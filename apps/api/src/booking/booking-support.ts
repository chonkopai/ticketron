import { readCheckoutSnapshot } from "@event-platform/shared-types";
import { createHash } from "node:crypto";
import { Prisma } from "@event-platform/database";
import { type CancellationResponse, type CheckoutResponse, type CheckoutSnapshot, type CreateTableCheckoutRequest, type CreateSeatCheckoutRequest, type CreateTicketCheckoutRequest, type CreateCartCheckoutRequest, type BotCheckoutQuote, type TelegramSeatQuote } from "@event-platform/shared-types";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { normalizeContact } from "../auth/contact-identity.js";

// Helpers shared by the checkout, settlement and cancellation services (moved from booking.service.ts).
export const TICKET_CHECKOUT = "checkout.ticket";
export const TABLE_CHECKOUT = "checkout.table";
export const SEAT_CHECKOUT = "checkout.seats";
export const CART_CHECKOUT = "checkout.cart";
export const TICKET_CANCEL = "cancel.ticket";
export const BOOKING_CANCEL = "cancel.booking";

/** Internal only: the anonymous boundary owns authorization, idempotency and the transaction. */
export interface AnonymousCheckoutContext {
  transaction: Prisma.TransactionClient;
  guestContact: Prisma.InputJsonObject;
  sessionId: string;
  verifiedEmail: string | null;
  botOffer?: BotCheckoutQuote | TelegramSeatQuote;
}
export async function claim(transaction: Prisma.TransactionClient, userId: string, operation: string, key: string, fingerprint: string, requestedEmail: boolean): Promise<CheckoutResponse | null> {
  const prior = await transaction.idempotencyRecord.findUnique({ where: { userId_operation_key: { userId, operation, key } } });
  if (prior && (prior.requestHash ? prior.requestHash !== fingerprint : requestedEmail)) throw new ConflictException({ code: "IDEMPOTENCY_CONFLICT" });
  if (prior?.response) return checkoutResponse(prior.response);
  if (prior) throw new ConflictException({ code: "IDEMPOTENCY_IN_PROGRESS", message: "An identical request is still processing" });
  await transaction.idempotencyRecord.create({ data: { userId, operation, key, requestHash: fingerprint } });
  return null;
}

export function checkoutFingerprint(input: CreateCartCheckoutRequest | CreateSeatCheckoutRequest | CreateTableCheckoutRequest | CreateTicketCheckoutRequest): string {
  const emailDelivery = input.emailDelivery ? { address: normalizeContact("email", input.emailDelivery.address) } : null;
  return createHash("sha256").update(JSON.stringify({ ...input, emailDelivery })).digest("hex");
}

export async function claimCancellation(transaction: Prisma.TransactionClient, userId: string, operation: string, key: string): Promise<CancellationResponse | null> {
  const prior = await transaction.idempotencyRecord.findUnique({ where: { userId_operation_key: { userId, operation, key } } });
  if (prior?.response) return cancellationResponse(prior.response);
  if (prior) throw new ConflictException({ code: "IDEMPOTENCY_IN_PROGRESS", message: "An identical request is still processing" });
  await transaction.idempotencyRecord.create({ data: { userId, operation, key } });
  return null;
}

export async function saveResponse(transaction: Prisma.TransactionClient, userId: string, operation: string, key: string, resourceId: string, response: CheckoutResponse | CancellationResponse): Promise<void> {
  await transaction.idempotencyRecord.update({
    where: { userId_operation_key: { userId, operation, key } },
    data: { resourceId, response: json(response) },
  });
}
export function snapshot(value: Prisma.JsonValue): CheckoutSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConflictException({ code: "CHECKOUT_SNAPSHOT_INVALID", message: "Checkout snapshot is unavailable" });
  return readCheckoutSnapshot(value);
}

export function checkoutResponse(value: Prisma.JsonValue): CheckoutResponse { return value as unknown as CheckoutResponse; }
export function cancellationResponse(value: Prisma.JsonValue): CancellationResponse { return value as unknown as CancellationResponse; }
export function json(value: object): Prisma.InputJsonObject { return value as unknown as Prisma.InputJsonObject; }
export function isUniqueError(error: unknown): boolean { return (error as { code?: string }).code === "P2002"; }
export function idempotencyKey(value: string | undefined): string {
  const key = value?.trim();
  if (!key || key.length < 8 || key.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw new BadRequestException({ code: "IDEMPOTENCY_KEY_INVALID", message: "Idempotency-Key must contain 8-128 safe characters" });
  }
  return key;
}
export function orderNotFound(): NotFoundException { return resourceNotFound("ORDER_NOT_FOUND"); }
export function resourceNotFound(code: string): NotFoundException { return new NotFoundException({ code, message: "Resource was not found" }); }
