import type { Prisma, PrismaClient } from "@event-platform/database";
import { BadRequestException, ForbiddenException } from "@nestjs/common";

export type BotPurchaseActor = { recipient: bigint; userId: string | null };

const INT64_MAX = 9223372036854775807n;

/** A Telegram user id: canonical positive decimal within int64 (the Telegram/Prisma BigInt range). Null otherwise. */
export function parseTelegramUserId(value: string): bigint | null {
  if (!/^[1-9]\d{0,18}$/.test(value)) return null;
  const id = BigInt(value);
  return id <= INT64_MAX ? id : null;
}

/** Private-chat actor: the user id and chat id must be the same valid user id. Null otherwise. */
export function parsePrivateChatActor(telegramId: string, chatId: string): bigint | null {
  return telegramId === chatId ? parseTelegramUserId(telegramId) : null;
}

/** Throwing form of parsePrivateChatActor for request handlers. */
export function requirePrivateChatActor(telegramId: string, chatId: string): bigint {
  const id = parsePrivateChatActor(telegramId, chatId);
  if (id === null) throw new BadRequestException({ code: "BOT_PRIVATE_CHAT_REQUIRED" });
  return id;
}

export async function botPurchaseActor(db: PrismaClient, telegramId: string, chatId: string): Promise<BotPurchaseActor> {
  const recipient = requirePrivateChatActor(telegramId, chatId);
  const user = await db.user.findUnique({ where: { telegramId: recipient }, select: { id: true, blockedAt: true, telegramChatId: true } });
  if (user?.blockedAt) throw new ForbiddenException({ code: "ACCOUNT_RESTRICTED" });
  return { recipient, userId: user?.telegramChatId === recipient ? user.id : null };
}

export function recipientWhere(actor: BotPurchaseActor) {
  return { telegramId: actor.recipient, chatId: actor.recipient };
}

export function botOrderScope(actor: BotPurchaseActor): Prisma.OrderWhereInput {
  return { OR: [
    { buyerUserId: null, anonymousSession: recipientWhere(actor) },
    ...(actor.userId ? [{ buyerUserId: actor.userId }] : []),
  ] };
}
