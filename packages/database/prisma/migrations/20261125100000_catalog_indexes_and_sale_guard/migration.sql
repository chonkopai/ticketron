-- PERF-03: the order-insert sale guard compared `id::text` / `"telegramId"::text`,
-- which cannot use the Event primary key or the User.telegramId unique index, so
-- every Order insert sequentially scanned Event (and User for Telegram guests).
-- Compare native uuid/bigint values instead. The format checks accept exactly
-- the canonical text forms the old `::text` comparison could ever match, so the
-- set of matched rows is unchanged and malformed snapshots still match nothing.
CREATE OR REPLACE FUNCTION platform_order_sale_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ev "Event"%ROWTYPE; owner "User"%ROWTYPE; buyer "User"%ROWTYPE; commission integer; event_key text; telegram_key text;
BEGIN
  IF NEW."buyerUserId" IS NOT NULL THEN
    SELECT * INTO buyer FROM "User" WHERE id=NEW."buyerUserId" FOR SHARE;
    IF buyer."blockedAt" IS NOT NULL THEN RAISE EXCEPTION 'ACCOUNT_RESTRICTED' USING ERRCODE='P0001'; END IF;
  ELSIF NEW."guestContact"->>'channel'='telegram' THEN
    telegram_key:=NEW."guestContact"->>'telegramId';
    IF telegram_key ~ '^(0|-?[1-9][0-9]{0,17})$' THEN
      SELECT * INTO buyer FROM "User" WHERE "telegramId"=telegram_key::bigint FOR SHARE;
      IF buyer."blockedAt" IS NOT NULL THEN RAISE EXCEPTION 'ACCOUNT_RESTRICTED' USING ERRCODE='P0001'; END IF;
    END IF;
  ELSIF NEW."guestContact"->>'channel'='email' THEN
    SELECT u.* INTO buyer FROM "User" u JOIN "ContactIdentity" c ON c."userId"=u.id WHERE c.method='email' AND c."normalizedIdentifier"=lower(NEW."guestContact"->>'email') FOR SHARE OF u;
    IF buyer."blockedAt" IS NOT NULL THEN RAISE EXCEPTION 'ACCOUNT_RESTRICTED' USING ERRCODE='P0001'; END IF;
  END IF;
  event_key:=NEW."checkoutSnapshot"->>'eventId';
  IF event_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT * INTO ev FROM "Event" WHERE id=event_key::uuid FOR SHARE;
    IF FOUND THEN
      SELECT * INTO owner FROM "User" WHERE id=ev."organizerId" FOR SHARE;
      IF owner."blockedAt" IS NOT NULL OR ev."approvedAt" IS NULL OR ev."salesPaused" OR ev."moderationStatus" <> 'approved' OR ev.status<>'published' THEN RAISE EXCEPTION 'EVENT_SALES_PAUSED' USING ERRCODE='P0001'; END IF;
      commission:=COALESCE(owner."commissionBps",(SELECT value FROM "PlatformSetting" WHERE key='commission.default'));
      NEW."commissionBps":=commission;
      NEW."commissionAmount":=CASE WHEN commission IS NULL THEN NULL ELSE floor(NEW.amount::bigint*commission/10000.0)::integer END;
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- PERF-04: catalogue "current event" filter (`startsAt > now OR endsAt > now`,
-- plus the legacy `startsAt IS NULL` scan) on published events.
CREATE INDEX "Event_status_startsAt_idx" ON "Event"("status", "startsAt");
CREATE INDEX "Event_status_endsAt_idx" ON "Event"("status", "endsAt");

-- PERF-04: catalogue search uses case-insensitive `%q%` (ILIKE) on these columns.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "Event_title_idx" ON "Event" USING GIN ("title" gin_trgm_ops);
CREATE INDEX "Event_city_idx" ON "Event" USING GIN ("city" gin_trgm_ops);
CREATE INDEX "Event_address_idx" ON "Event" USING GIN ("address" gin_trgm_ops);
CREATE INDEX "EventContent_title_idx" ON "EventContent" USING GIN ("title" gin_trgm_ops);
CREATE INDEX "EventContent_address_idx" ON "EventContent" USING GIN ("address" gin_trgm_ops);
CREATE INDEX "EventTranslation_title_idx" ON "EventTranslation" USING GIN ("title" gin_trgm_ops);
CREATE INDEX "EventTranslation_address_idx" ON "EventTranslation" USING GIN ("address" gin_trgm_ops);
