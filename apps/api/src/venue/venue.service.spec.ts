import "../test-support/require-test-database.js";
import { randomUUID } from "node:crypto";

import { prisma } from "@event-platform/database";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DomainEventsService } from "../domain-events/domain-events.service.js";
import type { Clock } from "../tables/tables.constants.js";
import { TablesService } from "../tables/tables.service.js";
import { VenueService } from "./venue.service.js";
import { approveEventsForTest } from "../test-support/approve-event.js";
import { holdTable } from "../test-support/table-hold.js";

const organizerA = randomUUID();
const organizerB = randomUUID();
const eventA = randomUUID();
const eventB = randomUUID();
let clockOffsetMs = 0;
const clock: Clock = { now: () => new Date(Date.now() + clockOffsetMs) };
const tables = new TablesService(prisma, new DomainEventsService(), { holdTtlSeconds: 600, cleanupIntervalSeconds: 60 }, clock);
const venue = new VenueService(prisma, new DomainEventsService(), tables);

beforeAll(async () => {
  const base = BigInt(Date.now()) * 100_000n;
  await prisma.user.createMany({ data: [
    { id: organizerA, telegramId: base + 801n, role: "organizer" },
    { id: organizerB, telegramId: base + 802n, role: "organizer" },
  ] });
  await prisma.event.createMany({ data: [eventData(eventA, organizerA), eventData(eventB, organizerB)] });
});

afterAll(async () => {
  await prisma.event.deleteMany({ where: { id: { in: [eventA, eventB] } } });
  await prisma.venueLayout.deleteMany({ where: { organizerId: organizerA } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: [organizerA, organizerB] } } });
  await prisma.user.deleteMany({ where: { id: { in: [organizerA, organizerB] } } });
  await prisma.$disconnect();
});

describe("VenueService", () => {
  it("creates owned layouts, validates exact geometry IDs, and hides cross-organizer resources", async () => {
    const layout = await venue.createForEvent(organizerA, eventA, {});
    const table = await tables.create(organizerA, layout.id, {
      number: 1, seats: 4, price: 0, geometry: { x: 30, y: 40, width: 100, height: 70 },
    });
    await expect(venue.get(organizerB, layout.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(venue.update(organizerA, layout.id, {
      layoutJson: { version: 1, canvas: { width: 800, height: 600 }, tables: [] },
    })).rejects.toBeInstanceOf(BadRequestException);
    const updated = await venue.update(organizerA, layout.id, {
      layoutJson: { version: 1, canvas: { width: 800, height: 600 }, tables: [{ tableId: table.id, x: 100, y: 120, width: 100, height: 70 }] },
    });
    expect(updated.layoutJson.tables[0]).toMatchObject({ tableId: table.id, x: 100, y: 120 });
  });

  it("clones reusable templates with independent layout and table IDs", async () => {
    const source = await venue.getForEvent(organizerA, eventA);
    const template = await venue.saveTemplate(organizerA, source.id, "Банкетная схема");
    expect(template.eventId).toBeNull();
    expect(template.organizerId).toBe(organizerA);
    expect(template.tables[0]?.id).not.toBe(source.tables[0]?.id);
    expect(template.layoutJson.tables[0]?.tableId).toBe(template.tables[0]?.id);

    const applied = await venue.applyTemplate(organizerA, eventB, template.id).catch((error) => {
      expect(error).toBeInstanceOf(NotFoundException);
      return null;
    });
    expect(applied).toBeNull();

    const ownEvent = randomUUID();
    await prisma.event.create({ data: eventData(ownEvent, organizerA) });
    const clone = await venue.applyTemplate(organizerA, ownEvent, template.id);
    expect(clone.id).not.toBe(template.id);
    expect(clone.tables[0]?.id).not.toBe(template.tables[0]?.id);
    expect(clone.layoutJson.tables[0]?.tableId).toBe(clone.tables[0]?.id);
    await prisma.event.delete({ where: { id: ownEvent } });

    const disposable = await venue.saveTemplate(organizerA, source.id, "Одноразовая схема");
    await expect(venue.delete(organizerA, disposable.id)).resolves.toEqual({ deleted: true, id: disposable.id });

    await approveEventsForTest(prisma, eventA);
    const hold = await holdTable(tables, source.tables[0]!.id, `layout-history-${randomUUID()}`);
    expect(hold.holdToken).toHaveLength(43);
    await expect(venue.delete(organizerA, source.id)).rejects.toThrow("hold or booking history");
  });

  it("presents an expired but uncleaned table hold as available and issues no write", async () => {
    const eventId = randomUUID();
    await prisma.event.create({ data: eventData(eventId, organizerA) });
    try {
      const layout = await venue.createForEvent(organizerA, eventId, {});
      const table = await tables.create(organizerA, layout.id, { number: 1, seats: 4, price: 0, geometry: { x: 30, y: 40, width: 100, height: 70 } });
      await approveEventsForTest(prisma, eventId);
      const hold = await holdTable(tables, table.id, `layout-lapsed-${randomUUID()}`);
      expect((await venue.get(organizerA, layout.id)).tables[0]).toMatchObject({ status: "held" });
      const before = await prisma.table.findUniqueOrThrow({ where: { id: table.id } });
      clockOffsetMs = 601_000;
      for (const read of [venue.get(organizerA, layout.id), venue.getForEvent(organizerA, eventId)]) {
        expect((await read).tables[0]).toMatchObject({ id: table.id, status: "available", holdExpiresAt: null });
      }
      await expect(prisma.table.findUniqueOrThrow({ where: { id: table.id } })).resolves.toEqual(before);
      await expect(prisma.tableHold.findUniqueOrThrow({ where: { token: hold.holdToken } })).resolves.toMatchObject({ status: "active" });
      await expect(prisma.outboxEvent.count({ where: { aggregateId: table.id, eventType: "table.hold_expired" } })).resolves.toBe(0);
    } finally {
      clockOffsetMs = 0;
      await prisma.event.delete({ where: { id: eventId } });
    }
  });
});

function eventData(id: string, organizerId: string) {
  return {
    id, organizerId, title: `Event ${id.slice(0, 4)}`, date: new Date("2027-07-01T00:00:00Z"),
    time: new Date("1970-01-01T20:00:00Z"), timezone: "Asia/Almaty", address: "Адрес", status: "published" as const,
  };
}
