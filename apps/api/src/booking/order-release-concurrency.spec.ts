import { databaseSuiteEnabled } from "@event-platform/database/test-database-guard";
import { randomUUID } from "node:crypto";
import { prisma, type PrismaClient } from "@event-platform/database";
import { editorHallV3, newHallObject } from "@event-platform/shared-types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { persistCanonicalHall } from "../creation-drafts/creation-sale.persistence.js";
import { DomainEventsService } from "../domain-events/domain-events.service.js";
import { PaymentService } from "../payments/payment.service.js";
import { StaffManagementService } from "../staff/staff-management.service.js";
import { TablesService } from "../tables/tables.service.js";
import { TicketTypesService } from "../ticket-types/ticket-types.service.js";
import { approveEventsForTest } from "../test-support/approve-event.js";
import { BookingService } from "./booking.service.js";
import { DevelopmentPaymentProvider } from "./payment-provider.js";
import { RefundService } from "./refund.service.js";

// Order release under concurrency and the shared release lock order.
// Interleavings are forced with query hooks and advisory locks, never with sleeps on the code under test.
const testUrl = databaseSuiteEnabled("order release concurrency", "REGRESSION_TEST_DATABASE_URL", { urlFlag: true }) ? process.env.REGRESSION_TEST_DATABASE_URL : undefined;
if (testUrl && testUrl !== process.env.DATABASE_URL) throw new Error("Order release concurrency tests require REGRESSION_TEST_DATABASE_URL to equal DATABASE_URL");

const ownerId = randomUUID(), buyerId = randomUUID(), moderatorId = randomUUID();
const eventIds: string[] = [];
const T0 = new Date("2030-01-01T00:00:00Z");
const at = (seconds: number) => ({ now: () => new Date(T0.getTime() + seconds * 1_000) });
const clock = at(0);
const domain = new DomainEventsService();
const provider = new DevelopmentPaymentProvider("http://localhost:3000", "order-release-concurrency-secret", 300, clock.now);
const types = new TicketTypesService(prisma, domain);
const tablesAt = (c: { now: () => Date }) => new TablesService(prisma, domain, { holdTtlSeconds: 600, cleanupIntervalSeconds: 60 }, c);
const payments = new PaymentService(prisma, provider, domain, clock);
const service = (db: PrismaClient = prisma, c = clock) => new BookingService(db, types, tablesAt(c), domain, { checkoutTtlSeconds: 900, cleanupIntervalSeconds: 60 }, c, payments);
const booking = service();
const refunds = new RefundService(prisma, provider, domain, clock);
const moderator = { id: moderatorId, role: "moderator" as const, sessionId: randomUUID(), authenticated: true };

type Gate = { reached: Promise<void>; wasReached: () => boolean; open: () => void; opened: Promise<void>; hit: () => void };
function gate(): Gate {
  let open!: () => void, hit!: () => void, reachedFlag = false;
  const opened = new Promise<void>(resolve => { open = resolve; });
  const reached = new Promise<void>(resolve => { hit = resolve; });
  return { reached, opened, open, wasReached: () => reachedFlag, hit: () => { reachedFlag = true; hit(); } };
}

/** A client that pauses (once) right after the first matching query returns, until the gate opens. */
function pausing(model: string, operation: string, match: (args: unknown) => boolean, g: Gate): PrismaClient {
  let fired = false;
  return prisma.$extends({ query: { $allModels: { async $allOperations({ model: current, operation: op, args, query }) {
    const result = await query(args);
    if (!fired && current === model && op === operation && match(args)) { fired = true; g.hit(); await g.opened; }
    return result;
  } } } }) as unknown as PrismaClient;
}
const whereId = (id: string) => (args: unknown) => (args as { where?: { id?: string } }).where?.id === id;

/** Resolves "done" when the condition holds first, "blocked" when another backend is waiting on a lock first. */
async function untilBlockedOr(done: () => boolean): Promise<"done" | "blocked"> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (done()) return "done";
    const [row] = await prisma.$queryRaw<Array<{ waiting: number }>>`SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (row!.waiting > 0) return "blocked";
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Interleaving did not settle");
}
const settle = <T,>(promise: Promise<T>) => promise.then(value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));

async function fixture(price = 1000) {
  const eventId = randomUUID(); eventIds.push(eventId);
  await prisma.event.create({ data: { id: eventId, organizerId: ownerId, title: "Order release concurrency", status: "published", date: new Date("2035-01-01"), time: new Date("1970-01-01T18:00:00Z"), timezone: "UTC", address: "Test venue", description: "Test", cancellationTerms: "Cancellations permitted", paymentMode: "full_payment" } });
  const layout = await prisma.venueLayout.create({ data: { eventId, templateName: "Test", layoutJson: { version: 1, canvas: { width: 800, height: 600 }, tables: [] } } });
  const type = await prisma.ticketType.create({ data: { eventId, name: randomUUID(), price, currency: "KZT", quantityTotal: 50, status: "active" } });
  await approveEventsForTest(prisma, eventId);
  return { eventId, layoutId: layout.id, typeId: type.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function newTable(f: Fixture, price = 1000) {
  const table = await tablesAt(clock).create(ownerId, f.layoutId, { number: Math.floor(Math.random() * 1_000_000) + 1, seats: 2, price, geometry: { x: 20, y: 20, width: 60, height: 60 } });
  await approveEventsForTest(prisma, f.eventId);
  return table.id;
}
async function pay(orderId: string) {
  const attempt = await prisma.payment.findFirstOrThrow({ where: { orderId } });
  await booking.handlePaymentWebhook({ provider: "mock", eventId: randomUUID(), eventType: "payment.succeeded", providerPaymentId: attempt.providerPaymentId!, orderId, amount: attempt.amount, currency: "KZT", payloadHash: randomUUID(), occurredAt: clock.now() });
}

(testUrl ? describe : describe.skip)("order release concurrency (isolated PostgreSQL)", () => {
  beforeAll(async () => {
    await prisma.user.createMany({ data: [{ id: ownerId, role: "organizer" }, { id: buyerId, role: "guest" }] });
    await prisma.staffAccount.create({ data: { id: moderatorId, name: "Test moderator", email: `${moderatorId}@example.test`, role: "moderator" } });
  });
  afterAll(async () => {
    await prisma.idempotencyRecord.deleteMany({ where: { userId: buyerId } });
    await prisma.$disconnect();
  });

  it("a checkout never commits a price that was replaced before its order", async () => {
    const f = await fixture(1000);
    const g = gate();
    const checkout = settle(service(pausing("TicketType", "findFirst", whereId(f.typeId), g)).checkoutTickets(buyerId, randomUUID(), { ticketTypeId: f.typeId, quantity: 1, termsAccepted: true }));
    await g.reached;
    let writerDone = false;
    // The real price writer, then a re-approval: the narrow window the approval trigger leaves open.
    const writer = types.update(ownerId, f.typeId, { price: 2000 }).then(() => approveEventsForTest(prisma, f.eventId)).then(() => { writerDone = true; });
    const order = await untilBlockedOr(() => writerDone);
    g.open();
    const result = await checkout; await writer;
    // The checkout commits its order; the later payment-link step may meet the writer's approval reset (409), which is fine.
    if (!result.ok) expect((result.error as { response?: { code?: string } }).response?.code).toBe("EVENT_SALES_PAUSED");
    const saved = await prisma.order.findFirstOrThrow({ where: { tickets: { some: { ticketTypeId: f.typeId } } } });
    // The writer either committed first (the checkout must see 2000) or waited for the checkout (1000 is then correct).
    expect(saved.amount).toBe(order === "done" ? 2000 : 1000);
  });

  it("a whole-table checkout never commits a replaced table price", async () => {
    const f = await fixture();
    const tableId = await newTable(f, 1000);
    const g = gate();
    const checkout = settle(service(pausing("Table", "findFirst", whereId(tableId), g)).checkoutTable(buyerId, randomUUID(), { tableId, termsAccepted: true }));
    await g.reached;
    let writerDone = false;
    // Once the checkout holds the table, the writer must refuse (TABLE_STATE_LOCKED) instead of repricing it.
    const writer = tablesAt(clock).update(ownerId, tableId, { price: 3000 }).then(() => approveEventsForTest(prisma, f.eventId), (error: { response?: { code?: string } }) => { expect(error.response?.code).toBe("TABLE_STATE_LOCKED"); }).then(() => { writerDone = true; });
    const order = await untilBlockedOr(() => writerDone);
    g.open();
    const result = await checkout; await writer;
    // The checkout commits its order; the later payment-link step may meet the writer's approval reset (409), which is fine.
    if (!result.ok) expect((result.error as { response?: { code?: string } }).response?.code).toBe("EVENT_SALES_PAUSED");
    const saved = await prisma.order.findFirstOrThrow({ where: { booking: { tableId } } });
    expect(saved.amount).toBe(order === "done" ? 3000 : 1000);
  });

  it("two carts with the same ticket types in reverse order both complete", async () => {
    const f = await fixture();
    const second = await prisma.ticketType.create({ data: { eventId: f.eventId, name: randomUUID(), price: 500, currency: "KZT", quantityTotal: 50, status: "active" } });
    await approveEventsForTest(prisma, f.eventId);
    const first = gate(), other = gate();
    const reservation = () => true;
    const a = settle(service(pausing("TicketReservation", "create", reservation, first)).checkoutCart(buyerId, randomUUID(), { eventId: f.eventId, tickets: [{ ticketTypeId: f.typeId, quantity: 1 }, { ticketTypeId: second.id, quantity: 1 }], seatIds: [], termsAccepted: true }));
    await first.reached;
    const b = settle(service(pausing("TicketReservation", "create", reservation, other)).checkoutCart(buyerId, randomUUID(), { eventId: f.eventId, tickets: [{ ticketTypeId: second.id, quantity: 1 }, { ticketTypeId: f.typeId, quantity: 1 }], seatIds: [], termsAccepted: true }));
    await untilBlockedOr(other.wasReached);
    first.open(); other.open();
    const results = await Promise.all([a, b]);
    expect(results.map(result => result.ok ? "ok" : String((result.error as { message?: string }).message).slice(0, 200))).toEqual(["ok", "ok"]);
    expect(await prisma.ticket.count({ where: { ticketTypeId: { in: [f.typeId, second.id] } } })).toBe(4);
  });

  it("settlement locks ticket types in sorted order", async () => {
    const f = await fixture();
    const second = await prisma.ticketType.create({ data: { eventId: f.eventId, name: randomUUID(), price: 500, currency: "KZT", quantityTotal: 50, status: "active" } });
    await approveEventsForTest(prisma, f.eventId);
    // Tickets are created in input order: the larger id first, so an unsorted settlement locks it first.
    const [low, high] = [f.typeId, second.id].sort();
    const order = await booking.checkoutCart(buyerId, randomUUID(), { eventId: f.eventId, tickets: [{ ticketTypeId: high!, quantity: 1 }, { ticketTypeId: low!, quantity: 1 }], seatIds: [], termsAccepted: true });
    let settled = false;
    let result!: Promise<{ ok: boolean }>;
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`ticket-type:${low}`}, 0))`;
      result = settle(pay(order.orderId)).then(value => { settled = true; return value; });
      expect(await untilBlockedOr(() => settled)).toBe("blocked");
      // The settlement waits on the lower id; it must not already hold the higher one.
      const [held] = await tx.$queryRaw<Array<{ free: boolean }>>`SELECT pg_try_advisory_lock(hashtextextended(${`ticket-type:${high}`}, 0)) AS free`;
      if (held!.free) await tx.$queryRaw`SELECT pg_advisory_unlock(hashtextextended(${`ticket-type:${high}`}, 0))`;
      expect(held!.free).toBe(true);
    }, { timeout: 15_000 });
    expect((await result).ok).toBe(true);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.orderId } })).toMatchObject({ paymentStatus: "paid" });
  });

  it("table-hold expiry waits for a settlement that already passed its expiry check", async () => {
    const f = await fixture();
    const tableId = await newTable(f);
    const order = await booking.checkoutTable(buyerId, randomUUID(), { tableId, termsAccepted: true });
    const g = gate();
    // Settlement at T+599s holds the order lock and has read the order; expiry runs at T+601s.
    const settling = settle(service(pausing("Order", "findUnique", whereId(order.orderId), g), at(599)).settleSucceeded(order.orderId));
    await g.reached;
    let expired = false;
    const expiry = settle(tablesAt(at(601)).expireLayoutHolds(f.layoutId)).then(value => { expired = true; return value; });
    await untilBlockedOr(() => expired);
    g.open();
    const [settlement, expiration] = await Promise.all([settling, expiry]);
    expect(settlement.ok ? "ok" : (settlement.error as { response?: { code?: string } }).response?.code ?? String(settlement.error)).toBe("ok");
    expect(expiration.ok).toBe(true);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.orderId } })).toMatchObject({ paymentStatus: "paid" });
    expect(await prisma.booking.findUniqueOrThrow({ where: { orderId: order.orderId } })).toMatchObject({ status: "confirmed" });
    expect(await prisma.table.findUniqueOrThrow({ where: { id: tableId } })).toMatchObject({ status: "booked" });
    expect(await prisma.ticket.count({ where: { orderId: order.orderId, status: "active" } })).toBe(2);
  });

  it("table-hold expiry still expires an unpaid hold and releases its order inventory", async () => {
    const f = await fixture();
    const tableId = await newTable(f);
    const order = await booking.checkoutTable(buyerId, randomUUID(), { tableId, termsAccepted: true });
    expect(await tablesAt(at(601)).expireLayoutHolds(f.layoutId)).toBe(1);
    expect(await prisma.table.findUniqueOrThrow({ where: { id: tableId } })).toMatchObject({ status: "available", holdToken: null });
    expect(await prisma.booking.findUniqueOrThrow({ where: { orderId: order.orderId } })).toMatchObject({ status: "expired" });
    expect(await prisma.tableHold.findFirstOrThrow({ where: { tableId } })).toMatchObject({ status: "expired" });
    expect(await prisma.ticket.count({ where: { orderId: order.orderId, status: "cancelled" } })).toBe(2);
    expect(await prisma.seatAllocation.count({ where: { orderId: order.orderId, status: "released" } })).toBe(2);
    expect(await prisma.groupPass.findUniqueOrThrow({ where: { orderId: order.orderId } })).toMatchObject({ status: "cancelled" });
  });

  it("hall edits cannot touch a booked table once the event is on sale", async () => {
    const f = await fixture();
    await prisma.event.update({ where: { id: f.eventId }, data: { status: "draft" } });
    const layout = await prisma.venueLayout.findUniqueOrThrow({ where: { eventId: f.eventId } });
    const tariffId = randomUUID();
    const tableObject = { ...newHallObject(randomUUID(), "table_rect", 10, 10), tariffId, saleMode: "whole_table" as const };
    const tableSeat = { ...newHallObject(randomUUID(), "seat", 10, 9), parentId: tableObject.id, side: "top" as const };
    const hall = (active: boolean) => {
      const built = editorHallV3({ widthM: 20, heightM: 20 }, { version: 1, objects: [tableObject, tableSeat], tariffs: [{ id: tariffId, name: "Standard", price: 4000, color: "#6320EE" }] }, null, "en");
      return { ...built, tariffs: built.tariffs.map(tariff => ({ ...tariff, active })) };
    };
    await prisma.$transaction(tx => persistCanonicalHall(tx, f.eventId, layout.id, hall(true), "en", "KZT"));
    await prisma.event.update({ where: { id: f.eventId }, data: { status: "published" } });
    await approveEventsForTest(prisma, f.eventId);
    const order = await booking.checkoutTable(buyerId, randomUUID(), { tableId: tableObject.id, termsAccepted: true });
    await pay(order.orderId);
    expect(await prisma.table.findUniqueOrThrow({ where: { id: tableObject.id } })).toMatchObject({ status: "booked" });
    await expect(prisma.$transaction(tx => persistCanonicalHall(tx, f.eventId, layout.id, hall(false), "en", "KZT"))).rejects.toMatchObject({ response: { code: "VENUE_STRUCTURE_DRAFT_ONLY" } });
    expect(await prisma.table.findUniqueOrThrow({ where: { id: tableObject.id } })).toMatchObject({ status: "booked" });
  });

  it("the organizer refund finish takes the table lock before releasing a booked table", async () => {
    const f = await fixture();
    const tableId = await newTable(f);
    const order = await booking.checkoutTable(buyerId, randomUUID(), { tableId, termsAccepted: true });
    await pay(order.orderId);
    let done = false;
    let refund!: Promise<{ ok: boolean }>;
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`table:${tableId}`}, 0))`;
      refund = settle(refunds.request(ownerId, f.eventId, order.orderId, "Organizer cancelled this table")).then(value => { done = true; return value; });
      expect(await untilBlockedOr(() => done)).toBe("blocked");
    }, { timeout: 15_000 });
    expect((await refund).ok).toBe(true);
    expect(await prisma.table.findUniqueOrThrow({ where: { id: tableId } })).toMatchObject({ status: "available" });
    expect(await prisma.booking.findUniqueOrThrow({ where: { orderId: order.orderId } })).toMatchObject({ status: "cancelled" });
    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.orderId } })).toMatchObject({ paymentStatus: "refunded" });
  });

  it("staff cancellation of a free table order takes the table lock and clears the table", async () => {
    const f = await fixture();
    const tableId = await newTable(f, 0);
    const order = await booking.checkoutTable(buyerId, randomUUID(), { tableId, termsAccepted: true });
    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.orderId } })).toMatchObject({ paymentStatus: "paid", amount: 0 });
    const management = new StaffManagementService(prisma, {} as never, booking, {} as never);
    let done = false;
    let cancel!: Promise<{ ok: boolean }>;
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`table:${tableId}`}, 0))`;
      cancel = settle(management.cancelUnpaid(moderator, order.orderId, randomUUID(), "Guest cannot attend")).then(value => { done = true; return value; });
      expect(await untilBlockedOr(() => done)).toBe("blocked");
    }, { timeout: 15_000 });
    expect((await cancel).ok).toBe(true);
    expect(await prisma.table.findUniqueOrThrow({ where: { id: tableId } })).toMatchObject({ status: "available", holdToken: null, holdExpiresAt: null });
    expect(await prisma.booking.findUniqueOrThrow({ where: { orderId: order.orderId } })).toMatchObject({ status: "cancelled" });
    expect(await prisma.ticket.count({ where: { orderId: order.orderId, status: "cancelled" } })).toBe(2);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.orderId } })).toMatchObject({ paymentStatus: "cancelled" });
  });
});

