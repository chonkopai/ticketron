import assert from "node:assert/strict";
import test from "node:test";
import { isDefiniteCheckoutFailure } from "./guest-checkout-retry";

test("4xx rejections are definite", () => {
  for (const s of [400, 404, 409, 422]) assert.equal(isDefiniteCheckoutFailure(s), true);
});
test("unknown outcomes keep the idempotency key", () => {
  for (const s of [408, 429, 500, 502, 503, undefined]) assert.equal(isDefiniteCheckoutFailure(s), false);
});
