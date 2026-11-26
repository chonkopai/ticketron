-- Staff TOTP failures are counted per account across sessions; 5 in a row lock verification for 15 minutes.
ALTER TABLE "StaffAccount"
  ADD COLUMN "totpFailedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "totpLockedUntil" TIMESTAMPTZ(3);
