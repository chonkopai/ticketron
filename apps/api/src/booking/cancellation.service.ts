import { parseHistoricalPurchaseSnapshot } from "@event-platform/shared-types";
import { BookingStatus, PaymentStatus, Prisma, RefundStatus, SeatAllocationStatus, TableHoldStatus, TicketReservationStatus, TicketStatus, type PrismaClient } from "@event-platform/database";
import { type CancellationResponse, type CancellationTermsResponse, type ManagementHoldPreview, type ManagementHoldRelease } from "@event-platform/shared-types";
import { ConflictException } from "@nestjs/common";
import { DomainEventsService } from "../domain-events/domain-events.service.js";
import { lockOrder, lockTable } from "./inventory-locks.js";
import { releaseOrderInventory } from "./order-release.service.js";
import { type BookingClock } from "./booking.constants.js";
import { TICKET_CANCEL, BOOKING_CANCEL, claimCancellation, saveResponse, snapshot, cancellationResponse, isUniqueError, idempotencyKey, orderNotFound, resourceNotFound } from "./booking-support.js";

/** Cancellation: buyer cancellation, unpaid-order release and expiry, organizer hold release (split from BookingService). */
export class CancellationService {
  constructor(
    private readonly database: PrismaClient,
    private readonly domainEvents: DomainEventsService,
    private readonly clock: BookingClock,
  ) {}

  async settleFailed(orderId: string, reason: "failed" | "expired" = "failed"): Promise<void> {
    await this.database.$transaction((transaction) => this.failOrderInTransaction(transaction, orderId, reason), { timeout: 15_000 });
  }

  async organizerHoldPreview(organizerId: string, eventId: string, orderId: string): Promise<ManagementHoldPreview> {
    const order = await ownedHoldOrder(this.database, organizerId, eventId, orderId);
    return presentHoldPreview(order, this.clock.now());
  }

  async organizerReleaseHold(organizerId: string, eventId: string, orderId: string): Promise<ManagementHoldRelease> {
    return this.database.$transaction(async (transaction) => {
      await lockOrder(transaction, orderId);
      const order = await ownedHoldOrder(transaction, organizerId, eventId, orderId);
      const prior = await transaction.auditLog.findFirst({ where: { entityType: "order", entityId: orderId, action: "checkout.hold_released" }, select: { id: true } });
      if (prior) return { orderId, released: true, alreadyReleased: true };
      const preview = presentHoldPreview(order, this.clock.now());
      if (!preview.eligible) throw new ConflictException({ code: "HOLD_NOT_RELEASABLE", message: `Hold cannot be released: ${preview.reason}` });
      await this.failOrderInTransaction(transaction, orderId, "released");
      await transaction.auditLog.create({ data: { actorId: organizerId, action: "checkout.hold_released", entityType: "order", entityId: orderId, meta: { eventId, resourceLabels: preview.resourceLabels } } });
      return { orderId, released: true, alreadyReleased: false };
    }, { timeout: 15_000 });
  }

  async expireDueCheckouts(limit: number): Promise<number> {
    const due = await this.database.order.findMany({
      where: { paymentStatus: PaymentStatus.pending, expiresAt: { lte: this.clock.now() } },
      select: { id: true },
      orderBy: { expiresAt: "asc" },
      take: Math.max(1, Math.min(limit, 500)),
    });
    for (const order of due) await this.settleFailed(order.id, "expired");
    return due.length;
  }

  async ticketCancellationTerms(userId: string, id: string): Promise<CancellationTermsResponse> {
    const ticket = await this.database.ticket.findFirst({ where: { id, order: { buyerUserId: userId } }, include: { order: true } });
    if (!ticket) throw resourceNotFound("TICKET_NOT_FOUND");
    if (snapshot(ticket.order.checkoutSnapshot).itemKind === "cart") throw new ConflictException({ code: "CART_CANCELLATION_REQUIRES_ORDER_REFUND", message: "For a combined purchase, contact the organizer to refund the whole order" });
    await this.expireIfDue(ticket.order);
    return cancellationTerms(id, ticket.status, ticket.order);
  }

  async bookingCancellationTerms(userId: string, id: string): Promise<CancellationTermsResponse> {
    const booking = await this.database.booking.findFirst({ where: { id, order: { buyerUserId: userId } }, include: { order: true } });
    if (!booking) throw resourceNotFound("BOOKING_NOT_FOUND");
    if (snapshot(booking.order.checkoutSnapshot).itemKind === "cart") throw new ConflictException({ code: "CART_CANCELLATION_REQUIRES_ORDER_REFUND", message: "For a combined purchase, contact the organizer to refund the whole order" });
    await this.expireIfDue(booking.order);
    return cancellationTerms(id, booking.status, booking.order);
  }

  async cancelTicket(userId: string, id: string, rawKey: string | undefined): Promise<CancellationResponse> {
    const key = idempotencyKey(rawKey);
    const prior = await this.replayedCancellation(userId, TICKET_CANCEL, key);
    if (prior) return prior;
    try {
      return await this.database.$transaction(async (transaction) => {
        const replay = await claimCancellation(transaction, userId, TICKET_CANCEL, key);
        if (replay) return replay;
        const initial = await transaction.ticket.findFirst({ where: { id, order: { buyerUserId: userId } }, select: { orderId: true } });
        if (!initial) throw resourceNotFound("TICKET_NOT_FOUND");
        await lockOrder(transaction, initial.orderId);
        const current = await transaction.ticket.findFirst({ where: { id, order: { buyerUserId: userId } }, include: { order: true, seatAllocation: true } });
        if (!current) throw resourceNotFound("TICKET_NOT_FOUND");
        if (snapshot(current.order.checkoutSnapshot).itemKind === "cart") throw new ConflictException({ code: "CART_CANCELLATION_REQUIRES_ORDER_REFUND", message: "For a combined purchase, contact the organizer to refund the whole order" });
        if (current.seatAllocation) throw new ConflictException({ code: "TABLE_CHILD_TICKET_CANCEL", message: "Cancel the whole table booking instead of an individual table seat" });
        await ensureNotRefunding(transaction, current.orderId);
        if (current.status === TicketStatus.used || current.status === TicketStatus.refunded) {
          throw cancellationNotAllowed("TICKET_CANCELLATION_NOT_ALLOWED");
        }
        assertAcceptedCancellation(current.order);
        // Provider links retain their original amount. Never remove only part of an unpaid selection.
        if (current.status !== TicketStatus.cancelled && current.order.paymentStatus === PaymentStatus.pending
          && await transaction.ticket.count({ where: { orderId: current.orderId, id: { not: id }, status: { not: TicketStatus.cancelled } } }) > 0) {
          throw new ConflictException({ code: "PENDING_ORDER_PARTIAL_CANCELLATION_UNAVAILABLE", message: "An unpaid checkout cannot be partially cancelled. Let it expire, then create a new checkout with the tickets you need." });
        }
        const refundPending = current.order.paymentStatus === PaymentStatus.paid && current.order.amount > 0;
        if (current.status !== TicketStatus.cancelled) {
          const sold = current.status === TicketStatus.paid || current.status === TicketStatus.active;
          await transaction.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`ticket-type:${current.ticketTypeId}`}, 0))`;
          await transaction.ticket.update({ where: { id }, data: { status: TicketStatus.cancelled, cancelledAt: this.clock.now() } });
          if (sold) await transaction.ticketType.update({ where: { id: current.ticketTypeId }, data: { quantitySold: { decrement: 1 } } });
          if (current.order.paymentStatus === PaymentStatus.pending) {
            const reservation = await transaction.ticketReservation.findFirst({ where: { orderId: current.orderId, status: TicketReservationStatus.active } });
            if (reservation) {
              await transaction.ticketReservation.update({ where: { id: reservation.id }, data: reservation.quantity > 1 ? { quantity: { decrement: 1 } } : { status: TicketReservationStatus.released } });
            }
            const remaining = await transaction.ticket.count({ where: { orderId: current.orderId, status: { not: TicketStatus.cancelled } } });
            if (remaining === 0) {
              await transaction.order.update({ where: { id: current.orderId }, data: { paymentStatus: PaymentStatus.cancelled } });
              await transaction.deposit.updateMany({ where: { orderId: current.orderId }, data: { status: PaymentStatus.cancelled } });
              await cancelPendingPayments(transaction, current.orderId);
            }
          }
          await this.recordCancellation(transaction, userId, "ticket", id, refundPending, current.orderId);
        }
        const response = { resourceId: id, cancelled: true as const, refundPending };
        await saveResponse(transaction, userId, TICKET_CANCEL, key, id, response);
        return response;
      });
    } catch (error) {
      return this.resolveCancellationRace(error, userId, TICKET_CANCEL, key);
    }
  }

  async cancelBooking(userId: string, id: string, rawKey: string | undefined): Promise<CancellationResponse> {
    const key = idempotencyKey(rawKey);
    const prior = await this.replayedCancellation(userId, BOOKING_CANCEL, key);
    if (prior) return prior;
    try {
      return await this.database.$transaction(async (transaction) => {
        const replay = await claimCancellation(transaction, userId, BOOKING_CANCEL, key);
        if (replay) return replay;
        const initial = await transaction.booking.findFirst({ where: { id, order: { buyerUserId: userId } }, select: { orderId: true, tableId: true } });
        if (!initial) throw resourceNotFound("BOOKING_NOT_FOUND");
        await lockOrder(transaction, initial.orderId);
        await lockTable(transaction, initial.tableId);
        const booking = await transaction.booking.findFirst({ where: { id, order: { buyerUserId: userId } }, include: { order: { include: { tickets: true } }, tableHold: true } });
        if (!booking) throw resourceNotFound("BOOKING_NOT_FOUND");
        if (snapshot(booking.order.checkoutSnapshot).itemKind === "cart") throw new ConflictException({ code: "CART_CANCELLATION_REQUIRES_ORDER_REFUND", message: "For a combined purchase, contact the organizer to refund the whole order" });
        await ensureNotRefunding(transaction, booking.orderId);
        if (booking.status === BookingStatus.expired || booking.order.tickets.some(ticket => ticket.status === TicketStatus.used || ticket.status === TicketStatus.refunded)) throw cancellationNotAllowed("BOOKING_CANCELLATION_NOT_ALLOWED");
        assertAcceptedCancellation(booking.order);
        const refundPending = booking.order.paymentStatus === PaymentStatus.paid && booking.order.amount > 0;
        if (booking.status !== BookingStatus.cancelled) {
          await releaseOrderInventory(transaction, booking.orderId, { terminalTicketStatus: "cancelled", reason: "cancelled", now: this.clock.now() });
          if (booking.order.paymentStatus === PaymentStatus.pending) {
            await transaction.order.update({ where: { id: booking.orderId }, data: { paymentStatus: PaymentStatus.cancelled } });
            await transaction.deposit.updateMany({ where: { orderId: booking.orderId }, data: { status: PaymentStatus.cancelled } });
            await cancelPendingPayments(transaction, booking.orderId);
          }
          await this.recordCancellation(transaction, userId, "booking", id, refundPending, booking.orderId);
        }
        const response = { resourceId: id, cancelled: true as const, refundPending };
        await saveResponse(transaction, userId, BOOKING_CANCEL, key, id, response);
        return response;
      }, { timeout: 15_000 });
    } catch (error) {
      return this.resolveCancellationRace(error, userId, BOOKING_CANCEL, key);
    }
  }

  async failOrderInTransaction(transaction: Prisma.TransactionClient, orderId: string, reason: "failed" | "expired" | "released"): Promise<void> {
    await lockOrder(transaction, orderId);
    const order = await transaction.order.findUnique({ where: { id: orderId }, select: { paymentStatus: true } });
    if (!order || order.paymentStatus !== PaymentStatus.pending) return;
    await releaseOrderInventory(transaction, orderId, { terminalTicketStatus: "cancelled", reason, now: this.clock.now() });
    const paymentStatus = reason === "failed" ? PaymentStatus.failed : PaymentStatus.cancelled;
    await transaction.order.update({ where: { id: orderId }, data: { paymentStatus } });
    await transaction.deposit.updateMany({ where: { orderId }, data: { status: paymentStatus } });
    await cancelPendingPayments(transaction, orderId);
    await this.domainEvents.append(transaction, {
      eventType: `checkout.${reason}`,
      aggregateType: "order",
      aggregateId: orderId,
      payload: { reason },
    });
  }

  private async recordCancellation(transaction: Prisma.TransactionClient, userId: string, kind: "ticket" | "booking", id: string, refundPending: boolean, orderId: string): Promise<void> {
    await this.domainEvents.append(transaction, {
      eventType: `${kind}.cancelled`,
      aggregateType: kind,
      aggregateId: id,
      payload: { userId, orderId, refundPending },
    });
    if (refundPending) {
      await this.domainEvents.append(transaction, {
        eventType: "refund.requested",
        aggregateType: "order",
        aggregateId: orderId,
        payload: { resourceType: kind, resourceId: id },
      });
    }
    await transaction.auditLog.create({
      data: { actorId: userId, action: `${kind}.cancelled`, entityType: kind, entityId: id, meta: { orderId, refundPending } },
    });
  }

  /** Expires one buyer-owned order if it is due. Used by the payment-status poll instead of a global sweep. */
  async expireOrderIfDue(userId: string, orderId: string): Promise<void> {
    const order = await this.database.order.findFirst({ where: { id: orderId, buyerUserId: userId }, select: { id: true, paymentStatus: true, expiresAt: true } });
    if (order) await this.expireIfDue(order);
  }

  private async expireIfDue(order: { id: string; paymentStatus: PaymentStatus; expiresAt: Date | null }): Promise<void> {
    if (order.paymentStatus === PaymentStatus.pending && order.expiresAt && order.expiresAt <= this.clock.now()) {
      await this.settleFailed(order.id, "expired");
    }
  }

  private async replayedCancellation(userId: string, operation: string, key: string): Promise<CancellationResponse | null> {
    const row = await this.database.idempotencyRecord.findUnique({ where: { userId_operation_key: { userId, operation, key } } });
    return row?.response ? cancellationResponse(row.response) : null;
  }

  private async resolveCancellationRace(error: unknown, userId: string, operation: string, key: string): Promise<CancellationResponse> {
    if (isUniqueError(error)) {
      const prior = await this.replayedCancellation(userId, operation, key);
      if (prior) return prior;
    }
    throw error;
  }
}

export const holdOrderSelect = {
  id: true, paymentStatus: true, expiresAt: true,
  payments: { select: { status: true } },
  booking: { select: { status: true, table: { select: { number: true, name: true, venueLayout: { select: { eventId: true } } } }, tableHold: { select: { status: true, expiresAt: true } } } },
  tickets: { select: { ticketType: { select: { eventId: true } } } },
  reservations: { select: { status: true, expiresAt: true, quantity: true, ticketType: { select: { eventId: true, name: true } } } },
  seatAllocations: { select: { status: true, seat: { select: { label: true, venueLayout: { select: { eventId: true } } } } } },
} satisfies Prisma.OrderSelect;

export type HoldOrder = Prisma.OrderGetPayload<{ select: typeof holdOrderSelect }>;

export async function ownedHoldOrder(database: Pick<Prisma.TransactionClient, "event" | "order">, organizerId: string, eventId: string, orderId: string): Promise<HoldOrder> {
  const event = await database.event.findFirst({ where: { id: eventId, organizerId }, select: { id: true } });
  if (!event) throw orderNotFound();
  const order = await database.order.findUnique({ where: { id: orderId }, select: holdOrderSelect });
  if (!order) throw orderNotFound();
  const memberships = [
    ...order.tickets.map((ticket) => ticket.ticketType.eventId),
    ...order.reservations.map((reservation) => reservation.ticketType.eventId),
    ...order.seatAllocations.map((allocation) => allocation.seat.venueLayout.eventId),
    ...(order.booking ? [order.booking.table.venueLayout.eventId] : []),
  ];
  if (!memberships.length || memberships.some((id) => id !== eventId)) throw orderNotFound();
  return order;
}

export function presentHoldPreview(order: HoldOrder, now: Date): ManagementHoldPreview {
  const resourceLabels = [
    ...(order.booking ? [`Стол ${order.booking.table.number}${order.booking.table.name ? ` · ${order.booking.table.name}` : ""}`] : []),
    ...order.reservations.filter((reservation) => reservation.status === TicketReservationStatus.active).map((reservation) => `${reservation.ticketType.name} · ${reservation.quantity} мест`),
    ...order.seatAllocations.filter((allocation) => allocation.status === SeatAllocationStatus.active).map((allocation) => allocation.seat.label),
  ];
  const expiries = [order.expiresAt, order.booking?.tableHold?.expiresAt, ...order.reservations.filter((reservation) => reservation.status === TicketReservationStatus.active).map((reservation) => reservation.expiresAt)].filter((value): value is Date => value instanceof Date);
  const expiresAt = expiries.length ? new Date(Math.min(...expiries.map((value) => value.getTime()))).toISOString() : null;
  const hasActiveHold = Boolean(order.booking?.tableHold?.status === TableHoldStatus.active || order.reservations.some((reservation) => reservation.status === TicketReservationStatus.active) || order.seatAllocations.some((allocation) => allocation.status === SeatAllocationStatus.active));
  const reason: ManagementHoldPreview["reason"] = order.payments.some((payment) => payment.status === PaymentStatus.paid) ? "payment_received"
    : order.paymentStatus !== PaymentStatus.pending ? order.paymentStatus === PaymentStatus.cancelled ? "released" : "not_pending"
    : expiresAt && new Date(expiresAt) <= now ? "expired"
    : hasActiveHold ? "active" : "no_active_hold";
  return { orderId: order.id, eligible: reason === "active", reason, expiresAt, resourceLabels };
}
export function cancellationTerms(resourceId: string, status: string, order: { amount: number; currency: string; paymentStatus: PaymentStatus; checkoutSnapshot: Prisma.JsonValue }): CancellationTermsResponse {
  const data = snapshot(order.checkoutSnapshot);
  return {
    resourceId,
    status,
    cancellationTerms: data.cancellationTerms,
    ...(data.acceptedPolicy?{acceptedPolicy:data.acceptedPolicy}:{}),
    paymentMode: data.paymentMode,
    amountPaid: order.paymentStatus === PaymentStatus.paid ? order.amount : 0,
    currency: order.currency.trim(),
  };
}
export async function ensureNotRefunding(transaction: Prisma.TransactionClient, orderId: string): Promise<void> {
  if (await transaction.staffRefund.findFirst({ where: { orderId, status: { in: ["requested", "processing"] } }, select: { id: true } })) throw new ConflictException({ code: "REFUND_IN_PROGRESS" });
  const refund = await transaction.refundRequest.findUnique({ where: { orderId }, select: { status: true } });
  if (refund && (refund.status === RefundStatus.requested || refund.status === RefundStatus.processing)) throw new ConflictException({ code: "REFUND_IN_PROGRESS", message: "This order is being refunded" });
}
export async function cancelPendingPayments(transaction: Prisma.TransactionClient, orderId: string): Promise<void> {
  await transaction.payment.updateMany({ where: { orderId, status: PaymentStatus.pending }, data: { status: PaymentStatus.cancelled } });
}
export function cancellationNotAllowed(code: string): ConflictException { return new ConflictException({ code, message: "Cancellation is not allowed in the current state" }); }
export function assertAcceptedCancellation(order:{paymentStatus:PaymentStatus;amount:number;checkoutSnapshot:Prisma.JsonValue}){const parsed=parseHistoricalPurchaseSnapshot(order.checkoutSnapshot);if(parsed.version===2&&order.paymentStatus===PaymentStatus.paid&&order.amount>0&&!parsed.snapshot.refund.available)throw new ConflictException({code:"REFUNDS_NOT_AVAILABLE",message:"The accepted policy does not allow monetary refunds; contact the organizer for an exception"});}