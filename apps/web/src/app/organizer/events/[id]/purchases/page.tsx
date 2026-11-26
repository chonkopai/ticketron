"use client";
import { quickRu, ru } from "@event-platform/shared-types";
import { useEffect, useState } from "react";
import { apiRequest } from "../../../../(auth)/_lib/api";
import { BackLink } from "../../../../../components/back-link";

type Purchase = { id: string; name: string | null; guestContact: { telegramId?: string } | null; amount: number; currency: string; status: string; tickets: Array<{ id: string; status: string }>; booking: { id: string; status: string } | null };
export default function PurchasesPage({ params }: { params: Promise<{ id: string }> }) {
  const [id, setId] = useState(""); const [page, setPage] = useState(1); const [rows, setRows] = useState<Purchase[] | null>(null); const [error, setError] = useState(false);
  useEffect(() => { void params.then(p => setId(p.id)); }, [params]);
  useEffect(() => { if (!id) return; let stopped = false; setRows(null); setError(false); void apiRequest<{ items: Purchase[] }>(`/api/organizer/events/${id}/purchases?page=${page}`).then(result => { if (!stopped) setRows(result.items); }).catch(() => { if (!stopped) setError(true); }); return () => { stopped = true; }; }, [id, page]);
  const status = (value: string) => (ru.checkout.paymentStatuses as Record<string, string>)[value] ?? value;
  return <main className="organizer-event-page tk-purchases"><BackLink href={`/organizer/events/${id}`} />
    <header className="tk-purchases-head"><h1>{quickRu.purchases}</h1></header>
    {error ? <p className="tk-purchases-note is-error" role="alert">{quickRu.error}</p> : !rows ? <p className="tk-purchases-note" role="status">{ru.common.loading}</p> : rows.length === 0 ? <p className="tk-purchases-note">{ru.guest.empty}</p> : <ul className="tk-purchases-list">{rows.map(row => <li key={row.id} className="tk-purchase">
      <span className="tk-purchase-ava" aria-hidden="true">{(row.name ?? "—").trim().charAt(0).toUpperCase() || "—"}</span>
      <div className="tk-purchase-main"><h2>{row.name ?? "—"}</h2>{row.guestContact?.telegramId && <p>Telegram: {row.guestContact.telegramId}</p>}
        <div className="tk-purchase-chips">{row.tickets.map(t => <span key={t.id}>{ru.guest.ticket}: {(quickRu.ticketStatuses as Record<string, string>)[t.status] ?? t.status}</span>)}{row.booking && <span>{ru.guest.table}: {(ru.guest.statuses as Record<string, string>)[row.booking.status] ?? row.booking.status}</span>}</div></div>
      <div className="tk-purchase-sum"><b>{row.amount / 100} {row.currency}</b><span className={row.status === "paid" ? "is-paid" : ""}>{status(row.status)}</span></div>
    </li>)}</ul>}
    <nav className="tk-purchases-pager"><button className="organizer-event-secondary-button" disabled={page === 1} onClick={() => setPage(page - 1)}>{ru.common.previous}</button><span>{page}</span><button className="organizer-event-secondary-button" disabled={!rows || rows.length < 20} onClick={() => setPage(page + 1)}>{ru.common.next}</button></nav></main>;
}
