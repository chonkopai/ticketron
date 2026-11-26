-- Audit batch 2 (L-06, BUG-02): rejected webhooks leave a durable row, and ignored/rejected rows say why.
ALTER TYPE "WebhookEventStatus" ADD VALUE IF NOT EXISTS 'rejected';
ALTER TABLE "WebhookEvent" ADD COLUMN "reason" VARCHAR(80);
