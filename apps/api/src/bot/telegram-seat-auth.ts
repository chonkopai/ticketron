import { createHmac, timingSafeEqual } from "node:crypto";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";

const MAX_AGE_SECONDS = 300;
const CLOCK_SKEW_SECONDS = 30;
export const TELEGRAM_SEAT_SESSION_MS = 30 * 60 * 1000;
export const seatUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export function verifyTelegramSeatLaunch(raw: unknown, token: string, now: Date) {
  const invalid = () => new UnauthorizedException({ code: "TELEGRAM_SEAT_LAUNCH_INVALID" });
  if (typeof raw !== "string" || !raw.length || raw.length > 8192) throw invalid();

  const data = new URLSearchParams(raw);
  const fields = [...data.keys()];
  const hash = data.get("hash");
  if (new Set(fields).size !== fields.length || !hash || !/^[a-f0-9]{64}$/.test(hash) ||
      fields.some(key => !/^[a-z0-9_]+$/.test(key) || /[\r\n]/.test(data.get(key)!))) throw invalid();
  const check = fields.filter(key => key !== "hash").sort().map(key => `${key}=${data.get(key)}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const expected = createHmac("sha256", secret).update(check).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, "hex"))) throw invalid();

  const authDate = data.get("auth_date");
  const age = Math.floor(now.getTime() / 1000) - Number(authDate);
  if (!authDate || !/^\d{1,12}$/.test(authDate) || age > MAX_AGE_SECONDS || age < -CLOCK_SKEW_SECONDS) throw invalid();

  const event = data.get("start_param");
  if (!event?.startsWith("s_") || !seatUuid.test(event.slice(2))) throw invalid();
  const chat = data.get("chat_type");
  if (chat !== "private" && chat !== "sender") throw new ForbiddenException({ code: "BOT_PRIVATE_CHAT_REQUIRED" });
  let user: { id?: unknown; language_code?: unknown } | null;
  try { user = JSON.parse(data.get("user") ?? "null"); } catch { throw invalid(); }
  const id = user?.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) throw invalid();
  return {
    launchHash: hash, telegramId: String(id), eventId: event.slice(2).toLowerCase(),
    language: typeof user?.language_code === "string" ? user.language_code.split("-")[0]?.toLowerCase() : undefined,
  };
}
