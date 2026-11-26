import { Prisma, type PrismaClient } from "@event-platform/database";
import { loadApiEnv } from "@event-platform/config";
import type { BotConversationInbox, BotConversationPage, BotConversationRef, BotConversationSide, BotConversationSummary } from "@event-platform/shared-types";
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { DATABASE_CLIENT } from "../auth/auth.constants.js";
import { EventChatService, presentChatMessage, type EventChatParticipant } from "../events/event-chat.service.js";
import { queueConversationAlert } from "../events/conversation-alert.js";
import { publicEventWhere } from "../events/event-moderation-policy.js";
import { readPrivateUpload } from "../staff/support-files.js";
import { botOrganizer } from "./bot-organizer-access.js";
import { botPurchaseActor } from "./bot-purchase-access.js";

const INBOX_SIZE = 6;
const HISTORY_SIZE = 2;
const hour = 3_600_000;
const day = 24 * hour;
const missing = () => new NotFoundException({ code: "CONVERSATION_NOT_FOUND" });
const inquirySelect = {
  id: true, eventId: true, guestTelegramId: true, closedAt: true,
  event: { select: { organizerId: true, title: true } },
} as const;
type Inquiry = Prisma.EventInquiryGetPayload<{ select: typeof inquirySelect }>;
type Actor = { userId: string | null; recipient: bigint };

@Injectable()
export class BotConversationsService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly db: PrismaClient,
    @Inject(EventChatService) private readonly orderChat: EventChatService,
  ) {}

  async inbox(telegramId: string, chatId: string, side: BotConversationSide, page: number, eventId?: string): Promise<BotConversationInbox> {
    const actor = await this.actor(telegramId, chatId, side);
    if (eventId && (side !== "organizer" || !await this.db.event.findFirst({ where: { id: eventId, organizerId: actor.userId! }, select: { id: true } }))) throw missing();
    const scope = side === "organizer" ? Prisma.sql`e."organizerId" = ${actor.userId}::uuid` : Prisma.sql`(
      (o.id IS NOT NULL AND (o."buyerUserId" = ${actor.userId}::uuid OR
        (o."buyerUserId" IS NULL AND a."telegramId" = ${actor.recipient} AND a."chatId" = ${actor.recipient})))
      OR i."guestTelegramId" = ${actor.recipient}
    )`;
    const rows = await this.db.$queryRaw<Array<Omit<BotConversationSummary, "side">>>`
      SELECT COALESCE(m."orderId", m."inquiryId") AS id,
        CASE WHEN m."orderId" IS NULL THEN 'inquiry' ELSE 'order' END AS kind,
        e.id AS "eventId", e.title, (i."closedAt" IS NOT NULL) AS closed,
        COUNT(*) FILTER (WHERE m."readAt" IS NULL AND m.sender::text <> ${side})::int AS unread
      FROM "ChatMessage" m JOIN "Event" e ON e.id = m."eventId"
      LEFT JOIN "Order" o ON o.id = m."orderId"
      LEFT JOIN "AnonymousCheckoutSession" a ON a."orderId" = o.id
      LEFT JOIN "EventInquiry" i ON i.id = m."inquiryId" AND i."eventId" = e.id
      WHERE NOT m.internal AND (o.id IS NOT NULL OR i.id IS NOT NULL) AND ${scope}
        ${eventId ? Prisma.sql`AND e.id = ${eventId}::uuid` : Prisma.empty}
      GROUP BY m."orderId", m."inquiryId", e.id, e.title, i."closedAt"
      ORDER BY MAX(m."createdAt") DESC, COALESCE(m."orderId", m."inquiryId") DESC
      LIMIT ${INBOX_SIZE + 1} OFFSET ${(page - 1) * INBOX_SIZE}
    `;
    return { items: rows.slice(0, INBOX_SIZE).map(row => ({ ...row, side })), hasNext: rows.length > INBOX_SIZE };
  }

  async forEvent(telegramId: string, chatId: string, eventId: string) {
    const actor = await this.actor(telegramId, chatId, "guest");
    const existing = await this.db.eventInquiry.findUnique({
      where: { eventId_guestTelegramId: { eventId, guestTelegramId: actor.recipient } }, select: { id: true },
    });
    if (existing) return { threadId: existing.id };
    await this.publicEvent(this.db, eventId);
    return { threadId: null };
  }

  async open(telegramId: string, chatId: string, ref: BotConversationRef, page: number): Promise<BotConversationPage> {
    const actor = await this.actor(telegramId, chatId, ref.side);
    if (ref.kind === "order") {
      const participant = orderParticipant(ref.side, actor);
      const scope = await this.orderChat.authorize(undefined, ref.id, participant);
      const history = await this.orderChat.list(scope.eventId, ref.id, participant, undefined, { page, limit: HISTORY_SIZE });
      if (page === 1) await this.orderChat.markRead(scope.eventId, ref.id, participant);
      return { thread: { ...ref, eventId: scope.eventId, title: scope.title, closed: false, unread: 0 }, ...history };
    }
    const inquiry = await this.inquiry(this.db, ref.id, ref.side, actor);
    const where = { inquiryId: ref.id, eventId: inquiry.eventId, internal: false };
    const rows = await this.db.chatMessage.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * HISTORY_SIZE, take: HISTORY_SIZE + 1, include: { files: { select: { id: true, name: true, mime: true, size: true } } } });
    const items = rows.slice(0, HISTORY_SIZE);
    if (page === 1) await this.db.chatMessage.updateMany({
      where: { ...where, readAt: null, sender: opposite(ref.side), ...(rows[0] ? { createdAt: { lte: rows[0].createdAt } } : { id: { in: [] } }) },
      data: { readAt: new Date() },
    });
    return { thread: { ...ref, eventId: inquiry.eventId, title: inquiry.event.title, closed: !!inquiry.closedAt, unread: 0 },
      nextCursor: rows.length > HISTORY_SIZE ? items.at(-1)!.id : null, items: items.reverse().map(presentChatMessage) };
  }

  async send(telegramId: string, chatId: string, ref: BotConversationRef | { kind: "event"; id: string; side: "guest" }, raw: string, requestKey: string) {
    const actor = await this.actor(telegramId, chatId, ref.side);
    const text = raw.trim();
    if (!text || text.length > 2000) throw new BadRequestException({ code: "CHAT_TEXT_INVALID" });
    if (ref.kind === "order") {
      const participant = orderParticipant(ref.side, actor);
      const scope = await this.orderChat.authorize(undefined, ref.id, participant);
      await this.orderChat.send(scope.eventId, ref.id, participant, text, requestKey);
      return { kind: "order" as const, id: ref.id };
    }
    return this.db.$transaction(async tx => {
      if (ref.side === "guest") await lock(tx, `inquiry-guest:${actor.recipient}`);
      let inquiry = ref.kind === "inquiry" ? await this.inquiry(tx, ref.id, ref.side, actor) :
        await tx.eventInquiry.findUnique({ where: { eventId_guestTelegramId: { eventId: ref.id, guestTelegramId: actor.recipient } }, select: inquirySelect });
      if (!inquiry) {
        await this.publicEvent(tx, ref.id);
        const now = Date.now();
        const recent = await tx.eventInquiry.findMany({
          where: { guestTelegramId: actor.recipient, createdAt: { gte: new Date(now - day) } },
          orderBy: { createdAt: "desc" }, take: 12, select: { createdAt: true },
        });
        if (recent.length >= 12 || recent.filter(row => row.createdAt.getTime() >= now - hour).length >= 4) {
          throw new ConflictException({ code: "CHAT_RATE_LIMITED" });
        }
        inquiry = await tx.eventInquiry.create({ data: { eventId: ref.id, guestTelegramId: actor.recipient }, select: inquirySelect });
      }
      await lock(tx, `inquiry:${inquiry.id}`);
      inquiry = await this.inquiry(tx, inquiry.id, ref.side, actor);
      const previous = await tx.chatMessage.findUnique({ where: { clientMessageId: requestKey }, select: { inquiryId: true, text: true, sender: true } });
      if (previous) {
        if (previous.inquiryId !== inquiry.id || previous.sender !== ref.side || previous.text !== text) throw new ConflictException({ code: "CHAT_REQUEST_KEY_CHANGED" });
        return { kind: "inquiry" as const, id: inquiry.id };
      }
      if (inquiry.closedAt) throw new ConflictException({ code: "INQUIRY_CLOSED" });
      const now = Date.now();
      const recent = await tx.chatMessage.count({ where: { inquiryId: inquiry.id, sender: ref.side, createdAt: { gte: new Date(now - 10_000) } } });
      const hourly = await tx.chatMessage.count({ where: {
        sender: ref.side, createdAt: { gte: new Date(now - hour) },
        ...(ref.side === "guest" ? { inquiry: { guestTelegramId: actor.recipient } } : { inquiryId: inquiry.id }),
      } });
      if (recent || hourly >= 20) throw new ConflictException({ code: "CHAT_RATE_LIMITED" });
      const message = await tx.chatMessage.create({ data: {
        eventId: inquiry.eventId, inquiryId: inquiry.id, organizerId: inquiry.event.organizerId,
        ...(ref.side === "guest" && actor.userId ? { guestUserId: actor.userId } : {}), sender: ref.side, text, clientMessageId: requestKey,
      }, select: { id: true } });
      await queueConversationAlert(tx, {
        messageId: message.id, recipientUserId: ref.side === "guest" ? inquiry.event.organizerId : null,
        ...(ref.side === "organizer" ? { anonymousTelegramId: inquiry.guestTelegramId } : {}),
        thread: { kind: "inquiry", side: opposite(ref.side), id: inquiry.id },
      });
      await tx.auditLog.create({ data: { actorId: actor.userId, action: "chat.inquiry_message_sent", entityType: "event_inquiry", entityId: inquiry.id, meta: { messageId: message.id, sender: ref.side, eventId: inquiry.eventId } } });
      return { kind: "inquiry" as const, id: inquiry.id };
    });
  }

  async close(telegramId: string, chatId: string, id: string) {
    const actor = await this.actor(telegramId, chatId, "organizer");
    return this.db.$transaction(async tx => {
      await this.inquiry(tx, id, "organizer", actor);
      await lock(tx, `inquiry:${id}`);
      const changed = await tx.eventInquiry.updateMany({ where: { id, closedAt: null, event: { organizerId: actor.userId! } }, data: { closedAt: new Date() } });
      if (changed.count) await tx.auditLog.create({ data: { actorId: actor.userId, action: "chat.inquiry_closed", entityType: "event_inquiry", entityId: id } });
      return { closed: true };
    });
  }

  async attachment(telegramId: string, chatId: string, side: BotConversationSide, id: string) {
    const actor = await this.actor(telegramId, chatId, side);
    const row = await this.db.privateUpload.findFirst({
      where: { id, chatMessage: { internal: false, orderId: { not: null } } },
      select: { name: true, mime: true, storageKey: true, chatMessage: { select: { eventId: true, orderId: true } } },
    });
    if (!row?.chatMessage?.orderId) throw missing();
    await this.orderChat.authorize(row.chatMessage.eventId, row.chatMessage.orderId, orderParticipant(side, actor));
    return readPrivateUpload(loadApiEnv().PRIVATE_SUPPORT_STORAGE_DIR, row).catch(() => { throw missing(); });
  }

  private async actor(telegramId: string, chatId: string, side: BotConversationSide): Promise<Actor> {
    if (side === "organizer") return { userId: await botOrganizer(this.db, telegramId, chatId), recipient: BigInt(telegramId) };
    return botPurchaseActor(this.db, telegramId, chatId);
  }

  private async inquiry(db: Prisma.TransactionClient, id: string, side: BotConversationSide, actor: Actor): Promise<Inquiry> {
    const row = await db.eventInquiry.findFirst({ where: { id,
      ...(side === "organizer" ? { event: { organizerId: actor.userId! } } : { guestTelegramId: actor.recipient }),
    }, select: inquirySelect });
    if (!row) throw missing();
    return row;
  }

  private async publicEvent(db: Prisma.TransactionClient, id: string) {
    const row = await db.event.findFirst({ where: { id, ...publicEventWhere }, select: { id: true } });
    if (!row) throw missing();
  }
}

function opposite(side: BotConversationSide): BotConversationSide { return side === "guest" ? "organizer" : "guest"; }
function orderParticipant(side: BotConversationSide, actor: Actor): EventChatParticipant {
  return { kind: side, ...(actor.userId ? { userId: actor.userId } : {}),
    ...(side === "guest" ? { telegramRecipient: actor.recipient } : {}) };
}
async function lock(tx: Prisma.TransactionClient, key: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}
