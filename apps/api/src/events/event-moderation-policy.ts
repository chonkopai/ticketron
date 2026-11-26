import type { Prisma } from "@event-platform/database";
/** Internal query helpers; preview access is supplied only by guarded staff routes. */
export const publicEventWhere = { status: "published", approvedAt: { not: null }, moderationStatus: { in: ["approved", "sales_paused"] }, organizer: { blockedAt: null } } satisfies Prisma.EventWhereInput;
export const saleEventWhere = { ...publicEventWhere, moderationStatus: "approved", salesPaused: false } satisfies Prisma.EventWhereInput;
