"use client";

import { formatMoney } from "@event-platform/shared-types";
import { externalPaymentLink } from "../../../../lib/payment-link";
import { INTL_LOCALES, localeUrl } from "../../../../lib/locale";

import type { PaymentStatusResponse } from "@event-platform/shared-types";
import Link from "next/link";
import { useEffect, useState } from "react";

import { apiRequest } from "../../../(auth)/_lib/api";
import { useDisplayCurrency } from "../../../../components/currency-provider";
import { useLocale } from "../../../../components/locale-provider";
import { PAYMENT_STATUS_COPY } from "../../../../lib/payment-status-copy";

const terminal = new Set(["paid", "failed", "cancelled", "refunded", "expired", "review_required"]);

export default function PaymentStatusPage() {
  const locale = useLocale();
  const copy = PAYMENT_STATUS_COPY[locale];
  const { currency: displayCurrency, formatMoney: formatDisplayMoney } = useDisplayCurrency();
  const [orderId, setOrderId] = useState<string | null>(null);
  const [status, setStatus] = useState<PaymentStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [emailDelivery, setEmailDelivery] = useState<{ status: string; address: string | null; acceptedAt: string | null } | null>(null);
  const [resendBusy, setResendBusy] = useState(false);

  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get("order");
    if (!value || !/^[0-9a-f-]{20,}$/i.test(value)) {
      setError(copy.error);
      return;
    }
    setOrderId(value);
  }, []);

  useEffect(() => {
    if (!orderId) return;
    let stopped = false;
    let timer: number | undefined;
    let attempts = 0;
    const read = async () => {
      if (stopped || document.visibilityState === "hidden") return;
      try {
        const next = await apiRequest<PaymentStatusResponse>(`/orders/${orderId}/payment-status`);
        if (stopped) return;
        setStatus(next);
        void apiRequest<{ status: string; address: string | null; acceptedAt: string | null }>(`/me/orders/${orderId}/email-delivery`).then(value => { if (!stopped) setEmailDelivery(value); }).catch(() => undefined);
        setError(null);
        attempts += 1;
        if (!terminal.has(next.status) && attempts < 120) timer = window.setTimeout(() => void read(), 3_000);
      } catch {
        if (!stopped) { setError(copy.error); if (++attempts < 120) timer = window.setTimeout(() => void read(), 10_000); }
      }
    };
    const onVisible = () => { if (document.visibilityState === "visible") { if (timer !== undefined) window.clearTimeout(timer); void read(); } };
    document.addEventListener("visibilitychange", onVisible);
    void read();
    return () => { stopped = true; if (timer !== undefined) window.clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [orderId, retryKey, copy]);

  const label = status ? copy.statuses[status.status] ?? status.status : copy.loading;
  // Same currency hint as checkout; never offer a "continue" link that reloads this page.
  const continueLink = status && typeof window !== "undefined" ? externalPaymentLink(status.paymentLink, window.location.href) : null;
  async function resendEmail() {
    if (!orderId || resendBusy) return;
    setResendBusy(true);
    try { await apiRequest(`/me/orders/${orderId}/email-delivery/resend`, { method: "POST" }); setEmailDelivery(await apiRequest(`/me/orders/${orderId}/email-delivery`)); setError(null); }
    catch { setError(copy.resendError); }
    finally { setResendBusy(false); }
  }
  const tone = !status ? (error ? "is-error" : "is-wait") : status.status === "paid" ? "is-ok" : status.status === "pending" ? "is-wait" : "is-error";
  return <main className="tk-status-page">
    <section className="tk-status-card">
      <span className={`tk-status-ico ${tone}`} aria-hidden="true">{tone === "is-ok" ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg> : tone === "is-error" ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 8v5m0 3.5v.5"/><circle cx="12" cy="12" r="9"/></svg> : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>}</span>
      <h1>{copy.title}</h1>
      {error ? <p className="tk-status-text is-error" role="alert">{error}</p> : null}
      {status ? <div className="tk-status-box" role="status"><b>{label}</b><p>{formatMoney(status.amount, status.currency, INTL_LOCALES[locale])} · {status.paymentLabel === "deposit" ? copy.deposit : copy.full}</p>{status.amount > 0 && displayCurrency !== status.currency ? <p className="is-small">{copy.approximate} {formatDisplayMoney(status.amount, status.currency)} · {copy.paymentIn} {status.currency}</p> : null}{status.status === "pending" && status.expiresAt ? <p className="is-small">{copy.payBefore} {new Date(status.expiresAt).toLocaleString(INTL_LOCALES[locale])}</p> : null}{status.status === "pending" && continueLink ? <a className="tk-btn tk-btn-primary" href={continueLink}>{copy.continuePayment}</a> : null}</div> : !error ? <p className="tk-status-text" role="status"><span className="tk-status-spinner" aria-hidden="true"/>{copy.loading}</p> : null}
      {emailDelivery?.address ? <div className="tk-status-box is-soft"><p>{copy.emailTickets}: <b>{emailDelivery.address}</b></p><p className="is-small">{copy.emailStatuses[emailDelivery.status] ?? emailDelivery.status}</p>{["accepted", "failed", "uncertain"].includes(emailDelivery.status) ? <button type="button" disabled={resendBusy} className="tk-status-link" onClick={() => void resendEmail()}>{copy.resend}</button> : null}</div> : null}
      <div className="tk-status-actions">
        <Link className="tk-btn tk-btn-primary" href={localeUrl("/account", locale)}>{copy.myTickets}</Link>
        {orderId ? <button className="tk-btn tk-btn-ghost" onClick={() => setRetryKey((value) => value + 1)} type="button">{copy.refresh}</button> : null}
      </div>
    </section>
  </main>;
}
