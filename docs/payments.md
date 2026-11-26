# Payments

## Current state

The only payment adapter is the mock provider, `DevelopmentPaymentProvider` in
`apps/api/src/booking/payment-provider.ts` (`PAYMENT_PROVIDER_NAME=mock`). It creates a payment
link that points back to the site's payment status page, and settles only when someone sends a
correctly signed webhook. Nobody is charged.

Guards against using it by mistake:

- In production the API starts with the mock provider only when `DEMO_MODE=true` and the site
  host is a demo or staging host (`isDemoOrigin` in `packages/config/src/index.ts`).
- The settlement command `dist/payments/dev-callback.js` refuses to run outside demo mode
  ([operations.md](operations.md#settling-mock-payments)).
- Finance reports show mock payments separately from real money.

## The provider interface

```ts
interface PaymentProvider {
  readonly name: string;
  readonly supportedCurrencies?: readonly CurrencyCapability[];
  createPaymentLink(input: PaymentLinkRequest): Promise<PaymentLinkResult>;
  verifyWebhook(input: { rawBody: Buffer; headers: Record<string, string | undefined>; now?: Date }): NormalizedPaymentWebhook;
  requestRefund?(input: { paymentId; orderId; amount; currency; idempotencyKey }): Promise<{ providerRefundId; status }>;
  lookupRefund?(idempotencyKey: string): Promise<{ providerRefundId; status }>;
}
```

Amounts are integers in the currency's minor unit. The rest of the system depends only on this
interface:

- `POST /orders/:id/pay` calls `createPaymentLink` and stores a `Payment` row. The request key
  makes retries return the same provider payment.
- `POST /payments/webhooks/:provider` passes the raw body and headers to `verifyWebhook`. The
  result is a `NormalizedPaymentWebhook` with one of `payment.succeeded`, `payment.failed` or
  `payment.expired`. The API stores each provider event ID once in `WebhookEvent`, ignores
  duplicates, and only moves a payment forward: a late `failed` or `expired` cannot undo a
  `succeeded`.
- Refunds call `requestRefund` with a stable idempotency key. `processing` and unknown outcomes
  are retried by the reconciliation worker through `lookupRefund`.

## Adding a real provider

1. Implement `PaymentProvider` for the provider:
   - `createPaymentLink`: create a hosted payment page or session for the amount and currency.
     Pass the order ID and the request key as the provider's idempotency key. Return the
     redirect URL and the provider's payment ID. Use the site's `/payment/status` page (or
     `/quick/status` for anonymous orders) as the return URL.
   - `verifyWebhook`: check the provider's signature over the raw body with a constant-time
     compare, reject stale timestamps (`PAYMENT_WEBHOOK_TOLERANCE_SECONDS`), and map the
     provider's event types to the three normalized types. Throw on anything invalid.
   - `requestRefund` and `lookupRefund`: call the provider's refund API with the idempotency key
     and map its states to `succeeded`, `processing` or `failed`.
   - `supportedCurrencies`: the currencies and exponents the provider account supports.
2. Register the adapter in the `PAYMENT_PROVIDER` factory in `apps/api/src/booking/booking.module.ts`,
   which currently accepts only `mock`. Add the provider's API key to `apiEnvSchema` in
   `packages/config/src/index.ts`. Also update `configuredPaymentCurrencies` in `payment-provider.ts`.
3. Make the webhook reachable. The API route is `/payments/webhooks/<name>`, but no public path
   forwards to it today. Add a Next.js rewrite in `apps/web/next.config.ts` (for example
   `/payments/webhooks/:path*` to the API) or a Caddy route, and register
   `https://SITE_DOMAIN/payments/webhooks/<name>` with the provider.
4. Set `PAYMENT_PROVIDER_NAME=<name>`, `PAYMENT_PROVIDER_WEBHOOK_SECRET` and `DEMO_MODE=false`.
5. Test in the provider's sandbox: success, failure, expiry, duplicate and late webhooks, a full
   refund and a partial refund. The existing specs in `apps/api/src/booking/payment-webhook-state.spec.ts`
   and `refund.service.spec.ts` show the expected state transitions.

Provider fees and disputes are not modeled yet. Finance reports mark them as unavailable.
