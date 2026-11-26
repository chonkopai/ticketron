import { readCheckoutSnapshot, acceptedResourceName, hasEventEnded, minorToMajor } from "@event-platform/shared-types";
import { loadApiEnv } from "@event-platform/config";
import type { PrismaClient } from "@event-platform/database";
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { DATABASE_CLIENT } from "../auth/auth.constants.js";
import { BOOKING_CLOCK, type BookingClock } from "../booking/booking.constants.js";
import QRCode from "qrcode";
import { ru } from "@event-platform/shared-types";
import { guestEventTiming, guestEventTimingSelect } from "../tickets/guest-ticket-details.js";
import { errorCode, startIntervalWorker } from "../workers/interval-worker.js";

type PhotoSender = (chat: string, image: Buffer, caption: string) => Promise<void>;
/** Posts a new receipt message and returns its Telegram message id. */
type ReceiptSender = (chat: string, text: string, orderId?: string) => Promise<number>;
const DELIVERY_TYPE = "quick.ticket_delivery";
const CLAIM_TIMEOUT_MS = 60_000;

/** Keeps the receipt edit idempotent and records photo attempts individually. */
@Injectable()
export class QuickDeliveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QuickDeliveryService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private cursor: string | undefined;
  constructor(@Inject(DATABASE_CLIENT) private readonly db: PrismaClient, @Inject(BOOKING_CLOCK) private readonly clock: BookingClock) {}
  onModuleInit(): void {
    // Logs carry order ids and error codes only, never payloads or tokens.
    this.timer = startIntervalWorker({ name: "Quick ticket delivery", intervalMs: 15_000, task: () => this.tick(), logger: this.logger });
  }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }
  async tick(send: (chat: string, message: number, text: string, orderId?: string) => Promise<void> = telegramEdit, sessionIds?: string[], sendPhoto: PhotoSender | undefined = send === telegramEdit ? telegramPhoto : undefined,
    sendReceipt: ReceiptSender | undefined = send === telegramEdit ? telegramSendReceipt : undefined): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let delivered = 0;
    try {
      const rows = await this.db.anonymousCheckoutSession.findMany({ where: {
        ...(sessionIds ? { id: { in: sessionIds } } : !this.cursor ? {} : { id: { gt: this.cursor } }),
        deliveredAt: null, deliveryFinishedAt: null, deliveryMessageId: { not: null }, order: { paymentStatus: "paid" },
      }, take: 25, orderBy: { id: "asc" }, include: { order: { include: {
        tickets: { orderBy: { id: "asc" }, select: { id: true, status: true, ticketTypeId: true, seatLabelSnapshot: true, ticketType: { select: { name: true, isInternal: true } }, seatAllocation: { select: { seatId: true, seat: { select: { tableId: true } } } } } },
        booking: { include: { table: { select: { number: true } } } },
      } } } });
      // Advance past permanently failing chats so they cannot starve later deliveries.
      if (!sessionIds) this.cursor = rows.length === 25 ? rows.at(-1)?.id : undefined;
      for (const row of rows) {
        const order = row.order;
        if (!order || !row.chatId || !row.deliveryMessageId) continue;
        const committed = await this.db.outboxEvent.findFirst({ where: { aggregateType: "order", aggregateId: order.id, eventType: "checkout.paid" } });
        if (!committed) continue;
        const snapshot = readCheckoutSnapshot(order.checkoutSnapshot);
        const activeTickets = order.tickets.filter(t => t.status === "active");
        const amount = `${minorToMajor(order.amount, order.currency).toLocaleString("ru-RU", { maximumFractionDigits: 2 }).replace(/[\u00a0\u202f]/g, " ")} ${order.currency.trim()}`;
        const lines = [ru.bot.paymentConfirmed, `🎭 ${snapshot.eventTitle.slice(0, 200)}\n💰 ${snapshot.paymentMode === "deposit" ? ru.events.paymentModes.deposit : ru.events.paymentModes.full_payment}: ${amount}`,
          ...activeTickets.map(t => `🎟 ${(acceptedResourceName(snapshot,[t.ticketTypeId,t.seatAllocation?.seatId,t.seatAllocation?.seat.tableId],t.ticketType.isInternal ? t.seatLabelSnapshot ?? ru.bot.tableOption : t.ticketType.name)).slice(0, 80)}\n${ru.bot.qrWillSend}`),
          ...(order.booking?.status === "confirmed" ? [`🪑 ${ru.bot.tableOption} №${order.booking.table.number}: ${ru.bot.tableConfirmed}`] : []),
          ru.bot.doNotShare];
        const text = lines.join("\n\n").slice(0, 3900);
        let anchor: "ready" | "retry" | "gone" = "ready";
        try { await send(row.chatId.toString(), row.deliveryMessageId, text, order.id); }
        catch (error) { anchor = definitelyRejected(error) ? "gone" : "retry"; if (anchor === "retry") this.logger.warn(`Quick delivery receipt for order ${order.id} deferred: ${errorCode(error)}`); }
        if (anchor === "gone" && sendReceipt) {
          // The original message was deleted or can no longer be edited: post a fresh
          // receipt, make it the anchor for later ticks, and still send the QR photos.
          try {
            const messageId = await sendReceipt(row.chatId.toString(), text, order.id);
            await this.db.anonymousCheckoutSession.updateMany({ where: { id: row.id, deliveredAt: null, deliveryFinishedAt: null }, data: { deliveryMessageId: messageId } });
            anchor = "ready";
          } catch (error) {
            anchor = definitelyRejected(error) ? "gone" : "retry";
            this.logger.warn(`Quick delivery replacement receipt for order ${order.id} ${anchor === "gone" ? "rejected" : "deferred"}: ${errorCode(error)}`);
          }
        }
        if (anchor === "gone") {
          await this.db.anonymousCheckoutSession.updateMany({ where: { id: row.id, deliveredAt: null, deliveryFinishedAt: null }, data: { deliveryFinishedAt: this.clock.now() } });
          continue;
        }
        if (anchor === "retry") continue;
        let allSent = true, pending = false;
        if (sendPhoto) {
          for (const ticket of activeTickets) {
            const name = acceptedResourceName(snapshot, [ticket.ticketTypeId, ticket.seatAllocation?.seatId, ticket.seatAllocation?.seat.tableId], ticket.ticketType.isInternal ? ticket.seatLabelSnapshot ?? ru.bot.tableOption : ticket.ticketType.name);
            const result = await this.deliverPhoto(row.id, row.chatId, order.id, ticket.id, `${ru.bot.ticketCaption}: ${name.slice(0, 180)}`, sendPhoto);
            allSent &&= result === "sent";
            pending ||= result === "pending";
          }
        }
        if (pending) continue;
        const confirmed = await this.db.$transaction(async tx => {
          const now = this.clock.now();
          const changed = await tx.anonymousCheckoutSession.updateMany({ where: { id: row.id, deliveredAt: null, deliveryFinishedAt: null }, data: { deliveryFinishedAt: now, ...(allSent ? { deliveredAt: now } : {}) } });
          if (changed.count && allSent) await tx.outboxEvent.create({ data: { eventType: "anonymous.delivery_completed", aggregateType: "order", aggregateId: order.id, payload: { sourceEventId: committed.id } } });
          return changed.count > 0 && allSent;
        });
        if (confirmed) delivered++;
      }
      return delivered;
    } finally { this.running = false; }
  }

  private async deliverPhoto(sessionId: string, chatId: bigint, orderId: string, ticketId: string, caption: string, send: PhotoSender): Promise<"sent" | "pending" | "unavailable"> {
    const now = this.clock.now(), dedupeKey = `quick-ticket:${sessionId}:${ticketId}`;
    await this.db.notification.createMany({ data: [{ dedupeKey, type: DELIVERY_TYPE, channel: "telegram", telegramId: chatId, payload: { orderId, ticketId }, nextAttemptAt: now }], skipDuplicates: true });
    const row = await this.db.notification.findUniqueOrThrow({ where: { dedupeKey } });
    if (row.status === "sent") return "sent";
    if (row.status === "uncertain" || (row.status === "failed" && !row.nextAttemptAt)) return "unavailable";
    if (row.status === "processing") {
      if (!row.claimedAt || now.getTime() - row.claimedAt.getTime() < CLAIM_TIMEOUT_MS) return "pending";
      await this.db.notification.updateMany({ where: { id: row.id, status: "processing", attempts: row.attempts }, data: { status: "uncertain", lastError: "DELIVERY_OUTCOME_UNKNOWN" } });
      return "pending";
    }
    if (row.nextAttemptAt && row.nextAttemptAt > now) return "pending";
    const claimed = await this.db.notification.updateMany({ where: { id: row.id, status: row.status, attempts: row.attempts }, data: {
      status: "processing", attempts: { increment: 1 }, claimedAt: now, nextAttemptAt: null,
    } });
    if (!claimed.count) return "pending";
    try {
      const ticket = await this.db.ticket.findFirst({ where: { id: ticketId, orderId, status: "active", order: { paymentStatus: "paid" } },
        select: { qrToken: true, ticketType: { select: { event: { select: { status: true, ...guestEventTimingSelect } } } } } });
      const event = ticket?.ticketType.event;
      if (!ticket || !event || event.status !== "published" || hasEventEnded(guestEventTiming(event), now)) throw new TelegramDeliveryRejected("TICKET_NOT_ACTIVE");
      await send(chatId.toString(), await QRCode.toBuffer(ticket.qrToken, { type: "png", width: 320, margin: 2 }), caption);
    } catch (error) {
      const rejected = error instanceof TelegramDeliveryRejected;
      const retry = rejected && error.retryAfter && row.attempts < 2 ? new Date(now.getTime() + error.retryAfter * 1000) : null;
      await this.db.notification.updateMany({ where: { id: row.id, status: "processing", attempts: row.attempts + 1 }, data: {
        status: rejected ? "failed" : "uncertain", lastError: rejected ? error.code : "DELIVERY_OUTCOME_UNKNOWN", nextAttemptAt: retry,
      } });
      return retry ? "pending" : "unavailable";
    }
    // A failed acknowledgement leaves the lease in processing. Its eventual
    // uncertain outcome must never trigger a second non-idempotent photo send.
    const accepted = await this.db.notification.updateMany({ where: { id: row.id, status: "processing", attempts: row.attempts + 1 }, data: { status: "sent", sentAt: this.clock.now(), lastError: null } });
    return accepted.count ? "sent" : "pending";
  }
}

export class TelegramDeliveryRejected extends Error {
  constructor(readonly code: string, readonly retryAfter?: number) { super(code); }
}

const definitelyRejected = (error: unknown): boolean => error instanceof TelegramDeliveryRejected && !error.retryAfter;

async function telegramEdit(chatId: string, messageId: number, text: string, orderId?: string): Promise<void> {
  const env = loadApiEnv();
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
    method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10000),
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, ...(orderId ? { reply_markup: { inline_keyboard: [[{
      text: "🧾 Открыть заказ", url: `https://t.me/${env.TELEGRAM_BOT_USERNAME}?start=p_${orderId}`,
    }]] } } : {}) }),
  });
  const result = await response.json() as { ok: boolean; description?: string; error_code?: number };
  if (result.ok || result.description?.includes("message is not modified")) return;
  if (result.error_code && result.error_code >= 400 && result.error_code < 500 && result.error_code !== 429) {
    throw new TelegramDeliveryRejected("DELIVERY_ANCHOR_UNAVAILABLE");
  }
  throw new Error("TELEGRAM_OUTCOME_UNKNOWN");
}

async function telegramSendReceipt(chatId: string, text: string, orderId?: string): Promise<number> {
  const env = loadApiEnv();
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10000),
    body: JSON.stringify({ chat_id: chatId, text, ...(orderId ? { reply_markup: { inline_keyboard: [[{
      text: "🧾 Открыть заказ", url: `https://t.me/${env.TELEGRAM_BOT_USERNAME}?start=p_${orderId}`,
    }]] } } : {}) }),
  });
  const result = await response.json() as { ok: boolean; result?: { message_id?: number }; error_code?: number; parameters?: { retry_after?: number } };
  if (result.ok && typeof result.result?.message_id === "number") return result.result.message_id;
  if (result.error_code === 429) throw new TelegramDeliveryRejected("RATE_LIMITED", Math.max(1, result.parameters?.retry_after ?? 60));
  if (result.error_code && result.error_code >= 400 && result.error_code < 500) throw new TelegramDeliveryRejected("RECIPIENT_REJECTED");
  throw new Error("TELEGRAM_OUTCOME_UNKNOWN");
}

async function telegramPhoto(chatId: string, image: Buffer, caption: string): Promise<void> {
  const env = loadApiEnv();
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("caption", caption);
  form.append("photo", new Blob([Uint8Array.from(image)], { type: "image/png" }), "ticket.png");
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`, { method: "POST", body: form, signal: AbortSignal.timeout(10000) });
  const result = await response.json() as { ok: boolean; error_code?: number; parameters?: { retry_after?: number } };
  if (result.ok) return;
  if (result.error_code === 429) throw new TelegramDeliveryRejected("RATE_LIMITED", Math.max(1, result.parameters?.retry_after ?? 60));
  if (result.error_code && result.error_code >= 400 && result.error_code < 500) throw new TelegramDeliveryRejected("RECIPIENT_REJECTED");
  throw new Error("TELEGRAM_OUTCOME_UNKNOWN");
}
