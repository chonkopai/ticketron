import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { CheckoutService } from "./checkout.service.js";

const a = "11111111-1111-4111-8111-111111111111";
const b = "22222222-2222-4222-8222-222222222222";
const service = new CheckoutService(...(Array(8).fill(undefined) as ConstructorParameters<typeof CheckoutService>));
const cart = (over: Record<string, unknown>) => ({ eventId: a, tickets: [], seatIds: [], termsAccepted: true as const, ...over }) as never;

describe("authenticated cart rules", () => {
  it.each([
    ["empty cart", {}],
    ["duplicate ticket types", { tickets: [{ ticketTypeId: a, quantity: 1 }, { ticketTypeId: a, quantity: 1 }] }],
    ["total quantity over 10", { tickets: [{ ticketTypeId: a, quantity: 6 }, { ticketTypeId: b, quantity: 5 }] }],
  ])("rejects %s", async (_name, over) => {
    await expect(service.checkoutCart(a, "k".repeat(16), cart(over))).rejects.toMatchObject({ response: { code: "CART_SELECTION_INVALID" } });
    await expect(service.checkoutCart(a, "k".repeat(16), cart(over))).rejects.toBeInstanceOf(BadRequestException);
  });
});
