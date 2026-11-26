import { formatMoney } from "@event-platform/shared-types";
import "./app.css";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { TelegramSeatCatalogue, TelegramSeatItem, TelegramSeatOffer, TelegramSeatOrder, TelegramSeatSelection, TelegramSeatSession } from "@event-platform/shared-types";
import { GuestHallPlan } from "../components/guest-hall-plan";
import { copy, seatLocale, type SeatCopy } from "./copy";
import { api, openSession, SeatApiError, syncTelegramViewport, telegram } from "./platform";

const noSelection: TelegramSeatSelection = { seatIds: [] };
const changedCodes = new Set([
  "BOT_OFFER_CHANGED", "REFUND_POLICY_CHANGED", "EVENT_PRESENTATION_CHANGED", "BOT_OFFER_EXPIRED",
  "QUICK_ACCESS_INVALID", "SEAT_UNAVAILABLE", "SEAT_SALES_WINDOW_CLOSED", "TABLE_UNAVAILABLE", "TABLE_NOT_AVAILABLE",
  "TABLE_REQUIRES_SEAT_SELECTION", "EVENT_SALES_PAUSED", "EVENT_ENDED", "EVENT_NOT_PUBLISHED",
]);

function App() {
  const [locale, setLocale] = useState(seatLocale(navigator.language));
  const [session, setSession] = useState<TelegramSeatSession>();
  const [catalogue, setCatalogue] = useState<TelegramSeatCatalogue>();
  const [selection, setSelection] = useState(noSelection);
  const [view, setView] = useState<"list" | "map">("list");
  const [offer, setOffer] = useState<TelegramSeatOffer>();
  const [order, setOrder] = useState<TelegramSeatOrder>();
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [launchEnded, setLaunchEnded] = useState(false);
  const working = useRef(false);
  const catalogueRequest = useRef(0);
  const c = copy[locale];
  const stage = launchEnded ? "start" : order ? "order" : offer ? "review" : catalogue ? "pick" : "start";

  function money(amount: number, currency: string) {
    if (amount === 0) return c.free;
    return formatMoney(amount, currency, locale);
  }

  useEffect(() => {
    const events = ["themeChanged", "viewportChanged", "safeAreaChanged", "contentSafeAreaChanged"] as const;
    syncTelegramViewport();
    events.forEach(event => telegram?.onEvent(event, syncTelegramViewport));
    telegram?.ready();
    telegram?.expand();
    void act(bootstrap);
    return () => events.forEach(event => telegram?.offEvent(event, syncTelegramViewport));
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [stage]);

  useEffect(() => {
    const button = telegram?.BackButton;
    if (!button) return;
    if (stage === "review" || stage === "order") button.show();
    else button.hide();
    const back = () => {
      if (working.current) return;
      if (stage === "review") setOffer(undefined);
      else telegram?.close();
    };
    button.onClick(back);
    return () => { button.offClick(back); button.hide(); };
  }, [stage]);

  useEffect(() => {
    if (!session || stage !== "pick") return;
    const refresh = () => {
      if (!document.hidden && !working.current) void loadCatalogue(session).catch(() => { /* The next explicit action revalidates availability. */ });
    };
    const timer = window.setInterval(refresh, 15000);
    telegram?.onEvent("activated", refresh);
    return () => { window.clearInterval(timer); telegram?.offEvent("activated", refresh); };
  }, [session, stage]);

  useEffect(() => {
    if (!session || stage !== "order" || order?.status !== "pending") return;
    const refresh = () => { if (!document.hidden && !working.current) void act(() => loadOrder(session, order.orderId), true); };
    const timer = window.setInterval(refresh, 7000);
    window.addEventListener("focus", refresh);
    telegram?.onEvent("activated", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      telegram?.offEvent("activated", refresh);
    };
  }, [session, stage, order?.orderId, order?.status]);

  async function bootstrap() {
    const current = await openSession();
    setSession(current);
    setLocale(current.locale);
    const result = await api<{ order: TelegramSeatOrder | null }>("order", current.token);
    if (result.order) setOrder(result.order);
    else await loadCatalogue(current);
  }

  async function loadCatalogue(current: TelegramSeatSession) {
    const request = ++catalogueRequest.current;
    const next = await api<TelegramSeatCatalogue>("catalogue", current.token);
    if (request === catalogueRequest.current) setCatalogue(next);
  }

  async function loadOrder(current: TelegramSeatSession, id: string, resume = false) {
    setOrder(await api<TelegramSeatOrder>(`order/${id}${resume ? "/resume" : ""}`, current.token, resume ? {} : undefined));
  }

  async function act(operation: () => Promise<void>, quiet = false) {
    if (working.current) return;
    working.current = true;
    if (!quiet) { setBusy(true); setError(""); }
    try {
      await operation();
    } catch (failure) {
      const code = failure instanceof SeatApiError ? failure.code : "REQUEST_FAILED";
      if (["ACCOUNT_RESTRICTED", "BOT_PRIVATE_CHAT_REQUIRED", "TELEGRAM_SEAT_SESSION_EXPIRED", "TELEGRAM_SEAT_LAUNCH_USED", "TELEGRAM_SEAT_LAUNCH_INVALID", "OPEN_FROM_BOT"].includes(code)) {
        setLaunchEnded(true);
        setError(code);
      } else if (!quiet) {
        setError(code);
        if (changedCodes.has(code) && session) {
          setOffer(undefined);
          setAccepted(false);
          try { await loadCatalogue(session); } catch { setCatalogue(undefined); }
        }
      }
    } finally {
      working.current = false;
      if (!quiet) setBusy(false);
    }
  }

  const items = new Map(catalogue?.groups.flatMap(group => group.items.map(item => [item.id, item] as const)));
  const picked = [...selection.seatIds, ...(selection.tableId ? [selection.tableId] : [])];
  const pickedItems = picked.flatMap(id => items.get(id) ?? []);
  const hasAvailable = [...items.values()].some(item => item.available);
  const canReview = pickedItems.length > 0 && pickedItems.length === picked.length && pickedItems.every(item => item.available) && !catalogue?.closed;

  function toggle(item?: TelegramSeatItem) {
    if (!item || busy) return;
    setError("");
    if (picked.includes(item.id)) {
      setSelection(item.kind === "table" ? { seatIds: selection.seatIds } : {
        ...selection, seatIds: selection.seatIds.filter(id => id !== item.id),
      });
      return;
    }
    if (!item.available) return;
    if (item.kind === "seat" && selection.seatIds.length >= 10) { setError("CART_SELECTION_INVALID"); return; }
    if (pickedItems.some(other => other.currency !== item.currency && (item.kind !== "table" || other.kind !== "table"))) {
      setError("CART_CURRENCY_MISMATCH");
      return;
    }
    setSelection(item.kind === "table" ? { ...selection, tableId: item.id } : {
      ...selection, seatIds: [...selection.seatIds, item.id],
    });
  }

  async function review() {
    if (!session || !canReview) return;
    const quote = await api<TelegramSeatOffer>("quote", session.token, selection);
    setAccepted(false);
    setOffer(quote);
  }

  async function confirm() {
    if (!session || !offer || !accepted) return;
    const next = await api<TelegramSeatOrder>(`confirm/${offer.reference}`, session.token, { termsAccepted: true });
    setOrder(next);
    setOffer(undefined);
    setSelection(noSelection);
  }

  async function chooseAgain() {
    if (!session) return;
    await loadCatalogue(session);
    setOrder(undefined);
    setOffer(undefined);
    setSelection(noSelection);
  }

  const warning = message(c, error);
  const chatUrl = order?.chatUrl ?? session?.chatUrl;
  const orderHasChatAction = stage === "order" && order &&
    (order.status === "pending" || order.status === "paid" || order.status === "review_required");

  return <main className="shell">
    <header>
      {stage === "review" ? <button className="quiet" disabled={busy} onClick={() => setOffer(undefined)}>{c.back}</button>
        : chatUrl && !launchEnded && !orderHasChatAction ? <ChatButton url={chatUrl}>{c.chat}</ChatButton> : null}
      <h1>{stage === "order" && order ? order.title : stage === "review" && offer ? offer.title : catalogue?.event.title ?? c.picker}</h1>
      {stage === "pick" && catalogue && <p className="muted event-meta">{[catalogue.event.date, catalogue.event.time.slice(0, 5), catalogue.event.timezone, catalogue.event.address].filter(Boolean).join(" · ")}</p>}
    </header>

    {warning && <p className="notice" role="alert">{warning}</p>}

    {stage === "start" && (
      launchEnded ? (chatUrl ? <ChatButton url={chatUrl} strong>{c.chat}</ChatButton>
        : telegram && <button className="primary" onClick={() => telegram?.close()}>{c.back}</button>)
        : busy ? <p role="status">{c.loading}</p> : <button className="primary" onClick={() => void act(bootstrap)}>{c.retry}</button>
    )}

    {stage === "pick" && catalogue && <>
      {catalogue.closed ? <p className="notice">{c.unavailable}</p> : !hasAvailable ? <p className="notice">{c.soldOut}</p> : null}
      {catalogue.layout && <div className="segmented" role="group" aria-label={c.picker}>
        <button type="button" aria-pressed={view === "list"} onClick={() => setView("list")}>{c.list}</button>
        <button type="button" aria-pressed={view === "map"} onClick={() => setView("map")}>{c.map}</button>
      </div>}
      {view === "map" && catalogue.layout
        ? <GuestHallPlan layout={catalogue.layout} compact copy={c} salesAvailable={!catalogue.closed}
          tableOptions={catalogue.layout.tables.map(table => ({
            ...table, availability: items.get(table.id)?.available ? "available" : "unavailable",
          }))}
          selectedSeatIds={selection.seatIds} selectedTableId={selection.tableId ?? null}
          canSelectSeat={id => items.get(id)?.available === true} seatLabels={new Map([...items.values()].map(item => [item.id, item.label]))}
          onSeat={seat => toggle(items.get(seat.id))} onTable={id => toggle(items.get(id))} />
        : <SeatList groups={catalogue.groups} picked={picked} copy={c} money={money} onToggle={toggle} />}
      {!!picked.length && <footer className="actions">
        <div className="selection" aria-live="polite"><span>{c.selected} {picked.length}</span></div>
        <div className="picked">{pickedItems.map(item => <button key={item.id} onClick={() => toggle(item)} aria-label={`${item.label} ×`}>{item.label} ×</button>)}</div>
        {!canReview && <><div className="muted">{c.changed}</div><button onClick={() => setSelection(noSelection)}>{c.chooseAgain}</button></>}
        <button className="primary" disabled={busy || !canReview} onClick={() => void act(review)}>{busy ? c.loading : c.review}</button>
      </footer>}
    </>}

    {stage === "review" && offer && <>
      <OrderItems {...offer} copy={c} money={money} />
      <Terms value={offer.refundTerms} available={offer.refundsAvailable} copy={c} locale={offer.locale} />
      <footer className="actions">
        <label className="accept"><input type="checkbox" checked={accepted} disabled={busy} onChange={event => setAccepted(event.target.checked)} />{c.accept}</label>
        <button className="primary" disabled={!accepted || busy} onClick={() => void act(confirm)}>{busy ? c.loading : c.confirm}</button>
      </footer>
    </>}

    {stage === "order" && order && <>
      <div role="status"><h2 className="status">{c.statuses[order.status]}</h2></div>
      {order.status === "pending" && order.expiresAt && <Countdown expiry={order.expiresAt} serverTime={order.serverTime} label={c.held} />}
      <OrderItems {...order} copy={c} money={money} />
      <Terms value={order.refundTerms} available={order.refundsAvailable} copy={c} />
      {order.status === "pending" && <footer className="actions">
        {order.paymentLink?.startsWith("https://") ? <button className="primary" type="button" onClick={() => telegram?.openLink(order.paymentLink!)}>{c.pay}</button>
          : <p className="muted">{order.demoPayment ? c.demo : c.paymentUnavailable}</p>}
        <button className={order.paymentLink ? "secondary" : "primary"} disabled={busy} onClick={() => session && void act(() => loadOrder(session, order.orderId, !order.paymentLink))}>{c.check}</button>
        <ChatButton url={order.chatUrl}>{c.tickets}</ChatButton>
      </footer>}
      {order.status !== "pending" && <footer className="actions">
        {(order.status === "paid" || order.status === "review_required") && <ChatButton url={order.chatUrl} strong>{c.tickets}</ChatButton>}
        {order.status !== "review_required" && <button className={order.status === "paid" ? "secondary" : "primary"} disabled={busy} onClick={() => void act(chooseAgain)}>{c.chooseAgain}</button>}
      </footer>}
    </>}
  </main>;
}

function ChatButton({ url, strong, children }: { url: string; strong?: boolean; children: ReactNode }) {
  return <button className={strong ? "primary" : "quiet"} onClick={() => {
    if (telegram) telegram.openTelegramLink(url);
    else window.location.assign(url);
  }}>{children}</button>;
}

type Money = (amount: number, currency: string) => string;
function SeatList({ groups, picked, copy: c, money, onToggle }: {
  groups: TelegramSeatCatalogue["groups"]; picked: string[]; copy: SeatCopy; money: Money; onToggle: (item: TelegramSeatItem) => void;
}) {
  return <div className="seat-groups">{groups.map(group => (
    <section className="seat-group" key={group.items[0]!.id}>
      <h2>{group.label}</h2>
      <ul>{group.items.map(item => (
        <li key={item.id}><button className="seat-option" aria-pressed={picked.includes(item.id)} disabled={!item.available && !picked.includes(item.id)} onClick={() => onToggle(item)}>
          <span>{item.label}{item.capacity !== undefined && <small>{c.capacity(item.capacity)}</small>}</span>
          <span>{money(item.amount, item.currency)}{!item.available && <small>{c.seatUnavailable}</small>}</span>
        </button></li>
      ))}</ul>
    </section>
  ))}</div>;
}

function OrderItems({ items, amountDue, currency, copy: c, money }: {
  items: { label: string; amount: number; capacity?: number }[]; amountDue: number; currency: string; copy: SeatCopy; money: Money;
}) {
  return <section className="receipt">
    <ul>{items.map((item, index) => <li key={index}>
      <span>{item.label}{item.capacity !== undefined && <small>{c.capacity(item.capacity)}</small>}</span>
      <span>{money(item.amount, currency)}</span>
    </li>)}</ul>
    <div className="selection"><span>{c.total}</span><strong>{money(amountDue, currency)}</strong></div>
  </section>;
}

function Terms({ value, available, copy: c, locale }: { value: string | null; available: boolean | null; copy: SeatCopy; locale?: TelegramSeatSession["locale"] }) {
  return <section className="terms"><h2>{c.terms}</h2><p lang={available !== false && value ? locale : undefined}>{available === false ? c.noRefund : value || c.noTerms}</p></section>;
}

function Countdown({ expiry, serverTime, label }: { expiry: string; serverTime: string; label: string }) {
  const [now, setNow] = useState(Date.now());
  const anchor = useRef({ serverTime, receivedAt: Date.now() });
  useEffect(() => {
    anchor.current = { serverTime, receivedAt: Date.now() };
    setNow(Date.now());
  }, [serverTime]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const remaining = Math.max(0, Math.ceil((Date.parse(expiry) - Date.parse(anchor.current.serverTime) - (now - anchor.current.receivedAt)) / 1000));
  const value = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;
  return <p className="countdown">{label} <strong role="timer">{value}</strong></p>;
}

function message(c: SeatCopy, code: string) {
  if (!code) return "";
  if (changedCodes.has(code)) return c.changed;
  if (code === "CART_CURRENCY_MISMATCH") return c.currencies;
  if (code === "CART_SELECTION_INVALID") return c.limit;
  if (code === "MONEY_TOTAL_OVERFLOW") return c.amountLimit;
  if (code === "ACCOUNT_RESTRICTED") return c.restricted;
  if (code === "BOT_OFFER_LIMIT") return c.offerLimit;
  if (code === "OPEN_FROM_BOT" || code === "BOT_PRIVATE_CHAT_REQUIRED") return c.launch;
  if (code.startsWith("TELEGRAM_SEAT_")) return c.relaunch;
  if (code === "EVENT_NOT_FOUND") return c.eventGone;
  return c.error;
}

createRoot(document.getElementById("root")!).render(<App />);
