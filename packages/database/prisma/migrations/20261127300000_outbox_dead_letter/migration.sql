-- Dead-letter marker for outbox consumers that exhausted their attempts.
ALTER TABLE "OutboxEvent" ADD COLUMN "deadAt" TIMESTAMPTZ(3);

CREATE INDEX "OutboxEvent_deadAt_eventType_idx" ON "OutboxEvent"("deadAt", "eventType");

-- Rows that already stopped being retried at five attempts become visible as dead.
UPDATE "OutboxEvent" SET "deadAt" = now() WHERE "processedAt" IS NULL AND attempts >= 5 AND "deadAt" IS NULL;
