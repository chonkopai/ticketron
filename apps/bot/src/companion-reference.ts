import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { BotConversationRef } from "@event-platform/shared-types";
import type { CheckoutActor } from "./api-client.js";

export const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export type ComposeScope = { kind: "order" | "inquiry" | "event" | "lookup"; side: "guest" | "organizer"; id: string };
const validity = 20 * 60;

export function threadData(ref: BotConversationRef, page = 1, eventId?: string) {
  // The optional event scope is for Back navigation only. The API checks the actual order.
  return `c:t:${ref.side === "guest" ? "g" : "a"}:${ref.kind === "order" ? "o" : "i"}:${eventId ? compactId(ref.id) + ":" + compactId(eventId) : ref.id}:${page}`;
}
export function compactId(id: string) { return Buffer.from(id.replaceAll("-", ""), "hex").toString("base64url"); }
export function expandId(input: string | undefined) {
  if (!input || !/^[A-Za-z0-9_-]{22}$/.test(input)) return null;
  const hex = Buffer.from(input, "base64url").toString("hex");
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return uuid.test(id) && compactId(id) === input ? id : null;
}
export function parseThread(side: string | undefined, kind: string | undefined, id: string | undefined): BotConversationRef | null {
  if ((side !== "g" && side !== "a") || (kind !== "o" && kind !== "i") || !id || !uuid.test(id)) return null;
  return { side: side === "g" ? "guest" : "organizer", kind: kind === "o" ? "order" : "inquiry", id };
}

export function signIntent(secret: string, actor: CheckoutActor, action: string, scope: string) {
  const expiresAt = (Math.floor(Date.now() / 1000) + validity).toString(36);
  const nonce = randomBytes(4).toString("base64url");
  const data = `${expiresAt}.${nonce}`;
  return `${data}.${signature(secret, actor, action, scope, data)}`;
}

export function verifyIntent(secret: string, actor: CheckoutActor, action: string, scope: string, intent: string) {
  const match = /^([a-z0-9]{6,7})\.([A-Za-z0-9_-]{6})\.([A-Za-z0-9_-]{11})$/.exec(intent);
  if (!match) return false;
  const time = Math.floor(Date.now() / 1000), expiresAt = Number.parseInt(match[1]!, 36);
  if (expiresAt <= time || expiresAt > time + validity) return false;
  const expected = signature(secret, actor, action, scope, `${match[1]}.${match[2]}`);
  return timingSafeEqual(Buffer.from(expected), Buffer.from(match[3]!));
}

export function requestId(parts: string[]) {
  const hash = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function signature(secret: string, actor: CheckoutActor, action: string, scope: string, data: string) {
  return createHmac("sha256", secret).update(JSON.stringify(["ticketron-companion", actor.telegramId, actor.chatId, action, scope, data])).digest().subarray(0, 8).toString("base64url");
}
