# Deployment

This guide deploys Ticketron on one Linux server with Docker Compose. Caddy terminates HTTPS
and gets certificates from Let's Encrypt automatically. All commands run from the repository
root on the server.

The stack (`deploy/docker-compose.yml`) has these services:

| Service | Image | Role |
|---|---|---|
| `postgres` | `postgres:17-alpine` | Database (volume `postgres_data`) |
| `migrate` | app image | Runs `prisma migrate deploy` once (profile `tools`) |
| `api` | app image | REST API and background workers, port 3001 inside the network |
| `bot` | app image | Telegram webhook server, port 3002 inside the network |
| `web` | app image | Next.js server, port 3000 inside the network |
| `caddy` | `caddy:2-alpine` | Public edge on ports 80 and 443 |

One image (`ticketron:<RELEASE_TAG>`, built from `deploy/Dockerfile`) contains all three apps.
Only Caddy publishes ports.

## 1. Server

- A Linux VM with 2 vCPU and 4 GB RAM or more, Docker Engine and the Compose plugin.
- Inbound TCP 80 and 443 (and UDP 443 for HTTP/3) open in the firewall.
- Outbound access to Docker Hub, the npm registry, Telegram, Google and your email provider.

## 2. DNS

Create A (and AAAA, if the server has IPv6) records pointing at the server:

- the site host, for example `tickets.example.com` (`SITE_DOMAIN`)
- the staff console host, for example `admin.example.com` (`ADMIN_DOMAIN`)

Both must resolve before Caddy starts, or certificate issuance fails and is retried later.

While the platform uses the mock payment provider, the site host must be a staging host: its
leftmost label must be `staging`, `stage`, `demo`, `test`, `dev`, `qa`, `sandbox` or `preview`
(optionally followed by `-something`), for example `staging.example.com`. The API refuses to
start with the mock provider or `DEMO_MODE=true` on any other host. See
[Taking real payments](#taking-real-payments).

## 3. Environment file

```bash
cp deploy/.env.example deploy/.env
chmod 600 deploy/.env
```

Fill in every value. Compose reads `deploy/.env` for variable substitution in the Compose file
and passes it to the API as its environment. The bot and web containers receive only the
variables listed in `deploy/docker-compose.yml`.

Required:

| Variable | Value |
|---|---|
| `SITE_DOMAIN` | Site host without scheme, e.g. `staging.example.com` |
| `ADMIN_DOMAIN` | Staff console host, e.g. `admin.example.com` |
| `DEMO_MODE`, `PAYMENT_PROVIDER_NAME` | `true` and `mock` until a real provider exists |
| `PAYMENT_PROVIDER_WEBHOOK_SECRET` | Random, 32+ characters |
| `POSTGRES_PASSWORD` | Random |
| `JWT_SECRET`, `JWT_REFRESH_SECRET`, `BOT_API_SECRET`, `OTP_HMAC_SECRET` | Four different random values, 32+ characters each |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` | From BotFather ([Telegram bot](#telegram-bot)) |
| `TELEGRAM_WEBHOOK_SECRET` | Random, 32-256 characters of `A-Z a-z 0-9 _ -` |

Generate each secret separately:

```bash
openssl rand -hex 32
```

Every other variable is optional. [configuration.md](configuration.md) lists all of them with
defaults. Never put a secret in a Docker build argument: build arguments end up in the image.
Only `NEXT_PUBLIC_*` values, which are public by design, are passed to the build.

## 4. Build, migrate, start

```bash
docker compose -f deploy/docker-compose.yml build web
docker compose -f deploy/docker-compose.yml up -d postgres
docker compose -f deploy/docker-compose.yml run --rm migrate
docker compose -f deploy/docker-compose.yml up -d api bot web caddy
docker compose -f deploy/docker-compose.yml ps
```

`build web` builds the shared image used by `api`, `bot`, `web` and `migrate`. Set
`RELEASE_TAG=<version>` in the shell to keep older images for rollback; the default tag is
`local`.

Check the chain from the web container to the API:

```bash
docker compose -f deploy/docker-compose.yml exec -T web node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{console.log(r.status);process.exit(r.ok?0:1)})"
curl -I https://$SITE_DOMAIN
```

The first command prints `200`. Do not run `pnpm db:seed` on a server: the seed creates demo
data. A new deployment starts with an empty catalog.

## 5. HTTPS and proxies

Caddy obtains and renews certificates for `SITE_DOMAIN` and `ADMIN_DOMAIN`. Certificates are
kept in the `caddy_data` volume.

Caddy is the only public entry point. It sets `X-Forwarded-For`, `X-Forwarded-Proto` and
`X-Forwarded-Host` from the real client connection and strips `X-Real-IP` and `Forwarded`
(`deploy/Caddyfile`), so clients cannot forge their address.

`API_TRUST_PROXY_HOPS` tells the API how many proxies sit in front of it. Rate limits use the
client address it derives. The Compose file sets `2` (Caddy, then Next.js).

| Path to the API | Value |
|---|---|
| Browser → Caddy → Next.js → API (all public API routes, the staff BFF) | `2` (Compose) |
| Telegram Mini App: Caddy → API at `/telegram/seats` | `2` works: Caddy sets `X-Forwarded-For` to the peer address |
| Bot → API on the internal network | not used |
| Local `pnpm dev`: browser → Next.js → API | `1` (`.env.example`) |
| Direct API access with no proxy | `0` (default) |

Keep the API and web ports private. If you add a CDN or another proxy, recount the hops.

The public site host does not send `X-Robots-Tag: noindex`. For a staging site you do not want
indexed, uncomment that line in `deploy/Caddyfile`. The admin host always sends it.

## 6. First staff account

Set `STAFF_ENABLED=true`, `STAFF_GATEWAY_SECRET` (random, different from all other secrets) and
`STAFF_MFA_ENCRYPTION_KEY` (`openssl rand -hex 32`) in `deploy/.env`, then recreate the
containers:

```bash
docker compose -f deploy/docker-compose.yml up -d api web
docker compose -f deploy/docker-compose.yml exec api node dist/staff/bootstrap.js
```

The bootstrap command creates the first Moderator. It asks for an email, a name and a password
(the password prompt is hidden). It refuses to run when any staff account exists. Sign in at `https://$ADMIN_DOMAIN/admin`,
enroll an authenticator app and save the recovery codes. Invite the rest of the team from
Settings. Staff invitations and password recovery are sent by email, so configure Resend first.

Back up `STAFF_MFA_ENCRYPTION_KEY` outside the server. Without it, existing staff cannot pass
two-factor checks.

## 7. Backups and restore

Back up these together: the PostgreSQL database, the media volumes (`poster_data`,
`draft_media_data`, `private_support_data`) and `deploy/.env`. Store backups encrypted and
off the server.

Consistent backup with a short write pause:

```bash
umask 077
mkdir -p backups/$(date +%F)
cd backups/$(date +%F)
docker compose -f ../../deploy/docker-compose.yml stop api bot web
docker compose -f ../../deploy/docker-compose.yml exec -T postgres pg_dump -U ticketron -d ticketron -Fc > database.dump
docker compose -f ../../deploy/docker-compose.yml run --rm --no-deps --entrypoint tar api -C /data -czf - posters draft-media private-support > media.tgz
docker compose -f ../../deploy/docker-compose.yml up -d api bot web
cd ../..
```

Restore into a new, empty stack with the same application version and the same `deploy/.env`:

```bash
docker compose -f deploy/docker-compose.yml up -d postgres
docker compose -f deploy/docker-compose.yml exec -T postgres pg_restore -U ticketron -d ticketron --no-owner --no-acl < backups/DATE/database.dump
docker compose -f deploy/docker-compose.yml run --rm --no-deps --entrypoint tar api -C /data -xzf - < backups/DATE/media.tgz
docker compose -f deploy/docker-compose.yml run --rm migrate
docker compose -f deploy/docker-compose.yml up -d api bot web caddy
```

Do not restore over a running database. Never run `docker compose down -v` on a server: it
deletes the database, media and certificate volumes.

## 8. Updates and rollback

```bash
git pull
export RELEASE_TAG=$(git rev-parse --short HEAD)
docker compose -f deploy/docker-compose.yml build web
docker compose -f deploy/docker-compose.yml run --rm migrate
docker compose -f deploy/docker-compose.yml up -d api bot web
```

Take a backup before any update that contains a migration. Migrations only move forward. To
roll back code, set `RELEASE_TAG` to the previous tag and run `up -d api bot web`. This works
when the newer migrations are additive, which is the convention in
`packages/database/prisma/migrations`. If a migration changed data in a way the old code cannot
read, restore the backup instead.

Changing a `NEXT_PUBLIC_*` value or `SITE_DOMAIN` requires `build web` again. Other variables
need only `up -d` for the affected services.

Older deployments used the Compose project name `ticketron-demo`. To keep their volumes, set
`COMPOSE_PROJECT_NAME=ticketron-demo` in the shell (or at the top of `deploy/.env`) before
running any command.

## Content Security Policy

The web app sends `Content-Security-Policy-Report-Only` on every page (built in
`apps/web/next.config.ts`, function `contentSecurityPolicy`). The public site allows the
Telegram login widget, Google sign-in, Yandex Maps and the Google Maps embed; the staff console
(`/admin`) allows only its own origin. Report-only mode blocks nothing: browsers print
violations in the developer console.

To switch to enforcement:

1. Open the main pages (catalog, event page with a map, checkout, sign-in with Telegram and
   Google, organizer dashboard, staff console) with the developer console open and confirm there
   are no `Content-Security-Policy` violation messages. Add any missing origin to the matching
   directive.
2. In `apps/web/next.config.ts`, rename the header key `Content-Security-Policy-Report-Only` to
   `Content-Security-Policy` for the site and admin entries.
3. Rebuild and deploy web, then repeat step 1.

`script-src` still allows `'unsafe-inline'` because Next.js inlines bootstrap scripts. Removing it
needs per-request nonces (see the Next.js Content Security Policy guide), which makes every page
dynamic.

## Taking real payments

The repository ships only the mock provider. Before the site can sell real tickets:

1. Implement a provider adapter, its webhook verification and refunds ([payments.md](payments.md)).
2. Set `PAYMENT_PROVIDER_NAME` to the new provider and `DEMO_MODE=false`.
3. Move `SITE_DOMAIN` to the production host, rebuild web, update DNS and re-register the
   Telegram webhook, the Telegram login domain and the Google origin for the new host.
4. Test a real charge and a real refund end to end.

## Third-party accounts and API keys

Every external key is configuration only. Replace any of them in `deploy/.env` with no code
change. The platform currently runs on the developer's own prototyping accounts. You can keep
them for a demo, but create your own accounts and replace the keys before launch: those keys
belong to the developer's accounts, billing and quotas and can be revoked at any time.

### Telegram bot

1. In Telegram, open @BotFather and run `/newbot`, or take over the existing bot with BotFather's
   ownership transfer (Bot Settings → Transfer Ownership).
2. Set `TELEGRAM_BOT_TOKEN` (the token) and `TELEGRAM_BOT_USERNAME` (without `@`). The web build
   uses the same username for the login widget.
3. Set `TELEGRAM_WEBHOOK_SECRET` to a new random value.
4. In BotFather, run `/setdomain` and enter `SITE_DOMAIN` so the login widget works.
5. Rebuild and restart, then register the webhook and the command menu:

   ```bash
   docker compose -f deploy/docker-compose.yml build web
   docker compose -f deploy/docker-compose.yml up -d api bot web
   docker compose -f deploy/docker-compose.yml exec bot node dist/register-webhook.js
   ```

6. Seat-picker Mini App (optional): in BotFather, create a Mini App on the bot with the URL
   `https://SITE_DOMAIN/telegram/seats`. Put its short name in `TELEGRAM_SEAT_MINI_APP_NAME`
   (default `seats`) and set `TELEGRAM_SEAT_MINI_APP_ENABLED=true`.
7. Telegram OIDC login (optional): in BotFather's Login Widget settings, register
   `https://SITE_DOMAIN` and `https://SITE_DOMAIN/login/telegram/callback`, choose RS256 and copy
   the client ID and secret to `TELEGRAM_OIDC_CLIENT_ID` and `TELEGRAM_OIDC_CLIENT_SECRET`. Then
   set `TELEGRAM_OIDC_ENABLED=true`.

Check: send `/start` to the bot and sign in on the site with Telegram.

### Google sign-in

1. In Google Cloud Console, create a project and configure the OAuth consent screen: app name,
   support email, logo and a link to your privacy policy.
2. Create an OAuth client of type Web application. Under Authorized JavaScript origins add
   `https://SITE_DOMAIN`. No redirect URI and no client secret are needed.
3. Set `GOOGLE_CLIENT_ID` and `NEXT_PUBLIC_GOOGLE_CLIENT_ID` to the same client ID, rebuild web
   and restart the API.

Check: the Google button on the sign-in page opens the Google popup and signs you in.

### Yandex Maps, Suggest and Geocoder

1. In the Yandex developer dashboard (developer.tech.yandex.ru), create keys for the JavaScript
   API and HTTP Geocoder, and a separate key for the Geosuggest API.
2. Restrict each browser key by HTTP Referer to `SITE_DOMAIN`.
3. Set `NEXT_PUBLIC_YANDEX_MAPS_API_KEY`, `NEXT_PUBLIC_YANDEX_SUGGEST_API_KEY` and
   `YANDEX_GEOCODER_API_KEY` (server only, never in the image), and
   `NEXT_PUBLIC_YANDEX_GEOCODER_ENABLED=true` so the browser uses the server geocoder. Rebuild web.
4. Optional: a Google Maps Embed API key in `NEXT_PUBLIC_GOOGLE_MAPS_EMBED_API_KEY`, restricted
   to the Maps Embed API and `SITE_DOMAIN`.

Check: the address field in the event wizard suggests addresses and shows the map.

### Email (Resend)

1. Create a Resend account and add a sending domain, for example `mail.example.com`.
2. Add the SPF, DKIM and MX records Resend shows to your DNS and wait for verification.
3. Create an API key with sending access only. Set `RESEND_API_KEY`,
   `RESEND_FROM_EMAIL=tickets@mail.example.com` and `RESEND_SENDER_DOMAIN=mail.example.com`.
   Restart the API.

Check: request an email sign-in code on the site.

### Machine translation (optional)

Organizers can translate event text automatically. Without a key, manual translation still works.

- Azure Translator: create a Translator resource in Azure, set `TRANSLATION_PROVIDER=azure`,
  `AZURE_TRANSLATOR_KEY` and `AZURE_TRANSLATOR_REGION` (`global` for a global resource).
- Google: enable the Cloud Translation API, create an API key restricted to it, set
  `TRANSLATION_PROVIDER=google` and `GOOGLE_TRANSLATE_API_KEY`.

### Apple Wallet (optional)

Requires an Apple Developer account. Create a Pass Type ID and its certificate, download the
Apple WWDR certificate, and set the `APPLE_WALLET_*` variables
([configuration.md](configuration.md#apple-wallet)). The certificate files must be mounted into
the API container; add a read-only volume for them in `deploy/docker-compose.yml`.

### Payment provider

Only the mock provider exists. See [payments.md](payments.md) for what a real integration needs.

### Internal secrets

`POSTGRES_PASSWORD`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `BOT_API_SECRET`, `OTP_HMAC_SECRET`,
`TELEGRAM_WEBHOOK_SECRET`, `PAYMENT_PROVIDER_WEBHOOK_SECRET`, `STAFF_GATEWAY_SECRET` and
`STAFF_MFA_ENCRYPTION_KEY` are not third-party keys. Always generate your own with
`openssl rand -hex 32` and never reuse the developer's values. Effects of changing one later:

| Secret | Effect of a change |
|---|---|
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | Every user is signed out |
| `OTP_HMAC_SECRET` | Pending email codes and existing ticket email links stop working |
| `STAFF_MFA_ENCRYPTION_KEY` | Stored staff TOTP secrets become unreadable; staff must re-enroll |
| `STAFF_GATEWAY_SECRET` | Must be identical on API and web; restart both together |
| `BOT_API_SECRET`, `TELEGRAM_WEBHOOK_SECRET` | Restart bot and API together; re-register the webhook |
| `POSTGRES_PASSWORD` | Set at first start only; change it inside PostgreSQL too (`ALTER USER`) |

### Rotating a key later

1. Change the value in `deploy/.env`.
2. If it is a `NEXT_PUBLIC_*` variable, run `build web`.
3. Run `docker compose -f deploy/docker-compose.yml up -d api bot web`.
4. If the bot token or `TELEGRAM_WEBHOOK_SECRET` changed, run `register-webhook.js` again.
5. Revoke the old key at the provider.
