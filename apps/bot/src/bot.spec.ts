import type { Context } from "grammy";
import { ru, quickRu } from "@event-platform/shared-types";
import { describe, expect, it, vi } from "vitest";

import { createLinkCallbackHandler, createStartHandler } from "./handlers/start.js";
import { createBot, BOT_CLIENT_OPTIONS, parseSearchQuery } from "./bot.js";
import { formatWelcome } from "./presentation.js";

describe("/start", () => {
  it("retains Telegram API results in webhook mode for idempotent delivery", () => {
    expect(BOT_CLIENT_OPTIONS.canUseWebhookReply("sendMessage")).toBe(false);
  });
  it("verifies an anonymous recipient without invoking account linking", async () => {
    const reply = vi.fn().mockResolvedValue({ message_id: 12 });
    const request = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ pending: false }) });
    const token = "a".repeat(43);
    const context = { message: { text: `/start q_${token}` }, from: { id: 777 }, chat: { id: 777, type: "private" }, reply } as unknown as Context;
    await createStartHandler({ apiBaseUrl: "http://localhost:3001", botApiSecret: "s".repeat(32), fetch: request })(context);
    expect(request.mock.calls[0]?.[0].pathname).toBe("/quick/verify");
    expect(JSON.parse(request.mock.calls[0]?.[1].body)).toEqual({ token, telegramId: "777", chatId: "777", messageId: 12 });
    expect(reply).toHaveBeenCalledWith(quickRu.botVerified);
  });
  it("does not verify anonymous recipients from a group chat", async () => {
    const request = vi.fn(), reply = vi.fn();
    const context = { message: { text: `/start q_${"a".repeat(43)}` }, from: { id: 777 }, chat: { id: -1, type: "group" }, reply } as unknown as Context;
    await createStartHandler({ apiBaseUrl: "http://localhost:3001", botApiSecret: "s".repeat(32), fetch: request })(context);
    expect(request).not.toHaveBeenCalled();
  });
  it("opens the bot help entry point", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const context = { message: { text: "/start" }, reply } as unknown as Context;
    const handler = createStartHandler({
      apiBaseUrl: "http://localhost:3001",
      botApiSecret: "a".repeat(32),
    });

    await handler(context);

    expect(reply).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledWith(formatWelcome("guest"));
  });

  const opts = (request: unknown) => ({ apiBaseUrl: "http://localhost:3001", botApiSecret: "s".repeat(32), fetch: request as typeof fetch });
  const attemptId = "11111111-2222-4333-8444-555555555555";
  const startCtx = (text: string, reply = vi.fn().mockResolvedValue(undefined)) =>
    ({ message: { text }, from: { id: 777, first_name: "Aruzhan", last_name: "S." }, chat: { id: 777, type: "private" }, reply }) as unknown as Context;

  it("asks for consent after consuming a deep-link token", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const request = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ attemptId, account: "a***@example.com" }) });
    const token = `l_${"A".repeat(32)}`;
    await createStartHandler(opts(request))(startCtx(`/start ${token}`, reply));

    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0].pathname).toBe("/auth/telegram/link/consume");
    expect(request.mock.calls[0]?.[1]).toMatchObject({ method: "POST", headers: { "x-bot-api-secret": "s".repeat(32) } });
    expect(JSON.parse(request.mock.calls[0]?.[1].body)).toEqual({ token, telegramId: 777, chatId: 777 });
    expect(reply).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledWith(ru.bot.linkConfirmPrompt("a***@example.com"), {
      reply_markup: { inline_keyboard: [[
        { text: ru.bot.linkConfirmButton, callback_data: `tl:y:${attemptId}` },
        { text: ru.bot.linkCancelButton, callback_data: `tl:n:${attemptId}` },
      ]] },
    });
    expect(reply).not.toHaveBeenCalledWith(ru.bot.linked);
    expect(reply).not.toHaveBeenCalledWith(ru.bot.linkPending);
  });

  it("rejects an old unprefixed link token with invalidLink", async () => {
    for (const payload of ["abc_DEF-123", "A".repeat(32)]) {
      const reply = vi.fn().mockResolvedValue(undefined);
      const request = vi.fn();
      await createStartHandler(opts(request))(startCtx(`/start ${payload}`, reply));
      expect(request).not.toHaveBeenCalled();
      expect(reply).toHaveBeenCalledWith(ru.bot.invalidLink);
    }
  });

  it("replies invalidLink when consume is rejected", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const request = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    await createStartHandler(opts(request))(startCtx(`/start l_${"A".repeat(32)}`, reply));
    expect(reply).toHaveBeenCalledWith(ru.bot.invalidLink);
  });
});

describe("link consent callback", () => {
  const opts = (request: unknown) => ({ apiBaseUrl: "http://localhost:3001", botApiSecret: "s".repeat(32), fetch: request as typeof fetch });
  const attemptId = "11111111-2222-4333-8444-555555555555";
  const cbCtx = (chat: { id: number; type: string } = { id: 777, type: "private" }) => ({
    from: { id: 777, first_name: "Aruzhan", last_name: "S." },
    callbackQuery: { message: { chat } },
    editMessageText: vi.fn().mockResolvedValue(true),
    reply: vi.fn(),
  });

  it("confirms the link and edits the prompt", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ state: "pending" }) });
    const ctx = cbCtx();
    expect(await createLinkCallbackHandler(opts(request))(ctx as unknown as Context, `tl:y:${attemptId}`)).toBe(true);
    expect(request.mock.calls[0]?.[0].pathname).toBe("/auth/telegram/link/answer");
    expect(request.mock.calls[0]?.[1].headers["x-bot-api-secret"]).toBe("s".repeat(32));
    expect(JSON.parse(request.mock.calls[0]?.[1].body)).toEqual({ attemptId, telegramId: 777, chatId: 777, decision: "confirm", firstName: "Aruzhan", lastName: "S." });
    expect(ctx.editMessageText).toHaveBeenCalledWith(ru.bot.linkPending);
  });

  it("cancels the link", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ state: "cancelled" }) });
    const ctx = cbCtx();
    await createLinkCallbackHandler(opts(request))(ctx as unknown as Context, `tl:n:${attemptId}`);
    expect(JSON.parse(request.mock.calls[0]?.[1].body).decision).toBe("cancel");
    expect(ctx.editMessageText).toHaveBeenCalledWith(ru.bot.linkCancelled);
  });

  it("falls back to invalidLink on API or network failure", async () => {
    for (const request of [vi.fn().mockResolvedValue({ ok: false }), vi.fn().mockRejectedValue(new Error("down"))]) {
      const ctx = cbCtx();
      await createLinkCallbackHandler(opts(request))(ctx as unknown as Context, `tl:y:${attemptId}`);
      expect(ctx.editMessageText).toHaveBeenCalledWith(ru.bot.invalidLink);
    }
  });

  it("refuses answers from non-private or mismatched chats", async () => {
    for (const chat of [{ id: -5, type: "group" }, { id: 888, type: "private" }]) {
      const request = vi.fn();
      const ctx = cbCtx(chat);
      expect(await createLinkCallbackHandler(opts(request))(ctx as unknown as Context, `tl:y:${attemptId}`)).toBe(true);
      expect(request).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(ru.bot.unableToIdentify);
    }
  });

  it("ignores non-matching callback data", async () => {
    const request = vi.fn();
    const handler = createLinkCallbackHandler(opts(request));
    expect(await handler(cbCtx() as unknown as Context, "events:1")).toBe(false);
    expect(await handler(cbCtx() as unknown as Context, "tl:y:not-a-uuid")).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it("is wired into createBot callback routing without reaching Telegram", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ state: "cancelled" }) });
    const bot = createBot("1:test", "test_bot", opts(request));
    bot.api.config.use(async () => ({ ok: true, result: true }) as never);
    await bot.handleUpdate({
      update_id: 2,
      callback_query: {
        id: "cb1", from: { id: 77, is_bot: false, first_name: "Fixture" }, chat_instance: "x", data: `tl:n:${attemptId}`,
        message: { message_id: 5, date: 1, chat: { id: 77, type: "private", first_name: "Fixture" } },
      },
    } as never);
    expect(request).toHaveBeenCalledOnce();
    expect(String(request.mock.calls[0]?.[0])).toBe("http://localhost:3001/auth/telegram/link/answer");
    expect(JSON.parse(request.mock.calls[0]?.[1].body).decision).toBe("cancel");
  });
});

describe("/search", () => {
  it("accepts a query with an optional bot username and normalizes whitespace", () => {
    expect(parseSearchQuery("/search@event_platform   джаз   Алматы")).toBe("джаз Алматы");
    expect(parseSearchQuery("/search")).toBe("");
    expect(parseSearchQuery("/events джаз")).toBe("");
  });
});

it("connects a legacy widget messaging grant without requiring /start", async () => {
  const request = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ linked: true }) });
  const bot = createBot("1:test", "test_bot", { apiBaseUrl: "http://localhost:3001", botApiSecret: "s".repeat(32), fetch: request });
  await bot.handleUpdate({ update_id: 1, message: { message_id: 1, date: 1, chat: { id: 77, type: "private", first_name: "Fixture" }, from: { id: 77, is_bot: false, first_name: "Fixture" }, write_access_allowed: { from_request: true } } });
  expect(request).toHaveBeenCalledOnce();
  expect(String(request.mock.calls[0]![0])).toBe("http://localhost:3001/bot/write-access");
  expect(JSON.parse(request.mock.calls[0]![1].body)).toEqual({ telegramId: "77", chatId: "77" });
});
