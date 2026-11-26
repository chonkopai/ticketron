"use client";
import { useEventEnded } from "../../../lib/use-event-ended";
import { RefundPolicyText } from "../../../components/event-presentation";

import { INTL_LOCALES, localeUrl } from "../../../lib/locale";

import { type CreateCartCheckoutRequest, type CheckoutEmailChoice, type CheckoutResponse, type PublicEvent, type PublicPaymentOption, type PublicVenueLayout, type PublicVenueSeat, formatMoney } from "@event-platform/shared-types";
import { GuestInlineCheckout } from "../../../components/guest-inline-checkout";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiRequest } from "../../(auth)/_lib/api";
import { getSession, subscribeSession } from "../../(auth)/_lib/session";
import { CheckoutEmailOption } from "../../../components/checkout-email-option";
import { useDisplayCurrency } from "../../../components/currency-provider";
import { useLocale } from "../../../components/locale-provider";
import { CHECKOUT_COPY } from "../../../lib/checkout-copy";
import { BOOKING_PANEL_COPY } from "../../../lib/booking-panel-copy";
import { AccountIcon } from "../../../components/account-icon";
import { CheckoutPaymentDialog } from "./checkout-payment-dialog";
import "./checkout-panel.css";

interface CheckoutPanelProps {
  hasHall?: boolean;
  showRefund?: boolean;
  readOnly?: boolean;
  onRestoreSelection?: ((body: CreateCartCheckoutRequest) => void) | undefined;
  onLockChange?: ((locked: boolean) => void) | undefined;
  emptyMessage?: string | undefined;
  event: PublicEvent;
  layout: PublicVenueLayout | null;
  selectedSeatIds: string[];
  selectedTableId: string | null;
  onTableChange: (id: string | null) => void;
  ticketQuantities: Record<string, number>;
  onTicketChange: (id: string, quantity: number) => void;
  onClearSeats: () => void;
  onRefreshAvailability: () => Promise<void>;
}

export function CheckoutPanel({ event, layout, hasHall = false, showRefund = true, selectedSeatIds, selectedTableId, onTableChange, ticketQuantities, onTicketChange, onClearSeats, onRefreshAvailability, readOnly = false, emptyMessage, onLockChange, onRestoreSelection }: CheckoutPanelProps) {
  const locale = useLocale();
  const ended = useEventEnded(event) && !readOnly;
  const copy = CHECKOUT_COPY[locale];
  const design = BOOKING_PANEL_COPY[locale];
  const { currency: displayCurrency, formatMoney: formatDisplayMoney } = useDisplayCurrency();
  const [accepted, setAccepted] = useState(false);
  const [guestLocked, setGuestLocked] = useState(false);
  const freezeGuest = useCallback((locked: boolean) => { setGuestLocked(locked); onLockChange?.(locked); }, [onLockChange]);
  useEffect(()=>setAccepted(false),[event.refundPolicyRevision,event.contentLocale]);
  const checkoutInFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [payment, setPayment] = useState<{ order: CheckoutResponse; guestAccess?: string } | null>(null);
  const [paymentOpen, setPaymentOpen] = useState(false);
  function openPayment(order: CheckoutResponse, guestAccess?: string) {
    setPayment({ order, ...(guestAccess ? { guestAccess } : {}) });
    setPaymentOpen(true);
  }
  function closePayment(retry: boolean) {
    setPaymentOpen(false);
    if (!retry) return;
    setPayment(null);
    freezeGuest(false);
    setAccepted(false);
    void onRefreshAvailability().catch(() => setError(copy.failed));
  }
  const [result, setResult] = useState<CheckoutResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loggedIn, setLoggedIn] = useState(false);
  const [emailRequested, setEmailRequested] = useState(false);
  const [emailChoice, setEmailChoice] = useState<CheckoutEmailChoice | null>(null);
  useEffect(() => {
    if (readOnly) return;
    const refresh = () => setLoggedIn(Boolean(getSession()));
    refresh();
    return subscribeSession(refresh);
  }, [readOnly]);
  useEffect(() => { setResult(null); setError(null); }, [selectedSeatIds, selectedTableId, ticketQuantities]);
  const selectionKey = JSON.stringify([selectedSeatIds.toSorted(), selectedTableId, Object.entries(ticketQuantities).sort(([left], [right]) => left.localeCompare(right))]);
  useEffect(() => setAccepted(false), [selectionKey]);

  const selectedTickets = event.ticketTypes.filter((ticket) => (ticketQuantities[ticket.id] ?? 0) > 0);
  const selection = useMemo(() => {
    const items: Array<{ label: string; amount: number; currency: string }> = [];
    let invalid = false;
    for (const ticket of event.ticketTypes) {
      const quantity = ticketQuantities[ticket.id] ?? 0;
      if (!quantity) continue;
      if (ticket.status !== "active" || quantity > ticket.remaining) invalid = true;
      items.push({ label: `${ticket.name} × ${quantity}`, amount: ticket.payment.amountDue * quantity, currency: ticket.currency });
    }
    const table = event.tables.find((item) => item.id === selectedTableId);
    if (selectedTableId && (!table || table.availability !== "available")) invalid = true;
    if (table) items.push({ label: `${table.name ?? `${copy.table} ${table.number}`} · ${copy.wholeTable}`, amount: table.payment.amountDue, currency: table.currency });
    for (const id of selectedSeatIds) {
      const seat = layout?.seats?.find((item) => item.id === id);
      if (!seat || seat.availability !== "available") { invalid = true; continue; }
      items.push({ label: seatLabel(layout!, seat, copy), amount: seat.price ?? 0, currency: seat.currency });
    }
    const currency = items[0]?.currency ?? "";
    const count = selectedSeatIds.length + selectedTickets.reduce((sum, ticket) => sum + (ticketQuantities[ticket.id] ?? 0), 0);
    if (count > 10 || items.some((item) => item.currency !== currency)) invalid = true;
    return { items, amount: items.reduce((sum, item) => sum + item.amount, 0), currency, valid: items.length > 0 && !invalid, reason: invalid ? copy.invalidSelection : null };
  }, [event, layout, selectedSeatIds, selectedTableId, ticketQuantities, selectedTickets, copy]);
  useEffect(() => {
    if (!selection.items.length) { setEmailRequested(false); setEmailChoice(null); }
  }, [selection.items.length]);

  async function checkout(): Promise<void> {
    if (readOnly || ended || !accepted || checkoutInFlight.current || payment || !selection.valid || (emailRequested && !emailChoice)) return;
    checkoutInFlight.current = true;
    let keepSelectionLocked = false;
    freezeGuest(true);
    setBusy(true); setError(null); setResult(null);
    try {
      const emailDelivery = emailChoice ? { emailDelivery: emailChoice } : {};
      const cartBody = { eventId: event.id, tickets: selectedTickets.map((ticket) => ({ ticketTypeId: ticket.id, quantity: (ticketQuantities[ticket.id] ?? 0) })), ...(selectedTableId ? { tableId: selectedTableId } : {}), seatIds: selectedSeatIds, termsAccepted: true, contentLocale:event.contentLocale,policyRevision:event.refundPolicyRevision, ...emailDelivery };
      const request = selectedTickets.length === 1 && !selectedTableId && !selectedSeatIds.length
        ? { path: "/me/checkouts/tickets", body: { ticketTypeId: selectedTickets[0]!.id, quantity: (ticketQuantities[selectedTickets[0]!.id] ?? 0), termsAccepted: true, contentLocale:event.contentLocale,policyRevision:event.refundPolicyRevision, ...emailDelivery } }
        : selectedTableId && !selectedTickets.length && !selectedSeatIds.length
          ? { path: "/me/checkouts/tables", body: { tableId: selectedTableId, termsAccepted: true, contentLocale:event.contentLocale,policyRevision:event.refundPolicyRevision, ...emailDelivery } }
          : selectedSeatIds.length && !selectedTickets.length && !selectedTableId
            ? { path: "/me/checkouts/seats", body: { seatIds: selectedSeatIds, termsAccepted: true, contentLocale:event.contentLocale,policyRevision:event.refundPolicyRevision, ...emailDelivery } }
            : { path: "/me/checkouts/cart", body: cartBody };
      const fingerprint = `${request.path}:${JSON.stringify(request.body)}`;
      const keyStorage = `ticket-checkout-key:${event.id}`;
      const prior = sessionStorage.getItem(keyStorage);
      let requestKey = crypto.randomUUID();
      if (prior) { try { const saved = JSON.parse(prior) as { fingerprint: string; key: string }; if (saved.fingerprint === fingerprint && /^[0-9a-f-]{36}$/i.test(saved.key)) requestKey = saved.key; } catch { /* Ignore stale browser state. */ } }
      sessionStorage.setItem(keyStorage, JSON.stringify({ fingerprint, key: requestKey }));
      const response = await apiRequest<CheckoutResponse>(request.path, { method: "POST", headers: { "Idempotency-Key": requestKey }, body: JSON.stringify(request.body) });
      if (response.amountDue > 0) { keepSelectionLocked = true; openPayment(response); }
      else setResult(response);
      sessionStorage.removeItem(keyStorage);
    } catch (reason) { setError(reason instanceof Error ? reason.message : copy.failed); }
    finally { checkoutInFlight.current = false; if (!keepSelectionLocked) freezeGuest(false); setBusy(false); }
  }

  const refund = showRefund && event.creationVersion === 2 ? <CheckoutRefund event={event} /> : null;
  const header = <header className="checkout-heading">
    <span className="checkout-heading-icon"><AccountIcon name="ticket" /></span>
    <div><h2>{copy.choose}</h2><p>{hasHall ? design.hallIntro : event.saleMode === "free" ? design.freeIntro : design.paidIntro}</p></div>
  </header>;
  if (ended && !payment) return <aside id="tickets" className="event-booking">
    <div className="checkout-empty" role="status"><AccountIcon name="info" /><h3>{design.ended}</h3><p>{design.endedHint}</p></div>
    {refund}
  </aside>;
  if (event.paymentMode === "deposit" && !payment) return <aside id="tickets" className="event-booking">
    {header}<div className="checkout-empty"><AccountIcon name="info" /><h3>{design.paused}</h3><p>{design.pausedHint}</p></div>
    {refund}
  </aside>;
  const availableTables = event.tables.filter((table) => table.saleMode === "whole_table");
  if (event.salesPaused && !readOnly && !payment) return <aside className="event-booking" id="tickets">{header}<div className="checkout-empty" role="status"><AccountIcon name="ticket"/><p>{({ru:"Продажи и регистрация временно остановлены.",kk:"Сатылым мен тіркелу уақытша тоқтатылған.",en:"Sales and registration are temporarily paused."})[locale]}</p></div>{refund}</aside>;
  const hasSelectableSeats = Boolean(layout?.seats?.some((seat) => seat.availability === "available"));
  const hasAvailableInventory = event.ticketTypes.some((ticket) => ticket.status === "active" && ticket.remaining > 0)
    || availableTables.some((table) => table.availability === "available") || hasSelectableSeats;
  if (!hasAvailableInventory && !payment && !busy && !guestLocked) return <aside className="event-booking" id="tickets">
    {header}<div className="checkout-empty"><AccountIcon name="ticket" /><p>{emptyMessage ?? copy.noOptions}</p></div>
    {refund}
  </aside>;
  const total = selection.amount === 0 ? design.free : formatMoney(selection.amount, selection.currency, INTL_LOCALES[locale]);
  const checkoutDisabled = !accepted || !selection.valid || busy || (emailRequested && !emailChoice);
  const resultHref = result ? localeUrl(result.ticketIds[0] ? `/account/tickets/${result.ticketIds[0]}` : "/account", locale) : "";
  const hint = guestLocked || !selection.items.length ? null : !accepted ? design.acceptHint : emailRequested && !emailChoice ? design.emailHint : null;
  return <aside className="event-booking" id="tickets">
    {header}
    {hasHall || hasSelectableSeats ? <a className="checkout-plan-button" href="#venue-plan"><AccountIcon name="map-pin" /><span>{copy.plan.replace(/\s*↓$/, "")}</span><AccountIcon name="arrow-up-right" /></a> : null}
    <fieldset className="checkout-options" disabled={guestLocked || Boolean(payment)}>
      {event.ticketTypes.filter(ticket => !hasHall || !ticket.venueObjectId || (ticketQuantities[ticket.id] ?? 0) > 0).map(ticket => {
        const quantity = ticketQuantities[ticket.id] ?? 0;
        const available = ticket.status === "active" && ticket.remaining > 0;
        return <article className={`checkout-ticket${quantity ? " is-selected" : ""}${available ? "" : " is-unavailable"}`} key={ticket.id} aria-label={ticket.name}>
          <div className="checkout-ticket-heading"><h3>{ticket.name}</h3><strong className="checkout-option-price">{ticket.payment.amountDue === 0 ? design.free : paymentSummary(ticket.payment, formatDisplayMoney)}</strong></div>
          {ticket.description ? <p className="checkout-ticket-description">{ticket.description}</p> : null}
          <div className="checkout-ticket-controls"><span className={`checkout-availability${available ? "" : " is-unavailable"}`}><span aria-hidden="true" />{available ? `${ticket.remaining} ${copy.left}` : copy.unavailable}</span>
            {quantity ? <div className="checkout-stepper" role="group" aria-label={`${copy.quantity}: ${ticket.name}`}>
              <button aria-label={`${copy.decrease} ${ticket.name}`} onClick={click => { const option = click.currentTarget.closest("article"); onTicketChange(ticket.id, quantity - 1); if (quantity === 1) requestAnimationFrame(() => option?.querySelector<HTMLButtonElement>(".checkout-add")?.focus({ preventScroll: true })); }} type="button">−</button>
              <output aria-live="polite" aria-label={`${copy.quantity}: ${ticket.name}`}>{quantity}</output>
              <button aria-label={`${copy.increase} ${ticket.name}`} disabled={!available || quantity >= Math.min(10, ticket.remaining)} onClick={() => onTicketChange(ticket.id, quantity + 1)} type="button">+</button>
            </div> : <button className="checkout-add" disabled={!available} onClick={click => { const option = click.currentTarget.closest("article"); onTicketChange(ticket.id, 1); requestAnimationFrame(() => option?.querySelector<HTMLButtonElement>(".checkout-stepper button")?.focus({ preventScroll: true })); }} type="button" aria-label={`${design.add}: ${ticket.name}`}>{design.add}<AccountIcon name="plus" /></button>}
          </div>
        </article>;
      })}
      {availableTables.filter(table => !hasHall || selectedTableId === table.id).map(table => <OptionButton active={selectedTableId === table.id} disabled={table.availability !== "available"} key={table.id} onClick={() => onTableChange(selectedTableId === table.id ? null : table.id)} title={table.name ?? `${copy.table} ${table.number}`} meta={`${table.seats} ${copy.places} · ${copy.wholeTable}`} price={table.payment.amountDue === 0 ? design.free : paymentSummary(table.payment, formatDisplayMoney)} unavailable={copy.unavailable} />)}
      {selectedSeatIds.length ? <div className="checkout-selected-seats"><AccountIcon name="circle-check" /><strong>{copy.selectedSeats} · {selectedSeatIds.length}</strong><button className="checkout-text-action" onClick={onClearSeats} type="button">{copy.clear}</button><ul>{selectedSeatIds.map(id => {
        const seat = layout?.seats?.find(item => item.id === id);
        return <li key={id}>{seat && layout ? seatLabel(layout, seat, copy) : copy.seat}</li>;
      })}</ul></div> : null}
    </fieldset>
    <section className="checkout-summary" aria-label={copy.yourChoice}>
      <div className="checkout-summary-heading"><h3>{copy.yourChoice}</h3>{selection.currency ? <span>{selection.currency}</span> : null}</div>
      {selection.items.length ? <>
        <ul>{selection.items.map((item, index) => <li key={`${item.label}-${index}`}><span>{item.label}</span><span>{item.amount === 0 ? design.free : formatMoney(item.amount, item.currency, INTL_LOCALES[locale])}</span></li>)}</ul>
        <div className="checkout-total"><span>{copy.total}</span><strong>{total}</strong></div>
        {selection.amount > 0 && displayCurrency !== selection.currency ? <p className="checkout-conversion">{copy.approximately} {formatDisplayMoney(selection.amount, selection.currency)} · {copy.paymentIn} {selection.currency}</p> : null}
      </> : <p className="checkout-summary-empty"><AccountIcon name="shopping-bag" />{design.selectHint}</p>}
    </section>
    {selection.reason ? <p className="checkout-message is-error" role="alert">{selection.reason}</p> : null}
    {selection.items.length > 0 && !payment ? <div className="checkout-details">
      {selectedTickets.length + Number(Boolean(selectedTableId)) + Number(selectedSeatIds.length > 0) > 1 ? <p className="checkout-note">{copy.combinedRefund}</p> : null}
      <label className="checkout-terms"><input checked={accepted || guestLocked} disabled={busy || Boolean(result) || guestLocked} onChange={input => setAccepted(input.target.checked)} type="checkbox" /><span>{event.creationVersion === 2 ? ({ ru: "Принимаю условия регистрации, покупки и отмены", en: "I accept the registration, purchase and cancellation terms", kk: "Тіркелу, сатып алу және бас тарту шарттарын қабылдаймын" })[locale] : copy.acceptTerms}</span></label>
      {loggedIn ? <CheckoutEmailOption compact choice={emailChoice} onChoice={setEmailChoice} onEnabledChange={setEmailRequested} /> : null}
    </div> : null}
    {error ? <div className="checkout-message is-error"><p role="alert">{error}</p><button className="checkout-text-action" onClick={() => void onRefreshAvailability().then(() => setError(null)).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : copy.failed))} type="button"><AccountIcon name="refresh-cw" />{copy.refresh}</button></div> : null}
    {result || payment ? <div className="checkout-message is-success" role="status"><AccountIcon name="circle-check" /><p>{result ? design.confirmed : copy.created}</p></div> : null}
    <footer className="checkout-footer">
      {payment ? <button className="checkout-primary" onClick={() => setPaymentOpen(true)} type="button"><span>{copy.continuePayment}</span><AccountIcon name="arrow-right" /></button>
        : result ? <a className="checkout-primary" href={resultHref}><span>{design.openTicket}</span><AccountIcon name="arrow-right" /></a>
        : loggedIn ? <button className="checkout-primary" disabled={checkoutDisabled} aria-busy={busy} onClick={() => void checkout()} type="button"><span>{busy ? copy.loading : event.saleMode === "free" ? design.registration : copy.pay}</span>{busy ? <span className="checkout-spinner" aria-hidden="true" /> : <AccountIcon name="arrow-right" />}</button>
        : readOnly ? <button className="checkout-primary" disabled type="button">{design.registration}</button> : <GuestInlineCheckout body={{ eventId: event.id, tickets: selectedTickets.map(ticket => ({ ticketTypeId: ticket.id, quantity: ticketQuantities[ticket.id] ?? 0 })), ...(selectedTableId ? { tableId: selectedTableId } : {}), seatIds: selectedSeatIds, termsAccepted: true, contentLocale: event.contentLocale, policyRevision: event.refundPolicyRevision }} accepted={accepted} valid={selection.valid} free={selection.amount === 0} onFreeze={freezeGuest} onRestore={onRestoreSelection} onPayment={openPayment} />}
      {hint && !result && !payment ? <p className="checkout-continue-hint">{hint}</p> : null}
      <p className="checkout-delivery-hint"><AccountIcon name="qr" />{design.delivery}</p>
      {!loggedIn && selection.items.length ? <p className="checkout-guest-hint">{copy.guestHint}</p> : null}
    </footer>
    {payment && paymentOpen ? <CheckoutPaymentDialog order={payment.order} guestAccess={payment.guestAccess} onClose={closePayment} /> : null}
    {refund}
  </aside>;
}

function CheckoutRefund({ event }: { event: PublicEvent }) {
  const locale = useLocale();
  const free = event.saleMode === "free";
  const available = !free && Boolean(event.refundsAvailable);
  const policy = <RefundPolicyText locale={locale} free={free} available={available} conditions={event.cancellationTerms} />;
  if (!available) return <div className="checkout-refund checkout-refund-static"><AccountIcon name="undo" />{policy}</div>;

  const label = { ru: "Возврат возможен", en: "Refunds available", kk: "Ақшаны қайтаруға болады" }[locale];
  return <details className="checkout-refund">
    <summary><AccountIcon name="undo" /><span>{label}</span><AccountIcon name="chevron-down" /></summary>
    <div>{policy}</div>
  </details>;
}

function OptionButton({ active, disabled, onClick, title, meta, price, unavailable }: { active: boolean; disabled: boolean; onClick: () => void; title: string; meta: string; price: string; unavailable: string }) {
  return <button aria-pressed={active} className={`checkout-table${active ? " is-selected" : ""}`} disabled={disabled} onClick={onClick} type="button">
    <span className="checkout-table-icon"><AccountIcon name={active ? "circle-check" : "ticket"} /></span>
    <span className="checkout-table-label"><strong>{title}</strong><small>{disabled ? unavailable : meta}</small></span>
    <strong className="checkout-option-price">{price}</strong>
  </button>;
}
function paymentSummary(payment: PublicPaymentOption, format: (amount: number, currency: string) => string): string { return format(payment.amountDue, payment.currency); }
function seatLabel(layout: PublicVenueLayout, seat: PublicVenueSeat, copy: typeof CHECKOUT_COPY.ru): string {
  if (seat.tableId) { const table = layout.tables.find((item) => item.id === seat.tableId); return `${copy.table} ${table?.number ?? ""} · ${copy.seat} ${seat.number}`; }
  if (seat.rowId) { const row = layout.rows.find((item) => item.id === seat.rowId); return `${row?.name || `${copy.row} ${row?.number ?? ""}`} · ${copy.seat} ${seat.number}`; }
  return seat.label;
}
