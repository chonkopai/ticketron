import { eventExpiryTime, readCheckoutSnapshot } from "@event-platform/shared-types";
import type { Prisma, PrismaClient } from "@event-platform/database";

import { guestEventTiming, guestEventTimingSelect } from "../tickets/guest-ticket-details.js";

/** Buyer capabilities (quick access, emailed ticket link) stay valid until at least this long after the event ends. */
export const EVENT_ACCESS_GRACE_MS = 7 * 24 * 60 * 60_000;

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * End of the event an order belongs to, in ms, or null when it cannot be resolved.
 * Read at check time, so a rescheduled event moves the deadline with it.
 */
export async function orderEventEnd(db: Db, orderId: string): Promise<number | null> {
  const order = await db.order.findUnique({ where: { id: orderId }, select: {
    checkoutSnapshot: true,
    tickets: { take: 1, select: { ticketType: { select: { eventId: true } } } },
    booking: { select: { table: { select: { venueLayout: { select: { eventId: true } } } } } },
  } });
  if (!order) return null;
  // Live inventory relations first; the frozen snapshot id is only a fallback.
  let snapshotEventId: string | null = null;
  try { const snapshot = readCheckoutSnapshot(order.checkoutSnapshot); snapshotEventId = typeof snapshot.eventId === "string" ? snapshot.eventId : null; }
  catch { snapshotEventId = null; }
  const eventId = order.tickets[0]?.ticketType.eventId ?? order.booking?.table.venueLayout.eventId ?? snapshotEventId;
  if (!eventId || !/^[0-9a-f-]{36}$/i.test(eventId)) return null;
  const event = await db.event.findUnique({ where: { id: eventId }, select: guestEventTimingSelect });
  if (!event) return null;
  const end = eventExpiryTime(guestEventTiming(event));
  return Number.isFinite(end) ? end : null;
}

/**
 * A capability issued with `issuedExpiry` (issue time + its TTL) is valid while
 * now < max(issuedExpiry, event end + 7 days). The event lookup runs only once the
 * issued expiry has passed, so the hot path stays a single indexed read.
 */
export async function capabilityStillValid(db: Db, orderId: string, issuedExpiry: Date, now: Date): Promise<boolean> {
  if (issuedExpiry > now) return true;
  const end = await orderEventEnd(db, orderId);
  return end !== null && end + EVENT_ACCESS_GRACE_MS > now.getTime();
}
