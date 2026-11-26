import { createHash } from "node:crypto";

import type { PrismaClient } from "@event-platform/database";
import type {
  BotIdentityRequest,
  BotIdentityResponse,
} from "@event-platform/shared-types";
import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from "@nestjs/common";

import { DATABASE_CLIENT } from "../auth/auth.constants.js";
import { startIntervalWorker } from "../workers/interval-worker.js";

/**
 * The bot acknowledges Telegram right after the claim and processes in the background,
 * so a redelivery can only follow a lost acknowledgement. Keep the lease well beyond any
 * handler run so such a redelivery is dropped instead of running the handler twice.
 */
const UPDATE_LEASE_SECONDS = 15 * 60;
const UPDATE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const UPDATE_PRUNE_BATCH = 500;
const UPDATE_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

@Injectable()
export class BotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BotService.name);
  private pruneTimer?: ReturnType<typeof setInterval>;

  constructor(
    @Inject(DATABASE_CLIENT) private readonly db: PrismaClient,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === "test") return;
    this.pruneTimer = startIntervalWorker({
      name: "Telegram update pruning",
      intervalMs: UPDATE_PRUNE_INTERVAL_MS,
      logger: this.logger,
      task: () => this.pruneUpdates(),
    });
  }

  onModuleDestroy(): void {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
  }

  /** Deletes finished (completed, or failed: Telegram stops redelivering after ~24h) updates past retention. Never touches `processing`. */
  async pruneUpdates(now = new Date(), limit = UPDATE_PRUNE_BATCH): Promise<number> {
    const rows = await this.db.telegramUpdate.findMany({
      where: { status: { in: ["completed", "failed"] }, createdAt: { lt: new Date(now.getTime() - UPDATE_RETENTION_MS) } },
      orderBy: { createdAt: "asc" },
      take: limit,
      select: { id: true },
    });
    if (!rows.length) return 0;
    const { count } = await this.db.telegramUpdate.deleteMany({ where: { id: { in: rows.map((row) => row.id) }, status: { in: ["completed", "failed"] } } });
    return count;
  }

  async grantWriteAccess(input: { telegramId: string; chatId: string }): Promise<{ linked: boolean }> {
    if (!/^[1-9][0-9]{0,18}$/.test(input.telegramId) || input.telegramId !== input.chatId || BigInt(input.telegramId) > 9223372036854775807n) throw new BadRequestException({ code: "BOT_IDENTITY_INVALID" });
    const telegramId = BigInt(input.telegramId);
    // This endpoint is restricted to the webhook service, which verifies Telegram updates.
    // Upsert also handles a permission update arriving before the widget login callback.
    await this.db.user.upsert({ where: { telegramId }, create: { telegramId, telegramChatId: telegramId, role: "guest" }, update: { telegramChatId: telegramId } });
    return { linked: true };
  }

  async identity(input: BotIdentityRequest): Promise<BotIdentityResponse> {
    if (!/^-?\d+$/.test(input.telegramId) || !/^-?\d+$/.test(input.chatId)) throw new BadRequestException({ code: "BOT_IDENTITY_INVALID" });
    const user = await this.db.user.findFirst({ where: { telegramId: BigInt(input.telegramId), telegramChatId: BigInt(input.chatId) } });
    if (!user) throw new NotFoundException({ code: "BOT_IDENTITY_NOT_LINKED" });
    return { user: { id: user.id, role: user.role } };
  }

  async claimUpdate(botId: string, updateId: string, payloadHash: string): Promise<{ process: boolean; retry?: boolean }> {
    if (!/^\d+$/.test(updateId) || !/^[a-f0-9]{64}$/.test(payloadHash)) throw new BadRequestException({ code: "BOT_UPDATE_INVALID" });
    const now = new Date();
    const id = BigInt(updateId);
    const leaseUntil = new Date(now.getTime() + UPDATE_LEASE_SECONDS * 1000);
    return this.db.$transaction(async (tx) => {
      // Insert-or-lock: two concurrent deliveries of one update can never both get process:true.
      const inserted = await tx.$executeRaw`
        INSERT INTO "TelegramUpdate" (id, "botId", "updateId", "payloadHash", status, attempts, "leaseUntil", "createdAt")
        VALUES (gen_random_uuid(), ${botId}, ${id}, ${payloadHash}, 'processing'::"TelegramUpdateStatus", 1, ${leaseUntil}, ${now})
        ON CONFLICT ("botId", "updateId") DO NOTHING`;
      if (inserted === 1) return { process: true };
      const [existing] = await tx.$queryRaw<Array<{ id: string; payloadHash: string; status: string; leaseUntil: Date | null }>>`
        SELECT id, "payloadHash", status::text AS status, "leaseUntil" FROM "TelegramUpdate" WHERE "botId" = ${botId} AND "updateId" = ${id} FOR UPDATE`;
      if (!existing) throw new ConflictException({ code: "BOT_UPDATE_CONFLICT" });
      if (existing.payloadHash !== payloadHash) throw new ConflictException({ code: "BOT_UPDATE_CONFLICT" });
      if (existing.status === "completed") return { process: false };
      // Still owned by a live run: drop the redelivery (200) rather than re-running the handler.
      if (existing.status === "processing" && existing.leaseUntil && existing.leaseUntil > now) return { process: false };
      await tx.telegramUpdate.update({ where: { id: existing.id }, data: { payloadHash, status: "processing", leaseUntil, attempts: { increment: 1 } } });
      return { process: true };
    });
  }

  async completeUpdate(botId: string, updateId: string, payloadHash: string, failed = false): Promise<void> {
    const row = await this.db.telegramUpdate.findUnique({ where: { botId_updateId: { botId, updateId: BigInt(updateId) } } });
    if (!row || row.payloadHash !== payloadHash) return;
    await this.db.telegramUpdate.update({ where: { id: row.id }, data: failed ? { status: "failed", leaseUntil: null } : { status: "completed", processedAt: new Date(), leaseUntil: null } });
  }
}

export function hashTelegramPayload(raw: Buffer | string): string {
  return createHash("sha256").update(raw).digest("hex");
}
