-- Checkout can materialize legacy, non-saleable admissions from already approved
-- whole-table capacity. Organizer seat edits still use the regular review trigger.
DROP TRIGGER event_seat_requires_review ON "Seat";
CREATE TRIGGER event_seat_requires_review AFTER UPDATE OR DELETE ON "Seat"
  FOR EACH ROW EXECUTE FUNCTION review_changed_event_resource('updatedAt','status');
CREATE TRIGGER event_seat_insert_requires_review AFTER INSERT ON "Seat"
  FOR EACH ROW WHEN (
    NEW."tableId" IS NULL OR NEW."ticketTypeId" IS NOT NULL OR NEW."rowId" IS NOT NULL
    OR NEW.status <> 'available'
    OR COALESCE(current_setting('ticketron.whole_table_admission', true), '') <> NEW."tableId"::text
  ) EXECUTE FUNCTION review_changed_event_resource('updatedAt','status');

CREATE OR REPLACE FUNCTION event_v2_resource_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE data jsonb; eid uuid;
BEGIN
  data := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  IF TG_TABLE_NAME = 'TicketType' AND data->>'isInternal' = 'true'
    AND (TG_OP <> 'UPDATE' OR to_jsonb(OLD)->>'isInternal' = 'true') THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'Seat' AND TG_OP = 'INSERT' AND data->>'tableId' IS NOT NULL
    AND data->>'ticketTypeId' IS NULL AND data->>'rowId' IS NULL AND data->>'status' = 'available'
    AND current_setting('ticketron.whole_table_admission', true) = data->>'tableId' THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME IN ('TicketType','EventTranslation','VenueLayout') THEN
    eid := (data->>'eventId')::uuid;
  ELSE
    SELECT "eventId" INTO eid FROM "VenueLayout" WHERE id = (data->>'venueLayoutId')::uuid;
  END IF;
  UPDATE "Event" SET "v2State" = 'dirty', "legacyFingerprint" = NULL, revision = revision + 1 WHERE id = eid;
  RETURN NULL;
END $$;
