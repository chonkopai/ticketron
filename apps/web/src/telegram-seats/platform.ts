import type { TelegramSeatSession } from "@event-platform/shared-types";

type Insets = { top: number; bottom: number; left: number; right: number };
type TelegramEvent = "activated" | "themeChanged" | "viewportChanged" | "safeAreaChanged" | "contentSafeAreaChanged";

interface TelegramWebApp {
  initData: string;
  colorScheme: "light" | "dark";
  viewportStableHeight: number;
  safeAreaInset?: Insets;
  contentSafeAreaInset?: Insets;
  BackButton?: { show(): void; hide(): void; onClick(handler: () => void): void; offClick(handler: () => void): void };
  ready(): void;
  expand(): void;
  close(): void;
  openLink(url: string): void;
  openTelegramLink(url: string): void;
  onEvent(event: TelegramEvent, handler: () => void): void;
  offEvent(event: TelegramEvent, handler: () => void): void;
}

export const telegram = (window as Window & { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp;

export class SeatApiError extends Error {
  constructor(readonly code: string) { super(code); }
}

export async function api<T>(path: string, token?: string, body?: object): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`/telegram/seats/${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as { code?: string };
      throw new SeatApiError(data.code ?? (response.status === 404 ? "EVENT_NOT_FOUND" : "REQUEST_FAILED"));
    }
    return await response.json() as T;
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function openSession(): Promise<TelegramSeatSession> {
  const initData = telegram?.initData;
  if (!initData) throw new SeatApiError("OPEN_FROM_BOT");
  const hash = new URLSearchParams(initData).get("hash") ?? "";
  const key = /^[a-f0-9]{64}$/.test(hash) ? `ticketron:seats:${hash}` : null;
  if (key) {
    try {
      const previous = sessionStorage.getItem(key);
      if (previous) return JSON.parse(previous) as TelegramSeatSession;
    } catch { /* Telegram webviews may disable browser storage. */ }
  }
  const session = await api<TelegramSeatSession>("session", undefined, { initData });
  if (key) {
    try { sessionStorage.setItem(key, JSON.stringify(session)); } catch { /* Keep the session in memory. */ }
  }
  return session;
}

export function syncTelegramViewport() {
  if (!telegram) return;
  const root = document.documentElement;
  root.dataset.theme = telegram.colorScheme;
  const height = telegram.viewportStableHeight;
  if (Number.isFinite(height) && height > 0) root.style.setProperty("--telegram-height", `${height}px`);
  for (const side of ["top", "bottom", "left", "right"] as const) {
    const pixels = (telegram.safeAreaInset?.[side] ?? 0) + (telegram.contentSafeAreaInset?.[side] ?? 0);
    root.style.setProperty(`--inset-${side}`, `${Math.max(0, pixels)}px`);
  }
}
