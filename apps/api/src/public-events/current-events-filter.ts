import type { Prisma, PrismaClient } from "@event-platform/database";
import { hasEventEnded } from "@event-platform/shared-types";
import { guestEventTiming, guestEventTimingSelect } from "../tickets/guest-ticket-details.js";

/** Legacy published events without `startsAt` that have not ended yet. */
export async function currentLegacyEventIds(database: PrismaClient, now: Date): Promise<string[]> {
  const legacy = await database.event.findMany({
    where: { status: "published", startsAt: null },
    select: { id: true, ...guestEventTimingSelect },
  });
  return legacy.filter(event => !hasEventEnded(guestEventTiming(event), now)).map(event => event.id);
}

/** Prisma form of the "current event" rule for the given legacy ids. */
export function currentEventsWhere(legacyIds: string[], now: Date): Prisma.EventWhereInput {
  // A valid end is after the start; otherwise the start is the cutoff. Thus an
  // event with canonical timestamps is current exactly when either is future.
  return { OR: [
    { startsAt: { gt: now } },
    { endsAt: { gt: now } },
    ...(legacyIds.length ? [{ id: { in: legacyIds } }] : []),
  ] };
}

/** Filter before counting/pagination, including legacy local dates without startsAt. */
export async function currentEventsFilter(database: PrismaClient, now: Date): Promise<Prisma.EventWhereInput> {
  return currentEventsWhere(await currentLegacyEventIds(database, now), now);
}
