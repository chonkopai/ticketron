import type { PrismaClient } from "@event-platform/database";
import { ForbiddenException } from "@nestjs/common";
import { botPurchaseActor } from "./bot-purchase-access.js";

export async function botOrganizer(db: PrismaClient, telegramId: string, chatId: string) {
  if (process.env.TELEGRAM_BOT_ORGANIZER_ENABLED === "false") throw new ForbiddenException({ code: "BOT_ORGANIZER_REQUIRED" });
  const actor = await botPurchaseActor(db, telegramId, chatId);
  const organizer = actor.userId && await db.user.findFirst({
    where: { id: actor.userId, blockedAt: null, role: { in: ["organizer", "admin"] }, telegramId: actor.recipient, telegramChatId: actor.recipient },
    select: { id: true },
  });
  if (!organizer) throw new ForbiddenException({ code: "BOT_ORGANIZER_REQUIRED" });
  return organizer.id;
}
