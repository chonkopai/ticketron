import type { PrismaClient } from "@event-platform/database";

/**
 * Runs `task` only if this instance wins `pg_try_advisory_xact_lock(key)`; other
 * instances skip the tick instead of waiting. The lock lives in a transaction that
 * stays open while `task` runs on the normal client, so it is released on commit,
 * rollback, timeout or a dropped connection. If the transaction times out first,
 * another instance may start early; tasks guarded this way must stay idempotent.
 */
export async function runWithAdvisoryLock<T>(db: PrismaClient, key: string, timeoutMs: number, task: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
  let outcome: { ran: true; value: T } | { ran: false } = { ran: false };
  let failure: { error: unknown } | undefined;
  try {
    await db.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS locked`;
      if (!row?.locked) return;
      try { outcome = { ran: true, value: await task() }; }
      catch (error) { failure = { error }; }
    }, { timeout: timeoutMs, maxWait: 10_000 });
  } catch (error) {
    // Closing the lock transaction after the task finished is harmless: the lock is gone with it.
    if (!failure && !outcome.ran) throw error;
  }
  if (failure) throw failure.error;
  return outcome;
}
