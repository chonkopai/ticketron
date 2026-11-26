CREATE TABLE "TelegramGuestPreference" (
  "telegramId" BIGINT PRIMARY KEY,
  "locale" VARCHAR(2),
  "locationSet" BOOLEAN NOT NULL DEFAULT false,
  "city" VARCHAR(120),
  "countryCode" VARCHAR(2),
  CONSTRAINT "TelegramGuestPreference_locale_check" CHECK ("locale" IN ('ru', 'kk', 'en'))
);
