import assert from "node:assert/strict";
import { test } from "node:test";
import { externalPaymentLink } from "./payment-link";

test("a payment link that points back at the current status page is hidden", () => {
  const here = "https://ticket.example/payment/status?order=abc";
  assert.equal(externalPaymentLink("https://ticket.example/payment/status?order=abc&mock=1", here), null);
  assert.equal(externalPaymentLink("/payment/status?order=abc", here), null);
  assert.equal(externalPaymentLink("", here), null);
  assert.equal(externalPaymentLink(null, here), null);
});

test("provider checkout pages are kept", () => {
  const here = "https://ticket.example/payment/status?order=abc";
  assert.equal(externalPaymentLink("https://pay.provider.example/checkout/1", here), "https://pay.provider.example/checkout/1");
  assert.equal(externalPaymentLink("/quick/status?order=abc", here), "https://ticket.example/quick/status?order=abc");
});
