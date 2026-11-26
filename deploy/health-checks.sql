-- Aggregate only. Run with a read-only operator connection.
BEGIN READ ONLY;

SELECT status, COUNT(*) AS updates, MAX(attempts) AS most_attempts,
       MAX(ROUND(EXTRACT(EPOCH FROM now() - "createdAt"))) FILTER (WHERE status <> 'completed') AS oldest_unfinished_seconds
FROM "TelegramUpdate"
WHERE "createdAt" >= now() - interval '24 hours' OR status = 'processing'
GROUP BY status ORDER BY status;

SELECT status, CASE WHEN "lastError" IN ('RECIPIENT_REJECTED', 'RATE_LIMITED', 'INVALID_RECIPIENT', 'DELIVERY_OUTCOME_UNKNOWN',
        'RECIPIENT_PREFERENCE_OR_LINK_CHANGED', 'EVENT_CHANGED_OR_CANCELLED', 'ORDER_NOT_ELIGIBLE', 'TICKET_NOT_ACTIVE')
       THEN "lastError" WHEN "lastError" IS NOT NULL THEN 'OTHER' END AS error_code, COUNT(*) AS deliveries,
       MAX(ROUND(EXTRACT(EPOCH FROM now() - "createdAt"))) AS oldest_seconds
FROM "Notification"
WHERE channel = 'telegram' AND ("createdAt" >= now() - interval '24 hours' OR status IN ('pending', 'processing') OR "nextAttemptAt" IS NOT NULL)
GROUP BY status, error_code ORDER BY status, error_code;

SELECT status, COUNT(*) FROM (
  SELECT CASE WHEN "expiresAt" <= now() THEN 'past_hold_expiry' ELSE 'pending_with_hold' END AS status
  FROM "Order" WHERE "paymentStatus" = 'pending' AND "expiresAt" IS NOT NULL
) pending_orders GROUP BY status ORDER BY status;

SELECT "eventType", COUNT(*) AS pending_triggers, MAX(attempts) AS most_attempts,
       MAX(ROUND(EXTRACT(EPOCH FROM now() - "occurredAt"))) AS oldest_seconds
FROM "OutboxEvent"
WHERE "processedAt" IS NULL AND "deadAt" IS NULL AND "eventType" IN ('event.updated', 'event.cancelled', 'checkout.paid', 'refund.succeeded', 'booking.cancelled', 'ticket.cancelled')
GROUP BY "eventType" ORDER BY "eventType";

SELECT CASE WHEN payload->>'reason' IN ('event_not_published', 'checkout_selection_changed', 'late_or_released_order')
            THEN payload->>'reason' ELSE 'OTHER' END AS review_reason,
       COUNT(*) AS orders_requiring_review
FROM "OutboxEvent"
WHERE "eventType" = 'payment.review_required' AND "occurredAt" >= now() - interval '24 hours'
GROUP BY review_reason ORDER BY review_reason;

-- Telegram links made before the Telegram-side confirmation step: the account has a Telegram ID,
-- at least one used link token without telegramConfirmedAt, and none with it. Counts such accounts
-- and the bot orders they claimed automatically. docs/operations.md has a variant that lists IDs.
WITH legacy_links AS (
  SELECT u.id
  FROM "User" u
  WHERE u."telegramId" IS NOT NULL
    AND EXISTS (SELECT 1 FROM "TelegramLinkToken" t WHERE t."userId" = u.id AND t."usedAt" IS NOT NULL AND t."telegramConfirmedAt" IS NULL)
    AND NOT EXISTS (SELECT 1 FROM "TelegramLinkToken" t WHERE t."userId" = u.id AND t."telegramConfirmedAt" IS NOT NULL)
    -- Web-confirmed links that skipped the Telegram step are already excluded from auto-claim.
    AND NOT EXISTS (SELECT 1 FROM "TelegramLinkToken" t WHERE t."userId" = u.id AND t."confirmedAt" IS NOT NULL
      AND t."pendingTelegramId" = u."telegramId" AND t."telegramConfirmedAt" IS NULL)
)
SELECT COUNT(DISTINCT l.id) AS legacy_linked_accounts,
       COUNT(DISTINCT l.id) FILTER (WHERE a.id IS NOT NULL) AS accounts_with_auto_claims,
       COUNT(a.id) AS auto_claimed_orders
FROM legacy_links l
LEFT JOIN "AuditLog" a ON a."actorId" = l.id AND a.action = 'order.claimed'
  AND a.meta->>'automatic' = 'true' AND a.meta->>'via' = 'telegram';

-- Dead-letter outbox rows: consumers gave up after five failed attempts. See docs/operations.md.
SELECT "eventType", COUNT(*) AS dead_rows, MIN("deadAt") AS oldest_dead_at, MAX(attempts) AS most_attempts
FROM "OutboxEvent"
WHERE "deadAt" IS NOT NULL
GROUP BY "eventType" ORDER BY "eventType";

-- Ticket email backlog: queued and sending are not final; accepted, failed and uncertain are.
SELECT status, COUNT(*) AS deliveries,
       MAX(ROUND(EXTRACT(EPOCH FROM now() - "createdAt"))) AS oldest_seconds
FROM "TicketEmailDelivery"
GROUP BY status ORDER BY status;

COMMIT;
