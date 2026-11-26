"use client";
import { CATEGORY_HUES, CategoryIcon } from "../components/category-icon";
import { CatalogEventCard } from "../components/catalog-event-card";

import { localeFromBrowser } from "../lib/locale";

import { eventExpiryTime, hasEventEnded, EVENT_CATEGORIES, type EventCategory, type PublicEventSummary } from "@event-platform/shared-types";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { AfishaCalendar } from "../components/afisha-calendar";
import { CatalogPopover, CatalogMenu } from "../components/catalog-popover";
import { DateStrip } from "../components/date-strip";
import { PromotionCarousel } from "../components/promotion-carousel";
import { useDisplayCurrency } from "../components/currency-provider";
import { ErrorState } from "../components/ui";
import { CATALOG_CITY_SELECTED, CATALOG_QUERY_UPDATED, CATALOG_SEARCH_SUBMITTED } from "../lib/catalog-query-events";
import { fetchPublicEvents, type PublicEventsQuery } from "../lib/public-events";
import { DEFAULT_QUERY, PAGE_SIZE, readHomeQuery, readPage, sameHomeQuery, type HomeInitialData } from "./home-query";
import { useLocale } from "../components/locale-provider";
import { HOME_COPY } from "./home-copy";
import { cityName, countryName } from "../lib/countries";
import { clearCatalogLocation } from "../lib/catalog-location";

function useHomeCopy() { return HOME_COPY[useLocale()]; }

const CITY_HEADING_NAMES: Record<string, string> = { Алматы: "Алматы", Астана: "Астане", Шымкент: "Шымкенте", Москва: "Москве" };
function hasActiveFilters(query: PublicEventsQuery): boolean {
  return Boolean(query.timeOfDay || query.search || query.category || query.datePreset || query.from || query.to || query.free || query.minPrice !== undefined || query.maxPrice !== undefined || query.countryCode || query.city);
}

function queryUrl(query: PublicEventsQuery, allCountries = false): string {
  const params = new URLSearchParams(window.location.search);
  const explicitAllCountries = allCountries || params.get("countryCode") === "";
  for (const key of ["countryCode", "city", "timeOfDay", "sort", "search", "category", "datePreset", "from", "to", "free", "minPrice", "maxPrice", "page"]) params.delete(key);
  params.set("lang", localeFromBrowser());
  if (query.countryCode) params.set("countryCode", query.countryCode);
  else if (!query.city && explicitAllCountries) params.set("countryCode", "");
  if (query.city) params.set("city", query.city);
  if (query.sort && query.sort !== "soonest") params.set("sort", query.sort);
  for (const key of ["timeOfDay", "search", "category", "datePreset", "from", "to"] as const) {
    const value = query[key];
    if (value) params.set(key, value);
  }
  if (query.free) params.set("free", "true");
  if (query.minPrice !== undefined) params.set("minPrice", String(query.minPrice));
  if (query.maxPrice !== undefined) params.set("maxPrice", String(query.maxPrice));
  return params.size ? `/?${params.toString()}` : "/";
}

function pageUrl(query: PublicEventsQuery, page: number): string {
  const url = new URL(queryUrl(query), window.location.origin);
  if (page > 1) url.searchParams.set("page", String(page));
  return `${url.pathname}${url.search}`;
}

export default function HomeClient({ initial }: { initial: HomeInitialData | null }) {
  const locale = useLocale();
  const copy = useHomeCopy();
  const [query, setQuery] = useState<PublicEventsQuery>(initial?.query ?? DEFAULT_QUERY);
  const [ready, setReady] = useState(false);
  const [events, setEvents] = useState<PublicEventSummary[] | null>(initial?.result.items ?? null);
  const [total, setTotal] = useState(initial?.result.total ?? 0);
  const [matchingTotal, setMatchingTotal] = useState(initial?.result.matchingTotal ?? initial?.result.total ?? 0);
  const [allTotal, setAllTotal] = useState<number | null>(initial?.allTotal ?? null);
  const [page, setPage] = useState(initial?.page ?? 1);
  // The first client render reuses the server-rendered page instead of refetching it.
  const seededList = useRef(initial);
  const seededTotal = useRef(initial);
  const pageNavigationPending = useRef(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const restore = () => {
      const params = new URLSearchParams(window.location.search);
      const next = readHomeQuery(params);
      pageNavigationPending.current = false;
      setQuery(current => {
        if (sameHomeQuery(current, next)) return current;
        setTotal(0);
        return next;
      });
      setPage(readPage(params));
    };
    restore();
    setReady(true);
    window.addEventListener("popstate", restore);
    window.addEventListener(CATALOG_CITY_SELECTED, restore);
    window.addEventListener(CATALOG_SEARCH_SUBMITTED, restore);
    return () => {
      window.removeEventListener("popstate", restore);
      window.removeEventListener(CATALOG_CITY_SELECTED, restore);
      window.removeEventListener(CATALOG_SEARCH_SUBMITTED, restore);
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const seeded = seededTotal.current;
    seededTotal.current = null;
    if (seeded && retry === 0 && seeded.allTotal !== null && seeded.query.countryCode === query.countryCode && seeded.query.city === query.city) return;
    let active = true;
    void fetchPublicEvents({ countryCode: query.countryCode, city: query.city, page: 1, limit: 1, sort: "recent" })
      .then((result) => { if (active) setAllTotal(result.total); })
      .catch(() => { if (active) setAllTotal(null); });
    return () => { active = false; };
  }, [query.countryCode, query.city, ready, retry]);

  useEffect(() => {
    if (!ready) return;
    let active = true;
    const apply = (result: Awaited<ReturnType<typeof fetchPublicEvents>>) => {
        if (!active) return;
        const lastPage = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
        if (page > lastPage) {
          setPage(lastPage);
          window.history.replaceState(null, "", pageUrl(query, lastPage));
          return;
        }
        setEvents(result.items);
        setTotal(result.total);
        setMatchingTotal(result.matchingTotal ?? result.total);
        if (pageNavigationPending.current) {
          pageNavigationPending.current = false;
          requestAnimationFrame(() => document.getElementById("catalog-results")?.scrollIntoView({ block: "start" }));
        }
    };
    const seeded = seededList.current;
    seededList.current = null;
    if (seeded && retry === 0 && seeded.page === page && sameHomeQuery(seeded.query, query)) {
      apply(seeded.result);
      return () => { active = false; };
    }
    setLoading(true);
    setError(false);
    setEvents(null);
    void fetchPublicEvents({ ...query, includeRemaining: true, page, limit: PAGE_SIZE })
      .then(apply)
      .catch(() => { if (active) setError(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [query, page, ready, retry]);

  useEffect(() => {
    if (!events?.length) return;
    const now = Date.now();
    const nextCutoff = Math.min(...events.map(eventExpiryTime).filter(time => time > now));
    const refresh = () => setRetry(value => value + 1);
    const onVisible = () => { if (document.visibilityState === "visible" && events.some(event => hasEventEnded(event))) refresh(); };
    const timer = Number.isFinite(nextCutoff) ? setTimeout(refresh, Math.min(nextCutoff - now + 50, 2_147_483_647)) : undefined;
    document.addEventListener("visibilitychange", onVisible);
    return () => { if (timer) clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [events]);

  function update(next: Partial<PublicEventsQuery>, allCountries = false) {
    const changed = { ...query, ...next };
    pageNavigationPending.current = false;
    setQuery(changed);
    setPage(1);
    setTotal(0);
    window.history.pushState(null, "", queryUrl(changed, allCountries));
    window.dispatchEvent(new Event(CATALOG_QUERY_UPDATED));
  }

  function changePage(next: number) {
    if (next === page || loading || next < 1 || next > Math.ceil(total / PAGE_SIZE)) return;
    pageNavigationPending.current = true;
    setPage(next);
    window.history.pushState(null, "", pageUrl(query, next));
  }

  function reset() {
    clearCatalogLocation();
    update({ ...DEFAULT_QUERY, countryCode: undefined, city: undefined, timeOfDay: undefined, search: undefined, category: undefined, datePreset: undefined, from: undefined, to: undefined, free: undefined, minPrice: undefined, maxPrice: undefined }, true);
  }

  const filtered = hasActiveFilters(query);
  const matchingOnPage = Math.max(0, Math.min(events?.length ?? 0, matchingTotal - (page - 1) * PAGE_SIZE));
  const catalog = events?.slice(0, matchingOnPage) ?? [];
  const remaining = events?.slice(matchingOnPage) ?? [];
  const city = query.city;
  const countryCode = query.countryCode;
  const pageCount = Math.ceil(total / PAGE_SIZE);

  const placeName = city ? (locale === "ru" ? CITY_HEADING_NAMES[city] ?? city : cityName(city, locale)) : countryCode ? countryName(countryCode, locale) : null;
  return <main className="ticket-catalog">
    <div className="tk-wrap">
      <section className="tk-hero">
        <h1 className="ticket-catalog-heading">{city ? <>{copy.headingCity} <em>{placeName}</em></> : countryCode ? <>{copy.heading} — <em>{placeName}</em></> : copy.heading}</h1>
        <p>{HERO_LEAD[locale]}</p>
      </section>
      <CategoryStrip category={query.category as EventCategory | undefined} total={matchingTotal} allTotal={allTotal ?? undefined} onSelect={(category) => update({ category })} />
      <div className="tk-dates">
        <AfishaCalendar tile from={query.from} onChange={(from, to) => update({ from, to, datePreset: undefined })} to={query.to} />
        <DateStrip from={query.from} onSelect={date => update(query.from === date && query.to === date ? { from: undefined, to: undefined, datePreset: undefined } : { from: date, to: date, datePreset: undefined })} onClear={() => update({ from: undefined, to: undefined, datePreset: undefined })} to={query.to} todaySelected={query.datePreset === "today"} />
      </div>
      <PromotionCarousel />
      <CatalogFilters query={query} onUpdate={update} onReset={reset} />
      {error ? <div className="mt-5"><ErrorState message={copy.loadFailed} onRetry={() => setRetry((value) => value + 1)} /></div> : null}
      {!events && !error ? <HomeSkeleton /> : null}
      {events && !error ? <section aria-live="polite" id="catalog-results" className="scroll-mt-32">
        {catalog.length || page === 1 ? <>
          <div className="tk-results-head"><h2>{filtered ? copy.results : copy.current}</h2><span className="tk-n">{matchingTotal}</span></div>
          {catalog.length ? <div className="tk-grid ticket-event-grid">{catalog.map((event, index) => <CatalogEventCard event={event} index={index} key={event.id} />)}</div> : <div className="tk-empty"><b>{copy.emptyResults}</b></div>}
        </> : null}
        {remaining.length ? <><div className="tk-results-head"><h2>{copy.otherEvents}</h2></div><div className="tk-grid ticket-event-grid">{remaining.map((event, index) => <CatalogEventCard event={event} index={index} key={event.id} />)}</div></> : null}
        {pageCount > 1 ? <CatalogPagination page={page} pageCount={pageCount} onChange={changePage} /> : null}
      </section> : null}
    </div>
    <HomeFooter />
  </main>;
}

const HERO_LEAD = {
  ru: "Концерты, спектакли, вечеринки и мастер-классы — выберите, куда пойти.",
  kk: "Концерттер, спектакльдер, кештер мен шеберханалар — қайда баратыныңызды таңдаңыз.",
  en: "Concerts, shows, parties and workshops — pick where to go.",
} as const;

function CategoryStrip({ category, total, allTotal, onSelect }: { category: EventCategory | undefined; total: number; allTotal: number | undefined; onSelect: (category: EventCategory | undefined) => void }) {
  const copy = useHomeCopy();
  const locale = useLocale();
  const row = useRef<HTMLElement>(null);
  const [edges, setEdges] = useState({ back: false, forward: false });
  useEffect(() => {
    const element = row.current;
    if (!element) return;
    const sync = () => setEdges({ back: element.scrollLeft > 4, forward: element.scrollLeft + element.clientWidth < element.scrollWidth - 4 });
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientWidth : 1);
      const canScroll = delta > 0 ? element.scrollLeft < element.scrollWidth - element.clientWidth - 1 : element.scrollLeft > 0;
      if (canScroll) { event.preventDefault(); element.scrollLeft += delta; }
    };
    sync();
    element.addEventListener("wheel", wheel, { passive: false });
    element.addEventListener("scroll", sync, { passive: true });
    const observer = new ResizeObserver(sync); observer.observe(element);
    return () => { element.removeEventListener("wheel", wheel); element.removeEventListener("scroll", sync); observer.disconnect(); };
  }, []);
  const scroll = (direction: number) => row.current?.scrollBy({ left: direction * row.current.clientWidth * 0.7, behavior: "smooth" });
  const arrows = ({ ru: ["Предыдущие категории", "Следующие категории"], kk: ["Алдыңғы санаттар", "Келесі санаттар"], en: ["Previous categories", "Next categories"] } as const)[locale];
  return <div className="tk-cats-wrap tk-has-scroll">
    <button className={`tk-scroll-btn tk-prev${edges.back ? " tk-show" : ""}`} type="button" aria-label={arrows[0]} onClick={() => scroll(-1)}><Chevron direction="left" /></button>
    <nav ref={row} aria-label={copy.categoriesLabel} className="tk-cats ticket-category-strip">
      <CategoryButton active={!category} count={allTotal} onClick={() => onSelect(undefined)} />
      {EVENT_CATEGORIES.map(item => <CategoryButton key={item} category={item} active={category === item} count={category === item ? total : undefined} onClick={() => onSelect(item)} />)}
    </nav>
    <button className={`tk-scroll-btn tk-next${edges.forward ? " tk-show" : ""}`} type="button" aria-label={arrows[1]} onClick={() => scroll(1)}><Chevron direction="right" /></button>
  </div>;
}

function CategoryButton({ category, active, onClick, count }: { category?: EventCategory; active: boolean; onClick: () => void; count?: number | undefined }) {
  const copy = useHomeCopy();
  return <button aria-pressed={active} className="tk-cat ticket-category-button" style={{ "--hue": CATEGORY_HUES[category ?? "all"] } as React.CSSProperties} onClick={onClick} type="button">
    <span className="tk-cat-icon"><CategoryIcon category={category ?? "all"} /></span><span className="ticket-category-label">{category ? copy.categories[category] : copy.all}</span>
    {count !== undefined ? <span className="tk-count">{count}</span> : null}
  </button>;
}

function CatalogPagination({ page, pageCount, onChange }: { page: number; pageCount: number; onChange: (page: number) => void }) {
  const copy = useHomeCopy();
  const visible = [...new Set([1, pageCount, page - 2, page - 1, page, page + 1, page + 2].filter((value) => value >= 1 && value <= pageCount))].sort((left, right) => left - right);
  return <nav aria-label={copy.pageLabel} className="tk-pager">
    <button aria-label={copy.previousPage} disabled={page === 1} onClick={() => onChange(page - 1)} type="button">‹</button>
    {visible.map((number, index) => <span className="contents" key={number}>{index > 0 && number - visible[index - 1]! > 1 ? <span aria-hidden="true" className="tk-pager-gap">…</span> : null}<button aria-current={number === page ? "page" : undefined} aria-label={`${copy.pageLabel} ${number}`} onClick={() => onChange(number)} type="button">{number}</button></span>)}
    <button aria-label={copy.nextPage} disabled={page === pageCount} onClick={() => onChange(page + 1)} type="button">›</button>
  </nav>;
}

function CatalogFilters({ query, onUpdate, onReset }: { query: PublicEventsQuery; onUpdate: (next: Partial<PublicEventsQuery>) => void; onReset: () => void }) {
  const locale = useLocale(), copy = HOME_COPY[locale];
  const { currency, rates, setCurrency, formatWholeKzt } = useDisplayCurrency();
  const canReset = hasActiveFilters(query) || Boolean(query.sort && query.sort !== "soonest");
  const sentinel = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  const [open, setOpen] = useState<"price" | "currency" | "sort" | null>(null);
  const anchors = { price: useRef<HTMLButtonElement>(null), currency: useRef<HTMLButtonElement>(null), sort: useRef<HTMLButtonElement>(null) };
  useEffect(() => {
    // Once pinned under the top bar the chips gather into one frosted capsule (prototype .toolbar.stuck).
    const sync = () => { const mark = sentinel.current; if (mark) setStuck(mark.getBoundingClientRect().top < 64); };
    sync();
    window.addEventListener("scroll", sync, { passive: true });
    window.addEventListener("resize", sync);
    return () => { window.removeEventListener("scroll", sync); window.removeEventListener("resize", sync); };
  }, []);
  const labels = ({ ru: { price: "Цена", sortShort: { soonest: "Ближайшие", popular: "Популярные", recent: "Новые" }, currency: { KZT: "₸ Тенге, KZT", RUB: "₽ Рубль, RUB", USD: "$ Доллар, USD" } }, kk: { price: "Баға", sortShort: { soonest: "Жақын", popular: "Танымал", recent: "Жаңа" }, currency: { KZT: "₸ Теңге, KZT", RUB: "₽ Рубль, RUB", USD: "$ Доллар, USD" } }, en: { price: "Price", sortShort: { soonest: "Soonest", popular: "Popular", recent: "Newest" }, currency: { KZT: "₸ Tenge, KZT", RUB: "₽ Ruble, RUB", USD: "$ Dollar, USD" } } } as const)[locale];
  const priceActive = query.minPrice !== undefined || query.maxPrice !== undefined;
  const sort = query.sort ?? "soonest";
  const currencyShort = { KZT: "₸ KZT", RUB: "₽ RUB", USD: "$ USD" }[currency];
  return <>
    <div className="tk-toolbar-sentinel" ref={sentinel} />
    <section className={`tk-toolbar ticket-catalog-toolbar${stuck ? " tk-stuck" : ""}`} aria-label={copy.filters}>
      <div className="tk-toolbar-row">
        <TimeOfDayFilters value={query.timeOfDay} onChange={timeOfDay => onUpdate({ timeOfDay })} />
        <button aria-pressed={query.free === true} className="tk-chip" onClick={() => onUpdate({ free: query.free ? undefined : true, minPrice: undefined, maxPrice: undefined })} type="button">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 12v8H4v-8M2 7h20v5H2zM12 22V7M12 7H7.5a2.5 2.5 0 1 1 0-5C11 2 12 7 12 7Zm0 0h4.5a2.5 2.5 0 1 0 0-5C13 2 12 7 12 7Z" /></svg>
          {copy.free}
        </button>
        <button ref={anchors.price} className={`tk-chip${priceActive ? " tk-active" : ""}`} type="button" aria-haspopup="dialog" aria-expanded={open === "price"} onClick={() => setOpen(open === "price" ? null : "price")}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></svg>
          <span>{priceActive ? `${formatWholeKzt(query.minPrice ?? 0)} – ${query.maxPrice === undefined ? "∞" : formatWholeKzt(query.maxPrice)}` : labels.price}</span>
          <ChipChevron />
        </button>
        <button ref={anchors.currency} className="tk-chip" type="button" aria-haspopup="listbox" aria-expanded={open === "currency"} title={rates ? `${copy.exchangeRates} ${rates.asOf}. ${copy.paymentCurrency}` : copy.loadingRates} onClick={() => setOpen(open === "currency" ? null : "currency")}>
          <span>{currencyShort}</span><ChipChevron />
        </button>
        <span className="tk-spacer" />
        {canReset ? <button className="tk-reset" onClick={onReset} type="button">{copy.clearAll}</button> : null}
        <button ref={anchors.sort} className="tk-chip" type="button" aria-haspopup="listbox" aria-expanded={open === "sort"} aria-label={copy.sort} onClick={() => setOpen(open === "sort" ? null : "sort")}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 4v16m0 0-3-3m3 3 3-3M17 20V4m0 0-3 3m3-3 3 3" /></svg>
          <span>{labels.sortShort[sort]}</span><ChipChevron />
        </button>
      </div>
    </section>
    {open === "price" ? <CatalogPopover anchor={anchors.price.current} onClose={() => setOpen(null)} className="tk-price-pop" label={copy.priceRange}><PriceRange query={query} onUpdate={onUpdate} onDone={() => setOpen(null)} /></CatalogPopover> : null}
    {open === "currency" ? <CatalogMenu anchor={anchors.currency.current} onClose={() => setOpen(null)} label={copy.currency} value={currency} options={(["KZT", "RUB", "USD"] as const).map(value => ({ value, label: labels.currency[value], disabled: value !== "KZT" && !rates }))} onPick={value => setCurrency(value as "KZT" | "RUB" | "USD")} /> : null}
    {open === "sort" ? <CatalogMenu anchor={anchors.sort.current} onClose={() => setOpen(null)} label={copy.sort} value={sort} options={[{ value: "soonest", label: copy.soonest }, { value: "popular", label: copy.popular }, { value: "recent", label: copy.recent }]} onPick={value => onUpdate({ sort: value as "popular" | "recent" | "soonest" })} /> : null}
  </>;
}

const PRICE_LIMIT = 1_000_000;
const PRICE_RANGE_STEPS = 1000;
const PRICE_RANGE_CURVE = 5;

function positionToPrice(position: number): number {
  const fraction = Math.min(PRICE_RANGE_STEPS, Math.max(0, position)) / PRICE_RANGE_STEPS;
  return Math.round(PRICE_LIMIT * Math.expm1(PRICE_RANGE_CURVE * fraction) / Math.expm1(PRICE_RANGE_CURVE) / 10) * 10;
}

function priceToPosition(price: number): number {
  const fraction = Math.min(PRICE_LIMIT, Math.max(0, price)) / PRICE_LIMIT;
  return Math.round(Math.log1p(fraction * Math.expm1(PRICE_RANGE_CURVE)) / PRICE_RANGE_CURVE * PRICE_RANGE_STEPS);
}

function PriceRange({ query, onUpdate, onDone }: { query: PublicEventsQuery; onUpdate: (next: Partial<PublicEventsQuery>) => void; onDone: () => void }) {
  const copy = useHomeCopy();
  const locale = useLocale();
  const { formatWholeKzt } = useDisplayCurrency();
  const [min, setMin] = useState(query.minPrice ?? 0);
  const [max, setMax] = useState(query.maxPrice ?? PRICE_LIMIT);
  const minPosition = priceToPosition(min);
  const maxPosition = priceToPosition(max);
  useEffect(() => { setMin(query.minPrice ?? 0); setMax(query.maxPrice ?? PRICE_LIMIT); }, [query.minPrice, query.maxPrice]);
  const text = ({ ru: { from: "от", to: "до", reset: "Сбросить", apply: "Показать" }, kk: { from: "бастап", to: "дейін", reset: "Тазарту", apply: "Көрсету" }, en: { from: "from", to: "to", reset: "Reset", apply: "Show" } } as const)[locale];
  const minimumFromInput = (position: number) => Math.min(positionToPrice(position), max);
  const maximumFromInput = (position: number) => Math.max(positionToPrice(position), min);
  return <div role="group" aria-label={copy.priceRange}>
    <h4>{copy.priceRange}</h4>
    <div className="tk-price-vals"><div><small>{text.from}</small><b>{formatWholeKzt(min)}</b></div><div><small>{text.to}</small><b>{max >= PRICE_LIMIT ? "∞" : formatWholeKzt(max)}</b></div></div>
    <div className="tk-range">
      <div className="tk-range-track"><div className="tk-range-fill" style={{ left: `${minPosition / PRICE_RANGE_STEPS * 100}%`, width: `${(maxPosition - minPosition) / PRICE_RANGE_STEPS * 100}%` }} /></div>
      <input aria-label={copy.minPrice} aria-valuetext={formatWholeKzt(min)} type="range" min={0} max={PRICE_RANGE_STEPS} step={1} value={minPosition} style={{ zIndex: minPosition > PRICE_RANGE_STEPS - 50 ? 3 : 2 }} onChange={(event) => setMin(minimumFromInput(Number(event.currentTarget.value)))} />
      <input aria-label={copy.maxPrice} aria-valuetext={formatWholeKzt(max)} type="range" min={0} max={PRICE_RANGE_STEPS} step={1} value={maxPosition} style={{ zIndex: 2 }} onChange={(event) => setMax(maximumFromInput(Number(event.currentTarget.value)))} />
    </div>
    <div className="tk-price-actions">
      <button className="tk-ghost" type="button" onClick={() => { setMin(0); setMax(PRICE_LIMIT); onUpdate({ minPrice: undefined, maxPrice: undefined }); }}>{text.reset}</button>
      <button className="tk-solid" type="button" onClick={() => { onUpdate({ minPrice: min === 0 ? undefined : min, maxPrice: max >= PRICE_LIMIT ? undefined : max, free: undefined }); onDone(); }}>{text.apply}</button>
    </div>
  </div>;
}

function HomeSkeleton() { const copy = useHomeCopy(); return <div aria-label={copy.loadingEvents} className="ticket-catalog-skeleton tk-grid mt-4">{Array.from({ length: 8 }, (_, index) => <div className="h-80 animate-pulse rounded-[20px] bg-ticket-raised" key={index} />)}</div>; }
function HomeFooter() { const copy = useHomeCopy(); return <footer className="tk-site-footer"><div className="tk-wrap tk-foot-row"><span><Link className="tk-brand" href="/" style={{ fontSize: 17, verticalAlign: -2 }}>TICKET</Link>&nbsp;&nbsp;© {new Date().getFullYear()} {copy.footerTagline}</span><nav aria-label={copy.footerLinks}><Link href="/organizer/events">{copy.forOrganizers}</Link><Link href="/favorites">{copy.favorites}</Link></nav></div></footer>; }


function ChipChevron() { return <svg className="tk-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>; }
function Chevron({ direction }: { direction: "left" | "right" }) { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={direction === "left" ? "m15 18-6-6 6-6" : "m9 18 6-6-6-6"} /></svg>; }

const TIME_OF_DAY_ICONS = {
  morning: <path d="M3 17h18M6 17a6 6 0 0 1 12 0M12 3v4m-6.4.6 1.4 1.4m11.4-1.4L17 9" />,
  day: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4m11.2-11.2L19 5" /></>,
  evening: <path d="M3 17h18M6 17a6 6 0 0 1 12 0M9 7l3 3 3-3M12 3v7" />,
  night: <path d="M20.5 14A8.5 8.5 0 0 1 10 3.5 8.5 8.5 0 1 0 20.5 14Z" />,
};

function TimeOfDayFilters({ value, onChange }: { value: PublicEventsQuery["timeOfDay"]; onChange: (value: PublicEventsQuery["timeOfDay"]) => void }) {
  const locale = useLocale();
  const labels = { ru: ["Утро", "День", "Вечер", "Ночь"], kk: ["Таң", "Күндіз", "Кеш", "Түн"], en: ["Morning", "Day", "Evening", "Night"] }[locale];
  return <div className="tk-seg ticket-time-of-day" role="group" aria-label={{ ru: "Время начала события", kk: "Іс-шараның басталу уақыты", en: "Event start time" }[locale]}>{(["morning", "day", "evening", "night"] as const).map((period, index) => <button key={period} type="button" aria-pressed={value === period} title={["06:00–11:59", "12:00–17:59", "18:00–23:59", "00:00–05:59"][index]} onClick={() => onChange(value === period ? undefined : period)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{TIME_OF_DAY_ICONS[period]}</svg>{labels[index]}</button>)}</div>;
}
