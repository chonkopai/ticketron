CREATE TABLE "EventInquiry" (
  "id" UUID NOT NULL,
  "eventId" UUID NOT NULL REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "guestTelegramId" BIGINT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closedAt" TIMESTAMPTZ(3),
  PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EventInquiry_eventId_guestTelegramId_key" ON "EventInquiry"("eventId", "guestTelegramId");
CREATE INDEX "EventInquiry_guestTelegramId_createdAt_idx" ON "EventInquiry"("guestTelegramId", "createdAt");
ALTER TABLE "ChatMessage" ADD COLUMN "inquiryId" UUID REFERENCES "EventInquiry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "ChatMessage_inquiryId_createdAt_id_idx" ON "ChatMessage"("inquiryId", "createdAt", "id");
ALTER TABLE "ChatMessage" DROP CONSTRAINT "ChatMessage_guest_identity_check";
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_guest_identity_check" CHECK (
  "guestUserId" IS NOT NULL OR "guestContact" IS NOT NULL OR "anonymousSessionId" IS NOT NULL OR "inquiryId" IS NOT NULL
);
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_inquiry_scope_check" CHECK (
  "inquiryId" IS NULL OR ("orderId" IS NULL AND "anonymousSessionId" IS NULL AND NOT "internal" AND "sender" IN ('guest', 'organizer'))
);
