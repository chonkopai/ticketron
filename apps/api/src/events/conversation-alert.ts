import type { Prisma } from "@event-platform/database";
import type { BotConversationRef } from "@event-platform/shared-types";

export const CONVERSATION_ALERT = "chat.telegram_alert";

export async function queueConversationAlert(
  tx: Prisma.TransactionClient,
  input: { messageId: string; recipientUserId: string | null; anonymousTelegramId?: bigint | null; thread: BotConversationRef },
) {
  if (input.thread.side === "guest" && process.env.TELEGRAM_BOT_MESSAGES_ENABLED === "false") return;
  const user = input.recipientUserId ? await tx.user.findUnique({
    where: { id: input.recipientUserId },
    select: { telegramChatId: true, telegramId: true, blockedAt: true, role: true },
  }) : null;
  if (input.recipientUserId && (!user || user.blockedAt || !user.telegramId || user.telegramId !== user.telegramChatId)) return;
  if (user && input.thread.side === "organizer" && user.role !== "organizer" && user.role !== "admin") return;
  const chatId = user?.telegramChatId ?? input.anonymousTelegramId;
  if (!chatId) return;
  if (!user && await tx.user.findFirst({ where: { telegramId: chatId, blockedAt: { not: null } }, select: { id: true } })) return;

  const settings = await tx.telegramGuestPreference.findUnique({ where: { telegramId: chatId }, select: { locale: true } });
  const locale = settings?.locale === "kk" || settings?.locale === "en" ? settings.locale : "ru";
  const [text, label] = alerts[locale];
  const { side, kind, id } = input.thread;
  const start = `c_${side === "guest" ? "g" : "a"}_${kind === "order" ? "o" : "i"}_${id}`;
  await tx.notification.create({ data: {
    userId: input.recipientUserId, telegramId: chatId, channel: "telegram", type: CONVERSATION_ALERT,
    dedupeKey: `telegram:chat:${input.messageId}`, payload: { text, label, start, messageId: input.messageId }, nextAttemptAt: new Date(),
  } });
}

const alerts = {
  ru: ["У вас новое сообщение в Ticketron.", "Открыть переписку"],
  kk: ["Ticketron-да жаңа хабарлама бар.", "Сөйлесуді ашу"],
  en: ["You have a new message in Ticketron.", "Open conversation"],
} as const;

export async function conversationAlertCurrent(db: Prisma.TransactionClient, input: {
  userId: string | null; telegramId: bigint; messageId: string; start: string;
}) {
  const message = await db.chatMessage.findFirst({
    where: { id: input.messageId, readAt: null, internal: false },
    select: {
      sender: true, orderId: true, inquiryId: true,
      event: { select: { organizerId: true } },
      inquiry: { select: { guestTelegramId: true } },
      order: { select: { buyerUserId: true, anonymousSession: { select: { telegramId: true, chatId: true } } } },
    },
  });
  if (!message || message.sender === "support") return false;
  const id = message.orderId ?? message.inquiryId;
  if (!id) return false;
  const organizer = message.sender === "guest";
  if (!organizer && process.env.TELEGRAM_BOT_MESSAGES_ENABLED === "false") return false;
  const expected = `c_${organizer ? "a" : "g"}_${message.orderId ? "o" : "i"}_${id}`;
  if (expected !== input.start) return false;
  const currentId = organizer ? message.event.organizerId : message.order?.buyerUserId ?? null;
  const user = await db.user.findUnique({
    where: { telegramId: input.telegramId }, select: { id: true, telegramChatId: true, blockedAt: true, role: true },
  });
  if (user?.blockedAt) return false;
  if (currentId) {
    return user?.id === currentId && input.userId === currentId && user.telegramChatId === input.telegramId &&
      (!organizer || user.role === "organizer" || user.role === "admin");
  }
  const anonymous = message.order?.anonymousSession;
  return !input.userId && (message.inquiry?.guestTelegramId === input.telegramId ||
    (anonymous?.chatId === input.telegramId && anonymous.telegramId === input.telegramId));
}
