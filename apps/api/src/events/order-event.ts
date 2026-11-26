import type { Prisma } from "@event-platform/database";

/** Structural shape of an order loaded with the relations that identify its event.
 * `eventId` is the denormalized column (null for orders written by an older release). */
export interface OrderEventSource {
  eventId?: string | null;
  tickets?: Array<{ ticketType: { eventId: string } }>;
  reservations?: Array<{ ticketType: { eventId: string } }>;
  seatAllocations?: Array<{ seat: { venueLayout: { eventId: string | null } } }>;
  booking?: { table: { venueLayout: { eventId: string | null } } } | null;
  deposit?: { eventId: string } | null;
}

/** Events an order belongs to. Prefers the order's own `eventId`; otherwise derives
 * them from tickets, reservations, seats, table booking and deposit. */
export function orderEventIds(order: OrderEventSource): Set<string> {
  if (order.eventId) return new Set([order.eventId]);
  const ids = new Set<string>();
  for (const ticket of order.tickets ?? []) ids.add(ticket.ticketType.eventId);
  for (const reservation of order.reservations ?? []) ids.add(reservation.ticketType.eventId);
  for (const allocation of order.seatAllocations ?? []) {
    if (allocation.seat.venueLayout.eventId) ids.add(allocation.seat.venueLayout.eventId);
  }
  if (order.booking?.table.venueLayout.eventId) ids.add(order.booking.table.venueLayout.eventId);
  if (order.deposit) ids.add(order.deposit.eventId);
  return ids;
}

/** The single event an order belongs to, or null when it has none or spans several. */
export function orderSoleEventId(order: OrderEventSource): string | null {
  const ids = orderEventIds(order);
  return ids.size === 1 ? [...ids][0]! : null;
}

/** True only when every event reference of the order points at `eventId`. */
export function orderBelongsOnlyToEvent(order: OrderEventSource, eventId: string): boolean {
  return orderSoleEventId(order) === eventId;
}

/** Prisma filter for orders that reference `eventId` (column first, relations for legacy rows). */
export function orderBelongsToEvent(eventId: string): Prisma.OrderWhereInput {
  return {
    OR: [
      { eventId },
      {
        eventId: null,
        OR: [
          { tickets: { some: { ticketType: { eventId } } } },
          { reservations: { some: { ticketType: { eventId } } } },
          { seatAllocations: { some: { seat: { venueLayout: { eventId } } } } },
          { booking: { table: { venueLayout: { eventId } } } },
          { deposit: { eventId } },
        ],
      },
    ],
  };
}
