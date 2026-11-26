CREATE TABLE "HomepageAdvertisement" (
  "eventId" UUID NOT NULL PRIMARY KEY REFERENCES "Event"(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK(position >= 0),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "HomepageAdvertisement_position_eventId_idx" ON "HomepageAdvertisement"(position,"eventId");
