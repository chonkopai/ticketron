import { prisma } from "@event-platform/database";
import type { ReleaseTableHoldResponse } from "@event-platform/shared-types";

import type { TablesService } from "../tables/tables.service.js";

/**
 * Test-only fixture: the public `POST /tables/:id/hold|release` routes and their service
 * wrappers were removed. Checkout holds tables inside its own transaction
 * through `holdInTransaction`; specs that need a bare hold use the same path here.
 */
export async function holdTable(tables: TablesService, tableId: string, requestKey: string) {
  const hold = await prisma.$transaction((transaction) => tables.holdInTransaction(transaction, tableId, requestKey));
  return { tableId: hold.tableId, holdToken: hold.token, expiresAt: hold.expiresAt.toISOString() };
}

export function releaseTable(tables: TablesService, tableId: string, token: string): Promise<ReleaseTableHoldResponse> {
  return prisma.$transaction((transaction) => tables.releaseInTransaction(transaction, tableId, token));
}
