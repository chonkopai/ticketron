import { databaseSuiteEnabled } from "@event-platform/database/test-database-guard";
import { randomUUID } from "node:crypto";
import { prisma } from "@event-platform/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DomainEventsService } from "../domain-events/domain-events.service.js";
import { PaymentService } from "../payments/payment.service.js";
import { SeatsService } from "../seats/seats.service.js";
import { TablesService } from "../tables/tables.service.js";
import { TicketTypesService } from "../ticket-types/ticket-types.service.js";
import { approveEventsForTest } from "../test-support/approve-event.js";
import { BookingService } from "./booking.service.js";
import { DevelopmentPaymentProvider } from "./payment-provider.js";

// The legacy ticket-type / table / seat editors take their locks in the documented order
// (order → seat → table → ticket type, each kind sorted), so they cannot deadlock with checkout and settlement.
// Order is asserted by holding one lock from outside and checking which later locks the blocked editor already owns.
const testUrl = databaseSuiteEnabled("legacy editor lock order", "REGRESSION_TEST_DATABASE_URL", { urlFlag: true }) ? process.env.REGRESSION_TEST_DATABASE_URL : undefined;
if (testUrl && testUrl !== process.env.DATABASE_URL) throw new Error("Legacy editor lock order tests require REGRESSION_TEST_DATABASE_URL to equal DATABASE_URL");

const ownerId = randomUUID(), buyerId = randomUUID();
const eventIds: string[] = [];
const clock = { now: () => new Date() };
const domain = new DomainEventsService();
const provider = new DevelopmentPaymentProvider("http://localhost:3000", "legacy-editor-lock-order-secret", 300, clock.now);
const types = new TicketTypesService(prisma, domain);
const tables = new TablesService(prisma, domain, { holdTtlSeconds: 600, cleanupIntervalSeconds: 60 }, clock);
const seats = new SeatsService(prisma, domain, tables);
const payments = new PaymentService(prisma, provider, domain, clock);
const booking = new BookingService(prisma, types, tables, domain, { checkoutTtlSeconds: 900, cleanupIntervalSeconds: 60 }, clock, payments);
const settle = <T,>(promise: Promise<T>) => promise.then(value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
const geometry = { x: 20, y: 20, width: 60, height: 60 };

async function draftEvent() {
  const eventId = randomUUID(); eventIds.push(eventId);
  await prisma.event.create({ data: { id: eventId, organizerId: ownerId, title: "Legacy editor lock order", status: "draft", date: new Date("2035-01-01"), time: new Date("1970-01-01T18:00:00Z"), timezone: "UTC", address: "Test venue", description: "Test", cancellationTerms: "Cancellations permitted", paymentMode: "full_payment" } });
  const layout = await prisma.venueLayout.create({ data: { eventId, templateName: "Test", layoutJson: { version: 1, canvas: { width: 800, height: 600 }, tables: [] } } });
  return { eventId, layoutId: layout.id };
}
async function publish(eventId: string) {
  await prisma.event.update({ where: { id: eventId }, data: { status: "published" } });
  await approveEventsForTest(prisma, eventId);
}
let nextNumber = 1;
/** A per-seat table whose two seats are priced by two different ticket types. */
async function perSeatTable(f: { eventId: string; layoutId: string }) {
  const table = await tables.create(ownerId, f.layoutId, { number: nextNumber++, seats: 2, price: 1000, saleMode: "per_seat", geometry });
  const created = await seats.createForTable(ownerId, table.id, { numbers: [1, 2] });
  const second = await prisma.ticketType.create({ data: { eventId: f.eventId, name: randomUUID(), price: 1000, currency: "KZT", quantityTotal: 5, status: "active" } });
  await prisma.seat.update({ where: { id: created[1]!.id }, data: { ticketTypeId: second.id } });
  const typeIds = [created[0]!.ticketTypeId!, second.id];
  return { tableId: table.id, seatIds: created.map(seat => seat.id), typeIds };
}

/** Holds `key` in a transaction while `editor` runs; the editor must block and, meanwhile, own none of `mustBeFree`. */
async function withHeldLock(key: string, mustBeFree: string[], editor: () => Promise<unknown>) {
  let result!: ReturnType<typeof settle>;
  let finished = false;
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    result = settle(editor()).then(value => { finished = true; return value; });
    for (let attempt = 0; attempt < 600; attempt += 1) {
      // Outside the transaction: pg_stat_activity is snapshotted per transaction.
      const [row] = await prisma.$queryRaw<Array<{ waiting: number }>>`SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if (row!.waiting > 0 || finished) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(finished, `editor should wait for ${key}`).toBe(false);
    for (const other of mustBeFree) {
      const [row] = await tx.$queryRaw<Array<{ free: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtextextended(${other}, 0)) AS free`;
      expect(row!.free, `editor must not hold ${other} while waiting for ${key}`).toBe(true);
    }
  }, { timeout: 15_000 });
  const outcome = await result;
  expect(outcome.ok, outcome.ok ? "" : String((outcome.error as Error).message)).toBe(true);
}

const deadlock = (error: unknown) => /40P01|P2034|deadlock/i.test(`${(error as { code?: string }).code ?? ""} ${(error as { message?: string }).message ?? ""}`);

(testUrl ? describe : describe.skip)("legacy editor lock order (isolated PostgreSQL)", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    await prisma.user.createMany({ data: [{ id: ownerId, role: "organizer" }, { id: buyerId, role: "guest" }] });
  });
  afterAll(async () => {
    await prisma.order.deleteMany({ where: { buyerUserId: buyerId } });
    await prisma.event.deleteMany({ where: { id: { in: eventIds } } });
    await prisma.idempotencyRecord.deleteMany({ where: { userId: buyerId } });
    await prisma.auditLog.deleteMany({ where: { actorId: ownerId } });
    await prisma.$disconnect();
  });

  it("table edit takes its ticket types sorted, after the table", async () => {
    const f = await draftEvent();
    const t = await perSeatTable(f);
    const [low, high] = [...t.typeIds].sort();
    await withHeldLock(`ticket-type:${low}`, [`ticket-type:${high}`], () => tables.update(ownerId, t.tableId, { price: 1500 }));
    expect(await prisma.ticketType.findMany({ where: { id: { in: t.typeIds } } })).toEqual(expect.arrayContaining([expect.objectContaining({ price: 1500 })]));
  });

  it("table delete locks its seats before the table", async () => {
    const f = await draftEvent();
    const t = await perSeatTable(f);
    const [lowSeat, highSeat] = [...t.seatIds].sort();
    await withHeldLock(`seat:${lowSeat}`, [`seat:${highSeat}`, `table:${t.tableId}`], () => tables.delete(ownerId, t.tableId));
    expect(await prisma.table.count({ where: { id: t.tableId } })).toBe(0);
  });

  it("row delete and row renumbering lock the row's seats (sorted) before anything lower", async () => {
    const f = await draftEvent();
    const row = await seats.createRow(ownerId, f.layoutId, { number: 1, seatCount: 3, price: 1000, currency: "KZT" });
    const typeId = row.seats[0]!.ticketTypeId!;
    const [lowSeat, ...rest] = row.seats.map(seat => seat.id).sort();
    await withHeldLock(`seat:${lowSeat}`, [...rest.map(id => `seat:${id}`), `ticket-type:${typeId}`], () => seats.updateRow(ownerId, row.id, { seatCount: 2 }));
    const renumbered = await prisma.venueRow.findUniqueOrThrow({ where: { id: row.id }, include: { seats: true } });
    expect(renumbered.seats).toHaveLength(2);
    const [lowest, ...others] = renumbered.seats.map(seat => seat.id).sort();
    await withHeldLock(`seat:${lowest}`, others.map(id => `seat:${id}`), () => seats.deleteRow(ownerId, row.id));
    expect(await prisma.venueRow.count({ where: { id: row.id } })).toBe(0);
  });

  it("seat delete locks the seat before its table", async () => {
    const f = await draftEvent();
    const t = await perSeatTable(f);
    await withHeldLock(`seat:${t.seatIds[0]}`, [`table:${t.tableId}`], () => seats.deleteSeat(ownerId, t.seatIds[0]!));
    expect(await prisma.table.findUniqueOrThrow({ where: { id: t.tableId } })).toMatchObject({ seats: 1 });
  });

  it("legacy edits racing seat checkout and settlement never deadlock (20 rounds)", async () => {
    const f = await draftEvent();
    const rounds = [];
    for (let round = 0; round < 20; round += 1) rounds.push(await perSeatTable(f));
    await publish(f.eventId);
    const failures: unknown[] = [];
    for (const [round, t] of rounds.entries()) {
      await approveEventsForTest(prisma, f.eventId); // the previous round's price edits paused sales
      const checkout = await booking.checkoutSeats(buyerId, randomUUID(), { seatIds: t.seatIds, termsAccepted: true });
      const attempt = await prisma.payment.findFirstOrThrow({ where: { orderId: checkout.orderId } });
      const pay = booking.handlePaymentWebhook({ provider: "mock", eventId: randomUUID(), eventType: "payment.succeeded", providerPaymentId: attempt.providerPaymentId!, orderId: checkout.orderId, amount: attempt.amount, currency: "KZT", payloadHash: randomUUID(), occurredAt: new Date() });
      const results = await Promise.all([
        settle(pay),
        settle(tables.update(ownerId, t.tableId, { price: 2000 + round })),
        ...t.typeIds.map((id, index) => settle(types.update(ownerId, id, { price: 3000 + round + index }))),
        settle(tables.delete(ownerId, t.tableId)),
        settle(seats.deleteSeat(ownerId, t.seatIds[0]!)),
      ]);
      for (const result of results) if (!result.ok) failures.push(result.error);
      // Whatever the legitimate refusals were, each sold seat is counted exactly once.
      // A re-priced (and so re-approved) event may legitimately turn the payment away; it must still end in a terminal state.
      expect(["paid", "cancelled", "failed"]).toContain((await prisma.order.findUniqueOrThrow({ where: { id: checkout.orderId } })).paymentStatus);
      for (const id of t.typeIds) {
        const type = await prisma.ticketType.findUniqueOrThrow({ where: { id } });
        expect(type.quantitySold).toBe(await prisma.ticket.count({ where: { ticketTypeId: id, status: { in: ["paid", "active", "used"] } } }));
      }
    }
    expect(failures.filter(deadlock)).toEqual([]);
  }, 120_000);
});
