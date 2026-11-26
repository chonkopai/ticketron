import { orderEventsArePublished } from "../events/event-lifecycle-lock.js";
import { BookingStatus, OrderType, PaymentStatus, Prisma, SeatAllocationStatus, TableHoldStatus, TicketReservationStatus, TicketStatus, type PrismaClient } from "@event-platform/database";
import { ConflictException, HttpException, NotFoundException } from "@nestjs/common";
import { DomainEventsService } from "../domain-events/domain-events.service.js";
import { TablesService } from "../tables/tables.service.js";
import { lockOrder, lockTicketTypes } from "./inventory-locks.js";
import { type BookingClock } from "./booking.constants.js";
import type { NormalizedPaymentWebhook } from "./payment-provider.js";
import { snapshot, isUniqueError, orderNotFound } from "./booking-support.js";
import type { CancellationService } from "./cancellation.service.js";

/** Settlement: provider webhooks and paid-order settlement (split from BookingService). */
export class SettlementService {
  constructor(
    private readonly database: PrismaClient,
    private readonly tables: TablesService,
    private readonly domainEvents: DomainEventsService,
    private readonly clock: BookingClock,
    private readonly cancellation: CancellationService,
  ) {}

  async settleSucceeded(orderId: string): Promise<void> {
    await this.database.$transaction((transaction) => this.settleSucceededInTransaction(transaction, orderId), { timeout: 15_000 });
  }

  async settleSucceededInTransaction(transaction: Prisma.TransactionClient, orderId: string): Promise<void> {
    await lockOrder(transaction, orderId);
    const order = await transaction.order.findUnique({ where: { id: orderId }, include: { tickets: true, reservations: true, booking: { include: { tableHold: true } }, deposit: true } });
    if (!order) throw orderNotFound();
    if (order.paymentStatus === PaymentStatus.paid) return;
    if (order.paymentStatus !== PaymentStatus.pending || (order.expiresAt && order.expiresAt <= this.clock.now())) throw new ConflictException({ code: "CHECKOUT_NOT_PAYABLE", message: "Checkout is no longer payable" });
    if (!await orderEventsArePublished(transaction, orderId)) throw new ConflictException({ code: "EVENT_NOT_PUBLISHED", message: "This event no longer accepts payment settlement" });
    if (order.tickets.some(ticket => ticket.status !== TicketStatus.pending_payment)) {
      throw new ConflictException({ code: "CHECKOUT_SELECTION_CHANGED", message: "Checkout selection no longer matches the payment" });
    }
    if (order.type === OrderType.ticket) {
      const byType = new Map<string, number>();
      for (const ticket of order.tickets) byType.set(ticket.ticketTypeId, (byType.get(ticket.ticketTypeId) ?? 0) + 1);
      for (const ticketTypeId of [...byType.keys()].sort()) {
        const quantity = byType.get(ticketTypeId)!;
        await lockTicketTypes(transaction, [ticketTypeId]); // sorted, like every other ticket-type lock
        const ticketType = await transaction.ticketType.findUniqueOrThrow({ where: { id: ticketTypeId }, select: { isInternal: true } });
        if (!ticketType.isInternal) await transaction.ticketType.update({ where: { id: ticketTypeId }, data: { quantitySold: { increment: quantity } } });
      }
      await transaction.ticket.updateMany({ where: { orderId, status: TicketStatus.pending_payment }, data: { status: TicketStatus.active, paidAt: this.clock.now(), activatedAt: this.clock.now() } });
      await transaction.ticketReservation.updateMany({ where: { orderId, status: TicketReservationStatus.active }, data: { status: TicketReservationStatus.consumed } });
      await transaction.seatAllocation.updateMany({ where: { orderId, status: SeatAllocationStatus.active }, data: { status: SeatAllocationStatus.consumed, consumedAt: this.clock.now() } });
    }
    if (order.booking?.tableHold) {
      await this.tables.confirmInTransaction(transaction, order.booking.tableId, order.booking.tableHold.token, orderId, order.buyerUserId);
      await transaction.ticket.updateMany({ where: { orderId, status: TicketStatus.pending_payment }, data: { status: TicketStatus.active, paidAt: this.clock.now(), activatedAt: this.clock.now() } });
      await transaction.seatAllocation.updateMany({ where: { orderId, status: SeatAllocationStatus.active }, data: { status: SeatAllocationStatus.consumed, consumedAt: this.clock.now() } });
    }
    await transaction.order.update({ where: { id: orderId }, data: { paymentStatus: PaymentStatus.paid } });
    await transaction.deposit.updateMany({ where: { orderId }, data: { status: PaymentStatus.paid, paidAt: this.clock.now() } });
    await this.domainEvents.append(transaction, { eventType: "checkout.paid", aggregateType: "order", aggregateId: orderId, payload: { paymentMode: snapshot(order.checkoutSnapshot).paymentMode } });
    if (order.emailDeliveryAddress) await this.domainEvents.append(transaction, { eventType: "ticket.email_requested", aggregateType: "order", aggregateId: orderId, payload: {} });
  }

  /**
   * Payment transitions are monotonic. Failure/expiry events only act on a `pending` Payment; a captured (`paid`)
   * or `refunded` Payment never moves back, and the stale event is recorded as `ignored` with a reason. A success
   * on an order that can no longer be settled (expired, released, cancelled by staff, failed) is quarantined as
   * `payment.review_required` and stays refundable. Rejected events (unknown payment, order or amount mismatch)
   * are committed as `rejected` rows and re-evaluated when the provider redelivers them.
   */
  async handlePaymentWebhook(webhook: NormalizedPaymentWebhook): Promise<WebhookResult> {
    let outcome: { result: WebhookResult } | { rejected: HttpException };
    try {
      outcome = await this.database.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`webhook:${webhook.provider}:${webhook.eventId}`}, 0))`;
      const existing = await transaction.webhookEvent.findUnique({ where: { provider_providerEventId: { provider: webhook.provider, providerEventId: webhook.eventId } } });
      if (existing) {
        if (existing.payloadHash !== webhook.payloadHash) throw new ConflictException({ code: "PAYMENT_EVENT_CONFLICT", message: "Webhook event payload conflicts with an earlier event" });
        if (existing.status !== "processing" && existing.status !== "rejected") return { result: duplicateWebhook(existing) };
      }
      const claim = existing ?? await transaction.webhookEvent.create({ data: { provider: webhook.provider, providerEventId: webhook.eventId, eventType: webhook.eventType, payloadHash: webhook.payloadHash, ...(webhook.metadata ? { metadata: webhook.metadata as Prisma.InputJsonObject } : {}) } });
      const finish = (status: "processed" | "ignored", reason: string | null = null) => transaction.webhookEvent.update({ where: { id: claim.id }, data: { status, reason, processedAt: this.clock.now() } });
      const reject = async (error: HttpException, link: { paymentId: string | null; orderId: string | null }) => {
        await transaction.webhookEvent.update({ where: { id: claim.id }, data: { status: "rejected", reason: exceptionCode(error), processedAt: this.clock.now(), ...link } });
        return { rejected: error };
      };
      let payment = await transaction.payment.findFirst({ where: { provider: webhook.provider, providerPaymentId: webhook.providerPaymentId } });
      if (!payment) return reject(new NotFoundException({ code: "PAYMENT_NOT_FOUND", message: "Payment attempt was not found" }), { paymentId: null, orderId: null });
      if (webhook.orderId && webhook.orderId !== payment.orderId) return reject(new ConflictException({ code: "PAYMENT_ORDER_MISMATCH", message: "Payment does not belong to this order" }), { paymentId: payment.id, orderId: payment.orderId });
      if (payment.amount !== webhook.amount || payment.currency.trim().toUpperCase() !== webhook.currency.trim().toUpperCase()) return reject(new ConflictException({ code: "PAYMENT_AMOUNT_MISMATCH", message: "Payment amount or currency does not match" }), { paymentId: payment.id, orderId: payment.orderId });
      await transaction.webhookEvent.update({ where: { id: claim.id }, data: { paymentId: payment.id, orderId: payment.orderId } });
      await lockOrder(transaction, payment.orderId);
      payment=await transaction.payment.findUniqueOrThrow({where:{id:payment.id}});
      const order = await transaction.order.findUnique({ where: { id: payment.orderId }, include: { tickets: { select: { status: true } }, booking: { include: { tableHold: true } } } });
      if (!order) throw orderNotFound();
      const captured = { status: PaymentStatus.paid, payloadHash: webhook.payloadHash, ...(webhook.metadata ? { rawWebhook: webhook.metadata as Prisma.InputJsonObject } : {}), ...(payment.webhookReceivedAt?{}:{webhookReceivedAt:this.clock.now()}) };
      if (webhook.eventType === "payment.succeeded") {
        // A delayed duplicate of the original payment must not resurrect a refunded payment.
        if(payment.status===PaymentStatus.refunded){
          await finish("processed", "payment_already_refunded");
          return { result: { accepted:true as const,duplicate:true,reviewRequired:false } };
        }
        if (order.paymentStatus === PaymentStatus.paid) {
          await transaction.payment.update({ where: { id: payment.id }, data: captured });
          await finish("processed");
          return { result: { accepted: true as const, duplicate: false, reviewRequired: false } };
        }
        let reviewRequired = false;
        const eventUnavailable = !await orderEventsArePublished(transaction, order.id);
        const selectionChanged = order.tickets.some(ticket => ticket.status !== TicketStatus.pending_payment);
        const eligible = !eventUnavailable && !selectionChanged && order.paymentStatus === PaymentStatus.pending && (!order.expiresAt || order.expiresAt > this.clock.now()) && (!order.booking || (order.booking.status === BookingStatus.pending && order.booking.tableHold?.status === TableHoldStatus.active));
        if (eligible) {
          await this.settleSucceededInTransaction(transaction, order.id);
          await transaction.payment.update({ where: { id: payment.id }, data: captured });
          await this.domainEvents.append(transaction, { eventType: "payment.succeeded", aggregateType: "payment", aggregateId: payment.id, payload: { orderId: order.id, provider: webhook.provider, eventId: webhook.eventId } });
          await transaction.auditLog.create({ data: { actorId: order.buyerUserId, action: "payment.succeeded", entityType: "payment", entityId: payment.id, meta: { orderId: order.id, eventId: webhook.eventId } } });
        } else {
          // Quarantine: money was captured for an order that cannot be settled (late, released, cancelled or failed).
          // The Payment records the capture (pending/failed/cancelled → paid) so staff and organizer can refund it.
          reviewRequired = true;
          if (order.paymentStatus === PaymentStatus.pending && order.expiresAt && order.expiresAt <= this.clock.now()) {
            await this.cancellation.failOrderInTransaction(transaction, order.id, "expired");
          } else if (order.paymentStatus === PaymentStatus.pending && (selectionChanged || eventUnavailable)) {
            await this.cancellation.failOrderInTransaction(transaction, order.id, "released");
          }
          await transaction.payment.update({ where: { id: payment.id }, data: captured });
          const review = await transaction.outboxEvent.findFirst({ where: { eventType: "payment.review_required", aggregateId: order.id } });
          if (!review) {
            await this.domainEvents.append(transaction, { eventType: "payment.review_required", aggregateType: "order", aggregateId: order.id, payload: { provider: webhook.provider, providerPaymentId: webhook.providerPaymentId, reason: eventUnavailable ? "event_not_published" : selectionChanged ? "checkout_selection_changed" : "late_or_released_order" } });
            await transaction.auditLog.create({ data: { actorId: order.buyerUserId, action: "payment.review_required", entityType: "order", entityId: order.id, meta: { provider: webhook.provider, eventId: webhook.eventId } } });
          }
        }
        await finish(reviewRequired ? "ignored" : "processed");
        return { result: { accepted: true as const, duplicate: false, reviewRequired } };
      }
      // payment.failed / payment.expired: only a pending attempt can fail. paid/refunded/failed/cancelled stay put.
      if (payment.status !== PaymentStatus.pending) {
        await finish("ignored", `payment_already_${payment.status}`);
        return { result: { accepted: true as const, duplicate: false, reviewRequired: false } };
      }
      if (order.paymentStatus === PaymentStatus.paid) {
        await finish("ignored", "order_already_paid");
        return { result: { accepted: true as const, duplicate: false, reviewRequired: false } };
      }
      if (order.paymentStatus === PaymentStatus.pending) await this.cancellation.failOrderInTransaction(transaction, order.id, webhook.eventType === "payment.expired" ? "expired" : "failed");
      await transaction.payment.update({ where: { id: payment.id }, data: { status: PaymentStatus.failed, payloadHash: webhook.payloadHash, ...(webhook.metadata ? { rawWebhook: webhook.metadata as Prisma.InputJsonObject } : {}), webhookReceivedAt: this.clock.now() } });
      await this.domainEvents.append(transaction, { eventType: "payment.failed", aggregateType: "payment", aggregateId: payment.id, payload: { orderId: order.id, provider: webhook.provider, eventId: webhook.eventId } });
      await transaction.auditLog.create({ data: { actorId: order.buyerUserId, action: "payment.failed", entityType: "payment", entityId: payment.id, meta: { orderId: order.id, eventId: webhook.eventId } } });
      await finish("processed");
      return { result: { accepted: true as const, duplicate: false, reviewRequired: false } };
      }, { timeout: 15_000 });
    } catch (error) {
      if (isUniqueError(error)) {
        const existing = await this.database.webhookEvent.findUnique({ where: { provider_providerEventId: { provider: webhook.provider, providerEventId: webhook.eventId } } });
        if (existing?.payloadHash === webhook.payloadHash && existing.status !== "processing" && existing.status !== "rejected") return duplicateWebhook(existing);
      }
      throw error;
    }
    // The rejection row is committed; the provider still gets the 4xx so it redelivers.
    if ("rejected" in outcome) throw outcome.rejected;
    return outcome.result;
  }

}

export type WebhookResult = { accepted: true; duplicate: boolean; reviewRequired: boolean };
/** Only a quarantined success is stored as an ignored `payment.succeeded`; ignored failures are stale events. */
export function duplicateWebhook(existing: { status: string; eventType: string }): WebhookResult {
  return { accepted: true, duplicate: true, reviewRequired: existing.status === "ignored" && existing.eventType === "payment.succeeded" };
}
export function exceptionCode(error: HttpException): string {
  const response = error.getResponse();
  return (typeof response === "object" && response && "code" in response && typeof response.code === "string" ? response.code : error.name).slice(0, 80);
}