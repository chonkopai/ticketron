import { createHmac, timingSafeEqual } from "node:crypto";
import type { Prisma, PrismaClient } from "@event-platform/database";
import {
  acceptedResourceName, EVENT_NOTIFICATION_TYPES, hasEventEnded, readCheckoutSnapshot,
  type BotAdmissionKind, type BotReturnKind, type BotReturnPreview, type BotWalletAdmission,
  type BotWalletEvent, type BotWalletEventDay, type BotWalletList, type BotWalletOrder, type BotWalletOrderDetail, type BotWalletTab, type EventLocale,
} from "@event-platform/shared-types";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { AUTH_CONFIG, DATABASE_CLIENT, type AuthConfig } from "../auth/auth.constants.js";
import { BOOKING_CLOCK, type BookingClock } from "../booking/booking.constants.js";
import { BookingService } from "../booking/booking.service.js";
import { linkGuestPurchases } from "../orders/automatic-purchase-link.js";
import { PublicEventsService } from "../public-events/public-events.service.js";
import { guestEventTiming, guestEventTimingSelect } from "../tickets/guest-ticket-details.js";
import { TicketsService } from "../tickets/tickets.service.js";
import { botOrderScope, botPurchaseActor, type BotPurchaseActor } from "./bot-purchase-access.js";

const PAGE_SIZE = 6;
const RETURN_WINDOW_MS = 5 * 60_000;
const eventUpdateTypes = ["event.change", "event.cancelled", "event.reminder", ...EVENT_NOTIFICATION_TYPES.map(type => `event.${type}`)];
const eventSelect = { id: true, title: true, address: true, status: true, ...guestEventTimingSelect } as const;
type EventRow = Prisma.EventGetPayload<{ select: typeof eventSelect }>;
const orderSelect = {
  id: true, buyerUserId: true, paymentStatus: true, expiresAt: true, amount: true, currency: true, checkoutSnapshot: true,
  anonymousSession: { select: { telegramId: true, chatId: true } },
  refundRequest: { select: { status: true } },
  tickets: { orderBy: { id: "asc" }, select: { id: true, ownerUserId: true, status: true, seatLabelSnapshot: true, ticketTypeId: true,
    seatAllocation: { select: { seatId: true, seat: { select: { tableId: true } } } },
    ticketType: { select: { name: true, isInternal: true, event: { select: eventSelect } } },
  } },
  booking: { select: { id: true, status: true, table: { select: { id: true, number: true, name: true, venueLayout: { select: { event: { select: eventSelect } } } } } } },
  groupPass: { select: { id: true, status: true } },
} as const satisfies Prisma.OrderSelect;
type OrderRow = Prisma.OrderGetPayload<{ select: typeof orderSelect }>;
type OrderView = { event: EventRow; order: BotWalletOrder; admissions: BotWalletAdmission[]; booking: BotWalletOrderDetail["booking"] };

@Injectable()
export class BotWalletService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly db: PrismaClient,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    @Inject(BOOKING_CLOCK) private readonly clock: BookingClock,
    @Inject(TicketsService) private readonly tickets: TicketsService,
    @Inject(BookingService) private readonly booking: BookingService,
    @Inject(PublicEventsService) private readonly publicEvents: PublicEventsService,
  ) {}

  async list(telegramId: string, chatId: string, tab: BotWalletTab, page: number, locale: EventLocale): Promise<BotWalletList> {
    const actor = await botPurchaseActor(this.db, telegramId, chatId);
    const orders = await this.views(actor);
    const ordered = orders.sort((a, b) => compareEvents(a.event, b.event));
    const events = new Map<string, EventRow>();
    for (const view of ordered) {
      const ended = !admissionOpen(view.event, this.clock.now());
      const pending = view.order.status === "pending" || view.order.status === "review_required";
      const current = view.order.status === "paid" && !ended &&
        (view.admissions.some(item => item.status === "active" || item.status === "used") || view.booking?.status === "confirmed");
      const history = !pending && (!current || view.order.cancellation || view.order.refund === "succeeded");
      if ((tab === "pending" && pending) || (tab === "upcoming" && current) || (tab === "past" && history)) {
        events.set(view.event.id, view.event);
      }
    }
    const results = [...events.values()];
    if (tab === "past") results.reverse();
    const start = (page - 1) * PAGE_SIZE;
    return {
      items: await Promise.all(results.slice(start, start + PAGE_SIZE).map(event => this.presentEvent(event, locale))),
      hasNext: start + PAGE_SIZE < results.length,
      nextQr: firstQr(ordered),
    };
  }

  async event(telegramId: string, chatId: string, id: string, page: number, locale: EventLocale): Promise<BotWalletEventDay> {
    const actor = await botPurchaseActor(this.db, telegramId, chatId);
    const orders = await this.views(actor, { OR: [
      { tickets: { some: { ticketType: { eventId: id } } } },
      { booking: { table: { venueLayout: { eventId: id } } } },
    ] }, id);
    if (!orders[0]) throw unavailable();
    const start = (page - 1) * PAGE_SIZE;
    const updates = await this.db.notification.findMany({
      where: {
        eventId: id, type: { in: eventUpdateTypes },
        status: "sent", OR: [{ channel: "telegram", telegramId: actor.recipient }, ...(actor.userId ? [{ channel: "in_app" as const, userId: actor.userId }] : [])],
      },
      select: { payload: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 8,
    });
    const texts = updates.flatMap(({ payload }) => {
      const value = payload && typeof payload === "object" && !Array.isArray(payload) ? payload.text : null;
      return typeof value === "string" ? [value] : [];
    });
    return {
      event: await this.presentEvent(orders[0].event, locale),
      orders: orders.slice(start, start + PAGE_SIZE).map(view => view.order),
      hasNext: start + PAGE_SIZE < orders.length, nextQr: firstQr(orders), updates: [...new Set(texts)].slice(0, 3),
    };
  }

  async order(telegramId: string, chatId: string, id: string, page: number, locale: EventLocale): Promise<BotWalletOrderDetail> {
    const actor = await botPurchaseActor(this.db, telegramId, chatId);
    const [view] = await this.views(actor, { id });
    if (!view) throw unavailable();
    const start = (page - 1) * PAGE_SIZE;
    return {
      event: await this.presentEvent(view.event, locale), order: view.order, booking: view.booking,
      admissions: view.admissions.slice(start, start + PAGE_SIZE), hasNext: start + PAGE_SIZE < view.admissions.length,
    };
  }

  async qr(telegramId: string, chatId: string, kind: BotAdmissionKind, id: string): Promise<Buffer> {
    const actor = await botPurchaseActor(this.db, telegramId, chatId);
    if (kind === "group") {
      const pass = await this.db.groupPass.findFirst({ where: { id, order: botOrderScope(actor) }, select: { orderId: true } });
      if (!pass) throw unavailable();
      return this.tickets.assetGroupPassForOrder(pass.orderId, id, true);
    }
    const ticket = await this.db.ticket.findFirst({
      where: { id, OR: [...(actor.userId ? [{ ownerUserId: actor.userId }] : []), { order: botOrderScope(actor) }] },
      select: { orderId: true },
    });
    if (!ticket) throw unavailable();
    return this.tickets.assetForAnonymousOrder(ticket.orderId, id, false, true);
  }

  async previewReturn(telegramId: string, chatId: string, kind: BotReturnKind, id: string): Promise<BotReturnPreview> {
    const { userId } = await botPurchaseActor(this.db, telegramId, chatId);
    if (!userId) throw unavailable();
    const [view] = await this.views({ recipient: BigInt(telegramId), userId },
      kind === "booking" ? { booking: { id } } : { tickets: { some: { id } } });
    const ticket = view?.admissions.find(item => item.kind === "ticket" && item.id === id);
    const resource = kind === "booking" ? view?.booking : ticket;
    if (!resource?.returnAvailable) throw new ConflictException({ code: "BOT_RETURN_UNAVAILABLE" });
    const quote = await (kind === "booking" ? this.booking.bookingCancellationTerms(userId, id) : this.booking.ticketCancellationTerms(userId, id));
    const label = "label" in resource ? resource.label : [resource.name, resource.seatLabel].filter(Boolean).join(" · ");
    return { ...quote, label, proof: this.proof(userId, kind, id, this.returnWindow()) };
  }

  async confirmReturn(telegramId: string, chatId: string, kind: BotReturnKind, id: string, proof: string) {
    const { userId } = await botPurchaseActor(this.db, telegramId, chatId);
    if (!userId) throw unavailable();
    if (!/^[A-Za-z0-9_-]{16}$/.test(proof)) throw new ConflictException({ code: "BOT_RETURN_EXPIRED" });
    const window = this.returnWindow();
    if (![window, window - 1].some(value => timingSafeEqual(Buffer.from(this.proof(userId, kind, id, value)), Buffer.from(proof)))) {
      throw new ConflictException({ code: "BOT_RETURN_EXPIRED" });
    }
    const key = `tg-return-${kind}-${id}`;
    return kind === "booking" ? this.booking.cancelBooking(userId, id, key) : this.booking.cancelTicket(userId, id, key);
  }

  async claim(telegramId: string, chatId: string, id: string): Promise<{ linked: boolean }> {
    const actor = await botPurchaseActor(this.db, telegramId, chatId);
    const owned = await this.db.order.findFirst({ where: { id, ...botOrderScope(actor) }, select: { buyerUserId: true, paymentStatus: true } });
    if (!owned) throw unavailable();
    if (actor.userId && owned.buyerUserId === actor.userId) return { linked: true };
    if (owned.paymentStatus !== "paid") throw new ConflictException({ code: "ORDER_NOT_CLAIMABLE" });
    if (!actor.userId) return { linked: false };
    await linkGuestPurchases(this.db, actor.userId, id);
    const order = await this.db.order.findFirst({ where: { id, buyerUserId: actor.userId }, select: { id: true } });
    if (!order) throw new ConflictException({ code: "ORDER_NOT_CLAIMABLE" });
    return { linked: true };
  }

  private async views(actor: BotPurchaseActor, where: Prisma.OrderWhereInput = {}, eventId?: string): Promise<OrderView[]> {
    const rows = await this.db.order.findMany({
      where: { AND: [where, { OR: [botOrderScope(actor), ...(actor.userId ? [{ tickets: { some: { ownerUserId: actor.userId } } }] : [])] }] },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { ...orderSelect, tickets: { ...orderSelect.tickets, where: {
        OR: [{ order: botOrderScope(actor) }, ...(actor.userId ? [{ ownerUserId: actor.userId }] : [])],
      } } },
    });
    if (!rows.length) return [];
    const ids = rows.map(order => order.id);
    const [signals, staffRefunds] = await Promise.all([
      this.db.outboxEvent.findMany({ where: { aggregateId: { in: ids }, eventType: { in: ["payment.review_required", "checkout.expired"] } }, select: { aggregateId: true, eventType: true } }),
      this.db.staffRefund.findMany({ where: { orderId: { in: ids } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { orderId: true, status: true }, distinct: ["orderId"] }),
    ]);
    const reviews = new Set(signals.filter(signal => signal.eventType === "payment.review_required").map(signal => signal.aggregateId));
    const expired = new Set(signals.filter(signal => signal.eventType === "checkout.expired").map(signal => signal.aggregateId));
    const staffStatus = new Map(staffRefunds.map(refund => [refund.orderId, refund.status]));
    const now = this.clock.now();
    return rows.flatMap(row => {
      const ownsOrder = row.buyerUserId === null
        ? row.anonymousSession?.telegramId === actor.recipient && row.anonymousSession.chatId === actor.recipient
        : row.buyerUserId === actor.userId;
      const admissions = row.tickets.filter(ticket => !eventId || ticket.ticketType.event.id === eventId);
      const booked = ownsOrder ? row.booking : null;
      const bookingEvent = booked?.table.venueLayout.event;
      const event = admissions[0]?.ticketType.event ?? (bookingEvent && (!eventId || bookingEvent.id === eventId) ? bookingEvent : null);
      if (!event) return [];
      const status = reviews.has(row.id) ? "review_required" : expired.has(row.id) || (row.paymentStatus === "pending" && row.expiresAt && row.expiresAt <= now) ? "expired" : row.paymentStatus;
      const cancellation = row.paymentStatus === "cancelled" || booked?.status === "cancelled" || admissions.some(ticket => ticket.status === "cancelled");
      const refund = ownsOrder ? refundState(row, staffStatus.get(row.id), cancellation) : null;
      const snapshot = readCheckoutSnapshot(row.checkoutSnapshot);
      const canReturn = !!actor.userId && row.buyerUserId === actor.userId && (status === "pending" || status === "paid") && admissionOpen(event, now) &&
        snapshot.itemKind !== "cart" && (status === "pending" || snapshot.acceptedPolicy?.available !== false || row.amount === 0) && refund !== "processing" && refund !== "requested";
      const pendingTicketReturn = status === "pending" && admissions.filter(ticket => ticket.status !== "cancelled").length === 1;
      const tickets: BotWalletAdmission[] = admissions.map(ticket => ({
        id: ticket.id, kind: "ticket", name: acceptedResourceName(snapshot, [ticket.ticketTypeId, ticket.seatAllocation?.seatId, ticket.seatAllocation?.seat.tableId], ticket.ticketType.isInternal ? ticket.seatLabelSnapshot ?? ticket.ticketType.name : ticket.ticketType.name),
        seatLabel: ticket.seatLabelSnapshot, status: ticket.status,
        qrAvailable: status === "paid" && ticket.status === "active" && admissionOpen(ticket.ticketType.event, now),
        returnAvailable: canReturn && !ticket.seatAllocation && (ticket.status === "active" || (pendingTicketReturn && ticket.status === "pending_payment")),
      }));
      if (row.groupPass && booked) tickets.unshift({
        id: row.groupPass.id, kind: "group", name: booked.table.name ?? `№${booked.table.number}`, seatLabel: null, status: row.groupPass.status,
        qrAvailable: row.groupPass.status === "active" && tickets.some(ticket => ticket.qrAvailable), returnAvailable: false,
      });
      return [{
        event, admissions: tickets, order: { id: row.id, status, amount: ownsOrder ? row.amount : null, currency: row.currency.trim(),
          anonymous: ownsOrder && row.buyerUserId === null, canClaim: ownsOrder && row.buyerUserId === null && status === "paid", cancellation, refund },
        booking: booked ? { id: booked.id, label: acceptedResourceName(snapshot, [booked.table.id], booked.table.name ?? `№${booked.table.number}`),
          status: booked.status, returnAvailable: canReturn && (booked.status === "confirmed" || booked.status === "pending") &&
            admissions.every(ticket => ticket.status === "active" || ticket.status === "pending_payment") } : null,
      }];
    });
  }

  private async presentEvent(row: EventRow, locale: EventLocale): Promise<BotWalletEvent> {
    const publicEvent = await this.publicEvents.get(row.id, this.clock.now(), locale).catch(error => {
      if (error instanceof NotFoundException) return null;
      throw error;
    });
    return { id: row.id, title: publicEvent?.title ?? row.title, address: publicEvent?.address ?? row.address,
      status: row.status, timezone: row.timezone, startsAt: guestEventTiming(row).startsAt };
  }

  private returnWindow(): number { return Math.floor(this.clock.now().getTime() / RETURN_WINDOW_MS); }
  private proof(userId: string, kind: BotReturnKind, id: string, window: number): string {
    return createHmac("sha256", this.config.botApiSecret).update(`wallet-return:${userId}:${kind}:${id}:${window}`).digest().subarray(0, 12).toString("base64url");
  }
}

function admissionOpen(event: EventRow, now: Date): boolean {
  return event.status === "published" && !hasEventEnded(guestEventTiming(event), now);
}
function compareEvents(a: EventRow, b: EventRow): number {
  return guestEventTiming(a).startsAt.localeCompare(guestEventTiming(b).startsAt) || a.id.localeCompare(b.id);
}
function firstQr(views: OrderView[]): BotWalletList["nextQr"] {
  for (const view of views) {
    const item = view.admissions.find(admission => admission.qrAvailable);
    if (item) return { kind: item.kind, id: item.id };
  }
  return null;
}
function refundState(row: OrderRow, staff: string | undefined, cancelled: boolean): BotWalletOrder["refund"] {
  if (row.paymentStatus === "refunded") return "succeeded";
  const status = staff ?? row.refundRequest?.status;
  if (status === "requested" || status === "processing" || status === "succeeded" || status === "failed") return status;
  return cancelled && row.paymentStatus === "paid" && row.amount > 0 ? "awaiting_review" : null;
}
function unavailable() { return new NotFoundException({ code: "BOT_WALLET_NOT_FOUND" }); }
