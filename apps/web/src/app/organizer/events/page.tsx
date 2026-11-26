"use client";

import { formatMoney } from "@event-platform/shared-types";
import type { OrganizerEventSort, OrganizerEventStatusGroup, OrganizerWorkspaceEvent, OrganizerWorkspaceEventList } from "@event-platform/shared-types";
import Link from "next/link";
import { EventCardMedia } from "../../../components/public-event-media";
import { EventReviewStatus } from "../../../components/event-review-status";
import { useEffect, useRef, useState } from "react";
import { OrganizerResourceError, OrganizerWorkspaceShell, useOrganizerWorkspace } from "../../../components/organizer-workspace";
import { AccountIcon } from "../../../components/account-icon";
import { useLocale } from "../../../components/locale-provider";
import { EVENTS_COPY } from "../../../lib/events-copy";
import { ORGANIZER_EVENTS_COPY } from "../../../lib/organizer-events-copy";
import { ORGANIZER_WORKSPACE_COPY } from "../../../lib/organizer-workspace-copy";
import { INTL_LOCALES, localeUrl } from "../../../lib/locale";
import { apiRequest } from "../../(auth)/_lib/api";
import { useAccountResource } from "../../(auth)/account/use-account-resource";

const PAGE_SIZE = 10;
const FILTERS: OrganizerEventStatusGroup[] = ["all", "pending", "on_sale", "paused", "rejected", "hidden", "draft", "archive"];

export default function OrganizerEventsPage() {
  return <OrganizerWorkspaceShell active="events"><OrganizerEvents /></OrganizerWorkspaceShell>;
}

function OrganizerEvents() {
  const locale = useLocale(); const copy = ORGANIZER_EVENTS_COPY[locale]; const design = ORGANIZER_WORKSPACE_COPY[locale];
  const { dashboard } = useOrganizerWorkspace();
  const [statusGroup, setStatusGroup] = useState<OrganizerEventStatusGroup>("all");
  const [sort, setSort] = useState<OrganizerEventSort>("updated_desc"); const [page, setPage] = useState(1);
  const list = useAccountResource<OrganizerWorkspaceEventList>(`/api/organizer/events?page=${page}&limit=${PAGE_SIZE}&statusGroup=${statusGroup}&sort=${sort}`);
  const [mutationError, setMutationError] = useState<string | null>(null); const [busyId, setBusyId] = useState<string | null>(null);
  const mutationLock = useRef(false); const [publishedMessage, setPublishedMessage] = useState(false);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("published") !== "1") return;
    setPublishedMessage(true); url.searchParams.delete("published");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  async function mutate(event: OrganizerWorkspaceEvent, action: "delete" | "reopen") {
    if (mutationLock.current) return;
    if (action === "delete" && !window.confirm(copy.deleteConfirm.replace("{title}", event.title))) return;
    mutationLock.current = true; setBusyId(event.id); setMutationError(null);
    try {
      await apiRequest(`/api/organizer/events/${event.id}${action === "reopen" ? "/reopen" : ""}`, { method: action === "reopen" ? "POST" : "DELETE" });
      if (action === "delete" && page > 1 && list.data?.items.length === 1) setPage(value => value - 1);
      else list.retry();
      dashboard.retry();
    } catch (reason) { setMutationError(reason instanceof Error ? reason.message : copy.loadFailed); }
    finally { mutationLock.current = false; setBusyId(null); }
  }

  const summary = dashboard.data;
  const occupancy = summary && summary.totalAdmissions > 0 ? Math.min(100, Math.round(summary.soldAdmissions / summary.totalAdmissions * 100)) : 0;
  const result = list.data;
  const pageSold = result?.items.reduce((total, event) => total + event.metrics.sold, 0) ?? 0;
  const metrics = [
    { label: copy.totalEvents, value: summary?.totalEvents ?? "…", detail: design.totalEventsHint, icon: "calendar-check", hue: "#6320ee" },
    { label: copy.published, value: summary?.publishedEvents ?? "…", detail: summary ? <><b>{occupancy}%</b> {copy.occupancy}</> : "…", icon: "circle-check", hue: "#16a34a" },
    { label: copy.drafts, value: summary?.draftEvents ?? "…", detail: summary ? `${summary.completedEvents + summary.cancelledEvents} ${copy.archived}` : "…", icon: "pencil", hue: "#ea580c" },
    { label: copy.paidRevenue, value: summary ? summary.currency ? formatMoney(summary.settledRevenue, summary.currency, INTL_LOCALES[locale]) : "—" : "…", detail: summary ? summary.currency ? summary.settledRevenue === 0 ? design.noSales : "" : design.revenueUnavailable : "…", icon: "money", hue: "#0284c7" },
  ];
  // Same markup as output/organizer-redesign/organizer.html.
  return <>
    <header className="tko-view-head">
      <h1>{design.events}</h1>
      <Link className="tko-btn" href={localeUrl("/events/create", locale)}><AccountIcon name="plus" />{copy.create}</Link>
    </header>
    <section className="tko-metrics">{metrics.map(metric => <div className="tko-panel tko-metric" key={metric.label} style={{ "--hue": metric.hue } as React.CSSProperties}><div className="tko-m-top"><span className="tko-m-ico"><AccountIcon name={metric.icon} /></span>{metric.label}</div><div className="tko-m-val tko-num">{metric.value}</div>{metric.detail ? <div className="tko-m-sub">{metric.detail}</div> : null}</div>)}</section>
    {dashboard.error ? <OrganizerResourceError message={dashboard.error} onRetry={dashboard.retry} /> : null}
    {publishedMessage ? <p className="organizer-success" role="status">{copy.publishedMessage}</p> : null}
    {mutationError ? <OrganizerResourceError message={mutationError} /> : null}
    <div className="tko-filters">
      <div className="tko-tabs" role="group" aria-label={copy.statusTabs}>{FILTERS.map(filter => <button key={filter} type="button" className={filter === statusGroup ? "tko-on" : ""} aria-pressed={filter === statusGroup} onClick={() => { setStatusGroup(filter); setPage(1); }}>{copy.filters[filter]}</button>)}</div>
      <label className="tko-sort"><select aria-label={copy.sort} value={sort} onChange={event => { setSort(event.target.value as OrganizerEventSort); setPage(1); }}><option value="updated_desc">{copy.updated}</option><option value="date_asc">{copy.earliest}</option><option value="date_desc">{copy.latest}</option></select><AccountIcon name="chevron-down" /></label>
    </div>
    <section className="tko-panel tko-events-card" aria-label={design.events}>
      {list.error ? <OrganizerResourceError message={list.error} onRetry={list.retry} /> : null}
      {!result && !list.error ? <p className="account-loading tko-loading" role="status">{copy.loading}</p> : null}
      {result ? <>
        <table className="tko-ev-table">
          <thead><tr><th>{design.events}</th><th>{design.salesColumn}</th><th className="tko-r">{design.revenueColumn}</th><th /></tr></thead>
          <tbody>{result.items.length ? result.items.map(event => <EventRow key={event.id} event={event} busy={busyId !== null} pending={busyId === event.id} onDelete={() => void mutate(event, "delete")} onReopen={() => void mutate(event, "reopen")} />) : <tr><td colSpan={4}><div className="tko-empty"><AccountIcon name="calendar-check" /><b>{copy.empty}</b><Link className="tko-btn" href={localeUrl("/events/create", locale)}>{copy.create}</Link></div></td></tr>}</tbody>
        </table>
        <div className="tko-tfoot"><span>{design.shown} {result.items.length} {design.of} {result.total} · {design.pageSales.toLowerCase()} {pageSold} {design.units}</span>{result.total > result.limit ? <span className="tko-pager"><button type="button" disabled={page === 1} onClick={() => setPage(value => Math.max(1, value - 1))}>{copy.previous}</button>{copy.page} {page}<button type="button" disabled={!result.hasNext} onClick={() => setPage(value => value + 1)}>{copy.next}</button></span> : null}</div>
      </> : null}
    </section>
    <section className="tko-panel tko-quick"><span className="tko-q-ico"><AccountIcon name="plus" /></span><div><b>{design.quickStart}</b><small>{copy.setupHint}</small></div><Link className="tko-btn tko-sm tko-soft" href={localeUrl("/events/create", locale)}>{copy.newEvent} <AccountIcon name="arrow-right" /></Link></section>
  </>;
}

function EventRow({ event, busy, pending, onDelete, onReopen }: { event: OrganizerWorkspaceEvent; busy: boolean; pending: boolean; onDelete: () => void; onReopen: () => void }) {
  const locale = useLocale(); const copy = ORGANIZER_EVENTS_COPY[locale]; const design = ORGANIZER_WORKSPACE_COPY[locale]; const eventsCopy = EVENTS_COPY[locale];
  const metrics = event.metrics; const progress = metrics.capacity > 0 ? Math.min(100, Math.round(metrics.sold / metrics.capacity * 100)) : 0;
  const unit = metrics.mode === "whole_table" ? design.tables : metrics.mode === "per_seat" ? design.seats : design.tickets;
  const [menu, setMenu] = useState(false);
  const draft = event.status === "draft";
  const deletable = draft && event.moderationStatus === "clear";
  const reopenable = event.status === "completed" && event.paymentMode !== "deposit";
  const manageHref = localeUrl(`/organizer/events/${event.id}${draft ? "/edit" : ""}`, locale);
  return <tr>
    <td className="tko-c-ev"><div className="tko-ev">
      <div className="tko-ev-poster organizer-poster" aria-hidden="true"><EventCardMedia asset={event.cardMedia} posterUrl={event.posterUrl} ownerPreview /></div>
      <div className="tko-ev-t"><Link href={manageHref}>{event.title}</Link><small>{event.date} · {event.time} · {event.address}</small>
        <div className="tko-ev-meta"><EventReviewStatus event={event} /><span>{metrics.mode === "ordinary" ? copy.ordinary : metrics.mode === "per_seat" ? copy.perSeat : copy.perTable}</span><span>ID {event.displayId}</span></div></div>
    </div></td>
    <td className="tko-sales tko-c-sales">{metrics.capacity > 0 ? <><div className="tko-sales-row tko-num"><b>{metrics.sold} / {metrics.capacity}</b><span>{progress}%</span></div><span className="tko-progress" role="progressbar" aria-label={`${copy.sold}: ${event.title}`} aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}><i className={progress >= 100 ? "tko-full" : ""} style={{ width: `${progress}%` }} /></span><small>{copy.remaining} {metrics.remaining} {unit}{metrics.includedSeats !== null ? ` · ${copy.includedSeats} ${metrics.includedSeats}` : ""}</small></> : <small>{design.noSales}</small>}</td>
    <td className="tko-r">{metrics.currency ? <span className="tko-rev tko-num">{formatMoney(metrics.settledRevenue, metrics.currency, INTL_LOCALES[locale])}</span> : <span className="tko-rev tko-none">—</span>}</td>
    <td className="tko-c-act"><div className="tko-acts">
      <Link className={`tko-btn${draft ? " tko-primary" : ""}`} href={manageHref}>{draft ? copy.continue : copy.manage}</Link>
      {deletable || reopenable ? <div className="tko-more">
        <button type="button" aria-label="⋯" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(value => !value)} onBlur={event => { if (!event.currentTarget.parentElement?.contains(event.relatedTarget)) setMenu(false); }}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5.5" cy="12" r="1.3" fill="currentColor" /><circle cx="12" cy="12" r="1.3" fill="currentColor" /><circle cx="18.5" cy="12" r="1.3" fill="currentColor" /></svg></button>
        {menu ? <div className="tko-menu" role="menu">
          {reopenable ? <button type="button" role="menuitem" disabled={busy} onClick={() => { setMenu(false); onReopen(); }}><AccountIcon name="send" />{pending ? copy.publishing : copy.republish}</button> : null}
          {deletable ? <button type="button" role="menuitem" className="tko-danger" disabled={busy} onClick={() => { setMenu(false); onDelete(); }}><AccountIcon name="trash" />{eventsCopy.deleteDraft}</button> : null}
        </div> : null}
      </div> : null}
    </div></td>
  </tr>;
}

