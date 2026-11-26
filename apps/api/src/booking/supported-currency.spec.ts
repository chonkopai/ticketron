import { describe, expect, it } from "vitest";

import { supportedCurrency } from "./supported-currency.js";

const currencies = [{ code: "KZT", exponent: 2 }, { code: "USD", exponent: 2 }];

describe("supportedCurrency", () => {
  it("normalizes a configured currency and defaults to KZT", () => {
    expect(supportedCurrency(" usd ", currencies)).toBe("USD");
    expect(supportedCurrency(undefined, currencies)).toBe("KZT");
  });
  it("rejects malformed and unconfigured codes", () => {
    expect(() => supportedCurrency("US", currencies)).toThrow(expect.objectContaining({ response: expect.objectContaining({ code: "CURRENCY_INVALID" }) }));
    expect(() => supportedCurrency("XYZ", currencies)).toThrow(expect.objectContaining({ response: expect.objectContaining({ code: "CURRENCY_UNSUPPORTED" }) }));
    expect(() => supportedCurrency("KZT", [])).toThrow();
  });
});
