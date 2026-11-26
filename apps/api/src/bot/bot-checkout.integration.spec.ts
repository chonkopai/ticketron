import { databaseSuiteEnabled } from "@event-platform/database/test-database-guard";
import { createHmac, randomUUID } from "node:crypto";
import "reflect-metadata";
import { prisma } from "@event-platform/database";
import { editorHallV3, newHallObject } from "@event-platform/shared-types";
import { NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BookingService } from "../booking/booking.service.js";
import { DevelopmentPaymentProvider } from "../booking/payment-provider.js";
import { DomainEventsService } from "../domain-events/domain-events.service.js";
import { AnonymousService } from "../orders/anonymous.service.js";
import { PaymentService } from "../payments/payment.service.js";
import { PublicEventsService } from "../public-events/public-events.service.js";
import { TablesService } from "../tables/tables.service.js";
import { TicketTypesService } from "../ticket-types/ticket-types.service.js";
import { BotCheckoutService } from "./bot-checkout.service.js";
import { BotModule } from "./bot.module.js";
import { BotWalletService } from "./bot-wallet.service.js";
import { TicketsService } from "../tickets/tickets.service.js";
import { QuickDeliveryService, TelegramDeliveryRejected } from "../orders/quick-delivery.service.js";
import { EventNotificationsService } from "../events/event-notifications.service.js";
import { SeatsService } from "../seats/seats.service.js";
import { TelegramSeatService } from "./telegram-seat.service.js";
import { persistCanonicalHall } from "../creation-drafts/creation-sale.persistence.js";

const enabled = databaseSuiteEnabled("Telegram checkout", "TELEGRAM_CHECKOUT_DB_TEST");
const organizerId = randomUUID();
const recipientBase = BigInt(Date.now()) * 100n;
const recipient = (id: number) => String(recipientBase + BigInt(id));
let now = new Date("2035-01-01T00:00:00Z");
const clock = { now: () => new Date(now) };
const events = new DomainEventsService();
const config = { checkoutTtlSeconds: 900, cleanupIntervalSeconds: 60 };
const quickConfig = { botUsername: "test_bot", sessionSeconds: 600, accessSeconds: 3600 };
const provider = new DevelopmentPaymentProvider("http://localhost:3000", "telegram-checkout-test", 300, clock.now);
const types = new TicketTypesService(prisma, events);
const tables = new TablesService(prisma, events, { holdTtlSeconds: 600, cleanupIntervalSeconds: 60 }, clock);
const payments = new PaymentService(prisma, provider, events, clock);
const booking = new BookingService(prisma, types, tables, events, config, clock, payments);
const publicEvents = new PublicEventsService(prisma, types, tables);
const seats = new SeatsService(prisma, events, tables);
const service = () => new BotCheckoutService(prisma, clock, publicEvents, new AnonymousService(prisma, booking, payments, events, clock, quickConfig), payments, booking);
const wallet = () => new BotWalletService(prisma, {
  accessTokenSecret: "fixture", refreshTokenSecret: "fixture", telegramBotToken: "1:fixture", telegramBotUsername: "fixture_bot",
  botApiSecret: "fixture-wallet-confirmation", organizerRequiresApproval: false,
}, clock, new TicketsService(prisma, events, { isConfigured: () => false, generate: async () => Buffer.alloc(0) }), booking, publicEvents);
const approve = (id: string) => prisma.event.update({ where: { id }, data: { status: "published", moderationStatus: "approved", approvedAt: clock.now() } });

async function event() {
  return prisma.event.create({ data: {
    organizerId, title: "Telegram test event", sourceLocale: "en", date: new Date("2035-03-01"),
    time: new Date("1970-01-01T14:00:00Z"), timezone: "UTC", address: "Test venue", cancellationTerms: "Legacy refund terms",
  } });
}

async function ticket(price: number, normalized = false, quantityTotal = 5) {
  const { id: eventId } = await event();
  const { id: itemId } = await prisma.ticketType.create({ data: { eventId, name: "General", price, quantityTotal, currency: "KZT", status: "active" } });
  if (normalized) {
    const asset = await prisma.mediaAsset.create({ data: {
      eventId, kind: "image", state: "ready", width: 800, height: 500, storageKey: `${eventId}/original`,
      bytes: 100n, checksum: "a".repeat(64), contentType: "image/png", derivatives: { display: "display.webp", thumbnail: "thumbnail.webp" },
    } });
    await prisma.eventMedia.create({ data: { eventId, assetId: asset.id, slot: 0, isCard: true, isBackground: true } });
    await prisma.eventContent.create({ data: { eventId, locale: "en", title: "Normalized event", description: "Test event", address: "Test venue", refundConditions: price ? "Original terms" : null } });
    await prisma.ticketTypeContent.create({ data: { ticketTypeId: itemId, locale: "en", name: "General" } });
    await prisma.event.update({ where: { id: eventId }, data: {
      creationVersion: 2, v2State: "reconciled", saleMode: price ? "paid_general" : "free", currency: "KZT",
      startsAt: new Date("2035-03-01T14:00:00Z"), endsAt: new Date("2035-03-01T18:00:00Z"), refundsAvailable: Boolean(price), refundPolicyRevision: 1,
    } });
  }
  await approve(eventId);
  return { eventId, itemId, kind: "ticket" as const, locale: "en" as const };
}

async function table() {
  const { id: eventId } = await event();
  const layout = await prisma.venueLayout.create({ data: { eventId, templateName: "Test", layoutJson: { version: 1, canvas: { width: 800, height: 600 }, tables: [] } } });
  const resource = await tables.create(organizerId, layout.id, { number: 1, name: "Table one", seats: 2, price: 12000, currency: "KZT", geometry: { x: 10, y: 10, width: 60, height: 60 } });
  await prisma.seat.createMany({ data: [1, 2].map(number => ({ number, label: String(number), sortOrder: number - 1, tableId: resource.id, venueLayoutId: layout.id })) });
  await approve(eventId);
  return { eventId, itemId: resource.id, kind: "table" as const, locale: "en" as const };
}

async function pay(orderId: string) {
  const payment = await prisma.payment.findFirstOrThrow({ where: { orderId } });
  const signed = DevelopmentPaymentProvider.signWebhook({
    eventId: randomUUID(), eventType: "payment.succeeded", orderId, providerPaymentId: payment.providerPaymentId!,
    amount: payment.amount, currency: payment.currency,
  }, "telegram-checkout-test", Math.floor(clock.now().getTime() / 1000));
  await booking.handlePaymentWebhook(provider.verifyWebhook(signed));
}

const seatToken = "1:fixture";
const seatApp = () => new TelegramSeatService(prisma, clock, { enabled: true, token: seatToken, botUsername: "fixture_bot" },
  publicEvents, seats, new AnonymousService(prisma, booking, payments, events, clock, quickConfig), service(), provider);

function launchData(eventId: string, telegramId: string, options: { now?: Date; chat?: string; query?: string } = {}) {
  const fields = {
    auth_date: String(Math.floor((options.now ?? clock.now()).getTime() / 1000)),
    user: JSON.stringify({ id: Number(telegramId), first_name: "Fixture", language_code: "en" }),
    chat_type: options.chat ?? "private",
    chat_instance: options.query ?? "fixture",
    start_param: `s_${eventId}`,
  };
  const payload = Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(seatToken).digest();
  return new URLSearchParams({ ...fields, hash: createHmac("sha256", secret).update(payload).digest("hex") }).toString();
}

async function seatLaunch(app: TelegramSeatService, eventId: string, id: number, query = "fixture") {
  const exchange = await app.exchange(launchData(eventId, recipient(id), { query }));
  return app.authenticate(`Bearer ${exchange.token}`);
}

async function seatHall(existingEventId?: string) {
  const eventId = existingEventId ?? (await event()).id;
  const rowId = randomUUID(), perSeatTable = randomUUID(), wholeTable = randomUUID();
  const layout = await prisma.venueLayout.create({ data: { eventId, templateName: "Fixture seats", layoutJson: {
    version: 2, room: { widthM: 12, heightM: 10 },
    rows: [{ rowId, x: 2, y: 2, width: 5, height: 1, seatCount: 3, seatSpacing: 1.5 }],
    tables: [perSeatTable, wholeTable].map((tableId, index) => ({
      tableId, x: 2 + 4 * index, y: 6, width: 2, height: 1.2, shape: "rectangle", preset: "two",
      seats: [{ number: 1, x: 25, y: -25 }, { number: 2, x: 75, y: -25 }],
    })),
  } } });
  const rowType = await prisma.ticketType.create({ data: { eventId, name: "Stalls", price: 8000, currency: "KZT", quantityTotal: 3, status: "active" } });
  const tableType = await prisma.ticketType.create({ data: { eventId, name: "Balcony", price: 13000, currency: "KZT", quantityTotal: 2, status: "active" } });
  await prisma.venueRow.create({ data: { id: rowId, venueLayoutId: layout.id, number: 1, price: rowType.price, currency: "KZT" } });
  await prisma.table.createMany({ data: [
    { id: perSeatTable, venueLayoutId: layout.id, number: 1, seats: 2, price: 13000, deposit: 0, currency: "KZT", saleMode: "per_seat" },
    { id: wholeTable, venueLayoutId: layout.id, number: 2, seats: 2, price: 33000, deposit: 0, currency: "KZT", saleMode: "whole_table" },
  ] });
  const rowSeats = Array.from({ length: 3 }, () => randomUUID()), tableSeats = [randomUUID(), randomUUID()];
  await prisma.seat.createMany({ data: [
    ...rowSeats.map((id, index) => ({ id, rowId, venueLayoutId: layout.id, ticketTypeId: rowType.id, number: index + 1, sortOrder: index, label: `Row 1 · Seat ${index + 1}` })),
    ...tableSeats.map((id, index) => ({ id, tableId: perSeatTable, venueLayoutId: layout.id, ticketTypeId: tableType.id, number: index + 1, sortOrder: index, label: `Table 1 · Seat ${index + 1}` })),
  ] });
  if (existingEventId) await prisma.event.update({ where: { id: eventId }, data: { v2State: "reconciled" } });
  await approve(eventId);
  return { eventId, rowSeats, rowId, tableSeats, wholeTable, rowType, tableType };
}

describe.runIf(enabled)("Telegram checkout against disposable PostgreSQL", () => {
  beforeAll(async () => { await prisma.user.create({ data: { id: organizerId, role: "organizer" } }); });
  afterAll(async () => { await prisma.$disconnect(); });

  it("validates signed private launches once and scopes protected operations to the actor and event", async () => {
    const first = await seatHall(), second = await seatHall();
    const app = seatApp(), raw = launchData(first.eventId, recipient(40));
    await expect(app.exchange(raw.replace(first.eventId, second.eventId))).rejects.toMatchObject({ status: 401 });
    await expect(app.exchange(launchData(first.eventId, recipient(40), { now: new Date(now.getTime() - 301000) }))).rejects.toMatchObject({ status: 401 });
    await expect(app.exchange(launchData(first.eventId, recipient(40), { now: new Date(now.getTime() + 31000) }))).rejects.toMatchObject({ status: 401 });
    await expect(app.exchange(launchData(first.eventId, recipient(40), { chat: "group" }))).rejects.toMatchObject({ status: 403 });
    const exchanged = await app.exchange(raw);
    const reordered = raw.split("&").reverse().join("&");
    await expect(seatApp().exchange(reordered)).rejects.toMatchObject({ response: { code: "TELEGRAM_SEAT_LAUNCH_USED" } });
    const active = await app.authenticate(`Bearer ${exchanged.token}`);
    await expect(app.catalogue(active)).resolves.toMatchObject({ event: { id: first.eventId }, closed: false });
    await expect(app.quote(active, { seatIds: [second.rowSeats[0]] })).rejects.toMatchObject({ response: { code: "SEAT_UNAVAILABLE" } });
    const offer = await app.quote(active, { seatIds: [first.rowSeats[0]] });
    const otherEvent = await seatLaunch(app, second.eventId, 40);
    const otherActor = await seatLaunch(app, first.eventId, 41);
    await expect(app.confirm(otherActor, offer.reference)).rejects.toMatchObject({ status: 404 });
    await expect(app.confirm(otherEvent, offer.reference)).rejects.toMatchObject({ status: 404 });
    await expect(service().confirm(recipient(40), recipient(40), offer.reference, 1)).rejects.toMatchObject({ status: 404 });
    await prisma.user.create({ data: { telegramId: BigInt(recipient(40)), telegramChatId: BigInt(recipient(40)), blockedAt: now } });
    await expect(app.authenticate(`Bearer ${exchanged.token}`)).rejects.toMatchObject({ response: { code: "ACCOUNT_RESTRICTED" } });
  });

  it("purchases a numbered seat, a table seat and a whole table and recovers the same order in Telegram", async () => {
    const fixture = await seatHall(), app = seatApp();
    for (const [index, [selection, amount, admission]] of [
      [{ seatIds: [fixture.rowSeats[0]!] }, 8000, "ticket"],
      [{ seatIds: [fixture.tableSeats[0]!] }, 13000, "ticket"],
      [{ seatIds: [], tableId: fixture.wholeTable }, 33000, "group"],
    ].entries()) {
      const buyer = 50 + index;
      const session = await seatLaunch(app, fixture.eventId, buyer);
      const offer = await app.quote(session, selection);
      expect(offer).toMatchObject({ amountDue: amount, refundTerms: "Legacy refund terms" });
      if (admission === "group") expect(offer.items[0]).toMatchObject({ capacity: 2 });
      const [first, duplicate] = await Promise.all([app.confirm(session, offer.reference), seatApp().confirm(session, offer.reference)]);
      expect(first).toMatchObject({ orderId: duplicate.orderId, status: "pending", demoPayment: true, paymentLink: null, amountDue: amount });
      expect(first.expiresAt).not.toBeNull();
      const restarted = seatApp(), reopened = await seatLaunch(restarted, fixture.eventId, buyer, "reopened");
      await expect(restarted.order(reopened)).resolves.toMatchObject({ orderId: first.orderId, status: "pending" });
      await expect(restarted.order(await seatLaunch(restarted, fixture.eventId, 59, String(buyer)), first.orderId)).rejects.toMatchObject({ status: 404 });
      expect((await service().list(recipient(buyer), recipient(buyer), 1)).items[0]?.orderId).toBe(first.orderId);
      await pay(first.orderId);
      await expect(restarted.order(reopened, first.orderId)).resolves.toMatchObject({ status: "paid", chatUrl: `https://t.me/fixture_bot?start=p_${first.orderId}` });
      const day = await wallet().event(recipient(buyer), recipient(buyer), fixture.eventId, 1, "en");
      expect(day.orders).toEqual(expect.arrayContaining([expect.objectContaining({ id: first.orderId })]));
      if (admission === "group") expect(await prisma.groupPass.findUnique({ where: { orderId: first.orderId } })).toMatchObject({ status: "active", totalSeats: 2 });
    }
  });

  it("refreshes stale amounts and terms, blocks contested seats and tables and releases expired holds", async () => {
    const normalized = await ticket(8500, true);
    const fixture = await seatHall(normalized.eventId), app = seatApp();
    const session = await seatLaunch(app, fixture.eventId, 60);
    const rowChoice = { seatIds: [fixture.rowSeats[0]!] };
    const quote = await app.quote(session, rowChoice);
    await prisma.ticketType.update({ where: { id: fixture.rowType.id }, data: { price: 8100 } });
    await prisma.event.update({ where: { id: fixture.eventId }, data: { v2State: "reconciled" } });
    await approve(fixture.eventId);
    await expect(app.confirm(session, quote.reference)).rejects.toMatchObject({ response: { code: "BOT_OFFER_CHANGED" } });
    const retry = await app.quote(session, rowChoice);
    await prisma.eventContent.update({ where: { eventId_locale: { eventId: fixture.eventId, locale: "en" } }, data: { refundConditions: "Updated seat refund terms" } });
    await prisma.event.update({ where: { id: fixture.eventId }, data: { refundPolicyRevision: 2, v2State: "reconciled" } });
    await approve(fixture.eventId);
    await expect(app.confirm(session, retry.reference)).rejects.toMatchObject({ response: { code: "REFUND_POLICY_CHANGED" } });
    await expect(app.quote(session, rowChoice)).resolves.toMatchObject({ amountDue: 8100, policyRevision: 2, refundTerms: "Updated seat refund terms" });
    const blockQuote = await app.quote(session, { seatIds: [fixture.rowSeats[1]!] });
    await prisma.seat.update({ where: { id: fixture.rowSeats[1]! }, data: { status: "disabled" } });
    await expect(app.confirm(session, blockQuote.reference)).rejects.toMatchObject({ response: { code: "SEAT_UNAVAILABLE" } });
    await prisma.event.update({ where: { id: fixture.eventId }, data: { v2State: "reconciled" } });
    await approve(fixture.eventId);

    const buyer = await prisma.user.create({ data: {} });
    for (const selection of [{ seatIds: [fixture.tableSeats[0]!] }, { seatIds: [], tableId: fixture.wholeTable }]) {
      const offer = await app.quote(session, selection);
      await booking.checkoutCart(buyer.id, randomUUID(), { ...selection, termsAccepted: true, policyRevision: 2, contentLocale: "en", eventId: fixture.eventId, tickets: [] });
      await expect(app.confirm(session, offer.reference)).rejects.toMatchObject({ response: { code: selection.tableId ? "TABLE_UNAVAILABLE" : "SEAT_UNAVAILABLE" } });
    }

    const contested = { seatIds: [fixture.rowSeats[2]!] };
    const competingOffer = await app.quote(session, contested);
    const sameSeat = await Promise.allSettled([
      app.confirm(session, competingOffer.reference),
      booking.checkoutCart(buyer.id, randomUUID(), { ...contested, termsAccepted: true, policyRevision: 2, contentLocale: "en", eventId: fixture.eventId, tickets: [] }),
    ]);
    expect(sameSeat.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.seatAllocation.count({ where: { seatId: contested.seatIds[0]!, status: "active" } })).toBe(1);

    const held = await app.confirm(session, (await app.quote(session, rowChoice)).reference);
    const previousTime = now;
    try {
      now = new Date(Date.parse(held.expiresAt!) + 1);
      await expect(app.order(session, held.orderId)).resolves.toMatchObject({ status: "expired", paymentLink: null });
      await booking.expireDueCheckouts(100);
      const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: held.orderId } });
      const delayed = DevelopmentPaymentProvider.signWebhook({
        eventId: randomUUID(), eventType: "payment.succeeded", orderId: held.orderId, providerPaymentId: payment.providerPaymentId!,
        amount: payment.amount, currency: payment.currency,
      }, "telegram-checkout-test", Math.floor(clock.now().getTime() / 1000));
      const verified = provider.verifyWebhook(delayed);
      await expect(booking.handlePaymentWebhook(verified)).resolves.toMatchObject({ reviewRequired: true });
      await expect(booking.handlePaymentWebhook(verified)).resolves.toMatchObject({ duplicate: true });
      expect(await prisma.ticket.count({ where: { orderId: held.orderId, status: "active" } })).toBe(0);
      await expect(app.quote(session, rowChoice)).resolves.toMatchObject({ amountDue: 8100 });
    } finally {
      now = previousTime;
    }
  });

  it("settles a normalized hall cart and preserves event approval after creating whole-table admission", async () => {
    const { eventId } = await ticket(8500, true);
    await prisma.event.update({ where: { id: eventId }, data: { status: "draft" } });
    const layout = await prisma.venueLayout.create({ data: { eventId, templateName: "Canonical hall", layoutJson: {
      version: 1, canvas: { width: 800, height: 600 }, tables: [],
    } } });
    const tariffId = randomUUID();
    const table = { ...newHallObject(randomUUID(), "table_rect", 10, 10), tariffId, saleMode: "whole_table" as const };
    const tableSeat = { ...newHallObject(randomUUID(), "seat", 10, 9), parentId: table.id, side: "top" as const };
    const seat = { ...newHallObject(randomUUID(), "seat", 4, 4), number: 1, tariffId };
    const hall = editorHallV3({ widthM: 20, heightM: 20 }, {
      version: 1, objects: [table, tableSeat, seat], tariffs: [{ id: tariffId, name: "Standard", price: 9500, color: "#6320EE" }],
    }, null, "en");
    await prisma.$transaction(tx => persistCanonicalHall(tx, eventId, layout.id, hall, "en", "KZT"));
    await prisma.event.update({ where: { id: eventId }, data: { saleMode: "paid_seated", v2State: "reconciled" } });
    await approve(eventId);
    const app = seatApp();
    const session = await seatLaunch(app, eventId, 61);
    const quote = await app.quote(session, { seatIds: [seat.id], tableId: table.id });
    expect(quote).toMatchObject({ amountDue: 19000, policyRevision: 1, locale: "en" });
    const order = await app.confirm(session, quote.reference);
    expect(order.status).toBe("pending");
    await pay(order.orderId);
    await expect(app.order(session, order.orderId)).resolves.toMatchObject({ status: "paid" });
    await expect(prisma.event.findUnique({ where: { id: eventId } })).resolves.toMatchObject({ moderationStatus: "approved", v2State: "reconciled" });
    await expect(prisma.order.findUnique({ where: { id: order.orderId } })).resolves.toMatchObject({
      checkoutSnapshot: { version: 2, amount: 19000, selection: { kind: "cart", groupPass: true }, refund: { revision: 1 } },
    });
  });

  it("settles a normalized free purchase once after simultaneous confirmations and preserves the delivery anchor", async () => {
    const selected = await ticket(0, true);
    const first = service();
    const offer = await first.prepare(recipient(1), recipient(1), "Guest", selected);
    expect(offer).toMatchObject({ policyRevision: 1, amountDue: 0, locale: "en" });
    await expect(first.confirm(recipient(11), recipient(11), offer.reference, 2)).rejects.toMatchObject({ status: 404 });
    await expect(first.confirm(recipient(1), recipient(11), offer.reference, 2)).rejects.toMatchObject({ status: 400 });
    const confirmation = await Promise.all([first.confirm(recipient(1), recipient(1), offer.reference, 42), service().confirm(recipient(1), recipient(1), offer.reference, 42)]);
    expect(confirmation[0]).toEqual(confirmation[1]);
    const session = await prisma.anonymousCheckoutSession.findUniqueOrThrow({ where: { id: offer.reference } });
    expect(session).toMatchObject({ deliveryMessageId: 42, requestKey: `tg-${offer.reference}` });
    expect(confirmation[0]).toMatchObject({ order: { orderId: session.orderId, status: "paid", paymentLink: null } });
    expect(await prisma.order.findUniqueOrThrow({ where: { id: session.orderId! } })).toMatchObject({ buyerUserId: null });
    expect(await prisma.ticket.count({ where: { orderId: session.orderId!, status: "active" } })).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { aggregateId: session.orderId!, eventType: "checkout.paid" } })).toBe(1);
  });

  it("returns revised terms and a new confirmation instead of purchasing from an old offer", async () => {
    const selected = await ticket(12500, true);
    const checkout = service();
    const offer = await checkout.prepare(recipient(2), recipient(2), "Guest", selected);
    expect(offer.refundTerms).toBe("Original terms");
    await prisma.eventContent.update({ where: { eventId_locale: { eventId: selected.eventId, locale: "en" } }, data: { refundConditions: "New terms" } });
    await prisma.event.update({ where: { id: selected.eventId }, data: { refundPolicyRevision: 2, v2State: "reconciled" } });
    await approve(selected.eventId);
    const refreshed = await checkout.confirm(recipient(2), recipient(2), offer.reference, 5);
    expect(refreshed).toMatchObject({ offer: { refundTerms: "New terms", policyRevision: 2 } });
    expect(await prisma.anonymousCheckoutSession.findUnique({ where: { id: offer.reference } })).toBeNull(); // superseded by the refreshed offer
    if (!("offer" in refreshed)) throw new Error("Expected new offer");
    const confirmed = await checkout.confirm(recipient(2), recipient(2), refreshed.offer.reference, 6);
    expect(confirmed).toMatchObject({ order: { status: "pending", amountDue: 12500 } });
  });

  it("recovers two distinct pending orders and resumes a whole-table payment after provider failure", async () => {
    const first = service(), admission = await ticket(10000), whole = await table();
    const general = await first.prepare(recipient(3), recipient(3), "Guest", admission);
    const reserved = await first.prepare(recipient(3), recipient(3), "Guest", whole);
    const generalResult = await first.confirm(recipient(3), recipient(3), general.reference, 10);
    expect(generalResult).toMatchObject({ order: { status: "pending", amountDue: 10000 } });
    vi.spyOn(provider, "createPaymentLink").mockRejectedValueOnce(new Error("Fixture outage"));
    await expect(first.confirm(recipient(3), recipient(3), reserved.reference, 11)).rejects.toMatchObject({ status: 503 });
    const restarted = service();
    const { items } = await restarted.list(recipient(3), recipient(3), 1);
    expect(items.map(item => item.amountDue).sort()).toEqual([10000, 12000]);
    const order = items.find(item => item.amountDue === 12000)!;
    await expect(restarted.order(recipient(13), recipient(13), order.orderId, true)).rejects.toMatchObject({ status: 404 });
    const result = await restarted.order(recipient(3), recipient(3), order.orderId, true);
    expect(result.paymentLink).toContain("http://localhost:3000/");
    expect(await prisma.payment.count({ where: { orderId: order.orderId } })).toBe(1);
    await pay(order.orderId);
    expect(await restarted.order(recipient(3), recipient(3), order.orderId, false)).toMatchObject({ status: "paid", paymentLink: null });
    expect(await prisma.booking.findUnique({ where: { orderId: order.orderId } })).toMatchObject({ status: "confirmed" });
    expect(await prisma.ticket.count({ where: { orderId: order.orderId, status: "active" } })).toBe(2);
    expect((await restarted.list(recipient(3), recipient(3), 1)).items).toHaveLength(1);
  });

  it("rejects paused sales and an offer overtaken by a competing reservation", async () => {
    const checkout = service(), selected = await ticket(10000, false, 1);
    const offer = await checkout.prepare(recipient(4), recipient(4), "Guest", selected);
    await prisma.event.update({ where: { id: selected.eventId }, data: { salesPaused: true } });
    await expect(checkout.confirm(recipient(4), recipient(4), offer.reference, 7)).rejects.toMatchObject({ response: { code: "EVENT_SALES_PAUSED" } });
    await prisma.event.update({ where: { id: selected.eventId }, data: { salesPaused: false } });
    const competing = await checkout.prepare(recipient(5), recipient(5), "Guest", selected);
    await checkout.confirm(recipient(5), recipient(5), competing.reference, 8);
    await expect(checkout.confirm(recipient(4), recipient(4), offer.reference, 7)).rejects.toMatchObject({ response: { code: "INSUFFICIENT_INVENTORY" } });
  });

  it("supersedes an earlier offer for the same event and caps offers across events", async () => {
    const anonymous = new AnonymousService(prisma, booking, payments, events, clock, quickConfig);
    const quote = (eventId: string) => ({ kind: "ticket", itemId: randomUUID(), eventId, locale: "en", policyRevision: null, items: [] }) as never;
    const user = recipient(8), event = randomUUID();
    const first = await anonymous.startBotOffer("Guest", BigInt(user), quote(event));
    const second = await anonymous.startBotOffer("Guest", BigInt(user), quote(event));
    const pending = { telegramId: BigInt(user), orderId: null };
    expect(await prisma.anonymousCheckoutSession.count({ where: pending })).toBe(1);
    expect(await prisma.anonymousCheckoutSession.findUnique({ where: { id: first.reference } })).toBeNull();
    await expect(anonymous.confirmBotOffer(BigInt(user), first.reference, 1)).rejects.toMatchObject({ status: 404 });
    expect(await prisma.anonymousCheckoutSession.findUnique({ where: { id: second.reference } })).not.toBeNull();
    for (let i = 0; i < 11; i++) await anonymous.startBotOffer("Guest", BigInt(user), quote(randomUUID()));
    await expect(anonymous.startBotOffer("Guest", BigInt(user), quote(randomUUID()))).rejects.toMatchObject({ status: 429 });
    await anonymous.startBotOffer("Guest", BigInt(user), quote(event));
    expect(await prisma.anonymousCheckoutSession.count({ where: pending })).toBe(12);
  });

  it("refreshes a legacy price and expires only unused offers", async () => {
    const checkout = service(), selected = await ticket(10000);
    const initial = await checkout.prepare(recipient(6), recipient(6), "Guest", selected);
    await prisma.ticketType.update({ where: { id: selected.itemId }, data: { price: 13000 } });
    await approve(selected.eventId);
    const result = await checkout.confirm(recipient(6), recipient(6), initial.reference, 7);
    expect(result).toMatchObject({ offer: { amountDue: 13000, policyRevision: null } });
    now = new Date(now.getTime() + 601_000);
    const anonymous = new AnonymousService(prisma, booking, payments, events, clock, quickConfig);
    await anonymous.pruneBotOffers();
    expect(await prisma.anonymousCheckoutSession.findUnique({ where: { id: initial.reference } })).toBeNull();
    expect(await prisma.anonymousCheckoutSession.count({ where: { telegramId: BigInt(recipient(3)), orderId: { not: null } } })).toBe(2);
  });

  it("allows the linked account to see its registered order and enforces account restrictions", async () => {
    const linked = await prisma.user.create({ data: { telegramId: BigInt(recipient(7)), telegramChatId: BigInt(recipient(7)) } });
    const checkout = service(), selected = await ticket(15000);
    const registered = await booking.checkoutTickets(linked.id, randomUUID(), { ticketTypeId: selected.itemId, quantity: 1, termsAccepted: true });
    expect((await checkout.list(recipient(7), recipient(7), 1)).items).toMatchObject([{ orderId: registered.orderId }]);
    await prisma.user.update({ where: { id: linked.id }, data: { blockedAt: clock.now() } });
    await expect(checkout.order(recipient(7), recipient(7), registered.orderId, true)).rejects.toMatchObject({ response: { code: "ACCOUNT_RESTRICTED" } });
  });

  it("preserves the existing anonymous website checkout and exposes the same verified order in Telegram", async () => {
    const selected = await ticket(19000);
    const anonymous = new AnonymousService(prisma, booking, payments, events, clock, quickConfig);
    const session = await anonymous.start("Website guest");
    const token = new URL(session.telegramUrl).searchParams.get("start")!.slice(2);
    await anonymous.verify({ token, telegramId: recipient(8), chatId: recipient(8), messageId: 15 });
    const result = await anonymous.checkout(session.sessionToken, randomUUID(), "ticket", { ticketTypeId: selected.itemId, quantity: 1, termsAccepted: true });
    expect((await service().list(recipient(8), recipient(8), 1)).items).toMatchObject([{ orderId: result.orderId }]);
    expect(await anonymous.status(session.accessToken)).toMatchObject({ orderId: result.orderId, status: "pending" });
    await pay(result.orderId);
    expect(await anonymous.status(session.accessToken)).toMatchObject({ orderId: result.orderId, status: "paid" });
  });

  it("applies the internal service guard and private-chat validation on the checkout HTTP route", async () => {
    const network = globalThis.fetch;
    const intercept = vi.spyOn(globalThis, "fetch").mockImplementation((url, options) => {
      if (new URL(String(url)).hostname !== "127.0.0.1") return Promise.reject(new Error("External requests disabled for fixture"));
      return network(url, options);
    });
    const app = await NestFactory.create(BotModule, { logger: false, abortOnError: false });
    try {
      await app.listen(0, "127.0.0.1");
      const endpoint = `${await app.getUrl()}/bot/checkout/orders`;
      const body = JSON.stringify({ telegramId: recipient(9), chatId: recipient(9), page: 1 });
      const headers = { "content-type": "application/json" };
      expect((await fetch(endpoint, { method: "POST", headers, body })).status).toBe(401);
      const trusted = { ...headers, "x-bot-api-secret": process.env.BOT_API_SECRET! };
      const response = await fetch(endpoint, { method: "POST", headers: trusted, body });
      expect(response.status).toBe(201);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ items: [], hasNext: false });
      const wrongChat = JSON.stringify({ telegramId: recipient(9), chatId: recipient(10) });
      expect((await fetch(endpoint, { method: "POST", headers: trusted, body: wrongChat })).status).toBe(400);
    } finally {
      await app.close();
      intercept.mockRestore();
    }
  });

  it("groups purchases by event, reads a single individual or group QR, and rejects stale or copied callbacks", async () => {
    const buyer = recipient(21), checkout = service();
    const general = await ticket(0, true), whole = await table();
    const registration = await checkout.prepare(buyer, buyer, "Guest", general);
    const reservation = await checkout.prepare(buyer, buyer, "Guest", whole);
    const free = await checkout.confirm(buyer, buyer, registration.reference, 17);
    const pending = await checkout.confirm(buyer, buyer, reservation.reference, 18);
    if (!("order" in free) || !("order" in pending)) throw new Error("Expected two orders");
    expect((await wallet().list(buyer, buyer, "pending", 1, "en")).items.map(item => item.id)).toEqual([whole.eventId]);
    await pay(pending.order.orderId);
    const list = await wallet().list(buyer, buyer, "upcoming", 1, "en");
    expect(list.items).toHaveLength(2);
    expect(list.nextQr).not.toBeNull();
    const individual = (await wallet().order(buyer, buyer, free.order.orderId, 1, "en")).admissions[0]!;
    const group = (await wallet().order(buyer, buyer, pending.order.orderId, 1, "en")).admissions.find(item => item.kind === "group")!;
    expect((await wallet().qr(buyer, buyer, "ticket", individual.id)).subarray(1, 4).toString()).toBe("PNG");
    expect((await wallet().qr(buyer, buyer, "group", group.id)).subarray(1, 4).toString()).toBe("PNG");
    await expect(wallet().qr(recipient(22), recipient(22), "group", group.id)).rejects.toMatchObject({ status: 404 });
    await expect(wallet().order(recipient(22), recipient(22), free.order.orderId, 1, "en")).rejects.toMatchObject({ status: 404 });
    await prisma.event.update({ where: { id: whole.eventId }, data: { status: "cancelled" } });
    const past = await wallet().list(buyer, buyer, "past", 1, "en");
    expect(past.items.map(item => item.id)).toContain(whole.eventId);
    await expect(wallet().qr(buyer, buyer, "group", group.id)).rejects.toMatchObject({ status: 409 });
  });

  it("claims one verified purchase and confirms an eligible cancellation once using accepted terms", async () => {
    const buyer = recipient(23), checkout = service(), selected = await ticket(0, true);
    const offer = await checkout.prepare(buyer, buyer, "Guest", selected);
    const result = await checkout.confirm(buyer, buyer, offer.reference, 19);
    if (!("order" in result)) throw new Error("Expected an order");
    const orderId = result.order.orderId;
    expect(await wallet().claim(buyer, buyer, orderId)).toEqual({ linked: false });
    const user = await prisma.user.create({ data: { telegramId: BigInt(buyer), telegramChatId: BigInt(buyer) } });
    await expect(wallet().claim(recipient(24), recipient(24), orderId)).rejects.toMatchObject({ status: 404 });
    expect(await Promise.all([wallet().claim(buyer, buyer, orderId), wallet().claim(buyer, buyer, orderId)])).toEqual([{ linked: true }, { linked: true }]);
    const event = await wallet().event(buyer, buyer, selected.eventId, 1, "en");
    expect(event.orders.map(order => order.id)).toEqual([orderId]);
    expect(await prisma.order.findUnique({ where: { id: orderId } })).toMatchObject({ buyerUserId: user.id });
    expect(await prisma.outboxEvent.count({ where: { aggregateId: orderId, eventType: "order.claimed" } })).toBe(1);
    const ticketId = event.nextQr!.id;
    await expect(wallet().confirmReturn(buyer, buyer, "ticket", ticketId, "0000000000000000")).rejects.toMatchObject({ status: 409 });
    const quote = await wallet().previewReturn(buyer, buyer, "ticket", ticketId);
    expect(quote).toMatchObject({ acceptedPolicy: { freeCancellation: true }, amountPaid: 0 });
    const confirmations = await Promise.all([
      wallet().confirmReturn(buyer, buyer, "ticket", ticketId, quote.proof),
      wallet().confirmReturn(buyer, buyer, "ticket", ticketId, quote.proof),
    ]);
    expect(confirmations[0]).toEqual(confirmations[1]);
    expect(await prisma.outboxEvent.count({ where: { eventType: "ticket.cancelled", aggregateId: ticketId } })).toBe(1);
    expect((await wallet().order(buyer, buyer, orderId, 1, "en")).admissions[0]).toMatchObject({ status: "cancelled", qrAvailable: false });
    await expect(wallet().qr(buyer, buyer, "ticket", ticketId)).rejects.toMatchObject({ status: 404 });
  });

  it("links a reminder to the wallet and reads the current schedule after a reschedule", async () => {
    const buyer = recipient(25), checkout = service(), fixture = await ticket(0);
    const offer = await checkout.prepare(buyer, buyer, "Guest", fixture);
    await checkout.confirm(buyer, buyer, offer.reference, 20);
    const notifications = new EventNotificationsService(prisma);
    const initial = (await wallet().event(buyer, buyer, fixture.eventId, 1, "en")).event.startsAt;
    const send = vi.fn(async (_recipient: string, _text: string, _id?: string) => "1");
    await notifications.queueSystem({ eventId: fixture.eventId, requestKey: randomUUID(), type: "event.reminder", reminder: true, eventStart: initial, message: "Fixture reminder" });
    await notifications.tick(send);
    expect(send).toHaveBeenCalledWith(buyer, expect.stringContaining("Fixture reminder"), fixture.eventId);
    await notifications.queueSystem({ eventId: fixture.eventId, requestKey: randomUUID(), type: "event.reminder", reminder: true, eventStart: initial, message: "Obsolete reminder" });
    await prisma.event.update({ where: { id: fixture.eventId }, data: { time: new Date("1970-01-01T17:00:00Z"), address: "New location" } });
    await approve(fixture.eventId);
    await notifications.tick(send);
    expect(send).not.toHaveBeenCalledWith(buyer, expect.stringContaining("Obsolete reminder"), fixture.eventId);
    expect((await wallet().event(buyer, buyer, fixture.eventId, 1, "en")).event).toMatchObject({ startsAt: "2035-03-01T17:00:00.000Z", address: "New location" });
  });

  it("retries one rejected photo after restart without resending accepted or uncertain QR photos", async () => {
    const buyer = recipient(26), checkout = service();
    const offers = [];
    for (const kind of [await table(), await table()]) {
      const offer = await checkout.prepare(buyer, buyer, "Guest", kind);
      const result = await checkout.confirm(buyer, buyer, offer.reference, 21);
      if (!("order" in result)) throw new Error("Expected an order");
      await pay(result.order.orderId);
      offers.push(offer);
    }
    const anchor = vi.fn(async () => undefined);
    const photos = vi.fn<(_chat: string, image: Buffer, _caption: string) => Promise<void>>(async () => undefined)
      .mockResolvedValueOnce(undefined).mockRejectedValueOnce(new TelegramDeliveryRejected("RATE_LIMITED", 10));
    const worker = () => new QuickDeliveryService(prisma, clock);
    await worker().tick(anchor, [offers[0]!.reference], photos);
    await worker().tick(anchor, [offers[0]!.reference], photos);
    expect(photos).toHaveBeenCalledTimes(2);
    now = new Date(now.getTime() + 11_000);
    await worker().tick(anchor, [offers[0]!.reference], photos);
    expect(photos).toHaveBeenCalledTimes(3);
    expect(photos.mock.calls[2]?.[1]).toEqual(photos.mock.calls[1]?.[1]);
    expect(photos.mock.calls[2]?.[1]).not.toEqual(photos.mock.calls[0]?.[1]);
    expect(await prisma.anonymousCheckoutSession.findUnique({ where: { id: offers[0]!.reference } })).toMatchObject({ deliveredAt: now });
    const uncertain = vi.fn(async () => { throw new Error("Provider timed out"); });
    await worker().tick(anchor, [offers[1]!.reference], uncertain);
    await worker().tick(anchor, [offers[1]!.reference], uncertain);
    expect(uncertain).toHaveBeenCalledTimes(2);
    expect(await prisma.anonymousCheckoutSession.findUnique({ where: { id: offers[1]!.reference } })).toMatchObject({ deliveryFinishedAt: now, deliveredAt: null });
  });
});
