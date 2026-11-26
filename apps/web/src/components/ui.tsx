"use client";

import type { EventLocale } from "@event-platform/shared-types";
import type { ReactNode } from "react";

import { useLocale } from "./locale-provider";

const UI_COPY: Record<EventLocale, { fullPayment: string; unavailable: string; retry: string; loading: string; tickets: string; tables: string; seats: string }> = {
  ru: { fullPayment: "Полная оплата", unavailable: "Недоступно", retry: "Повторить", loading: "Загрузка", tickets: "билетов", tables: "столов", seats: "мест" },
  kk: { fullPayment: "Толық төлем", unavailable: "Қолжетімсіз", retry: "Қайталау", loading: "Жүктелуде", tickets: "билет", tables: "үстел", seats: "орын" },
  en: { fullPayment: "Full payment", unavailable: "Unavailable", retry: "Retry", loading: "Loading", tickets: "tickets", tables: "tables", seats: "seats" },
};

export function PageShell({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <main className={`mx-auto min-h-screen w-full max-w-6xl px-5 py-8 sm:px-8 sm:py-12 ${className}`}>{children}</main>;
}

export function SectionHeading({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: ReactNode }) {
  return <div className="tk-section-head">
    <div>
      {eyebrow ? <p className="tk-section-eyebrow">{eyebrow}</p> : null}
      <h1>{title}</h1>
      {description ? <p>{description}</p> : null}
    </div>
    {action}
  </div>;
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return <div className="tk-empty-state"><span className="tk-empty-ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7Z"/></svg></span><h2>{title}</h2>{description ? <p>{description}</p> : null}{action ? <div className="tk-empty-action">{action}</div> : null}</div>;
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const copy = UI_COPY[useLocale()];
  return <div className="tk-error-state" role="alert"><p>{message}</p>{onRetry ? <button className="tk-btn tk-btn-ghost" onClick={onRetry} type="button">{copy.retry}</button> : null}</div>;
}

export function LoadingGrid({ count = 6 }: { count?: number }) {
  const copy = UI_COPY[useLocale()];
  return <div aria-label={copy.loading} className="tk-grid">{Array.from({ length: count }, (_, index) => <div aria-hidden="true" className="h-80 animate-pulse rounded-[20px] bg-ticket-raised" key={index} />)}</div>;
}
