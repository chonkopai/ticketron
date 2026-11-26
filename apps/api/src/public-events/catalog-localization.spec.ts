import "../test-support/require-test-database.js";
import { randomUUID } from "node:crypto";

import { createPrismaClient, type Prisma } from "@event-platform/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DomainEventsService } from "../domain-events/domain-events.service.js";
import { approveEventsForTest } from "../test-support/approve-event.js";
import { TablesService } from "../tables/tables.service.js";
import { TicketTypesService } from "../ticket-types/ticket-types.service.js";
import { PublicEventsService } from "./public-events.service.js";

// A catalogue page localizes every item; the cost must not grow per event.

const database = createPrismaClient({ log: [{ emit: "event", level: "query" }] });
let queries = 0;
(database as unknown as { $on(event: "query", listener: () => void): void }).$on("query", () => { queries += 1; });
const now = new Date("2027-03-01T00:00:00.000Z");
const domainEvents = new DomainEventsService();
const tables = new TablesService(database, domainEvents, { holdTtlSeconds: 60, cleanupIntervalSeconds: 60 }, { now: () => now });
const service = new PublicEventsService(database, new TicketTypesService(database, domainEvents), tables);

const organizerId: string = randomUUID();
const legacyTranslated: string = randomUUID(), legacyPlain: string = randomUUID(), v2Translated: string = randomUUID(), v2Plain: string = randomUUID(), v2Plain2: string = randomUUID();
const ids = [legacyTranslated, legacyPlain, v2Translated, v2Plain, v2Plain2];

function base(id: string, title: string, day: number): Prisma.EventCreateManyInput {
  return { id, organizerId, title, category: "music", city: "Алматы", countryCode: "KZ", address: "Адрес", status: "published" as const, timezone: "UTC",
    date: new Date(`2027-04-0${day}T00:00:00.000Z`), time: new Date("1970-01-01T18:00:00.000Z"), startsAt: new Date(`2027-04-0${day}T18:00:00.000Z`), publishedAt: now };
}
const v2 = { creationVersion: 2, v2State: "reconciled" as const, saleMode: "free" as const, currency: "KZT", refundsAvailable: false, refundPolicyRevision: 1 };

const v2Ids = [v2Translated, v2Plain, v2Plain2];
const assetIds: string[] = [];

// The publication trigger needs ready media and source-locale content, so v2
// events are built as drafts and published last.
async function publishV2(eventId: string, caption: string | null) {
  const asset = await database.mediaAsset.create({ data: { eventId, kind: "image", state: "ready", width: 800, height: 600, storageKey: `loc-${eventId}`, checksum: "a".repeat(64), contentType: "image/png", bytes: 1000n } });
  assetIds.push(asset.id);
  await database.eventMedia.create({ data: { eventId, assetId: asset.id, slot: 0, isCard: true, isBackground: true } });
  if (caption) await database.mediaAssetContent.createMany({ data: [{ assetId: asset.id, locale: "ru", caption: `${caption} ru` }, { assetId: asset.id, locale: "en", caption: `${caption} en` }] });
  const type = await database.ticketType.create({ data: { eventId, name: "Free", price: 0, currency: "KZT", quantityTotal: 10, status: "active" } });
  await database.ticketTypeContent.createMany({ data: ["ru", "en"].map(locale => ({ ticketTypeId: type.id, locale, name: `Free ${locale}`, description: "" })) });
  await database.event.update({ where: { id: eventId }, data: { status: "published" } });
}

beforeAll(async () => {
  await database.user.create({ data: { id: organizerId, role: "organizer", name: "Org" } });
  await database.event.createMany({ data: [
    base(legacyTranslated, "Legacy RU", 1), base(legacyPlain, "Legacy plain", 2),
    ...v2Ids.map((id, index) => ({ ...base(id, "V2", 3 + index), ...v2, status: "draft" as const, endsAt: new Date(`2027-04-0${3 + index}T20:00:00.000Z`) })),
  ] });
  await database.eventTranslation.create({ data: { eventId: legacyTranslated, locale: "en", title: "Legacy EN", address: "Address EN", origin: "manual" } });
  const content = (eventId: string, locale: string, title: string) => ({ eventId, locale, title, description: "d", address: locale === "en" ? "Address EN" : "Адрес", refundConditions: "" });
  await database.eventContent.createMany({ data: [
    content(v2Translated, "ru", "V2 RU"), content(v2Translated, "en", "V2 EN"), content(v2Plain, "ru", "V2 plain"), content(v2Plain2, "ru", "V2 plain 2"),
  ] });
  await publishV2(v2Translated, "Cap"); await publishV2(v2Plain, null); await publishV2(v2Plain2, "Cap2");
  // Resource edits flag the event for reconciliation; restore the state a real publish leaves.
  await database.event.updateMany({ where: { id: { in: v2Ids } }, data: { v2State: "reconciled" } });
  await approveEventsForTest(database, ...ids);
});

afterAll(async () => {
  await database.event.deleteMany({ where: { id: { in: ids } } });
  await database.mediaAsset.deleteMany({ where: { id: { in: assetIds } } });
  await database.user.deleteMany({ where: { id: organizerId } });
  await database.$disconnect();
});

const query = (locale: "ru" | "en") => ({ sort: "soonest" as const, page: 1, limit: 20, locale });
const pick = (items: Array<Record<string, unknown>>) => items.filter(item => ids.includes(item.id as string))
  .map(item => ({ id: item.id, title: item.title, address: item.address, city: item.city, contentLocale: item.contentLocale, sourceLocale: item.sourceLocale }));

describe("catalogue localization", () => {
  it("localizes a mixed page in two locales, falling back when a translation is missing", async () => {
    const en = await service.list(query("en"), now);
    const ru = await service.list(query("ru"), now);
    const byId = (items: ReturnType<typeof pick>) => Object.fromEntries(items.map(item => [item.id as string, item]));
    const enItems = byId(pick(en.items as never)), ruItems = byId(pick(ru.items as never));
    expect(enItems[legacyTranslated]).toMatchObject({ title: "Legacy EN", address: "Address EN", contentLocale: "en", sourceLocale: "ru" });
    expect(enItems[legacyPlain]).toMatchObject({ title: "Legacy plain", contentLocale: "ru", sourceLocale: "ru" });
    expect(enItems[v2Translated]).toMatchObject({ title: "V2 EN", address: "Address EN", contentLocale: "en" });
    expect(enItems[v2Plain]).toMatchObject({ title: "V2 plain", contentLocale: "ru" });
    expect(ruItems[legacyTranslated]).toMatchObject({ title: "Legacy RU", contentLocale: "ru" });
    expect(ruItems[v2Translated]).toMatchObject({ title: "V2 RU", contentLocale: "ru" });
    expect(Object.keys(enItems)).toHaveLength(5);
    expect(enItems[legacyTranslated]!.city).toBe("Almaty");
    expect(ruItems[legacyTranslated]!.city).toBe("Алматы");
  });

  it("keeps the query count flat as normalized events are added", async () => {
    await service.list(query("en"), now);
    queries = 0;
    await service.list(query("en"), now);
    console.info(`[catalog-localization] queries for a 5-event page: ${queries}`);
    expect(queries).toBeLessThanOrEqual(Number(process.env.LOCALIZATION_QUERY_BUDGET ?? 25));
  });
});
