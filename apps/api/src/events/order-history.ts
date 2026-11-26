/** Outbox event types shown in the organizer order history (and therefore never pruned from the outbox). */
export const SAFE_ORDER_HISTORY = new Set([
  "order.claimed",
  "payment.attempt_created",
  "payment.succeeded",
  "payment.failed",
  "payment.review_required",
  "checkout.paid",
  "checkout.expired",
  "ticket.cancelled",
  "booking.cancelled",
  "booking.booking_cancelled",
  "refund.requested",
  "refund.operation_requested",
  "refund.succeeded",
  "checkout.hold_released",
]);
