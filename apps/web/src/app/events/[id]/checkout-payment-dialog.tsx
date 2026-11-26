"use client";

import { formatMoney } from "@event-platform/shared-types";
import type { CheckoutResponse, PaymentStatusResponse, QuickOrderStatus } from "@event-platform/shared-types";
import { useEffect, useId, useRef, useState } from "react";
import { apiRequest } from "../../(auth)/_lib/api";
import { quickRequest } from "../../quick/api";
import { useLocale } from "../../../components/locale-provider";
import { INTL_LOCALES, localeUrl } from "../../../lib/locale";
import { PAYMENT_STATUS_COPY } from "../../../lib/payment-status-copy";

type PaymentState = { status: string; paymentLink: string | null; expiresAt: string | null };

const closeText = { ru: "Закрыть", en: "Close", kk: "Жабу" };
const retryable = new Set(["expired", "failed", "cancelled"]);

function providerUrl(link: string | null) {
  if (!link) return null;
  try {
    const url = new URL(link, window.location.origin);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return /^\/(payment|quick)\/status\/?$/.test(url.pathname) ? null : url.href;
  } catch {
    return null;
  }
}

export function CheckoutPaymentDialog({ order, guestAccess, onClose }: {
  order: CheckoutResponse;
  guestAccess?: string | undefined;
  onClose: (retry: boolean) => void;
}) {
  const locale = useLocale(), copy = PAYMENT_STATUS_COPY[locale];
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [payment, setPayment] = useState<PaymentState>({ status: "pending", paymentLink: order.paymentLink, expiresAt: order.expiresAt });
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState(false);

  useEffect(() => {
    const panel = dialog.current;
    panel?.showModal();
    return () => { if (panel?.open) panel.close(); };
  }, []);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next: PaymentState = guestAccess
          ? { ...await quickRequest<Pick<QuickOrderStatus, "status" | "expiresAt">>("order", guestAccess), paymentLink: order.paymentLink }
          : await apiRequest<PaymentStatusResponse>(`/orders/${order.orderId}/payment-status`);
        if (disposed) return;
        setPayment(next);
        setError(false);
        if (next.status === "pending") timer = setTimeout(poll, 3000);
      } catch {
        if (disposed) return;
        setError(true);
        timer = setTimeout(poll, 10_000);
      }
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [guestAccess, order.orderId, order.paymentLink, retry]);

  const url = providerUrl(payment.paymentLink);
  const receipt = guestAccess ? `/quick/status?order=${order.orderId}` : order.ticketIds[0] ? `/account/tickets/${order.ticketIds[0]}` : "/account";
  const close = () => onClose(retryable.has(payment.status));
  return <dialog ref={dialog} className="checkout-payment-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); close(); }}
    onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <section className="checkout-payment-content">
      <header>
        <h2 id={titleId}>{copy.title}</h2>
        <button className="checkout-payment-close" type="button" onClick={close} aria-label={closeText[locale]}>×</button>
      </header>
      <div className="checkout-payment-state" role="status">
        <h3>{copy.statuses[payment.status] ?? copy.loading}</h3>
        <p>{formatMoney(order.amountDue, order.currency, INTL_LOCALES[locale])} · {order.paymentLabel === "deposit" ? copy.deposit : copy.full}</p>
        {payment.status === "pending" && payment.expiresAt ? <p>{copy.payBefore} {new Date(payment.expiresAt).toLocaleString(INTL_LOCALES[locale])}</p> : null}
      </div>
      {error ? <p className="checkout-message is-error" role="alert">{copy.error}</p> : null}
      {payment.status === "pending" && url ? <a className="checkout-primary" href={url} target="_blank" rel="noopener noreferrer">{copy.continuePayment}</a> : null}
      {payment.status === "paid" ? <a className="checkout-primary" href={localeUrl(receipt, locale)}>{copy.myTickets}</a> : null}
      <button className="checkout-text-action" type="button" onClick={() => setRetry(value => value + 1)}>{copy.refresh}</button>
    </section>
  </dialog>;
}
