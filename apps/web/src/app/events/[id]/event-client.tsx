"use client";
import { useEventEnded } from "../../../lib/use-event-ended";

import { localeFromBrowser } from "../../../lib/locale";

import { richDescriptionBody, tariffColor, UNAVAILABLE_HALL_COLOR, TARIFF_COLORS, type CreateCartCheckoutRequest, type EventLocale, type PublicEvent, type PublicVenueLayout, type PublicVenueSeat, type PublicEventSummary } from "@event-platform/shared-types";
import Link from "next/link";
import { EventHero } from "./event-hero";
import "./event-page.css";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { PublicFramedAsset } from "../../../components/public-event-media";
import { FavoriteButton } from "../../../components/favorite-button";
import { useDisplayCurrency } from "../../../components/currency-provider";
import { GuestHallPlan } from "../../../components/guest-hall-plan";
import { rememberRecentlyViewed } from "../../../lib/local-preferences";
import { EventHeroDetails } from "./event-hero-details";
import { CheckoutPanel } from "./checkout-panel";
import { ContentLanguageNote } from "../../../components/content-language-note";
import { useLocale } from "../../../components/locale-provider";
import { EVENT_COPY } from "./event-copy";
import { fetchPublicVenueLayout } from "../../../lib/public-events";
import { HOME_COPY } from "../../home-copy";
import { CatalogEventCard } from "../../../components/catalog-event-card";
import { fetchPublicEvents } from "../../../lib/public-events";
import { cityName, countryName } from "../../../lib/countries";
import { localeUrl } from "../../../lib/locale";
import { EventSectionNav, EventBuyBar } from "./event-chrome";

function useEventCopy() { return EVENT_COPY[useLocale()]; }

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
type CartPrefill = { tickets?: Array<{ ticketTypeId: string; quantity: number }>; tableId?: string | null; seatIds?: string[] };

export type EventPagePreview = { event: PublicEvent; layout: PublicVenueLayout | null; datePlaceholder?: string | undefined; descriptionPlaceholder: string; emptyTickets: string; showRefund: boolean; interactive?: boolean };

/** Server-rendered first payload; the client only fetches again after a locale change or for polling. */
export type EventPageInitial = { event: PublicEvent; layout: PublicVenueLayout | null; locale: EventLocale };

export default function PublicEventPage({ id, preview, initial, description }: { id: string; preview?: EventPagePreview; initial?: EventPageInitial | undefined; description?: ReactNode }) {
  const copy = useEventCopy();
  const locale = useLocale();
  const [loadedEvent, setEvent] = useState<PublicEvent | null>(initial?.event.id === id ? initial.event : null);
  const [loadedLayout, setLayout] = useState<PublicVenueLayout | null>(initial?.event.id === id ? initial.layout : null);
  const seeded = useRef(initial);
  const event = preview ? preview.event : loadedEvent;
  const layout = preview ? preview.layout : loadedLayout;
  const [selectedSeatIds, setSelectedSeatIds] = useState<string[]>([]);
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const [ticketQuantities, setTicketQuantities] = useState<Record<string, number>>({});
  const [checkoutLocked, setCheckoutLocked] = useState(false);
  const checkoutLock = useRef(false);
  const changeCheckoutLock = useCallback((locked: boolean) => {
    checkoutLock.current = locked;
    setCheckoutLocked(locked);
  }, []);
  const restoreCheckout = useCallback((body: CreateCartCheckoutRequest) => {
    if (body.eventId !== id) return;
    setTicketQuantities(Object.fromEntries(body.tickets.map(ticket => [ticket.ticketTypeId, ticket.quantity])));
    setSelectedTableId(body.tableId ?? null); setSelectedSeatIds(body.seatIds);
  }, [id]);
  const changeSeats = (ids: string[]) => { if (!checkoutLocked) setSelectedSeatIds(ids); };
  const changeTable = (id: string | null) => { if (!checkoutLocked) setSelectedTableId(id); };
  const changeTicket = (id: string, quantity: number) => setTicketQuantities((current) => {
    if (checkoutLocked) return current;
    const next = { ...current };
    if (quantity <= 0) delete next[id]; else next[id] = quantity;
    return next;
  });
  const { formatMoney } = useDisplayCurrency();
  const [error, setError] = useState(false);
  const [syncError, setSyncError] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (preview) return;
    let active = true;
    void (async () => {
      const initialData = seeded.current?.event.id === id && seeded.current.locale === locale ? seeded.current : undefined;
      seeded.current = undefined;
      const [nextEvent, nextLayout] = initialData ? [initialData.event, initialData.layout] : await Promise.all([
        fetch(`/api/events/${encodeURIComponent(id)}?locale=${localeFromBrowser()}`).then(async (eventResponse) => {
          if (!eventResponse.ok) throw new Error("EVENT_NOT_FOUND");
          return await eventResponse.json() as PublicEvent;
        }),
        fetchPublicVenueLayout(id).catch(() => null),
      ]);
      if (active) {
        setEvent(nextEvent);
        setLayout(nextLayout);
        const search = new URLSearchParams(window.location.search);
        let cart: CartPrefill | null = null;
        try { cart = JSON.parse(search.get("cart") ?? "null") as CartPrefill | null; } catch { /* Ignore malformed shared link. */ }
        const retained = Array.isArray(cart?.seatIds) ? cart.seatIds : search.get("seats")?.split(",") ?? [];
        if (retained.length <= 10 && nextLayout?.seats) setSelectedSeatIds(retained.filter((seatId) => nextLayout.seats?.some((seat) => seat.id === seatId && seat.availability === "available")));
        if (cart?.tableId && nextEvent.tables.some((table) => table.id === cart.tableId && table.availability === "available")) setSelectedTableId(cart.tableId);
        if (Array.isArray(cart?.tickets)) setTicketQuantities(Object.fromEntries(cart.tickets.filter((entry) => nextEvent.ticketTypes.some((ticket) => ticket.id === entry.ticketTypeId && ticket.status === "active" && ticket.remaining >= entry.quantity) && Number.isInteger(entry.quantity) && entry.quantity >= 1 && entry.quantity <= 10).map((entry) => [entry.ticketTypeId, entry.quantity])));
        rememberRecentlyViewed(nextEvent.id);
      }
    })().catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [id,locale,Boolean(preview)]);

  async function share(): Promise<void> {
    if (preview) return;
    if (navigator.share) { await navigator.share(event ? { title: event.title, url: window.location.href } : { url: window.location.href }).catch(() => undefined); return; }
    await navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  const refreshAvailability = useCallback(async (): Promise<void> => {
    if (!event || preview) return;
    const [eventResponse, nextLayout] = await Promise.all([
      fetch(`/api/events/${encodeURIComponent(event.id)}?locale=${localeFromBrowser()}`, { cache: "no-store" }),
      fetchPublicVenueLayout(event.id),
    ]);
    if (eventResponse.status === 404) { setError(true); return; }
    if (!eventResponse.ok) throw new Error(copy.refreshFailed);
    const nextEvent = await eventResponse.json() as PublicEvent;
    setEvent(nextEvent);
    setLayout(nextLayout);
    if (!checkoutLock.current) {
      setSelectedSeatIds((current) => current.filter((id) => nextLayout?.seats?.some((seat) => seat.id === id && seat.availability === "available")));
      setSelectedTableId((current) => current && nextEvent.tables.some((table) => table.id === current && table.availability === "available") ? current : null);
      setTicketQuantities((current) => Object.fromEntries(Object.entries(current).filter(([id, quantity]) => nextEvent.ticketTypes.some((ticket) => ticket.id === id && ticket.status === "active" && ticket.remaining >= quantity))));
    }
    setSyncError(false);
  }, [event?.id,Boolean(preview)]);

  useEffect(() => {
    if (!event?.id || error || preview) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let polling = false;
    const poll = async () => {
      if (!active || polling) return;
      polling = true;
      if (document.visibilityState === "visible") {
        try { await refreshAvailability(); failures = 0; }
        catch { failures = Math.min(3, failures + 1); if (active) setSyncError(true); }
      }
      polling = false;
      if (active) timer = setTimeout(poll, 30_000 * (failures + 1));
    };
    timer = setTimeout(poll, 30_000);
    const visible = () => { if (document.visibilityState === "visible") { if (timer) clearTimeout(timer); void poll(); } };
    document.addEventListener("visibilitychange", visible);
    return () => { active = false; if (timer) clearTimeout(timer); document.removeEventListener("visibilitychange", visible); };
  }, [event?.id, error, refreshAvailability]);

  if (error) return <main className="min-h-screen px-5 pt-32 text-center"><h1 className="text-2xl font-bold">{copy.notFound}</h1><Link className="ticket-pill-button mt-5" href="/">{copy.returnToEvents}</Link></main>;
  if (!event) return <EventPageSkeleton />;

  const hasHall = Boolean((!event.saleMode||event.saleMode==="paid_seated")&&layout && (layout.tables.length > 0 || layout.rows.length > 0 || (layout.layoutJson.version === 2 && (layout.layoutJson.editor?.objects.length ?? 0) > 0)));
  const home = HOME_COPY[locale];
  const price = startingPrice(event, layout, formatMoney);
  const left = remainingPlaces(event, layout);
  const free = price === formatMoney(0, "KZT") || /^0\D/.test(price ?? "") || event.saleMode === "free";
  const ctaLabel = free ? CTA_LABEL[locale].register : hasHall ? CTA_LABEL[locale].seats : CTA_LABEL[locale].buy;
  const sections = [
    { id: "about", label: copy.about, show: Boolean(event.description || preview || galleryCount(event)) },
    { id: "hall", label: copy.hallMap, show: Boolean(hasHall && layout) },
    { id: "program", label: copy.program, show: Boolean(event.program) },
    { id: "location", label: CTA_LABEL[locale].place, show: true },
    { id: "terms", label: copy.terms, show: event.creationVersion !== 2 && [event.rules, event.visitTerms, event.cancellationTerms, event.extraConditions, event.depositTerms].some(Boolean) },
    { id: "organizer", label: copy.organizer, show: true },
  ].filter(section => section.show);
  return <main inert={preview && !preview.interactive ? true : undefined} className="tke-page">
    <div className="tk-wrap">
      <EventHero event={event} galleryLabel={copy.gallery} actions={<>
        <button aria-label={copied ? copy.copied : copy.share} title={copied ? copy.copied : copy.share} className="tke-glass" onClick={() => void share()} type="button"><ShareIcon /></button>
        <FavoriteButton eventId={event.id} heroOverlay readOnly={Boolean(preview)} />
      </>}>
        <p className="tke-eyebrow">{home.categories[event.category]} <span>·</span> {event.ageRestriction}+</p>
        <h1>{event.title}</h1>
        <ContentLanguageNote contentLocale={event.contentLocale} />
        <EventHeroDetails event={event} locale={locale} datePlaceholder={preview?.datePlaceholder} organizerLabel={copy.organizer} />
        <div className="tke-buy-row">
          <div className="tke-from">{free ? <b className="tke-free">{home.free}</b> : price ? <><small>{home.from}</small><b>{price}</b></> : null}{left !== null && left > 0 ? <span className="tke-left"><i />{CTA_LABEL[locale].left(left)}</span> : null}</div>
          <a className="tke-btn" href="#tickets" id="hero-cta">{ctaLabel} <ArrowIcon /></a>
        </div>
      </EventHero>

      <EventSectionNav sections={sections} />

      {syncError ? <div aria-live="polite" className="tke-sync">{copy.syncFailed} <button onClick={() => void refreshAvailability().catch(() => setSyncError(true))} type="button">{copy.retry}</button></div> : null}
      <div className="event-details-grid tke-layout">
        <div className="tke-col">
          {sections.some(section => section.id === "about") ? <section className="tke-panel" id="about">
            <div className="tke-panel-head"><div><h2>{copy.about}</h2></div></div>
            {event.description ? <ClampedText>{event.creationVersion === 2 ? (description && event.description === (preview?.event ?? initial?.event)?.description ? description : <DescriptionText value={event.description} />) : <RichText text={event.description} />}</ClampedText> : preview ? <p className="tke-desc">{preview.descriptionPlaceholder}</p> : null}
            <Gallery event={event} />
          </section> : null}
          {hasHall && layout ? <VenueSection layout={layout} event={event} selectedSeatIds={selectedSeatIds} onChange={changeSeats} selectedTableId={selectedTableId} onTableChange={changeTable} ticketQuantities={ticketQuantities} onTicketChange={changeTicket} /> : null}
          {event.program ? <ProgramCard text={event.program} eventTime={event.time}/> : null}
          <LocationCard event={event} preview={Boolean(preview)} />
          {event.creationVersion !== 2 ? <TermsCard event={event}/> : null}
          <OrganizerCard event={event} />
        </div>
        <div className="event-checkout"><CheckoutPanel event={event} layout={layout} hasHall={hasHall} selectedSeatIds={selectedSeatIds} selectedTableId={selectedTableId} onTableChange={changeTable} ticketQuantities={ticketQuantities} onTicketChange={changeTicket} onClearSeats={() => changeSeats([])} onRefreshAvailability={refreshAvailability} readOnly={Boolean(preview)} onLockChange={changeCheckoutLock} onRestoreSelection={restoreCheckout} emptyMessage={preview?.emptyTickets} showRefund={preview?.showRefund ?? true} /></div>
      </div>
      {!preview ? <SimilarEvents event={event} /> : null}
    </div>
    <EventBuyBar label={home.from} price={price} action={ctaLabel} />
  </main>;
}

const CTA_LABEL = {
  ru: { register: "Записаться", seats: "Выбрать места", buy: "Купить билет", place: "Место", more: "Читать полностью", less: "Свернуть", similar: "Похожие события", all: "Вся афиша →", left: (n: number) => `Осталось ${n} ${n % 10 === 1 && n % 100 !== 11 ? "место" : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "места" : "мест"}`, openMaps: "Открыть в картах", copy: "Скопировать адрес", copied: "Адрес скопирован" },
  kk: { register: "Тіркелу", seats: "Орын таңдау", buy: "Билет сатып алу", place: "Орны", more: "Толық оқу", less: "Жию", similar: "Ұқсас іс-шаралар", all: "Барлық афиша →", left: (n: number) => `${n} орын қалды`, openMaps: "Картадан ашу", copy: "Мекенжайды көшіру", copied: "Мекенжай көшірілді" },
  en: { register: "Register", seats: "Choose seats", buy: "Buy ticket", place: "Venue", more: "Read more", less: "Show less", similar: "Similar events", all: "All events →", left: (n: number) => `${n} left`, openMaps: "Open in maps", copy: "Copy address", copied: "Address copied" },
} as const;

/** Prototype .desc.clamped with "Читать полностью". */
function ClampedText({ children }: { children: React.ReactNode }) {
  const locale = useLocale();
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useEffect(() => { const element = box.current; if (element) setLong(element.scrollHeight > 190); }, [children]);
  return <>
    <div ref={box} className={`tke-desc${long && !open ? " tke-clamped" : ""}`}>{children}</div>
    {long ? <button className="tke-more" type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? CTA_LABEL[locale].less : CTA_LABEL[locale].more} <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></button> : null}
  </>;
}

export function VenueSection({ layout, event, selectedSeatIds, onChange, selectedTableId, onTableChange, ticketQuantities, onTicketChange }: { layout: PublicVenueLayout; event: PublicEvent; selectedSeatIds: string[]; onChange: (ids: string[]) => void; selectedTableId: string | null; onTableChange: (id: string | null) => void; ticketQuantities: Record<string, number>; onTicketChange: (id: string, quantity: number) => void }) {
  const copy = useEventCopy();
  const { formatMoney } = useDisplayCurrency();
  const [selectionError, setSelectionError] = useState("");
  const json = layout.layoutJson;
  const isV2 = json.version === 2;
  const legacyTariffs = [...layout.tables, ...layout.rows].filter((item, index, all) => all.findIndex(other => other.typeLabel === item.typeLabel && other.price === item.price && other.currency === item.currency) === index).map((item, index) => ({ name: item.typeLabel || copy.available, price: item.price, currency: item.currency, color: TARIFF_COLORS[index % TARIFF_COLORS.length]!.color }));
  const width = isV2 ? json.room.widthM : json.canvas.width;
  const height = isV2 ? json.room.heightM : json.canvas.height;
  const dimensions = isV2 ? `${width.toFixed(1)} × ${height.toFixed(1)} ${copy.metres}` : `${width} × ${height} px`;
  const ended = useEventEnded(event);
  const salesAvailable = event.paymentMode !== "deposit" && !ended;
  const toggle = (seat: PublicVenueSeat | (PublicVenueLayout["tables"][number]["seatRecords"][number])) => {
    if (!salesAvailable || seat.availability !== "available") return;
    if (selectedSeatIds.includes(seat.id)) { setSelectionError(""); onChange(selectedSeatIds.filter((id) => id !== seat.id)); return; }
    const firstSelected = layout.seats?.find((item) => item.id === selectedSeatIds[0]);
    const nextSeat = layout.seats?.find((item) => item.id === seat.id);
    if (firstSelected && nextSeat && firstSelected.currency !== nextSeat.currency) { setSelectionError(copy.mixedCurrencies); return; }
    if (selectedSeatIds.length < 10) { setSelectionError(""); onChange([...selectedSeatIds, seat.id]); }
  };
  const selectedLabels = selectedSeatIds.map((id) => {
    const canonical = layout.seats?.find((seat) => seat.id === id);
    if (canonical) return { id, label: canonical.rowId ? `${layout.rows.find((row) => row.id === canonical.rowId)?.name || `${copy.row} ${layout.rows.find((row) => row.id === canonical.rowId)?.number ?? ""}`} · ${copy.seat} ${canonical.number}` : canonical.tableId ? `${copy.table} ${layout.tables.find((table) => table.id === canonical.tableId)?.number ?? ""} · ${copy.seat} ${canonical.number}` : canonical.label, tariff: canonical.tariffName, amount: canonical.price, currency: canonical.currency };
    for (const table of layout.tables) {
      const seat = table.seatRecords.find((item) => item.id === id);
      if (seat) return { id, label: `${copy.table} ${table.number} · ${copy.seat} ${seat.number}`, tariff: table.typeLabel, amount: table.price, currency: table.currency };
    }
    for (const row of layout.rows) {
      const seat = row.seats.find((item) => item.id === id);
      if (seat) return { id, label: `${copy.row} ${row.number} · ${copy.seat} ${seat.number}`, tariff: row.typeLabel, amount: row.price, currency: row.currency };
    }
    return { id, label: copy.selectedSeat, tariff: null, amount: null, currency: "" };
  });
  const chosenTable = selectedTableId ? event.tables.find((table) => table.id === selectedTableId) : null;
  const chosenZones = event.ticketTypes.filter((ticket) => (ticketQuantities[ticket.id] ?? 0) > 0);
  const chooseTable = (id: string) => { if (!salesAvailable) return; const table = event.tables.find((item) => item.id === id && item.saleMode === "whole_table" && item.availability === "available"); if (table) onTableChange(selectedTableId === id ? null : id); };
  const chooseZone = (id: string) => { if (!salesAvailable) return; const ticket = event.ticketTypes.find((item) => item.venueObjectId === id && item.status === "active" && item.remaining > 0); if (ticket) onTicketChange(ticket.id, (ticketQuantities[ticket.id] ?? 0) ? 0 : 1); };

  const [full, setFull] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  const closer = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!full) return;
    document.body.classList.add("tke-fs-lock");
    closer.current?.focus();
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setFull(false); };
    document.addEventListener("keydown", escape);
    return () => { document.body.classList.remove("tke-fs-lock"); document.removeEventListener("keydown", escape); };
  }, [full]);
  const trayItems = [
    ...selectedLabels.map(seat => ({ key: seat.id, label: seat.label, amount: seat.amount, currency: seat.currency, color: null as string | null, remove: () => onChange(selectedSeatIds.filter(id => id !== seat.id)) })),
    ...(chosenTable ? [{ key: chosenTable.id, label: chosenTable.name ?? `${copy.table} ${chosenTable.number}`, amount: chosenTable.payment.amountDue, currency: chosenTable.currency, color: null, remove: () => onTableChange(null) }] : []),
    ...chosenZones.map(zone => ({ key: zone.id, label: `${zone.name} × ${ticketQuantities[zone.id] ?? 0}`, amount: zone.payment.amountDue * (ticketQuantities[zone.id] ?? 0), currency: zone.currency, color: null, remove: () => onTicketChange(zone.id, 0) })),
  ];
  const trayCurrency = trayItems.find(item => item.currency)?.currency ?? "";
  const trayTotal = trayItems.filter(item => item.currency === trayCurrency).reduce((sum, item) => sum + (item.amount ?? 0), 0);
  const fsCopy = FS_COPY[useLocale()];
  const tariffs = isV2 && json.editor?.tariffs.length
    ? json.editor.tariffs.map((tariff, index) => ({ key: tariff.id, name: tariff.name, color: tariffColor(tariff.color, index), price: formatMoney(tariff.price, event.currency ?? layout.seats?.[0]?.currency ?? event.tables[0]?.currency ?? "KZT") }))
    : legacyTariffs.map((tariff, index) => ({ key: String(index), name: tariff.name, color: tariff.color, price: tariff.price === null ? "—" : formatMoney(tariff.price, tariff.currency) }));

  return <section id="hall" className="tke-panel">
    <span id="venue-plan" className="tke-anchor" />
    <div className="tke-panel-head">
      <div><p className="tke-kicker">{copy.interactiveMap}</p><h2>{copy.chooseSeat}</h2><p className="tke-panel-sub">{copy.selectionHint}</p></div>
      <div className="tke-legend"><span><i style={{ background: "var(--tk-accent)" }} />{copy.selected}</span><span><i style={{ background: UNAVAILABLE_HALL_COLOR }} />{copy.unavailable}</span></div>
    </div>
    {full ? <div className="tke-map-backdrop" onClick={() => setFull(false)} /> : null}
    <div className={`tke-map-shell${full ? " tke-full" : ""}`} role={full ? "dialog" : undefined} aria-modal={full ? true : undefined} aria-label={full ? copy.hallMap : undefined}>
      {full ? <div className="tke-fs-head"><div><b>{copy.hallMap}</b><span>{copy.chooseSeat}</span></div><button ref={closer} className="tke-fs-close" type="button" aria-label={fsCopy.close} onClick={() => setFull(false)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg></button></div> : null}
      <span className="tke-dims">{dimensions}</span>
      <div className="tke-map-scroll">
        <GuestHallPlan layout={layout} copy={copy} tableOptions={event.tables} zoneOptions={event.ticketTypes}
          selectedSeatIds={selectedSeatIds} selectedTableId={selectedTableId} salesAvailable={salesAvailable}
          onSeat={toggle} onTable={chooseTable} onZone={chooseZone} ticketQuantities={ticketQuantities}
          formatPrice={formatMoney} highlightTariffId={highlight} />
      </div>
      {!full ? <button className="tke-fs-btn" type="button" aria-label={fsCopy.open} title={fsCopy.open} onClick={() => setFull(true)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14.5 3.5h6v6M9.5 20.5h-6v-6M20.5 3.5l-6.5 6.5M3.5 20.5 10 14" /></svg></button> : null}
      <div className="tke-tray">
        <div className="tke-tray-list">{trayItems.length ? trayItems.map(item => <span className="tke-tray-chip" key={item.key}><b>{item.label}</b>{item.amount !== null ? <small>{formatMoney(item.amount, item.currency)}</small> : null}<button className="tke-x" type="button" aria-label={`${copy.remove} ${item.label}`} onClick={item.remove}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg></button></span>) : <span className="tke-tray-empty">{copy.noSelection}</span>}</div>
        <div className="tke-tray-total">{trayItems.length}<b>{trayCurrency ? formatMoney(trayTotal, trayCurrency) : "—"}</b></div>
        <a className="tke-btn" href="#tickets" aria-disabled={!trayItems.length} onClick={() => setFull(false)}>{fsCopy.done} <ArrowIcon /></a>
      </div>
    </div>
    {selectionError ? <p className="tke-error" role="alert">{selectionError}</p> : null}
    <div className="tke-tariffs" aria-label={copy.tariffs}>{tariffs.map(tariff => <span className="tke-tariff" key={tariff.key} style={{ "--c": tariff.color } as React.CSSProperties} onMouseEnter={() => setHighlight(isV2 && json.editor ? tariff.key : null)} onMouseLeave={() => setHighlight(null)}><i />{tariff.name} <b>{tariff.price}</b></span>)}</div>
  </section>;
}

const FS_COPY = {
  ru: { open: "Открыть схему на весь экран", close: "Закрыть полноэкранную схему", done: "Готово" },
  kk: { open: "Сызбаны толық экранда ашу", close: "Толық экранды сызбаны жабу", done: "Дайын" },
  en: { open: "Open the map full screen", close: "Close the full-screen map", done: "Done" },
} as const;

/** Text-only fallback (no HTML is rendered) when no sanitized description was supplied by the server. */
function DescriptionText({ value }: { value: string }) {
  const body = richDescriptionBody(value);
  const text = body === null ? value : body.replace(/<br\s*\/?>|<\/(p|h1|h2|li)>/gi, "\n").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&").trim();
  return <p className="whitespace-pre-wrap break-words leading-7 text-ticket-muted">{text}</p>;
}
function RichText({ text }: { text: string | null }) { const copy = useEventCopy(); return text ? <p style={{ whiteSpace: "pre-wrap" }}>{text}</p> : <p>{copy.descriptionSoon}</p>; }
/** Prototype .gallery mosaic: one large tile, up to four small ones, "+N" on the last; opens a lightbox. */
function Gallery({ event }: { event: PublicEvent }) {
  const copy = useEventCopy();
  const media = event.media?.filter(asset => asset.galleryVisible) ?? [];
  const urls = [...new Set([event.posterUrl, ...(event.galleryUrls ?? [])].filter((url): url is string => !!url))];
  const items = media.length ? media.map(asset => ({ key: asset.id, asset, url: asset.kind === "image" ? asset.url : asset.posterUrl ?? "" })) : urls.map(url => ({ key: url, asset: undefined, url: resolveMedia(url, "") }));
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    if (open === null) return;
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(null); if (event.key === "ArrowRight") setOpen(index => index === null ? null : (index + 1) % items.length); if (event.key === "ArrowLeft") setOpen(index => index === null ? null : (index - 1 + items.length) % items.length); };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [open, items.length]);
  if (!items.length) return null;
  const shown = items.slice(0, 5);
  return <>
    <div className="tke-gallery" aria-label={copy.gallery}>{shown.map((item, index) => <button key={item.key} type="button" aria-label={`${copy.gallery}: ${index + 1}`} onClick={() => setOpen(index)}>
      {item.asset ? <PublicFramedAsset asset={item.asset} role="gallery" className="h-full w-full" /> : <img alt="" src={item.url} width={400} height={300} loading="lazy" decoding="async" />}
      {index === 4 && items.length > 5 ? <span className="tke-plus">+{items.length - 5}</span> : null}
    </button>)}</div>
    {open !== null ? <div className="tke-lightbox tke-open" role="dialog" aria-label={copy.gallery} onClick={event => { if (event.target === event.currentTarget) setOpen(null); }}>
      {items[open]!.asset && items[open]!.asset!.kind === "video" ? <PublicFramedAsset asset={items[open]!.asset!} role="gallery" className="h-[70vh] w-[min(1100px,100%)]" controls /> : <img alt="" src={items[open]!.url} />}
      <button className="tke-glass tke-lb-close" type="button" aria-label="×" onClick={() => setOpen(null)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg></button>
      {items.length > 1 ? <><button className="tke-glass tke-lb-prev" type="button" aria-label="‹" onClick={() => setOpen((open - 1 + items.length) % items.length)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 6-6 6 6 6" /></svg></button><button className="tke-glass tke-lb-next" type="button" aria-label="›" onClick={() => setOpen((open + 1) % items.length)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg></button></> : null}
    </div> : null}
  </>;
}
function galleryCount(event: PublicEvent) { return (event.media?.filter(asset => asset.galleryVisible).length ?? 0) || [event.posterUrl, ...(event.galleryUrls ?? [])].filter(Boolean).length; }
function ProgramCard({ text, eventTime }: { text: string | null; eventTime: string }) { const copy = useEventCopy(); const items = parseProgram(text, eventTime, copy); return <section className="tke-panel" id="program"><div className="tke-panel-head"><div><p className="tke-kicker">{copy.program}</p><h2>{copy.schedule}</h2></div></div><ol className="tke-timeline">{items.map((item, index) => <li key={`${item.time}-${index}`}><time>{item.time}</time><div><b>{item.label}</b></div></li>)}</ol></section>; }
function LocationCard({ event, preview = false }: { event: PublicEvent; preview?: boolean }) {
  const copy = useEventCopy();
  const locale = useLocale();
  const [copied, setCopied] = useState(false);
  const query = [event.address, event.city, event.countryCode].filter(Boolean).join(", ");
  const encodedQuery = encodeURIComponent(query);
  const mapsKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_EMBED_API_KEY;
  const embedUrl = mapsKey ? `https://www.google.com/maps/embed/v1/place?key=${encodeURIComponent(mapsKey)}&q=${encodedQuery}` : `https://www.google.com/maps?q=${encodedQuery}&output=embed`;
  const mapUrl = `https://www.google.com/maps/search/?api=1&query=${encodedQuery}`;
  const place = [event.city ? cityName(event.city, locale) : "", event.countryCode ? countryName(event.countryCode, locale) : ""].filter(Boolean).join(", ");
  return <section className="tke-panel" id="location">
    <div className="tke-panel-head"><div><p className="tke-kicker">{CTA_LABEL[locale].place}</p><h2>{copy.location}</h2></div></div>
    <div className="tke-loc-grid">
      <div className="tke-mapcard">{!preview ? <iframe className="tke-map-frame" loading="lazy" referrerPolicy="strict-origin-when-cross-origin" src={embedUrl} title={`${copy.location}: ${event.address}`} /> : null}<a className="tke-btn tke-sm tke-ghost tke-open-maps" href={mapUrl} rel="noreferrer" target="_blank">{copy.openMap} <ExternalIcon /></a></div>
      <div className="tke-loc-info">
        <div className="tke-addr"><b>{event.address}</b><span>{place}</span></div>
        <div className="tke-map-links">
          <a className="tke-chip-link" href={mapUrl} rel="noreferrer" target="_blank"><ExternalIcon />{CTA_LABEL[locale].openMaps}</a>
          <button className="tke-chip-link" type="button" onClick={() => { void navigator.clipboard?.writeText(query).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1800); }); }}><CopyIcon />{copied ? CTA_LABEL[locale].copied : CTA_LABEL[locale].copy}</button>
        </div>
      </div>
    </div>
  </section>;
}
function TermsCard({ event }: { event: PublicEvent }) { const copy = useEventCopy(); const terms = [[copy.visitRules, event.rules], [copy.visitTerms, event.visitTerms], [copy.cancellationTerms, event.cancellationTerms], ...(event.paymentMode === "deposit" ? [[copy.depositTerms, event.depositTerms]] : []), [copy.extraConditions, event.extraConditions]] as [string, string | null][]; return terms.some(([, text]) => text) ? <section className="tke-panel" id="terms"><div className="tke-panel-head"><div><p className="tke-kicker">{copy.terms}</p><h2>{copy.visitTerms}</h2></div></div>{terms.filter(([, text]) => text).map(([title, text], index) => <details className="tke-acc" key={title} open={index === 0}><summary><span className="tke-fact-ico" style={{ "--hue": ["#16a34a", "#7c3aed", "#ea580c", "#0284c7", "#64748b"][index % 5] } as React.CSSProperties}><InfoIcon /></span>{title}<span className="tke-chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></span></summary><p style={{ whiteSpace: "pre-wrap" }}>{text}</p></details>)}</section> : null; }
function OrganizerCard({ event }: { event: PublicEvent }) { const copy = useEventCopy(); return <section className="tke-panel" id="organizer"><p className="tke-kicker">{copy.organizer}</p><div className="tke-org">{event.organizer.photoUrl ? <img alt="" className="tke-org-ava" width={60} height={60} loading="lazy" decoding="async" onError={(image) => { image.currentTarget.style.visibility = "hidden"; }} src={resolveMedia(event.organizer.photoUrl, "")} /> : <span className="tke-org-ava">{event.organizer.name?.slice(0, 1) || "T"}</span>}<div><div className="tke-org-name">{event.organizer.name || copy.organizerTeam}{event.organizer.verified ? <span className="tke-verified"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>{copy.verifiedOrganizer}</span> : null}</div><div className="tke-org-meta">{event.organizer.personName && event.organizer.personName !== event.organizer.name ? `${event.organizer.personName} · ` : ""}{event.organizer.contact ?? copy.contactUnavailable}</div></div></div></section>; }

/** Prototype "Похожие события": the same card as the home page, from the same category. */
function SimilarEvents({ event }: { event: PublicEvent }) {
  const locale = useLocale();
  const [items, setItems] = useState<PublicEventSummary[]>([]);
  useEffect(() => {
    let active = true;
    void fetchPublicEvents({ category: event.category, page: 1, limit: 5, sort: "soonest" }).then(result => { if (active) setItems(result.items.filter(item => item.id !== event.id).slice(0, 4)); }).catch(() => undefined);
    return () => { active = false; };
  }, [event.id, event.category]);
  if (!items.length) return null;
  return <>
    <div className="tke-similar-head"><h2>{CTA_LABEL[locale].similar}</h2><Link href={localeUrl("/", locale)}>{CTA_LABEL[locale].all}</Link></div>
    <div className="tk-grid">{items.map((item, index) => <CatalogEventCard key={item.id} event={item} index={index} newTab={false} />)}</div>
  </>;
}

function remainingPlaces(event: PublicEvent, layout: PublicVenueLayout | null): number | null {
  const seats = layout?.seats?.filter(seat => seat.availability === "available").length ?? 0;
  const tickets = event.ticketTypes.filter(ticket => ticket.status === "active").reduce((sum, ticket) => sum + ticket.remaining, 0);
  const total = seats + tickets;
  return total > 0 && total <= 50 ? total : null;
}
function ShareIcon() { return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 15V3.5M7.5 8 12 3.5 16.5 8" /><path d="M5 12.5V18a2.5 2.5 0 0 0 2.5 2.5h9A2.5 2.5 0 0 0 19 18v-5.5" /></svg>; }
function ArrowIcon() { return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14m-6-6 6 6-6 6" /></svg>; }
function CopyIcon() { return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="8.5" y="8.5" width="12" height="12" rx="2.5" /><path d="M15.5 8.5V5.5A2 2 0 0 0 13.5 3.5h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3" /></svg>; }
function InfoIcon() { return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 8h.01" /></svg>; }
function ExternalIcon() { return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" /></svg>; }
/** Lowest price a guest can pay now, across ticket types, whole tables and seats of the first currency. */
function startingPrice(event: PublicEvent, layout: PublicVenueLayout | null, formatMoney: (amount: number, currency: string) => string): string | null {
  const options = [
    ...event.ticketTypes.filter(ticket => ticket.status === "active" && ticket.remaining > 0).map(ticket => ({ amount: ticket.payment.amountDue, currency: ticket.currency })),
    ...event.tables.filter(table => table.availability === "available").map(table => ({ amount: table.payment.amountDue, currency: table.currency })),
    ...(layout?.seats ?? []).filter(seat => seat.availability === "available" && seat.price !== null && seat.price !== undefined).map(seat => ({ amount: seat.price ?? 0, currency: seat.currency })),
  ].filter(option => option.currency);
  const currency = options[0]?.currency;
  const same = options.filter(option => option.currency === currency);
  if (!currency || !same.length) return null;
  return formatMoney(Math.min(...same.map(option => option.amount)), currency);
}

function parseProgram(value: string | null, fallbackTime: string, copy: typeof EVENT_COPY[EventLocale]): Array<{ time: string; label: string }> { if (!value) return [{ time: fallbackTime.slice(0, 5), label: copy.eventStart }]; const chunks = value.split(/[;\n]+/).map((part) => part.trim()).filter(Boolean); return chunks.slice(0, 8).map((part, index) => { const match = part.match(/^(\d{1,2}:\d{2})\s*[—–-]?\s*(.*)$/); return match ? { time: match[1]!, label: match[2] || copy.programStep } : { time: index === 0 ? fallbackTime.slice(0, 5) : "—", label: part }; }); }

function resolveMedia(value: string | null, fallback: string): string { if (!value) return fallback; if (value.startsWith("/staff-api/")) return value; try { return new URL(value, API_URL).toString(); } catch { return fallback; } }
function EventPageSkeleton() { return <main className="tke-page animate-pulse"><div className="tk-wrap"><div className="h-[440px] rounded-[28px] bg-ticket-raised" /><div className="tke-layout"><div className="h-64 rounded-[28px] bg-ticket-raised"/><div className="h-64 rounded-[28px] bg-ticket-raised"/></div></div></main>; }
