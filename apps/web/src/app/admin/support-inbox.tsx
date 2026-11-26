"use client";
import { MessageComposer } from "../../components/message-composer";
import { mergeMessages, SupportFile } from "../../components/platform-support";
import { INTL_LOCALES } from "../../lib/locale";
import { StaffSelect } from "./staff-select";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  Paged,
  SupportCase,
  SupportMessage,
  PrivateFile,
} from "@event-platform/shared-types";
import { useLocale } from "../../components/locale-provider";
import { staffRequest, errorText } from "./staff-client";
import {
  useText,
  useResource,
  ResourceState,
  Table,
  Pager,
  Status,
  date,
  money,
  text,
  type Row,
} from "./staff-ui";
export function StaffSupportInbox({
  initialCaseId,
  onConsumed,
  openOrder,
}: {
  initialCaseId: string | null;
  onConsumed: () => void;
  openOrder: (id: string) => void;
}) {
  const t = useText(),
    [category, setCategory] = useState<"support" | "organizer">("support"),
    [search, setSearch] = useState(""),
    [status, setStatus] = useState(""),
    [page, setPage] = useState(1),
    [id, setId] = useState<string | null>(null);
  const resource = useResource<Paged<SupportCase>>(
    `cases?page=${page}&search=${encodeURIComponent(search)}${status ? `&status=${status}` : ""}`,
    10000,
  );
  useEffect(() => {
    if (initialCaseId) {
      setId(initialCaseId);
      onConsumed();
    }
  }, [initialCaseId, onConsumed]);
  if (id)
    return (
      <StaffConversation
        key={id}
        id={id}
        openOrder={openOrder}
        onBack={() => {
          setId(null);
          resource.retry();
        }}
      />
    );
  return (
    <><div className="staff-support-tabs" role="group" aria-label={t("Категория обращений", "Өтініш санаты", "Conversation category")}>
      <button aria-pressed={category === "support"} onClick={() => setCategory("support")}>{t("Обращения в поддержку", "Қолдауға өтініштер", "Support enquiries")}</button>
      <button aria-pressed={category === "organizer"} onClick={() => setCategory("organizer")}>{t("Переписка с организаторами", "Ұйымдастырушылармен хат алмасу", "Organizer conversations")}</button>
    </div>
    {category === "organizer" ? <StaffOrganizerInbox openOrder={openOrder} /> : <section className="staff-card">
      <div className="staff-toolbar">
        <input
          type="search"
          aria-label={t(
            "Поиск обращений",
            "Өтініш іздеу",
            "Search conversations",
          )}
          placeholder={t(
            "Поиск обращений",
            "Өтініш іздеу",
            "Search conversations",
          )}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        <StaffSelect
          aria-label={t("Статус", "Күйі", "Status")}
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">
            {t("Все статусы", "Барлық күйлер", "All statuses")}
          </option>
          <option value="new">{t("Новые", "Жаңа", "New")}</option>
          <option value="in_progress">
            {t("В работе", "Жұмыста", "In progress")}
          </option>
          <option value="closed">{t("Закрытые", "Жабық", "Closed")}</option>
        </StaffSelect>
      </div>
      <p className="staff-result-count">
        {t("Обращений", "Өтініштер", "Conversations")}:{" "}
        {resource.data?.total ?? "…"}
      </p>
      <ResourceState
        error={resource.error}
        loading={!resource.data}
        onRetry={resource.retry}
      />
      {resource.data ? (
        <>
          <Table
            wholeRow
            rows={resource.data.items as unknown as Row[]}
            columns={[
              {
                key: "subject",
                label: t("Тема", "Тақырып", "Subject"),
                render: (row) => (
                  <>
                    {row.unread ? (
                      <strong
                        aria-label={t("Непрочитано", "Оқылмаған", "Unread")}
                      >
                        ●{" "}
                      </strong>
                    ) : null}
                    {text(row.subject)}
                  </>
                ),
              },
              {
                key: "status",
                label: t("Статус", "Күйі", "Status"),
                render: (row) => <Status value={row.status} />,
              },
              {
                key: "updatedAt",
                label: t("Обновлено", "Жаңартылды", "Updated"),
                render: (row) => date(row.updatedAt),
              },
            ]}
            onRow={(row) => setId(String(row.id))}
          />
          <Pager
            page={page}
            limit={20}
            total={resource.data.total}
            onPage={setPage}
          />
        </>
      ) : null}
    </section>}</>
  );
}
function StaffConversation({
  id,
  onBack,
  openOrder,
  organizerChat,
}: {
  organizerChat?: OrganizerConversation;
  id: string;
  onBack: () => void;
  openOrder: (id: string) => void;
}) {
  const t = useText(),
    locale = useLocale(),
    resource = useResource<Paged<SupportMessage> & { case: SupportCase }>(
      `${organizerChat ? `organizer-chats/${id}` : `cases/${id}`}/messages?limit=50`,
      5000,
    ),
    [body, setBody] = useState(""),
    [files, setFiles] = useState<PrivateFile[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [chat, setChat] = useState<Paged<Row> | null>(null);
  const key = useRef(crypto.randomUUID()), lock = useRef(false);
  const path = organizerChat ? `organizer-chats/${id}` : `cases/${id}`;
  const [history, setHistory] = useState<SupportMessage[]>([]), [hasOlder, setHasOlder] = useState(false), [loadingOlder, setLoadingOlder] = useState(false);
  const initialized = useRef(false), list = useRef<HTMLDivElement>(null), viewport = useRef<{ top: number; height: number } | null>(null), follow = useRef(true);
  useEffect(() => {
    if (!resource.data) return;
    setHistory(previous => mergeMessages(previous, resource.data!.items));
    if (!initialized.current) { initialized.current = true; setHasOlder(resource.data.hasNext); }
  }, [resource.data]);
  useLayoutEffect(() => {
    const el = list.current; if (!el) return;
    if (viewport.current) { el.scrollTop = viewport.current.top + el.scrollHeight - viewport.current.height; viewport.current = null; }
    else if (follow.current) el.scrollTop = el.scrollHeight;
  }, [history]);
  async function loadOlder() {
    if (loadingOlder) return;
    setLoadingOlder(true);
    try {
      const result = await staffRequest<Paged<SupportMessage>>(`${path}/messages?before=${history[0]!.id}&limit=50`);
      const el = list.current; viewport.current = el ? { top: el.scrollTop, height: el.scrollHeight } : null;
      setHistory(previous => mergeMessages(previous, result.items)); setHasOlder(result.hasNext);
    } catch (reason) { setError(errorText(reason, locale)); }
    finally { setLoadingOlder(false); }
  }
  async function send() {
    if (!body.trim() || busy || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await staffRequest(`${path}/messages`, {
        text: body,
        clientKey: key.current,
        fileIds: files.map((f) => f.id),
      });
      key.current = crypto.randomUUID();
      setBody("");
      setFiles([]);
      follow.current = true;
      resource.retry();
    } catch (reason) {
      setError(errorText(reason, locale));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const order = useResource<Row>(
    (organizerChat?.orderId ?? resource.data?.case?.orderId) ? `orders/${organizerChat?.orderId ?? resource.data?.case?.orderId}` : null,
  );
  const conversation = organizerChat ? { ...organizerChat, eventTitle: organizerChat.subject, status: "in_progress", eventId: organizerChat.eventId, ticketId: null } : resource.data?.case;
  const messages = history;
  const sender = (kind: string) => ["support", "moderator"].includes(kind) ? t("Поддержка TICKET", "TICKET қолдауы", "TICKET support") : kind === "organizer" ? t("Организатор", "Ұйымдастырушы", "Organizer") : t("Клиент", "Клиент", "Customer");
  return (
    <>
      <button className="staff-link" onClick={onBack}>
        ← {t("Все обращения", "Барлық өтініштер", "All conversations")}
      </button>
      <ResourceState
        error={resource.error}
        loading={!resource.data}
        onRetry={resource.retry}
      />
      {conversation ? (
        <div className="staff-conversation-layout">
          <section className="staff-card">
            <div className="staff-toolbar">
              <h2>{conversation.subject}</h2>
              {!organizerChat ? <Status value={conversation.status} /> : null}
            </div>
            {organizerChat ? <p className="staff-muted">{t("Клиент", "Клиент", "Customer")}: {organizerChat.customer ?? "—"} · {t("Организатор", "Ұйымдастырушы", "Organizer")}: {organizerChat.organizer ?? "—"}</p> : null}
            {hasOlder ? <button className="staff-link" disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? t("Загрузка…", "Жүктелуде…", "Loading…") : t("Загрузить предыдущие сообщения", "Алдыңғы хабарларды жүктеу", "Load previous messages")}</button> : null}
            <div ref={list} onScroll={e => { const el = e.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }} className="staff-messages conversation-transcript" aria-live="polite">
              {messages?.map((message) => (
                <article
                  key={message.id}
                  className={`staff-message from-${message.authorKind} ${message.internal ? "is-note" : ""}`}
                >
                  <div>
                    <strong>{sender(message.authorKind)}</strong>
                    {message.internal ? (
                      <strong>
                        {t("Внутренняя заметка", "Ішкі жазба", "Internal note")}
                      </strong>
                    ) : null}
                    <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString(INTL_LOCALES[locale])}</time>
                  </div>
                  <p>{message.text}</p>
                  {message.files.map((file) => (
                    <SupportFile key={file.id} file={file} staff onError={setError} />
                  ))}
                </article>
              ))}
            </div>
            {error ? (
              <p className="staff-error" role="alert">
                {error}
              </p>
            ) : null}
            <form className="staff-chat-compose" onSubmit={event => { event.preventDefault(); void send(); }}>
              <MessageComposer value={body} onChange={value => { setBody(value); key.current = crypto.randomUUID(); }}
                label={t("Сообщение", "Хабарлама", "Message")} sendLabel={t("Отправить", "Жіберу", "Send")} sendingLabel={t("Отправка…", "Жіберілуде…", "Sending…")}
                maxLength={4000} files={files} onFiles={next => { setFiles(next); key.current = crypto.randomUUID(); }}
                busy={busy} onBusy={setBusy} onError={setError}
                upload={async file => { const data = new FormData(); data.set("file", file); return staffRequest<PrivateFile>(organizerChat ? "support-uploads" : `cases/${id}/uploads`, data); }} />
            </form>
          </section>
          <aside className="staff-card">
            <h2>{t("Обращение", "Өтініш", "Case")}</h2>
            <p>{conversation.subject}</p>
            {!organizerChat && conversation.customer ? <p>{t("Клиент", "Клиент", "Customer")}: {conversation.customer}</p> : null}
            {conversation.eventId ? <p>{t("Мероприятие", "Іс-шара", "Event")}: <span className="staff-id">{conversation.eventTitle ?? conversation.eventId}</span></p> : null}
            <p>
              {t("Заказ", "Тапсырыс", "Order")}:{" "}
              <span className="staff-id">{conversation.orderId ?? "—"}</span>
            </p>
            {order.data ? (
              <div>
                <p>
                  {t("Сумма", "Сома", "Amount")}:{" "}
                  {money(order.data.amount, order.data.currency)}
                </p>
                <Status value={order.data.paymentStatus} />
                <button onClick={() => openOrder(conversation.orderId!)}>
                  {t(
                    "Заказ, билеты и возврат",
                    "Тапсырыс, билеттер және қайтару",
                    "Order, tickets & refund",
                  )}
                </button>
              </div>
            ) : null}
            {conversation.orderId ? (
              <button
                onClick={() =>
                  void staffRequest<Paged<Row>>(`cases/${id}/order-chat`)
                    .then(setChat)
                    .catch((reason) => setError(errorText(reason, locale)))
                }
              >
                {t(
                  "Переписка по заказу",
                  "Тапсырыс хаттары",
                  "Inspect order conversation",
                )}
              </button>
            ) : null}
            {chat ? (
              <div>
                {chat.items.map((row) => (
                  <p key={String(row.id)}>
                    <strong>{text(row.sender)}</strong>: {text(row.text)}
                  </p>
                ))}
                <Pager
                  page={chat.page}
                  total={chat.total}
                  limit={chat.limit}
                  onPage={(page) => {
                    void staffRequest<Paged<Row>>(
                      `cases/${id}/order-chat?page=${page}`,
                    )
                      .then(setChat)
                      .catch((reason) => setError(errorText(reason, locale)));
                  }}
                />
              </div>
            ) : null}
          </aside>
        </div>
      ) : null}

    </>
  );
}

interface OrganizerConversation { id: string; eventId: string; orderId: string; subject: string; organizer?: string; customer?: string; updatedAt: string; }
function StaffOrganizerInbox({ openOrder }: { openOrder: (id: string) => void }) {
  const t = useText(), [search, setSearch] = useState(""), [page, setPage] = useState(1), [selected, setSelected] = useState<OrganizerConversation | null>(null);
  const resource = useResource<Paged<OrganizerConversation>>(`organizer-chats?page=${page}&search=${encodeURIComponent(search)}`, 10000);
  if (selected) return <StaffConversation key={selected.id} id={selected.id} organizerChat={selected} openOrder={openOrder} onBack={() => setSelected(null)} />;
  return <section className="staff-card"><input type="search" value={search} placeholder={t("Поиск по мероприятию", "Іс-шара бойынша іздеу", "Search by event")} aria-label={t("Поиск по мероприятию", "Іс-шара бойынша іздеу", "Search by event")} onChange={e => { setSearch(e.target.value); setPage(1); }} />
    <ResourceState error={resource.error} loading={!resource.data} onRetry={resource.retry} />
    {resource.data ? <><Table wholeRow rows={resource.data.items as unknown as Row[]} columns={[
      { key: "subject", label: t("Мероприятие", "Іс-шара", "Event") },
      { key: "customer", label: t("Клиент", "Клиент", "Customer") },
      { key: "organizer", label: t("Организатор", "Ұйымдастырушы", "Organizer") },
      { key: "updatedAt", label: t("Обновлено", "Жаңартылды", "Updated"), render: row => date(row.updatedAt) },
    ]} onRow={row => setSelected(resource.data!.items.find(item => item.id === row.id)!)} /><Pager page={page} limit={20} total={resource.data.total} onPage={setPage} /></> : null}
  </section>;
}
