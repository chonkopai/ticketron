import { randomUUID } from "node:crypto";
import type { BotGuestSettings, BotGuestSettingsUpdate } from "@event-platform/shared-types";
import { describe, expect, it, vi } from "vitest";
import { createBot } from "./bot.js";

const id = randomUUID(), itemId = randomUUID();
const event = {
  id, title: "A Jazz Evening", city: "Алматы", countryCode: "KZ", address: "1 Music Street",
  date: "2040-03-04", time: "19:00", timezone: "Asia/Almaty", startsAt: "2040-03-04T14:00:00Z",
  posterUrl: "/media/events/fixture/display", paymentMode: "full_payment", description: "Details", rules: "Doors open at 18:30",
  startingPrices: [{ amount: 12000, currency: "KZT", unit: "ticket" }], saleStatus: "available",
  ticketTypes: [{ id: itemId, status: "active", name: "General", remaining: 10, payment: { amountDue: 12000, currency: "KZT" } }], tables: [],
};

type Button = { text: string; callback_data?: string; url?: string };
type Payload = { text?: string; caption?: string; photo?: string; reply_markup?: { inline_keyboard?: Button[][]; force_reply?: boolean } };

function fixture(params: { preferences?: Map<string, BotGuestSettings>; messagesEnabled?: boolean; poster?: string | null; rejectPhoto?: boolean; title?: string; longRules?: string; hidden?: boolean; paused?: boolean; soldOut?: boolean; seatMiniAppName?: string } = {}) {
  const preferences = params.preferences ?? new Map<string, BotGuestSettings>();
  const entry = { ...event, title: params.title ?? event.title, posterUrl: params.poster === undefined ? event.posterUrl : params.poster,
    rules: params.longRules ?? event.rules, salesPaused: params.paused ?? false, saleStatus: params.soldOut ? "sold_out" : event.saleStatus };
  const urls: URL[] = [], saves: BotGuestSettingsUpdate[] = [];
  const defaults = { locale: null, location: null, linked: false, canOrganize: false };
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input)); urls.push(url);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    if (url.pathname === "/bot/guest/settings") return Response.json(preferences.get(body.telegramId) ?? defaults);
    if (url.pathname === "/bot/guest/preferences") {
      const { locale, location } = body;
      const changes = { ...(locale !== undefined ? { locale } : {}), ...(location !== undefined ? { location } : {}) };
      saves.push(changes);
      const updated = { ...defaults, ...preferences.get(body.telegramId), ...changes };
      preferences.set(body.telegramId, updated);
      return Response.json(updated);
    }
    if (url.pathname === "/events") return Response.json({ items: [entry], hasNext: url.searchParams.get("page") === "1" });
    if (url.pathname === "/events/locations") return Response.json([{ countryCode: "KZ", cities: ["Алматы", "Almaty", "Астана"] }]);
    if (url.pathname.endsWith("/venue-layout")) return Response.json({ seats: [], rows: [], tables: [{ saleMode: "whole_table" }] });
    if (url.pathname === `/events/${id}` || url.pathname === `/events/${id}/summary`) {
      return params.hidden ? Response.json({ code: "EVENT_NOT_FOUND" }, { status: 404 }) : Response.json(entry);
    }
    if (url.pathname === "/bot/checkout/offers") return Response.json({
      reference: randomUUID(), eventId: id, expiresAt: "2040-01-01T12:00:00Z", title: event.title, itemName: "General",
      amountDue: 12000, currency: "KZT", refundTerms: "Refunds until 6 hours before entry.", timezone: event.timezone,
    });
    if (url.pathname === "/bot/guest/messages") return Response.json({ items: [{ text: "Doors open at 18:30." }], hasNext: false });
    if (url.pathname === "/bot/companion/inbox") return Response.json({ items: [], hasNext: false });
    if (url.pathname === "/bot/identity") return Response.json({ user: { id: "fixture-user", role: "organizer" } });
    throw new Error(`Unexpected fixture route ${url.pathname}`);
  });
  const bot = createBot("1:test", "fixture_bot", { apiBaseUrl: "http://fixture.invalid", botApiSecret: "fixture", webOrigin: "https://ticket.invalid",
    ...(params.seatMiniAppName ? { seatMiniAppName: params.seatMiniAppName } : {}),
    ...(params.messagesEnabled === undefined ? {} : { messagesEnabled: params.messagesEnabled }), fetch: request });
  let update = 0, messageId = 40;
  const outputs: Array<{ method: string; payload: Payload; id: number }> = [];
  const user = (userId: number, lang: string) => ({ id: userId, is_bot: false, first_name: "Fixture", language_code: lang });
  const chat = (userId: number) => ({ id: userId, type: "private" as const, first_name: "Fixture" });
  bot.api.config.use(async (_next, method, payload) => {
    if (method !== "answerCallbackQuery") outputs.push({ method, payload: payload as Payload, id: ++messageId });
    if (method === "sendPhoto" && params.rejectPhoto) return { ok: false, error_code: 400, description: "Missing image" };
    return { ok: true, result: (method === "answerCallbackQuery" ? true : { message_id: messageId, date: 1, chat: chat(77), ...payload }) as never };
  });
  const command = (text: string, userId = 77, lang = "en") => bot.handleUpdate({ update_id: ++update, message: {
    message_id: ++messageId, date: 1, text, chat: chat(userId), from: user(userId, lang),
    entities: [{ offset: 0, length: text.split(" ")[0]!.length, type: "bot_command" }],
  } });
  const reply = (text: string, target: number, userId = 77) => bot.handleUpdate({ update_id: ++update, message: {
    message_id: ++messageId, date: 1, text, chat: chat(userId), from: user(userId, "en"),
    reply_to_message: { message_id: target, date: 1, chat: chat(userId), text: "Fixture prompt" } as never,
  } });
  const press = (data: string, userId = 77, lang = "en") => bot.handleUpdate({ update_id: ++update, callback_query: {
    id: String(update), data, from: user(userId, lang), chat_instance: "fixture", message: { message_id: messageId, date: 1, chat: chat(userId), text: "Fixture panel" },
  } });
  const last = () => outputs.at(-1)!;
  const buttons = () => last().payload.reply_markup?.inline_keyboard?.flat() ?? [];
  const button = (label: string) => {
    const found = buttons().find(item => item.text === label);
    if (!found) throw new Error(`Missing ${label} in ${JSON.stringify(buttons())}`);
    return found;
  };
  const tap = (label: string, userId = 77, lang = "en") => press(button(label).callback_data!, userId, lang);
  return { command, press, reply, tap, button, buttons, last, urls, saves, outputs };
}

describe("Telegram guest navigation", () => {
  it("launches the named Mini App for a whole-table hall with only the public event reference", async () => {
    const bot = fixture({ seatMiniAppName: "seats" });
    await bot.command(`/start e_${id}`);
    await bot.tap("🎟 Buy tickets");
    expect(bot.button("💺 Pick a seat on the map").url).toBe(`https://t.me/fixture_bot/seats?startapp=s_${id}`);
    expect(bot.urls.at(-1)?.searchParams.get("locale")).toBe("en");
  });

  it("takes a new guest from Home through a poster card to the purchase confirmation", async () => {
    const bot = fixture({ title: "🎵".repeat(2200) });
    await bot.command("/start");
    expect(bot.buttons().map(button => button.text)).toEqual(["🎭 Find events", "🎟 My tickets", "💬 Messages", "⚙️ Profile"]);
    await bot.tap("🎭 Find events");
    await bot.press(bot.buttons()[0]!.callback_data!);
    expect(bot.last().method).toBe("sendPhoto");
    expect(bot.last().payload.photo).toBe("https://ticket.invalid/media/events/fixture/display");
    expect(bot.last().payload.caption).toContain("120 KZT / ticket");
    expect(bot.last().payload.caption!.length).toBeLessThan(1024);
    await bot.tap("🎟 Buy tickets");
    await bot.tap("General · 120 KZT");
    expect(bot.last().payload.text).toContain("Refunds until 6 hours before entry.");
    expect(bot.button("✅ Confirm purchase").callback_data!.length).toBeLessThanOrEqual(64);
  });

  it("restores a filtered second result page after another search starts in the same chat", async () => {
    const bot = fixture();
    await bot.command("/menu");
    await bot.tap("🎭 Find events");
    await bot.tap("📍 City");
    expect(bot.buttons().filter(button => button.text === "Almaty · KZ")).toHaveLength(1);
    await bot.tap("Almaty · KZ");
    await bot.tap("Today");
    await bot.tap("Weekend");
    await bot.tap("Free");
    await bot.tap("🏷 Category");
    await bot.tap("Music");
    await bot.tap("🔎 Search");
    expect(bot.last().payload.reply_markup?.force_reply).toBe(true);
    await bot.reply("  jazz    night ", bot.last().id);
    await bot.tap("Next ›");
    await bot.press(bot.buttons()[0]!.callback_data!);
    const back = bot.button("← Back").callback_data!;
    await bot.command("/search dance");
    expect(bot.urls.at(-1)?.searchParams.get("search")).toBe("dance");
    await bot.press(back);
    expect(Object.fromEntries(bot.urls.at(-1)!.searchParams)).toMatchObject({
      page: "2", city: "Алматы", countryCode: "KZ", datePreset: "weekend", free: "true", category: "music", search: "jazz night", locale: "en",
    });
    expect(bot.saves).toEqual([]);
    await bot.press(back, 88);
    expect(bot.last().payload.text).toContain("This menu has expired");
  });

  it("shares a public event with a second account and falls back safely when the event or photo is unavailable", async () => {
    const bot = fixture({ rejectPhoto: true });
    await bot.command(`/start e_${id}`);
    expect(bot.outputs.map(output => output.method)).toEqual(["sendPhoto", "sendMessage"]);
    const link = new URL(bot.button("📤 Share").url!);
    const payload = new URL(link.searchParams.get("url")!).searchParams.get("start");
    expect(payload).toBe(`e_${id}`);
    await bot.command(`/start ${payload}`, 88, "kk");
    expect(bot.urls.at(-1)?.searchParams.get("locale")).toBe("kk");
    expect(bot.button("📤 Бөлісу").url).toBeDefined();
    const hidden = fixture({ hidden: true });
    await hidden.command(`/start ${payload}`, 88);
    expect(hidden.last().payload.text).toBe("😔 This event is no longer available.");
    expect(hidden.button("🎭 Find events").callback_data).toBeDefined();
  });

  it("shows readable cards without a poster, paginates long details, and hides purchases for paused or sold-out events", async () => {
    const bot = fixture({ poster: null, longRules: "Rules ".repeat(950), paused: true });
    await bot.command(`/start e_${id}`);
    expect(bot.last().method).toBe("sendMessage");
    expect(bot.last().payload.text).toContain("Sales paused");
    expect(bot.buttons().some(button => button.text === "🎟 Buy tickets")).toBe(false);
    await bot.tap("ℹ️ Details");
    expect(bot.last().payload.text!.length).toBeLessThan(4096);
    await bot.tap("Next ›");
    expect(bot.button("← Back").callback_data).toBeDefined();
    const soldOut = fixture({ poster: null, soldOut: true });
    await soldOut.command(`/start e_${id}`);
    expect(soldOut.last().payload.text).toContain("Sold out");
    expect(soldOut.buttons().some(button => button.text === "🎟 Buy tickets")).toBe(false);
  });

  it("persists explicit language and city changes, and only shows the organizer and messages entries when permitted", async () => {
    const preferences = new Map<string, BotGuestSettings>();
    preferences.set("77", { linked: true, canOrganize: true, locale: null, location: null });
    const bot = fixture({ preferences });
    await bot.command("/start", 77, "ru");
    expect(bot.button("📊 Организатор").callback_data).toBe("guest:organizer");
    await bot.tap("⚙️ Профиль", 77, "ru");
    await bot.tap("🌐 Язык", 77, "ru");
    await bot.tap("Қазақша", 77, "ru");
    await bot.tap("📍 Қала", 77, "ru");
    await bot.tap("Алматы · KZ", 77, "ru");
    expect(bot.saves).toEqual([{ locale: "kk" }, { location: { city: "Алматы", countryCode: "KZ" } }]);
    const restarted = fixture({ preferences, messagesEnabled: false });
    await restarted.command("/menu", 77, "ru");
    expect(restarted.buttons().map(button => button.text)).toEqual(["🎭 Іс-шара табу", "🎟 Билеттерім", "⚙️ Профиль", "📊 Ұйымдастырушы"]);
    await restarted.tap("🎭 Іс-шара табу", 77, "ru");
    expect(Object.fromEntries(restarted.urls.at(-1)!.searchParams)).toMatchObject({ locale: "kk", city: "Алматы", countryCode: "KZ" });
    await bot.command("/chat", 77, "ru");
    await bot.tap("🔔 Хабарландырулар", 77, "ru");
    expect(bot.last().payload.text).toContain("Doors open at 18:30.");
  });
});
