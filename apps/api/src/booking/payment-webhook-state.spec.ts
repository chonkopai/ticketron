import { databaseSuiteEnabled } from "@event-platform/database/test-database-guard";
import { randomBytes, randomUUID } from "node:crypto";
import { prisma, type Prisma } from "@event-platform/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DomainEventsService } from "../domain-events/domain-events.service.js";
import { EventsService } from "../events/events.service.js";
import type { ObjectStorage } from "../events/object-storage.js";
import { PaymentService } from "../payments/payment.service.js";
import { OrdersPaymentController } from "../payments/payments.controller.js";
import { StaffManagementService } from "../staff/staff-management.service.js";
import { StaffRefundsService } from "../staff/staff-refunds.service.js";
import { TablesService } from "../tables/tables.service.js";
import { TicketTypesService } from "../ticket-types/ticket-types.service.js";
import { approveEventsForTest } from "../test-support/approve-event.js";
import { BookingService } from "./booking.service.js";
import { DevelopmentPaymentProvider, type NormalizedPaymentWebhook, type PaymentLinkRequest, type PaymentWebhookType } from "./payment-provider.js";
import { RefundService } from "./refund.service.js";

// Payment × webhook transitions, money recovery for captured-but-unsettled payments,
// payment-link and expiry reconciliation. Runs only against a disposable PostgreSQL.
const testUrl = databaseSuiteEnabled("payment webhook state machine", "REGRESSION_TEST_DATABASE_URL", { urlFlag: true }) ? process.env.REGRESSION_TEST_DATABASE_URL : undefined;
if (testUrl && testUrl !== process.env.DATABASE_URL) throw new Error("Payment webhook regressions require REGRESSION_TEST_DATABASE_URL to equal DATABASE_URL");

const ownerId = randomUUID(), buyerId = randomUUID(), moderatorId = randomUUID(), supportId = randomUUID();
const eventIds: string[] = [], orderIds: string[] = [];
const START = new Date("2030-01-01T00:00:00Z");
let now = new Date(START);
const clock = { now: () => new Date(now) };
const later = (minutes: number) => { now = new Date(now.getTime() + minutes * 60_000); };
const domain = new DomainEventsService();
const provider = new DevelopmentPaymentProvider("http://localhost:3000", "payment-state-test-secret", 300, clock.now);
const types = new TicketTypesService(prisma, domain);
const tables = new TablesService(prisma, domain, { holdTtlSeconds: 600, cleanupIntervalSeconds: 60 }, clock);
const payments = new PaymentService(prisma, provider, domain, clock);
const booking = new BookingService(prisma, types, tables, domain, { checkoutTtlSeconds: 900, cleanupIntervalSeconds: 60 }, clock, payments);
const refunds = new RefundService(prisma, provider, domain, clock);
const staff = new StaffRefundsService(prisma, provider);
const events = new EventsService(prisma, {} as ObjectStorage, domain);
const controller = new OrdersPaymentController(payments, booking);
const support = { id: supportId, role: "support" as const, sessionId: randomUUID(), authenticated: true };
const moderator = { id: moderatorId, role: "moderator" as const, sessionId: randomUUID(), authenticated: true };

async function fixture() {
  const eventId = randomUUID(); eventIds.push(eventId);
  await prisma.event.create({ data: { id: eventId, organizerId: ownerId, title: "Payment webhook state", status: "published", date: new Date("2035-01-01"), time: new Date("1970-01-01T18:00:00Z"), timezone: "UTC", address: "Test", cancellationTerms: "Cancellation permitted" } });
  const layout = await prisma.venueLayout.create({ data: { eventId, templateName: "Test", layoutJson: { version: 1, canvas: { width: 800, height: 600 }, tables: [] } } });
  const type = await prisma.ticketType.create({ data: { eventId, name: randomUUID(), price: 1000, currency: "KZT", quantityTotal: 100, status: "active" } });
  await approveEventsForTest(prisma, eventId);
  return { eventId, layoutId: layout.id, typeId: type.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function ticket(f: Fixture, quantity = 1) {
  const order = await booking.checkoutTickets(buyerId, randomUUID(), { ticketTypeId: f.typeId, quantity, termsAccepted: true });
  orderIds.push(order.orderId); return order;
}
async function table(f: Fixture) {
  const resource = await tables.create(ownerId, f.layoutId, { number: 1, seats: 2, price: 1000, geometry: { x: 20, y: 20, width: 60, height: 60 } });
  await approveEventsForTest(prisma, f.eventId);
  const order = await booking.checkoutTable(buyerId, randomUUID(), { tableId: resource.id, termsAccepted: true });
  orderIds.push(order.orderId); return { ...order, tableId: resource.id };
}
async function callback(orderId: string, eventType: PaymentWebhookType = "payment.succeeded", overrides: Partial<NormalizedPaymentWebhook> = {}): Promise<NormalizedPaymentWebhook> {
  const attempt = await prisma.payment.findFirstOrThrow({ where: { orderId } });
  return { provider: "mock", eventId: randomUUID(), eventType, orderId, providerPaymentId: attempt.providerPaymentId!, amount: attempt.amount, currency: attempt.currency, occurredAt: clock.now(), payloadHash: randomUUID(), ...overrides };
}
const handle = (webhook: NormalizedPaymentWebhook) => booking.handlePaymentWebhook(webhook);
const paymentOf = (orderId: string) => prisma.payment.findFirstOrThrow({ where: { orderId } });
const orderOf = (orderId: string) => prisma.order.findUniqueOrThrow({ where: { id: orderId } });
const webhookRows = (eventId: string) => prisma.webhookEvent.findMany({ where: { provider: "mock", providerEventId: eventId } });
const reviews = (orderId: string) => prisma.outboxEvent.count({ where: { aggregateId: orderId, eventType: "payment.review_required" } });
const staffRefund = (orderId: string, actor = support) => staff.request(actor, orderId, { key: randomUUID(), reason: "Return money captured for an unsettled order" });

async function expectRefundedByStaff(orderId: string, eventId: string) {
  expect(await refunds.quote(ownerId, eventId, orderId)).toMatchObject({ eligible: true, reason: "available" });
  expect(await staff.quote(orderId)).toMatchObject({ reason: null });
  expect(await staffRefund(orderId)).toMatchObject({ status: "succeeded" });
  expect(await orderOf(orderId)).toMatchObject({ paymentStatus: "refunded" });
  expect(await paymentOf(orderId)).toMatchObject({ status: "refunded" });
  expect(await prisma.ticket.count({ where: { orderId, status: { not: "refunded" } } })).toBe(0);
}

(testUrl ? describe : describe.skip)("payment webhook state machine (disposable PostgreSQL)", () => {
  beforeAll(async () => {
    await prisma.user.createMany({ data: [{ id: ownerId, role: "organizer" }, { id: buyerId, role: "guest" }] });
    await prisma.staffAccount.createMany({ data: [
      { id: moderatorId, name: "Test moderator", email: `${moderatorId}@example.test`, role: "moderator" },
      { id: supportId, name: "Test support", email: `${supportId}@example.test`, role: "support" },
    ] });
  });
  beforeEach(() => { now = new Date(START); });
  afterAll(async () => {
    await prisma.idempotencyRecord.deleteMany({ where: { userId: buyerId } });
    await prisma.staffRefund.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.refundRequest.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.webhookEvent.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.event.deleteMany({ where: { id: { in: eventIds } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: [ownerId, buyerId] } } });
    // Staff audit rows are append-only; staff accounts stay until the disposable DB is dropped.
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, buyerId] } } });
    await prisma.$disconnect();
  });

  // Late capture after expiry, then a stale expiry event.
  it("keeps a late capture paid and refundable when a stale payment.expired follows it", async () => {
    const f = await fixture(), order = await ticket(f), success = await callback(order.orderId);
    later(16);
    expect(await handle(success)).toMatchObject({ duplicate: false, reviewRequired: true });
    expect(await orderOf(order.orderId)).toMatchObject({ paymentStatus: "cancelled" });
    const stale = await callback(order.orderId, "payment.expired");
    expect(await handle(stale)).toMatchObject({ duplicate: false, reviewRequired: false });
    const payment = await paymentOf(order.orderId);
    expect(payment).toMatchObject({ status: "paid" });
    expect(await webhookRows(stale.eventId)).toMatchObject([{ status: "ignored", reason: "payment_already_paid", paymentId: payment.id }]);
    expect(await prisma.outboxEvent.count({ where: { aggregateId: payment.id, eventType: "payment.failed" } })).toBe(0);
    // Replays are idempotent.
    expect(await handle(stale)).toMatchObject({ duplicate: true, reviewRequired: false });
    expect(await handle(success)).toMatchObject({ duplicate: true, reviewRequired: true });
    expect(await paymentOf(order.orderId)).toMatchObject({ status: "paid" });
    expect(await reviews(order.orderId)).toBe(1);
    await expectRefundedByStaff(order.orderId, f.eventId);
    expect(await prisma.ticketType.findUniqueOrThrow({ where: { id: f.typeId } })).toMatchObject({ quantitySold: 0 });
  });

  // Refund history must survive a late failure.
  it("keeps a refunded payment refunded when a late payment.failed arrives", async () => {
    const f = await fixture(), order = await ticket(f);
    await handle(await callback(order.orderId));
    // A second success (new event id) on a settled order changes nothing.
    expect(await handle(await callback(order.orderId))).toMatchObject({ duplicate: false, reviewRequired: false });
    expect(await paymentOf(order.orderId)).toMatchObject({ status: "paid" });
    expect(await refunds.request(ownerId, f.eventId, order.orderId, "Organizer refunded the order")).toMatchObject({ status: "succeeded" });
    const late = await callback(order.orderId, "payment.failed");
    expect(await handle(late)).toMatchObject({ duplicate: false, reviewRequired: false });
    expect(await paymentOf(order.orderId)).toMatchObject({ status: "refunded" });
    expect(await orderOf(order.orderId)).toMatchObject({ paymentStatus: "refunded" });
    expect(await webhookRows(late.eventId)).toMatchObject([{ status: "ignored", reason: "payment_already_refunded" }]);
    expect(await handle(late)).toMatchObject({ duplicate: true, reviewRequired: false });
    // A late success after the refund does not resurrect the capture either.
    await handle(await callback(order.orderId));
    expect(await paymentOf(order.orderId)).toMatchObject({ status: "refunded" });
  });

  // Failure, then a success on the same provider session.
  it("quarantines a success that follows payment.failed and keeps it refundable", async () => {
    const f = await fixture(), order = await ticket(f);
    const failed = await callback(order.orderId, "payment.failed"), success = await callback(order.orderId);
    expect(await handle(failed)).toMatchObject({ duplicate: false, reviewRequired: false });
    expect(await orderOf(order.orderId)).toMatchObject({ paymentStatus: "failed" });
    expect(await paymentOf(order.orderId)).toMatchObject({ status: "failed" });
    expect(await handle(success)).toMatchObject({ duplicate: false, reviewRequired: true });
    expect(await paymentOf(order.orderId)).toMatchObject({ status: "paid" });
    expect(await orderOf(order.orderId)).toMatchObject({ paymentStatus: "failed" });
    expect(await reviews(order.orderId)).toBe(1);
    // Replays, and a second stale failure with a new event id, change nothing.
    expect(await handle(failed)).toMatchObject({ duplicate: true, reviewRequired: false });
    expect(await handle(success)).toMatchObject({ duplicate: true, reviewRequired: true });
    expect(await handle(await callback(order.orderId, "payment.failed"))).toMatchObject({ duplicate: false, reviewRequired: false });
    expect(await paymentOf(order.orderId)).toMatchObject({ status: "paid" });
    // A second success (new event id) on the quarantined order adds no second review.
    expect(await handle(await callback(order.orderId))).toMatchObject({ duplicate: false, reviewRequired: true });
    expect(await reviews(order.orderId)).toBe(1);
    expect(await events.managementOrderDetail(ownerId, f.eventId, order.orderId)).toMatchObject({ reviewRequired: true, payment: { status: "failed" } });
    await expectRefundedByStaff(order.orderId, f.eventId);
  });

  // Staff cancels a pending order, then the buyer's payment lands.
  it("quarantines a late success after staff cancelled the pending order, and staff can refund it", async () => {
    const f = await fixture(), order = await ticket(f), success = await callback(order.orderId);
    const management = new StaffManagementService(prisma, {} as never, booking, {} as never);
    expect(await management.cancelUnpaid(moderator, order.orderId, randomUUID(), "Buyer asked support to cancel")).toMatchObject({ cancelled: true });
    expect(await orderOf(order.orderId)).toMatchObject({ paymentStatus: "cancelled" });
    expect(await paymentOf(order.orderId)).toMatchObject({ status: "cancelled" });
    const expired = await callback(order.orderId, "payment.expired");
    expect(await handle(expired)).toMatchObject({ duplicate: false, reviewRequired: false });
    expect(await webhookRows(expired.eventId)).toMatchObject([{ status: "ignored", reason: "payment_already_cancelled" }]);
    expect(await paymentOf(order.orderId)).toMatchObject({ status: "cancelled" });
    expect(await handle(success)).toMatchObject({ duplicate: false, reviewRequired: true });
    expect(await paymentOf(order.orderId)).toMatchObject({ status: "paid" });
    expect(await reviews(order.orderId)).toBe(1);
    expect(await events.managementOrderDetail(ownerId, f.eventId, order.orderId)).toMatchObject({ reviewRequired: true });
    await expectRefundedByStaff(order.orderId, f.eventId);
  });

  it("expires a pending order on provider payment.expired, then ignores a later failure for the failed attempt", async () => {
    const f = await fixture(), order = await ticket(f);
    const expired = await callback(order.orderId, "payment.expired");
    expect(await handle(expired)).toMatchObject({ duplicate: false, reviewRequired: false });
    expect(await orderOf(order.orderId)).toMatchObject({ paymentStatus: "cancelled" });
    expect(await paymentOf(order.orderId)).toMatchObject({ status: "failed" });
    expect(await webhookRows(expired.eventId)).toMatchObject([{ status: "processed", reason: null }]);
    const again = await callback(order.orderId, "payment.failed");
    expect(await handle(again)).toMatchObject({ duplicate: false, reviewRequired: false });
    expect(await webhookRows(again.eventId)).toMatchObject([{ status: "ignored", reason: "payment_already_failed" }]);
    expect(await prisma.outboxEvent.count({ where: { aggregateId: (await paymentOf(order.orderId)).id, eventType: "payment.failed" } })).toBe(1);
    expect(await handle(expired)).toMatchObject({ duplicate: true, reviewRequired: false });
  });

  it("does not let staff refund a paid Payment on a cancelled order without a review_required record", async () => {
    const f = await fixture(), order = await ticket(f);
    await handle(await callback(order.orderId));
    await prisma.order.update({ where: { id: order.orderId }, data: { paymentStatus: "cancelled" } });
    await expect(staffRefund(order.orderId)).rejects.toMatchObject({ response: { code: "REFUND_PAYMENT_UNVERIFIED" } });
  });

  // Rejected webhooks leave a durable row and stay retryable.
  it("records rejected webhooks with a reason and re-evaluates them on redelivery", async () => {
    const f = await fixture(), order = await ticket(f), attempt = await paymentOf(order.orderId);
    const mismatch = await callback(order.orderId, "payment.succeeded", { amount: attempt.amount + 1 });
    await expect(handle(mismatch)).rejects.toMatchObject({ response: { code: "PAYMENT_AMOUNT_MISMATCH" } });
    expect(await webhookRows(mismatch.eventId)).toMatchObject([{ status: "rejected", reason: "PAYMENT_AMOUNT_MISMATCH", paymentId: attempt.id, orderId: order.orderId }]);
    await expect(handle(mismatch)).rejects.toMatchObject({ response: { code: "PAYMENT_AMOUNT_MISMATCH" } });
    expect(await webhookRows(mismatch.eventId)).toHaveLength(1);
    const foreign = await callback(order.orderId, "payment.succeeded", { orderId: randomUUID() });
    await expect(handle(foreign)).rejects.toMatchObject({ response: { code: "PAYMENT_ORDER_MISMATCH" } });
    expect(await webhookRows(foreign.eventId)).toMatchObject([{ status: "rejected", reason: "PAYMENT_ORDER_MISMATCH", paymentId: attempt.id }]);
    expect(await orderOf(order.orderId)).toMatchObject({ paymentStatus: "pending" });
    expect(await paymentOf(order.orderId)).toMatchObject({ status: "pending" });
    // Unknown provider payment id: rejected, then processed once the link is saved.
    const unknown = await callback(order.orderId, "payment.succeeded", { providerPaymentId: `dev-${randomUUID()}` });
    await expect(handle(unknown)).rejects.toMatchObject({ response: { code: "PAYMENT_NOT_FOUND" } });
    expect(await webhookRows(unknown.eventId)).toMatchObject([{ status: "rejected", reason: "PAYMENT_NOT_FOUND", paymentId: null }]);
    await prisma.payment.update({ where: { id: attempt.id }, data: { providerPaymentId: unknown.providerPaymentId } });
    expect(await handle(unknown)).toMatchObject({ duplicate: false, reviewRequired: false });
    expect(await webhookRows(unknown.eventId)).toMatchObject([{ status: "processed", reason: null }]);
    expect(await orderOf(order.orderId)).toMatchObject({ paymentStatus: "paid" });
  });

  // Payment rows follow the order outcome.
  it("cancels the pending Payment when the order expires or the buyer cancels it", async () => {
    const f = await fixture();
    const expiring = await ticket(f);
    later(16);
    await booking.expireDueCheckouts(500);
    expect(await orderOf(expiring.orderId)).toMatchObject({ paymentStatus: "cancelled" });
    expect(await paymentOf(expiring.orderId)).toMatchObject({ status: "cancelled" });
    now = new Date(START);
    const single = await ticket(f);
    await booking.cancelTicket(buyerId, single.ticketIds[0]!, randomUUID());
    expect(await orderOf(single.orderId)).toMatchObject({ paymentStatus: "cancelled" });
    expect(await paymentOf(single.orderId)).toMatchObject({ status: "cancelled" });
    const held = await table(f);
    await booking.cancelBooking(buyerId, held.bookingId!, randomUUID());
    expect(await orderOf(held.orderId)).toMatchObject({ paymentStatus: "cancelled" });
    expect(await paymentOf(held.orderId)).toMatchObject({ status: "cancelled" });
  });

  it("settles a zero-amount /pay without creating a pending Payment, and replays it", async () => {
    const f = await fixture(), template = await orderOf((await ticket(f)).orderId);
    const free = await prisma.ticketType.create({ data: { eventId: f.eventId, name: randomUUID(), price: 0, currency: "KZT", quantityTotal: 10, status: "active" } });
    await approveEventsForTest(prisma, f.eventId);
    const orderId = randomUUID(); orderIds.push(orderId);
    await prisma.order.create({ data: { id: orderId, type: "ticket", amount: 0, currency: "KZT", paymentStatus: "pending", buyerUserId: buyerId, expiresAt: new Date(now.getTime() + 15 * 60_000), checkoutSnapshot: template.checkoutSnapshot as Prisma.InputJsonObject } });
    await prisma.ticket.create({ data: { orderId, ticketTypeId: free.id, qrToken: randomBytes(32).toString("base64url"), status: "pending_payment" } });
    const key = randomUUID(), principal = { userId: buyerId } as never;
    expect(await controller.pay(principal, orderId, key)).toMatchObject({ amount: 0, status: "paid" });
    expect(await orderOf(orderId)).toMatchObject({ paymentStatus: "paid" });
    expect(await prisma.payment.count({ where: { orderId } })).toBe(0);
    expect(await controller.pay(principal, orderId, key)).toMatchObject({ amount: 0, status: "paid" });
    expect(await prisma.payment.count({ where: { orderId } })).toBe(0);
  });

  // No payment link for an order that is no longer payable.
  it("refuses to replay a payment link after the order expired", async () => {
    const f = await fixture(), order = await ticket(f), key = randomUUID();
    expect((await payments.createLink(buyerId, order.orderId, key)).paymentLink).toMatch(/^http/);
    later(16);
    await expect(payments.createLink(buyerId, order.orderId, key)).rejects.toMatchObject({ response: { code: "ORDER_NOT_PAYABLE" } });
  });

  it("does not save a payment link when the order expires while the provider call is in flight", async () => {
    const f = await fixture(), order = await ticket(f);
    await prisma.payment.updateMany({ where: { orderId: order.orderId }, data: { paymentLink: null, providerPaymentId: null } });
    class ExpiringProvider extends DevelopmentPaymentProvider {
      override async createPaymentLink(input: PaymentLinkRequest) {
        await booking.settleFailed(input.orderId, "expired");
        return super.createPaymentLink(input);
      }
    }
    const racing = new PaymentService(prisma, new ExpiringProvider("http://localhost:3000", "payment-state-test-secret", 300, clock.now), domain, clock);
    await expect(racing.createLink(buyerId, order.orderId, randomUUID())).rejects.toMatchObject({ response: { code: "ORDER_NOT_PAYABLE" } });
    expect(await paymentOf(order.orderId)).toMatchObject({ paymentLink: null, status: "cancelled" });
  });

  // Buyer cancellation waits for an organizer refund in flight.
  it("refuses buyer cancellation while an organizer RefundRequest is requested or processing", async () => {
    const f = await fixture(), order = await ticket(f);
    await handle(await callback(order.orderId));
    const payment = await paymentOf(order.orderId);
    const request = await prisma.refundRequest.create({ data: { orderId: order.orderId, paymentId: payment.id, organizerId: ownerId, provider: "mock", requestKey: `refund:${order.orderId}`, amount: payment.amount, currency: "KZT", reason: "Organizer refund in flight", status: "processing" } });
    await expect(booking.cancelTicket(buyerId, order.ticketIds[0]!, randomUUID())).rejects.toMatchObject({ response: { code: "REFUND_IN_PROGRESS" } });
    expect(await prisma.ticket.findUniqueOrThrow({ where: { id: order.ticketIds[0]! } })).toMatchObject({ status: "active" });
    await prisma.refundRequest.update({ where: { id: request.id }, data: { status: "failed" } });
    expect(await booking.cancelTicket(buyerId, order.ticketIds[0]!, randomUUID())).toMatchObject({ cancelled: true });

    const held = await table(f);
    await handle(await callback(held.orderId));
    const tablePayment = await paymentOf(held.orderId);
    await prisma.refundRequest.create({ data: { orderId: held.orderId, paymentId: tablePayment.id, organizerId: ownerId, provider: "mock", requestKey: `refund:${held.orderId}`, amount: tablePayment.amount, currency: "KZT", reason: "Organizer refund in flight", status: "requested" } });
    await expect(booking.cancelBooking(buyerId, held.bookingId!, randomUUID())).rejects.toMatchObject({ response: { code: "REFUND_IN_PROGRESS" } });
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: held.bookingId! } })).toMatchObject({ status: "confirmed" });
  });

  // The status poll expires only the polled order.
  it("expires only the polled order on GET /orders/:id/payment-status", async () => {
    const f = await fixture(), polled = await ticket(f), other = await ticket(f);
    later(16);
    expect(await controller.status({ userId: buyerId } as never, polled.orderId)).toMatchObject({ status: "cancelled" });
    expect(await orderOf(polled.orderId)).toMatchObject({ paymentStatus: "cancelled" });
    expect(await paymentOf(polled.orderId)).toMatchObject({ status: "cancelled" });
    expect(await orderOf(other.orderId)).toMatchObject({ paymentStatus: "pending" });
  });
});
