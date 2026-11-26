"use client";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type {
  Paged,
  PrivateFile,
  SupportCase,
  SupportMessage,
} from "@event-platform/shared-types";
import { apiBlobRequest, apiRequest } from "../app/(auth)/_lib/api";
import { useLocale } from "./locale-provider";
import "./platform-support.css";
import { INTL_LOCALES } from "../lib/locale";
import { MessageComposer } from "./message-composer";
export function useSupportText() {
  const locale = useLocale();
  return (ru: string, kk: string, en: string) => ({ ru, kk, en })[locale];
}
export async function supportRequest<T>(
  path: string,
  init: RequestInit = {},
  access?: string,
): Promise<T> {
  if (!access) return apiRequest<T>(`/platform-support/${path}`, init);
  const response = await fetch(`/platform-support/${path}`, {
    ...init,
    headers: {
      ...(init.body && !(init.body instanceof FormData)
        ? { "content-type": "application/json" }
        : {}),
      "x-quick-access": access,
    },
    cache: "no-store",
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.message ?? `Ошибка запроса (${response.status})`);
  }
  return response.json() as Promise<T>;
}
export async function supportFileBlob(file: PrivateFile, access?: string, staff = false) {
  const path = staff ? `/staff-api/files/${file.id}` : `/platform-support/files/${file.id}`;
  if (!access && !staff) return apiBlobRequest(path);
  const response = await fetch(path, { headers: access ? { "x-quick-access": access } : {}, cache: "no-store" });
  if (!response.ok) throw new Error(`File (${response.status})`);
  return response.blob();
}
export async function downloadSupportFile(file: PrivateFile, access?: string, staff = false) {
  const blob = await supportFileBlob(file, access, staff);
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = file.name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export function SupportFile({ file, access, staff = false, onError }: {
  file: PrivateFile; access?: string | undefined; staff?: boolean; onError: (v: string) => void;
}) {
  const t = useSupportText(), [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    let active = true, url: string | undefined;
    if (file.mime.startsWith("image/")) void supportFileBlob(file, access, staff).then(blob => {
      if (!active) return;
      url = URL.createObjectURL(blob); setPreview(url);
    }).catch(() => {});
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [file.id, file.mime, access, staff]);
  return <button type="button" className="support-file-card" onClick={() => void downloadSupportFile(file, access, staff).catch(() => onError(t("Не удалось загрузить файл. Повторите попытку.", "Файл жүктелмеді. Қайталаңыз.", "Could not download the file. Try again.")))}>
    {preview ? <img src={preview} alt="" width={48} height={48} loading="lazy" decoding="async" /> : <span aria-hidden="true">{file.mime === "application/pdf" ? "PDF" : "▧"}</span>}
    <span>{file.name}<small>{Math.ceil(file.size / 1024)} KB · {t("Скачать", "Жүктеу", "Download")} ↓</small></span>
  </button>;
}
export function SupportStatus({ status }: { status: string }) {
  const t = useSupportText();
  const names: Record<string, string> = {
    new: t("Новое", "Жаңа", "New"),
    in_progress: t("В работе", "Қарастырылуда", "In progress"),
    closed: t("Закрыто", "Жабық", "Closed"),
    pending: t("На проверке", "Тексерілуде", "Pending review"),
    changes_requested: t(
      "Нужны изменения",
      "Өзгеріс қажет",
      "Changes requested",
    ),
    verified: t("Подтверждён", "Расталған", "Verified"),
    rejected: t("Отклонено", "Қабылданбаған", "Rejected"),
    revoked: t(
      "Подтверждение отозвано",
      "Растау қайтарылды",
      "Verification revoked",
    ),
    not_submitted: t("Не отправлена", "Жіберілмеген", "Not submitted"),
  };
  return <span className="support-status">{names[status] ?? status}</span>;
}
export function PlatformSupport({
  access,
  orderId,
  initialCaseId,
  onUnread,
  requesterKind = "customer",
}: {
  requesterKind?: "customer" | "organizer";
  access?: string | undefined;
  orderId?: string | undefined;
  initialCaseId?: string | undefined;
  onUnread?: (v: number) => void;
}) {
  const locale = useLocale();
  const t = useSupportText(),
    [cases, setCases] = useState<Paged<SupportCase> | null>(null),
    [page, setPage] = useState(1),
    [selected, setSelected] = useState<string | null>(initialCaseId ?? null),
    [creating, setCreating] = useState(false),
    [files, setFiles] = useState<PrivateFile[]>([]),
    [subject, setSubject] = useState(""),
    [text, setText] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const key = useRef(crypto.randomUUID()), createLock = useRef(false);
  const refresh = useCallback(async () => {
    try {
      const result = await supportRequest<Paged<SupportCase>>(
        `cases?page=${page}`,
        {},
        access,
      );
      setCases(result);
      onUnread?.(result.items.filter((v) => v.unread).length);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [page, access, onUnread]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 10000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    const query = new URLSearchParams(location.search).get("caseId");
    if (initialCaseId) setSelected(initialCaseId);
    else if (query && /^[a-f0-9-]{36}$/i.test(query)) setSelected(query);
  }, [initialCaseId]);
  async function create(e: FormEvent) {
    e.preventDefault();
    if (busy || createLock.current) return;
    createLock.current = true;
    setBusy(true);
    setError("");
    try {
      const row = await supportRequest<SupportCase>(
        "cases",
        {
          method: "POST",
          body: JSON.stringify({
            subject,
            text,
            requesterKind,
            fileIds: files.map(f => f.id),
            clientKey: key.current,
            ...(orderId ? { orderId } : {}),
          }),
        },
        access,
      );
      setFiles([]);
      setCreating(false);
      setSelected(row.id);
      setSubject("");
      setText("");
      key.current = crypto.randomUUID();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      createLock.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="platform-support">
      <div className="account-card-toolbar">
        <h2>{t("Поддержка TICKET", "TICKET қолдауы", "TICKET support")}</h2>
        <button
          type="button"
          className="account-button account-button-primary"
          disabled={busy}
          onClick={() => {
            setCreating(true);
            setSelected(null);
            key.current = crypto.randomUUID();
          }}
        >
          {t("Новое обращение", "Жаңа өтініш", "New conversation")}
        </button>
      </div>
      {error ? (
        <p role="alert" className="support-error">
          {error}
          <button
            type="button"
            className="account-text-link"
            onClick={() => void refresh()}
          >
            {t("Повторить", "Қайталау", "Retry")}
          </button>
        </p>
      ) : null}
      {creating ? (
        <form
          className="account-card support-form"
          onSubmit={(e) => void create(e)}
        >
          <label className="account-field">
            {t("Тема", "Тақырып", "Subject")}
            <input
              disabled={busy}
              required
              minLength={3}
              maxLength={160}
              value={subject}
              onChange={(e) => { setSubject(e.target.value); key.current = crypto.randomUUID(); }}
            />
          </label>
          <MessageComposer value={text} onChange={value => { setText(value); key.current = crypto.randomUUID(); }}
            label={t("Сообщение", "Хабарлама", "Message")} sendLabel={t("Отправить", "Жіберу", "Send")} sendingLabel={t("Отправка…", "Жіберілуде…", "Sending…")}
            maxLength={4000} files={files} onFiles={next => { setFiles(next); key.current = crypto.randomUUID(); }}
            busy={busy} onBusy={setBusy} onError={setError}
            upload={async file => { const data = new FormData(); data.set("file", file); return supportRequest<PrivateFile>("uploads", { method: "POST", body: data }, access); }} />
          <div className="support-actions">
            <button
              type="button"
              className="account-button"
              disabled={busy}
              onClick={() => setCreating(false)}
            >
              {t("Отмена", "Бас тарту", "Cancel")}
            </button>
          </div>

        </form>
      ) : null}
      {selected ? (
        <>
          <button
            type="button"
            className="account-text-link"
            onClick={() => {
              setSelected(null);
              void refresh();
            }}
          >
            ← {t("Все обращения", "Барлық өтініштер", "All conversations")}
          </button>
          <SupportConversation
            key={selected}
            id={selected}
            access={access}
            onChanged={refresh}
          />
        </>
      ) : !creating ? (
        <div className="account-card">
          {cases ? (
            cases.items.length ? (
              cases.items.map((row) => (
                <button
                  className="support-case-row"
                  type="button"
                  key={row.id}
                  onClick={() => setSelected(row.id)}
                >
                  <span>
                    <strong>
                      {row.unread ? "● " : ""}
                      {row.subject}
                    </strong>
                    <small>{new Date(row.updatedAt).toLocaleString(INTL_LOCALES[locale])}</small>
                  </span>
                  <SupportStatus status={row.status} />
                </button>
              ))
            ) : (
              <p className="support-empty">
                <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5A8.5 8.5 0 0 1 10.5 3h2a8.5 8.5 0 0 1 8.5 8.5Z"/><path d="M7 9h10M7 13h6"/></svg>
                {t(
                  "Обращений пока нет. Напишите нам — мы поможем.",
                  "Әзірге өтініш жоқ. Бізге жазыңыз — көмектесеміз.",
                  "No conversations yet. Write to us for help.",
                )}
              </p>
            )
          ) : (
            <p role="status">{t("Загрузка…", "Жүктелуде…", "Loading…")}</p>
          )}
          {cases && cases.total > cases.limit ? (
            <div className="support-actions">
              <button
                type="button"
                className="account-button"
                disabled={page === 1}
                onClick={() => setPage((v) => v - 1)}
              >
                ←
              </button>
              <span>{page}</span>
              <button
                type="button"
                className="account-button"
                disabled={!cases.hasNext}
                onClick={() => setPage((v) => v + 1)}
              >
                →
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
export function SupportConversation({
  id,
  access,
  onChanged,
}: {
  id: string;
  access?: string | undefined;
  onChanged?: () => void;
}) {
  const t = useSupportText(),
    [messages, setMessages] = useState<
      (Paged<SupportMessage> & { case: SupportCase }) | null
    >(null),
    [loadingOlder, setLoadingOlder] = useState(false),
    [text, setText] = useState(""),
    [files, setFiles] = useState<PrivateFile[]>([]),
    [error, setError] = useState(""),
    [loadError, setLoadError] = useState(""),
    [busy, setBusy] = useState(false);
  const locale = useLocale();
  const key = useRef(crypto.randomUUID()), lock = useRef(false);
  const list = useRef<HTMLDivElement>(null), viewport = useRef<{ top: number; height: number } | null>(null);
  const follow = useRef(true);
  useLayoutEffect(() => {
    const el = list.current; if (!el) return;
    if (viewport.current) { el.scrollTop = viewport.current.top + el.scrollHeight - viewport.current.height; viewport.current = null; }
    else if (follow.current) el.scrollTop = el.scrollHeight;
  }, [messages]);
  const refresh = useCallback(async () => {
    try {
      const result = await supportRequest<Paged<SupportMessage> & { case: SupportCase }>(`cases/${id}/messages?limit=50`, {}, access);
      setMessages(previous => previous ? { ...result, hasNext: previous.hasNext, items: mergeMessages(previous.items, result.items) } : result);
      setLoadError("");
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [id, access]);
  useEffect(() => {
    setMessages(null);
    setFiles([]);
    setText("");
    key.current = crypto.randomUUID();
  }, [id]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);
  async function older() {
    if (loadingOlder || !messages?.hasNext) return;
    setLoadingOlder(true);
    try {
      const result = await supportRequest<Paged<SupportMessage>>(`cases/${id}/messages?before=${messages.items[0]!.id}&limit=50`, {}, access);
      const el = list.current; viewport.current = el ? { top: el.scrollTop, height: el.scrollHeight } : null;
      setMessages(previous => previous ? { ...previous, hasNext: result.hasNext, items: mergeMessages(result.items, previous.items) } : previous);
    } catch (e) { setError((e as Error).message); }
    finally { setLoadingOlder(false); }
  }
  async function send(e: FormEvent) {
    e.preventDefault();
    if (busy || lock.current || !text.trim()) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await supportRequest(
        `cases/${id}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            text,
            clientKey: key.current,
            fileIds: files.map((v) => v.id),
          }),
        },
        access,
      );
      setText("");
      setFiles([]);
      key.current = crypto.randomUUID();
      follow.current = true;
      await refresh();
      onChanged?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const sender = (kind: string) => ["moderator", "support"].includes(kind)
    ? t("Поддержка TICKET", "TICKET қолдауы", "TICKET support") : t("Вы", "Сіз", "You");
  return (
    <section className="account-card support-thread">
      <div className="account-card-toolbar">
        <h3>
          {messages?.case.subject ?? t("Переписка", "Хаттар", "Conversation")}
        </h3>
        {messages ? <SupportStatus status={messages.case.status} /> : null}
      </div>
      {loadError ? <p role="alert" className="support-error">{loadError} <button type="button" className="account-text-link" onClick={() => void refresh()}>{t("Повторить", "Қайталау", "Retry")}</button></p> : null}
      {error ? (
        <p role="alert" className="support-error">
          {error}
        </p>
      ) : null}
      {messages ? (
        <>
          {messages.hasNext ? <button type="button" className="account-text-link support-load-older" disabled={loadingOlder} onClick={() => void older()}>
            {loadingOlder ? t("Загрузка…", "Жүктелуде…", "Loading…") : t("Загрузить предыдущие сообщения", "Алдыңғы хабарларды жүктеу", "Load previous messages")}
          </button> : null}
          <div ref={list} onScroll={e => { const el = e.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }} className="support-message-list conversation-transcript" aria-live="polite">
            {messages.items.map((row) => (
              <article
                className={`support-message ${["moderator", "support"].includes(row.authorKind) ? "from-staff" : ""}`}
                key={row.id}
              >
                <div>
                  <strong>{sender(row.authorKind)}</strong>
                  <time dateTime={row.createdAt}>
                    {new Date(row.createdAt).toLocaleString(INTL_LOCALES[locale])}
                  </time>
                </div>
                <p>{row.text}</p>
                {row.files.map((file) => (
                  <SupportFile
                    key={file.id}
                    file={file}
                    access={access}
                    onError={setError}
                  />
                ))}
              </article>
            ))}
          </div>
        </>
      ) : (
        <p role="status">{t("Загрузка…", "Жүктелуде…", "Loading…")}</p>
      )}
      <form className="support-form" onSubmit={event => void send(event)}>
        <MessageComposer value={text} onChange={value => { setText(value); key.current = crypto.randomUUID(); }}
          label={t("Сообщение", "Хабарлама", "Message")} sendLabel={t("Отправить", "Жіберу", "Send")} sendingLabel={t("Отправка…", "Жіберілуде…", "Sending…")}
          maxLength={4000} files={files} onFiles={next => { setFiles(next); key.current = crypto.randomUUID(); }}
          busy={busy} onBusy={setBusy} onError={setError}
          upload={async file => { const data = new FormData(); data.set("file", file); return supportRequest<PrivateFile>(`uploads?caseId=${id}`, { method: "POST", body: data }, access); }} />
      </form>
    </section>
  );
}

export function mergeMessages<T extends { id: string; createdAt: string }>(previous: T[], incoming: T[]): T[] {
  const items = new Map(previous.map(item => [item.id, item]));
  incoming.forEach(item => items.set(item.id, item));
  return [...items.values()].sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
