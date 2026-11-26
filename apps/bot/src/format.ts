import type { EventLocale } from "@event-platform/shared-types";

/** Every bot panel is rendered as Telegram HTML. Dynamic text must go through `esc`. */
export const HTML = { parse_mode: "HTML" } as const;

export function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function bold(value: string): string {
  return `<b>${esc(value)}</b>`;
}

/** Split plain text into Telegram-sized chunks first, then escape each one, so no entity is cut in half. */
export function escChunks(value: string, size: number): string[] {
  return (value.match(new RegExp(`[\\s\\S]{1,${size}}`, "gu")) ?? []).map(esc);
}

/** "Tue, 4 March · 19:00" from the event's own wall-clock date and time. */
export function eventWhen(date: string, time: string, locale: EventLocale): string {
  const parsed = new Date(`${date}T${/^\d{2}:\d{2}/.test(time) ? time.slice(0, 5) : "00:00"}:00Z`);
  if (Number.isNaN(parsed.getTime())) return `${date} · ${time}`;
  const day = new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "short", day: "numeric", month: "long" }).format(parsed);
  return `${day} · ${time.slice(0, 5)}`;
}

export const saleDot: Record<string, string> = {
  available: "🟢", few_left: "🟡", sold_out: "🔴", temporarily_unavailable: "⏸", sales_not_started: "⏳", sales_ended: "⚪️",
  paused: "⏸", ended: "⚪️",
};

export const orderDot: Record<string, string> = {
  pending: "⏳", paid: "✅", failed: "❌", expired: "⌛️", review_required: "🔍", cancelled: "⚪️", refunded: "↩️",
};
