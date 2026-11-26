-- Batch 3 (SEC-01, SEC-03, PERF-21): Telegram-side link consent, absolute refresh family lifetime, purge index.
ALTER TABLE "RefreshToken" ADD COLUMN "familyCreatedAt" TIMESTAMPTZ(3);
CREATE INDEX "RefreshToken_expiresAt_idx" ON "RefreshToken"("expiresAt");

ALTER TABLE "TelegramLinkToken"
  ADD COLUMN "attemptTelegramId" BIGINT,
  ADD COLUMN "attemptChatId" BIGINT,
  ADD COLUMN "attemptAt" TIMESTAMPTZ(3),
  ADD COLUMN "telegramConfirmedAt" TIMESTAMPTZ(3),
  ADD COLUMN "cancelledAt" TIMESTAMPTZ(3);
