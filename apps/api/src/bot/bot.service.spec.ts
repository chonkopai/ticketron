import { describe, expect, it, vi } from "vitest";

import { BotService } from "./bot.service.js";

function service(database: Record<string, unknown>) {
  return new BotService(database as never);
}

describe("BotService", () => {
  it("returns the user without minting a token for the linked Telegram chat", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "user-1", role: "guest" });
    const result = await service({ user: { findFirst } }).identity({ telegramId: "77", chatId: "77" });
    expect(result).toEqual({ user: { id: "user-1", role: "guest" } });
    expect(findFirst).toHaveBeenCalledWith({ where: { telegramId: 77n, telegramChatId: 77n } });
  });
});

it("links messaging permission received before the website login callback", async () => {
  const upsert = vi.fn();
  await expect(service({ user: { upsert } }).grantWriteAccess({ telegramId: "77", chatId: "77" })).resolves.toEqual({ linked: true });
  expect(upsert).toHaveBeenCalledWith({ where: { telegramId: 77n }, create: { telegramId: 77n, telegramChatId: 77n, role: "guest" }, update: { telegramChatId: 77n } });
});
it("rejects messaging permission for a different or group chat", async () => {
  const upsert = vi.fn();
  for (const chatId of ["78", "-77"]) await expect(service({ user: { upsert } }).grantWriteAccess({ telegramId: "77", chatId })).rejects.toBeTruthy();
  expect(upsert).not.toHaveBeenCalled();
});
