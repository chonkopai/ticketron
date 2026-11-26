"use client";
import { OrderChatButton } from "../../../components/floating-order-chat";

import { catalogCityOptions, eventExpiryTime, type AccountDashboard, type AccountOrderList, type AuthUser, type GuestEventList, type LinkedMethodsResponse, type NotificationPreferences, type TelegramLinkTokenResponse, formatMoney } from "@event-platform/shared-types";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { AccountIcon } from "../../../components/account-icon";
import { useDisplayCurrency } from "../../../components/currency-provider";
import { FavoritesContent } from "../../../components/favorites-content";
import { GuestEventCard } from "../../../components/guest-event-card";
import { useLocale } from "../../../components/locale-provider";
import { OptionPicker } from "../../../components/option-picker";
import { COUNTRY_CODES, countryName } from "../../../lib/countries";
import type { DisplayCurrency } from "../../../lib/display-currency";
import { ACCOUNT_EXPERIENCE_COPY } from "../../../lib/account-experience-copy";
import { SupportPanel } from "./support-panel";
import { rememberCatalogLocation, clearCatalogLocation, countryForCity } from "../../../lib/catalog-location";
import { CATALOG_CITY_SELECTED } from "../../../lib/catalog-query-events";
import { ACCOUNT_COPY } from "../../../lib/account-copy";
import { ACCOUNT_REDESIGN_COPY } from "../../../lib/account-redesign-copy";
import { INTL_LOCALES, localeUrl } from "../../../lib/locale";
import { ProtectedRoute } from "../_components/protected-route";
import { apiRequest, logoutSession } from "../_lib/api";
import { getSession, updateSessionUser } from "../_lib/session";
import { LoginMethodsPanel } from "./login-methods-panel";
import { NotificationsPanel } from "./notifications-panel";
import { SessionsPanel } from "./sessions-panel";
import { useAccountResource } from "./use-account-resource";

type AccountTab = "tickets" | "favorites" | "profile" | "notifications" | "payments" | "support";
const TABS: Exclude<AccountTab, "support">[] = ["tickets", "favorites", "profile", "notifications", "payments"];
const NAV_ICONS: Record<Exclude<AccountTab, "support">, string> = { tickets: "ticket", favorites: "heart", profile: "user-round", notifications: "bell", payments: "receipt-text" };

export default function AccountPage() {
  return <main className="account-workspace"><ProtectedRoute><Suspense fallback={<Loading />}><Account /></Suspense></ProtectedRoute></main>;
}

function Account() {
  const locale = useLocale(); const copy = ACCOUNT_COPY[locale]; const design = ACCOUNT_REDESIGN_COPY[locale]; const experience = ACCOUNT_EXPERIENCE_COPY[locale];
  const params = useSearchParams(); const requested = params.get("tab");
  const tab: AccountTab = (requested === "support" || TABS.includes(requested as Exclude<AccountTab, "support">)) ? requested as AccountTab : "tickets";
  const [user, setUser] = useState<AuthUser | null>(() => getSession()?.user ?? null);
  const profile = useAccountResource<AuthUser>("/me", false);
  const dashboard = useAccountResource<AccountDashboard>(tab === "tickets" ? "/me/dashboard" : null);
  const preferenceResource = useAccountResource<NotificationPreferences>("/me/notification-preferences", false);
  const identities = useAccountResource<LinkedMethodsResponse>(tab === "profile" ? "/me/identities" : null, false);
  const [eventStatus, setEventStatus] = useState<"upcoming" | "past">("upcoming");
  const [eventPage, setEventPage] = useState(1); const [orderPage, setOrderPage] = useState(1);
  const events = useAccountResource<GuestEventList>(tab === "tickets" ? `/me/events?status=${eventStatus}&page=${eventPage}&limit=10&locale=${locale}` : null);
  const otherEvents = useAccountResource<GuestEventList>(tab === "tickets" ? `/me/events?status=${eventStatus === "upcoming" ? "past" : "upcoming"}&page=1&limit=1&locale=${locale}` : null);
  const orders = useAccountResource<AccountOrderList>(tab === "payments" ? `/me/orders?page=${orderPage}&limit=10` : null);
  const { setCurrency } = useDisplayCurrency();
  const [defaultCountry, setDefaultCountry] = useState("");
  const [preferredCurrency, setPreferredCurrency] = useState<DisplayCurrency>("KZT");
  const [defaultCity, setDefaultCity] = useState("");
  const [message, setMessage] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [savingPreference, setSavingPreference] = useState(false); const preferenceLock = useRef(false);
  const organizer = user?.role === "organizer" || user?.role === "admin";

  useEffect(() => {
    if (tab !== "tickets") return;
    const now = Date.now();
    const cutoffs = [...(events.data?.items ?? []), ...(otherEvents.data?.items ?? [])].map(eventExpiryTime).filter(time => time > now);
    if (!cutoffs.length) return;
    const timer = setTimeout(() => { events.retry(); otherEvents.retry(); dashboard.retry(); }, Math.min(Math.min(...cutoffs) - now + 1, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [tab, events.data, otherEvents.data, events.retry, otherEvents.retry, dashboard.retry]);

  useEffect(() => { if (profile.data) { setUser(profile.data); updateSessionUser(profile.data); } }, [profile.data]);
  useEffect(() => { setDefaultCity(user?.defaultCity ?? ""); setDefaultCountry(user?.defaultCountry ?? (user?.defaultCity ? countryForCity(user.defaultCity) ?? "" : "")); setPreferredCurrency(user?.preferredCurrency ?? "KZT"); }, [user]);
  useEffect(() => { setMessage(null); }, [tab]);
  function selectTab(next: AccountTab) {
    const url = new URL(window.location.href); url.searchParams.set("tab", next); url.searchParams.set("lang", locale);
    if (url.search !== window.location.search) window.history.pushState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }
  function followTab(event: MouseEvent<HTMLAnchorElement>, next: AccountTab) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); selectTab(next);
  }
  const refreshUser = useCallback(() => {
    void apiRequest<AuthUser>("/me").then(value => { setUser(value); updateSessionUser(value); }).catch(reason => setMessage(errorMessage(reason)));
  }, []);
  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage(null);
    try { const value = await apiRequest<AuthUser>("/me", { method: "PATCH", body: JSON.stringify({ defaultCity: defaultCity.trim() || null, defaultCountry: defaultCountry || null, preferredCurrency }) }); setUser(value); updateSessionUser(value); if (value.defaultCountry) rememberCatalogLocation({ countryCode: value.defaultCountry, city: value.defaultCity ?? "" }); else clearCatalogLocation(); setCurrency(preferredCurrency); window.dispatchEvent(new Event(CATALOG_CITY_SELECTED)); setMessage(experience.saved); }
    catch (reason) { setMessage(errorMessage(reason)); } finally { setBusy(false); }
  }
  async function savePreference(key: keyof NotificationPreferences, value: boolean) {
    const previous = preferenceResource.data; if (!previous || preferenceLock.current) return;
    preferenceLock.current = true; setSavingPreference(true); setMessage(null); preferenceResource.setData({ ...previous, [key]: value });
    try { preferenceResource.setData(await apiRequest<NotificationPreferences>("/me/notification-preferences", { method: "PATCH", body: JSON.stringify({ [key]: value }) })); }
    catch (reason) { preferenceResource.setData(previous); setMessage(`${design.saveFailed} ${errorMessage(reason)}`); }
    finally { preferenceLock.current = false; setSavingPreference(false); }
  }
  async function becomeOrganizer() {
    setBusy(true); setMessage(null);
    try { const value = await apiRequest<AuthUser>("/me/become-organizer", { method: "POST" }); setUser(value); updateSessionUser(value); window.location.assign(localeUrl("/organizer/events", locale)); }
    catch (reason) { setMessage(errorMessage(reason)); } finally { setBusy(false); }
  }
  async function linkTelegram() {
    if (!user?.telegramId) { selectTab("profile"); return; }
    setBusy(true); setMessage(null);
    try { const link = await apiRequest<TelegramLinkTokenResponse>("/auth/telegram/link-token", { method: "POST" }); window.location.assign(link.deepLinkUrl); }
    catch (reason) { setMessage(errorMessage(reason)); } finally { setBusy(false); }
  }
  async function logout() {
    setBusy(true); setMessage(null);
    try { await logoutSession(); window.location.assign(localeUrl("/", locale)); }
    catch (reason) { setMessage(errorMessage(reason)); setBusy(false); }
  }
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") refreshUser(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [refreshUser]);
  const title = tab === "support" ? design.help : tab === "tickets" ? design.tickets : tab === "profile" ? design.profile : tab === "notifications" ? design.notifications : copy.tabs[tab];
  const navLabel = (item: Exclude<AccountTab, "support">) => item === "tickets" ? design.tickets : item === "profile" ? design.profileNav : item === "notifications" ? design.notificationsNav : copy.tabs[item];

  const ticketsHead = <>
    <div><h1>{title}</h1><div className="tka-stats"><span><b className="tka-num">{dashboard.data?.activeAdmissions ?? "…"}</b> {copy.activeTickets.toLowerCase()}</span><span><b className="tka-num">{dashboard.data?.attendedEvents ?? "…"}</b> {copy.attendedEvents.toLowerCase()}</span></div></div>
    <Segmented label={copy.sections} value={eventStatus} onChange={value => { setEventStatus(value as "upcoming" | "past"); setEventPage(1); }} options={(["upcoming", "past"] as const).map(item => ({ value: item, label: copy[item], count: (item === eventStatus ? events.data?.total : otherEvents.data?.total) }))} />
  </>;
  // Same markup as output/account-redesign/account.html; every section keeps its existing data and actions.
  return <div className="tk-wrap"><div className="tka-acc-layout">
    <aside className="tka-side">
      <div className="tka-panel tka-me">
        <span className="tka-me-ava">{user?.photoUrl ? <img alt="" src={new URL(user.photoUrl, process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001").toString()} /> : user?.name?.slice(0, 1).toUpperCase() || "T"}</span>
        <div><b>{user?.name || copy.user}</b><small>{user ? copy.roles[user.role] : "…"} · {user?.telegramId ? design.telegramLinked : copy.telegramUnlinked}</small></div>
      </div>
      <nav className="tka-panel tka-nav" aria-label={copy.sections}>
        <Link href={localeUrl("/", locale)} className="tka-back"><AccountIcon name="arrow-left" />{experience.backToAfisha}</Link>
        <hr />
        {TABS.map(item => <Link aria-current={tab === item ? "page" : undefined} className={tab === item ? "tka-on" : ""} key={item} href={localeUrl(`/account?tab=${item}`, locale)} onClick={event => followTab(event, item)}><AccountIcon name={NAV_ICONS[item]} />{navLabel(item)}</Link>)}
        <Link className={tab === "support" ? "tka-on" : ""} aria-current={tab === "support" ? "page" : undefined} href={localeUrl("/account?tab=support", locale)} onClick={event => followTab(event, "support")}><AccountIcon name="circle-help" />{design.help}</Link>
        <hr />
        <button className="tka-out" disabled={busy} type="button" onClick={() => void logout()}><AccountIcon name="log-out" />{design.logout}</button>
      </nav>
      <div className="tka-pro-teaser">
        <span className="tka-pro-badge">★ PRO</span>
        <b>{design.organizer}</b>
        <p>{design.organizerHint}</p>
        {organizer ? <Link href={localeUrl("/organizer/events", locale)}>{copy.organizerCabinet} <AccountIcon name="arrow-right" /></Link> : <button disabled={busy} type="button" onClick={() => void becomeOrganizer()}>{copy.becomeOrganizer} <AccountIcon name="arrow-right" /></button>}
      </div>
      <nav className="tka-mtabs" aria-label={copy.sections}>
        {TABS.map(item => <Link className={tab === item ? "tka-on" : ""} key={item} href={localeUrl(`/account?tab=${item}`, locale)} onClick={event => followTab(event, item)}><AccountIcon name={NAV_ICONS[item]} />{navLabel(item)}</Link>)}
        <Link className={tab === "support" ? "tka-on" : ""} href={localeUrl("/account?tab=support", locale)} onClick={event => followTab(event, "support")}><AccountIcon name="circle-help" />{design.help}</Link>
      </nav>
    </aside>

    <div className="account-content tka-content">
      <section className="tka-view tka-on">
      {tab === "tickets" ? <div className="tka-view-head">{ticketsHead}</div> : tab !== "favorites" ? <div className="tka-view-head"><h1>{title}</h1></div> : null}
      {message ? <p className="account-message" role="status">{message}</p> : null}{profile.error ? <ResourceError message={profile.error} onRetry={profile.retry} /> : null}
      {tab === "tickets" ? <>{dashboard.error ? <ResourceError message={dashboard.error} onRetry={dashboard.retry} /> : null}
        <TicketsPanel events={events.data} error={events.error} onRetry={events.retry} onReturned={() => { events.retry(); otherEvents.retry(); dashboard.retry(); }} page={eventPage} status={eventStatus} onPage={setEventPage} />
        <p className="tka-help-line">{design.ticketHelp} <button type="button" onClick={() => selectTab("support")}>{design.contactSupport}</button></p></> : null}
      {tab === "favorites" ? <FavoritesContent embedded /> : null}
      {tab === "profile" ? <>{identities.error ? <ResourceError message={identities.error} onRetry={identities.retry} /> : null}<LoginMethodsPanel methods={identities.data} onMethodsChange={identities.setData} onUpdated={refreshUser} /><SessionsPanel /><PreferencesPanel busy={busy} country={defaultCountry} onCountry={value => { setDefaultCountry(value); setDefaultCity(""); }} city={defaultCity} onCity={setDefaultCity} currency={preferredCurrency} onCurrency={setPreferredCurrency} onSave={saveProfile} /></> : null}
      {tab === "notifications" ? <NotificationsPanel linked={Boolean(user?.telegramChatId)} preferences={preferenceResource.data} preferencesError={preferenceResource.error} onRetryPreferences={preferenceResource.retry} busy={busy} savingPreference={savingPreference} onLink={() => void linkTelegram()} onChange={(key, value) => void savePreference(key, value)} /> : null}
      {tab === "support" ? <SupportPanel /> : null}
      {tab === "payments" ? <>{orders.error ? <ResourceError message={orders.error} onRetry={orders.retry} /> : <PaymentsPanel orders={orders.data} page={orderPage} onPage={setOrderPage} />}</> : null}
      </section>
    </div>
  </div></div>;
}

/** Prototype .seg: pill track with a sliding thumb. */
function Segmented({ label, value, options, onChange }: { label: string; value: string; options: Array<{ value: string; label: string; count?: number | undefined }>; onChange: (value: string) => void }) {
  const track = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ width: number; left: number } | null>(null);
  useEffect(() => {
    const place = () => { const button = track.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]'); if (button) setThumb({ width: button.offsetWidth, left: button.offsetLeft - 3 }); };
    place();
    const observer = new ResizeObserver(place); if (track.current) observer.observe(track.current);
    return () => observer.disconnect();
  }, [value, options.map(option => `${option.label}${option.count}`).join()]);
  return <div className="tka-seg" role="group" aria-label={label} ref={track}>
    <span className="tka-seg-thumb" style={thumb ? { width: thumb.width, transform: `translateX(${thumb.left}px)` } : undefined} />
    {options.map(option => <button key={option.value} type="button" aria-pressed={option.value === value} onClick={() => onChange(option.value)}>{option.label} <span className="tka-n">{option.count ?? "…"}</span></button>)}
  </div>;
}


function TicketsPanel({ events, error, onRetry, onReturned, page, status, onPage }: { events: GuestEventList | null; error: string | null; onRetry: () => void; onReturned: () => void; page: number; status: "upcoming" | "past"; onPage: (page: number) => void }) {
  const locale = useLocale(); const copy = ACCOUNT_COPY[locale]; const design = ACCOUNT_REDESIGN_COPY[locale];
  return <>{error ? <ResourceError message={error} onRetry={onRetry} /> : null}{!events ? error ? null : <Loading /> : events.items.length ? <div className="tka-tickets account-event-list">{events.items.map((event, index) => <GuestEventCard event={event} key={event.id} index={index} onReturned={onReturned} />)}</div> : <div className="tka-panel tka-empty-state"><AccountIcon name="ticket" /><b>{status === "upcoming" ? design.noUpcoming : copy.noPast}</b><p>{design.emptyTicketsHint}</p><Link className="tka-btn tka-sm" href={localeUrl("/", locale)}>{design.findEvent}</Link></div>}{events && events.total > events.limit ? <Pager page={page} hasNext={events.hasNext} onPage={onPage} /> : null}</>;
}

function PreferencesPanel({ busy, country, onCountry, city, onCity, currency, onCurrency, onSave }: { busy: boolean; country: string; onCountry: (value: string) => void; city: string; onCity: (value: string) => void; currency: DisplayCurrency; onCurrency: (value: DisplayCurrency) => void; onSave: (event: FormEvent<HTMLFormElement>) => void }) {
  const locale = useLocale(); const copy = ACCOUNT_COPY[locale]; const design = ACCOUNT_REDESIGN_COPY[locale]; const experience = ACCOUNT_EXPERIENCE_COPY[locale];
  const labels = { ru: ["Страна", "Все страны", "Выберите страну, город и валюту для поиска событий."], kk: ["Ел", "Барлық елдер", "Іс-шара іздеу үшін елді, қаланы және валютаны таңдаңыз."], en: ["Country", "All countries", "Choose your country, city, and currency for finding events."] }[locale];
  const [locations, setLocations] = useState<{ countryCode: string; cities: string[] }[]>([]);
  useEffect(() => { let active = true; void fetch("/api/events/locations").then(response => response.ok ? response.json() : []).then(value => { if (active && Array.isArray(value)) setLocations(value); }).catch(() => {}); return () => { active = false; }; }, []);
  const cities = catalogCityOptions(country, locale, [...(locations.find(item => item.countryCode === country)?.cities ?? []), ...(city ? [city] : [])]);
  return <form className="account-card account-preferences-form" onSubmit={onSave}><div><h2>{experience.preferences}</h2><p className="account-subtitle">{labels[2]}</p></div><div className="grid gap-4 sm:grid-cols-2">
    <div className="account-city-preference"><label htmlFor="account-country-picker">{labels[0]}</label><OptionPicker id="account-country-picker" label={labels[0]!} value={country} options={[{ value: "", label: labels[1]! }, ...[...COUNTRY_CODES].sort((a,b) => countryName(a,locale).localeCompare(countryName(b,locale),locale)).map(code => ({ value: code, label: countryName(code, locale) }))]} disabled={busy} onChange={onCountry} icon={<AccountIcon name="map-pin" />} /></div>
    <div className="account-city-preference"><label htmlFor="account-city-picker">{copy.defaultCity}</label><OptionPicker id="account-city-picker" label={copy.defaultCity} value={city} options={[{ value: "", label: design.chooseCity }, ...cities]} disabled={busy || !country} onChange={onCity} icon={<AccountIcon name="map-pin" />} /></div>
    <div className="account-city-preference"><label htmlFor="account-currency-picker">{design.defaultCurrency}</label><OptionPicker id="account-currency-picker" label={design.defaultCurrency} value={currency} options={[{ value: "KZT", label: ({ ru: "Казахстанский тенге", kk: "Қазақстан теңгесі", en: "Kazakhstani tenge" })[locale] + " · KZT ₸" }, { value: "RUB", label: ({ ru: "Российский рубль", kk: "Ресей рублі", en: "Russian ruble" })[locale] + " · RUB ₽" }, { value: "USD", label: "US dollar · USD $" }]} disabled={busy} onChange={value => onCurrency(value as DisplayCurrency)} icon={<AccountIcon name="money" />} /></div>
  </div><button className="account-button account-button-primary" disabled={busy} type="submit">{copy.saveChanges}</button></form>;
}

function PaymentsPanel({ orders, page, onPage }: { orders: AccountOrderList | null; page: number; onPage: (page: number) => void }) {
  const copy = ACCOUNT_COPY[useLocale()]; if (!orders) return <Loading />;
  return <section className="account-card account-orders"><div><h2>{copy.paymentsTitle}</h2><p className="account-subtitle">{copy.onlyAccount}</p></div>{orders.items.length ? <OrderRows orders={orders} /> : <p className="account-muted">{copy.paymentsEmpty}</p>}{orders.total > orders.limit ? <Pager page={page} hasNext={orders.hasNext} onPage={onPage} /> : null}</section>;
}
function OrderRows({ orders }: { orders: AccountOrderList }) {
  const locale = useLocale(); const copy = ACCOUNT_COPY[locale];
  return <div className="account-order-list">{orders.items.map(order => <article className="account-order" key={order.id}><div><div className="account-order-title"><h3>{order.eventTitle}</h3><span>{order.paymentUnsuccessful || order.status === "failed" ? ({ ru: "Оплата не прошла", en: "Payment unsuccessful", kk: "Төлем өтпеді" })[locale] : copy.paymentStatuses[order.status]}</span></div><p>{order.itemSummary} · {new Intl.DateTimeFormat(INTL_LOCALES[locale], { dateStyle: "medium" }).format(new Date(order.createdAt))}</p><p className="account-receipt">{copy.receiptUnavailable}</p>{order.eventId ? <OrderChatButton className="account-text-link" eventId={order.eventId!} orderId={order.id} title={order.eventTitle}>{copy.writeOrganizer}</OrderChatButton> : null}</div><strong>{formatMoney(order.amount, order.currency, INTL_LOCALES[locale])}</strong></article>)}</div>;
}

function Pager({ page, hasNext, onPage }: { page: number; hasNext: boolean; onPage: (page: number) => void }) { const copy = ACCOUNT_COPY[useLocale()]; return <nav className="account-pager" aria-label={copy.pages}><button className="account-button" disabled={page === 1} type="button" onClick={() => onPage(Math.max(1, page - 1))}>{copy.back}</button><span>{copy.page} {page}</span><button className="account-button" disabled={!hasNext} type="button" onClick={() => onPage(page + 1)}>{copy.next}</button></nav>; }
function ResourceError({ message, onRetry }: { message: string; onRetry: () => void }) { return <div className="account-resource-error" role="alert"><p>{message}</p><button type="button" className="account-text-link" onClick={onRetry}>{ACCOUNT_REDESIGN_COPY[useLocale()].retry}</button></div>; }
function Loading() { return <p className="account-loading" role="status">{ACCOUNT_COPY[useLocale()].loading}</p>; }
function errorMessage(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason); }
