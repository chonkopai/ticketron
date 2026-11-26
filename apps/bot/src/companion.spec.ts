import { randomUUID } from "node:crypto";
import type { BotConversationSummary, BotOrganizerSnapshot } from "@event-platform/shared-types";
import { expect, it, vi } from "vitest";
import { createBot } from "./bot.js";
import { threadData } from "./companion-reference.js";

type Button = { text: string; callback_data?: string; url?: string };
type Output = { text?: string; reply_markup?: { force_reply?: boolean; inline_keyboard?: Button[][] }; protect_content?: boolean };
const event = randomUUID(), inquiry = randomUUID(), ticket = randomUUID(), order = randomUUID(), delivery = randomUUID(), organizer = 45, guest = 46, other = 47;
const title = "Evening fixture";

function fixture() {
  let saved = false, closed = false;
  const sends: Record<string, unknown>[] = [];
  const confirmations: Record<string, unknown>[] = [];
  const responses = vi.fn<typeof fetch>(async (target, options) => {
    const path = new URL(String(target)).pathname;
    const body = JSON.parse(String(options?.body ?? "{}")) as Record<string, unknown>;
    if (path === "/bot/guest/settings") return Response.json({ locale: "en", canOrganize: body.telegramId === String(organizer), linked: body.telegramId === String(organizer), location: null });
    const role = body.side === "organizer" ? "organizer" : "guest";
    const ref = { id: inquiry, title, kind: "inquiry", side: role, eventId: event, closed, unread: 1 } satisfies BotConversationSummary;
    const allowed = body.telegramId === String(role === "organizer" ? organizer : guest);
    if (path === "/bot/companion/inbox") return Response.json({ items: allowed && saved ? [ref] : [], hasNext: false });
    if (path === `/bot/companion/inquiry/${event}`) return Response.json({ threadId: saved ? inquiry : null });
    if (path === `/bot/companion/thread/${inquiry}`) {
      return allowed ? Response.json({ thread: ref, nextCursor: null, items: [{ sender: "guest", text: "Is the event accessible?", createdAt: "2035-01-01T05:00:00Z", files: [] }] }) : Response.json({ code: "CONVERSATION_NOT_FOUND" }, { status: 404 });
    }
    if (/\/thread\/[^/]+\/send$/.test(path)) {
      sends.push(body);
      saved = true;
      return Response.json({ id: inquiry, kind: "inquiry" });
    }
    if (path === `/bot/companion/inquiry/${inquiry}/close`) {
      closed = true;
      return Response.json({ closed });
    }
    if (path === "/bot/companion/events") return Response.json({ items: body.telegramId === String(other) ? [] : [{ id: event, title, date: "2035-01-01", time: "20:00", timezone: "UTC", status: "published", published: true }], hasNext: false });
    if (path === `/bot/companion/events/${event}`) return Response.json({
      event: { id: event, title, date: "2035-01-01", time: "20:00", timezone: "UTC", status: "published" },
      inventory: { soldAdmissions: 4, buyableAdmissions: 2, wholeTables: { configured: 1 }, saleGroups: [{ name: "Fixture Table", unit: "tables", sold: 1, buyable: 0, price: 30000, currency: "KZT" }] },
      orders: { paid: 1, completedRefunds: 1 }, attendance: { checkedInTickets: 0, checkedInGroupPasses: 0, individualAttendanceKnown: true },
      buyers: { registered: 1, anonymousOrders: 0, unknown: false },
      money: { grossReceived: [{ amount: 30000, currency: "KZT" }, { amount: 4000, currency: "USD" }], completedRefunds: [{ amount: 4000, currency: "USD" }] }, publicCard: true,
    } as BotOrganizerSnapshot);
    if (path === `/bot/companion/updates/${event}/draft`) {
      return Response.json({ id: inquiry, eventId: event, type: body.type, text: `${title}\n\n${body.text}`, audienceCount: 3, reachableCount: 2, review: "a".repeat(20) });
    }
    if (path === `/bot/companion/updates/${inquiry}/confirm`) {
      if (body.review === "a".repeat(20)) return Response.json({ preview: { id: inquiry, eventId: event, type: "venue", text: `${title}\n\nUse the side door`, audienceCount: 3, reachableCount: 3, review: "b".repeat(20) } });
      return Response.json({ eventId: event, delivery: { audienceCount: 3, reachableCount: 3, inboxReadCount: 0, counts: { queued: 3, processing: 0, accepted: 0, failed: 0, uncertain: 0 } } });
    }
    if (path === `/bot/companion/events/${event}/lookup`) return Response.json({ items: [{ id: order, buyerName: "Amina", payment: { status: "paid", amount: 30000, currency: "KZT" } }], hasNext: false });
    if (path === `/bot/companion/events/${event}/orders/${order}`) return Response.json({
      id: order, eventId: event, buyerName: "Amina", payment: { status: "paid", amount: 30000, currency: "KZT" }, resources: {ticketCount: 2, allocatedSeatCount: 2, wholeTableCount: 1},
      attendance: { checkedInTickets: 0, totalTickets: 2 }, tickets: [{ id: ticket, typeName: "Fixture ticket", status: "active", canResend: true }], hasNext: false,
    });
    if (path === `/bot/companion/tickets/${ticket}/resend`) {
      if (body.requestKey) confirmations.push(body);
      return Response.json({ eventId: event, orderId: order, label: "Fixture ticket", status: body.requestKey ? { id: delivery, status: "queued", counts: { queued: 1, processing: 0, accepted: 0, failed: 0, uncertain: 0 } } : null });
    }
    return Response.json({ code: "NOT_FOUND" }, { status: 404 });
  });
  let updateId = 0, seq = 100;
  const outputs: Output[] = [];
  const chat = (who: number) => ({ id: who, type: "private" as const, first_name: "Fixture" });
  const user = (who: number) => ({ id: who, is_bot: who === 1, first_name: "Fixture", language_code: "en" });
  const instance = () => {
    const bot = createBot("1:fixture", "fixture_bot", { apiBaseUrl: "http://fixture.test", botApiSecret: "companion-secret", webOrigin: "https://website.test", fetch: responses });
    bot.api.config.use(async (_next, method, payload) => {
      if (method !== "answerCallbackQuery") outputs.push(payload as Output);
      return { ok: true, result: (method === "answerCallbackQuery" ? true : { message_id: ++seq, date: 1, chat: chat(guest), ...payload }) as never };
    });
    return bot;
  };
  let bot = instance();
  const press = (data: string, who: number) => bot.handleUpdate({ update_id: ++updateId, callback_query: {
    id: String(updateId), data, from: user(who), chat_instance: "fixture",
    message: { message_id: seq, date: 1, chat: chat(who), from: user(1), text: "Fixture panel", has_protected_content: true },
  } });
  const send = (text: string, who: number, origin?: string, messageId = ++seq) => bot.handleUpdate({ update_id: ++updateId, message: {
    message_id: messageId, date: 1, chat: chat(who), from: user(who), text,
    ...(text.startsWith("/") ? { entities: [{ type: "bot_command" as const, offset: 0, length: text.split(" ")[0]!.length }] } : {}),
    ...(origin ? { reply_to_message: { message_id: seq, date: 1, chat: chat(who), from: user(1), text: origin } as never } : {}),
  } });
  const last = () => outputs.at(-1)!;
  const buttons = () => last().reply_markup?.inline_keyboard?.flat() ?? [];
  const tap = (text: string, who: number) => {
    const button = buttons().find(row => row.text.includes(text));
    if (!button?.callback_data) throw new Error("Missing fixture button " + text);
    expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
    return press(button.callback_data, who);
  };
  return { press, send, sends, tap, last, buttons, confirmations, restart: () => { bot = instance(); } };
}

it("binds a reply to the customer and thread, survives bot restart, and rejects a forwarded link", async () => {
  const app = fixture();
  await app.press(`c:n:${event}`, guest);
  expect(app.last().reply_markup?.force_reply).toBe(true);
  const prompt = app.last().text!;
  await app.send("Forwarded compose prompt", other, prompt);
  expect(app.sends).toHaveLength(0);
  expect(app.last().text).toContain("expired");
  app.restart();
  await app.send("Is the event accessible?", guest, prompt, 901);
  await app.send("Is the event accessible?", guest, prompt, 901);
  expect(app.sends).toHaveLength(2);
  expect(app.sends[0]?.requestKey).toBe(app.sends[1]?.requestKey);
  expect(app.last().text).toBe("✅ Message sent.");
  await app.send(`/start c_g_i_${inquiry}`, other);
  expect(app.last().text).toContain("unavailable");
  await app.press("c:l:a:1", organizer);
  await app.tap("1 new", organizer);
  await app.tap("Reply", organizer);
  await app.send("Please use the west entrance", organizer, app.last().text!);
  expect(app.sends.at(-1)?.side).toBe("organizer");
  await app.press(threadData({ kind: "inquiry", side: "organizer", id: inquiry }), organizer);
  await app.tap("Close question", organizer);
  await app.tap("Confirm", organizer);
  expect(app.last().text).toContain("Question closed");
  await app.send(`/start c_g_i_${inquiry}`, guest);
  expect(app.buttons().some(button => button.text === "🎟 My tickets")).toBe(true);
  expect(app.buttons().some(button => button.text === "Reply")).toBe(false);
  await app.send("Unbound text", guest);
  expect(app.buttons().some(button => button.text === "🎭 Find events")).toBe(true);
});

it("navigates the owner dashboard and binds a resend confirmation to the organizer", async () => {
  const app = fixture();
  await app.press("guest:organizer", organizer);
  expect(app.buttons().map(button => button.text)).toEqual(["📅 My events", "💬 Inbox", "📣 Updates", "← Guest mode"]);
  await app.tap("My events", organizer);
  await app.tap(title, organizer);
  expect(app.last().text).toContain("Sold 4 admissions");
  expect(app.last().text).toContain("300 KZT · 40 USD");
  await app.tap("Tickets & tables", organizer);
  expect(app.last().text).toContain("Fixture Table · tables");
  await app.tap("Back", organizer);
  await app.tap("Find an order", organizer);
  await app.send("Amina", organizer, app.last().text!);
  await app.tap("Amina", organizer);
  await app.tap("Resend", organizer);
  const confirm = app.buttons().find(button => button.text === "✅ Confirm")!.callback_data!;
  await app.press(confirm, other);
  expect(app.confirmations).toHaveLength(0);
  await app.press(confirm, organizer);
  await app.press(confirm, organizer);
  expect(app.confirmations[0]?.requestKey).toBe(app.confirmations[1]?.requestKey);
  expect(app.last().text).toContain("Ticket delivery · Queued");
  await app.send("/today", other);
  expect(app.last().text).toContain("No owned events");
  expect(app.buttons().some(button => button.callback_data === "guest:home")).toBe(true);
});

it("starts an operational update from /notify and requires confirmation again when the audience changes", async () => {
  const app = fixture();
  await app.send("/notify", organizer);
  await app.tap(title, organizer);
  await app.tap("Venue", organizer);
  const prompt = app.last().text!;
  await app.send("Use the side door", organizer, prompt);
  expect(app.last().text).toContain("Telegram reachable 2");
  expect(app.last().text).toContain("Use the side door");
  await app.tap("Send update", organizer);
  expect(app.last().text).toContain("Review it again");
  expect(app.last().text).toContain("Telegram reachable 3");
  await app.tap("Send update", organizer);
  expect(app.last().text).toContain("3 · 0 · 0 · 0 · 0");
  expect(app.last().text).toContain("Inbox · read 0");
});
