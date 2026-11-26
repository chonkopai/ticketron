import type { Table } from "@event-platform/database";
import type { VenueSeat, VenueTable } from "@event-platform/shared-types";

type TableWithSeats = Table & { seatRecords?: Array<{ id: string; number: number; label: string; sortOrder: number; status: "available" | "disabled"; tableId: string | null; rowId: string | null; ticketTypeId: string | null }> };

/**
 * A hold whose expiry has passed is no longer a hold, even if the cleanup worker has not
 * run yet: readers present such a table exactly as the expiry would leave it (available,
 * no hold fields). Mirrors TablesService.expireLocked; seat rows are untouched by it.
 */
export function holdLapsed(table: Pick<Table, "status" | "holdToken" | "holdExpiresAt">, now: Date): boolean {
  return table.status === "held" && Boolean(table.holdToken) && table.holdExpiresAt !== null && table.holdExpiresAt <= now;
}

export function presentTable(source: TableWithSeats, now?: Date): VenueTable {
  const table = now && holdLapsed(source, now) ? { ...source, status: "available" as const, holdToken: null, holdRequestKey: null, holdExpiresAt: null } : source;
  return {
    id: table.id,
    venueLayoutId: table.venueLayoutId,
    number: table.number,
    name: table.name,
    seats: table.seats,
    price: table.price,
    deposit: table.deposit,
    currency: table.currency,
    description: table.description,
    typeLabel: table.typeLabel,
    shortDescription: table.shortDescription,
    saleMode: table.saleMode,
    status: table.status,
    holdExpiresAt: table.holdExpiresAt?.toISOString() ?? null,
    ...(table.seatRecords ? { seatRecords: table.seatRecords.map((seat): VenueSeat => ({
      id: seat.id,
      number: seat.number,
      label: seat.label,
      sortOrder: seat.sortOrder,
      status: seat.status,
      tableId: seat.tableId,
      rowId: seat.rowId,
      ticketTypeId: seat.ticketTypeId,
    })) } : {}),
  };
}
