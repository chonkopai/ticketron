-- Orders record their event directly so revenue by event can use an index instead of scanning
-- every paid order through tickets and bookings. Additive: the previous release ignores the
-- column. Orders it writes during a rollback keep a NULL eventId and are still counted by the
-- revenue fallback; re-running the UPDATE below after such a rollback fills them in.
ALTER TABLE "Order" ADD COLUMN "eventId" UUID;

-- Backfill with the same precedence the revenue code used: checkout snapshot, then the first
-- ticket's ticket type, then the booked table's layout. Only events that still exist are used.
UPDATE "Order" o SET "eventId" = e.id
FROM "Event" e
WHERE o."eventId" IS NULL
  AND o."checkoutSnapshot" ->> 'eventId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND e.id = (o."checkoutSnapshot" ->> 'eventId')::uuid;

UPDATE "Order" o SET "eventId" = tt."eventId"
FROM "Ticket" t
JOIN "TicketType" tt ON tt.id = t."ticketTypeId"
WHERE o."eventId" IS NULL AND t."orderId" = o.id;

UPDATE "Order" o SET "eventId" = vl."eventId"
FROM "Booking" b
JOIN "Table" tb ON tb.id = b."tableId"
JOIN "VenueLayout" vl ON vl.id = tb."venueLayoutId"
WHERE o."eventId" IS NULL AND b."orderId" = o.id AND vl."eventId" IS NOT NULL;

CREATE INDEX "Order_eventId_paymentStatus_idx" ON "Order"("eventId", "paymentStatus");

ALTER TABLE "Order" ADD CONSTRAINT "Order_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;
