ALTER TYPE "ChatSender" ADD VALUE 'support';
ALTER TABLE "ChatMessage" ADD COLUMN "internal" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "staffId" UUID;
ALTER TABLE "PlatformCase" ADD COLUMN "requesterKind" VARCHAR(20);
-- Verification applications provide reliable historical organizer context.
UPDATE "PlatformCase" SET "requesterKind" = 'organizer' WHERE id IN (SELECT "caseId" FROM "OrganizerVerification");
-- An owned purchase is reliable historical customer context, regardless of global role.
UPDATE "PlatformCase" AS c SET "requesterKind" = 'customer' FROM "Order" AS o
WHERE c."orderId" = o.id AND c."ownerId" = o."buyerUserId" AND c."requesterKind" IS NULL;
ALTER TABLE "PrivateUpload" ADD COLUMN "chatMessageId" UUID;
ALTER TABLE "PrivateUpload" ADD CONSTRAINT "PrivateUpload_chatMessageId_fkey" FOREIGN KEY ("chatMessageId") REFERENCES "ChatMessage"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "PrivateUpload_chatMessageId_idx" ON "PrivateUpload"("chatMessageId");
