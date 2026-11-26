# Roadmap

Planned improvements, grouped by area and listed roughly by priority within each group. Items
marked "next" are worth doing soon; the others are smaller refinements and edge cases.

## Before a paid launch

- Connect a real payment provider: adapter, webhook route and refunds ([payments.md](payments.md)).
- Move the third-party services to the client's own accounts
  ([deployment.md](deployment.md#third-party-accounts-and-api-keys)).
- Add an SMS provider for phone verification, and push notifications.
- Add object storage for posters, draft media and private files (today they live on local
  volumes).
- Move the in-memory rate limiters and abuse guards (sign-in, anonymous checkout, geocoding) to a
  shared store before running more than one API or web instance.
- Decide whether guests may retry a failed payment. Today a `payment.failed` closes the pending
  order, and each order has one payment per provider.

## Security hardening

- Next: keep the refresh token in an `HttpOnly` cookie (with an origin check on refresh and
  logout), and switch the Content Security Policy from report-only to enforcing once its reports
  are clean ([deployment.md](deployment.md#content-security-policy)).
- After refresh-token reuse is detected, also end the current access token right away instead of
  at its normal expiry (up to 15 minutes). "Sign out everywhere" already does this.
- Scan support and verification uploads for malware.
- Ask owners of Telegram links made before the confirmation step (September 2026) to re-link, so
  bot orders are only claimed through confirmed links. `deploy/health-checks.sql` counts these
  accounts and [operations.md](operations.md#health-checks) shows how to list them.

## Refinements

- Next: approval notices could summarize every change since the last approval, not only the
  latest submission.
- Keep queued "event changed" notices when a later, unrelated edit touches the event.
- Give refunds that keep failing a "needs review" state and a staff screen, and store payment
  review state in its own column.
- Persist incoming bot updates so one can be replayed after a crash.
- Apply newly enabled notification channels and newly linked Telegram chats to already scheduled
  reminders right away (today within the hour; turning a channel off already applies at once).

## Performance

- "My events" runs about 18 queries per page, independent of how many events are shown; this
  could be brought under 10.
- A catalog page runs about 20 queries; localization is already a fixed part of that.
- Page the bot wallet's orders in the database, and let the public seat map read expired holds as
  free instead of expiring them on read.

## Code health

- Split a few large files by responsibility: `organizer/events/_components/event-management.tsx`,
  `events/events.service.ts`, `staff/staff-management.service.ts`,
  `components/hall-builder/hall-builder.jsx`.
- Bring the three translation mechanisms together (the organizer dashboard is in Russian only).
- Retire the legacy `Deposit` model over two releases: nothing creates rows anymore, but some
  cancellation, refund and settlement code still reads it.
