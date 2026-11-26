# Ticketron

Ticketron is an event ticketing platform. Organizers create events with ticket types, numbered
seating or bookable tables, send them for moderation and sell tickets on the website and in
Telegram. Guests buy with an account or as verified guests and receive QR tickets by email,
in Telegram or in their account. Staff moderate events and organizers, answer support cases,
issue refunds and see finance reports in a separate staff console.

## Features

- Public catalog with search, filters, favorites and localized event pages (Russian, English, Kazakh)
- Sign-in with Telegram (widget or OIDC), Google, email code or password, linked into one account
- Organizer workspace: event wizard with drafts, media, translations, hall and seating editor,
  sales analytics, refunds, buyer messages and marketing campaigns
- Ticket types, numbered seats, whole tables and table holds with database-enforced inventory
- Checkout for signed-in and anonymous guests, QR tickets, optional Apple Wallet passes
- Ticket email delivery through Resend with a scoped purchase link
- Telegram bot: event search, checkout, seat-picker Mini App, ticket wallet, reminders,
  buyer and organizer conversations, organizer companion
- Staff console on its own host: event moderation, organizer verification, support inbox,
  orders and refunds, finance, homepage advertisements, team management with TOTP

## Architecture

```text
Browser ──► Caddy ─┬─► web (Next.js) ──rewrites──► api (NestJS) ──► PostgreSQL
                   ├─► /telegram/webhook ──► bot (grammY) ──► api (internal, shared secret)
                   └─► /telegram/seats ────► api (Telegram Mini App)
```

The API owns the business logic and the database. The web app renders pages and forwards
browser API calls through Next.js rewrites, so the browser talks to one origin. The bot calls
the API over the internal network. Background workers run inside the API process.
Details: [docs/architecture.md](docs/architecture.md).

## Tech stack

| Area | Technology |
|---|---|
| Runtime | Node.js 24.15+, pnpm 11.19, Turborepo 2 |
| Web | Next.js 16.3, React 19.2, TipTap 3 |
| API | NestJS 12, Prisma 7.10, PostgreSQL 17 |
| Bot | grammY 1.46, Express 5 |
| Shared | TypeScript, Zod schemas (`packages/shared-types`), env validation (`packages/config`) |
| Tests | Vitest (API, bot, packages), `node:test` (web) |
| Deployment | Docker, Docker Compose, Caddy with automatic HTTPS |

## Repository layout

```text
apps/api                NestJS REST API and background workers
apps/bot                Telegram bot and webhook server
apps/web                Next.js website, organizer workspace, staff console, Telegram Mini App build
packages/config         Environment validation shared by all apps
packages/database       Prisma schema, migrations, seed and client
packages/shared-types   Shared schemas, contracts and UI strings
deploy/                 Production Dockerfile, Compose stack, Caddyfile, env example, health SQL
docs/                   Architecture, deployment, configuration, operations and other guides
docker-compose.yml      Local PostgreSQL for development
```

## Local quick start

Requirements: Node.js 24.15 or newer, pnpm 11.19 (`corepack enable`), Docker with Compose.

```bash
cp .env.example .env
pnpm install
pnpm build:packages
docker compose up -d
pnpm db:migrate
pnpm db:seed
pnpm db:verify
pnpm dev
```

The placeholder values in `.env` are enough to run the site locally. Fill in Telegram, Google
or email settings when you need them. Never commit `.env`.

- Website: http://localhost:3000
- Staff console (with `STAFF_ENABLED=true` and staff secrets set): http://admin.localhost:3000/admin
- API health: http://localhost:3001/health
- Bot health: http://localhost:3002/health

`pnpm db:seed` adds demo organizers, events and halls. Run it only against a local database.
`docker compose down` stops PostgreSQL and keeps the data; `docker compose down -v` deletes it.

Telegram login needs a public HTTPS host registered with BotFather. For local testing, expose
port 3000 through an HTTPS tunnel and follow [docs/telegram.md](docs/telegram.md).

## Tests

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @event-platform/database prisma:validate
```

Database tests run only against a disposable PostgreSQL database whose name matches the guard
in `packages/database/src/test-database-guard.ts`, for example `ticketron_test_1`. Against any
other database they refuse to run. [docs/development.md](docs/development.md) has the exact
commands. CI runs the same steps in `.github/workflows/ci.yml`.

## Documentation

- [Architecture](docs/architecture.md)
- [Deployment](docs/deployment.md), including [third-party accounts and API keys](docs/deployment.md#third-party-accounts-and-api-keys)
- [Configuration reference](docs/configuration.md)
- [Operations](docs/operations.md)
- [Telegram](docs/telegram.md)
- [Payments](docs/payments.md)
- [Development](docs/development.md)
- [Roadmap](docs/roadmap.md)

## Known limitations / before production

- **Payments.** Only the mock payment provider is implemented. It never charges anyone, and an
  operator settles test orders with a signed command. The API refuses to start with the mock
  provider on a non-staging domain. A real provider adapter is needed before taking money; see
  [docs/payments.md](docs/payments.md).
- **SMS and push.** Phone verification and push notifications are not implemented.
- **Media storage.** Posters, draft media and private support files are stored on local disk
  (Docker volumes). There is no object storage adapter. Back the volumes up with the database.
- **One API instance.** Rate limiters and some abuse guards keep their state in process memory.
  Run one API and one web container until they move to a shared store.
- **Uploads.** Support and verification files are type-checked and re-encoded, but not scanned
  for malware.
- **Third-party keys.** The current deployment uses the developer's prototyping accounts
  (Telegram bot, Google, Yandex Maps, Resend, translation). Create your own accounts and
  replace the keys before launch; see
  [Third-party accounts and API keys](docs/deployment.md#third-party-accounts-and-api-keys).
- **Roadmap.** Planned improvements and refinements are listed in
  [docs/roadmap.md](docs/roadmap.md).
