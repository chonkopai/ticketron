CREATE TABLE "TelegramSeatSession" (
    "launchHash" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "telegramId" BIGINT NOT NULL,
    "eventId" UUID NOT NULL,
    "locale" VARCHAR(2) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "TelegramSeatSession_pkey" PRIMARY KEY ("launchHash")
);

CREATE UNIQUE INDEX "TelegramSeatSession_tokenHash_key" ON "TelegramSeatSession"("tokenHash");
CREATE INDEX "TelegramSeatSession_expiresAt_idx" ON "TelegramSeatSession"("expiresAt");

ALTER TABLE "AnonymousCheckoutSession" ADD COLUMN "telegramSeatEventId" UUID;
CREATE INDEX "AnonymousCheckoutSession_telegram_seat_event_idx" ON "AnonymousCheckoutSession"("telegramId", "telegramSeatEventId", "createdAt");
