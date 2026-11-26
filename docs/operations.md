# Operations

Commands below assume the production stack from [deployment.md](deployment.md). Shorten them with
an alias:

```bash
alias dc='docker compose -f deploy/docker-compose.yml'
```

## Staff console

The console is at `https://ADMIN_DOMAIN/admin` and needs `STAFF_ENABLED=true`. The public host
returns 404 for `/admin` and `/staff-api`. Create the first account with the bootstrap command
([deployment.md](deployment.md#6-first-staff-account)) and invite others from Settings.
Invitations expire after 24 hours and password recovery links after 30 minutes.

| Area | Support | Moderator |
|---|---|---|
| Support inbox (customer and organizer cases, internal notes) | yes | yes |
| Orders: search, details, ticket resend | yes | yes |
| Refunds within the refund policy | yes | yes |
| Refund exceptions outside the policy | – | yes |
| Event moderation: approve, reject | yes | yes |
| Other event actions (hide, cancel and similar) | – | yes |
| Organizer verification and its documents | – | yes |
| Blocking organizers and users | – | yes |
| Finance and payout records | – | yes |
| Homepage advertisements | – | yes |
| Team management, staff audit log | – | yes |

Each staff member enrolls a TOTP app on first sign-in and receives one-time recovery codes.
Staff sessions last 8 hours. The last active Moderator cannot be disabled. If a Moderator loses
both the authenticator and the recovery codes, an operator must repair the staff record in the
database; there is no email-only bypass.

### Staff MFA lockout

Five consecutive wrong authenticator codes for one staff account (counted across all of its
sessions) lock second-factor verification for 15 minutes; verification then returns 429
`STAFF_RATE_LIMITED` without checking the code. Each failure is written to the staff audit log as
`staff.mfa_failed`. A correct code resets the counter. To clear a lock early, run:

```sql
UPDATE "StaffAccount" SET "totpFailedCount" = 0, "totpLockedUntil" = NULL WHERE id = '<staff-account-uuid>';
```

## Moderation

New events and later changes to sale data wait for a Moderator. Approval makes the event public
and sellable. Hiding or cancelling an event stops new sales; existing tickets and support access
stay. Cancelling can notify buyers. Refunds are a separate, explicit action.

Blocking an organizer stops event creation, editing, publication and new checkouts on their
events. It does not refund or delete existing orders.

## Refunds

Refunds go through the payment provider with an idempotency key and release the refunded
inventory. Full refunds work for every order type. Partial refunds select individual unused
admissions; group passes, whole tables and deposit orders need a full refund. Used admissions
cannot be refunded. A refund whose provider outcome is unknown stays `processing`, and the
reconciliation worker retries it.

## Settling mock payments

With `PAYMENT_PROVIDER_NAME=mock` and `DEMO_MODE=true`, an order stays pending until an operator
sends a signed callback:

```bash
dc exec api node dist/payments/dev-callback.js ORDER_ID payment.succeeded
```

Use `payment.failed` or `payment.expired` to test other outcomes. The command refuses to run
outside demo mode. It never moves real money.

## Health checks

- `GET /api/health` on the site (forwarded to the API) and `GET /health` inside the API and bot
  containers. Compose health checks use the internal ones.
- `deploy/health-checks.sql` reports queue depth and age for Telegram updates, notifications,
  pending orders, outbox triggers and payment review reasons. Run it read-only:

```bash
dc exec -T postgres psql -U ticketron -d ticketron < deploy/health-checks.sql
```

Investigate a queue that keeps growing or an oldest-item age that keeps rising.

The last query counts accounts whose Telegram link was made before the Telegram-side
confirmation step (September 2026) and the bot orders they claimed automatically. Such links can
still auto-claim bot orders. If the count is not zero, list the account IDs and ask each owner to
re-link Telegram (unlink, then link again from the account page):

```sql
SELECT u.id, COUNT(a.id) AS auto_claimed_orders
FROM "User" u
LEFT JOIN "AuditLog" a ON a."actorId" = u.id AND a.action = 'order.claimed'
  AND a.meta->>'automatic' = 'true' AND a.meta->>'via' = 'telegram'
WHERE u."telegramId" IS NOT NULL
  AND EXISTS (SELECT 1 FROM "TelegramLinkToken" t WHERE t."userId" = u.id AND t."usedAt" IS NOT NULL AND t."telegramConfirmedAt" IS NULL)
  AND NOT EXISTS (SELECT 1 FROM "TelegramLinkToken" t WHERE t."userId" = u.id AND t."telegramConfirmedAt" IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM "TelegramLinkToken" t WHERE t."userId" = u.id AND t."confirmedAt" IS NOT NULL
    AND t."pendingTelegramId" = u."telegramId" AND t."telegramConfirmedAt" IS NULL)
GROUP BY u.id ORDER BY auto_claimed_orders DESC;
```

### Dead-letter outbox rows

An `OutboxEvent` row with `"deadAt"` set was retried five times by its consumer and then given up
on. It is no longer selected, so whatever it should have triggered (a notification, a ticket
email request) did not happen. The error log has a line "Outbox event <id> (<eventType>) is dead".
Staff `GET /api/staff/issues` returns `queues.outboxPending`, `outboxDead` and
`ticketEmailBacklog`. The dead-letter query in `deploy/health-checks.sql` groups dead rows by
event type; to inspect one, read `"lastError"`, `attempts` and `"occurredAt"` (not the payload,
which can hold personal data). After fixing the cause, retry a row:

```sql
UPDATE "OutboxEvent" SET "deadAt" = NULL, attempts = 0 WHERE id = '<row id>' AND "processedAt" IS NULL;
```

## Logs

```bash
dc logs -f --tail=200 api
dc logs -f --tail=200 bot web caddy
```

Logs are JSON files rotated at 10 MB, three files per service (`x-log-limits` in the Compose file).
Workers log failures with the worker name, for example `Ticket email delivery`.

## Common issues

| Symptom | Cause and fix |
|---|---|
| Compose stops with `Set ... in deploy/.env` | A required variable is missing in `deploy/.env`. |
| API exits: mock provider or demo mode on a non-demo domain | `SITE_DOMAIN` is not a staging host while `PAYMENT_PROVIDER_NAME=mock`. See [deployment.md](deployment.md#2-dns). |
| API exits: staff secrets must be independent | `STAFF_GATEWAY_SECRET` or `STAFF_MFA_ENCRYPTION_KEY` equals another secret or is missing. |
| No HTTPS certificate | DNS does not point at the server yet, or ports 80/443 are closed. Check `dc logs caddy`. |
| Telegram login button says the domain is invalid | Run `/setdomain` in BotFather with `SITE_DOMAIN`. |
| Bot does not answer | Webhook not registered for this host or secret changed. Run `dc exec bot node dist/register-webhook.js`. |
| Google button missing | `NEXT_PUBLIC_GOOGLE_CLIENT_ID` was not set at build time. Rebuild web. |
| Email codes unavailable | `RESEND_API_KEY` or `RESEND_FROM_EMAIL` missing, or the sender domain is not verified. |
| Everyone was signed out | `JWT_SECRET` or `JWT_REFRESH_SECRET` changed. |
