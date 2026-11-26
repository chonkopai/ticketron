import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createBot } from "./bot.js";

const ticketId = randomUUID(), groupId = randomUUID(), eventId = randomUUID(), orderId = randomUUID();
const event = { id: eventId, title: "Fixture concert", startsAt: "2035-06-01T15:30:00.000Z", timezone: "UTC", address: "Current venue", status: "published" };
const order = { id: orderId, status: "paid", amount: 0, currency: "KZT", anonymous: false, canClaim: false, cancellation: false, refund: null };
type Button = { text: string; callback_data?: string; url?: string };
type Payload = { text?: string; protect_content?: boolean; reply_markup?: { inline_keyboard?: Button[][] } };

function fixture() {
  let update = 0;
  const out: { method: string; payload: Payload }[] = [];
  const chat = (id: number) => ({ id, type: "private" as const, first_name: "Fixture" });
  const user = (id: number) => ({ id, is_bot: false, first_name: "Fixture", language_code: "en" });
  const bot = createBot("1:test", "fixture_bot", {
    apiBaseUrl: "http://fixture.invalid", botApiSecret: "fixture", webOrigin: "https://fixture.invalid",
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body));
      if (path === "/bot/guest/settings") return Response.json({ locale: "en", location: null, linked: true, canOrganize: false });
      if (body.telegramId !== "77") return Response.json({}, { status: 404 });
      if (path === "/bot/wallet/events") return Response.json({
        items: [event], hasNext: false, nextQr: { kind: "ticket", id: ticketId },
      });
      if (path === `/bot/wallet/events/${eventId}`) return Response.json({
        event, orders: [order], hasNext: false, nextQr: { kind: "group", id: groupId }, updates: ["Venue moved"],
      });
      if (path === `/bot/wallet/orders/${orderId}`) return Response.json({
        event, order: { ...order, status: "refunded", cancellation: true, refund: "succeeded" }, admissions: [], booking: null, hasNext: false,
      });
      if (path.startsWith("/bot/wallet/admission/")) return new Response("PNG");
      throw new Error(`Unexpected fixture route ${path}`);
    },
  });
  bot.api.config.use(async (_previous, method, payload) => {
    if (method !== "answerCallbackQuery") out.push({ method, payload: payload as Payload });
    return { ok: true, result: (method === "answerCallbackQuery" ? true : { message_id: 48, date: 1, chat: chat(77) }) as never };
  });
  const command = (text: string) => bot.handleUpdate({ update_id: ++update, message: {
    message_id: 47, date: 1, chat: chat(77), from: user(77), text, entities: [{ offset: 0, length: text.split(" ")[0]!.length, type: "bot_command" }],
  } });
  const press = (data: string, id = 77) => bot.handleUpdate({ update_id: ++update, callback_query: {
    id: String(update), data, from: user(id), chat_instance: "fixture", message: { message_id: 48, date: 1, chat: chat(id), text: "Fixture" },
  } });
  const last = () => out.at(-1)!;
  const buttons = () => last().payload.reply_markup?.inline_keyboard?.flat() ?? [];
  const tap = (text: string) => press(buttons().find(item => item.text === text)!.callback_data!);
  return { command, press, tap, buttons, last };
}

it("opens one protected QR in two taps from Home and rejects a copied callback", async () => {
  const bot = fixture();
  await bot.command("/start");
  await bot.tap("🎟 My tickets");
  expect(bot.buttons()[0]).toMatchObject({ text: "📱 Show next QR" });
  const callback = bot.buttons()[0]!.callback_data!;
  await bot.tap("📱 Show next QR");
  expect(bot.last()).toMatchObject({ method: "sendPhoto", payload: { protect_content: true } });
  await bot.press(callback, 88);
  expect(bot.last()).toMatchObject({ method: "sendMessage", payload: { text: expect.stringContaining("no longer available") } });
});

it("opens current event-day details and a group pass, and renders refund history without QR actions", async () => {
  const restarted = fixture();
  await restarted.command(`/start d_${eventId}`);
  expect(restarted.last().payload.text).toContain(event.address);
  expect(restarted.last().payload.text).toContain("Venue moved");
  expect(restarted.buttons()[0]).toMatchObject({ text: "📱 Show QR", callback_data: `w:q:g:${groupId}` });
  await restarted.tap("📱 Show QR");
  expect(restarted.last().method).toBe("sendPhoto");
  await restarted.press(`w:o:${orderId}:1`);
  expect(restarted.last().payload.text).toContain("Refund · Completed");
  expect(restarted.buttons().some(button => button.callback_data?.startsWith("w:q:"))).toBe(false);
});
