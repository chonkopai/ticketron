import { formatMoney } from "@event-platform/shared-types";
import type { BotCheckoutOffer, BotPaymentStatus, EventLocale } from "@event-platform/shared-types";
import { InlineKeyboard, type Context } from "grammy";
import { BotApiError, type BotApiClient } from "./api-client.js";
import { guestLocale as locale } from "./guest-copy.js";
import { HTML, bold, esc, escChunks, orderDot } from "./format.js";
import { privateActor as actor } from "./private-actor.js";

export const checkoutReference = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const confirmButton = new RegExp(`^confirm:(${checkoutReference})(?::([A-Za-z0-9_-]{12}))?$`);
const orderButton = new RegExp(`^(check|resume):(${checkoutReference})$`);
const ordersButton = /^orders:([1-9]\d{0,2}|1000)$/;

const copy = {
  en: {
    private: "🔒 Open a private chat with the bot to continue.", home: "🏠 Menu", back: "← Back", previous: "‹ Prev", next: "Next ›",
    review: "🛒 Check your order", confirm: "✅ Confirm purchase", terms: "↩️ Refund terms", noRefund: "Refunds are unavailable.", noTerms: "No additional refund terms.", freeTerms: "Free registration can be cancelled.",
    quoteExpiry: "⏱ Price held until", holdExpiry: "⏱ Pay before", updated: "⚠️ The offer changed. Please review the new details.",
    check: "🔄 Check status", resume: "💳 Continue payment", pay: "💳 Pay now", orders: "🧾 Orders", tickets: "🎟 My tickets", pendingOrders: "🧾 <b>Orders</b>\nSome orders are waiting for payment.", ordersTitle: "🧾 <b>Orders</b>", empty: "🧾 <b>Orders</b>\n\nNo orders yet.",
    permission: "🔒 Purchases are unavailable for this account.", expired: "⌛️ This offer or order has expired. Open the event again or check your orders.",
    unavailable: "😔 This option just sold out or is no longer available. Open the event to see what's left.",
    offerLimit: "⚠️ Too many open offers. Finish or wait a few minutes before starting a new one.",
    retry: "⚠️ We couldn't finish that. Check your orders before trying again so you don't pay twice.",
    status: { pending: "Awaiting payment", paid: "Confirmed", failed: "Payment failed", expired: "Payment time ran out", review_required: "Payment under review", cancelled: "Cancelled", refunded: "Refunded" },
  },
  ru: {
    private: "🔒 Чтобы продолжить, откройте личный чат с ботом.", home: "🏠 Меню", back: "← Назад", previous: "‹ Пред.", next: "Далее ›",
    review: "🛒 Проверьте заказ", confirm: "✅ Подтвердить покупку", terms: "↩️ Условия возврата", noRefund: "Возврат недоступен.", noTerms: "Дополнительных условий возврата нет.", freeTerms: "Бесплатную регистрацию можно отменить.",
    quoteExpiry: "⏱ Цена зафиксирована до", holdExpiry: "⏱ Оплатите до", updated: "⚠️ Условия изменились. Проверьте их ещё раз.",
    check: "🔄 Проверить статус", resume: "💳 Продолжить оплату", pay: "💳 Оплатить", orders: "🧾 Заказы", tickets: "🎟 Мои билеты", pendingOrders: "🧾 <b>Заказы</b>\nЕсть заказы, ожидающие оплаты.", ordersTitle: "🧾 <b>Заказы</b>", empty: "🧾 <b>Заказы</b>\n\nЗаказов пока нет.",
    permission: "🔒 Для этого аккаунта покупки недоступны.", expired: "⌛️ Предложение или заказ устарели. Откройте событие заново или проверьте заказы.",
    unavailable: "😔 Этот вариант уже раскупили или он недоступен. Откройте событие, чтобы посмотреть, что осталось.",
    offerLimit: "⚠️ Слишком много открытых предложений. Завершите их или подождите несколько минут, прежде чем начать новое.",
    retry: "⚠️ Не получилось. Проверьте заказы перед повторной попыткой, чтобы не оплатить дважды.",
    status: { pending: "Ожидает оплаты", paid: "Подтверждён", failed: "Оплата не прошла", expired: "Время оплаты истекло", review_required: "Оплата на проверке", cancelled: "Отменён", refunded: "Возврат оформлен" },
  },
  kk: {
    private: "🔒 Жалғастыру үшін ботпен жеке чат ашыңыз.", home: "🏠 Мәзір", back: "← Артқа", previous: "‹ Алдыңғы", next: "Келесі ›",
    review: "🛒 Тапсырысты тексеріңіз", confirm: "✅ Сатып алуды растау", terms: "↩️ Қайтару шарттары", noRefund: "Қайтару мүмкін емес.", noTerms: "Қайтарудың қосымша шарттары жоқ.", freeTerms: "Тегін тіркеуден бас тартуға болады.",
    quoteExpiry: "⏱ Баға бекітілген уақыт", holdExpiry: "⏱ Төлеу мерзімі", updated: "⚠️ Шарттар өзгерді. Қайта тексеріңіз.",
    check: "🔄 Күйін тексеру", resume: "💳 Төлемді жалғастыру", pay: "💳 Төлеу", orders: "🧾 Тапсырыстар", tickets: "🎟 Билеттерім", pendingOrders: "🧾 <b>Тапсырыстар</b>\nТөлем күтіп тұрған тапсырыстар бар.", ordersTitle: "🧾 <b>Тапсырыстар</b>", empty: "🧾 <b>Тапсырыстар</b>\n\nТапсырыстар әзірге жоқ.",
    permission: "🔒 Бұл аккаунт үшін сатып алу қолжетімсіз.", expired: "⌛️ Ұсыныс немесе тапсырыс ескірді. Іс-шараны қайта ашыңыз немесе тапсырыстарды тексеріңіз.",
    unavailable: "😔 Бұл нұсқа сатылып кетті немесе қолжетімсіз. Қалғанын көру үшін іс-шараны ашыңыз.",
    offerLimit: "⚠️ Ашық ұсыныстар тым көп. Жаңасын бастамас бұрын аяқтаңыз немесе бірнеше минут күтіңіз.",
    retry: "⚠️ Орындалмады. Екі рет төлемеу үшін қайталамас бұрын тапсырыстарды тексеріңіз.",
    status: { pending: "Төлем күтілуде", paid: "Расталды", failed: "Төлем өтпеді", expired: "Төлем уақыты өтті", review_required: "Төлем тексерілуде", cancelled: "Бас тартылды", refunded: "Ақша қайтарылды" },
  },
};

export async function buyFromChat(ctx: Context, api: BotApiClient, kind: "ticket" | "table", itemId: string, navigation?: string): Promise<void> {
  const recipient = actor(ctx);
  if (!recipient) { await ctx.reply(copy[locale(ctx)].private); return; }
  try {
    const offer = await api.checkoutOffer(recipient, ctx.from!.first_name, { kind, itemId, locale: locale(ctx) });
    await showOffer(ctx, offer, false, navigation);
  } catch (error) { await showError(ctx, error); }
}

export async function checkoutCallback(ctx: Context, api: BotApiClient, data: string): Promise<boolean> {
  const orders = ordersButton.exec(data);
  const detail = orderButton.exec(data);
  const confirm = confirmButton.exec(data);
  if (orders) await showCheckoutOrders(ctx, api, Number(orders[1]));
  else if (detail) await showCheckoutOrder(ctx, api, detail[2]!, detail[1] === "resume");
  else if (confirm) {
    const recipient = actor(ctx);
    const messageId = ctx.callbackQuery?.message?.message_id;
    if (!recipient || !messageId) { await ctx.reply(copy[locale(ctx)].private); return true; }
    try {
      const result = await api.confirmCheckout(recipient, confirm[1]!, messageId);
      if ("offer" in result) await showOffer(ctx, result.offer, true, confirm[2]);
      else await showOrder(ctx, result.order);
    } catch (error) { await showError(ctx, error); }
  } else if (data.startsWith("confirm:")) await showError(ctx, new BotApiError(409, "BOT_OFFER_EXPIRED"));
  else return false;
  return true;
}

export async function showCheckoutOrders(ctx: Context, api: BotApiClient, page = 1): Promise<void> {
  const recipient = actor(ctx);
  const labels = copy[locale(ctx)];
  if (!recipient) { await ctx.reply(labels.private); return; }
  try {
    const { items, hasNext } = await api.checkoutOrders(recipient, page);
    const keyboard = new InlineKeyboard();
    for (const order of items) keyboard.text(`${orderDot[order.status] ?? "•"} ${order.title.slice(0, 40)} · ${labels.status[order.status]}`, `check:${order.orderId}`).row();
    if (page > 1) keyboard.text(labels.previous, `orders:${page - 1}`);
    if (hasNext && page < 1000) keyboard.text(labels.next, `orders:${page + 1}`);
    if (page > 1 || (hasNext && page < 1000)) keyboard.row();
    keyboard.text(labels.home, "guest:home");
    await navigate(ctx, !items.length ? labels.empty : items.some(order => order.status === "pending") ? labels.pendingOrders : labels.ordersTitle, keyboard);
  } catch (error) { await showError(ctx, error); }
}

export async function showCheckoutOrder(ctx: Context, api: BotApiClient, id: string, resume = false): Promise<void> {
  const recipient = actor(ctx);
  if (!recipient) { await ctx.reply(copy[locale(ctx)].private); return; }
  try {
    await showOrder(ctx, await api.checkoutOrder(recipient, id, resume), true);
  } catch (error) { await showError(ctx, error); }
}

async function showOffer(ctx: Context, offer: BotCheckoutOffer, updated = false, navigation?: string): Promise<void> {
  const lang = locale(ctx);
  const labels = copy[lang];
  const terms = offer.refundTerms || (offer.amountDue === 0 ? labels.freeTerms : offer.refundsAvailable === false ? labels.noRefund : labels.noTerms);
  const head = [
    ...(updated ? [labels.updated, ""] : []), `<b>${labels.review}</b>`, "",
    `🎭 ${bold(offer.title)}`, `🎟 ${esc(offer.itemName)}`, `💰 <b>${esc(amount(offer, lang))}</b>`, "",
    `${labels.quoteExpiry} ${esc(expiry(offer.expiresAt, lang, offer.timezone))}`, "", `<b>${labels.terms}</b>`,
  ].join("\n");
  const suffix = navigation ? `:${navigation}` : "";
  const keyboard = new InlineKeyboard().text(labels.confirm, `confirm:${offer.reference}${suffix}`).row()
    .text(labels.back, navigation ? `n:${navigation}:open` : `event:${offer.eventId}`).text(labels.home, "guest:home");
  // Long terms go first as their own messages so the summary and the Confirm button stay together at the bottom.
  const chunks = escChunks(terms, 1800);
  const last = chunks.pop() ?? "";
  for (const chunk of chunks) await ctx.reply(chunk, HTML);
  await ctx.reply(`${head}\n${last}`, { reply_markup: keyboard, ...HTML });
}

async function showOrder(ctx: Context, order: BotPaymentStatus, edit = false): Promise<void> {
  const lang = locale(ctx);
  const labels = copy[lang];
  const keyboard = new InlineKeyboard();
  if (order.status === "pending") {
    if (order.paymentLink) keyboard.url(labels.pay, order.paymentLink).row();
    else keyboard.text(labels.resume, `resume:${order.orderId}`).row();
    keyboard.text(labels.check, `check:${order.orderId}`).row();
  }
  if (["paid", "refunded", "cancelled"].includes(order.status)) keyboard.text(labels.tickets, `w:o:${order.orderId}:1`).row();
  keyboard.text(labels.orders, "orders:1").text(labels.home, "guest:home");
  const lines = [bold(order.title), "", `${orderDot[order.status] ?? "•"} <b>${labels.status[order.status]}</b>`, `💰 ${esc(amount(order, lang))}`];
  if (order.status === "pending" && order.expiresAt) lines.push(`${labels.holdExpiry} ${esc(expiry(order.expiresAt, lang, order.timezone))}`);
  if (edit) await navigate(ctx, lines.join("\n"), keyboard);
  else await ctx.reply(lines.join("\n"), { reply_markup: keyboard, ...HTML });
}

async function showError(ctx: Context, error: unknown): Promise<void> {
  const labels = copy[locale(ctx)];
  const code = error instanceof BotApiError ? error.code : undefined;
  const message = code === "ACCOUNT_RESTRICTED" ? labels.permission
    : code === "BOT_OFFER_LIMIT" ? labels.offerLimit
    : ["BOT_OFFER_EXPIRED", "QUICK_ACCESS_INVALID", "BOT_ORDER_NOT_FOUND"].includes(code ?? "") ? labels.expired
    : ["BOT_ITEM_UNAVAILABLE", "EVENT_ENDED", "EVENT_SALES_PAUSED", "EVENT_NOT_PUBLISHED", "INSUFFICIENT_INVENTORY",
      "TABLE_UNAVAILABLE", "TICKET_TYPE_NOT_ON_SALE", "TICKET_TYPE_NOT_FOUND", "TABLE_NOT_FOUND", "EVENT_NOT_FOUND"].includes(code ?? "") ? labels.unavailable
    : labels.retry;
  await ctx.reply(message, { reply_markup: new InlineKeyboard().text(labels.orders, "orders:1").text(labels.home, "guest:home") });
}

async function navigate(ctx: Context, text: string, keyboard: InlineKeyboard): Promise<void> {
  // Keep offer messages and delivery anchors intact. Only edit existing status/list views.
  if (ctx.callbackQuery?.message && /^(?:orders|check|resume):/.test(ctx.callbackQuery.data ?? "")) {
    try { await ctx.editMessageText(text, { reply_markup: keyboard, ...HTML }); return; }
    catch (error) { if (error instanceof Error && error.message.includes("message is not modified")) return; }
  }
  await ctx.reply(text, { reply_markup: keyboard, ...HTML });
}

function amount(value: Pick<BotPaymentStatus, "amountDue" | "currency">, lang: EventLocale): string {
  return formatMoney(value.amountDue, value.currency, lang, { currencyDisplay: "code" });
}

function expiry(value: string, lang: EventLocale, timezone: string): string {
  return new Intl.DateTimeFormat(lang, { timeZone: timezone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }).format(new Date(value));
}
