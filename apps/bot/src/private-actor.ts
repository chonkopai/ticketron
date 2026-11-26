import type { CheckoutActor } from "./api-client.js";

type ActorContext = { chat?: { type: string; id: number } | undefined; from?: { id: number } | undefined };

/** The Telegram user as a checkout actor, only in their own private chat (chat id equals user id). */
export function privateActor(ctx: ActorContext): CheckoutActor | null {
  if (ctx.chat?.type !== "private" || !ctx.from || ctx.from.id !== ctx.chat.id) return null;
  return { telegramId: String(ctx.from.id), chatId: String(ctx.chat.id) };
}
