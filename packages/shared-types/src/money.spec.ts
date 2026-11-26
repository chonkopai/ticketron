import { describe, expect, it } from "vitest";
import { currencyExponent, formatMoney, minorToMajor } from "./money.js";

describe("money formatting", () => {
  it("uses the currency's minor-unit exponent", () => {
    expect(currencyExponent("KZT")).toBe(2);
    expect(currencyExponent("USD")).toBe(2);
    expect(currencyExponent("JPY")).toBe(0);
    expect(minorToMajor(150050, "KZT")).toBe(1500.5);
    expect(minorToMajor(1500, "JPY")).toBe(1500);
  });
  it("matches the previous amount / 100 output for two-digit currencies", () => {
    for (const [locale, currency] of [["ru-RU", "KZT"], ["en-GB", "USD"], ["kk-KZ", "RUB"], ["en-US", "EUR"]] as const) {
      const legacy = new Intl.NumberFormat(locale, { style: "currency", currency }).format(123456 / 100);
      expect(formatMoney(123456, currency, locale)).toBe(legacy);
    }
  });
  it("passes extra Intl options through", () => {
    expect(formatMoney(150000, "USD", "en-US", { currencyDisplay: "code" })).toMatch(/^USD\s1,500\.00$/);
    expect(formatMoney(150000000, "USD", "en-US", { notation: "compact", maximumFractionDigits: 1 })).toBe("$1.5M");
  });
  it("falls back to two digits for an unknown currency code", () => {
    expect(currencyExponent("not-a-code")).toBe(2);
  });
});
