import type { Prisma, PrismaClient } from "@event-platform/database";
import type {
  BookingOptions,
  CancellationResponse,
  CancellationTermsResponse,
  CheckoutResponse,
  CreateCartCheckoutRequest,
  CreateSeatCheckoutRequest,
  CreateTableCheckoutRequest,
  CreateTicketCheckoutRequest,
  ManagementHoldPreview,
  ManagementHoldRelease,
} from "@event-platform/shared-types";
import { Inject, Injectable } from "@nestjs/common";

import { DATABASE_CLIENT } from "../auth/auth.constants.js";
import { DomainEventsService } from "../domain-events/domain-events.service.js";
import { PaymentService } from "../payments/payment.service.js";
import { TablesService } from "../tables/tables.service.js";
import { TicketTypesService } from "../ticket-types/ticket-types.service.js";
import { BOOKING_CLOCK, BOOKING_CONFIG, type BookingClock, type BookingConfig } from "./booking.constants.js";
import type { AnonymousCheckoutContext } from "./booking-support.js";
import { CancellationService } from "./cancellation.service.js";
import { CheckoutEmailService } from "./checkout-email.service.js";
import { CheckoutService } from "./checkout.service.js";
import type { NormalizedPaymentWebhook } from "./payment-provider.js";
import { SettlementService, type WebhookResult } from "./settlement.service.js";

export type { AnonymousCheckoutContext } from "./booking-support.js";

/**
 * Thin facade over the booking services. Controllers, the bot, staff and anonymous checkout keep
 * calling BookingService; the work lives in:
 * - CheckoutService: idempotent order creation (tickets, seats, whole tables, carts);
 * - SettlementService: provider webhooks and paid-order settlement;
 * - CancellationService: buyer cancellation, unpaid-order release and expiry, organizer hold release.
 * Inventory is returned through the shared `releaseOrderInventory` (order-release.service.ts).
 * The constructor is unchanged, so every existing caller and spec builds it the same way.
 */
@Injectable()
export class BookingService {
  readonly checkout: CheckoutService;
  readonly settlement: SettlementService;
  readonly cancellation: CancellationService;

  constructor(
    @Inject(DATABASE_CLIENT) database: PrismaClient,
    @Inject(TicketTypesService) ticketTypes: TicketTypesService,
    @Inject(TablesService) tables: TablesService,
    @Inject(DomainEventsService) domainEvents: DomainEventsService,
    @Inject(BOOKING_CONFIG) config: BookingConfig,
    @Inject(BOOKING_CLOCK) clock: BookingClock,
    @Inject(PaymentService) paymentLinks: PaymentService,
    @Inject(CheckoutEmailService) checkoutEmail?: CheckoutEmailService,
  ) {
    this.cancellation = new CancellationService(database, domainEvents, clock);
    this.settlement = new SettlementService(database, tables, domainEvents, clock, this.cancellation);
    this.checkout = new CheckoutService(database, ticketTypes, tables, domainEvents, config, clock, paymentLinks, this.settlement, checkoutEmail);
  }

  // Checkout
  checkoutCart(userId: string, rawKey: string | undefined, input: CreateCartCheckoutRequest, anonymous?: AnonymousCheckoutContext, sessionFamilyId?: string): Promise<CheckoutResponse> {
    return this.checkout.checkoutCart(userId, rawKey, input, anonymous, sessionFamilyId);
  }
  checkoutTickets(userId: string, rawKey: string | undefined, input: CreateTicketCheckoutRequest, anonymous?: AnonymousCheckoutContext, sessionFamilyId?: string): Promise<CheckoutResponse> {
    return this.checkout.checkoutTickets(userId, rawKey, input, anonymous, sessionFamilyId);
  }
  checkoutTable(userId: string, rawKey: string | undefined, input: CreateTableCheckoutRequest, anonymous?: AnonymousCheckoutContext, sessionFamilyId?: string): Promise<CheckoutResponse> {
    return this.checkout.checkoutTable(userId, rawKey, input, anonymous, sessionFamilyId);
  }
  checkoutSeats(userId: string, rawKey: string | undefined, input: CreateSeatCheckoutRequest, anonymous?: AnonymousCheckoutContext, sessionFamilyId?: string): Promise<CheckoutResponse> {
    return this.checkout.checkoutSeats(userId, rawKey, input, anonymous, sessionFamilyId);
  }
  options(userId: string, eventId: string): Promise<BookingOptions> {
    return this.checkout.options(userId, eventId);
  }

  // Settlement
  settleSucceeded(orderId: string): Promise<void> {
    return this.settlement.settleSucceeded(orderId);
  }
  settleSucceededInTransaction(transaction: Prisma.TransactionClient, orderId: string): Promise<void> {
    return this.settlement.settleSucceededInTransaction(transaction, orderId);
  }
  handlePaymentWebhook(webhook: NormalizedPaymentWebhook): Promise<WebhookResult> {
    return this.settlement.handlePaymentWebhook(webhook);
  }

  // Cancellation, release and expiry
  settleFailed(orderId: string, reason: "failed" | "expired" = "failed"): Promise<void> {
    return this.cancellation.settleFailed(orderId, reason);
  }
  failOrderInTransaction(transaction: Prisma.TransactionClient, orderId: string, reason: "failed" | "expired" | "released"): Promise<void> {
    return this.cancellation.failOrderInTransaction(transaction, orderId, reason);
  }
  organizerHoldPreview(organizerId: string, eventId: string, orderId: string): Promise<ManagementHoldPreview> {
    return this.cancellation.organizerHoldPreview(organizerId, eventId, orderId);
  }
  organizerReleaseHold(organizerId: string, eventId: string, orderId: string): Promise<ManagementHoldRelease> {
    return this.cancellation.organizerReleaseHold(organizerId, eventId, orderId);
  }
  expireDueCheckouts(limit: number): Promise<number> {
    return this.cancellation.expireDueCheckouts(limit);
  }
  expireOrderIfDue(userId: string, orderId: string): Promise<void> {
    return this.cancellation.expireOrderIfDue(userId, orderId);
  }
  ticketCancellationTerms(userId: string, id: string): Promise<CancellationTermsResponse> {
    return this.cancellation.ticketCancellationTerms(userId, id);
  }
  bookingCancellationTerms(userId: string, id: string): Promise<CancellationTermsResponse> {
    return this.cancellation.bookingCancellationTerms(userId, id);
  }
  cancelTicket(userId: string, id: string, rawKey: string | undefined): Promise<CancellationResponse> {
    return this.cancellation.cancelTicket(userId, id, rawKey);
  }
  cancelBooking(userId: string, id: string, rawKey: string | undefined): Promise<CancellationResponse> {
    return this.cancellation.cancelBooking(userId, id, rawKey);
  }
}
