# Architecture

## Services

| Service | Code | Responsibility |
|---|---|---|
| API | `apps/api` (NestJS) | All business rules, database access, payments, email, file storage, background workers |
| Web | `apps/web` (Next.js) | Public site, account, organizer workspace, staff console, server rendering of public pages |
| Bot | `apps/bot` (grammY + Express) | Telegram webhook, bot menus and conversations; calls the API for everything |
| PostgreSQL | `packages/database` (Prisma) | Single database for all services |

The web app does not talk to the database. Browser requests go to the site origin, and Next.js
rewrites (`apps/web/next.config.ts`) forward `/api/*`, `/auth/*`, `/me/*`, `/orders/*`, `/media/*`
and similar paths to the API. `/telegram/webhook` is forwarded to the bot. The staff console calls
`/staff-api/*`, a Next.js route handler that forwards only the staff cookie and CSRF header and
adds the `STAFF_GATEWAY_SECRET`.

The bot calls `/bot/*` API routes with the `x-bot-api-secret` header (`BOT_API_SECRET`). Those
routes are not exposed publicly.

The Telegram seat-picker Mini App is a static bundle built by `apps/web/scripts/build-telegram-seats.mjs`
and served by the API at `/telegram/seats`. Caddy routes that path straight to the API.

## API modules

`apps/api/src` is organized by domain:

| Module | Purpose |
|---|---|
| `auth` | Accounts, sessions (JWT access + rotating refresh tokens), Telegram, Google and email sign-in, account linking |
| `public-events` | Catalog, search and public event pages |
| `creation-drafts` | Event wizard drafts, media upload and processing, translations, submission for moderation |
| `events` | Organizer event management, analytics, notifications, buyer chat, marketing campaigns |
| `ticket-types`, `tables`, `seats`, `venue` | Inventory: ticket types, tables and holds, numbered seats, hall layouts |
| `booking` | Checkout, settlement, cancellation, refunds, order release, payment provider interface |
| `payments` | Payment links, payment status, webhook endpoint `/payments/webhooks/:provider` |
| `orders` | Anonymous (quick) checkout, ticket email delivery, Telegram ticket delivery |
| `tickets`, `wallet` | QR tickets, check-in scans, Apple Wallet passes |
| `my-events`, `favorites` | Guest account pages |
| `bot` | API surface for the Telegram bot |
| `staff` | Staff console: moderation, verification, support, orders, refunds, finance, team, advertisements |
| `domain-events` | Transactional outbox |
| `workers` | Interval worker and PostgreSQL advisory-lock helpers |

## Data model

The Prisma schema is in `packages/database/prisma/schema.prisma`. Main groups:

- **Identity:** `User` (role `guest`, `organizer` or `admin`), `ContactIdentity` (verified email and
  phone), `GoogleIdentity`, `RefreshToken`, `TelegramLinkToken`, `TelegramLoginAttempt`,
  `OrganizerProfile`, `OrganizerVerification`.
- **Events:** `Event` (status `draft`, `published`, `cancelled`, `completed`, plus a moderation
  status), `EventContent` and other `*Content` tables for localized text, `EventCreationDraft`,
  `EventMedia`, `MediaAsset`.
- **Inventory:** `TicketType`, `VenueLayout`, `VenueRow`, `Seat`, `Table`, `TableHold`, `HallTariff`.
- **Sales:** `Order`, `Booking`, `Ticket`, `SeatAllocation`, `GroupPass`, `Payment`,
  `RefundRequest`, `WebhookEvent`, `AnonymousCheckoutSession`, `IdempotencyRecord`.
- **Messaging:** `OutboxEvent`, `Notification`, `TicketEmailDelivery`, `ChatMessage`,
  `EventInquiry`, `Broadcast`, `TelegramUpdate`.
- **Staff:** `StaffAccount`, `StaffSession`, `StaffAudit` (append-only, enforced by a trigger),
  `PlatformCase`, `PlatformMessage`, `PrivateUpload`, `StaffRefund`, `OrganizerPayout`,
  `HomepageAdvertisement`.

Inventory limits are enforced in the database: checkout takes row locks on ticket types, seats
and tables in a fixed order, and constraints reject overselling.

Migrations in `packages/database/prisma/migrations` are forward-only and applied with
`prisma migrate deploy`.

## Main flows

**Checkout to ticket.**

1. The guest selects tickets, seats or a table. `POST` to the booking or quick-checkout API
   creates an `Order` in `pending` state and reserves inventory for `CHECKOUT_TTL_SECONDS`.
2. The API asks the payment provider for a payment link (`booking/payment-provider.ts`).
3. The provider calls `POST /payments/webhooks/:provider`. The API verifies the signature,
   stores the `WebhookEvent` once and moves the `Payment` forward only (a late failure cannot
   downgrade a paid payment).
4. Settlement marks the order paid, issues `Ticket` rows with QR tokens and writes outbox events.
5. Workers deliver the tickets by email and Telegram. Unpaid orders expire and release inventory.

**Check-in.** Organizers scan QR codes; the tickets service marks the admission used once.

**Event creation and moderation.** Organizers build an event in the wizard (`creation-drafts`).
Submitting creates a pending moderation item. A Moderator approves, rejects or requests changes
in the staff console. Only approved events are listed publicly and can sell. Later edits to sale
data go through moderation again.

**Refunds.** Organizer, buyer or staff refunds create a `RefundRequest`, call the provider's
refund method with an idempotency key and release inventory when it succeeds. A reconciliation
worker retries refunds whose outcome is unknown.

## Background workers

All run inside the API process (`startIntervalWorker`). Workers that must not run twice use a
PostgreSQL advisory lock, so a second API instance skips the tick.

| Worker | Code |
|---|---|
| Checkout cleanup, refund reconciliation, anonymous session cleanup, outbox maintenance | `booking/checkout-cleanup.service.ts` |
| Table hold cleanup | `tables/table-hold-cleanup.service.ts` |
| Event notifications and transactional notification scan | `events/event-notifications.service.ts`, `events/transactional-notifications.service.ts` |
| Ticket email delivery | `orders/ticket-email-delivery.service.ts` |
| Telegram ticket delivery | `orders/quick-delivery.service.ts` |
| Draft and draft-media cleanup | `creation-drafts/creation-drafts.service.ts`, `creation-drafts/draft-media.service.ts` |
| Verification code cleanup | `auth/verification.service.ts` |
| Staff refund reconciliation, moderation review archiver | `staff/staff-refunds.service.ts`, `staff/staff-management.service.ts` |

## Security model

- **Public sessions.** Short-lived JWT access tokens and rotating refresh tokens. Each refresh
  token belongs to a family; reuse of a rotated token revokes the family. A family cannot be
  refreshed beyond `REFRESH_FAMILY_MAX_AGE_DAYS`. "Sign out everywhere" bumps the user's
  credential version.
- **Sign-in.** Telegram data is verified with the bot token (widget) or OIDC (RS256, PKCE,
  browser-bound attempts). Google ID tokens are verified for audience, issuer and nonce. Email
  codes are HMAC-protected and rate-limited. Linking a Telegram account requires confirmation
  inside Telegram.
- **Staff.** A separate account table and host. Staff sessions use a host-only, `Secure`,
  `HttpOnly`, `SameSite=Strict` cookie, a CSRF token on mutations, an origin check, TOTP with
  recovery codes, and roles `support` and `moderator`. Every privileged action is written to
  `StaffAudit`. Public JWTs grant no staff access.
- **Bot.** Telegram webhook calls must carry `TELEGRAM_WEBHOOK_SECRET`. The bot reaches the API
  only with `BOT_API_SECRET`, and gets no database or JWT secrets.
- **Anonymous buyers.** Access to an anonymous order uses an expiring, hashed capability token,
  never an order number or email alone.
- **Rate limits** key on the client address derived with `API_TRUST_PROXY_HOPS`.
