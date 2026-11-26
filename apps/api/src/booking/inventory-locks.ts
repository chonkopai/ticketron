import type { Prisma } from "@event-platform/database";

/**
 * Advisory locks for orders and sale inventory. Every path takes them in one order:
 *
 *   order → seat (sorted) → table → ticket type (sorted)
 *
 * Price and inventory writers (ticket type / table edits) take their resource lock before they touch the Event row,
 * so a reader that locks the resource first and only then reads prices sees one consistent price.
 * Locks are transaction scoped and re-entrant within a transaction.
 */
type Tx = Pick<Prisma.TransactionClient, "$queryRaw">;

export async function lockOrder(transaction: Tx, id: string): Promise<void> {
  await transaction.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`order:${id}`}, 0))`;
}

/** Non-blocking order lock for code that already holds a later lock in the order above (table hold expiry). */
export async function tryLockOrder(transaction: Tx, id: string): Promise<boolean> {
  const [row] = await transaction.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtextextended(${`order:${id}`}, 0)) AS "locked"`;
  return row?.locked === true;
}

export async function lockSeat(transaction: Tx, id: string): Promise<void> {
  await transaction.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`seat:${id}`}, 0))`;
}

/** Locks each distinct seat once, in sorted id order. */
export async function lockSeats(transaction: Tx, ids: Iterable<string>): Promise<void> {
  for (const id of [...new Set(ids)].sort()) await lockSeat(transaction, id);
}

export async function lockTable(transaction: Tx, id: string): Promise<void> {
  await transaction.$queryRaw`SELECT 1 AS "locked" FROM pg_advisory_xact_lock(hashtextextended(${`table:${id}`}, 0))`;
}

/** Locks each distinct ticket type once, in sorted id order. */
export async function lockTicketTypes(transaction: Tx, ids: Iterable<string>): Promise<void> {
  for (const id of [...new Set(ids)].sort()) {
    await transaction.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`ticket-type:${id}`}, 0))`;
  }
}

/** The ticket types that price the given seats; read before locking them, so callers re-read prices afterwards. */
export async function seatTicketTypeIds(transaction: Pick<Prisma.TransactionClient, "seat">, seatIds: readonly string[]): Promise<string[]> {
  if (!seatIds.length) return [];
  const seats = await transaction.seat.findMany({ where: { id: { in: [...seatIds] } }, select: { ticketTypeId: true } });
  return seats.flatMap((seat) => (seat.ticketTypeId ? [seat.ticketTypeId] : []));
}

/** Returned by a peek-then-lock transaction when the re-read under its locks shows the peeked set was stale. */
export const LOCKS_STALE = Symbol("locks-stale");

/**
 * Peek-then-lock-in-order-then-recheck: the transaction peeks the rows it must lock, takes the locks in the documented
 * order, re-reads, and returns LOCKS_STALE (before any write) when the peek no longer holds. A fresh transaction then peeks again.
 */
export async function withStaleRetry<T>(run: () => Promise<T | typeof LOCKS_STALE>, attempts = 5): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await run();
    if (result !== LOCKS_STALE) return result;
  }
  throw new Error("Resource set kept changing while taking inventory locks");
}
