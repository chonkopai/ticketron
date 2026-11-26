ALTER TABLE "AnonymousCheckoutSession" ADD COLUMN "botOffer" JSONB;

CREATE INDEX "AnonymousCheckoutSession_telegramId_chatId_createdAt_idx"
  ON "AnonymousCheckoutSession"("telegramId", "chatId", "createdAt");
