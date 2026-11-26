# Telegram

Telegram is used for sign-in, a guest and organizer bot, ticket delivery and a seat-picker
Mini App. Setting up the bot account and keys is covered in
[deployment.md](deployment.md#telegram-bot).

## Sign-in

- **Login widget.** The default. Telegram signs the user data with the bot token and the API
  verifies it. Requires the site domain to be set with `/setdomain` in BotFather.
- **OIDC** (`TELEGRAM_OIDC_ENABLED=true`). Redirect-based sign-in with RS256, PKCE and
  single-use, browser-bound attempts. The callback is `https://SITE_DOMAIN/login/telegram/callback`.
  It requests the `telegram:bot_access` scope, so the bot can message the user afterwards. The
  widget stays available for phone-number sign-in.

Both methods resolve to the same account by Telegram user ID. Linking a Telegram account to an
existing account starts on the site and must be confirmed inside the bot.

## Bot

`apps/bot` runs an Express server with one public route, `POST /telegram/webhook`, plus
`GET /health`. Telegram must send `X-Telegram-Bot-Api-Secret-Token` equal to
`TELEGRAM_WEBHOOK_SECRET`. Each update is claimed in the API's `TelegramUpdate` inbox before
processing, so a redelivered update is not handled twice. The bot holds no database access; it
calls the API's `/bot/*` routes with `BOT_API_SECRET`.

Guest features: event search and cards, checkout for general tickets and whole tables,
payment status and resume (`/check_payment`), **My tickets** with QR codes, event-day cards and
reminders, questions to organizers and order conversations. Menus are in Russian, English and
Kazakh, chosen by the Telegram client language.

Organizer features (`TELEGRAM_BOT_ORGANIZER_ENABLED`, on by default): event list with sales
snapshot, order lookup, ticket resend, inbox for buyer messages and event updates to buyers.

### Registering the webhook

After the site is reachable over HTTPS:

```bash
docker compose -f deploy/docker-compose.yml exec bot node dist/register-webhook.js
```

The script registers `https://SITE_DOMAIN/telegram/webhook` with the secret, the allowed update
types and the command menu in all three languages. It keeps pending updates. Run it again after
changing the bot token, the webhook secret or the site domain. A bot can have only one webhook,
so do not point a production bot at a test server.

For local development without a public host, the bot cannot receive updates. Use an HTTPS tunnel
to port 3000 (Next.js forwards `/telegram/webhook` to the bot), set `WEB_ORIGIN` and
`NEXT_PUBLIC_API_URL` to the tunnel URL, add its host to `NEXT_ALLOWED_DEV_ORIGINS`, and register
the webhook from `apps/bot`:

```bash
pnpm --filter @event-platform/bot exec tsx src/register-webhook.ts
```

Use a separate test bot for this, never the production bot.

## Seat-picker Mini App

Guests choose numbered seats, table seats or whole tables in a Telegram Mini App. It is a static
bundle built during `pnpm build` (`apps/web` script `build:telegram-seats`) and served by the API
at `/telegram/seats`. Caddy sends that path directly to the API, so it works even if the web
container is down.

Setup:

1. In BotFather, create a Mini App on the bot with the URL `https://SITE_DOMAIN/telegram/seats`.
2. Set `TELEGRAM_SEAT_MINI_APP_NAME` to its short name (default `seats`).
3. Set `TELEGRAM_SEAT_MINI_APP_ENABLED=true` and restart the API and bot.

The API accepts Mini App launch data up to five minutes old and issues a short-lived session
bound to the Telegram user and event. Checkout uses the same prices, locks and orders as the
website.

## Notifications

With `TRANSACTIONAL_NOTIFICATIONS_ENABLED=true`, the API sends purchase confirmations, event
change and cancellation notices and reminders to users who linked Telegram and allowed messages.
Delivery runs in API workers with retries. Telegram errors 403 (blocked bot) and 429 (rate limit)
are recorded on the notification. `deploy/health-checks.sql` shows queue state.
