"use client";

import { type CancellationTermsResponse,type GuestEvent } from "@event-platform/shared-types";
import Link from "next/link";
import { useRef, useState } from "react";

import { apiRequest } from "../app/(auth)/_lib/api";
import { Countdown } from "./countdown";
import { PublicFramedAsset } from "./public-event-media";
import { useLocale } from "./locale-provider";
import { INTL_LOCALES } from "../lib/locale";
import { GUEST_COPY, GUEST_EXTRA } from "../lib/guest-copy";
import { localeUrl } from "../lib/locale";
import { ContentLanguageNote } from "./content-language-note";
import { GuestTicketActions } from "./guest-ticket-actions";
import { TICKET_ACTIONS_COPY } from "../lib/ticket-actions-copy";
import { AccountIcon } from "./account-icon";
import { eventMapUrl } from "../lib/event-map-url";
import { guestEventSchedule } from "../lib/guest-event-schedule";
import { guestEventParticipationLabel, guestTicketParticipationLabel } from "../lib/guest-participation-label";
import { useEventEnded } from "../lib/use-event-ended";

export function GuestEventCard({ event, onReturned, index: position = 0 }: { event: GuestEvent; onReturned?: () => void; index?: number }) {
  const locale = useLocale();
  const extra = GUEST_EXTRA[locale];
  const actionsCopy = TICKET_ACTIONS_COPY[locale];
  const ended = useEventEnded(event);
  const details = { startsAt: event.startsAt, endsAt: event.endsAt ?? null, timezone: event.timezone, address: event.address, coordinates: event.coordinates ?? null, organizer: event.organizer ?? { name: null, phone: null, email: null, address: null } };
  const mapUrl = eventMapUrl(event);
  const chatPath = event.tickets.find(ticket => ticket.chatPath)?.chatPath ?? event.bookings.find(booking => booking.chatPath)?.chatPath;
  const eventHref = localeUrl(`/events/${event.id}`, locale);
  const schedule = guestEventSchedule(event, locale);
  const canOpenEvent = event.eventStatus === "published" && !ended;
  const cardAsset = event.media?.find(asset => asset.isCard);
  const [index, setIndex] = useState(0);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const last = event.tickets.length - 1;
  const current = Math.min(index, last);
  const ticket = event.tickets[current];
  const participation = ticket?.participationStatus ?? event.participationStatus;
  const returned = ticket?.status === "refunded";
  const cancelled = event.eventStatus === "cancelled" || ticket?.status === "cancelled" || participation === "cancelled";
  const attended = ticket?.status === "used" || participation === "attended";
  const label = returned ? actionsCopy.statuses.refunded
    : cancelled ? GUEST_COPY[locale].states.cancelled
    : attended ? GUEST_COPY[locale].states.attended
    : ticket ? guestTicketParticipationLabel(ticket, locale, ended) : guestEventParticipationLabel(event, locale, ended);
  const tone = cancelled || returned ? "inactive" : attended || ended || participation === "no_show" ? "past" : "active";
  const [direction, setDirection] = useState(0);
  function move(step: number) {
    const next = Math.max(0, Math.min(last, current + step));
    if (next === current) return;
    setDirection(step);
    setIndex(next);
  }
  const poster = cardAsset ? <PublicFramedAsset asset={cardAsset} className="account-event-poster-media" />
    : event.posterUrl ? <img alt="" className="account-event-poster-media" src={event.posterUrl} width={600} height={800} loading="lazy" decoding="async" />
    : <span aria-hidden="true" className="account-event-poster-placeholder">{event.title.slice(0, 1)}</span>;
  const start = new Date(event.startsAt);
  const day = new Intl.DateTimeFormat(INTL_LOCALES[locale], { day: "numeric", timeZone: event.timezone }).format(start);
  const month = new Intl.DateTimeFormat(INTL_LOCALES[locale], { month: "short", timeZone: event.timezone }).format(start).replace(".", "");
  // Prototype ticket card (output/account-redesign/account.html): photo · details · perforated stub.
  return <article className={`tka-ticket${tone === "active" ? "" : " tka-past"}`} style={{ animationDelay: `${position * 50}ms` }}>
    {canOpenEvent ? <Link aria-label={`${extra.openEvent}: ${event.title}`} className="tka-ticket-photo" href={eventHref}>{poster}<span className="tk-date-badge"><b>{day}</b><small>{month}</small></span></Link> : <div className="tka-ticket-photo">{poster}<span className="tk-date-badge"><b>{day}</b><small>{month}</small></span></div>}
    <div className="tka-ticket-body">
      <div className="tka-t-top"><h3 title={event.title}>{canOpenEvent ? <Link href={eventHref}>{event.title}</Link> : event.title}</h3><Countdown startsAt={event.startsAt} past={ended} /></div>
      {event.contentLocale && event.contentLocale !== locale ? <ContentLanguageNote contentLocale={event.contentLocale} /> : null}
      <div className="tka-tmeta">
        <span><AccountIcon name="clock" /><time dateTime={event.startsAt}>{schedule}</time></span>
        {mapUrl ? <a href={mapUrl} target="_blank" rel="noopener noreferrer" title={`${actionsCopy.map}: ${event.address}`}><AccountIcon name="map-pin" />{event.address || actionsCopy.map}<AccountIcon name="arrow-up-right" /></a> : <span><AccountIcon name="map-pin" />{actionsCopy.noAddress}</span>}
      </div>
      {!canOpenEvent ? <p className="account-event-unavailable">{extra.pageUnavailable}</p> : null}
      {ticket ? <div className="tka-t-pick"
        onTouchStart={event => { const touch = event.touches.length === 1 ? event.touches[0] : undefined; touchStart.current = touch ? { x: touch.clientX, y: touch.clientY } : null; }}
        onTouchCancel={() => { touchStart.current = null; }}
        onTouchEnd={event => { const begin = touchStart.current; touchStart.current = null; const touch = event.changedTouches[0]; if (!begin || !touch) return; const dx = touch.clientX - begin.x, dy = touch.clientY - begin.y; if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) move(dx < 0 ? 1 : -1); }}>
        <div key={ticket.id} data-direction={direction}><Link className="account-guest-ticket-title" href={localeUrl(`/account/tickets/${ticket.id}`, locale)}><b>{ticket.ticketTypeName}</b></Link>{ticket.seatLabel ? <small>{ticket.seatLabel}</small> : null}</div>
        {last > 0 ? <div className="tka-pager"><button type="button" aria-label={GUEST_COPY[locale].previous} disabled={current === 0} onClick={() => move(-1)}><AccountIcon name="chevron-left" /></button><span aria-live="polite">{current + 1} / {last + 1}</span><button type="button" aria-label={GUEST_COPY[locale].next} disabled={current === last} onClick={() => move(1)}><AccountIcon name="chevron-right" /></button></div> : null}
      </div> : null}
      {event.bookings.map(booking => <BookingChip booking={booking} key={booking.id} />)}
      <div className="tka-t-org"><GuestTicketActions variant="organizer" details={details} chatPath={chatPath} chatTitle={event.title} /></div>
    </div>
    <div className="tka-stub">
      <span className={`tka-t-status ${tone === "active" ? "tka-ok" : tone === "past" ? "tka-past" : "tka-off"}`}>{label}</span>
      {ticket ? <GuestTicketActions variant="ticket" ticket={ticket} details={details} onReturned={onReturned} /> : null}
    </div>
  </article>;
}

function BookingChip({ booking }: { booking: GuestEvent["bookings"][number] }) {
  const locale = useLocale(); const copy = GUEST_COPY[locale]; const extra = GUEST_EXTRA[locale];
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  // One key per chip, so a repeated click after a lost response cannot cancel twice.
  const idempotencyKey = useRef<string | null>(null);
  async function cancel(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const terms = await apiRequest<CancellationTermsResponse>(`/me/bookings/${booking.id}/cancellation`);
      if(terms.acceptedPolicy&&!terms.acceptedPolicy.available&&terms.amountPaid>0){setMessage(({ru:"Возврат денег не предусмотрен. Обратитесь к организатору.",en:"Monetary refunds are unavailable. Contact the organizer.",kk:"Ақшаны қайтару қарастырылмаған. Ұйымдастырушыға хабарласыңыз."})[locale]);return;}
      if (!window.confirm(`${terms.cancellationTerms ?? ""}\n\n${extra.cancelConfirm}`)) return;
      idempotencyKey.current ??= crypto.randomUUID();
      const result = await apiRequest<{ refundPending: boolean }>(`/me/bookings/${booking.id}/cancel`, { method: "POST", headers: { "Idempotency-Key": idempotencyKey.current }, body: JSON.stringify({ confirmed: true }) });
      setDone(true);
      setMessage(result.refundPending ? extra.refundPending : extra.cancelled);
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : extra.failed); }
    finally { setBusy(false); }
  }
  const cancellable = !done && (booking.status === "pending" || booking.status === "confirmed");
  return <span className="tka-booking">{copy.table} №{booking.table.number} · {message ?? copy.statuses[booking.status]}{cancellable ? <button className="tka-booking-cancel" disabled={busy} onClick={() => void cancel()} type="button">{extra.cancel}</button> : null}</span>;
}
