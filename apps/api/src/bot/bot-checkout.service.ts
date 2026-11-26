import { Prisma, type PrismaClient } from "@event-platform/database";
import { hasEventEnded, readCheckoutSnapshot, type BotCheckoutOffer, type BotCheckoutResult, type BotCheckoutSelection, type BotPaymentStatus } from "@event-platform/shared-types";
import { ConflictException, HttpException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { DATABASE_CLIENT } from "../auth/auth.constants.js";
import { BOOKING_CLOCK, type BookingClock } from "../booking/booking.constants.js";
import { BookingService } from "../booking/booking.service.js";
import { AnonymousService } from "../orders/anonymous.service.js";
import { PaymentService } from "../payments/payment.service.js";
import { PublicEventsService } from "../public-events/public-events.service.js";
import { botOrderScope, botPurchaseActor, recipientWhere, type BotPurchaseActor } from "./bot-purchase-access.js";

const PAGE_SIZE = 8;
const orderSelect = {
  id: true, buyerUserId: true, amount: true, currency: true, paymentStatus: true,
  expiresAt: true, paymentLink: true, checkoutSnapshot: true, anonymousSession: { select: { id: true } },
} satisfies Prisma.OrderSelect;
type Order = Prisma.OrderGetPayload<{ select: typeof orderSelect }>;


@Injectable()
export class BotCheckoutService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly db: PrismaClient,
    @Inject(BOOKING_CLOCK) private readonly clock: BookingClock,
    @Inject(PublicEventsService) private readonly publicEvents: PublicEventsService,
    @Inject(AnonymousService) private readonly anonymous: AnonymousService,
    @Inject(PaymentService) private readonly payments: PaymentService,
    @Inject(BookingService) private readonly booking: BookingService,
  ) {}

  async prepare(telegramId: string, chatId: string, name: string, selection: BotCheckoutSelection): Promise<BotCheckoutOffer> {
    return this.prepareFor(await botPurchaseActor(this.db, telegramId, chatId), name, selection);
  }

  async confirm(telegramId: string, chatId: string, reference: string, messageId: number): Promise<BotCheckoutResult> {
    const actor = await botPurchaseActor(this.db, telegramId, chatId);
    let id: string;
    try {
      id = await this.anonymous.confirmBotOffer(actor.recipient, reference, messageId);
    } catch (error) {
      if (!["BOT_OFFER_CHANGED", "REFUND_POLICY_CHANGED", "EVENT_PRESENTATION_CHANGED"].includes(errorCode(error) ?? "")) throw error;
      const session = await this.db.anonymousCheckoutSession.findFirst({
        where: { id: reference, ...recipientWhere(actor), orderId: null, expiresAt: { gt: this.clock.now() } },
        select: { name: true, botOffer: true },
      });
      if (!session?.botOffer) throw new ConflictException({ code: "BOT_OFFER_EXPIRED" });
      return { offer: await this.prepareFor(actor, session.name, session.botOffer as unknown as BotCheckoutSelection) };
    }
    return { order: await this.readOrder(actor, id, true) };
  }

  async list(telegramId: string, chatId: string, page: number): Promise<{ items: BotPaymentStatus[]; hasNext: boolean }> {
    const actor = await botPurchaseActor(this.db, telegramId, chatId);
    const where = botOrderScope(actor);
    const orderBy = [{ createdAt: "desc" }, { id: "desc" }] satisfies Prisma.OrderOrderByWithRelationInput[];
    const pending = await this.db.order.findMany({
      where: { ...where, paymentStatus: "pending" },
      select: orderSelect, orderBy, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE + 1,
    });
    const orders = pending.length || page > 1 ? pending : await this.db.order.findMany({ where, select: orderSelect, orderBy, take: 1 });
    return { items: await Promise.all(orders.slice(0, PAGE_SIZE).map(order => this.present(order))), hasNext: orders.length > PAGE_SIZE };
  }

  async order(telegramId: string, chatId: string, orderId: string, resume: boolean): Promise<BotPaymentStatus> {
    return this.readOrder(await botPurchaseActor(this.db, telegramId, chatId), orderId, resume);
  }

  private async prepareFor(actor: BotPurchaseActor, name: string, selection: BotCheckoutSelection): Promise<BotCheckoutOffer> {
    const { itemId, kind } = selection;
    const eventId = kind === "ticket"
      ? (await this.db.ticketType.findFirst({ where: { id: itemId, isInternal: false, seats: { none: {} } }, select: { eventId: true } }))?.eventId
      : (await this.db.table.findUnique({ where: { id: itemId }, select: { venueLayout: { select: { eventId: true } } } }))?.venueLayout.eventId;
    if (!eventId) throw unavailable();
    const now = this.clock.now();
    let event = await this.publicEvents.get(eventId, now, selection.locale);
    // Legacy snapshots store the source terms. Quote the same terms the booking will persist.
    if (!event.creationVersion && event.sourceLocale && event.contentLocale !== event.sourceLocale) {
      event = await this.publicEvents.get(eventId, now, event.sourceLocale);
    }
    if (event.salesPaused || event.paymentMode === "deposit") throw new ConflictException({ code: "EVENT_SALES_PAUSED" });
    if (hasEventEnded(event, now)) throw new ConflictException({ code: "EVENT_ENDED" });
    const ticket = kind === "ticket" ? event.ticketTypes.find(item => item.id === itemId && item.status === "active" && item.remaining > 0) : undefined;
    const table = kind === "table" ? event.tables.find(item => item.id === itemId && item.saleMode === "whole_table" && item.availability === "available") : undefined;
    const item = ticket ?? table;
    if (!item) throw unavailable();
    return this.anonymous.startBotOffer(name, actor.recipient, {
      kind, itemId, eventId, title: event.title, itemName: item.name || (table ? `№${table.number}` : event.title),
      locale: event.contentLocale ?? selection.locale, amountDue: item.payment.amountDue, currency: item.payment.currency,
      refundTerms: event.cancellationTerms, refundsAvailable: event.refundsAvailable ?? null, policyRevision: event.refundPolicyRevision ?? null, timezone: event.timezone,
    });
  }

  private async readOrder(actor: BotPurchaseActor, id: string, resume: boolean): Promise<BotPaymentStatus> {
    const where = { id, ...botOrderScope(actor) };
    let order = await this.db.order.findFirst({ where, select: orderSelect });
    if (!order) throw new NotFoundException({ code: "BOT_ORDER_NOT_FOUND" });
    if (order.paymentStatus === "pending" && order.expiresAt && order.expiresAt <= this.clock.now()) {
      await this.booking.settleFailed(id, "expired");
      order = await this.db.order.findFirst({ where, select: orderSelect });
      if (!order) throw new NotFoundException({ code: "BOT_ORDER_NOT_FOUND" });
    }
    const status = await this.present(order);
    if (status.status !== "pending") return status;
    if (order.amount > 0 && !resume) return status;
    try {
      if (order.amount === 0) await this.booking.settleSucceeded(id);
      else {
        const owner = order.buyerUserId ?? order.anonymousSession?.id;
        if (!owner) throw new NotFoundException({ code: "BOT_ORDER_NOT_FOUND" });
        await this.payments.createLink(owner, id, `tg-pay-${id}`, !order.buyerUserId);
      }
    } catch (error) {
      if (!["ORDER_NOT_PAYABLE", "CHECKOUT_NOT_PAYABLE"].includes(errorCode(error) ?? "")) throw error;
    }
    order = await this.db.order.findFirst({ where, select: orderSelect });
    if (!order) throw new NotFoundException({ code: "BOT_ORDER_NOT_FOUND" });
    return this.present(order, resume);
  }

  private async present(order: Order, allowPaymentLink = false): Promise<BotPaymentStatus> {
    const signals = await this.db.outboxEvent.findMany({
      where: { aggregateId: order.id, eventType: { in: ["payment.review_required", "checkout.expired"] } },
      distinct: ["eventType"], select: { eventType: true },
    });
    const status = signals.some(row => row.eventType === "payment.review_required") ? "review_required"
      : signals.some(row => row.eventType === "checkout.expired") || (order.paymentStatus === "pending" && order.expiresAt && order.expiresAt <= this.clock.now()) ? "expired"
      : order.paymentStatus;
    const snapshot = readCheckoutSnapshot(order.checkoutSnapshot);
    return {
      orderId: order.id, status, title: snapshot.eventTitle, amountDue: order.amount, currency: order.currency.trim(),
      timezone: snapshot.eventTimezone ?? "UTC",
      expiresAt: order.expiresAt?.toISOString() ?? null, paymentLink: allowPaymentLink && status === "pending" ? order.paymentLink : null,
    };
  }

}

function unavailable() { return new ConflictException({ code: "BOT_ITEM_UNAVAILABLE" }); }

function errorCode(error: unknown): string | undefined {
  return error instanceof HttpException ? (error.getResponse() as { code?: string }).code : undefined;
}
