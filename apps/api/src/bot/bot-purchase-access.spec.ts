import { describe, expect, it } from "vitest";
import { parsePrivateChatActor, parseTelegramUserId } from "./bot-purchase-access.js";

describe("telegram actor parsing", () => {
  it("accepts positive int64 user ids, including 16 and 19 digit values", () => {
    expect(parseTelegramUserId("1")).toBe(1n);
    expect(parseTelegramUserId("123456789")).toBe(123456789n);
    expect(parseTelegramUserId("4503599627370495")).toBe(4503599627370495n);
    expect(parseTelegramUserId("9223372036854775807")).toBe(9223372036854775807n);
  });
  it("rejects zero, negatives, leading zeros, non-digits, too long and above int64", () => {
    for (const v of ["0", "-1", "-100123", "012", "", "12a", "1.5", " 1", "+1", "12345678901234567890", "9223372036854775808"]) {
      expect(parseTelegramUserId(v), v).toBeNull();
    }
  });
  it("requires telegram id and chat id to be the same valid id", () => {
    expect(parsePrivateChatActor("42", "42")).toBe(42n);
    expect(parsePrivateChatActor("42", "43")).toBeNull();
    expect(parsePrivateChatActor("-5", "-5")).toBeNull();
  });
});
