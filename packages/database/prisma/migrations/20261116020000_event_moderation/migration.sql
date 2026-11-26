ALTER TABLE "Event" ADD COLUMN "approvedAt" TIMESTAMPTZ(3), ADD COLUMN "approvedByStaffId" UUID, ADD COLUMN "salesPaused" BOOLEAN NOT NULL DEFAULT false;
UPDATE "Event" SET "salesPaused" = true WHERE "moderationStatus" = 'sales_paused' OR "paymentMode" = 'deposit';
-- Recognize only an actual staff approval covering the current stored version.
-- An old approval preceding later changes is not evidence for the current content.
UPDATE "Event" e SET "approvedAt" = a."createdAt", "approvedByStaffId" = a."staffId"
FROM "StaffAudit" a WHERE a."targetType" = 'event' AND a."targetId" = e.id::text AND a.action = 'event.approve'
AND a."staffId" IS NOT NULL AND a."createdAt" >= e."updatedAt" AND e."moderationStatus" IN ('approved','sales_paused','hidden');
-- Keep event/order/ticket records and lifecycle status intact. Stop public exposure
-- and new sales for unverifiable legacy publications; do not cancel or refund orders.
UPDATE "Event" SET "moderationStatus" = 'pending', "moderationReason" = 'Требуется проверка текущей версии мероприятия.'
WHERE status = 'published' AND "approvedAt" IS NULL AND "moderationStatus" IN ('clear','approved','sales_paused');
INSERT INTO "Notification" (id,"userId","eventId",channel,type,payload,status,"sentAt")
SELECT gen_random_uuid(),"organizerId",id,'in_app','event.moderation',jsonb_build_object('action','review_required','text','Мероприятие «' || title || '» направлено на проверку. Действующие билеты сохранены.','organizerEvent',true),'sent',now()
FROM "Event" WHERE status='published' AND "approvedAt" IS NULL AND "moderationStatus"='pending';

CREATE FUNCTION invalidate_event_approval(event_id UUID) RETURNS void LANGUAGE sql AS $$
  UPDATE "Event" SET "approvedAt"=NULL,"approvedByStaffId"=NULL,"moderationStatus"='pending',"moderationReason"=NULL,"updatedAt"=now(),revision=revision+1
  WHERE id=event_id AND "approvedAt" IS NOT NULL AND status NOT IN ('cancelled','completed');
$$;
CREATE FUNCTION review_changed_event_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."approvedAt" IS NOT NULL AND OLD.status NOT IN ('cancelled','completed') AND
    (to_jsonb(NEW)-ARRAY['updatedAt','revision','status','publishedAt','moderationStatus','moderationReason','approvedAt','approvedByStaffId','salesPaused','v2State']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['updatedAt','revision','status','publishedAt','moderationStatus','moderationReason','approvedAt','approvedByStaffId','salesPaused','v2State']) THEN
    NEW."approvedAt":=NULL; NEW."approvedByStaffId":=NULL; NEW."moderationStatus":='pending'; NEW."moderationReason":=NULL; NEW.revision:=OLD.revision+1;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER event_content_requires_review BEFORE UPDATE ON "Event" FOR EACH ROW EXECUTE FUNCTION review_changed_event_content();

-- Cover alternate organizer resource/translation writers as well as the main editor.
-- Ignore inventory counters and routine sales-window/status changes.
CREATE FUNCTION review_changed_event_resource() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE data JSONB; event_id UUID; resource_id UUID; layout_id UUID;
BEGIN
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-TG_ARGV) IS NOT DISTINCT FROM (to_jsonb(OLD)-TG_ARGV) THEN RETURN NEW; END IF;
  IF TG_OP='DELETE' THEN data:=to_jsonb(OLD); ELSE data:=to_jsonb(NEW); END IF;
  -- Whole-table purchases create private admission ticket types. Those are
  -- fulfillment records, not changes to the approved public offer.
  IF TG_TABLE_NAME='TicketType' AND data->>'isInternal'='true' AND (TG_OP<>'UPDATE' OR to_jsonb(OLD)->>'isInternal'='true') THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
  END IF;
  IF TG_TABLE_NAME='TicketTypeContent' AND EXISTS(SELECT 1 FROM "TicketType" WHERE id=(data->>'ticketTypeId')::uuid AND "isInternal") THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
  END IF;
  event_id:=(data->>'eventId')::uuid;
  IF event_id IS NULL THEN
    layout_id:=(data->>'venueLayoutId')::uuid;
    IF layout_id IS NOT NULL THEN SELECT "eventId" INTO event_id FROM "VenueLayout" WHERE id=layout_id;
    ELSIF data ? 'ticketTypeId' THEN SELECT "eventId" INTO event_id FROM "TicketType" WHERE id=(data->>'ticketTypeId')::uuid;
    ELSIF data ? 'assetId' THEN SELECT "eventId" INTO event_id FROM "MediaAsset" WHERE id=(data->>'assetId')::uuid;
    ELSE
      resource_id:=COALESCE(data->>'tableId',data->>'rowId',data->>'tariffId')::uuid;
      IF data ? 'tableId' THEN SELECT "venueLayoutId" INTO layout_id FROM "Table" WHERE id=resource_id;
      ELSIF data ? 'rowId' THEN SELECT "venueLayoutId" INTO layout_id FROM "VenueRow" WHERE id=resource_id;
      ELSIF data ? 'tariffId' THEN SELECT "venueLayoutId" INTO layout_id FROM "HallTariff" WHERE id=resource_id; END IF;
      SELECT "eventId" INTO event_id FROM "VenueLayout" WHERE id=layout_id;
    END IF;
  END IF;
  PERFORM invalidate_event_approval(event_id);
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER event_translation_requires_review AFTER INSERT OR UPDATE OR DELETE ON "EventTranslation" FOR EACH ROW EXECUTE FUNCTION review_changed_event_resource('updatedAt');
CREATE TRIGGER event_text_requires_review AFTER INSERT OR UPDATE OR DELETE ON "EventContent" FOR EACH ROW EXECUTE FUNCTION review_changed_event_resource('updatedAt','revision');
CREATE TRIGGER event_media_requires_review AFTER INSERT OR UPDATE OR DELETE ON "EventMedia" FOR EACH ROW EXECUTE FUNCTION review_changed_event_resource();
CREATE TRIGGER event_caption_requires_review AFTER INSERT OR UPDATE OR DELETE ON "MediaAssetContent" FOR EACH ROW EXECUTE FUNCTION review_changed_event_resource('updatedAt','revision');
CREATE TRIGGER event_ticket_requires_review AFTER INSERT OR UPDATE OR DELETE ON "TicketType" FOR EACH ROW EXECUTE FUNCTION review_changed_event_resource('updatedAt','quantitySold','quantityReserved','status','salesStartAt','salesEndAt');
CREATE TRIGGER event_ticket_text_requires_review AFTER INSERT OR UPDATE OR DELETE ON "TicketTypeContent" FOR EACH ROW EXECUTE FUNCTION review_changed_event_resource('updatedAt','revision');
CREATE TRIGGER event_hall_requires_review AFTER INSERT OR UPDATE OR DELETE ON "VenueLayout" FOR EACH ROW EXECUTE FUNCTION review_changed_event_resource('updatedAt','revision');
CREATE TRIGGER event_table_requires_review AFTER INSERT OR UPDATE OR DELETE ON "Table" FOR EACH ROW EXECUTE FUNCTION review_changed_event_resource('updatedAt','status','holdExpiresAt','holdToken','holdRequestKey');
CREATE TRIGGER event_table_text_requires_review AFTER INSERT OR UPDATE OR DELETE ON "TableContent" FOR EACH ROW EXECUTE FUNCTION review_changed_event_resource('updatedAt','revision');
CREATE TRIGGER event_row_requires_review AFTER INSERT OR UPDATE OR DELETE ON "VenueRow" FOR EACH ROW EXECUTE FUNCTION review_changed_event_resource('updatedAt','status');
CREATE TRIGGER event_row_text_requires_review AFTER INSERT OR UPDATE OR DELETE ON "VenueRowContent" FOR EACH ROW EXECUTE FUNCTION review_changed_event_resource('updatedAt','revision');
CREATE TRIGGER event_seat_requires_review AFTER INSERT OR UPDATE OR DELETE ON "Seat" FOR EACH ROW EXECUTE FUNCTION review_changed_event_resource('updatedAt','status');
CREATE TRIGGER event_tariff_requires_review AFTER INSERT OR UPDATE OR DELETE ON "HallTariff" FOR EACH ROW EXECUTE FUNCTION review_changed_event_resource('updatedAt');
CREATE TRIGGER event_tariff_text_requires_review AFTER INSERT OR UPDATE OR DELETE ON "HallTariffContent" FOR EACH ROW EXECUTE FUNCTION review_changed_event_resource('updatedAt','revision');

CREATE OR REPLACE FUNCTION platform_order_sale_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ev "Event"%ROWTYPE; owner "User"%ROWTYPE; buyer "User"%ROWTYPE; commission integer; event_key text;
BEGIN
  IF NEW."buyerUserId" IS NOT NULL THEN
    SELECT * INTO buyer FROM "User" WHERE id=NEW."buyerUserId" FOR SHARE;
    IF buyer."blockedAt" IS NOT NULL THEN RAISE EXCEPTION 'ACCOUNT_RESTRICTED' USING ERRCODE='P0001'; END IF;
  ELSIF NEW."guestContact"->>'channel'='telegram' THEN
    SELECT * INTO buyer FROM "User" WHERE "telegramId"::text=NEW."guestContact"->>'telegramId' FOR SHARE;
    IF buyer."blockedAt" IS NOT NULL THEN RAISE EXCEPTION 'ACCOUNT_RESTRICTED' USING ERRCODE='P0001'; END IF;
  ELSIF NEW."guestContact"->>'channel'='email' THEN
    SELECT u.* INTO buyer FROM "User" u JOIN "ContactIdentity" c ON c."userId"=u.id WHERE c.method='email' AND c."normalizedIdentifier"=lower(NEW."guestContact"->>'email') FOR SHARE OF u;
    IF buyer."blockedAt" IS NOT NULL THEN RAISE EXCEPTION 'ACCOUNT_RESTRICTED' USING ERRCODE='P0001'; END IF;
  END IF;
  event_key:=NEW."checkoutSnapshot"->>'eventId';
  SELECT * INTO ev FROM "Event" WHERE id::text=event_key FOR SHARE;
  IF FOUND THEN
    SELECT * INTO owner FROM "User" WHERE id=ev."organizerId" FOR SHARE;
    IF owner."blockedAt" IS NOT NULL OR ev."approvedAt" IS NULL OR ev."salesPaused" OR ev."moderationStatus" <> 'approved' OR ev.status<>'published' THEN RAISE EXCEPTION 'EVENT_SALES_PAUSED' USING ERRCODE='P0001'; END IF;
    commission:=COALESCE(owner."commissionBps",(SELECT value FROM "PlatformSetting" WHERE key='commission.default'));
    NEW."commissionBps":=commission;
    NEW."commissionAmount":=CASE WHEN commission IS NULL THEN NULL ELSE floor(NEW.amount::bigint*commission/10000.0)::integer END;
  END IF;
  RETURN NEW;
END $$;
