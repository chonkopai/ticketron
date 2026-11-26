import type { PrismaClient } from "@event-platform/database";
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";

import { DATABASE_CLIENT } from "../auth/auth.constants.js";
import { maintainOutbox } from "../domain-events/outbox-maintenance.js";
import { BOOKING_CONFIG, type BookingConfig } from "./booking.constants.js";
import { BookingService } from "./booking.service.js";
import { RefundService } from "./refund.service.js";
import { AnonymousService } from "../orders/anonymous.service.js";
import { startIntervalWorker } from "../workers/interval-worker.js";

const OUTBOX_MAINTENANCE_MS = 10 * 60_000;

@Injectable()
export class CheckoutCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CheckoutCleanupService.name);
  private timers: Array<ReturnType<typeof setInterval>> = [];

  constructor(
    @Inject(BookingService) private readonly booking: BookingService,
    @Inject(RefundService) private readonly refunds: RefundService,
    @Inject(BOOKING_CONFIG) private readonly config: BookingConfig,
    @Inject(AnonymousService) private readonly anonymous: AnonymousService,
    @Inject(DATABASE_CLIENT) private readonly db: PrismaClient,
  ) {}

  onModuleInit(): void {
    const intervalMs = this.config.cleanupIntervalSeconds * 1_000;
    const logger = this.logger;
    // One overlap guard per task, so a slow refund reconciliation does not delay expiry.
    this.timers = [
      startIntervalWorker({ name: "Checkout cleanup", intervalMs, logger, task: () => this.booking.expireDueCheckouts(100) }),
      startIntervalWorker({ name: "Refund reconciliation", intervalMs, logger, task: () => this.refunds.processPending(20) }),
      startIntervalWorker({ name: "Anonymous session cleanup", intervalMs, logger, task: async () => {
        await this.anonymous.pruneBotOffers();
        await this.anonymous.pruneExpiredSessions();
      } }),
      startIntervalWorker({ name: "Outbox maintenance", intervalMs: OUTBOX_MAINTENANCE_MS, logger, task: () => maintainOutbox(this.db, new Date()) }),
    ];
  }

  onModuleDestroy(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }
}
