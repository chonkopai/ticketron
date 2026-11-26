import { EVENT_NOTIFICATION_TYPES } from "@event-platform/shared-types";
import { updateCopy } from "./update-copy.js";
import type {
  BotConversationInbox, BotConversationPage, BotConversationRef, BotConversationSide, BotOrganizerEvents, BotOrganizerOrder,
  BotOrganizerOrderDetail, BotOrganizerSnapshot, BotOrganizerTab, EventNotificationStatus, ManagementCurrencyMoney,
  BotOperationalPreview, BotOperationalResult, EventNotificationType, NotificationPreferences,
} from "@event-platform/shared-types";
import { InlineKeyboard, InputFile } from "grammy";
import { BotApiError, type BotApiClient, type CheckoutActor } from "./api-client.js";
import { companionCopy, type CompanionCopy } from "./companion-copy.js";
import { compactId, expandId, parseThread, requestId, signIntent, threadData, uuid, verifyIntent, type ComposeScope } from "./companion-reference.js";
import { guestCopy, guestLocale, type GuestContext } from "./guest-copy.js";
import { cataloguePrice, truncate } from "./presentation.js";
import { HTML, bold, esc, eventWhen } from "./format.js";
import { privateActor } from "./private-actor.js";

type UpdateList = { items: BotOrganizerOrder[]; hasNext: boolean };
type Delivery = { eventId: string; orderId: string; status: EventNotificationStatus | null; label?: string };
const tabs = ["today", "upcoming", "past"] as const;
const kindCode = { order: "o", inquiry: "i" } as const;
const sideCode = { guest: "g", organizer: "a" } as const;

export class BotCompanion {
  constructor(private readonly secret: string, private readonly webOrigin?: string, private readonly messagesEnabled = true) {}

  async openLink(ctx: GuestContext, api: BotApiClient, payload: string) {
    const [, side, kind, id] = payload.split("_");
    const ref = parseThread(side, kind, id);
    if (ref) await this.callback(ctx, api, threadData(ref));
  }

  async callback(ctx: GuestContext, api: BotApiClient, data: string): Promise<boolean> {
    if (!data.startsWith("c:") && !data.startsWith("a:") && !data.startsWith("u:")) return false;
    const actor = privateActor(ctx);
    const labels = companionCopy[guestLocale(ctx)];
    if (!actor) {
      await privatePanel(ctx, guestCopy[guestLocale(ctx)].private, this.back(ctx));
      return true;
    }
    try {
      if (data.startsWith("c:")) await this.conversationAction(ctx, api, actor, data);
      else if (data.startsWith("u:")) await this.updateAction(ctx, api, actor, data);
      else await this.organizerAction(ctx, api, actor, data);
    } catch (error) {
      await privatePanel(ctx, errorText(labels, error), this.back(ctx, data.startsWith("a:") || data.startsWith("c:t:a:") ? "a:h" : "guest:home"));
    }
    return true;
  }

  async reply(ctx: GuestContext, api: BotApiClient): Promise<boolean> {
    const actor = privateActor(ctx);
    const update = ctx.message;
    const original = update?.reply_to_message;
    if (!actor || !update?.text || !original?.text || original.from?.id !== ctx.me.id || update.forward_origin) return false;
    const marker = /\n\n\[tr:([a-z_]+):([ga]):([a-f0-9-]{36}):([^\]]+)\]$/.exec(original.text);
    if (!marker) return false;
    const [, kind, side, id, intent] = marker;
    const labels = companionCopy[guestLocale(ctx)];
    if (!id || !uuid.test(id) || !intent || !verifyIntent(this.secret, actor, `compose.${kind}.${side}`, id, intent)) {
      await privatePanel(ctx, labels.expired, this.back(ctx));
      return true;
    }
    try {
      const text = update.text.trim();
      const updateType = EVENT_NOTIFICATION_TYPES.find(type => kind === `update_${type}`);
      if (side === "a" && updateType) {
        if (!text || text.length > 1000) { await this.updatePrompt(ctx, actor, id, updateType); return true; }
        const requestKey = requestId(["event-update", String(ctx.me.id), actor.chatId, String(update.message_id)]);
        await this.updatePreview(ctx, await api.companion<BotOperationalPreview>(actor, `updates/${id}/draft`, { type: updateType, text, requestKey }));
      } else if (kind === "lookup" && side === "a") {
        if (text.length < 2 || text.length > 80) { await this.prompt(ctx, actor, { side: "organizer", kind: "lookup", id }); return true; }
        const result = await api.companion<UpdateList>(actor, `events/${id}/lookup`, { search: text });
        await this.lookupResults(ctx, id, result);
      } else if (kind === "order" || kind === "inquiry" || (kind === "event" && side === "g")) {
        const role = side === "g" ? "guest" : "organizer";
        if (!this.messagesEnabled && role === "guest") return true;
        if (!text || text.length > 2000) { await this.prompt(ctx, actor, { kind, side: role, id }); return true; }
        const key = requestId(["message", String(ctx.me.id), actor.chatId, String(update.message_id)]);
        const saved = await api.companion<{ kind: "order" | "inquiry"; id: string }>(actor, `thread/${id}/send`, { kind, side: role, text, requestKey: key });
        await ctx.reply(labels.sent, { protect_content: true, reply_markup: new InlineKeyboard().text(labels.saved, threadData({ ...saved, side: role })).row().append(this.back(ctx, role === "organizer" ? "a:h" : "guest:home")) });
      } else return false;
    } catch (error) {
      const keyboard = new InlineKeyboard();
      if (kind === "order" || kind === "inquiry") keyboard.text(labels.saved, threadData({ id, kind, side: side === "g" ? "guest" : "organizer" })).row();
      await privatePanel(ctx, errorText(labels, error), keyboard.append(this.back(ctx, side === "a" ? "a:h" : "guest:home")));
    }
    return true;
  }

  private async conversationAction(ctx: GuestContext, api: BotApiClient, actor: CheckoutActor, data: string) {
    const [, action, first, second, third, fourth, fifth] = data.split(":");
    const labels = companionCopy[guestLocale(ctx)];
    if (action === "l" && (first === "g" || first === "a")) {
      const side = first === "g" ? "guest" : "organizer";
      if (!this.messagesEnabled && side === "guest") return;
      if (third && !uuid.test(third)) return;
      return this.inbox(ctx, api, actor, side, page(second), third);
    }
    if (action === "n" && first && uuid.test(first) && this.messagesEnabled) {
      const result = await api.companion<{ threadId: string | null }>(actor, `inquiry/${first}`);
      if (result.threadId) return this.thread(ctx, api, actor, { side: "guest", kind: "inquiry", id: result.threadId }, 1);
      return this.prompt(ctx, actor, { side: "guest", kind: "event", id: first });
    }
    if (action === "f" && (first === "a" || (first === "g" && this.messagesEnabled)) && second && uuid.test(second)) {
      const file = await api.conversationAttachment(actor, first === "g" ? "guest" : "organizer", second);
      await ctx.replyWithDocument(new InputFile(file.bytes, file.name), { protect_content: true });
      return;
    }
    if (action === "t" || action === "r") {
      const id = fifth ? expandId(third) : third;
      const scopedEvent = fifth ? expandId(fourth) : null;
      const ref = id ? parseThread(first, second, id) : null;
      if (!ref || (ref.side === "guest" && !this.messagesEnabled)) return;
      if (action === "t") return this.thread(ctx, api, actor, ref, page(fifth ?? fourth), scopedEvent ?? undefined);
      const result = await api.companion<BotConversationPage>(actor, `thread/${ref.id}`, { kind: ref.kind, side: ref.side, page: 1 });
      if (result.thread.closed) return this.renderThread(ctx, result, 1);
      return this.prompt(ctx, actor, ref);
    }
    if (action === "x" || action === "z") {
      const id = expandId(first);
      if (!id) return;
      const ref = { side: "organizer", kind: "inquiry", id } as const;
      if (action === "z") {
        if (!second || !verifyIntent(this.secret, actor, "close", id, second)) return privatePanel(ctx, labels.expired, this.back(ctx, threadData(ref)));
        await api.companion(actor, `inquiry/${id}/close`);
        return this.thread(ctx, api, actor, ref, 1);
      }
      const result = await api.companion<BotConversationPage>(actor, `thread/${id}`, { side: ref.side, kind: ref.kind, page: 1 });
      if (result.thread.closed) return this.renderThread(ctx, result, 1);
      const intent = signIntent(this.secret, actor, "close", id);
      return privatePanel(ctx, labels.closeConfirm, new InlineKeyboard().text(labels.confirm, `c:z:${first}:${intent}`).row().append(this.back(ctx, threadData(ref))));
    }
  }

  private async inbox(ctx: GuestContext, api: BotApiClient, actor: CheckoutActor, side: BotConversationSide, index: number, eventId?: string) {
    const locale = guestLocale(ctx), labels = companionCopy[locale], guest = guestCopy[locale];
    const data = await api.companion<BotConversationInbox>(actor, "inbox", { side, page: index, ...(eventId ? { eventId } : {}) });
    const keyboard = new InlineKeyboard();
    for (const thread of data.items) {
      const icon = thread.closed ? "🔒" : thread.kind === "order" ? "🧾" : "❓";
      keyboard.text(`${icon} ${truncate(thread.title, 40)}${thread.unread ? ` · 🔵 ${thread.unread} ${labels.unread}` : ""}`, threadData(thread, 1, eventId)).row();
    }
    paginate(keyboard, ctx, index, data.hasNext, next => `c:l:${sideCode[side]}:${next}${eventId ? `:${eventId}` : ""}`);
    if (side === "guest") {
      keyboard.text(labels.alerts, "guest:alerts:1").row().text(guest.find, "guest:find").text(guest.tickets, "checkout:tickets").row();
    }
    keyboard.append(this.back(ctx, eventId ? `a:s:${eventId}` : side === "organizer" ? "a:h" : "guest:home"));
    const title = side === "organizer" ? eventId ? labels.eventInbox : labels.inbox : guest.messages;
    await privatePanel(ctx, data.items.length ? `<b>${title}</b>` : `<b>${title}</b>\n\n${side === "organizer" ? labels.emptyOrganizer : labels.emptyInbox}`, keyboard);
  }

  private async thread(ctx: GuestContext, api: BotApiClient, actor: CheckoutActor, ref: BotConversationRef, index: number, scopedEvent?: string) {
    const data = await api.companion<BotConversationPage>(actor, `thread/${ref.id}`, { side: ref.side, kind: ref.kind, page: index });
    await this.renderThread(ctx, data, index, scopedEvent === data.thread.eventId ? scopedEvent : undefined);
  }

  private async renderThread(ctx: GuestContext, data: BotConversationPage, index: number, scopedEvent?: string) {
    const locale = guestLocale(ctx), labels = companionCopy[locale], guest = guestCopy[locale];
    const { thread } = data;
    const messages = data.items.map(item => {
      const stamp = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short", timeZone: "UTC" }).format(new Date(item.createdAt));
      return `<b>${labels[item.sender]}</b> · <i>${stamp} UTC</i>\n${esc(item.text)}`;
    });
    const heading = `<b>${thread.kind === "order" ? labels.orderChat : `❓ ${labels.inquiry}`}</b> · №${thread.id.slice(0, 8)}`;
    const keyboard = new InlineKeyboard();
    if (!thread.closed) keyboard.text(labels.reply, `c:r:${sideCode[thread.side]}:${kindCode[thread.kind]}:${thread.id}`).row();
    if (!thread.closed && thread.side === "organizer" && thread.kind === "inquiry") keyboard.text(labels.close, `c:x:${compactId(thread.id)}`).row();
    for (const file of data.items.flatMap(item => item.files ?? [])) {
      keyboard.text(`${labels.attachment} ${truncate(file.name, 34)}`, `c:f:${sideCode[thread.side]}:${file.id}`).row();
    }
    if (thread.kind === "order" && this.webOrigin && (thread.side === "organizer" || ctx.guestSettings?.linked)) {
      const path = thread.side === "organizer" ? `/organizer/events/${thread.eventId}/purchases` : `/account/events/${thread.eventId}/orders/${thread.id}/chat`;
      keyboard.url(labels.orderChat + " ↗", new URL(path, this.webOrigin).href).row();
    }
    paginate(keyboard, ctx, index, Boolean(data.nextCursor), next => threadData(thread, next, scopedEvent));
    if (thread.closed && thread.side === "guest") keyboard.text(guest.tickets, "checkout:tickets").row();
    keyboard.append(this.back(ctx, `c:l:${sideCode[thread.side]}:1${scopedEvent ? `:${scopedEvent}` : ""}`));
    const title = [heading, `🎭 ${esc(truncate(thread.title, 140))}`, ...(thread.closed ? [labels.closed, ...(thread.side === "guest" ? [labels.closedHelp] : [])] : [])].join("\n\n");
    const text = [title, ...(messages.length ? messages : [labels.emptyThread])].join("\n\n");
    if (text.length < 3900) return privatePanel(ctx, text, keyboard);
    // Telegram limits message length. Keep the full thread text available, including to anonymous buyers.
    await ctx.reply([title, messages[0]].join("\n\n"), { protect_content: true, link_preview_options: { is_disabled: true }, ...HTML });
    await ctx.reply(messages.slice(1).join("\n\n"), { protect_content: true, reply_markup: keyboard, link_preview_options: { is_disabled: true }, ...HTML });
  }

  private async organizerAction(ctx: GuestContext, api: BotApiClient, actor: CheckoutActor, data: string) {
    const [, action, first, second, third] = data.split(":");
    const locale = guestLocale(ctx), labels = companionCopy[locale];
    if (action === "h") {
      await api.companion<BotOrganizerEvents>(actor, "events", { tab: "today", page: 1 });
      return privatePanel(ctx, `<b>${guestCopy[locale].organizer}</b>\n\n${labels.dashboardHint}`, new InlineKeyboard().text(labels.myEvents, "a:e:upcoming:1").row()
        .text(labels.inbox, "c:l:a:1").text(labels.updates, "a:u:upcoming:1").row().text(labels.switchHome, "guest:home"));
    }
    if ((action === "e" || action === "u") && isTab(first)) {
      return this.events(ctx, api, actor, first, page(second), action === "u");
    }
    if ((action === "s" || action === "b" || action === "f" || action === "v") && first && uuid.test(first)) {
      const snapshot = await api.companion<BotOrganizerSnapshot>(actor, `events/${first}`);
      if (action === "f") return this.prompt(ctx, actor, { side: "organizer", kind: "lookup", id: first });
      if (action === "v") {
        const c = updateCopy[locale], keyboard = new InlineKeyboard();
        for (const type of EVENT_NOTIFICATION_TYPES) keyboard.text(c.types[type], `u:t:${first}:${type}`).row();
        keyboard.text(c.history, `u:h:${first}:1`).row().append(this.back(ctx, "a:u:upcoming:1"));
        return privatePanel(ctx, `<b>${labels.updates}</b>\n🎭 ${esc(truncate(snapshot.event.title, 150))}\n\n${c.pickType}`, keyboard);
      }
      return this.snapshot(ctx, snapshot, action === "b" ? page(second) : undefined);
    }
    if (action === "o") {
      const eventId = expandId(first), orderId = expandId(second);
      if (eventId && orderId) {
        const order = await api.companion<BotOrganizerOrderDetail>(actor, `events/${eventId}/orders/${orderId}`, { page: page(third) });
        return this.order(ctx, order, page(third));
      }
      return;
    }
    if (action === "r" || action === "c") {
      const ticketId = expandId(first);
      if (!ticketId) return;
      if (action === "c") {
        if (!second || !verifyIntent(this.secret, actor, "resend", ticketId, second)) return privatePanel(ctx, labels.expired, this.back(ctx, "a:h"));
        const result = await api.companion<Delivery>(actor, `tickets/${ticketId}/resend`, { requestKey: requestId(["resend", actor.chatId, ticketId, second]) });
        return this.delivery(ctx, result);
      }
      const result = await api.companion<Delivery>(actor, `tickets/${ticketId}/resend`);
      const intent = signIntent(this.secret, actor, "resend", ticketId);
      return privatePanel(ctx, `${labels.resendConfirm}\n\n🎟 ${esc(truncate(result.label ?? "", 180))}`, new InlineKeyboard().text(labels.confirm, `a:c:${first}:${intent}`).row().append(this.back(ctx, orderData(result.eventId, result.orderId))));
    }
    if (action === "z" && first && uuid.test(first)) return this.delivery(ctx, await api.companion<Delivery>(actor, `resends/${first}`));
  }

  private async updateAction(ctx: GuestContext, api: BotApiClient, actor: CheckoutActor, data: string) {
    const [, action, target, value] = data.split(":");
    const locale = guestLocale(ctx), c = updateCopy[locale], labels = companionCopy[locale];
    if (action === "p") {
      const key = target === "r" ? "eventReminders" : target === "t" ? "transactionalTicketDelivery" : undefined;
      const state = await api.companion<NotificationPreferences>(actor, "preferences", key && (value === "1" || value === "0") ? { key, enabled: value === "1" } : undefined);
      const preference = (label: string, enabled: boolean) => `${label} · ${enabled ? c.on : c.off}`;
      const keyboard = new InlineKeyboard()
        .text(preference(c.reminders, state.eventReminders), `u:p:r:${state.eventReminders ? 0 : 1}`).row()
        .text(preference(c.tickets, state.transactionalTicketDelivery), `u:p:t:${state.transactionalTicketDelivery ? 0 : 1}`).row();
      return privatePanel(ctx, `<b>${c.preferences}</b>\n\n${c.critical}`, keyboard.append(this.back(ctx, "guest:profile")));
    }
    if (action === "m" && target && uuid.test(target)) {
      await api.companion(actor, `alerts/${target}/read`);
      // Open the inbox again using its normal navigation handler.
      await privatePanel(ctx, c.read, new InlineKeyboard().text(labels.alerts, `guest:alerts:${page(value)}`).row().append(this.back(ctx)));
      return;
    }
    if (action === "c") {
      const id = expandId(target);
      if (!id || !value || !/^[A-Za-z0-9_-]{20}$/.test(value)) return;
      const result = await api.companion<BotOperationalResult>(actor, `updates/${id}/confirm`, { review: value });
      if ("preview" in result) return this.updatePreview(ctx, result.preview, true);
      return privatePanel(ctx, this.updateStatus(result.delivery, locale), new InlineKeyboard()
        .text(labels.check, `u:h:${result.eventId}:1`).row().append(this.back(ctx, `a:v:${result.eventId}`)));
    }
    if (!target || !uuid.test(target)) return;
    if (action === "t") {
      const type = EVENT_NOTIFICATION_TYPES.find(type => type === value);
      if (!type) return;
      await api.companion(actor, `events/${target}`);
      return this.updatePrompt(ctx, actor, target, type);
    }
    if (action === "h") {
      const index = page(value);
      const result = await api.companion<{ items: EventNotificationStatus[]; hasNext: boolean }>(actor, `updates/${target}/history`, { page: index });
      const keyboard = new InlineKeyboard().text(labels.check, `u:h:${target}:${index}`).row();
      paginate(keyboard, ctx, index, result.hasNext, next => `u:h:${target}:${next}`);
      return privatePanel(ctx, [`<b>${c.history}</b>`, ...result.items.map(row => `<i>${row.createdAt.slice(0, 16).replace("T", " ")} UTC</i>
${esc(truncate(row.message, 200))}
${this.updateStatus(row, locale)}`),
        ...(!result.items.length ? [c.empty] : [])].join("\n\n"), keyboard.append(this.back(ctx, `a:v:${target}`)));
    }
  }

  private async updatePrompt(ctx: GuestContext, actor: CheckoutActor, id: string, type: EventNotificationType) {
    const c = updateCopy[guestLocale(ctx)], kind = `update_${type}`;
    const proof = signIntent(this.secret, actor, `compose.${kind}.a`, id);
    const prompt = `${c.types[type]}
${c.compose}`;
    const marker = `[tr:${kind}:a:${id}:${proof}]`;
    await ctx.reply(`${prompt}

${marker}`, { protect_content: true,
      entities: [{ type: "spoiler", offset: prompt.length + 2, length: marker.length }],
      reply_markup: { force_reply: true, selective: true },
    });
  }

  private async updatePreview(ctx: GuestContext, preview: BotOperationalPreview, changed = false) {
    const c = updateCopy[guestLocale(ctx)];
    return privatePanel(ctx, [`<b>${changed ? c.changed : c.preview}</b>`, `🏷 ${c.types[preview.type]}`, `<blockquote>${esc(preview.text)}</blockquote>`,
      `👥 ${c.eligible} ${preview.audienceCount} · 📱 ${c.reachable} ${preview.reachableCount}`].join("\n\n"),
    new InlineKeyboard().text(c.send, `u:c:${compactId(preview.id)}:${preview.review}`).row().append(this.back(ctx, `a:v:${preview.eventId}`)));
  }

  private updateStatus(row: EventNotificationStatus, locale: ReturnType<typeof guestLocale>) {
    const c = updateCopy[locale], labels = companionCopy[locale];
    const { queued, processing, accepted, failed, uncertain } = row.counts;
    return [`👥 ${c.eligible} ${row.audienceCount} · 📱 ${c.reachable} ${row.reachableCount}`, `<i>${labels.deliveryCounts}</i>`,
      [queued, processing, accepted, failed, uncertain].join(" · "), `${labels.inbox} · ${c.inboxRead} ${row.inboxReadCount ?? 0}`,
      ...(row.failureReasons?.length ? [row.failureReasons.map(reason => `${esc(reason.code)} ×${reason.count}`).join(" · ")] : []), c.accepted].join("\n");
  }

  private async events(ctx: GuestContext, api: BotApiClient, actor: CheckoutActor, tab: BotOrganizerTab, index: number, updates: boolean) {
    const locale = guestLocale(ctx), labels = companionCopy[locale];
    const data = await api.companion<BotOrganizerEvents>(actor, "events", { tab, page: index });
    const keyboard = new InlineKeyboard(), action = updates ? "u" : "e";
    for (const event of data.items) {
      keyboard.text(`${eventWhen(event.date, event.time, locale)} · ${truncate(event.title, 33)}`, `a:${updates ? "v" : "s"}:${event.id}`).row();
    }
    paginate(keyboard, ctx, index, data.hasNext, next => `a:${action}:${tab}:${next}`);
    for (const item of tabs) keyboard.text(`${item === tab ? "✓ " : ""}${labels[item]}`, `a:${action}:${item}:1`);
    keyboard.row().append(this.back(ctx, "a:h"));
    await privatePanel(ctx, [updates ? labels.chooseUpdate : `<b>${labels.myEvents}</b>`, ...(!data.items.length ? [labels.noEvents] : [])].join("\n\n"), keyboard);
  }

  private async snapshot(ctx: GuestContext, data: BotOrganizerSnapshot, breakdown?: number) {
    const locale = guestLocale(ctx), labels = companionCopy[locale];
    const { event, inventory, orders, attendance, buyers, money } = data;
    const keyboard = new InlineKeyboard();
    let lines: string[];
    if (breakdown) {
      const start = (breakdown - 1) * 8;
      lines = inventory.saleGroups.slice(start, start + 8).map(row =>
        `🎟 ${esc(truncate(row.name, 100))} · ${labels.units[row.unit]}\n${labels.sold} ${row.sold} · ${labels.remaining} ${row.buyable}${row.price === null ? "" : ` · 💰 ${cataloguePrice(row.price, row.currency, locale)}`}`);
      paginate(keyboard, ctx, breakdown, start + 8 < inventory.saleGroups.length, next => `a:b:${event.id}:${next}`);
      keyboard.append(this.back(ctx, `a:s:${event.id}`));
      await privatePanel(ctx, [`<b>${labels.breakdown}</b>\n🎭 ${esc(truncate(event.title, 150))}`, ...(lines.length ? lines : [labels.noBreakdown])].join("\n\n"), keyboard);
      return;
    }
    lines = [
      `<b>${labels.snapshot}</b>`, bold(truncate(event.title, 150)), `📅 ${esc(eventWhen(event.date, event.time, locale))} (${esc(event.timezone)}) · ${status(labels, snapshotStatus(event))}`, "",
      `🎟 ${labels.sold} ${inventory.soldAdmissions} ${labels.admission} · ${labels.remaining} ${inventory.buyableAdmissions} ${labels.admission}`,
      `🧾 ${labels.paid}: ${orders?.paid ?? labels.withheld}`,
      `👥 ${labels.registered} ${buyers.registered} · ${labels.anonymous} ${buyers.anonymousOrders}`,
      `✅ ${labels.checkins}: ${attendance.individualAttendanceKnown ? attendance.checkedInTickets : labels.withheld}`,
      ...(inventory.wholeTables.configured ? [`🪑 ${labels.group}: ${attendance.checkedInGroupPasses}`] : []), "",
      `💰 ${labels.gross}: <b>${totals(money.grossReceived, labels, locale)}</b>`,
      `↩️ ${labels.refunds}: ${money.completedRefunds ? orders?.completedRefunds ?? labels.withheld : labels.withheld}`,
      `💸 ${labels.refunded}: ${totals(money.completedRefunds, labels, locale)}`,
    ];
    keyboard.text(labels.breakdown, `a:b:${event.id}:1`).row().text(labels.findOrder, `a:f:${event.id}`).text(labels.eventInbox, `c:l:a:1:${event.id}`).row();
    keyboard.text(labels.updates, `a:v:${event.id}`);
    if (data.publicCard) keyboard.text(labels.openEvent, `event:${event.id}`);
    keyboard.row().append(this.back(ctx, "a:e:upcoming:1"));
    await privatePanel(ctx, lines.join("\n"), keyboard);
  }

  private async lookupResults(ctx: GuestContext, eventId: string, result: UpdateList) {
    const locale = guestLocale(ctx), labels = companionCopy[locale];
    const keyboard = new InlineKeyboard();
    const rows = result.items.map(order => {
      const title = `№${order.id.slice(0, 8)}${order.buyerName ? ` · ${truncate(order.buyerName, 35)}` : ""}`;
      keyboard.text(`🧾 ${title}`, orderData(eventId, order.id)).row();
      return `🧾 <b>${esc(title)}</b>\n${status(labels, order.payment.status)} · ${cataloguePrice(order.payment.amount, order.payment.currency, locale)}`;
    });
    keyboard.text(labels.findOrder, `a:f:${eventId}`).row().append(this.back(ctx, `a:s:${eventId}`));
    await privatePanel(ctx, [`<b>${labels.findOrder}</b>`, ...(rows.length ? rows : [labels.noOrders]), ...(result.hasNext ? [labels.refine] : [])].join("\n\n"), keyboard);
  }

  private async order(ctx: GuestContext, order: BotOrganizerOrderDetail, index: number) {
    const locale = guestLocale(ctx), labels = companionCopy[locale], keyboard = new InlineKeyboard();
    const items = order.tickets.map(ticket => {
      const name = truncate(ticket.seatLabel ?? ticket.typeName, 105);
      if (ticket.canResend) keyboard.text(`${labels.resend} · ${truncate(name, 28)}`, `a:r:${compactId(ticket.id)}`).row();
      return `🎟 ${esc(name)} · ${status(labels, ticket.status)}`;
    });
    paginate(keyboard, ctx, index, order.hasNext, next => orderData(order.eventId, order.id, next));
    keyboard.text(labels.orderChat, threadData({ side: "organizer", kind: "order", id: order.id }, 1, order.eventId)).row().append(this.back(ctx, `a:s:${order.eventId}`));
    const { resources, attendance, payment } = order;
    await privatePanel(ctx, [
      `🧾 <b>${labels.order} №${order.id.slice(0, 8)}</b>`, ...(order.buyerName ? [`👤 ${esc(truncate(order.buyerName, 100))}`] : []),
      `💰 ${status(labels, payment.status)} · ${cataloguePrice(payment.amount, payment.currency, locale)}`,
      `📦 ${resources.ticketCount} ${labels.units.tickets} · ${resources.allocatedSeatCount} ${labels.units.seats} · ${resources.wholeTableCount} ${labels.units.tables}`,
      `✅ ${labels.checkins}: ${attendance.checkedInTickets}/${attendance.totalTickets}`, "", ...items,
    ].join("\n"), keyboard);
  }

  private async delivery(ctx: GuestContext, data: Delivery) {
    const labels = companionCopy[guestLocale(ctx)], result = data.status;
    if (!result) return;
    const { queued, processing, accepted, failed, uncertain } = result.counts;
    const keyboard = new InlineKeyboard().text(labels.check, `a:z:${result.id}`).row().append(this.back(ctx, orderData(data.eventId, data.orderId)));
    await privatePanel(ctx, `<b>${labels.delivery} · ${status(labels, result.status)}</b>\n\n<i>${labels.deliveryCounts}</i>\n${[queued, processing, accepted, failed, uncertain].join(" · ")}`, keyboard);
  }

  private async prompt(ctx: GuestContext, actor: CheckoutActor, scope: ComposeScope) {
    const labels = companionCopy[guestLocale(ctx)], side = sideCode[scope.side];
    const intent = signIntent(this.secret, actor, `compose.${scope.kind}.${side}`, scope.id);
    const prompt = scope.kind === "lookup" ? labels.searchPrompt : labels.compose;
    const marker = `[tr:${scope.kind}:${side}:${scope.id}:${intent}]`;
    await ctx.reply(`${prompt}\n\n${marker}`, {
      protect_content: true,
      entities: [{ type: "spoiler", offset: prompt.length + 2, length: marker.length }],
      reply_markup: { force_reply: true, selective: true },
    });
  }

  private back(ctx: GuestContext, target = "guest:home") {
    const labels = guestCopy[guestLocale(ctx)];
    const keyboard = new InlineKeyboard();
    if (target !== "guest:home") keyboard.text(labels.back, target);
    return keyboard.text(labels.home, "guest:home");
  }
}

function orderData(eventId: string, orderId: string, index = 1) {
  return `a:o:${compactId(eventId)}:${compactId(orderId)}:${index}`;
}
function page(value?: string) { return value && /^(?:[1-9]\d{0,2}|1000)$/.test(value) ? Number(value) : 1; }
function isTab(value?: string): value is BotOrganizerTab { return (tabs as readonly string[]).includes(value ?? ""); }
function paginate(keyboard: InlineKeyboard, ctx: GuestContext, index: number, hasNext: boolean, target: (page: number) => string) {
  const labels = guestCopy[guestLocale(ctx)];
  if (index > 1) keyboard.text(labels.previous, target(index - 1));
  if (hasNext && index < 1000) keyboard.text(labels.next, target(index + 1));
  if (index > 1 || (hasNext && index < 1000)) keyboard.row();
}
function status(labels: CompanionCopy, key: string) {
  return (labels.statuses as Record<string, string>)[key] ?? labels.withheld;
}
function snapshotStatus(event: BotOrganizerSnapshot["event"]) {
  if (event.status === "cancelled" || event.status === "completed") return event.status;
  if (event.status === "published" && event.salesPaused) return "paused";
  if (event.moderationStatus === "pending") return "review";
  if (event.moderationStatus === "rejected") return "rejected";
  return event.status;
}
function totals(money: ManagementCurrencyMoney[] | null, labels: CompanionCopy, locale: ReturnType<typeof guestLocale>) {
  if (!money) return labels.withheld;
  return money.length ? money.map(row => cataloguePrice(row.amount, row.currency, locale)).join(" · ") : labels.none;
}
function errorText(labels: CompanionCopy, error: unknown) {
  const code = error instanceof BotApiError ? error.code : null;
  if (code === "CHAT_RATE_LIMITED" || code === "EVENT_UPDATE_DRAFT_LIMIT") return labels.slowDown;
  if (code === "EVENT_UPDATE_DRAFT_EXPIRED") return labels.expired;
  if (code === "INQUIRY_CLOSED") return `${labels.closed}\n${labels.closedHelp}`;
  if (code === "TICKET_NOT_ACTIVE" || code === "TICKET_DELIVERY_DISABLED" || code === "TELEGRAM_LINK_REQUIRED") return labels.deliverUnavailable;
  return labels.denied;
}
async function privatePanel(ctx: GuestContext, text: string, keyboard: InlineKeyboard) {
  const options = { reply_markup: keyboard, link_preview_options: { is_disabled: true }, ...HTML };
  const source = ctx.callbackQuery?.message;
  if (source && "text" in source && source.text && source.has_protected_content) {
    try { await ctx.editMessageText(text, options); return; }
    catch (error) { if (error instanceof Error && error.message.includes("message is not modified")) return; }
  }
  await ctx.reply(text, { ...options, protect_content: true });
}
