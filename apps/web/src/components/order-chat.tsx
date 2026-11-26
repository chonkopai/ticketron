"use client";

import { INTL_LOCALES } from "../lib/locale";

import { MessageComposer } from "./message-composer";
import { SupportFile, supportRequest, useSupportText } from "./platform-support";
import type { PrivateFile, EventChatMessage } from "@event-platform/shared-types";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { orderChatClient } from "../lib/order-chat-client";
import { useLocale } from "./locale-provider";
import { ORDER_CHAT_COPY } from "../lib/order-chat-copy";

export function OrderChat({ eventId, orderId, mode, accessToken }: { eventId: string; orderId: string; mode: "guest" | "organizer" | "anonymous"; accessToken?: string }) {
  return <OrderConversation key={`${mode}:${eventId}:${orderId}`} eventId={eventId} orderId={orderId} mode={mode} accessToken={accessToken} />;
}

function OrderConversation({ eventId, orderId, mode, accessToken }: { eventId: string; orderId: string; mode: "guest" | "organizer" | "anonymous"; accessToken?: string | undefined }) {
  const locale = useLocale(), t = useSupportText();
  const [files, setFiles] = useState<PrivateFile[]>([]);
  const copy = ORDER_CHAT_COPY[locale];
  const client = useMemo(() => orderChatClient(eventId, orderId, mode, accessToken), [accessToken, eventId, mode, orderId]);
  const [items, setItems] = useState<EventChatMessage[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const messageList = useRef<HTMLOListElement>(null);
  const followLatest = useRef(true);
  const previousViewport = useRef<{ height: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const list = messageList.current;
    if (!list) return;
    if (previousViewport.current !== null) {
      list.scrollTop = previousViewport.current.top + list.scrollHeight - previousViewport.current.height;
      previousViewport.current = null;
    } else if (followLatest.current) {
      list.scrollTop = list.scrollHeight;
    }
  }, [items, loaded]);
  const pending = useRef(false);
  const messageKey = useRef<string | null>(null);
  const cursorInitialized = useRef(false);
  const refresh = useCallback(async () => {
    const page = await client.list();
    setItems((previous) => {
      const byId = new Map(previous.map((item) => [item.id, item]));
      page.items.forEach((item) => byId.set(item.id, item));
      return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    });
    if (!cursorInitialized.current) { setCursor(page.nextCursor); cursorInitialized.current = true; }
    if (!document.hidden) await client.read();
    setLoadError(null);
  }, [client]);
  useEffect(() => {
    let active = true;
    followLatest.current = true; previousViewport.current = null;
    setLoaded(false); setItems([]); setCursor(null); setError(null); setLoadError(null); cursorInitialized.current = false;
    void refresh().catch((reason) => { if (active) setLoadError(errorText(reason, copy.failed)); }).finally(() => { if (active) setLoaded(true); });
    const timer = setInterval(() => { if (active && !document.hidden) void refresh().catch((reason) => { if (active) setLoadError(errorText(reason, copy.failed)); }); }, 10_000);
    return () => { active = false; clearInterval(timer); };
  }, [refresh, copy]);
  async function older(): Promise<void> {
    if (!cursor) return;
    try {
      const page = await client.list(cursor);
      const list = messageList.current;
      previousViewport.current = list ? { height: list.scrollHeight, top: list.scrollTop } : null;
      setItems((previous) => [...page.items.filter((item) => !previous.some((existing) => existing.id === item.id)), ...previous]);
      setCursor(page.nextCursor);
    } catch (reason) { setError(errorText(reason, copy.failed)); }
  }
  async function send(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending.current || !draft.trim()) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      const requestKey = messageKey.current ?? crypto.randomUUID(); messageKey.current = requestKey;
      const saved = await client.send(draft.trim(), requestKey, files.map(file => file.id));
      followLatest.current = true;
      setItems((previous) => previous.some((item) => item.id === saved.id) ? previous : [...previous, saved]);
      setDraft(""); setFiles([]); messageKey.current = null;
      void refresh().catch(() => undefined);
    } catch (reason) { setError(errorText(reason, copy.failed)); }
    finally { pending.current = false; setBusy(false); }
  }
  return <section className="mt-6 border-t border-[#e7e3ed] dark:border-ticket-border pt-5" aria-label={copy.label}><h3 className="text-base font-bold">{copy.title}</h3><p className="mt-1 text-xs text-[#6b7280] dark:text-ticket-muted">{copy.hint}</p>
    {cursor ? <button type="button" className="mt-3 text-sm font-semibold text-[#5b21b6] dark:text-ticket-accent" onClick={() => void older()}>{copy.older}</button> : null}
    {!loaded ? <p className="mt-3 text-sm" role="status">{copy.loading}</p> : items.length === 0 ? !loadError && <p className="mt-3 text-sm text-[#6b7280] dark:text-ticket-muted">{copy.empty}</p> : <ol ref={messageList} onScroll={event => { const list = event.currentTarget; followLatest.current = list.scrollHeight - list.clientHeight - list.scrollTop < 40; }} className="mt-3 max-h-80 space-y-2 overflow-y-auto conversation-transcript" aria-live="polite">{items.map((item) => <li key={item.id} className={`conversation-bubble px-3 py-2 text-sm${item.sender === (mode === "organizer" ? "organizer" : "guest") ? " is-outgoing" : ""}`}><p className="whitespace-pre-wrap break-words">{item.text}</p>{item.files?.map(file => <SupportFile key={file.id} file={file} access={accessToken} onError={setError} />)}<p className="mt-1 text-[11px] text-[#6b7280] dark:text-ticket-muted">{item.sender === "support" ? t("Поддержка TICKET", "TICKET қолдауы", "TICKET support") : item.sender === (mode === "organizer" ? "organizer" : "guest") ? t("Вы", "Сіз", "You") : item.sender === "organizer" ? copy.organizer : t("Клиент", "Клиент", "Customer")} · {new Date(item.createdAt).toLocaleString(INTL_LOCALES[locale])}</p></li>)}</ol>}
    {loadError ? <p className="mt-3 rounded-lg bg-red-50 dark:bg-ticket-danger-soft p-2 text-sm text-red-800 dark:text-ticket-danger" role="alert">{loadError}<button type="button" className="ml-3 font-semibold underline" onClick={() => void refresh().catch((reason) => setLoadError(errorText(reason, copy.failed)))}>{copy.retry}</button></p> : null}
    {error ? <p className="mt-3 rounded-lg bg-red-50 dark:bg-ticket-danger-soft p-2 text-sm text-red-800 dark:text-ticket-danger" role="alert">{error}</p> : null}
    <form className="mt-4" onSubmit={event => void send(event)}>
      <MessageComposer value={draft} onChange={value => { setDraft(value); messageKey.current = null; }} label={copy.yourMessage}
        sendLabel={copy.send} sendingLabel={copy.sending} maxLength={2000} files={files}
        onFiles={next => { setFiles(next); messageKey.current = null; }} busy={busy} onBusy={setBusy} onError={setError}
        upload={async file => { const data = new FormData(); data.set("file", file); return supportRequest<PrivateFile>("uploads", { method: "POST", body: data }, accessToken); }} />
    </form>
  </section>;
}

function errorText(error: unknown, fallback: string): string { return error instanceof Error ? error.message : fallback; }
