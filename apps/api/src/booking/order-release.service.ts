import { BookingStatus, SeatAllocationStatus, TableHoldStatus, TableStatus, TicketReservationStatus, TicketStatus, type Prisma } from "@event-platform/database";

import { lockOrder, lockTable, lockTicketTypes } from "./inventory-locks.js";

/**
 * Why an order lets go of its inventory. `expired` and `failed` mark a live booking and hold `expired`;
 * every other reason cancels the booking and releases the hold.
 */
export type OrderReleaseReason = "failed" | "expired" | "released" | "cancelled" | "refunded";

export interface OrderReleaseOptions {
  /**
   * The status released tickets end in. `cancelled` (buyer/staff cancellation, unpaid releases) takes
   * pending, paid and active tickets; `refunded` (money returned) takes paid and active tickets.
   */
  terminalTicketStatus: "cancelled" | "refunded";
  reason: OrderReleaseReason;
  now: Date;
  /** Release only these tickets and their seat allocations (staff partial refund). Default: the whole order. */
  ticketIds?: readonly string[];
  /** Also release reservations, the group pass, the booking, its hold and the table. Default: true. */
  releaseOrderResources?: boolean;
  /** Staff refunds also move already-cancelled tickets to `refunded`, because their money is returned now. */
  refundCancelledTickets?: boolean;
}

export interface OrderReleaseResult {
  releasedTicketIds: string[];
}

/**
 * The one place that returns an order's inventory. Lock order: order → table → ticket types (sorted),
 * the order every checkout, settlement and cancellation path uses; state is read only after the locks.
 * Order, Payment and Deposit statuses, outbox events and audit rows stay with the caller, because they differ per flow.
 * Idempotent: rows already in a terminal state are left alone.
 */
export async function releaseOrderInventory(transaction: Prisma.TransactionClient, orderId: string, options: OrderReleaseOptions): Promise<OrderReleaseResult> {
  const { now, ticketIds } = options;
  await lockOrder(transaction, orderId);
  const claim = await transaction.booking.findUnique({ where: { orderId }, select: { tableId: true } });
  if (claim) await lockTable(transaction, claim.tableId);

  const from: TicketStatus[] = options.terminalTicketStatus === "refunded"
    ? [TicketStatus.paid, TicketStatus.active, ...(options.refundCancelledTickets ? [TicketStatus.cancelled] : [])]
    : [TicketStatus.pending_payment, TicketStatus.paid, TicketStatus.active];
  const tickets = await transaction.ticket.findMany({
    where: { orderId, status: { in: from }, ...(ticketIds ? { id: { in: [...ticketIds] } } : {}) },
    select: { id: true, status: true, ticketTypeId: true, ticketType: { select: { isInternal: true } } },
  });
  const sold = new Map<string, number>();
  for (const ticket of tickets) {
    if (ticket.ticketType.isInternal || (ticket.status !== TicketStatus.paid && ticket.status !== TicketStatus.active)) continue;
    sold.set(ticket.ticketTypeId, (sold.get(ticket.ticketTypeId) ?? 0) + 1);
  }
  await lockTicketTypes(transaction, sold.keys());
  for (const ticketTypeId of [...sold.keys()].sort()) {
    await transaction.ticketType.update({ where: { id: ticketTypeId }, data: { quantitySold: { decrement: sold.get(ticketTypeId)! } } });
  }
  const releasedTicketIds = tickets.map((ticket) => ticket.id);
  if (releasedTicketIds.length) {
    await transaction.ticket.updateMany({
      where: { id: { in: releasedTicketIds }, status: { in: from } },
      data: options.terminalTicketStatus === "refunded" ? { status: TicketStatus.refunded, refundedAt: now } : { status: TicketStatus.cancelled, cancelledAt: now },
    });
  }
  await transaction.seatAllocation.updateMany({
    where: { ...(ticketIds ? { ticketId: { in: [...ticketIds] } } : { orderId }), status: { in: [SeatAllocationStatus.active, SeatAllocationStatus.consumed] } },
    data: { status: SeatAllocationStatus.released, releasedAt: now },
  });
  if (options.releaseOrderResources === false) return { releasedTicketIds };

  await transaction.ticketReservation.updateMany({ where: { orderId, status: TicketReservationStatus.active }, data: { status: TicketReservationStatus.released } });
  await transaction.groupPass.updateMany({ where: { orderId, status: "active" }, data: { status: "cancelled" } });
  const booking = claim ? await transaction.booking.findUnique({ where: { orderId }, include: { tableHold: true } }) : null;
  if (booking && (booking.status === BookingStatus.pending || booking.status === BookingStatus.confirmed)) {
    const lapsed = options.reason === "expired" || options.reason === "failed";
    await transaction.booking.update({ where: { id: booking.id }, data: { status: lapsed ? BookingStatus.expired : BookingStatus.cancelled } });
    const hold = booking.tableHold?.status === TableHoldStatus.active ? booking.tableHold : null;
    if (hold) await transaction.tableHold.update({ where: { id: hold.id }, data: { status: lapsed ? TableHoldStatus.expired : TableHoldStatus.released } });
    // Clear only this booking's own claim on the table: its confirmed sale or its live hold.
    const own: Prisma.TableWhereInput[] = [
      ...(booking.status === BookingStatus.confirmed ? [{ status: TableStatus.booked }] : []),
      ...(hold ? [{ status: TableStatus.held, holdToken: hold.token }] : []),
    ];
    if (own.length) {
      await transaction.table.updateMany({
        where: { id: booking.tableId, OR: own },
        data: { status: TableStatus.available, holdToken: null, holdRequestKey: null, holdExpiresAt: null },
      });
    }
  }
  return { releasedTicketIds };
}
