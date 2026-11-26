import type { BotAdmissionKind, BotReturnKind, BotWalletEvent, BotWalletList, BotWalletOrder, EventLocale } from "@event-platform/shared-types";
import { InlineKeyboard, InputFile } from "grammy";
import { BotApiError, type BotApiClient, type CheckoutActor } from "./api-client.js";
import { checkoutReference } from "./checkout.js";
import { companionCopy } from "./companion-copy.js";
import { threadData } from "./companion-reference.js";
import { guestCopy, guestLocale, type GuestContext } from "./guest-copy.js";
import { cataloguePrice, formatTicketStatus, truncate } from "./presentation.js";
import { HTML, bold, esc, escChunks, orderDot } from "./format.js";

const tabs = { u: "upcoming", p: "past", n: "pending" } as const;
type Tab = keyof typeof tabs;
const uuid = new RegExp(`^${checkoutReference}$`);
const copy = {
  en: {
    tabs: { u: "Upcoming", p: "Past", n: "Unpaid" }, nextQr: "📱 Show next QR", qr: "📱 Show QR", group: "Group pass", table: "Table", empty: "📭 Nothing here yet.\nTickets you buy will appear here with their QR codes.",
    check: "🔄 Check status", resume: "💳 Continue payment", cancel: "↩️ Return", confirm: "✅ Confirm return", terms: "↩️ <b>Return terms</b>",
    noTerms: "No additional cancellation terms were recorded.", cancelled: "✅ Return recorded.", refundPending: "↩️ Refund: awaiting review",
    claim: "👤 Add to my account", claimTip: "👤 Sign in with this same Telegram account to add the purchase to your profile.", linked: "✅ Purchase added to your account.",
    help: "🆘 Help", helpTitle: "🆘 <b>Help with your order</b>", helpHint: "Share this order number with support:", reference: "Order", updates: "📣 <b>Event updates</b>", unavailable: "😔 This purchase or action is no longer available.",
    status: { pending: "Awaiting payment", paid: "Confirmed", refunded: "Refunded", failed: "Payment failed", expired: "Expired", cancelled: "Cancelled", review_required: "Payment under review" },
    refund: { awaiting_review: "Awaiting review", requested: "Requested", processing: "Processing", succeeded: "Completed", failed: "Failed" }, refundLabel: "Refund",
  },
  ru: {
    tabs: { u: "Предстоящие", p: "Прошедшие", n: "Не оплачены" }, nextQr: "📱 Показать ближайший QR", qr: "📱 Показать QR", group: "Групповой пропуск", table: "Столик", empty: "📭 Здесь пока пусто.\nКупленные билеты появятся здесь вместе с QR-кодами.",
    check: "🔄 Проверить статус", resume: "💳 Продолжить оплату", cancel: "↩️ Вернуть", confirm: "✅ Подтвердить возврат", terms: "↩️ <b>Условия возврата</b>",
    noTerms: "Дополнительные условия отмены не указаны.", cancelled: "✅ Возврат оформлен.", refundPending: "↩️ Возврат денег: на рассмотрении",
    claim: "👤 Добавить в профиль", claimTip: "👤 Войдите через этот же Telegram, чтобы добавить покупку в профиль.", linked: "✅ Покупка добавлена в ваш аккаунт.",
    help: "🆘 Помощь", helpTitle: "🆘 <b>Помощь с заказом</b>", helpHint: "Назовите поддержке номер заказа:", reference: "Заказ", updates: "📣 <b>Новости события</b>", unavailable: "😔 Эта покупка или действие больше недоступны.",
    status: { pending: "Ожидает оплаты", paid: "Подтверждён", refunded: "Возвращён", failed: "Оплата не прошла", expired: "Срок истёк", cancelled: "Отменён", review_required: "Оплата на проверке" },
    refund: { awaiting_review: "На рассмотрении", requested: "Запрошен", processing: "В обработке", succeeded: "Выполнен", failed: "Не выполнен" }, refundLabel: "Возврат",
  },
  kk: {
    tabs: { u: "Алдағы", p: "Өткен", n: "Төленбеген" }, nextQr: "📱 Жақын QR-кодты көрсету", qr: "📱 QR-кодты көрсету", group: "Топтық рұқсат", table: "Үстел", empty: "📭 Әзірге бос.\nСатып алған билеттеріңіз QR-кодтарымен осында шығады.",
    check: "🔄 Күйін тексеру", resume: "💳 Төлемді жалғастыру", cancel: "↩️ Қайтару", confirm: "✅ Қайтаруды растау", terms: "↩️ <b>Қайтару шарттары</b>",
    noTerms: "Бас тартудың қосымша шарттары көрсетілмеген.", cancelled: "✅ Қайтару рәсімделді.", refundPending: "↩️ Ақшаны қайтару: қаралуда",
    claim: "👤 Профильге қосу", claimTip: "👤 Сатып алуды профильге қосу үшін осы Telegram аккаунтымен кіріңіз.", linked: "✅ Сатып алу аккаунтыңызға қосылды.",
    help: "🆘 Көмек", helpTitle: "🆘 <b>Тапсырыс бойынша көмек</b>", helpHint: "Қолдау қызметіне тапсырыс нөмірін айтыңыз:", reference: "Тапсырыс", updates: "📣 <b>Іс-шара жаңалықтары</b>", unavailable: "😔 Бұл сатып алу немесе әрекет енді қолжетімсіз.",
    status: { pending: "Төлем күтілуде", paid: "Расталды", refunded: "Ақша қайтарылды", failed: "Төлем өтпеді", expired: "Мерзімі өтті", cancelled: "Бас тартылды", review_required: "Төлем тексерілуде" },
    refund: { awaiting_review: "Қаралуда", requested: "Сұралды", processing: "Өңделуде", succeeded: "Аяқталды", failed: "Орындалмады" }, refundLabel: "Ақшаны қайтару",
  },
};

export class TicketWallet {
  constructor(private readonly webOrigin?: string, private readonly messagesEnabled = true) {}

  async show(ctx: GuestContext, api: BotApiClient): Promise<void> {
    await this.run(ctx, (actor) => this.list(ctx, api, actor, "u", 1));
  }

  async eventDay(ctx: GuestContext, api: BotApiClient, id: string): Promise<void> {
    await this.run(ctx, (actor) => this.event(ctx, api, actor, id, 1));
  }

  async callback(ctx: GuestContext, api: BotApiClient, data: string): Promise<boolean> {
    if (!data.startsWith("w:")) return false;
    const [, action, value, parameter, proof] = data.split(":");
    await this.run(ctx, async (actor) => {
      const page = Number(parameter);
      if (action === "l" && value && Object.hasOwn(tabs, value) && validPage(page)) {
        await this.list(ctx, api, actor, value as Tab, page);
      } else if ((action === "o" || action === "e") && value && uuid.test(value) && validPage(page)) {
        if (action === "o") await this.order(ctx, api, actor, value, page);
        else await this.event(ctx, api, actor, value, page);
      } else if (action === "q" && (value === "t" || value === "g") && parameter && uuid.test(parameter)) {
        const image = await api.walletQr(actor, value === "t" ? "ticket" : "group", parameter);
        await ctx.replyWithPhoto(new InputFile(image, "ticket.png"), {
          caption: guestCopy[guestLocale(ctx)].qr, protect_content: true, reply_markup: this.navigation(ctx),
        });
      } else if ((action === "r" || action === "c") && (value === "t" || value === "b") && parameter && uuid.test(parameter)) {
        const kind = value === "t" ? "ticket" : "booking";
        if (action === "r") await this.preview(ctx, api, actor, kind, parameter);
        else if (proof) {
          const result = await api.walletConfirmReturn(actor, kind, parameter, proof);
          const labels = copy[guestLocale(ctx)];
          await this.panel(ctx, [`<b>${labels.cancelled}</b>`, result.refundPending ? labels.refundPending : ""].filter(Boolean).join("\n\n"), this.navigation(ctx));
        }
      } else if ((action === "claim" || action === "help") && value && uuid.test(value)) {
        if (action === "claim") await this.claim(ctx, api, actor, value);
        else {
          await api.walletOrder(actor, guestLocale(ctx), value, 1);
          const labels = copy[guestLocale(ctx)];
          const keyboard = this.navigation(ctx);
          if (this.webOrigin) keyboard.row().url(guestCopy[guestLocale(ctx)].support, new URL("/account?tab=support", this.webOrigin).href);
          await this.panel(ctx, `${labels.helpTitle}\n\n${labels.helpHint}\n<code>${value}</code>`, keyboard);
        }
      }
    });
    return true;
  }

  private async list(ctx: GuestContext, api: BotApiClient, actor: CheckoutActor, tab: Tab, page: number): Promise<void> {
    const locale = guestLocale(ctx), labels = copy[locale], guest = guestCopy[locale];
    const result = await api.walletEvents(actor, locale, tabs[tab], page);
    const keyboard = new InlineKeyboard();
    addQr(keyboard, result.nextQr, labels.nextQr);
    for (const event of result.items) {
      keyboard.text(`🎭 ${truncate(event.title, 40)} · ${formatDate(event, locale, true)}`, `w:e:${event.id}:1`).row();
    }
    this.pagination(keyboard, locale, `w:l:${tab}`, page, result.hasNext);
    for (const [key, text] of Object.entries(labels.tabs)) keyboard.text(key === tab ? `✅ ${text}` : text, `w:l:${key}:1`);
    keyboard.row();
    if (!result.items.length && tab === "u") keyboard.text(guest.find, "guest:find").row();
    keyboard.text(guest.home, "guest:home");
    await this.panel(ctx, `<b>${guest.tickets}</b> · ${labels.tabs[tab]}${result.items.length ? "" : `\n\n${labels.empty}`}`, keyboard);
  }

  private async event(ctx: GuestContext, api: BotApiClient, actor: CheckoutActor, id: string, page: number): Promise<void> {
    const locale = guestLocale(ctx), labels = copy[locale], guest = guestCopy[locale];
    const result = await api.walletEvent(actor, locale, id, page);
    const keyboard = new InlineKeyboard();
    addQr(keyboard, result.nextQr, labels.qr);
    for (const order of result.orders) {
      keyboard.text(`${orderDot[order.status] ?? "•"} ${labels.reference} ${order.id.slice(0, 8)} · ${labels.status[order.status]}`, `w:o:${order.id}:1`).row();
    }
    this.pagination(keyboard, locale, `w:e:${id}`, page, result.hasNext);
    const directions = new URL("https://www.google.com/maps/search/");
    directions.searchParams.set("api", "1");
    directions.searchParams.set("query", result.event.address);
    if (result.event.address) keyboard.url(guest.directions, directions.href);
    if (result.orders[0]) keyboard.text(labels.help, `w:help:${result.orders[0].id}`);
    if (result.event.address || result.orders[0]) keyboard.row();
    keyboard.append(this.navigation(ctx));
    const updates = result.updates.map(text => `• ${esc(truncate(text, 330))}`);
    await this.panel(ctx, [eventText(result.event, locale), ...(updates.length ? [labels.updates, ...updates] : [])].join("\n\n"), keyboard);
  }

  private async order(ctx: GuestContext, api: BotApiClient, actor: CheckoutActor, id: string, page: number): Promise<void> {
    const locale = guestLocale(ctx), labels = copy[locale], guest = guestCopy[locale];
    const result = await api.walletOrder(actor, locale, id, page);
    const { order, booking } = result;
    const keyboard = new InlineKeyboard();
    if (order.status === "pending") keyboard.text(labels.resume, `resume:${id}`).text(labels.check, `check:${id}`).row();
    if (order.status === "review_required") keyboard.text(labels.check, `check:${id}`).row();
    if (booking?.returnAvailable) keyboard.text(`${labels.cancel} · ${labels.table}`, `w:r:b:${booking.id}`).row();
    const lines = result.admissions.map(item => {
      const name = item.kind === "group" ? `${labels.group} · ${item.name}` : item.name;
      const label = truncate([name, item.seatLabel && item.seatLabel !== item.name ? item.seatLabel : ""].filter(Boolean).join(" · "), 125);
      if (item.qrAvailable) keyboard.text(`📱 ${truncate(label, 40)}`, `w:q:${admissionCode(item.kind)}:${item.id}`);
      if (item.returnAvailable) keyboard.text(`${labels.cancel} · ${truncate(label, 27)}`, `w:r:t:${item.id}`);
      if (item.qrAvailable || item.returnAvailable) keyboard.row();
      return `🎟 ${esc(label)} · ${formatTicketStatus(item.status, locale)}`;
    });
    this.pagination(keyboard, locale, `w:o:${id}`, page, result.hasNext);
    if (order.canClaim && (this.webOrigin || ctx.guestSettings?.linked)) keyboard.text(labels.claim, `w:claim:${id}`).row();
    if (this.messagesEnabled) keyboard.text(companionCopy[locale].orderChat, threadData({ side: "guest", kind: "order", id })).row();
    keyboard.text(labels.help, `w:help:${id}`).text(guest.back, `w:e:${result.event.id}:1`).row().append(this.navigation(ctx));
    const orderLines = [eventText(result.event, locale), "", `🧾 <b>${labels.reference} ${id.slice(0, 8)}</b> · ${orderDot[order.status] ?? "•"} ${labels.status[order.status]}`];
    if (order.amount !== null) orderLines.push(`💰 ${esc(cataloguePrice(order.amount, order.currency, locale))}`);
    if (order.cancellation && order.status !== "cancelled") orderLines.push(labels.cancelled);
    if (order.refund) orderLines.push(`↩️ ${labels.refundLabel} · ${labels.refund[order.refund]}`);
    if (booking) orderLines.push(`🪑 ${labels.table} · ${esc(truncate(booking.label, 95))} · ${booking.status === "confirmed" ? labels.status.paid : labels.status[booking.status as BotWalletOrder["status"]] ?? esc(booking.status)}`);
    await this.panel(ctx, [...orderLines, ...(lines.length ? ["", ...lines] : [])].join("\n"), keyboard);
  }

  private async preview(ctx: GuestContext, api: BotApiClient, actor: CheckoutActor, kind: BotReturnKind, id: string): Promise<void> {
    const locale = guestLocale(ctx), labels = copy[locale];
    const quote = await api.walletReturn(actor, kind, id);
    const terms = quote.acceptedPolicy?.conditions ?? quote.cancellationTerms ?? labels.noTerms;
    const keyboard = new InlineKeyboard().text(labels.confirm, `w:c:${kind === "ticket" ? "t" : "b"}:${id}:${quote.proof}`).row().append(this.navigation(ctx));
    const chunks = escChunks(terms, 1700);
    const last = chunks.pop() ?? esc(labels.noTerms);
    for (const chunk of chunks) await ctx.reply(chunk, { protect_content: true, ...HTML });
    await ctx.reply(`🎟 ${bold(truncate(quote.label, 180))}\n💰 ${esc(cataloguePrice(quote.amountPaid, quote.currency, locale))}\n\n${labels.terms}\n${last}`, { protect_content: true, reply_markup: keyboard, ...HTML });
  }

  private async claim(ctx: GuestContext, api: BotApiClient, actor: CheckoutActor, id: string): Promise<void> {
    const { linked } = await api.walletClaim(actor, id);
    const labels = copy[guestLocale(ctx)], keyboard = this.navigation(ctx);
    if (!linked && this.webOrigin) {
      const url = new URL("/login", this.webOrigin);
      url.searchParams.set("returnTo", "/account?tab=tickets");
      url.searchParams.set("lang", guestLocale(ctx));
      keyboard.row().url(labels.claim, url.href);
    }
    await this.panel(ctx, linked ? labels.linked : labels.claimTip, keyboard);
  }

  private async run(ctx: GuestContext, action: (actor: CheckoutActor) => Promise<void>): Promise<void> {
    if (ctx.chat?.type !== "private" || ctx.from?.id !== ctx.chat.id) {
      await ctx.reply(guestCopy[guestLocale(ctx)].private);
      return;
    }
    try { await action({ telegramId: String(ctx.from.id), chatId: String(ctx.chat.id) }); }
    catch (error) {
      const locale = guestLocale(ctx);
      const message = error instanceof BotApiError && error.message.startsWith("BOT_API_4") ? copy[locale].unavailable : guestCopy[locale].unavailable;
      await ctx.reply(message, { reply_markup: this.navigation(ctx), protect_content: true });
    }
  }

  private navigation(ctx: GuestContext): InlineKeyboard {
    const guest = guestCopy[guestLocale(ctx)];
    return new InlineKeyboard().text(guest.tickets, "w:l:u:1").text(guest.home, "guest:home");
  }

  private pagination(keyboard: InlineKeyboard, locale: EventLocale, prefix: string, page: number, hasNext: boolean): void {
    const labels = guestCopy[locale];
    if (page > 1) keyboard.text(labels.previous, `${prefix}:${page - 1}`);
    if (hasNext && page < 1000) keyboard.text(labels.next, `${prefix}:${page + 1}`);
    if (page > 1 || (hasNext && page < 1000)) keyboard.row();
  }

  private async panel(ctx: GuestContext, text: string, keyboard: InlineKeyboard): Promise<void> {
    const message = ctx.callbackQuery?.message;
    const options = { reply_markup: keyboard, link_preview_options: { is_disabled: true }, ...HTML };
    // New wallet messages are protected, so the first wallet action should send
    // a fresh message instead of editing a forwardable Home or checkout screen.
    if (message && "text" in message && message.text && message.has_protected_content) {
      try { await ctx.editMessageText(text, options); return; }
      catch (error) { if (error instanceof Error && error.message.includes("message is not modified")) return; }
    }
    await ctx.reply(text, { ...options, protect_content: true });
  }
}

function addQr(keyboard: InlineKeyboard, qr: BotWalletList["nextQr"], label: string): void {
  if (qr) keyboard.text(label, `w:q:${admissionCode(qr.kind)}:${qr.id}`).row();
}
function admissionCode(kind: BotAdmissionKind) { return kind === "group" ? "g" : "t"; }
function validPage(page: number) { return Number.isSafeInteger(page) && page >= 1 && page <= 1000; }
function formatDate(event: BotWalletEvent, locale: EventLocale, short = false): string {
  return new Intl.DateTimeFormat(locale, { timeZone: event.timezone, month: "short", day: "numeric",
    ...(short ? {} : { year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }),
  }).format(new Date(event.startsAt));
}
function eventText(event: BotWalletEvent, locale: EventLocale): string {
  return [bold(truncate(event.title, 180)), `📅 ${esc(formatDate(event, locale))}`, event.address ? `📍 ${esc(truncate(event.address, 200))}` : "",
    event.status === "cancelled" ? `⚪️ ${copy[locale].status.cancelled}` : ""].filter(Boolean).join("\n");
}
