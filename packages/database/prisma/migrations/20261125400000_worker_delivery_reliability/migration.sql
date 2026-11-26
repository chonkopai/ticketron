-- Batch 7 (BUG-16, PERF-09, PERF-10, PERF-11): worker and delivery reliability.

-- BUG-16: retries of one email generation reuse its provider idempotency key only inside the provider window.
ALTER TABLE "TicketEmailDelivery" ADD COLUMN "firstAttemptAt" TIMESTAMPTZ(3);

-- PERF-10: reminder audience is recomputed only when the event revision changes, a paid order invalidates it, or it is stale.
ALTER TABLE "Broadcast"
  ADD COLUMN "reminderAudienceRevision" INTEGER,
  ADD COLUMN "reminderAudienceAt" TIMESTAMPTZ(3);

-- PERF-11: skip/prune sweeps and consumer scans filter by (processedAt, eventType).
CREATE INDEX "OutboxEvent_processedAt_eventType_idx" ON "OutboxEvent"("processedAt", "eventType");

-- PERF-09: the quick-delivery worker only scans sessions still waiting for Telegram delivery.
-- Partial index kept in raw SQL, like the other partial indexes in this schema.
CREATE INDEX "AnonymousCheckoutSession_delivery_due_idx" ON "AnonymousCheckoutSession"("id")
  WHERE "deliveredAt" IS NULL AND "deliveryFinishedAt" IS NULL AND "deliveryMessageId" IS NOT NULL;
