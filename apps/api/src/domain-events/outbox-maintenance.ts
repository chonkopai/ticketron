import type { PrismaClient } from "@event-platform/database";

import { SAFE_ORDER_HISTORY } from "../events/order-history.js";

/** Rows the transactional notification dispatcher consumes (it sets processedAt). */
export const TRANSACTIONAL_TRIGGER_TYPES = ["event.updated", "event.cancelled", "checkout.paid", "booking.cancelled", "ticket.cancelled", "refund.succeeded"] as const;

/** Every outbox type some worker consumes by `processedAt IS NULL`. Anything else has no consumer. */
export const CONSUMED_OUTBOX_TYPES: readonly string[] = [...TRANSACTIONAL_TRIGGER_TYPES, "ticket.email_requested"];

/**
 * Types that stay in the outbox after processing because code reads them later as
 * facts: order history, review/expiry signals, refund evidence, event cancellation
 * status, and the once-per-order ticket email guard (a partial unique index).
 */
export const RETAINED_OUTBOX_TYPES: readonly string[] = [...new Set([
  ...SAFE_ORDER_HISTORY,
  "payment.review_required", "checkout.expired", "checkout.paid",
  "refund.requested", "refund.operation_requested",
  "event.cancelled", "ticket.email_requested",
])];

export const OUTBOX_RETENTION_MS = 30 * 24 * 60 * 60_000;

/**
 * Marks rows nobody consumes as processed so consumer scans stop walking them, then
 * deletes processed rows older than 30 days unless their type is retained. Both steps
 * are bounded and use SKIP LOCKED, so several instances can run it safely.
 */
export async function maintainOutbox(db: PrismaClient, now: Date, limit = 1000): Promise<{ skipped: number; pruned: number }> {
  const consumed = [...CONSUMED_OUTBOX_TYPES];
  const retained = [...RETAINED_OUTBOX_TYPES];
  const skipped = await db.$executeRaw`
    UPDATE "OutboxEvent" SET "processedAt" = ${now}
    WHERE id IN (
      SELECT id FROM "OutboxEvent"
      WHERE "processedAt" IS NULL AND NOT ("eventType" = ANY(${consumed}::text[]))
      LIMIT ${limit} FOR UPDATE SKIP LOCKED)`;
  const cutoff = new Date(now.getTime() - OUTBOX_RETENTION_MS);
  const pruned = await db.$executeRaw`
    DELETE FROM "OutboxEvent"
    WHERE id IN (
      SELECT id FROM "OutboxEvent"
      WHERE "processedAt" IS NOT NULL AND "processedAt" < ${cutoff} AND NOT ("eventType" = ANY(${retained}::text[]))
      LIMIT ${limit} FOR UPDATE SKIP LOCKED)`;
  return { skipped, pruned };
}
