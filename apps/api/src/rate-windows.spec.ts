import type { ExecutionContext } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { SensitiveRateGuard } from "./auth/sensitive-rate.guard.js";
import { QuickRateGuard } from "./orders/quick.guards.js";

const context = (ip: string, path = "/auth/password/login") =>
  ({ switchToHttp: () => ({ getRequest: () => ({ ip, method: "POST", path }) }) }) as unknown as ExecutionContext;
const ip = (index: number) => `10.${(index >> 16) & 255}.${(index >> 8) & 255}.${index & 255}`;

describe("in-process rate guards when the key map is full", () => {
  for (const [name, create] of [["SensitiveRateGuard", () => new SensitiveRateGuard()], ["QuickRateGuard", () => new QuickRateGuard()]] as const) {
    it(`${name} admits a new client after 10,000 distinct clients instead of returning 429`, () => {
      const guard = create();
      for (let index = 0; index < 10_000; index++) guard.canActivate(context(ip(index)));
      expect(guard.canActivate(context("203.0.113.50"))).toBe(true);
      // A recent client keeps its window, so its own limit still applies.
      for (let hit = 0; hit < 29; hit++) guard.canActivate(context("203.0.113.50"));
      expect(() => guard.canActivate(context("203.0.113.50"))).toThrow();
    });
  }
});
