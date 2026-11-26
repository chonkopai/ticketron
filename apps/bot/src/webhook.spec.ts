import { describe, expect, it } from "vitest";

import { parseTelegramUpdate, TELEGRAM_ALLOWED_UPDATES, verifyTelegramWebhookSecret } from "./webhook.js";

describe("Telegram webhook secret", () => {
  it("subscribes to commands, write-access messages and callbacks", () => {
    expect(TELEGRAM_ALLOWED_UPDATES).toEqual(["message", "callback_query"]);
  });

  it("rejects malformed bodies without entering the durable update inbox", () => {
    for (const body of ["null", "[]", "{", '{"update_id":-1}', '{"update_id":"1"}']) {
      expect(parseTelegramUpdate(Buffer.from(body))).toBeNull();
    }
    expect(parseTelegramUpdate(Buffer.from('{"update_id":42,"message":{}}'))).toMatchObject({ update_id: 42, message: {} });
  });

  it("accepts only an exact configured secret", () => {
    expect(verifyTelegramWebhookSecret("x".repeat(32), "x".repeat(32))).toBe(true);
    expect(verifyTelegramWebhookSecret("x".repeat(31), "x".repeat(32))).toBe(false);
    expect(verifyTelegramWebhookSecret(undefined, "x".repeat(32))).toBe(false);
    expect(verifyTelegramWebhookSecret("x".repeat(32), undefined)).toBe(false);
  });
});
