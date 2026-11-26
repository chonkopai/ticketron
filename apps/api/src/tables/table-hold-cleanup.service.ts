import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";

import { TABLES_CONFIG, type TablesConfig } from "./tables.constants.js";
import { TablesService } from "./tables.service.js";
import { startIntervalWorker } from "../workers/interval-worker.js";

@Injectable()
export class TableHoldCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TableHoldCleanupService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(TablesService) private readonly tables: TablesService,
    @Inject(TABLES_CONFIG) private readonly config: TablesConfig,
  ) {}

  onModuleInit(): void {
    this.timer = startIntervalWorker({
      name: "Table hold cleanup",
      intervalMs: this.config.cleanupIntervalSeconds * 1_000,
      logger: this.logger,
      task: () => this.tables.expireDueHolds(100),
    });
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
