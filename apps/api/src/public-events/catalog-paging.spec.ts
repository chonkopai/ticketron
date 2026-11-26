import "../test-support/require-test-database.js";
import { createPrismaClient, type Prisma } from "@event-platform/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DomainEventsService } from "../domain-events/domain-events.service.js";
import { TablesService } from "../tables/tables.service.js";
import { TicketTypesService } from "../ticket-types/ticket-types.service.js";
import { PublicEventsService } from "./public-events.service.js";

// Regression: the default homepage request (sort=soonest +
// includeRemaining) must page in SQL with a query count that does not grow with
// the catalogue, and must return exactly what the in-memory scan returned.

const database = createPrismaClient({ log: [{ emit: "event", level: "query" }] });
let queries = 0;
(database as unknown as { $on(event: "query", listener: () => void): void }).$on("query", () => { queries += 1; });

const now = new Date("2027-03-01T00:00:00.000Z");
const clock = { now: () => now };
const domainEvents = new DomainEventsService();
const tables = new TablesService(database, domainEvents, { holdTtlSeconds: 60, cleanupIntervalSeconds: 60 }, clock);
const service = new PublicEventsService(database, new TicketTypesService(database, domainEvents), tables);

const uuid = (group: number, index: number) => `00000000-0000-4000-8${group.toString().padStart(3, "0")}-${index.toString().padStart(12, "0")}`;
const ownerId = uuid(1, 1), blockedOwnerId = uuid(1, 2), buyerId = uuid(1, 3);
const day = 86_400_000;
const VISIBLE = 24;
const visibleIds = Array.from({ length: VISIBLE }, (_, index) => uuid(2, index));
const hiddenIds = Array.from({ length: 5 }, (_, index) => uuid(3, index));
const extraIds = Array.from({ length: 30 }, (_, index) => uuid(4, index));
const orderIds: string[] = [];

function eventRow(id: string, index: number): Prisma.EventCreateManyInput {
  const legacy = index === 5 || index === 11;
  const startsAt = new Date(now.getTime() + ((index * 7) % VISIBLE + 1) * day + (index % 4) * 3_600_000);
  const russia = index % 3 === 0;
  return {
    id, organizerId: ownerId, title: `Paging fixture ${index}`, status: "published",
    countryCode: russia ? "RU" : "KZ", city: russia ? "Москва" : index % 2 ? "Алматы" : "Астана",
    category: index % 2 ? "music" : "theatre", address: "Test venue",
    paymentMode: index === 17 ? "deposit" : "full_payment",
    // Legacy rows carry only the local date/time; the rest also carry instants.
    date: new Date(`${startsAt.toISOString().slice(0, 10)}T00:00:00.000Z`),
    time: new Date(`1970-01-01T${startsAt.toISOString().slice(11, 19)}.000Z`),
    timezone: "UTC",
    startsAt: legacy ? null : startsAt,
    endsAt: legacy || index % 2 ? null : new Date(startsAt.getTime() + 3 * 3_600_000),
    publishedAt: new Date(Date.UTC(2027, 0, 1 + ((index * 5) % VISIBLE))),
  };
}

async function approveAll() {
  await database.event.updateMany({ where: { organizerId: { in: [ownerId, blockedOwnerId] }, status: "published", id: { not: hiddenIds[1]! } }, data: { approvedAt: now, moderationStatus: "approved" } });
  await database.event.update({ where: { id: hiddenIds[4]! }, data: { moderationStatus: "sales_paused", salesPaused: true } });
}

beforeAll(async () => {
  await database.user.createMany({ data: [
    { id: ownerId, role: "organizer", name: "Owner" },
    { id: blockedOwnerId, role: "organizer", name: "Blocked", blockedAt: now },
    { id: buyerId, role: "guest", name: "Buyer" },
  ] });
  await database.event.createMany({ data: visibleIds.map(eventRow) });
  await database.event.createMany({ data: [
    { ...eventRow(hiddenIds[0]!, 30), organizerId: blockedOwnerId },
    { ...eventRow(hiddenIds[1]!, 31) }, // stays pending moderation
    { ...eventRow(hiddenIds[2]!, 32), startsAt: new Date(now.getTime() - 2 * day), endsAt: new Date(now.getTime() - day) },
    { ...eventRow(hiddenIds[3]!, 5), date: new Date("2027-02-01T00:00:00.000Z") }, // legacy, already past
    { ...eventRow(hiddenIds[4]!, 34) }, // sales_paused is still public
  ] });
  for (const [index, eventId] of visibleIds.entries()) {
    const variant = index % 6;
    if (variant === 0) {
      const type = await database.ticketType.create({ data: { eventId, name: "Standard", price: 5_000 + index, currency: "KZT", quantityTotal: 10, status: "active" } });
      const order = await database.order.create({ data: { type: "ticket", buyerUserId: buyerId, amount: 5_000, currency: "KZT", paymentStatus: "paid" } });
      orderIds.push(order.id);
      await database.ticket.createMany({ data: [0, 1].map(n => ({ ticketTypeId: type.id, orderId: order.id, ownerUserId: buyerId, qrToken: `paging-${index}-${n}`, status: "active" as const })) });
    } else if (variant === 1) {
      await database.ticketType.createMany({ data: [
        { eventId, name: "KZT", price: 7_000, currency: "KZT", quantityTotal: 3, status: "active" },
        { eventId, name: "USD", price: 900, currency: "USD", quantityTotal: 3, status: "active" },
      ] });
    } else if (variant === 2) {
      const type = await database.ticketType.create({ data: { eventId, name: "Last one", price: 3_000, currency: "KZT", quantityTotal: 1, status: "active" } });
      await database.ticketReservation.create({ data: { ticketTypeId: type.id, token: `paging-hold-${index}`, quantity: 1, expiresAt: new Date(now.getTime() + 600_000) } });
    } else if (variant === 3) {
      const layout = await database.venueLayout.create({ data: { eventId, templateName: "Hall", layoutJson: { version: 1, canvas: { width: 100, height: 100 }, tables: [] } } });
      await database.table.create({ data: { venueLayoutId: layout.id, number: 1, seats: 4, price: 40_000, deposit: 10_000, currency: "KZT", status: "available" } });
      const held = await database.table.create({ data: { venueLayoutId: layout.id, number: 2, seats: 4, price: 30_000, deposit: 10_000, currency: "KZT", status: "held", holdToken: `paging-table-${index}`, holdRequestKey: `paging-${index}`, holdExpiresAt: new Date(now.getTime() - 60_000) } });
      await database.tableHold.create({ data: { tableId: held.id, requestKey: `paging-${index}`, token: `paging-table-${index}`, expiresAt: new Date(now.getTime() - 60_000) } });
    } else if (variant === 4) {
      const layout = await database.venueLayout.create({ data: { eventId, templateName: "Hall", layoutJson: { version: 1, canvas: { width: 100, height: 100 }, tables: [] } } });
      const open = await database.ticketType.create({ data: { eventId, name: "Seat A", price: 12_000, currency: "KZT", quantityTotal: 3, status: "active" } });
      const later = await database.ticketType.create({ data: { eventId, name: "Seat B", price: 9_000, currency: "KZT", quantityTotal: 1, status: "active", salesStartAt: new Date(now.getTime() + day) } });
      const seats = await database.seat.createManyAndReturn({ data: [
        { venueLayoutId: layout.id, number: 1, label: "1", sortOrder: 0, ticketTypeId: open.id },
        { venueLayoutId: layout.id, number: 2, label: "2", sortOrder: 1, ticketTypeId: open.id },
        { venueLayoutId: layout.id, number: 3, label: "3", sortOrder: 2, ticketTypeId: open.id },
        { venueLayoutId: layout.id, number: 4, label: "4", sortOrder: 3, ticketTypeId: later.id },
      ] });
      const order = await database.order.create({ data: { type: "ticket", buyerUserId: buyerId, amount: 12_000, currency: "KZT", paymentStatus: "pending" } });
      orderIds.push(order.id);
      await database.seatAllocation.create({ data: { seatId: seats[0]!.id, orderId: order.id, status: "active" } });
    } else {
      await database.ticketType.create({ data: { eventId, name: "Closed", price: 2_000, currency: "KZT", quantityTotal: 5, status: "active", salesEndAt: new Date(now.getTime() - day) } });
    }
  }
  await approveAll();
});

afterAll(async () => {
  await database.order.deleteMany({ where: { id: { in: orderIds } } });
  await database.event.deleteMany({ where: { organizerId: { in: [ownerId, blockedOwnerId] } } });
  await database.user.deleteMany({ where: { id: { in: [ownerId, blockedOwnerId, buyerId] } } });
  await database.$disconnect();
});

async function counted<T>(run: () => Promise<T>): Promise<{ result: T; queries: number }> {
  queries = 0;
  const result = await run();
  return { result, queries };
}

const homepage = { sort: "soonest" as const, includeRemaining: true, limit: 18 };
const QUERY_SHAPES: Array<Parameters<PublicEventsService["list"]>[0]> = [
  { ...homepage, page: 1 },
  { ...homepage, page: 2 },
  { ...homepage, page: 1, limit: 5, countryCode: "KZ" },
  { ...homepage, page: 3, limit: 5, countryCode: "KZ" },
  { ...homepage, page: 1, limit: 7, city: "Алматы", countryCode: "KZ" },
  { ...homepage, page: 2, limit: 7, category: "music", countryCode: "RU" },
  { ...homepage, page: 1, limit: 10, from: "2027-03-05", to: "2027-03-15" },
  { sort: "soonest", page: 1, limit: 5, category: "music" },
  { sort: "soonest", page: 2, limit: 4, countryCode: "KZ" },
  { sort: "recent", page: 1, limit: 6, countryCode: "KZ" },
  { sort: "recent", page: 2, limit: 6 },
];

describe("catalogue SQL paging", () => {
  it("keeps the homepage query count independent of the catalogue size", async () => {
    const small = await counted(() => service.list({ ...homepage, page: 1 }, now));
    expect(small.result.total).toBe(VISIBLE + 1);
    await database.event.createMany({ data: extraIds.map((id, index) => eventRow(id, index)) });
    await approveAll();
    try {
      const large = await counted(() => service.list({ ...homepage, page: 1 }, now));
      expect(large.result.total).toBe(VISIBLE + 1 + extraIds.length);
      console.info(`[catalog-paging] homepage queries: ${VISIBLE + 1} events → ${small.queries}, ${VISIBLE + 1 + extraIds.length} events → ${large.queries}`);
      expect(large.queries).toBe(small.queries);
      expect(large.queries).toBeLessThanOrEqual(25);
    } finally {
      await database.event.deleteMany({ where: { id: { in: extraIds } } });
    }
  });

  it("returns exactly what the in-memory scan returns, page by page", async () => {
    for (const shape of QUERY_SHAPES) {
      const reference = await service.listByScan(shape, now);
      const paged = await service.list(shape, now);
      expect({ shape, paged }).toEqual({ shape, paged: reference });
    }
  });

  it("orders matches first, then the remaining events chronologically, across page boundaries", async () => {
    const pages = await Promise.all([1, 2, 3, 4, 5].map(page => service.list({ ...homepage, page, limit: 6, countryCode: "RU" }, now)));
    const items = pages.flatMap(page => page.items);
    const matching = pages[0]!.matchingTotal!;
    expect(new Set(items.map(item => item.id)).size).toBe(VISIBLE + 1);
    expect(items.slice(0, matching).every(item => item.countryCode === "RU")).toBe(true);
    expect(items.slice(matching).some(item => item.countryCode === "RU")).toBe(false);
    for (const group of [items.slice(0, matching), items.slice(matching)]) {
      const starts = group.map(item => Date.parse(item.startsAt));
      expect(starts).toEqual([...starts].sort((left, right) => left - right));
    }
    expect(items.some(item => hiddenIds.slice(0, 4).includes(item.id))).toBe(false);
    expect(items.some(item => item.id === hiddenIds[4])).toBe(true);
  });

  it("reports an expired whole-table hold as available without writing on the read path", async () => {
    const eventId = visibleIds[3]!;
    const before = await database.tableHold.findFirstOrThrow({ where: { token: "paging-table-3" } });
    const summary = await service.summary(eventId, now);
    expect(summary).toMatchObject({ remainingTables: 2, saleStatus: "few_left", startingAmount: 30_000, startingUnit: "table" });
    const after = await database.tableHold.findFirstOrThrow({ where: { token: "paging-table-3" } });
    expect(after.status).toBe(before.status);
  });
});
