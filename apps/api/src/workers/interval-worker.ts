import { Logger } from "@nestjs/common";

/**
 * Stable, PII-free label for an error: a Prisma/Node `code`, an HTTP-style
 * `response.code`, or the error class name. Never the message, which can carry
 * recipients, tokens or SQL values.
 */
export function errorCode(error: unknown): string {
  if (error && typeof error === "object") {
    const record = error as { code?: unknown; kind?: unknown; response?: { code?: unknown }; name?: unknown };
    for (const value of [record.code, record.response?.code, record.kind]) {
      if (typeof value === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(value)) return value;
    }
    if (typeof record.name === "string" && /^[A-Za-z0-9_]{1,64}$/.test(record.name)) return record.name;
  }
  return "UNKNOWN_ERROR";
}

/** Runs one task at a time in this process: a tick that starts while the previous one is still running is skipped. */
export class ExclusiveRunner {
  private active = false;
  get running(): boolean { return this.active; }

  /** Resolves `{ ran: false }` when the previous run is still in progress. */
  async run<T>(task: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
    if (this.active) return { ran: false };
    this.active = true;
    try { return { ran: true, value: await task() }; }
    finally { this.active = false; }
  }
}

export interface IntervalWorkerOptions {
  /** Short label for logs, e.g. "Checkout cleanup". */
  name: string;
  intervalMs: number;
  task: () => Promise<unknown>;
  logger?: Logger;
  /** Also run once right away (still guarded). */
  runImmediately?: boolean;
}

/**
 * Starts an unref'd `setInterval` worker with an in-process overlap guard and
 * PII-free error logging. Cross-instance exclusion (where needed) is the task's job.
 */
export function startIntervalWorker(options: IntervalWorkerOptions): ReturnType<typeof setInterval> {
  const runner = new ExclusiveRunner();
  const logger = options.logger ?? new Logger(options.name);
  const fire = (): void => {
    void runner.run(options.task).catch((error: unknown) => {
      logger.error(`${options.name} failed: ${errorCode(error)}`);
    });
  };
  if (options.runImmediately) fire();
  const timer = setInterval(fire, options.intervalMs);
  timer.unref();
  return timer;
}
