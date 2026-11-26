import type { PrismaClient } from "@event-platform/database";

/**
 * Fixture helper: mark events as staff-approved and on sale, as the moderation
 * flow would (see migration 20261116020000_event_moderation).
 *
 * Call it AFTER the fixture's inventory is written: inserting or editing ticket
 * types, layouts, tables, rows, seats or tariffs resets approval through the
 * review triggers, and checkout / the public catalog then refuse the event.
 */
export async function approveEventsForTest(db: Pick<PrismaClient, "event">, ...eventIds: string[]): Promise<void> {
  await db.event.updateMany({
    where: { id: { in: eventIds } },
    data: { approvedAt: new Date(), moderationStatus: "approved", moderationReason: null, salesPaused: false },
  });
}
