import { randomBytes } from "node:crypto";
import { type PrismaClient, type TelegramSeatSession as StoredSession } from "@event-platform/database";
import {
  checkedOrderTotal, EVENT_LOCALES, hasEventEnded, readCheckoutSnapshot,
  type EventLocale, type PublicEvent, type TelegramSeatCatalogue, type TelegramSeatItem,
  type TelegramSeatOffer, type TelegramSeatOrder, type TelegramSeatSelection, type TelegramSeatSession,
} from "@event-platform/shared-types";
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { DATABASE_CLIENT } from "../auth/auth.constants.js";
import { BOOKING_CLOCK, PAYMENT_PROVIDER, type BookingClock } from "../booking/booking.constants.js";
import type { PaymentProvider } from "../booking/payment-provider.js";
import { AnonymousService, secretHash } from "../orders/anonymous.service.js";
import { PublicEventsService } from "../public-events/public-events.service.js";
import { SeatsService } from "../seats/seats.service.js";
import { BotCheckoutService } from "./bot-checkout.service.js";
import { botPurchaseActor, botOrderScope, recipientWhere, type BotPurchaseActor } from "./bot-purchase-access.js";
import { TELEGRAM_SEAT_SESSION_MS, seatUuid, verifyTelegramSeatLaunch } from "./telegram-seat-auth.js";

export const TELEGRAM_SEAT_CONFIG = Symbol("TELEGRAM_SEAT_CONFIG");
export interface TelegramSeatConfig { enabled: boolean; token: string; botUsername: string }
type Session = Pick<StoredSession, "eventId"> & { actor: BotPurchaseActor; locale: EventLocale };

@Injectable()
export class TelegramSeatService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly db: PrismaClient,
    @Inject(BOOKING_CLOCK) private readonly clock: BookingClock,
    @Inject(TELEGRAM_SEAT_CONFIG) private readonly config: TelegramSeatConfig,
    @Inject(PublicEventsService) private readonly events: PublicEventsService,
    @Inject(SeatsService) private readonly seats: SeatsService,
    @Inject(AnonymousService) private readonly anonymous: AnonymousService,
    @Inject(BotCheckoutService) private readonly checkout: BotCheckoutService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  assertEnabled(): void {
    if (!this.config.enabled) throw new NotFoundException();
  }

  async exchange(initData: unknown): Promise<TelegramSeatSession> {
    this.assertEnabled();
    const now = this.clock.now();
    const launch = verifyTelegramSeatLaunch(initData, this.config.token, now);
    const actor = await botPurchaseActor(this.db, launch.telegramId, launch.telegramId);
    const preference = await this.db.telegramGuestPreference.findUnique({
      where: { telegramId: actor.recipient }, select: { locale: true },
    });
    const locale = EVENT_LOCALES.find(value => value === preference?.locale)
      ?? EVENT_LOCALES.find(value => value === launch.language) ?? "ru";
    const session: Session = { actor, eventId: launch.eventId, locale };
    try {
      await this.events.get(session.eventId, now, locale);
    } catch (error) {
      if (!(error instanceof NotFoundException) || !await this.latestOrder(session)) throw error;
    }
    const token = randomBytes(32).toString("base64url");
    // The key is Telegram's verified digest, independent of query ordering or encoding.
    const result = await this.db.telegramSeatSession.createMany({ skipDuplicates: true, data: [{
      launchHash: launch.launchHash, tokenHash: secretHash(token), telegramId: actor.recipient,
      eventId: session.eventId, locale, expiresAt: new Date(now.getTime() + TELEGRAM_SEAT_SESSION_MS),
    }] });
    if (!result.count) throw new ConflictException({ code: "TELEGRAM_SEAT_LAUNCH_USED" });
    return { token, eventId: session.eventId, locale, chatUrl: this.chatUrl() };
  }

  async authenticate(authorization?: string): Promise<Session> {
    this.assertEnabled();
    if (!authorization || !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) throw sessionExpired();
    const row = await this.db.telegramSeatSession.findFirst({
      where: { tokenHash: secretHash(authorization.slice(7)), expiresAt: { gt: this.clock.now() } },
      select: { telegramId: true, eventId: true, locale: true },
    });
    if (!row) throw sessionExpired();
    const id = String(row.telegramId);
    return { eventId: row.eventId, locale: EVENT_LOCALES.find(value => value === row.locale) ?? "ru", actor: await botPurchaseActor(this.db, id, id) };
  }

  async catalogue(session: Session): Promise<TelegramSeatCatalogue> {
    return (await this.inventory(session)).catalogue;
  }

  async quote(session: Session, input: unknown): Promise<TelegramSeatOffer> {
    const { seatIds, tableId } = readSelection(input);
    const { event, catalogue } = await this.inventory(session);
    if (catalogue.closed) throw new ConflictException({ code: "EVENT_SALES_PAUSED" });
    const all = new Map(catalogue.groups.flatMap(group => group.items).map(item => [item.id, item]));
    const items = [...seatIds.map(id => pick(all, id, "seat")), ...(tableId ? [pick(all, tableId, "table")] : [])];
    const currency = items[0]!.currency;
    if (items.some(item => item.currency !== currency)) throw new ConflictException({ code: "CART_CURRENCY_MISMATCH" });
    let amountDue: number;
    try {
      amountDue = checkedOrderTotal(items.map(item => ({ unitAmount: item.amount, quantity: 1, currency: item.currency })), currency);
    } catch {
      throw new BadRequestException({ code: "MONEY_TOTAL_OVERFLOW" });
    }
    return this.anonymous.startSeatOffer("Telegram", session.actor.recipient, {
      kind: "cart", eventId: event.id, items, title: event.title, timezone: event.timezone, amountDue, currency,
      locale: event.contentLocale ?? event.sourceLocale ?? session.locale,
      refundTerms: event.cancellationTerms, refundsAvailable: event.refundsAvailable ?? null, policyRevision: event.refundPolicyRevision ?? null,
    });
  }

  async confirm(session: Session, reference: string): Promise<TelegramSeatOrder> {
    const id = await this.anonymous.confirmSeatOffer(session.actor.recipient, reference, session.eventId);
    // An unavailable payment adapter can be retried from this order after the hold commits.
    return (await this.order(session, id, true))!;
  }

  async order(session: Session, id?: string, resume = false): Promise<TelegramSeatOrder | null> {
    const where = this.ordersWhere(session);
    const order = id
      ? await this.db.order.findFirst({ where: { ...where, id }, select: seatOrderSelect })
      : await this.latestOrder(session);
    if (!order) {
      if (id) throw new NotFoundException({ code: "BOT_ORDER_NOT_FOUND" });
      return null;
    }
    const telegramId = String(session.actor.recipient);
    const result = await this.checkout.order(telegramId, telegramId, order.id, resume).catch(error => {
      if (!(error instanceof ServiceUnavailableException)) throw error;
      return this.checkout.order(telegramId, telegramId, order.id, false);
    });
    const demoPayment = result.amountDue > 0 && this.provider.name === "mock";
    const snapshot = readCheckoutSnapshot(order.checkoutSnapshot);
    return {
      ...result, demoPayment,
      paymentLink: !demoPayment && result.status === "pending" ? (result.paymentLink ?? order.paymentLink) : null,
      chatUrl: this.chatUrl(result.orderId), serverTime: this.clock.now().toISOString(),
      items: (snapshot.items ?? []).map(item => ({
        label: (item.kind === "seat" && snapshot.seatLabels?.[snapshot.seatIds?.indexOf(item.id) ?? -1]) || item.name,
        amount: item.amountDue,
      })),
      refundTerms: snapshot.cancellationTerms, refundsAvailable: snapshot.acceptedPolicy?.available ?? null,
    };
  }

  private ordersWhere(session: Session) {
    return {
      ...botOrderScope(session.actor),
      anonymousSession: { ...recipientWhere(session.actor), telegramSeatEventId: session.eventId },
    };
  }

  private async latestOrder(session: Session) {
    const where = this.ordersWhere(session);
    const orderBy = { createdAt: "desc" } as const;
    return await this.db.order.findFirst({ where: {
      ...where, paymentStatus: "pending", expiresAt: { gt: this.clock.now() },
    }, orderBy, select: seatOrderSelect }) ?? this.db.order.findFirst({ where, orderBy, select: seatOrderSelect });
  }

  private async inventory(session: Session): Promise<{ event: PublicEvent; catalogue: TelegramSeatCatalogue }> {
    const now = this.clock.now();
    let event = await this.events.get(session.eventId, now, session.locale);
    if (!event.creationVersion && event.sourceLocale && event.contentLocale !== event.sourceLocale) {
      event = await this.events.get(session.eventId, now, event.sourceLocale);
    }
    const layout = await this.seats.publicForEvent(session.eventId, event.contentLocale ?? session.locale);
    const closed = !layout || event.salesPaused || event.paymentMode === "deposit" || hasEventEnded(event, now);
    const words = seatWords[session.locale];
    const groups: TelegramSeatCatalogue["groups"] = [];
    const priced = new Map(layout?.seats?.map(seat => [seat.id, seat]));
    const ungrouped = (layout?.seats ?? []).flatMap(seat => seat.rowId || seat.tableId || seat.price === null ? [] : [{
      id: seat.id, kind: "seat" as const, label: seat.label || `${words.seat} ${seat.number}`,
      amount: seat.price, currency: seat.currency, available: !closed && seat.availability === "available",
    }]);
    if (ungrouped.length) groups.push({ label: words.seats, items: ungrouped });
    for (const row of layout?.rows ?? []) {
      const label = row.name || `${words.row} ${row.number}`;
      const items = row.seats.flatMap(seat => {
        const price = priced.get(seat.id) ?? seat;
        return price.price === null ? [] : [{
          id: seat.id, kind: "seat" as const, label: `${label} · ${words.seat} ${seat.number}`,
          amount: price.price, currency: price.currency, available: !closed && row.availability === "available" && price.availability === "available",
        }];
      });
      if (items.length) groups.push({ label, items });
    }
    for (const table of layout?.tables ?? []) {
      const label = table.name || `${words.table} ${table.number}`;
      if (table.saleMode === "whole_table") {
        const option = event.tables.find(value => value.id === table.id);
        if (option?.payment.amountDue != null && table.price !== null) groups.push({ label, items: [{
          id: table.id, kind: "table", label, capacity: table.seats, amount: option.payment.amountDue,
          currency: option.payment.currency, available: !closed && option.availability === "available",
        }] });
      } else {
        const items = table.seatRecords.flatMap(seat => {
          const price = priced.get(seat.id);
          return price?.price == null ? [] : [{
            id: seat.id, kind: "seat" as const, label: `${label} · ${words.seat} ${seat.number}`,
            amount: price.price, currency: price.currency, available: !closed && table.status === "available" && price.availability === "available",
          }];
        });
        if (items.length) groups.push({ label, items });
      }
    }
    const { id, title, date, time, timezone, address } = event;
    return { event, catalogue: { event: { id, title, date, time, timezone, address }, layout, groups, closed } };
  }

  private chatUrl(orderId?: string) {
    return `https://t.me/${this.config.botUsername}${orderId ? `?start=p_${orderId}` : ""}`;
  }
}

const seatWords = {
  en: { row: "Row", seat: "Seat", seats: "Seats", table: "Table" },
  kk: { row: "Қатар", seat: "Орын", seats: "Орындар", table: "Үстел" },
  ru: { row: "Ряд", seat: "Место", seats: "Места", table: "Стол" },
} as const;
const seatOrderSelect = { id: true, checkoutSnapshot: true, paymentLink: true } as const;

function sessionExpired() { return new UnauthorizedException({ code: "TELEGRAM_SEAT_SESSION_EXPIRED" }); }

function pick(items: Map<string, TelegramSeatItem>, id: string, kind: TelegramSeatItem["kind"]) {
  const item = items.get(id);
  if (!item?.available || item.kind !== kind) throw new ConflictException({ code: kind === "seat" ? "SEAT_UNAVAILABLE" : "TABLE_UNAVAILABLE" });
  return item;
}

function readSelection(input: unknown): TelegramSeatSelection {
  const invalid = () => new BadRequestException({ code: "CART_SELECTION_INVALID" });
  if (!input || typeof input !== "object") throw invalid();
  const { seatIds, tableId } = input as Record<string, unknown>;
  if (!Array.isArray(seatIds) || seatIds.length > 10 ||
      seatIds.some(id => typeof id !== "string" || !seatUuid.test(id)) ||
      (tableId !== undefined && (typeof tableId !== "string" || !seatUuid.test(tableId))) || (!seatIds.length && !tableId)) throw invalid();
  const normalizedIds = seatIds.map((id: string) => id.toLowerCase());
  if (new Set(normalizedIds).size !== normalizedIds.length) throw invalid();
  return { seatIds: normalizedIds, ...(typeof tableId === "string" ? { tableId: tableId.toLowerCase() } : {}) };
}
