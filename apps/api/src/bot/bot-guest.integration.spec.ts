import { databaseSuiteEnabled } from "@event-platform/database/test-database-guard";
import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { prisma } from "@event-platform/database";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BotModule } from "./bot.module.js";

const enabled = databaseSuiteEnabled("Telegram guest", "TELEGRAM_GUEST_DB_TEST");
const organizerId = randomUUID();
const base = BigInt(Date.now()) * 100n;
const linkedId = String(base + 11n), anonymousId = String(base + 12n);
const title = `Guest catalogue ${randomUUID()}`;
let app: INestApplication, origin: string, visibleId: string, hiddenId: string;

async function createEvent(visible: boolean) {
  const event = await prisma.event.create({ data: {
    organizerId, title, sourceLocale: "en", city: "Астана", countryCode: "KZ", category: "music",
    address: "Test venue", date: new Date("2040-03-01"), time: new Date("1970-01-01T17:00:00Z"), timezone: "UTC",
  } });
  await prisma.ticketType.create({ data: { eventId: event.id, name: "Free", price: 0, currency: "KZT", quantityTotal: 5, status: "active" } });
  await prisma.event.update({ where: { id: event.id }, data: { status: "published", moderationStatus: visible ? "approved" : "hidden", approvedAt: new Date() } });
  return event.id;
}

function guest(endpoint: string, telegramId: string, body: Record<string, unknown> = {}, secret = process.env.BOT_API_SECRET) {
  return fetch(`${origin}/bot/guest/${endpoint}`, {
    method: "POST", headers: { "content-type": "application/json", ...(secret ? { "x-bot-api-secret": secret } : {}) },
    body: JSON.stringify({ telegramId, chatId: telegramId, ...body }),
  });
}

describe.runIf(enabled)("Telegram guest settings and public catalogue HTTP", () => {
  beforeAll(async () => {
    await prisma.user.create({ data: { id: organizerId, telegramId: BigInt(linkedId), telegramChatId: BigInt(linkedId), role: "organizer", defaultCity: "Астана", defaultCountry: "KZ" } });
    await prisma.notification.create({ data: { userId: organizerId, channel: "in_app", status: "sent", type: "event.reminder", payload: { text: "Linked inbox fixture" } } });
    visibleId = await createEvent(true);
    hiddenId = await createEvent(false);
    app = await NestFactory.create(BotModule, { logger: false, abortOnError: false });
    await app.listen(0, "127.0.0.1");
    origin = await app.getUrl();
  });
  afterAll(async () => { await app?.close(); await prisma.$disconnect(); });

  it("reads account defaults without writing, and stores only explicit Telegram preferences", async () => {
    expect(await (await guest("settings", linkedId)).json()).toEqual({
      locale: null, location: { city: "Астана", countryCode: "KZ" }, linked: true, canOrganize: true,
    });
    expect(await prisma.telegramGuestPreference.findUnique({ where: { telegramId: BigInt(linkedId) } })).toBeNull();
    const saved = await guest("preferences", anonymousId, { locale: "kk", location: { city: "Алматы", countryCode: "KZ" } });
    expect(saved.status).toBe(201);
    expect(await (await guest("settings", anonymousId)).json()).toMatchObject({ locale: "kk", location: { city: "Алматы" }, linked: false });
    expect(await prisma.user.findUnique({ where: { telegramId: BigInt(anonymousId) } })).toBeNull();
    expect(await (await guest("preferences", linkedId, { location: null })).json()).toMatchObject({ location: null });
    expect(await prisma.user.findUnique({ where: { id: organizerId } })).toMatchObject({ defaultCity: "Астана" });
  });

  it("restricts preferences and inbox to the trusted private chat and rechecks organizer access", async () => {
    expect((await guest("settings", linkedId, {}, "")).status).toBe(401);
    expect((await guest("preferences", linkedId, { chatId: anonymousId, locale: "ru" })).status).toBe(400);
    expect((await guest("preferences", linkedId, { locale: "und" })).status).toBe(400);
    expect((await guest("messages", anonymousId, { locale: "en" })).status).toBe(404);
    expect(await (await guest("messages", linkedId, { locale: "en" })).json()).toMatchObject({ items: [{ text: "Linked inbox fixture" }] });
    await prisma.user.update({ where: { id: organizerId }, data: { blockedAt: new Date() } });
    expect(await (await guest("settings", linkedId)).json()).toMatchObject({ canOrganize: false });
    expect((await guest("messages", linkedId, { locale: "en" })).status).toBe(403);
    expect((await guest("preferences", linkedId, { locale: "en" })).status).toBe(403);
    await prisma.user.update({ where: { id: organizerId }, data: { blockedAt: null } });
  });

  it("uses the shared catalogue query and rejects a hidden event by public ID", async () => {
    const params = new URLSearchParams({ locale: "en", city: "Astana", countryCode: "KZ", category: "music", free: "true", search: title, page: "1", limit: "6" });
    const list = await fetch(`${origin}/events?${params}`);
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ items: [{ id: visibleId, city: "Astana", saleStatus: "few_left", startingPrices: [{ amount: 0 }] }], total: 1 });
    expect((await fetch(`${origin}/events/${hiddenId}?locale=kk`)).status).toBe(404);
  });
});
