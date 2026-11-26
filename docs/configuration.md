# Configuration reference

All settings come from environment variables. The API and bot validate theirs at startup with
the Zod schemas in `packages/config/src/index.ts` and refuse to start on an invalid value. The
web app validates its public values in `next.config.ts`.

Where the values live:

- Local development: `.env` in the repository root (copy of `.env.example`).
- Production: `deploy/.env` (copy of `deploy/.env.example`). Compose passes the whole file to the
  API, and only the listed variables to bot and web (`deploy/docker-compose.yml`). Some values
  are set by the Compose file itself and marked "Compose" below.

**Build time vs restart.** `NEXT_PUBLIC_*` variables are compiled into the browser bundle. After
changing one, rebuild the web image (`docker compose -f deploy/docker-compose.yml build web`).
Everything else takes effect after restarting the service that reads it.

**Owner** says who provides the value: *generated* means a random secret you create
(`openssl rand -hex 32`); *third-party* means a key from an external account
([deployment.md](deployment.md#third-party-accounts-and-api-keys)); *setting* is a plain choice.

## Runtime and URLs

| Variable | Used by | Required | Default | Meaning | Owner |
|---|---|---|---|---|---|
| `NODE_ENV` | api, bot, web | no | `development` | `production` enables HTTPS and secret checks. Compose sets `production`. | setting |
| `SITE_DOMAIN` | Compose, Caddy, web build | prod | – | Public site host. Compose derives `WEB_ORIGIN` and `NEXT_PUBLIC_API_URL` from it. | setting |
| `ADMIN_DOMAIN` | Compose, Caddy | prod | – | Staff console host. Compose derives `ADMIN_ORIGIN` from it. | setting |
| `WEB_ORIGIN` | api, bot, web | no | `http://localhost:3000` | Canonical public site origin, no trailing slash. HTTPS in production. Compose. | setting |
| `NEXT_PUBLIC_API_URL` | web (build) | yes | – | Browser-facing origin for API calls; the site origin, because Next.js forwards `/api/*`. HTTPS in production. Compose. | setting |
| `API_PORT` | api | no | `3001` | API listen port. | setting |
| `BOT_PORT` | bot | no | `3002` | Bot listen port. | setting |
| `API_BASE_URL` | bot | yes | – | Internal API URL for the bot, e.g. `http://api:3001`. Compose. | setting |
| `API_INTERNAL_URL` | web | no | `http://localhost:3001` | Internal API URL for Next.js rewrites and server rendering. Compose. | setting |
| `BOT_INTERNAL_URL` | web | no | `http://localhost:3002` | Internal bot URL for `/telegram/webhook`. Compose. | setting |
| `API_TRUST_PROXY_HOPS` | api | no | `0` | Number of proxies in front of the API ([deployment.md](deployment.md#5-https-and-proxies)). Compose sets `2`. | setting |
| `DATABASE_URL` | api, database | yes | – | PostgreSQL URL. Compose builds it from `POSTGRES_PASSWORD`. | setting |
| `POSTGRES_PASSWORD` | Compose | prod | – | Database password for the `ticketron` user. | generated |
| `POSTGRES_PORT` | local `docker-compose.yml` | no | `5432` | Host port for local PostgreSQL. | setting |
| `NEXT_ALLOWED_DEV_ORIGINS` | web (dev only) | no | – | Comma-separated extra hostnames allowed to load the dev server, e.g. an HTTPS tunnel. | setting |
| `TICKET_NEXT_DIST_DIR` | web | no | `.next` | Alternative Next.js build directory. | setting |

## Authentication and secrets

| Variable | Used by | Required | Default | Meaning | Owner |
|---|---|---|---|---|---|
| `JWT_SECRET` | api | yes | – | Signs access tokens. 32+ characters. Changing it signs everyone out. | generated |
| `JWT_REFRESH_SECRET` | api | yes | – | Signs refresh tokens. Must differ from `JWT_SECRET`. | generated |
| `REFRESH_FAMILY_MAX_AGE_DAYS` | api | no | `60` | Longest a session can be refreshed before a new sign-in is required (1-365). | setting |
| `BOT_API_SECRET` | api, bot | yes | – | Shared secret the bot sends in `x-bot-api-secret`. 32+ characters. | generated |
| `OTP_HMAC_SECRET` | api | prod | – | HMAC key for email codes and ticket access links. 32+ characters. | generated |
| `GOOGLE_CLIENT_ID` | api | no | – | Google OAuth web client ID; enables Google sign-in. | third-party |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | web (build) | no | – | Same value as `GOOGLE_CLIENT_ID`; shows the Google button. | third-party |

## Telegram

| Variable | Used by | Required | Default | Meaning | Owner |
|---|---|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | api, bot | yes | – | Bot token from BotFather. | third-party |
| `TELEGRAM_BOT_USERNAME` | api, bot, web build | yes | – | Bot username without `@`. Compose also passes it to the web build. | third-party |
| `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` | web (build) | yes | – | Username for the login widget. Compose sets it from `TELEGRAM_BOT_USERNAME`. | third-party |
| `TELEGRAM_WEBHOOK_SECRET` | bot | yes | – | Secret Telegram sends with each webhook call. 32-256 chars of `A-Za-z0-9_-`. | generated |
| `TELEGRAM_BOT_MESSAGES_ENABLED` | api, bot | no | `true` | Shows conversations and notifications in the bot. | setting |
| `TELEGRAM_BOT_ORGANIZER_ENABLED` | api | no | `true` | Organizer companion in the bot. Only `false` turns it off. | setting |
| `TELEGRAM_SEAT_MINI_APP_ENABLED` | api, bot | no | `false` | Enables the seat-picker Mini App. | setting |
| `TELEGRAM_SEAT_MINI_APP_NAME` | bot | no | `seats` | Mini App short name registered in BotFather. | setting |
| `TELEGRAM_OIDC_ENABLED` | api | no | `false` | Enables Telegram OIDC login. Needs client ID, secret and an HTTPS `WEB_ORIGIN`. | setting |
| `TELEGRAM_OIDC_CLIENT_ID` | api | with OIDC | – | Numeric client ID from BotFather. | third-party |
| `TELEGRAM_OIDC_CLIENT_SECRET` | api | with OIDC | – | Client secret from BotFather. | third-party |

## Payments and orders

| Variable | Used by | Required | Default | Meaning | Owner |
|---|---|---|---|---|---|
| `PAYMENT_PROVIDER_NAME` | api | Compose | `mock` | Payment adapter. Only `mock` exists. | setting |
| `DEMO_MODE` | api | Compose | `false` | Allows the mock provider in production, on staging hosts only. | setting |
| `PAYMENT_PROVIDER_WEBHOOK_SECRET` | api | yes for mock | – | Signs and verifies payment webhooks. 32+ characters. | generated |
| `PAYMENT_WEBHOOK_TOLERANCE_SECONDS` | api | no | `300` | Accepted webhook clock skew (30-3600). | setting |
| `CHECKOUT_TTL_SECONDS` | api | no | `900` | How long an unpaid order holds inventory. | setting |
| `CHECKOUT_CLEANUP_INTERVAL_SECONDS` | api | no | `60` | Interval of the expired-order cleanup worker. | setting |
| `TABLE_HOLD_TTL_SECONDS` | api | no | `600` | Lifetime of a table hold. | setting |
| `TABLE_HOLD_CLEANUP_INTERVAL_SECONDS` | api | no | `60` | Interval of the table-hold cleanup worker. | setting |
| `QUICK_SESSION_TTL_SECONDS` | api | no | `600` | Anonymous checkout verification session lifetime. | setting |
| `QUICK_ACCESS_TTL_SECONDS` | api | no | `2592000` | Lifetime of an anonymous buyer's order link (30 days). | setting |
| `ORGANIZER_REQUIRES_APPROVAL` | api | no | `false` | Requires staff approval before an account can act as an organizer. | setting |
| `TRANSACTIONAL_NOTIFICATIONS_ENABLED` | api | no | `false` | Automatic purchase and event notifications and reminders. Manual resends work either way. | setting |
| `EVENT_CONTENT_V2_ENABLED` | api, database | no | `false` | Also serves reconciled older events from the normalized event tables. Events created in the current wizard always use them. | setting |

## Email

| Variable | Used by | Required | Default | Meaning | Owner |
|---|---|---|---|---|---|
| `RESEND_API_KEY` | api | no | – | Resend key (`re_…`). Without it, email codes and ticket emails are unavailable. | third-party |
| `RESEND_FROM_EMAIL` | api | with key | – | Sender address. | setting |
| `RESEND_SENDER_DOMAIN` | api | no | – | Domain verified in Resend. When set, the sender must use it. | setting |

## Media and storage

| Variable | Used by | Required | Default | Meaning | Owner |
|---|---|---|---|---|---|
| `POSTER_STORAGE_DIR` | api | no | `var/posters` | Published images. Absolute in production; Compose `/data/posters`. | setting |
| `DRAFT_MEDIA_STORAGE_DIR` | api | no | `var/draft-media` | Draft uploads. Compose `/data/draft-media`. | setting |
| `PRIVATE_SUPPORT_STORAGE_DIR` | api | no | `var/private-support` | Support and verification files. Compose `/data/private-support`. | setting |
| `MEDIA_FFMPEG_PATH`, `MEDIA_FFPROBE_PATH` | api | no | `ffmpeg`, `ffprobe` | Video tools (installed in the image). | setting |
| `MEDIA_IMAGE_MAX_BYTES` | api | no | `10485760` | Image upload limit. | setting |
| `MEDIA_VIDEO_MAX_BYTES` | api | no | `104857600` | Video upload limit. | setting |
| `MEDIA_VIDEO_MAX_SECONDS` | api | no | `60` | Video length limit. | setting |
| `MEDIA_PROCESSING_CONCURRENCY` | api | no | `2` | Max concurrent ffmpeg/sharp jobs (1-16); excess uploads queue, then get 503 `MEDIA_BUSY`. | setting |
| `MEDIA_DRAFT_MAX_BYTES` | api | no | `262144000` | Total media per draft. | setting |

## Maps and address search

| Variable | Used by | Required | Default | Meaning | Owner |
|---|---|---|---|---|---|
| `NEXT_PUBLIC_YANDEX_MAPS_API_KEY` | web (build) | no | – | Yandex Maps JavaScript API key for the address picker. | third-party |
| `NEXT_PUBLIC_YANDEX_SUGGEST_API_KEY` | web (build) | no | – | Yandex Geosuggest key. | third-party |
| `YANDEX_GEOCODER_API_KEY` | web (server) | no | – | Yandex HTTP Geocoder key, used only on the server. | third-party |
| `NEXT_PUBLIC_YANDEX_GEOCODER_ENABLED` | web (build) | no | `false` | Geocode through the server route `/api/address/geocode` instead of the browser Maps API. Locally it turns on by itself when `YANDEX_GEOCODER_API_KEY` is set; Docker builds need it set explicitly. | setting |
| `NEXT_PUBLIC_IP_GEOLOCATION_ENABLED` | web (build) | no | `false` | When `true`, the catalog suggests a city from an approximate IP lookup at `ipwho.is`, which sends the visitor's IP address to that service. Off by default; the catalog then uses the default city. Enable only with visitor consent. | setting |
| `NEXT_PUBLIC_GOOGLE_MAPS_EMBED_API_KEY` | web (build) | no | – | Google Maps Embed key for the event page map. | third-party |

## Machine translation

| Variable | Used by | Required | Default | Meaning | Owner |
|---|---|---|---|---|---|
| `TRANSLATION_PROVIDER` | api | no | `google` | `azure` or `google`. | setting |
| `AZURE_TRANSLATOR_KEY` | api | no | – | Azure Translator key. | third-party |
| `AZURE_TRANSLATOR_REGION` | api | no | `global` | Azure resource region. | setting |
| `GOOGLE_TRANSLATE_API_KEY` | api | no | – | Google Cloud Translation key. | third-party |
| `TRANSLATION_TIMEOUT_MS` | api | no | `10000` | Request timeout. | setting |
| `TRANSLATION_RETRIES` | api | no | `1` | Retries per request (0-2). | setting |
| `TRANSLATION_HOURLY_REQUESTS` | api | no | `20` | Hourly request limit per signed-in user. | setting |
| `TRANSLATION_DAILY_CHARACTERS` | api | no | `100000` | Daily character limit per signed-in user. | setting |
| `TRANSLATION_ANONYMOUS_HOURLY_REQUESTS` | api | no | `300` | Hourly request limit for anonymous drafts. | setting |
| `TRANSLATION_ANONYMOUS_HOURLY_CHARACTERS` | api | no | `200000` | Hourly character limit for anonymous drafts. | setting |
| `TRANSLATION_CACHE_SECONDS` | api | no | `604800` | Cache lifetime of translations. | setting |

## Staff console

| Variable | Used by | Required | Default | Meaning | Owner |
|---|---|---|---|---|---|
| `STAFF_ENABLED` | api, web | no | `false` | Enables the staff console and its API. | setting |
| `ADMIN_ORIGIN` | api, web | no | `http://admin.localhost:3000` | Staff console origin. HTTPS in production. Compose. | setting |
| `STAFF_GATEWAY_SECRET` | api, web | with staff | – | Secret the web BFF adds to staff API calls. 32+ chars, unique. | generated |
| `STAFF_MFA_ENCRYPTION_KEY` | api | with staff | – | 64 hex characters; encrypts staff TOTP secrets. | generated |

## Apple Wallet

All optional; the feature is off unless the pass type and certificates are set.

| Variable | Meaning | Owner |
|---|---|---|
| `APPLE_WALLET_PASS_TYPE_ID` | Pass Type ID, e.g. `pass.com.example.tickets` | third-party |
| `APPLE_WALLET_TEAM_ID` | Apple Developer team ID | third-party |
| `APPLE_WALLET_ORGANIZATION_NAME` | Name shown on passes | setting |
| `APPLE_WALLET_SIGNER_CERT_PATH` | Path to the pass certificate (PEM) | third-party |
| `APPLE_WALLET_SIGNER_KEY_PATH` | Path to its private key (PEM) | third-party |
| `APPLE_WALLET_SIGNER_KEY_PASSWORD` | Private key password | third-party |
| `APPLE_WALLET_WWDR_CERT_PATH` | Path to the Apple WWDR certificate | third-party |
| `APPLE_WALLET_ICON_PATH` | Path to the pass icon (PNG) | setting |

## Test-only variables

| Variable | Meaning |
|---|---|
| `ENV_FILE` | Load this env file instead of `.env` (tests and CI use `.github/ci/test.env`). |
| `TEST_DATABASE_URL` | Overrides `DATABASE_URL` in test runs. |
| `REQUIRE_DB_TESTS` | Fail instead of skipping when a database suite is disabled. |
| `REGRESSION_TEST_DATABASE_URL`, `VERIFICATION_TEST_DATABASE_URL` | Enable the regression and verification suites; must equal `DATABASE_URL`. |
| `DATABASE_TESTS`, `STAFF_DATABASE_TEST`, `EVENT_CREATION_DB_TEST`, `GOOGLE_AUTH_DB_TEST`, `TELEGRAM_*_DB_TEST` | Enable individual database suites. |
| `CI` | Set by CI; tests never fall back to the developer's `.env`. |
