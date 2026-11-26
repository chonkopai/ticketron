import type { ManagementOrderDetail } from "@event-platform/shared-types";

/**
 * Refund controls are shown for settled or refunded orders, for cancelled orders, and for any order whose
 * captured payment was quarantined as review-required (including `failed` orders). The API quote decides eligibility.
 */
export function showsRefundControls(order: Pick<ManagementOrderDetail, "payment" | "reviewRequired">): boolean {
  const status = order.payment.status;
  return order.reviewRequired || status === "paid" || status === "cancelled" || status === "refunded";
}
