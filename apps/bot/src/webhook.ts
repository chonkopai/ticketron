import { timingSafeEqual } from "node:crypto";

export function verifyTelegramWebhookSecret(provided: string | undefined, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export const TELEGRAM_ALLOWED_UPDATES = ["message", "callback_query"] as const;

export function parseTelegramUpdate(raw: Buffer): { update_id: number } | null {
  try {
    const value: unknown = JSON.parse(raw.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const { update_id } = value as { update_id?: unknown };
    if (typeof update_id !== "number" || !Number.isSafeInteger(update_id) || update_id < 0) return null;
    return value as { update_id: number };
  } catch {
    return null;
  }
}
