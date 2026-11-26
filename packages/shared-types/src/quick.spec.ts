import { describe, expect, it } from "vitest";
import { cartRuleViolation, quickCartSchema } from "./quick.js";

const a = "11111111-1111-4111-8111-111111111111";
const b = "22222222-2222-4222-8222-222222222222";
const base = { eventId: a, seatIds: [] as string[], termsAccepted: true as const };

describe("cart rules", () => {
  it("accepts a valid cart", () => {
    expect(cartRuleViolation({ tickets: [{ ticketTypeId: a, quantity: 5 }, { ticketTypeId: b, quantity: 5 }] })).toBeNull();
    expect(cartRuleViolation({ tickets: [], tableId: a, seatIds: [] })).toBeNull();
  });
  it("rejects empty, duplicate and oversized carts", () => {
    expect(cartRuleViolation({ tickets: [], seatIds: [] })).not.toBeNull();
    expect(cartRuleViolation({ tickets: [{ ticketTypeId: a, quantity: 1 }, { ticketTypeId: a, quantity: 1 }] })).not.toBeNull();
    expect(cartRuleViolation({ tickets: [{ ticketTypeId: a, quantity: 6 }, { ticketTypeId: b, quantity: 5 }] })).not.toBeNull();
    expect(cartRuleViolation({ seatIds: [a, a] })).not.toBeNull();
    expect(cartRuleViolation({ tickets: [{ ticketTypeId: a, quantity: 0 }] })).not.toBeNull();
  });
  it("is what the Zod schema enforces", () => {
    expect(quickCartSchema.safeParse({ ...base, tickets: [] }).success).toBe(false);
    expect(quickCartSchema.safeParse({ ...base, tickets: [{ ticketTypeId: a, quantity: 2 }] }).success).toBe(true);
  });
});
