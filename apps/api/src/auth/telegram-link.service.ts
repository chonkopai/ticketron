import { createHash, randomBytes } from "node:crypto";

import { Prisma, type PrismaClient, type User } from "@event-platform/database";
import {
  TELEGRAM_LINK_TOKEN_PATTERN,
  TELEGRAM_LINK_TOKEN_PREFIX,
  type TelegramLinkAnswerRequest,
  type TelegramLinkAnswerResponse,
  type TelegramLinkConsumeRequest,
  type TelegramLinkConsumeResponse,
  type TelegramLinkTokenResponse,
} from "@event-platform/shared-types";
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";

import { AUTH_CONFIG, DATABASE_CLIENT, type AuthConfig } from "./auth.constants.js";
import { cancelPendingTelegramNotifications } from "./account.service.js";

const LINK_TOKEN_TTL_MS = 10 * 60 * 1_000;

@Injectable()
export class TelegramLinkService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly database: PrismaClient,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  async issue(userId: string, now = new Date(), sessionFamilyId?: string): Promise<TelegramLinkTokenResponse> {
    const token = `${TELEGRAM_LINK_TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
    const expiresAt = new Date(now.getTime() + LINK_TOKEN_TTL_MS);

    await this.database.telegramLinkToken.create({
      data: { userId, tokenHash: hashToken(token), expiresAt, ...(sessionFamilyId ? { sessionFamilyId } : {}) },
    });

    return {
      token,
      expiresAt: expiresAt.toISOString(),
      deepLinkUrl: `https://t.me/${this.config.telegramBotUsername}?start=${token}`,
    };
  }

  /**
   * The bot reports who opened the link. Nothing is bound here: the attempt is recorded and the
   * bot asks that Telegram user to confirm (see `answer`). Re-opening the same link from the same
   * Telegram account before answering returns the same attempt.
   */
  async consume(input: TelegramLinkConsumeRequest, now = new Date()): Promise<TelegramLinkConsumeResponse> {
    if (!TELEGRAM_LINK_TOKEN_PATTERN.test(input.token)) throw new UnauthorizedException("Telegram link token is invalid");
    const tokenHash = hashToken(input.token);
    const telegramId = BigInt(input.telegramId);
    const telegramChatId = BigInt(input.chatId);

    return this.database.$transaction(async (transaction) => {
      const record = await transaction.telegramLinkToken.findUnique({
        where: { tokenHash },
        include: { user: { include: { contactIdentities: { select: { method: true, normalizedIdentifier: true } }, googleIdentity: { select: { email: true } } } } },
      });

      if (!record || record.expiresAt <= now || record.cancelledAt || record.confirmedAt || record.telegramConfirmedAt) {
        throw new UnauthorizedException("Telegram link token is invalid, expired, or already used");
      }
      if (record.usedAt) {
        // Only the Telegram account that opened it first may see the prompt again.
        if (record.attemptTelegramId !== telegramId || record.attemptChatId !== telegramChatId) throw new UnauthorizedException("Telegram link token was already used");
        return { attemptId: record.id, account: maskAccount(record.user) };
      }
      await this.assertBindable(transaction, record.userId, record.user.telegramId, record.sessionFamilyId, telegramId, telegramChatId);

      const claimed = await transaction.telegramLinkToken.updateMany({
        where: { id: record.id, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now, attemptTelegramId: telegramId, attemptChatId: telegramChatId, attemptAt: now },
      });
      if (claimed.count !== 1) throw new ConflictException("Telegram link token was already used");
      return { attemptId: record.id, account: maskAccount(record.user) };
    });
  }

  /**
   * The Telegram user's Confirm/Cancel. Confirm moves a new identity to `pending` (the web session
   * still confirms); for the account's own Telegram identity it only refreshes the chat.
   */
  async answer(input: TelegramLinkAnswerRequest, now = new Date()): Promise<TelegramLinkAnswerResponse> {
    const telegramId = BigInt(input.telegramId);
    const telegramChatId = BigInt(input.chatId);
    try {
      return await this.database.$transaction(async (transaction) => {
        const initial = await transaction.telegramLinkToken.findUnique({ where: { id: input.attemptId }, select: { userId: true } });
        if (!initial) throw new UnauthorizedException("Telegram link is invalid or expired");
        await transaction.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`telegram-link:${initial.userId}`}, 0))`;
        const record = await transaction.telegramLinkToken.findUniqueOrThrow({ where: { id: input.attemptId }, include: { user: true } });
        if (
          !record.usedAt || record.attemptTelegramId !== telegramId || record.attemptChatId !== telegramChatId ||
          record.telegramConfirmedAt || record.cancelledAt || record.confirmedAt || record.expiresAt <= now
        ) throw new UnauthorizedException("Telegram link is invalid or expired");

        if (input.decision === "cancel") {
          await transaction.telegramLinkToken.update({ where: { id: record.id }, data: { cancelledAt: now } });
          await transaction.auditLog.create({ data: { actorId: record.userId, action: "identity.telegram_link_declined", entityType: "user", entityId: record.userId, meta: { telegramId: telegramId.toString() } } });
          return { state: "cancelled" as const };
        }

        await this.assertBindable(transaction, record.userId, record.user.telegramId, record.sessionFamilyId, telegramId, telegramChatId);
        if (record.user.telegramId === telegramId) {
          const telegramName = [input.firstName, input.lastName].filter(Boolean).join(" ") || undefined;
          const data: Prisma.UserUpdateInput = { telegramChatId };
          if (!record.user.name && telegramName) data.name = telegramName;
          await transaction.user.update({ where: { id: record.userId }, data });
          await cancelPendingTelegramNotifications(transaction, record.userId, { NOT: { telegramId: telegramChatId } });
          await transaction.telegramLinkToken.update({ where: { id: record.id }, data: { telegramConfirmedAt: now, confirmedAt: now } });
          await transaction.auditLog.create({ data: { actorId: record.userId, action: "identity.telegram_chat_linked", entityType: "user", entityId: record.userId, meta: { telegramId: telegramId.toString() } } });
          return { state: "linked" as const };
        }
        await transaction.telegramLinkToken.update({ where: { id: record.id }, data: { telegramConfirmedAt: now, pendingTelegramId: telegramId, pendingChatId: telegramChatId, pendingAt: now } });
        await transaction.auditLog.create({ data: { actorId: record.userId, action: "identity.telegram_link_approved", entityType: "user", entityId: record.userId, meta: { telegramId: telegramId.toString() } } });
        return { state: "pending" as const };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new ConflictException("This Telegram chat is already linked to another user");
      throw error;
    }
  }

  private async assertBindable(transaction: Prisma.TransactionClient, userId: string, currentTelegramId: bigint | null, sessionFamilyId: string | null, telegramId: bigint, telegramChatId: bigint): Promise<void> {
    if (currentTelegramId !== telegramId) {
      if (currentTelegramId !== null) throw new ForbiddenException("This link token belongs to a different Telegram account");
      if (!sessionFamilyId) throw new UnauthorizedException("A web session is required to confirm this link");
      const identityOwner = await transaction.user.findUnique({ where: { telegramId }, select: { id: true } });
      if (identityOwner && identityOwner.id !== userId) throw new ConflictException("This Telegram account is already linked to another user");
    }
    const chatOwner = await transaction.user.findUnique({ where: { telegramChatId }, select: { id: true } });
    if (chatOwner && chatOwner.id !== userId) throw new ConflictException("This Telegram chat is already linked to another user");
  }

  async status(userId: string, sessionFamilyId: string, token: string, now = new Date()): Promise<{ state: "waiting" | "ready" | "linked" | "expired" }> {
    const row = await this.database.telegramLinkToken.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!row || row.userId !== userId || row.sessionFamilyId !== sessionFamilyId || row.expiresAt <= now) return { state: "expired" };
    if (row.confirmedAt) return { state: "linked" };
    if (row.cancelledAt) return { state: "expired" };
    return { state: row.telegramConfirmedAt && row.pendingTelegramId && row.pendingChatId ? "ready" : "waiting" };
  }

  async confirm(userId: string, sessionFamilyId: string, token: string, now = new Date()): Promise<User> {
    try {
      return await this.database.$transaction(async transaction => {
        const row = await transaction.telegramLinkToken.findUnique({ where: { tokenHash: hashToken(token) } });
        if (!row || row.userId !== userId || row.sessionFamilyId !== sessionFamilyId || !row.usedAt || !row.telegramConfirmedAt || row.cancelledAt || !row.pendingTelegramId || !row.pendingChatId || row.confirmedAt || row.expiresAt <= now) throw new UnauthorizedException("Telegram link is not ready for confirmation");
        await transaction.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`telegram-link:${userId}`}, 0))`;
        const telegramOwner = await transaction.user.findUnique({ where: { telegramId: row.pendingTelegramId } });
        const chatOwner = await transaction.user.findUnique({ where: { telegramChatId: row.pendingChatId } });
        if ((telegramOwner && telegramOwner.id !== userId) || (chatOwner && chatOwner.id !== userId)) throw new ConflictException("Telegram identity is already linked");
        const claimed = await transaction.user.updateMany({ where: { id: userId, telegramId: null }, data: { telegramId: row.pendingTelegramId, telegramChatId: row.pendingChatId } });
        if (claimed.count !== 1) throw new ConflictException("Telegram identity is already linked");
        await cancelPendingTelegramNotifications(transaction, userId, { NOT: { telegramId: row.pendingChatId } });
        await transaction.telegramLinkToken.update({ where: { id: row.id }, data: { confirmedAt: now } });
        await transaction.auditLog.create({ data: { actorId: userId, action: "identity.telegram_linked", entityType: "user", entityId: userId } });
        return transaction.user.findUniqueOrThrow({ where: { id: userId } });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new ConflictException("Telegram identity is already linked");
      throw error;
    }
  }
}

/**
 * Enough for the Telegram user to recognise (or not recognise) the account, never the full value.
 * Only verified identifiers are shown: profile name and profile email are editable by the account
 * owner, so an attacker could make them look like the victim's own.
 */
export function maskAccount(user: { contactIdentities: Array<{ method: string; normalizedIdentifier: string }>; googleIdentity: { email: string } | null }): string {
  const email = user.contactIdentities.find(identity => identity.method === "email")?.normalizedIdentifier ?? user.googleIdentity?.email;
  if (email?.includes("@")) {
    const [local = "", domain = ""] = email.split("@");
    const dot = domain.lastIndexOf(".");
    const host = dot > 0 ? domain.slice(0, dot) : domain;
    const tld = dot > 0 ? domain.slice(dot) : "";
    return `${local.slice(0, 1)}***@${host.slice(0, 1)}***${tld}`;
  }
  const phone = user.contactIdentities.find(identity => identity.method === "phone")?.normalizedIdentifier;
  if (phone && phone.length > 6) return `${phone.slice(0, 3)}***${phone.slice(-2)}`;
  return "без подтверждённого email или телефона";
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
