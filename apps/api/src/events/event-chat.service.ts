import { Prisma, type PrismaClient } from "@event-platform/database";
import { ForbiddenException, BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { DATABASE_CLIENT } from "../auth/auth.constants.js";
import { claimFiles, sameFiles } from "../staff/support-files.js";
import { secretHash } from "../orders/anonymous.service.js";
import { capabilityStillValid } from "../orders/access-expiry.js";

import { queueConversationAlert } from "./conversation-alert.js";
import { orderSoleEventId } from "./order-event.js";

export type EventChatParticipant = { kind: "organizer" | "guest"; userId?: string; accessToken?: string; telegramRecipient?: bigint };
const messageSelect = { id: true, sender: true, text: true, createdAt: true, readAt: true, files: { select: { id: true, name: true, mime: true, size: true } } } as const;

export function presentChatMessage(row: Prisma.ChatMessageGetPayload<{ select: typeof messageSelect }>) {
  return { id: row.id, sender: row.sender, text: row.text, createdAt: row.createdAt.toISOString(), files: row.files, readAt: row.readAt?.toISOString() ?? null };
}

@Injectable()
export class EventChatService {
  constructor(@Inject(DATABASE_CLIENT) private readonly db: PrismaClient) {}

  async list(eventId: string, orderId: string, participant: EventChatParticipant, before?: string, window?: { page: number; limit: number }) {
    await this.authorize(eventId, orderId, participant);
    const cursor = before ? await this.db.chatMessage.findFirst({ where: { id: before, orderId, eventId, internal: false }, select: { id: true, createdAt: true } }) : null;
    if (before && !cursor) throw new BadRequestException({ code: "CHAT_CURSOR_INVALID" });
    const limit = window?.limit ?? 30;
    const rows = await this.db.chatMessage.findMany({ where: { eventId, orderId, internal: false, ...(cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {}) }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: window ? (window.page - 1) * limit : 0, take: limit + 1, select: messageSelect });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return { items: page.reverse().map(presentChatMessage), nextCursor: hasMore ? page[0]?.id ?? null : null };
  }

  async send(eventId: string, orderId: string, participant: EventChatParticipant, raw: string, requestKey: string, fileIds: string[] = []) {
    if (fileIds.length > 5 || new Set(fileIds).size !== fileIds.length) throw new BadRequestException({ code: "ATTACHMENT_LIMIT" });
    const text = raw.trim();
    if (!text || text.length > 2000) throw new BadRequestException({ code: "CHAT_TEXT_INVALID" });
    const { organizerId, guestUserId, anonymousSessionId, uploadAnonymousSessionId, anonymousTelegramId } = await this.authorize(eventId, orderId, participant);
    const sender = participant.kind;
    const existing = await this.db.chatMessage.findUnique({ where: { clientMessageId: requestKey }, select: { id: true, eventId: true, orderId: true, sender: true, text: true, createdAt: true, readAt: true, files: { select: { id: true, name: true, mime: true, size: true } } } });
    if (existing) return sameMessage(existing, eventId, orderId, sender, text, fileIds);
    try {
      const row = await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`chat:${orderId}:${sender}`}))`;
      const prior = await tx.chatMessage.findUnique({ where: { clientMessageId: requestKey }, select: { id: true, eventId: true, orderId: true, sender: true, text: true, createdAt: true, readAt: true, files: { select: { id: true, name: true, mime: true, size: true } } } });
      if (prior) return prior;
      const recent = await tx.chatMessage.findFirst({ where: { orderId, sender, createdAt: { gte: new Date(Date.now() - 10_000) } }, select: { id: true } });
      if (recent) throw new ConflictException({ code: "CHAT_RATE_LIMITED" });
      const hourly = await tx.chatMessage.count({ where: { orderId, sender, createdAt: { gte: new Date(Date.now() - 3_600_000) } } });
      if (hourly >= 20) throw new ConflictException({ code: "CHAT_RATE_LIMITED" });
      const files = await tx.privateUpload.findMany({ where: { id: { in: fileIds }, messageId: null, chatMessageId: null, verificationId: null, caseId: null,
        ...(participant.userId ? { ownerId: participant.userId } : { anonymousSessionId: uploadAnonymousSessionId }) } });
      if (files.length !== fileIds.length) throw new ForbiddenException({ code: "ATTACHMENT_NOT_OWNED" });
      const saved = await tx.chatMessage.create({ data: { eventId, orderId, clientMessageId: requestKey, organizerId, guestUserId, anonymousSessionId, sender, text }, select: { id: true, eventId: true, orderId: true, sender: true, text: true, createdAt: true, readAt: true, files: { select: { id: true, name: true, mime: true, size: true } } } });
      await claimFiles(tx, fileIds, { chatMessageId: saved.id });
      saved.files = files.map(({ id, name, mime, size }) => ({ id, name, mime, size }));
      const recipientId = sender === "guest" ? organizerId : guestUserId;
      if (recipientId) await tx.notification.create({ data: {
        userId: recipientId, eventId, channel: "in_app", status: "sent", type: `chat.${sender}`,
        dedupeKey: `chat:${saved.id}`, payload: { text: sender === "guest" ? "Новое сообщение покупателя" : "Ответ организатора", orderId },
      } });
      await queueConversationAlert(tx, {
        messageId: saved.id, recipientUserId: recipientId,
        ...(sender === "organizer" ? { anonymousTelegramId } : {}),
        thread: { side: sender === "guest" ? "organizer" : "guest", kind: "order", id: orderId },
      });
      await tx.auditLog.create({ data: { actorId: participant.userId ?? null, action: "chat.message_sent", entityType: "order", entityId: orderId, meta: { eventId, sender, chatMessageId: saved.id } } });
      return saved;
      });
      return sameMessage(row, eventId, orderId, sender, text, fileIds);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const concurrent = await this.db.chatMessage.findUnique({ where: { clientMessageId: requestKey }, select: { id: true, eventId: true, orderId: true, sender: true, text: true, createdAt: true, readAt: true, files: { select: { id: true, name: true, mime: true, size: true } } } });
        if (concurrent) return sameMessage(concurrent, eventId, orderId, sender, text, fileIds);
      }
      throw error;
    }
  }

  async markRead(eventId: string, orderId: string, participant: EventChatParticipant) {
    await this.authorize(eventId, orderId, participant);
    const opposite = participant.kind === "guest" ? "organizer" : "guest";
    const changed = await this.db.chatMessage.updateMany({ where: { eventId, orderId, sender: { in: [opposite, "support"] }, internal: false, readAt: null }, data: { readAt: new Date() } });
    if (participant.userId) await this.db.notification.updateMany({ where: {
      userId: participant.userId, eventId, type: { in: [`chat.${opposite}`, "chat.support"] }, readAt: null,
      payload: { path: ["orderId"], equals: orderId },
    }, data: { readAt: new Date() } });
    return { marked: changed.count };
  }

  async authorize(eventId: string | undefined, orderId: string, participant: EventChatParticipant) {
    const order = await this.db.order.findUnique({ where: { id: orderId }, select: {
      buyerUserId: true, eventId: true,
      anonymousSession: { select: { id: true, accessHash: true, accessExpiresAt: true, telegramId: true, chatId: true } },
      tickets: { select: { ticketType: { select: { eventId: true } } } },
      reservations: { select: { ticketType: { select: { eventId: true } } } },
      seatAllocations: { select: { seat: { select: { venueLayout: { select: { eventId: true } } } } } },
      booking: { select: { table: { select: { venueLayout: { select: { eventId: true } } } } } },
      deposit: { select: { eventId: true } },
    } });
    // Conversation access follows ownership, including customers who need help paying.
    if (!order) throw new NotFoundException({ code: "ORDER_NOT_FOUND" });
    if (!order.buyerUserId && !order.anonymousSession) throw new NotFoundException({ code: "ORDER_NOT_FOUND" });
    const resolvedEventId = orderSoleEventId(order);
    if (!resolvedEventId || (eventId && eventId !== resolvedEventId)) throw new NotFoundException({ code: "ORDER_NOT_FOUND" });
    const event = await this.db.event.findUnique({ where: { id: resolvedEventId }, select: { organizerId: true, title: true } });
    if (!event || (participant.kind === "organizer" && event.organizerId !== participant.userId)) throw new NotFoundException({ code: "ORDER_NOT_FOUND" });
    const anonymousTelegramId = order.anonymousSession?.telegramId === order.anonymousSession?.chatId ? order.anonymousSession?.telegramId ?? null : null;
    if (participant.kind === "guest") {
      const ownedByUser = Boolean(participant.userId && order.buyerUserId === participant.userId);
      const ownedBySession = Boolean(participant.accessToken && order.anonymousSession?.accessHash === secretHash(participant.accessToken) && await capabilityStillValid(this.db, orderId, order.anonymousSession.accessExpiresAt, new Date()));
      const ownedByTelegram = Boolean(!order.buyerUserId && participant.telegramRecipient && anonymousTelegramId === participant.telegramRecipient);
      if (!ownedByUser && !ownedBySession && !ownedByTelegram) throw new NotFoundException({ code: "ORDER_NOT_FOUND" });
    }
    return { eventId: resolvedEventId, title: event.title, anonymousTelegramId, uploadAnonymousSessionId: order.anonymousSession?.id ?? null, organizerId: event.organizerId, guestUserId: order.buyerUserId, anonymousSessionId: order.buyerUserId ? null : order.anonymousSession?.id ?? null };
  }
}

function sameMessage(row: { id: string; eventId: string; orderId: string | null; sender: "guest" | "organizer" | "support"; files: { id: string; name: string; mime: string; size: number }[]; text: string; createdAt: Date; readAt: Date | null }, eventId: string, orderId: string, sender: "guest" | "organizer", text: string, fileIds: string[]) {
  if (row.eventId !== eventId || row.orderId !== orderId) throw new NotFoundException({ code: "ORDER_NOT_FOUND" });
  if (row.sender !== sender || row.text !== text || !sameFiles(row.files, fileIds)) throw new ConflictException({ code: "CHAT_REQUEST_KEY_CHANGED" });
  return { id: row.id, sender: row.sender, text: row.text, createdAt: row.createdAt.toISOString(), files: row.files, readAt: row.readAt?.toISOString() ?? null };
}
