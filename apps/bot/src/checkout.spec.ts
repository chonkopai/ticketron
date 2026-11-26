import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createBot } from "./bot.js";

const first = { id: 77, is_bot: false, first_name: "Fixture", language_code: "en" };
const chat = { id: 77, type: "private" as const, first_name: "Fixture" };
const itemId = randomUUID(), eventId = randomUUID(), reference = randomUUID(), orderId = randomUUID(), otherOrderId = randomUUID();
const offer = {
  eventId, itemId, kind: "ticket", title: "Fixture", itemName: "General", amountDue: 12500, currency: "KZT", locale: "en",
  policyRevision: 2, refundTerms: "Refundable until 24 hours before the event.", refundsAvailable: true,
  reference, expiresAt: "2030-02-01T00:00:00Z", timezone: "UTC",
};
const pending = { orderId, title: "Fixture", status: "pending", amountDue: 12500, currency: "KZT", expiresAt: "2030-02-01T00:00:00Z", timezone: "UTC", paymentLink: "https://fixture.invalid/pay" };

function fixture() {
  const request = vi.fn<typeof fetch>(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/bot/guest/settings") return Response.json({ locale: null, location: null, linked: false, canOrganize: false });
    if (path.endsWith("/offers")) return Response.json(offer);
    if (path.endsWith("/confirm")) return Response.json({ order: pending });
    if (path.endsWith("/orders")) return Response.json({ items: [pending, { ...pending, orderId: otherOrderId }], hasNext: false });
    return Response.json({ ...pending, status: "paid", paymentLink: null });
  });
  const messages: Array<{ method: string; payload: unknown }> = [];
  const bot = createBot("1:test", "fixture_bot", { apiBaseUrl: "http://fixture.invalid", botApiSecret: "fixture", fetch: request });
  bot.api.config.use(async (_previous, method, payload) => {
    messages.push({ method, payload });
    const result = method === "answerCallbackQuery" ? true : { message_id: 42, date: 1, chat, ...payload };
    return { ok: true, result: result as never };
  });
  const press = (data: string, update_id: number) => bot.handleUpdate({ update_id, callback_query: {
    id: String(update_id), data, from: first, chat_instance: "test", message: { message_id: 42, date: 1, chat },
  } });
  const command = (text: string, update_id: number) => bot.handleUpdate({ update_id, message: {
    message_id: 43, date: 1, chat, from: first, text, entities: [{ offset: 0, length: text.split(" ")[0]!.length, type: "bot_command" }],
  } });
  return { request, messages, press, command };
}

describe("Telegram checkout in chat", () => {
  it("displays the server offer and confirms the same opaque reference from a fresh bot instance", async () => {
    const buyer = fixture();
    await buyer.press(`buy:ticket:${itemId}`, 1);
    expect(buyer.messages[0]?.method).toBe("answerCallbackQuery");
    expect(buyer.messages.at(-1)?.payload).toMatchObject({
      text: expect.stringContaining(offer.refundTerms),
      reply_markup: { inline_keyboard: [[{ text: "✅ Confirm purchase", callback_data: `confirm:${reference}` }], expect.any(Array)] },
    });
    const restarted = fixture();
    await restarted.press(`confirm:${reference}`, 2);
    const confirmed = restarted.request.mock.calls.find(([url]) => String(url).endsWith(`/offers/${reference}/confirm`));
    expect(confirmed).toBeDefined();
    expect(JSON.parse(String(confirmed?.[1]?.body))).toEqual({ telegramId: "77", chatId: "77", messageId: 42 });
    expect(restarted.messages.at(-1)?.payload).toMatchObject({
      text: expect.stringContaining("Awaiting payment"),
      reply_markup: { inline_keyboard: [[{ url: pending.paymentLink }], [{ callback_data: `check:${orderId}` }], expect.any(Array)] },
    });
  });

  it("lists multiple pending orders after restart and opens only the chosen order or return link", async () => {
    const restarted = fixture();
    await restarted.command("/check_payment", 1);
    expect(restarted.messages.at(-1)?.payload).toMatchObject({ reply_markup: { inline_keyboard: [
      [{ callback_data: `check:${orderId}` }], [{ callback_data: `check:${otherOrderId}` }], expect.any(Array),
    ] } });
    await restarted.press(`check:${otherOrderId}`, 2);
    expect(String(restarted.request.mock.lastCall?.[0])).toContain(`/orders/${otherOrderId}`);
    expect(restarted.messages.at(-1)?.payload).toMatchObject({ text: expect.stringContaining("Confirmed") });
    await restarted.command(`/start p_${orderId}`, 3);
    expect(String(restarted.request.mock.lastCall?.[0])).toContain(`/orders/${orderId}`);
  });
});
