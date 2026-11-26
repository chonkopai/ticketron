import { randomBytes } from "node:crypto";
import { prisma } from "@event-platform/database";

import { secretHash } from "../orders/anonymous.service.js";

/**
 * Test-only fixture: an account-free checkout session bound to a private Telegram chat that the
 * bot has already verified. Production creates these through the bot offer flow.
 */
export async function verifiedQuickSession(name: string, telegramId: string, now = new Date(), sessionSeconds = 600, accessSeconds = 3600) {
  const sessionToken = randomBytes(32).toString("base64url"), accessToken = randomBytes(32).toString("base64url");
  const session = await prisma.anonymousCheckoutSession.create({ data: {
    name, sessionHash: secretHash(sessionToken), accessHash: secretHash(accessToken),
    telegramId: BigInt(telegramId), chatId: BigInt(telegramId),
    expiresAt: new Date(now.getTime() + sessionSeconds * 1000),
    accessExpiresAt: new Date(now.getTime() + accessSeconds * 1000),
  } });
  return { sessionToken, accessToken, expiresAt: session.expiresAt.toISOString(), accessExpiresAt: session.accessExpiresAt.toISOString() };
}
