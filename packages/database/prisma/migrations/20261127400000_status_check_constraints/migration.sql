-- Free-text status columns had no CHECK, so a typo in code was stored silently.
-- The allowed values below are every value the code, seeds and triggers write.
--
-- The constraints are NOT VALID on purpose: a deploy must never fail on a row
-- written before this migration. They still apply to every new INSERT and to
-- every UPDATE of a row, so no new bad value can be stored. After checking the
-- old rows, an operator can run the VALIDATE statements at the bottom.

ALTER TABLE "Event" ADD CONSTRAINT "Event_moderationStatus_check"
  CHECK ("moderationStatus" IN ('clear','pending','approved','sales_paused','rejected','hidden','cancelled','expired')) NOT VALID;

ALTER TABLE "TicketEmailDelivery" ADD CONSTRAINT "TicketEmailDelivery_status_check"
  CHECK ("status" IN ('queued','sending','accepted','failed','uncertain')) NOT VALID;

ALTER TABLE "StaffOperation" ADD CONSTRAINT "StaffOperation_status_check"
  CHECK ("status" IN ('pending','dispatching','queued','failed','completed')) NOT VALID;

ALTER TABLE "StaffRefund" ADD CONSTRAINT "StaffRefund_status_check"
  CHECK ("status" IN ('requested','processing','succeeded','failed')) NOT VALID;

-- Operator follow-up (not run by this migration). Each query must return no rows:
--   SELECT DISTINCT "moderationStatus" FROM "Event" WHERE "moderationStatus" NOT IN ('clear','pending','approved','sales_paused','rejected','hidden','cancelled','expired');
--   SELECT DISTINCT "status" FROM "TicketEmailDelivery" WHERE "status" NOT IN ('queued','sending','accepted','failed','uncertain');
--   SELECT DISTINCT "status" FROM "StaffOperation" WHERE "status" NOT IN ('pending','dispatching','queued','failed','completed');
--   SELECT DISTINCT "status" FROM "StaffRefund" WHERE "status" NOT IN ('requested','processing','succeeded','failed');
-- Fix any rows they list, then validate:
--   ALTER TABLE "Event" VALIDATE CONSTRAINT "Event_moderationStatus_check";
--   ALTER TABLE "TicketEmailDelivery" VALIDATE CONSTRAINT "TicketEmailDelivery_status_check";
--   ALTER TABLE "StaffOperation" VALIDATE CONSTRAINT "StaffOperation_status_check";
--   ALTER TABLE "StaffRefund" VALIDATE CONSTRAINT "StaffRefund_status_check";
