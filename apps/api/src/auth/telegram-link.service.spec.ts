import type { PrismaClient } from "@event-platform/database";
import { UnauthorizedException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import type { AuthConfig } from "./auth.constants.js";
import { maskAccount, TelegramLinkService } from "./telegram-link.service.js";

// Flows that touch the database are in telegram-link-consent.spec.ts.
function fixture() {
  const create = vi.fn().mockResolvedValue(undefined);
  const transaction = vi.fn();
  const database = { telegramLinkToken: { create }, $transaction: transaction } as unknown as PrismaClient;
  return { service: new TelegramLinkService(database, { telegramBotUsername: "event_platform_bot" } as AuthConfig), create, transaction };
}

describe("TelegramLinkService", () => {
  it("issues l_-prefixed tokens that expire after ten minutes", async () => {
    const { service, create } = fixture();
    const issuedAt = new Date("2026-09-02T00:00:00.000Z");
    const link = await service.issue("user-1", issuedAt, "family-1");
    expect(link.token).toMatch(/^l_[A-Za-z0-9_-]{32}$/);
    expect(link.deepLinkUrl).toBe(`https://t.me/event_platform_bot?start=${link.token}`);
    expect(link.expiresAt).toBe("2026-09-02T00:10:00.000Z");
    expect(create.mock.calls[0]?.[0].data.tokenHash).not.toContain(link.token);
  });

  it("refuses an unprefixed token before reading the database", async () => {
    const { service, transaction } = fixture();
    await expect(service.consume({ token: "A".repeat(32), telegramId: 777, chatId: 777 })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("masks only verified identifiers", () => {
    expect(maskAccount({ contactIdentities: [{ method: "email", normalizedIdentifier: "aruzhan@gmail.com" }], googleIdentity: null })).toBe("a***@g***.com");
    expect(maskAccount({ contactIdentities: [], googleIdentity: { email: "bob@mail.example.kz" } })).toBe("b***@m***.kz");
    expect(maskAccount({ contactIdentities: [{ method: "phone", normalizedIdentifier: "+77011234567" }], googleIdentity: null })).toBe("+77***67");
    expect(maskAccount({ contactIdentities: [], googleIdentity: null })).toBe("без подтверждённого email или телефона");
  });
});
