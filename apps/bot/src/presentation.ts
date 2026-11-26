import type {
  BotIdentityResponse,
  PublicEvent,
  PublicEventSummary,
  PublicPaymentOption,
  EventLocale,
} from "@event-platform/shared-types";
import { localizedCityName, ru, richDescriptionBody, minorToMajor } from "@event-platform/shared-types";
import { convert } from "html-to-text";
import { guestCopy } from "./guest-copy.js";
import { bold, esc, eventWhen, saleDot } from "./format.js";

export type BotRole = BotIdentityResponse["user"]["role"];

const ticketStatusLabels: Record<string, string> = {
  created: "Создан",
  pending_payment: "Ожидает оплаты",
  paid: "Оплачен",
  active: "Действителен",
  used: "Использован",
  cancelled: "Отменён",
  refunded: "Возвращён",
};

const localizedTicketStatus: Record<EventLocale, Record<string, string>> = {
  ru: ticketStatusLabels,
  en: { created: "Created", pending_payment: "Awaiting payment", paid: "Paid", active: "Valid", used: "Used", cancelled: "Cancelled", refunded: "Refunded" },
  kk: { created: "Жасалды", pending_payment: "Төлем күтілуде", paid: "Төленді", active: "Жарамды", used: "Пайдаланылды", cancelled: "Бас тартылды", refunded: "Ақша қайтарылды" },
};

export function formatTicketStatus(status: string, locale: EventLocale = "ru"): string {
  return localizedTicketStatus[locale][status] ?? status;
}

export function formatWelcome(role: BotRole = "guest"): string {
  return `${ru.bot.welcomeIntro}\n\n${ru.bot.commandsTitle}\n${formatCommandList(role)}`;
}

export function formatHelp(role: BotRole = "guest"): string {
  return `${ru.bot.helpIntro}\n\n${formatCommandList(role)}`;
}

export function formatCommandList(role: BotRole = "guest"): string {
  const commands: string[] = [
    ru.bot.commands.events,
    ru.bot.commands.search,
    ru.bot.commands.tickets,
    ru.bot.commands.help,
  ];
  if (role === "organizer" || role === "admin") {
    commands.push(ru.bot.organizerCommands.today, ru.bot.organizerCommands.notify, ru.bot.organizerCommands.chat);
  }
  return commands.join("\n");
}

export function formatEventList(events: readonly PublicEventSummary[]): string {
  return events.map(formatEventSummary).join(`\n\n${ru.bot.eventSeparator}\n\n`);
}

export function formatEventSummary(event: PublicEventSummary): string {
  const price = event.startingPrices.length > 1
    ? event.startingPrices.map((item) => `${formatStartingPrice(event.paymentMode, item.amount, item.currency)}${item.unit === "table" ? " за стол" : item.unit === "seat" ? " за место" : " за билет"}`).join("\n")
    : event.startingAmount === null
    ? (["sold_out", "sales_ended", "temporarily_unavailable"].includes(event.saleStatus) ? ru.publicEvent.saleStatuses[event.saleStatus] : ru.bot.priceUnavailable)
    : `${formatStartingPrice(event.paymentMode, event.startingAmount, event.startingCurrency)}${event.startingUnit === "table" ? " за стол" : event.startingUnit === "seat" ? " за место" : " за билет"}`;
  return [
    `🎫 ${truncate(event.title, 180)}`,
    `${event.date} ${event.time} (${event.timezone})`,
    `${truncate(event.address, 180)}`,
    price,
  ].join("\n");
}

export function formatEventDetails(event: PublicEvent, hasSeatSelection = false): string {
  const lines = [
    `🎫 ${truncate(event.title, 200)}`,
    `${event.date} ${event.time} (${event.timezone})`,
    `${truncate(event.address, 220)}`,
  ];
  if (event.description) {
    lines.push(`\n${truncate(eventText(event.description), 700)}`);
  }

  if (event.paymentMode === "deposit") return [...lines, "", "Новые продажи приостановлены. Существующие покупки сохраняют первоначальные суммы и условия."].join("\n");

  const options = [
    ...event.ticketTypes.map((ticket) => formatPaymentOption(ticket.name, ticket.payment, ticket.status === "active" && ticket.remaining > 0 ? `${ticket.remaining} ${ru.bot.availableTickets}` : ru.bot.soldOut)),
    ...event.tables.filter((table) => table.saleMode === "whole_table").map((table) => formatPaymentOption(`${ru.bot.tablePrice} ${table.name ?? table.number}`, table.payment, table.availability === "available" ? ru.bot.availableTables : ru.bot.soldOut)),
  ];
  if (hasSeatSelection) options.push("Места по схеме: выберите конкретное место на сайте, затем подтвердите покупку через Telegram.");
  lines.push("", options.length ? options.join("\n\n") : ru.bot.priceUnavailable);
  return lines.join("\n");
}

export function formatPaymentOption(name: string, payment: PublicPaymentOption, availability?: string): string {
  const label = payment.mode === "deposit" ? ru.bot.depositPrice : ru.bot.fullPaymentPrice;
  const lines = [`${name}`, `${label}: ${formatAmount(payment.amountDue, payment.currency)}`];
  if (payment.mode === "deposit" && payment.fullAmount !== null) {
    lines.push(`${ru.bot.fullAmount}: ${formatAmount(payment.fullAmount, payment.currency)}`);
  }
  if (availability) lines.push(`${ru.bot.remainingLabel}: ${availability}`);
  return lines.join("\n");
}

export function formatStartingPrice(mode: "deposit" | "full_payment", amount: number, currency: string | null): string {
  const label = mode === "deposit" ? ru.bot.depositPrice : ru.bot.fullPaymentPrice;
  if (amount === 0) return `${label}: ${ru.bot.free}`;
  return `${label}: ${ru.bot.from} ${formatAmount(amount, currency ?? "KZT")}`;
}

export function formatAmount(amount: number, currency: string): string {
  if (amount === 0) return ru.bot.free;
  const formatted = minorToMajor(amount, currency).toLocaleString("ru-RU").replace(/[\u00a0\u202f]/g, " ");
  return `${formatted} ${currency.trim()}`;
}

export function truncate(value: string, max: number): string {
  const normalized = value.trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, "").trimEnd()}…`;
}

export function eventText(value: string): string {
  const body = richDescriptionBody(value);
  return body === null ? value : convert(body, {
    wordwrap: false,
    selectors: [{ selector: "h1", options: { uppercase: false } }, { selector: "h2", options: { uppercase: false } }, { selector: "a", options: { hideLinkHrefIfSameAsText: true } }, { selector: "img", format: "skip" }, { selector: "script", format: "skip" }, { selector: "style", format: "skip" }],
  });
}

export function cataloguePrice(amount: number, currency: string, locale: EventLocale): string {
  const formatted = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(minorToMajor(amount, currency));
  return amount === 0 ? guestCopy[locale].free : `${formatted} ${currency}`;
}

export function catalogueEvent(event: PublicEventSummary, locale: EventLocale, full = false, closed?: "ended" | "paused", index?: number): string {
  const copy = guestCopy[locale];
  const prices = event.startingPrices.slice(0, 3).map(price => {
    const value = cataloguePrice(price.amount, price.currency, locale);
    // Kazakh puts "бастап" after the amount.
    const from = !price.amount ? value : locale === "kk" ? `${value} ${copy.from}` : `${copy.from} ${value}`;
    return `${from} / ${copy[price.unit]}`;
  });
  if (event.startingPrices.length > 3) prices.push(`+${event.startingPrices.length - 3} ${copy.more.toLowerCase()}`);
  const place = [localizedCityName(event.city, locale, event.countryCode), ...(full ? [event.address] : [])].filter(Boolean).join(" · ");
  const status = closed ? `${saleDot[closed]} ${copy[closed]}` : `${saleDot[event.saleStatus] ?? "•"} ${copy.status[event.saleStatus]}`;
  const title = truncate(event.title, full ? 180 : 85);
  const price = `💰 ${esc(prices.join(" · ") || copy.pricePending)}`;
  return [
    index === undefined ? bold(title) : `<b>${index}. ${esc(title)}</b>`,
    `📅 ${esc(eventWhen(event.date, event.time, locale))}`,
    `📍 ${esc(truncate(place, full ? 240 : 85))}`,
    ...(full ? [price, status] : [`${price} · ${status}`]),
  ].join("\n");
}

const helpCopy: Record<EventLocale, { title: string; intro: string; guest: string[]; organizer: string[]; organizerTitle: string }> = {
  ru: {
    title: "ℹ️ <b>Помощь</b>", intro: "Пользуйтесь кнопками под сообщениями или командами:", organizerTitle: "<b>Для организаторов</b>",
    guest: ["/menu — главное меню", "/events — афиша событий", "/search — поиск по названию или городу", "/tickets — мои билеты и QR-коды", "/check_payment — статус оплаты", "/help — эта подсказка"],
    organizer: ["/today — мои события сегодня", "/notify — отправить обновление гостям"],
  },
  en: {
    title: "ℹ️ <b>Help</b>", intro: "Use the buttons under messages, or these commands:", organizerTitle: "<b>For organizers</b>",
    guest: ["/menu — main menu", "/events — browse events", "/search — search by name or city", "/tickets — my tickets and QR codes", "/check_payment — payment status", "/help — this message"],
    organizer: ["/today — my events today", "/notify — send guests an update"],
  },
  kk: {
    title: "ℹ️ <b>Көмек</b>", intro: "Хабарлама астындағы батырмаларды немесе командаларды қолданыңыз:", organizerTitle: "<b>Ұйымдастырушыларға</b>",
    guest: ["/menu — басты мәзір", "/events — іс-шаралар афишасы", "/search — атау немесе қала бойынша іздеу", "/tickets — билеттерім және QR-кодтар", "/check_payment — төлем күйі", "/help — осы көмек"],
    organizer: ["/today — бүгінгі іс-шараларым", "/notify — қонақтарға жаңарту жіберу"],
  },
};

/** Localised /help, rendered as Telegram HTML. */
export function helpText(role: BotRole, locale: EventLocale): string {
  const copy = helpCopy[locale];
  const organizer = role === "organizer" || role === "admin";
  return [copy.title, copy.intro, copy.guest.join("\n"), ...(organizer ? [`${copy.organizerTitle}\n${copy.organizer.join("\n")}`] : [])].join("\n\n");
}
