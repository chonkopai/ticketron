# Development

## Setup

Follow the quick start in the [README](../README.md#local-quick-start). `pnpm dev` starts the
API (port 3001), bot (3002) and web app (3000) in watch mode through Turborepo.

Useful scripts from the repository root:

| Command | What it does |
|---|---|
| `pnpm dev` | All apps in watch mode |
| `pnpm build` | Build every package (shared packages first); the web build needs production HTTPS URLs |
| `pnpm build:packages` | Build only the shared packages, which the apps and the seed import |
| `pnpm lint` | oxlint over `apps` and `packages` |
| `pnpm typecheck` | TypeScript checks, including Next.js route types |
| `pnpm test` | All test suites, one package at a time |
| `pnpm db:generate` | Regenerate the Prisma client |
| `pnpm db:migrate` | Apply migrations (`prisma migrate deploy`) and regenerate the client |
| `pnpm db:seed` / `pnpm db:verify` | Load and check demo data |
| `pnpm --filter @event-platform/database db:migrate:dev` | Create a new migration from schema changes |

Prisma reads `DATABASE_URL` from the root `.env`, so `db:generate` needs that file.

## Tests

Unit tests run without a database. Database suites are gated: they only run against a
PostgreSQL database whose name matches the disposable pattern in
`packages/database/src/test-database-guard.ts` (for example `ticketron_test_1`). Each API spec
file empties every table of that database before it runs, so never point tests at a database
you care about. With any other `DATABASE_URL` the database suites refuse to run.

Run everything the way CI does:

```bash
docker run -d --rm --name ticketron-test-db -p 55432:5432 \
  -e POSTGRES_USER=ticketron -e POSTGRES_PASSWORD=ticketron -e POSTGRES_DB=ticketron_test_1 postgres:17

export ENV_FILE=$PWD/.github/ci/test.env
export DATABASE_URL=postgresql://ticketron:ticketron@localhost:55432/ticketron_test_1
export REGRESSION_TEST_DATABASE_URL=$DATABASE_URL VERIFICATION_TEST_DATABASE_URL=$DATABASE_URL
export REQUIRE_DB_TESTS=true DATABASE_TESTS=true STAFF_DATABASE_TEST=true EVENT_CREATION_DB_TEST=true \
  GOOGLE_AUTH_DB_TEST=true TELEGRAM_CHECKOUT_DB_TEST=true TELEGRAM_COMPANION_DB_TEST=true \
  TELEGRAM_GUEST_DB_TEST=true TELEGRAM_OIDC_DB_TEST=true

pnpm db:migrate
pnpm lint
pnpm typecheck
pnpm test

docker stop ticketron-test-db
```

`.github/ci/test.env` holds inert, non-secret settings; tests never call Telegram, Resend,
translation, maps or payment services. The draft media specs need `ffmpeg` and `ffprobe` on the
`PATH`. Web tests use `node:test` (`apps/web/scripts/run-unit-tests.mjs`); the other packages use
Vitest.

To run one API spec:

```bash
cd apps/api
npx vitest run src/booking/refund.service.spec.ts
```

## CI

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests: install, migrate a
PostgreSQL 17 service database, lint, typecheck, schema validation, all tests, then migrate,
seed and verify a second fresh database.

## Conventions

- Business rules live in the API. The web app and bot call the API; they do not import
  `@event-platform/database`.
- Shared request and response shapes are Zod schemas in `packages/shared-types`. Validate
  inputs with them on both sides.
- New environment variables go into the schema in `packages/config/src/index.ts`, into
  `.env.example` (and `deploy/.env.example` if production needs them), into
  `deploy/docker-compose.yml` for bot and web, and into [configuration.md](configuration.md).
- Migrations are forward-only and additive where possible, so the previous release can still
  run against the new schema during a rollback. Never edit a migration that has been applied.
- Money is stored as integers in the currency's minor unit.
- Inventory changes take row locks in a fixed order (see `booking/inventory-locks.ts`).
- Spec files sit next to the code they test (`*.spec.ts`). Database specs import
  `test-support/require-test-database.js` first.
