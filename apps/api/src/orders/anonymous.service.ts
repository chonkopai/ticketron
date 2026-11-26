import { readCheckoutSnapshot,acceptedResourceName,ticketNumber,receiptTicketPrice } from "@event-platform/shared-types";
import { createHash, randomBytes } from "node:crypto";
import { Prisma, type AnonymousCheckoutSession, type PrismaClient } from "@event-platform/database";
import type { BotCheckoutOffer, BotCheckoutQuote, CheckoutResponse, CreateCartCheckoutRequest, CreateSeatCheckoutRequest, CreateTableCheckoutRequest, CreateTicketCheckoutRequest, TelegramSeatOffer, TelegramSeatQuote } from "@event-platform/shared-types";
import { ConflictException, HttpException, HttpStatus, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { DATABASE_CLIENT } from "../auth/auth.constants.js";
import { BOOKING_CLOCK, type BookingClock } from "../booking/booking.constants.js";
import { BookingService } from "../booking/booking.service.js";
import { PaymentService } from "../payments/payment.service.js";
import { DomainEventsService } from "../domain-events/domain-events.service.js";
import { VerificationService } from "../auth/verification.service.js";
import { normalizeContact } from "../auth/contact-identity.js";
import { capabilityStillValid } from "./access-expiry.js";

export const QUICK_CONFIG = Symbol("QUICK_CONFIG");
export interface QuickConfig { botUsername: string; sessionSeconds: number; accessSeconds: number }
export const secretHash = (value: string): string => createHash("sha256").update(value).digest("hex");
const token = (): string => randomBytes(32).toString("base64url");
const missing = (): NotFoundException => new NotFoundException({ code: "QUICK_ACCESS_INVALID", message: "Purchase access is unavailable" });
const conflict = (code: string): ConflictException => new ConflictException({ code, message: "This operation is not available" });
type CheckoutKind = "ticket" | "table" | "seats" | "cart";
type CheckoutInput = CreateTicketCheckoutRequest | CreateTableCheckoutRequest | CreateSeatCheckoutRequest | CreateCartCheckoutRequest;

@Injectable()
export class AnonymousService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly db: PrismaClient,
    @Inject(BookingService) private readonly booking: BookingService,
    @Inject(PaymentService) private readonly payments: PaymentService,
    @Inject(DomainEventsService) private readonly events: DomainEventsService,
    @Inject(BOOKING_CLOCK) private readonly clock: BookingClock,
    @Inject(QUICK_CONFIG) private readonly config: QuickConfig,
    @Inject(VerificationService) private readonly verification?: VerificationService,
  ) {}

  async start(name: string) {
    const sessionToken = token(), accessToken = token(), verification = token();
    const now = this.clock.now();
    const session = await this.db.anonymousCheckoutSession.create({ data: {
      name, sessionHash: secretHash(sessionToken), accessHash: secretHash(accessToken),
      verificationHash: secretHash(verification),
      expiresAt: new Date(now.getTime() + this.config.sessionSeconds * 1000),
      accessExpiresAt: new Date(now.getTime() + this.config.accessSeconds * 1000),
    } });
    return { sessionToken, accessToken, expiresAt: session.expiresAt.toISOString(), accessExpiresAt: session.accessExpiresAt.toISOString(), telegramUrl: `https://t.me/${this.config.botUsername}?start=q_${verification}` };
  }

  options(eventId: string) { return this.booking.options("", eventId); }

  startBotOffer(name: string, recipient: bigint, offer: BotCheckoutQuote): Promise<BotCheckoutOffer> {
    return this.startTelegramOffer(name, recipient, offer);
  }

  startSeatOffer(name: string, recipient: bigint, offer: TelegramSeatQuote): Promise<TelegramSeatOffer> {
    return this.startTelegramOffer(name, recipient, offer);
  }

  private async startTelegramOffer<T extends BotCheckoutQuote | TelegramSeatQuote>(name: string, recipient: bigint, offer: T): Promise<T & { reference: string; expiresAt: string }> {
    return this.db.$transaction(async tx => {
      await lock(tx, `bot-offer:${recipient}`);
      const now = this.clock.now();
      const pending = { telegramId: recipient, chatId: recipient, orderId: null, botOffer: { not: Prisma.DbNull } };
      await tx.anonymousCheckoutSession.deleteMany({ where: { ...pending, expiresAt: { lte: now } } });
      // A new tap on the same event supersedes the earlier unconfirmed offer; a stale confirm then fails with the not-found error.
      await tx.anonymousCheckoutSession.deleteMany({ where: { ...pending, botOffer: { path: ["eventId"], equals: offer.eventId } } });
      if (await tx.anonymousCheckoutSession.count({ where: pending }) >= 12) {
        throw new HttpException({ code: "BOT_OFFER_LIMIT" }, HttpStatus.TOO_MANY_REQUESTS);
      }
      const session = await tx.anonymousCheckoutSession.create({ data: {
        name, telegramId: recipient, chatId: recipient, sessionHash: secretHash(token()), accessHash: secretHash(token()),
        expiresAt: new Date(now.getTime() + this.config.sessionSeconds * 1000),
        accessExpiresAt: new Date(now.getTime() + this.config.accessSeconds * 1000),
        botOffer: { ...offer, ...(offer.kind === "cart" ? { items: offer.items.map(item => ({ ...item })) } : {}) } as Prisma.InputJsonObject,
        telegramSeatEventId: offer.kind === "cart" ? offer.eventId : null,
      } });
      return { ...offer, reference: session.id, expiresAt: session.expiresAt.toISOString() };
    });
  }

  confirmBotOffer(recipient: bigint, reference: string, messageId: number): Promise<string> {
    return this.confirmTelegramOffer(recipient, reference, { eventId: null, messageId });
  }

  confirmSeatOffer(recipient: bigint, reference: string, eventId: string): Promise<string> {
    return this.confirmTelegramOffer(recipient, reference, { eventId, messageId: null });
  }

  private async confirmTelegramOffer(recipient: bigint, reference: string, scope: { eventId: string | null; messageId: number | null }): Promise<string> {
    return this.db.$transaction(async tx => {
      await lock(tx, `quick:${reference}`);
      await tx.$queryRaw`SELECT id FROM "AnonymousCheckoutSession" WHERE id=${reference}::uuid AND "telegramId"=${recipient} AND "chatId"=${recipient} FOR UPDATE`;
      const session = await tx.anonymousCheckoutSession.findFirst({ where: { id: reference, telegramId: recipient, chatId: recipient, telegramSeatEventId: scope.eventId } });
      const key = `tg-${reference}`;
      if (session?.orderId && session.requestKey === key) return session.orderId;
      if (!session?.botOffer) throw missing();
      if (session.orderId) throw missing();
      if (session.expiresAt <= this.clock.now()) throw conflict("BOT_OFFER_EXPIRED");
      const offer = session.botOffer as unknown as BotCheckoutQuote | TelegramSeatQuote;
      const terms = {
        termsAccepted: true as const, contentLocale: offer.locale,
        ...(offer.policyRevision === null ? {} : { policyRevision: offer.policyRevision }),
      };
      if (offer.kind === "cart" && offer.eventId !== scope.eventId) throw missing();
      let input: CheckoutInput;
      if (offer.kind === "cart") {
        const tableId = offer.items.find(item => item.kind === "table")?.id;
        input = { ...terms, eventId: offer.eventId, seatIds: offer.items.filter(item => item.kind === "seat").map(item => item.id), ...(tableId ? { tableId } : {}) };
      } else {
        input = offer.kind === "ticket" ? { ...terms, ticketTypeId: offer.itemId, quantity: 1 } : { ...terms, tableId: offer.itemId };
      }
      const order = await this.createCheckout(tx, session, key, offer.kind, input, { offer, messageId: scope.messageId });
      return order.orderId;
    }, { timeout: 15000 });
  }

  async pruneBotOffers(): Promise<void> {
    const expiresAt = { lte: this.clock.now() };
    const expired = { expiresAt, orderId: null, botOffer: { not: Prisma.DbNull } };
    const [rows, launches] = await Promise.all([
      this.db.anonymousCheckoutSession.findMany({ where: expired, orderBy: { expiresAt: "asc" }, take: 100, select: { id: true } }),
      this.db.telegramSeatSession.findMany({ where: { expiresAt }, orderBy: { expiresAt: "asc" }, take: 100, select: { launchHash: true } }),
    ]);
    if (rows.length) await this.db.anonymousCheckoutSession.deleteMany({ where: { ...expired, id: { in: rows.map(row => row.id) } } });
    if (launches.length) await this.db.telegramSeatSession.deleteMany({ where: { expiresAt, launchHash: { in: launches.map(row => row.launchHash) } } });
  }

  /**
   * Deletes checkout sessions that never produced an order and expired more than a
   * day ago. Sessions with an order are the buyer's receipt capability and are kept;
   * sessions referenced by support cases, uploads or chat are kept as well.
   */
  async pruneExpiredSessions(limit = 500): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - 24 * 60 * 60_000);
    return this.db.$executeRaw`
      DELETE FROM "AnonymousCheckoutSession" WHERE id IN (
        SELECT s.id FROM "AnonymousCheckoutSession" s
        WHERE s."orderId" IS NULL AND s."expiresAt" < ${cutoff}
          AND NOT EXISTS (SELECT 1 FROM "PlatformCase" c WHERE c."anonymousSessionId" = s.id)
          AND NOT EXISTS (SELECT 1 FROM "PrivateUpload" u WHERE u."anonymousSessionId" = s.id)
          AND NOT EXISTS (SELECT 1 FROM "ChatMessage" m WHERE m."anonymousSessionId" = s.id)
        ORDER BY s."expiresAt" LIMIT ${limit}
        FOR UPDATE OF s SKIP LOCKED)`;
  }

  async verify(input: { token: string; telegramId: string; chatId: string; messageId: number }) {
    // Only private chats are eligible. HTTP caller must pass the bot-service guard.
    if (input.telegramId !== input.chatId) throw missing();
    return this.db.$transaction(async tx => {
      await lock(tx, `quick-verify:${secretHash(input.token)}`);
      const row = await tx.anonymousCheckoutSession.findUnique({ where: { verificationHash: secretHash(input.token) } });
      if (!row || row.expiresAt <= this.clock.now() || row.telegramId) throw missing();
      await tx.anonymousCheckoutSession.update({ where: { id: row.id }, data: {
        telegramId: BigInt(input.telegramId), chatId: BigInt(input.chatId), deliveryMessageId: input.messageId, verificationHash: null,
      } });
      await this.events.append(tx, { eventType: "anonymous.recipient_verified", aggregateType: "anonymous_session", aggregateId: row.id, payload: {} });
      return { verified: true };
    });
  }

  async session(raw: string) {
    const row = await this.db.anonymousCheckoutSession.findUnique({ where: { sessionHash: secretHash(raw) } });
    if (!row || row.expiresAt <= this.clock.now()) throw missing();
    return row;
  }

  async requestEmail(raw: string, address: string, clientKey: string) {
    const session = await this.session(raw);
    if (session.orderId || !this.verification) throw conflict("CHECKOUT_EMAIL_UNAVAILABLE");
    return this.verification.issue({ purpose: "checkout_email", method: "email", target: address, sessionFamilyId: session.id, clientKey });
  }

  async verifyEmail(raw: string, address: string, challengeId: string, code: string, clientKey: string) {
    const session = await this.session(raw);
    if (session.orderId || !this.verification) throw conflict("CHECKOUT_EMAIL_UNAVAILABLE");
    const proof = await this.verification.verify({ purpose: "checkout_email", method: "email", target: address, challengeId, code, sessionFamilyId: session.id, clientKey });
    const email = normalizeContact("email", address);
    await this.db.$transaction(async tx => {
      await lock(tx, `quick:${session.id}`);
      const current = await tx.anonymousCheckoutSession.findUniqueOrThrow({ where: { id: session.id } });
      if (current.orderId || current.expiresAt <= this.clock.now()) throw conflict("QUICK_ACCESS_INVALID");
      await this.verification!.claimGrant(tx, { purpose: "checkout_email", method: "email", target: email, sessionFamilyId: session.id, grant: proof.grant });
      await tx.anonymousCheckoutSession.update({ where: { id: session.id }, data: { verifiedEmail: email } });
    });
    return { verified: true, email };
  }

  async checkout(raw: string, key: string, kind: CheckoutKind, input: CheckoutInput): Promise<CheckoutResponse> {
    const session = await this.session(raw);
    const response = await this.db.$transaction(async tx => {
      await lock(tx, `quick:${session.id}`);
      const current = await tx.anonymousCheckoutSession.findUniqueOrThrow({ where: { id: session.id } });
      if (current.expiresAt <= this.clock.now() || ((!current.telegramId || !current.chatId) && !current.verifiedEmail)) throw conflict("RECIPIENT_NOT_VERIFIED");
      if (!current.telegramId && (!input.emailDelivery || normalizeContact("email", input.emailDelivery.address) !== current.verifiedEmail)) throw conflict("CHECKOUT_EMAIL_REQUIRED");
      return this.createCheckout(tx, current, key, kind, input);
    }, { timeout: 15000 });
    const order = await this.db.order.findUniqueOrThrow({ where: { id: response.orderId } });
    if (order.paymentStatus !== "pending") return response;
    if (response.amountDue === 0) {
      await this.booking.settleSucceeded(response.orderId);
      return response;
    }
    const link = await this.payments.createLink(session.id, response.orderId, key, true);
    return { ...response, paymentLink: link.paymentLink };
  }

  private async createCheckout(tx: Prisma.TransactionClient, session: AnonymousCheckoutSession, key: string, kind: CheckoutKind, input: CheckoutInput, bot?: { offer: BotCheckoutQuote | TelegramSeatQuote; messageId: number | null }): Promise<CheckoutResponse> {
    const fingerprint = secretHash(JSON.stringify({ kind, ...input }));
    if (session.requestKey) {
      if (session.requestKey !== key || session.requestHash !== fingerprint) throw conflict("IDEMPOTENCY_CONFLICT");
      return session.response as unknown as CheckoutResponse;
    }
    const context = { transaction: tx, sessionId: session.id, verifiedEmail: session.verifiedEmail,
      ...(bot ? { botOffer: bot.offer } : {}),
      guestContact: session.telegramId && session.chatId
        ? { name: session.name, channel: "telegram", telegramId: session.telegramId.toString(), chatId: session.chatId.toString() }
        : { name: session.name, channel: "email", email: session.verifiedEmail! } };
    const created = kind === "cart"
      ? await this.booking.checkoutCart(session.id, key, input as CreateCartCheckoutRequest, context)
      : kind === "ticket"
      ? await this.booking.checkoutTickets(session.id, key, input as CreateTicketCheckoutRequest, context)
      : kind === "table"
        ? await this.booking.checkoutTable(session.id, key, input as CreateTableCheckoutRequest, context)
        : await this.booking.checkoutSeats(session.id, key, input as CreateSeatCheckoutRequest, context);
    await tx.anonymousCheckoutSession.update({ where: { id: session.id }, data: {
      orderId: created.orderId, requestKey: key, requestHash: fingerprint, response: created as unknown as Prisma.InputJsonObject,
      ...(bot ? { deliveryMessageId: bot.messageId, botOffer: Prisma.DbNull } : {}),
    } });
    return created;
  }

  /** Valid until max(issue + access TTL, event end + 7 days); see access-expiry.ts. */
  async access(raw: string, orderId?: string) {
    const row = await this.db.anonymousCheckoutSession.findFirst({ where: {
      accessHash: secretHash(raw), ...(orderId ? { orderId } : {}),
    } });
    if (!row?.orderId || !await capabilityStillValid(this.db, row.orderId, row.accessExpiresAt, this.clock.now())) throw missing();
    return row;
  }

  async status(raw: string) {
    const session = await this.access(raw);
    let order = await this.db.order.findUniqueOrThrow({ where: { id: session.orderId! }, include: { tickets: { include: { ticketType: { select: { name: true, isInternal: true } },seatAllocation:{select:{seatId:true,seat:{select:{tableId:true}}}} } }, booking: { include: { table: { select: { number: true, name: true } } } }, deposit: true } });
    if (order.paymentStatus === "pending" && order.expiresAt && order.expiresAt <= this.clock.now()) {
      await this.booking.settleFailed(order.id, "expired");
      order = await this.db.order.findUniqueOrThrow({ where: { id: order.id }, include: { tickets: { include: { ticketType: { select: { name: true, isInternal: true } },seatAllocation:{select:{seatId:true,seat:{select:{tableId:true}}}} } }, booking: { include: { table: { select: { number: true, name: true } } } }, deposit: true } });
    }
    const snapshot = readCheckoutSnapshot(order.checkoutSnapshot);
    const event = typeof snapshot.eventId === "string" ? await this.db.event.findUnique({ where: { id: snapshot.eventId }, select: { date: true, time: true, timezone: true, address: true, sourceLocale: true } }) : null;
    const review = await this.db.outboxEvent.findFirst({ where: { aggregateId: order.id, eventType: "payment.review_required" } });
    const expired = await this.db.outboxEvent.findFirst({ where: { aggregateId: order.id, eventType: "checkout.expired" } });
    return { createdAt: order.createdAt.toISOString(), buyerName: session.name, orderId: order.id, eventId: typeof snapshot.eventId === "string" ? snapshot.eventId : null, status: review ? "review_required" : expired ? "expired" : order.paymentStatus,
      title: snapshot.eventTitle, sourceLocale: snapshot.contentLocale??event?.sourceLocale ?? "ru", paymentMode: snapshot.paymentMode, amountDue: order.amount, currency: order.currency.trim(),
      fullAmount: snapshot.fullAmount, ...(snapshot.acceptedPolicy?{acceptedPolicy:snapshot.acceptedPolicy}:{}), cancellationTerms: snapshot.cancellationTerms, depositTerms: snapshot.depositTerms,
      expiresAt: order.expiresAt?.toISOString() ?? null, linked: Boolean(order.buyerUserId),
      deliveryStatus: session.deliveredAt ? "confirmed" : !session.deliveryFinishedAt && session.chatId && session.deliveryMessageId ? "pending" : "unavailable",
      event: event ? { date: snapshot.eventDate??event.date.toISOString().slice(0,10), time: snapshot.eventTime??event.time.toISOString().slice(11,16), timezone: snapshot.eventTimezone??event.timezone, address: snapshot.address??event.address } : null,
      tickets: order.tickets.map(t => ({ id: t.id, name: acceptedResourceName(snapshot,[t.ticketTypeId,t.seatAllocation?.seatId,t.seatAllocation?.seat.tableId],t.ticketType.isInternal ? t.seatLabelSnapshot ?? "Место за столом" : t.ticketType.name), seatLabel: t.seatLabelSnapshot, status: t.status, number: ticketNumber(t.id), price: receiptTicketPrice(snapshot,[t.ticketTypeId,t.seatAllocation?.seatId,t.seatAllocation?.seat.tableId],order.amount) })),
      booking: order.booking ? { id: order.booking.id, status: order.booking.status, table: order.booking.table } : null,
      deposit: order.deposit ? { amount: order.deposit.amount, status: order.deposit.status } : null };
  }

  async purchases(organizerId: string, eventId: string, page: number) {
    if (!await this.db.event.findFirst({ where: { id: eventId, organizerId }, select: { id: true } })) throw missing();
    const rows = await this.db.order.findMany({ where: { OR: [
      { tickets: { some: { ticketType: { eventId, event: { organizerId } } } } },
      { booking: { table: { venueLayout: { eventId, event: { organizerId } } } } },
    ] }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip: (page - 1) * 20, take: 20,
      include: { buyer: { select: { name: true } }, tickets: { select: { id: true, status: true } }, booking: { select: { id: true, status: true } } } });
    return { page, items: rows.map(o => ({ id: o.id, name: o.buyer?.name ?? (o.guestContact as { name?: string } | null)?.name ?? null,
      guestContact: o.buyerUserId || !o.guestContact ? null : {
        name: (o.guestContact as { name?: string }).name ?? null,
        telegramId: (o.guestContact as { telegramId?: string }).telegramId ?? null,
        email: (o.guestContact as { email?: string }).email ?? null,
        channel: (o.guestContact as { channel?: string }).channel === "email" ? "email" : "telegram",
      }, status: o.paymentStatus, amount: o.amount, currency: o.currency.trim(), tickets: o.tickets, booking: o.booking })) };
  }
}

async function lock(tx: Prisma.TransactionClient, key: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}
