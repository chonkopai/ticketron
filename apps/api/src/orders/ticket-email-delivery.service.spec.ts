import { databaseSuiteEnabled } from "@event-platform/database/test-database-guard";
import { randomBytes, randomUUID } from "node:crypto";

import { createPrismaClient, type PrismaClient } from "@event-platform/database";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TicketsService } from "../tickets/tickets.service.js";
import { approveEventsForTest } from "../test-support/approve-event.js";
import { TicketEmailDeliveryService } from "./ticket-email-delivery.service.js";
import { TicketEmailSendError, type TicketEmailMessage, type TicketEmailSender } from "./ticket-email-sender.js";

const testUrl = process.env.VERIFICATION_TEST_DATABASE_URL;
const integration = databaseSuiteEnabled("ticket email delivery", "VERIFICATION_TEST_DATABASE_URL", { urlFlag: true }) ? describe : describe.skip;

integration("ticket email outbox and purchase capability", () => {
  let db: PrismaClient;
  let service: TicketEmailDeliveryService;
  const sent: TicketEmailMessage[] = [];
  const organizerId = randomUUID(), eventId = randomUUID(), typeId = randomUUID();
  const orderIds: string[] = [];
  let fail: "uncertain" | null = null;
  const sender: TicketEmailSender = { available: () => true, send: async message => {
    sent.push(message);
    if (fail) throw new TicketEmailSendError(fail);
    return { id: `test-${sent.length}` };
  } };

  beforeAll(async () => {
    const prior = process.env.DATABASE_URL;
    process.env.DATABASE_URL = testUrl;
    db = createPrismaClient();
    if (prior === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = prior;
    service = new TicketEmailDeliveryService(db, sender, { secret: "test-only-ticket-email-secret-32-chars", webOrigin: "https://tickets.example.test" }, new TicketsService(db, {} as never, {} as never));
    await db.user.create({ data: { id: organizerId, telegramId: BigInt(Date.now()) * 100n + 41n, role: "organizer" } });
    await db.event.create({ data: { id: eventId, organizerId, title: "Ticket email delivery", date: new Date("2035-02-01T00:00:00Z"), time: new Date("1970-01-01T18:00:00Z"), timezone: "Asia/Almaty", address: "Almaty", status: "published" } });
    await db.ticketType.create({ data: { id: typeId, eventId, name: "Standard", price: 1000, currency: "KZT", quantityTotal: 10, status: "active", isInternal: false } });
    await approveEventsForTest(db, eventId);
  });
  afterAll(async () => {
    if (db) {
      await db.outboxEvent.deleteMany({ where: { aggregateId: { in: orderIds } } });
      await db.ticketEmailDelivery.deleteMany({ where: { orderId: { in: orderIds } } });
      await db.ticket.deleteMany({ where: { orderId: { in: orderIds } } });
      await db.order.deleteMany({ where: { id: { in: orderIds } } });
      await db.event.deleteMany({ where: { id: eventId } });
      await db.user.deleteMany({ where: { id: organizerId } });
    }
    await db?.$disconnect();
  });

  async function paidFixture() {
    const type = { id: typeId };
    const id = randomUUID();
    orderIds.push(id);
    const order = await db.order.create({ data: { id, type: "ticket", amount: 1000, currency: "KZT", paymentStatus: "paid", emailDeliveryAddress: `${id}@example.test`, emailDeliveryRequestedAt: new Date(), checkoutSnapshot: { eventId: randomUUID(), eventTitle: "Тестовое событие", eventDate: "2026-10-10", eventTime: "19:00", eventTimezone: "Asia/Almaty", itemId: type.id, itemName: "Билет", itemKind: "ticket", quantity: 1, paymentMode: "full_payment", paymentLabel: "full_payment", unitFullAmount: 1000, fullAmount: 1000, amountDue: 1000, currency: "KZT", cancellationTerms: null, depositTerms: null } } });
    const ticket = await db.ticket.create({ data: { orderId: id, ticketTypeId: type.id, qrToken: randomBytes(32).toString("base64url"), status: "active" } });
    await db.outboxEvent.create({ data: { eventType: "ticket.email_requested", aggregateType: "order", aggregateId: id, payload: {} } });
    return { order, ticket };
  }

  it("accepts one initial email, stores only a hash, and denies cross-order QR access", async () => {
    const { order, ticket } = await paidFixture();
    const before = sent.length;
    await service.tick(); await service.tick();
    expect(sent.length).toBe(before + 1);
    const message = sent.at(-1)!;
    expect(message.to).toBe(order.emailDeliveryAddress);
    expect(message.text).toContain("Asia/Almaty");
    const token = /#token=([A-Za-z0-9_-]{43})/.exec(message.text)?.[1];
    expect(token).toBeTruthy();
    const state = await db.ticketEmailDelivery.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(state.status).toBe("accepted");
    expect(state.capabilityHash).not.toBe(token);
    expect((await service.view(token!)).tickets[0]?.id).toBe(ticket.id);
    await expect(service.qr(token!, randomUUID())).rejects.toBeTruthy();
    expect((await service.qr(token!, ticket.id)).length).toBeGreaterThan(100);
    await db.ticket.update({ where: { id: ticket.id }, data: { status: "refunded" } });
    expect((await service.view(token!)).tickets[0]?.status).toBe("refunded");
    await expect(service.qr(token!, ticket.id)).rejects.toBeTruthy();
  });

  it("retries an ambiguous provider result with the same idempotency key, then accepts it", async () => {
    const { order } = await paidFixture();
    fail = "uncertain";
    const before = sent.length;
    await service.tick();
    let state = await db.ticketEmailDelivery.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(state).toMatchObject({ status: "queued", lastErrorCode: "UNCERTAIN", leaseUntil: null });
    expect(state.firstAttemptAt).toBeTruthy();
    await db.ticketEmailDelivery.update({ where: { orderId: order.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    fail = null;
    await service.tick();
    expect(sent.length).toBe(before + 2);
    expect(sent.at(-1)!.idempotencyKey).toBe(sent.at(-2)!.idempotencyKey);
    state = await db.ticketEmailDelivery.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(state).toMatchObject({ status: "accepted", attempts: 2 });
  });

  it("marks the delivery uncertain once the provider retry window has passed, until an authorized resend", async () => {
    const { order } = await paidFixture();
    fail = "uncertain";
    const before = sent.length;
    await service.tick();
    await db.ticketEmailDelivery.update({ where: { orderId: order.id }, data: { nextAttemptAt: new Date(Date.now() - 1000), firstAttemptAt: new Date(Date.now() - 24 * 60 * 60_000) } });
    await service.tick();
    expect(sent.length).toBe(before + 1);
    expect(await db.ticketEmailDelivery.findUniqueOrThrow({ where: { orderId: order.id } })).toMatchObject({ status: "uncertain", lastErrorCode: "RETRY_WINDOW_EXPIRED" });
    const oldToken = /#token=([A-Za-z0-9_-]{43})/.exec(sent.at(-1)!.text)![1]!;
    await db.ticketEmailDelivery.update({ where: { orderId: order.id }, data: { updatedAt: new Date(Date.now() - 11 * 60_000) } });
    fail = null;
    await service.resend(order.id);
    await service.tick();
    expect(sent.length).toBe(before + 2);
    await expect(service.view(oldToken)).rejects.toBeTruthy();
    expect((await db.ticketEmailDelivery.findUniqueOrThrow({ where: { orderId: order.id } })).status).toBe("accepted");
  });

  it("releases the lease and keeps other rows going when the pre-send checks throw", async () => {
    const { order } = await paidFixture();
    let failOrderRead = true;
    const flaky = new Proxy(db, { get(target, property) {
      if (property === "order" && failOrderRead) {
        failOrderRead = false;
        return { ...target.order, findUnique: async () => { throw Object.assign(new Error("connection lost for someone@example.test"), { code: "P1001" }); } };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    } });
    const flakyService = new TicketEmailDeliveryService(flaky, sender, { secret: "test-only-ticket-email-secret-32-chars", webOrigin: "https://tickets.example.test" }, new TicketsService(db, {} as never, {} as never));
    const logged: string[] = [];
    const logger = (flakyService as unknown as { logger: { warn: (message: string) => void; error: (message: string) => void } }).logger;
    logger.warn = (message: string) => { logged.push(message); };
    logger.error = (message: string) => { logged.push(message); };
    await expect(flakyService.tick()).resolves.toBeUndefined();
    const state = await db.ticketEmailDelivery.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(state).toMatchObject({ status: "queued", leaseUntil: null, lastErrorCode: "INTERNAL_ERROR", attempts: 1 });
    expect(logged.join("\n")).toContain(order.id);
    expect(logged.join("\n")).toContain("P1001");
    expect(logged.join("\n")).not.toContain("@example.test");
  });

  it("keeps the emailed link valid until a week after the event, not just 30 days after purchase", async () => {
    const { order } = await paidFixture();
    await service.tick();
    const token = /#token=([A-Za-z0-9_-]{43})/.exec(sent.at(-1)!.text)![1]!;
    await db.ticketEmailDelivery.update({ where: { orderId: order.id }, data: { capabilityExpiresAt: new Date(Date.now() - 1000) } });
    expect((await service.view(token)).orderId).toBe(order.id);
    const event = await db.event.findUniqueOrThrow({ where: { id: eventId } });
    await db.event.update({ where: { id: eventId }, data: { startsAt: new Date(Date.now() - 8 * 24 * 60 * 60_000) } });
    try { await expect(service.view(token)).rejects.toBeTruthy(); }
    finally { await db.event.update({ where: { id: eventId }, data: { startsAt: event.startsAt } }); }
  });

  it("marks an enqueue request dead after five failures and stops retrying it", async () => {
    const orderId = randomUUID();
    orderIds.push(orderId);
    const request = await db.outboxEvent.create({ data: { eventType: "ticket.email_requested", aggregateType: "order", aggregateId: orderId, payload: {} } });
    type Internals = { enqueueOne(eventId: string, orderId: string): Promise<void> };
    const original = (service as unknown as Internals).enqueueOne.bind(service);
    const spy = vi.spyOn(service as unknown as Internals, "enqueueOne").mockImplementation(async (eventId, id) => { if (eventId === request.id) throw new Error("boom"); return original(eventId, id); });
    try {
      for (let attempt = 1; attempt <= 5; attempt += 1) await service.tick();
      const dead = await db.outboxEvent.findUniqueOrThrow({ where: { id: request.id } });
      expect(dead).toMatchObject({ attempts: 5, processedAt: null });
      expect(dead.deadAt).toBeInstanceOf(Date);
      const calls = spy.mock.calls.filter(([id]) => id === request.id).length;
      await service.tick();
      expect(spy.mock.calls.filter(([id]) => id === request.id).length).toBe(calls);
    } finally { spy.mockRestore(); }
  });
});
