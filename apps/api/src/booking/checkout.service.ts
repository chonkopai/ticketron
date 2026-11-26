import { publicEventWhere } from "../events/event-moderation-policy.js";
import { assertEventRegistrationOpen } from "../events/event-registration-policy.js";
import { assertCurrentSale } from "../events/current-sale-policy.js";
import { acceptedSnapshot } from "./accepted-policy-snapshot.js";
import { readCheckoutSnapshot } from "@event-platform/shared-types";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EventPaymentMode, EventStatus, OrderType, Prisma, SeatAllocationStatus, SeatStatus, TableSaleMode, TableStatus, TicketStatus, TicketTypeStatus, type PrismaClient } from "@event-platform/database";
import { cartRuleViolation, CART_SELECTION_INVALID_MESSAGE, venueLayoutSchemaAny, publishedHallV3Schema, checkedOrderTotal, type EventLocale, type BookingOptions, type CheckoutResponse, type CheckoutSnapshot, type CreateTableCheckoutRequest, type CreateSeatCheckoutRequest, type CreateTicketCheckoutRequest, type CreateCartCheckoutRequest, type CheckoutEmailChoice } from "@event-platform/shared-types";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { readCanonicalHall,canonicalHallCompatibility } from "../venue/canonical-hall.compat.js";
import { DomainEventsService } from "../domain-events/domain-events.service.js";
import { TablesService } from "../tables/tables.service.js";
import { TicketTypesService } from "../ticket-types/ticket-types.service.js";
import { lockSeat, lockTable, lockTicketTypes, seatTicketTypeIds } from "./inventory-locks.js";
import { type BookingClock, type BookingConfig } from "./booking.constants.js";
import { PaymentService } from "../payments/payment.service.js";
import { CheckoutEmailService } from "./checkout-email.service.js";
import { TICKET_CHECKOUT, TABLE_CHECKOUT, SEAT_CHECKOUT, CART_CHECKOUT, type AnonymousCheckoutContext, claim, checkoutFingerprint, saveResponse, checkoutResponse, json, isUniqueError, idempotencyKey } from "./booking-support.js";
import type { SettlementService } from "./settlement.service.js";

/** Checkout: idempotent order creation for tickets, seats, whole tables and carts (split from BookingService). */
export class CheckoutService {
  constructor(
    private readonly database: PrismaClient,
    private readonly ticketTypes: TicketTypesService,
    private readonly tables: TablesService,
    private readonly domainEvents: DomainEventsService,
    private readonly config: BookingConfig,
    private readonly clock: BookingClock,
    private readonly paymentLinks: PaymentService,
    private readonly settlement: SettlementService,
    private readonly checkoutEmail?: CheckoutEmailService,
  ) {}

  async checkoutCart(userId: string, rawKey: string | undefined, input: CreateCartCheckoutRequest, anonymous?: AnonymousCheckoutContext, sessionFamilyId?: string): Promise<CheckoutResponse> {
    idempotencyKey(rawKey); // a malformed key is reported before the selection, as before
    if (cartRuleViolation(input) !== null) throw new BadRequestException({ code: "CART_SELECTION_INVALID", message: CART_SELECTION_INVALID_MESSAGE });
    const tickets = input.tickets ?? [];
    const seatIds = input.seatIds ?? [];
    return this.run(CART_CHECKOUT, userId, rawKey, input, anonymous, async (transaction, key) => {
      if (anonymous?.botOffer?.kind === "cart") {
        // Freeze the sale revision before reading its priced inventory.
        await transaction.$queryRaw`SELECT id FROM "Event" WHERE id=${input.eventId}::uuid FOR SHARE`;
      }
      // Prices are read only after the inventory locks; ticket types are locked sorted.
      for (const id of [...seatIds].sort()) await lockSeat(transaction, id);
      if (input.tableId) await lockTable(transaction, input.tableId);
      await lockTicketTypes(transaction, [...tickets.map((item) => item.ticketTypeId), ...await seatTicketTypeIds(transaction, seatIds)]);
      const event = await transaction.event.findFirst({ where: { id: input.eventId, status: EventStatus.published } });
      if (!event) throw new NotFoundException({ code: "EVENT_NOT_FOUND", message: "Event was not found" });
      assertCurrentSale(event);
      const now = this.clock.now();
      assertEventRegistrationOpen(event, now);
      const configuredExpiry = new Date(now.getTime() + this.config.checkoutTtlSeconds * 1_000);
      const types = tickets.length ? await transaction.ticketType.findMany({ where: { id: { in: tickets.map((item) => item.ticketTypeId) }, eventId: event.id, isInternal: false, seats: { none: {} }, status: TicketTypeStatus.active } }) : [];
      if (types.length !== tickets.length || types.some((type) => (type.salesStartAt && type.salesStartAt > now) || (type.salesEndAt && type.salesEndAt <= now))) throw new ConflictException({ code: "TICKET_UNAVAILABLE", message: "A selected ticket is unavailable" });
      const seats = seatIds.length ? await transaction.seat.findMany({ where: { id: { in: seatIds } }, include: {
        ticketType: true, table: { select: { number: true, saleMode: true, status: true, venueLayoutId: true } }, row: { select: { number: true, status: true, venueLayoutId: true } },
        allocations: { where: { status: { in: [SeatAllocationStatus.active, SeatAllocationStatus.consumed] } }, select: { id: true } },
      } }) : [];
      if (seats.length !== seatIds.length || seats.some((seat) => seat.status !== SeatStatus.available || seat.allocations.length || !seat.ticketType || seat.ticketType.eventId !== event.id || seat.ticketType.status !== TicketTypeStatus.active || (seat.table && (seat.table.saleMode !== TableSaleMode.per_seat || seat.table.venueLayoutId !== seat.venueLayoutId)) || (seat.row && seat.row.venueLayoutId !== seat.venueLayoutId))) throw new ConflictException({ code: "SEAT_UNAVAILABLE", message: "A selected seat is unavailable" });
      if (anonymous?.botOffer?.kind === "cart" && seats.some(seat =>
        (seat.table && seat.table.status !== TableStatus.available) || (seat.row && seat.row.status !== TableStatus.available))) {
        throw new ConflictException({ code: "SEAT_UNAVAILABLE" });
      }
      if (seatIds.length) {
        const locked = await transaction.seat.findMany({ where: { id: { in: seatIds } }, include: { allocations: { where: { status: { in: [SeatAllocationStatus.active, SeatAllocationStatus.consumed] } }, select: { id: true } } } });
        if (locked.some((seat) => seat.status !== SeatStatus.available || seat.allocations.length)) throw new ConflictException({ code: "SEAT_UNAVAILABLE", message: "A selected seat is unavailable" });
      }
      if (seats.some((seat) => (seat.ticketType!.salesStartAt && seat.ticketType!.salesStartAt > now) || (seat.ticketType!.salesEndAt && seat.ticketType!.salesEndAt <= now))) throw new ConflictException({ code: "SEAT_SALES_WINDOW_CLOSED", message: "Selected seats are not currently on sale" });
      const table = input.tableId ? await transaction.table.findFirst({ where: { id: input.tableId, venueLayout: { eventId: event.id } }, include: { seatRecords: { orderBy: { sortOrder: "asc" } } } }) : null;
      if (input.tableId && (!table || table.saleMode !== TableSaleMode.whole_table)) throw new ConflictException({ code: "TABLE_UNAVAILABLE", message: "Selected table is unavailable" });
      const currencies = [...types.map((type) => type.currency.trim()), ...seats.map((seat) => seat.ticketType!.currency.trim()), ...(table ? [table.currency.trim()] : [])];
      const currency = currencies[0]!;
      if (currencies.some((value) => value !== currency)) throw new ConflictException({ code: "CART_CURRENCY_MISMATCH", message: "All selections must use the same currency" });
      const full = tickets.reduce((sum, item) => sum + types.find((type) => type.id === item.ticketTypeId)!.price * item.quantity, 0)
        + seats.reduce((sum, seat) => sum + seat.ticketType!.price, 0) + (table?.price ?? 0);
      const due = full;
      assertChargeTotal(full);assertChargeTotal(due);
      const orderId = randomUUID();
      let hold: Awaited<ReturnType<TablesService["holdInTransaction"]>> | null = null;
      let includedSeats: Awaited<ReturnType<typeof ensureWholeTableSeats>> = [];
      if (table) {
        const holdKey = `checkout-${createHash("sha256").update(`${userId}:${key}`).digest("hex")}`;
        hold = await this.tables.holdInTransaction(transaction, table.id, holdKey, now);
        includedSeats = await ensureWholeTableSeats(transaction, table.id, table.venueLayoutId, table.seats, table.seatRecords);
      }
      const expiresAt = hold && hold.expiresAt < configuredExpiry ? hold.expiresAt : configuredExpiry;
      const fullAmount = full;
      const itemLabels = [
        ...tickets.map((item) => ({ kind: "ticket" as const, id: item.ticketTypeId, name: types.find((type) => type.id === item.ticketTypeId)!.name, quantity: item.quantity, amountDue: (types.find((type) => type.id === item.ticketTypeId)!.price) * item.quantity })),
        ...seats.map((seat) => ({ kind: "seat" as const, id: seat.id, name: seat.label, quantity: 1, amountDue: seat.ticketType!.price })),
        ...(table ? [{ kind: "table" as const, id: table.id, name: table.name ?? `Стол №${table.number}`, quantity: 1, amountDue: table.price }] : []),
      ];
      const snapshot: CheckoutSnapshot = { eventId: event.id, eventTitle: event.title, eventDate: event.date.toISOString().slice(0, 10), eventTime: event.time.toISOString().slice(11, 16), eventTimezone: event.timezone, address: event.address, itemId: itemLabels[0]!.id, itemName: itemLabels.map((item) => item.name).join(", "), itemKind: "cart", quantity: itemLabels.reduce((sum, item) => sum + item.quantity, 0), paymentMode: event.paymentMode, paymentLabel: event.paymentMode, unitFullAmount: full, fullAmount, amountDue: due, currency, cancellationTerms: event.cancellationTerms, depositTerms: event.depositTerms, items: itemLabels,
        seatIds: [...seatIds, ...includedSeats.map((seat) => seat.id)], groupPass: Boolean(table) };
      const deliveryEmail = await this.resolveEmail(transaction, userId, input.emailDelivery, sessionFamilyId, anonymous);
      const frozen=await acceptedSnapshot(transaction,event,snapshot,input,now,anonymous?.botOffer);
      await transaction.order.create({ data: { id: orderId, type: OrderType.ticket, eventId: event.id, buyerUserId: anonymous ? null : userId, ...(anonymous ? { guestContact: anonymous.guestContact } : {}), amount: due, currency, checkoutSnapshot: frozen, termsAcceptedAt: now, expiresAt, emailDeliveryAddress: deliveryEmail, emailDeliveryRequestedAt: deliveryEmail ? now : null } });
      const ticketIds: string[] = [];
      for (const item of tickets) {
        await this.ticketTypes.reserveInTransaction(transaction, item.ticketTypeId, item.quantity, expiresAt, orderId, now);
        for (let index = 0; index < item.quantity; index++) {
          const ticket = await transaction.ticket.create({ data: { ticketTypeId: item.ticketTypeId, orderId, ownerUserId: anonymous ? null : userId, qrToken: randomBytes(32).toString("base64url"), status: TicketStatus.pending_payment } });
          ticketIds.push(ticket.id);
        }
      }
      for (const seat of seats) {
        const label = seat.table ? `Стол ${seat.table.number} · Место ${seat.number}` : `Ряд ${seat.row?.number ?? ""} · Место ${seat.number}`;
        const ticket = await transaction.ticket.create({ data: { ticketTypeId: seat.ticketType!.id, orderId, ownerUserId: anonymous ? null : userId, qrToken: randomBytes(32).toString("base64url"), seatLabelSnapshot: frozenSeatLabel(frozen,seat.id,label), status: TicketStatus.pending_payment } });
        ticketIds.push(ticket.id);
        await transaction.seatAllocation.create({ data: { seatId: seat.id, orderId, ticketId: ticket.id } });
      }
      let bookingId: string | null = null;
      let groupPassId: string | null = null;
      if (table && hold) {
        const booking = await transaction.booking.create({ data: { tableId: table.id, orderId, tableHoldId: hold.id, ...(anonymous ? { guestContact: anonymous.guestContact } : {}) } });
        bookingId = booking.id;
        const admissionType = await ensureAdmissionTicketType(transaction, event.id, table.id, currency);
        for (const seat of includedSeats) {
          const ticket = await transaction.ticket.create({ data: { ticketTypeId: admissionType.id, orderId, ownerUserId: anonymous ? null : userId, qrToken: randomBytes(32).toString("base64url"), seatLabelSnapshot: frozenSeatLabel(frozen,seat.id,`Стол ${table.number} · Место ${seat.number}`), status: TicketStatus.pending_payment } });
          ticketIds.push(ticket.id);
          await transaction.seatAllocation.create({ data: { seatId: seat.id, orderId, ticketId: ticket.id } });
        }
        const pass = await transaction.groupPass.create({ data: { orderId, tableId: table.id, token: randomBytes(32).toString("base64url"), totalSeats: includedSeats.length } });
        groupPassId = pass.id;
      }
      const response: CheckoutResponse = { orderId, kind: "cart", paymentMode: event.paymentMode, paymentLabel: event.paymentMode, amountDue: due, fullAmount, currency, paymentLink: "", expiresAt: expiresAt.toISOString(), ticketIds, bookingId, emailDelivery: deliveryEmail ? { address: deliveryEmail, status: "pending_payment" } : null, ...(groupPassId ? { groupPassId, groupPassQrPath: `/me/group-passes/${groupPassId}/qr` } : {}) };
      await this.domainEvents.append(transaction, { eventType: "checkout.cart_created", aggregateType: "order", aggregateId: orderId, payload: { userId: anonymous ? null : userId, eventId: event.id, items: itemLabels, amountDue: due } });
      return response;
    });
  }

  async checkoutTickets(
    userId: string,
    rawKey: string | undefined,
    input: CreateTicketCheckoutRequest,
    anonymous?: AnonymousCheckoutContext,
    sessionFamilyId?: string,
  ): Promise<CheckoutResponse> {

    return this.run(TICKET_CHECKOUT, userId, rawKey, input, anonymous, async (transaction) => {

      await lockTicketTypes(transaction, [input.ticketTypeId]); // read the price under the writer's lock
      const ticketType = await transaction.ticketType.findFirst({
        where: { id: input.ticketTypeId, isInternal: false, seats: { none: {} }, status: TicketTypeStatus.active, event: { status: EventStatus.published } },
        include: { event: true },
      });
      if (!ticketType) throw new NotFoundException({ code: "TICKET_TYPE_NOT_FOUND", message: "Ticket type was not found" });
      assertCurrentSale(ticketType.event);

      const now = this.clock.now();
      assertEventRegistrationOpen(ticketType.event, now);
      const expiresAt = new Date(now.getTime() + this.config.checkoutTtlSeconds * 1_000);
      const amounts = paymentAmounts(ticketType.event, ticketType.price, input.quantity);
      const snapshot: CheckoutSnapshot = {
        eventId: ticketType.eventId,
        eventTitle: ticketType.event.title,
        eventDate: ticketType.event.date.toISOString().slice(0, 10),
        eventTime: ticketType.event.time.toISOString().slice(11, 16),
        eventTimezone: ticketType.event.timezone,
        address: ticketType.event.address,
        itemId: ticketType.id,
        itemName: ticketType.name,
        itemKind: "ticket",
        quantity: input.quantity,
        paymentMode: ticketType.event.paymentMode,
        paymentLabel: ticketType.event.paymentMode,
        unitFullAmount: ticketType.price,
        fullAmount: amounts.fullAmount,
        amountDue: amounts.amountDue,
        currency: ticketType.currency.trim(),
        cancellationTerms: ticketType.event.cancellationTerms,
        depositTerms: ticketType.event.depositTerms,
      };
      const orderId = randomUUID();
      const deliveryEmail = await this.resolveEmail(transaction, userId, input.emailDelivery, sessionFamilyId, anonymous);
      const frozen=await acceptedSnapshot(transaction,ticketType.event,snapshot,input,now,anonymous?.botOffer);
      await transaction.order.create({
        data: {
          id: orderId,
          type: OrderType.ticket,
          eventId: ticketType.event.id,
          buyerUserId: anonymous ? null : userId,
          ...(anonymous ? { guestContact: anonymous.guestContact } : {}),
          amount: amounts.amountDue,
          currency: snapshot.currency,
          checkoutSnapshot: frozen,
          emailDeliveryAddress: deliveryEmail,
          emailDeliveryRequestedAt: deliveryEmail ? now : null,
          termsAcceptedAt: now,
          expiresAt,
        },
      });
      await this.ticketTypes.reserveInTransaction(transaction, ticketType.id, input.quantity, expiresAt, orderId, now);
      const tickets: Array<{ id: string }> = [];
      for (let index = 0; index < input.quantity; index += 1) {
        tickets.push(await transaction.ticket.create({
          data: {
            ticketTypeId: ticketType.id,
            orderId,
            ownerUserId: anonymous ? null : userId,
            qrToken: randomBytes(32).toString("base64url"),
            status: TicketStatus.pending_payment,
          },
          select: { id: true },
        }));
      }
      const response: CheckoutResponse = {
        orderId,
        kind: "ticket",
        paymentMode: snapshot.paymentMode,
        paymentLabel: snapshot.paymentLabel,
        amountDue: snapshot.amountDue,
        fullAmount: snapshot.fullAmount,
        currency: snapshot.currency,
        paymentLink: "",
        expiresAt: expiresAt.toISOString(),
        ticketIds: tickets.map(({ id }) => id),
        bookingId: null,
        emailDelivery: deliveryEmail ? { address: deliveryEmail, status: "pending_payment" } : null,
      };
      await this.domainEvents.append(transaction, {
        eventType: "checkout.ticket_created",
        aggregateType: "order",
        aggregateId: orderId,
        payload: { userId: anonymous ? null : userId, ...(anonymous ? { anonymousSessionId: userId } : {}), eventId: ticketType.eventId, ticketTypeId: ticketType.id, quantity: input.quantity, amountDue: amounts.amountDue },
      });
      return response;
    });
  }

  async checkoutTable(
    userId: string,
    rawKey: string | undefined,
    input: CreateTableCheckoutRequest,
    anonymous?: AnonymousCheckoutContext,
    sessionFamilyId?: string,
  ): Promise<CheckoutResponse> {
    return this.run(TABLE_CHECKOUT, userId, rawKey, input, anonymous, async (transaction, key) => {
      await lockTable(transaction, input.tableId); // read the price under the writer's lock
      const table = await transaction.table.findFirst({
        where: { id: input.tableId, venueLayout: { event: { status: EventStatus.published } } },
        include: { seatRecords: { orderBy: { sortOrder: "asc" } }, venueLayout: { include: { event: true } } },
      });
      const event = table?.venueLayout.event;
      if (!table || !event) throw new NotFoundException({ code: "TABLE_NOT_FOUND", message: "Table was not found" });
      if (table.saleMode === TableSaleMode.per_seat) throw new ConflictException({ code: "TABLE_REQUIRES_SEAT_SELECTION", message: "Select individual seats for this table" });

      const now = this.clock.now();
      assertEventRegistrationOpen(event, now);
      const configuredExpiry = new Date(now.getTime() + this.config.checkoutTtlSeconds * 1_000);
      const holdKey = `checkout-${createHash("sha256").update(`${userId}:${key}`).digest("hex")}`;
      const hold = await this.tables.holdInTransaction(transaction, table.id, holdKey, now);
      const includedSeats = await ensureWholeTableSeats(transaction, table.id, table.venueLayoutId, table.seats, table.seatRecords);
      const expiresAt = hold.expiresAt < configuredExpiry ? hold.expiresAt : configuredExpiry;
      const amounts = paymentAmounts(event, table.price, 1);
      const snapshot: CheckoutSnapshot = {
        eventId: event.id,
        eventTitle: event.title,
        eventDate: event.date.toISOString().slice(0, 10),
        eventTime: event.time.toISOString().slice(11, 16),
        eventTimezone: event.timezone,
        address: event.address,
        itemId: table.id,
        itemName: table.name ?? `Стол №${table.number}`,
        itemKind: "table",
        quantity: 1,
        paymentMode: event.paymentMode,
        paymentLabel: event.paymentMode,
        unitFullAmount: table.price,
        fullAmount: amounts.fullAmount,
        amountDue: amounts.amountDue,
        currency: table.currency.trim(),
        cancellationTerms: event.cancellationTerms,
        depositTerms: event.depositTerms,
        seatIds: includedSeats.map((seat) => seat.id),
        seatLabels: includedSeats.map((seat) => `Стол ${table.number} · Место ${seat.number}`),
        seatAssignments: includedSeats.map((seat) => ({ seatId: seat.id, seatNumber: seat.number, parentKind: "table", parentNumber: table.number, displayLabel: `Стол ${table.number} · Место ${seat.number}` })),
        groupPass: true,
      };
      const orderId = randomUUID();
      const deliveryEmail = await this.resolveEmail(transaction, userId, input.emailDelivery, sessionFamilyId, anonymous);
      const frozen=await acceptedSnapshot(transaction,event,snapshot,input,now,anonymous?.botOffer);
      await transaction.order.create({
        data: {
          id: orderId,
          type: OrderType.table,
          eventId: event.id,
          buyerUserId: anonymous ? null : userId,
          ...(anonymous ? { guestContact: anonymous.guestContact } : {}),
          amount: amounts.amountDue,
          currency: snapshot.currency,
          checkoutSnapshot: frozen,
          emailDeliveryAddress: deliveryEmail,
          emailDeliveryRequestedAt: deliveryEmail ? now : null,
          termsAcceptedAt: now,
          expiresAt,
        },
      });
      const booking = await transaction.booking.create({
        data: { tableId: table.id, orderId, tableHoldId: hold.id, ...(anonymous ? { guestContact: anonymous.guestContact } : {}) },
      });
      const admissionType = await ensureAdmissionTicketType(transaction, event.id, table.id, table.currency.trim());
      const individualTicketIds: string[] = [];
      for (const seat of includedSeats) {
        const ticket = await transaction.ticket.create({ data: { ticketTypeId: admissionType.id, orderId, ownerUserId: anonymous ? null : userId, qrToken: randomBytes(32).toString("base64url"), seatLabelSnapshot: frozenSeatLabel(frozen,seat.id,`Стол ${table.number} · Место ${seat.number}`), status: TicketStatus.pending_payment } });
        individualTicketIds.push(ticket.id);
        await transaction.seatAllocation.create({ data: { seatId: seat.id, orderId, ticketId: ticket.id } });
      }
      const groupPass = await transaction.groupPass.create({ data: { orderId, tableId: table.id, token: randomBytes(32).toString("base64url"), totalSeats: includedSeats.length } });
      const response: CheckoutResponse = {
        orderId,
        kind: "table",
        paymentMode: snapshot.paymentMode,
        paymentLabel: snapshot.paymentLabel,
        amountDue: snapshot.amountDue,
        fullAmount: snapshot.fullAmount,
        currency: snapshot.currency,
        paymentLink: "",
        expiresAt: expiresAt.toISOString(),
        ticketIds: individualTicketIds,
        bookingId: booking.id,
        groupPassId: groupPass.id,
        groupPassQrPath: `/me/group-passes/${groupPass.id}/qr`,
        emailDelivery: deliveryEmail ? { address: deliveryEmail, status: "pending_payment" } : null,
      };
      await this.domainEvents.append(transaction, {
        eventType: "checkout.table_created",
        aggregateType: "order",
        aggregateId: orderId,
        payload: { userId: anonymous ? null : userId, ...(anonymous ? { anonymousSessionId: userId } : {}), eventId: event.id, tableId: table.id, bookingId: booking.id, ticketIds: individualTicketIds, groupPassId: groupPass.id, amountDue: amounts.amountDue },
      });
      return response;
    });
  }

  async checkoutSeats(
    userId: string,
    rawKey: string | undefined,
    input: CreateSeatCheckoutRequest,
    anonymous?: AnonymousCheckoutContext,
    sessionFamilyId?: string,
  ): Promise<CheckoutResponse> {
    idempotencyKey(rawKey);
    const seatIds = [...new Set(input.seatIds)];
    if (seatIds.length < 1 || seatIds.length > 10 || seatIds.length !== input.seatIds.length) {
      throw new BadRequestException({ code: "SEAT_SELECTION_INVALID", message: "Choose between 1 and 10 different seats" });
    }
    return this.run(SEAT_CHECKOUT, userId, rawKey, input, anonymous, async (transaction) => {
      // Lock seats, then the ticket types that price them, before reading prices.
      for (const id of [...seatIds].sort()) await lockSeat(transaction, id);
      await lockTicketTypes(transaction, await seatTicketTypeIds(transaction, seatIds));
      const seats = await transaction.seat.findMany({
        where: { id: { in: seatIds } },
        include: {
          ticketType: { include: { event: true } },
          table: { select: { id: true, number: true, saleMode: true, venueLayoutId: true } },
          row: { select: { id: true, number: true, venueLayoutId: true } },
          allocations: { where: { status: { in: [SeatAllocationStatus.active, SeatAllocationStatus.consumed] } }, select: { id: true } },
        },
      });
      if (seats.length !== seatIds.length || seats.some((seat) => seat.status !== SeatStatus.available || !seat.ticketType || seat.ticketType.status !== TicketTypeStatus.active)) {
        throw new ConflictException({ code: "SEAT_UNAVAILABLE", message: "One or more selected seats are unavailable" });
      }
      if (seats.some((seat) => seat.table && seat.table.saleMode !== TableSaleMode.per_seat)) {
        throw new ConflictException({ code: "SEAT_SALE_MODE_INVALID", message: "This table is sold as a whole" });
      }
      const event = seats[0]!.ticketType!.event;
      assertCurrentSale(event);
      if (event.status !== EventStatus.published || seats.some((seat) => seat.ticketType!.eventId !== event.id || seat.allocations.length > 0 || (seat.table && seat.table.venueLayoutId !== seat.venueLayoutId) || (seat.row && seat.row.venueLayoutId !== seat.venueLayoutId))) {
        throw new ConflictException({ code: "SEAT_UNAVAILABLE", message: "One or more selected seats are unavailable" });
      }
      const locked = await transaction.seat.findMany({ where: { id: { in: seatIds } }, include: { allocations: { where: { status: { in: [SeatAllocationStatus.active, SeatAllocationStatus.consumed] } }, select: { id: true } } } });
      if (locked.some((seat) => seat.status !== SeatStatus.available || seat.allocations.length > 0)) throw new ConflictException({ code: "SEAT_UNAVAILABLE", message: "One or more selected seats are unavailable" });
      const now = this.clock.now();
      assertEventRegistrationOpen(event, now);
      if (seats.some((seat) => (seat.ticketType!.salesStartAt && seat.ticketType!.salesStartAt > now) || (seat.ticketType!.salesEndAt && seat.ticketType!.salesEndAt <= now))) {
        throw new ConflictException({ code: "SEAT_SALES_WINDOW_CLOSED", message: "Selected seats are not currently on sale" });
      }
      const expiresAt = new Date(now.getTime() + this.config.checkoutTtlSeconds * 1_000);
      const currency = seats[0]!.ticketType!.currency.trim();
      if (seats.some((seat) => seat.ticketType!.currency.trim() !== currency)) throw new ConflictException({ code: "SEAT_CURRENCY_MISMATCH", message: "Selected seats use different currencies" });
      const fullAmount = seats.reduce((sum, seat) => sum + seat.ticketType!.price, 0);
      const amountDue = fullAmount;
      assertChargeTotal(fullAmount);assertChargeTotal(amountDue);
      const seatAssignments = seats.map((seat) => seat.table
        ? { seatId: seat.id, seatNumber: seat.number, parentKind: "table" as const, parentNumber: seat.table.number, displayLabel: `Стол ${seat.table.number} · Место ${seat.number}` }
        : seat.row?{ seatId: seat.id, seatNumber: seat.number, parentKind: "row" as const, parentNumber: seat.row.number, displayLabel: `Ряд ${seat.row.number} · Место ${seat.number}` }
        : {seatId:seat.id,seatNumber:seat.number,parentKind:"standalone" as const,parentNumber:seat.number,displayLabel:seat.label||`Место ${seat.number}`});
      const snapshot: CheckoutSnapshot = {
        eventId: event.id,
        eventTitle: event.title,
        eventDate: event.date.toISOString().slice(0, 10),
        eventTime: event.time.toISOString().slice(11, 16),
        eventTimezone: event.timezone,
        address: event.address,
        itemId: seatIds[0]!,
        itemName: `${seats.length} мест`,
        itemKind: "ticket",
        quantity: seats.length,
        paymentMode: event.paymentMode,
        paymentLabel: event.paymentMode,
        unitFullAmount: seats.length === 1 ? seats[0]!.ticketType!.price : fullAmount,
        fullAmount: fullAmount,
        amountDue,
        currency,
        cancellationTerms: event.cancellationTerms,
        depositTerms: event.depositTerms,
        seatIds,
        seatLabels: seatAssignments.map(({ displayLabel }) => displayLabel),
        seatAssignments,
        items:seats.map(seat=>({kind:"seat",id:seat.id,name:seat.label,quantity:1,amountDue:seat.ticketType!.price})),
      };
      const orderId = randomUUID();
      const deliveryEmail = await this.resolveEmail(transaction, userId, input.emailDelivery, sessionFamilyId, anonymous);
      const frozen=await acceptedSnapshot(transaction,event,snapshot,input,now);
      await transaction.order.create({ data: { id: orderId, type: OrderType.ticket, eventId: event.id, buyerUserId: anonymous ? null : userId, ...(anonymous ? { guestContact: anonymous.guestContact } : {}), amount: amountDue, currency, checkoutSnapshot: frozen, termsAcceptedAt: now, expiresAt, emailDeliveryAddress: deliveryEmail, emailDeliveryRequestedAt: deliveryEmail ? now : null } });
      const ticketIds: string[] = [];
      for (const seat of seats) {
        const displayLabel = seatAssignments.find(({ seatId }) => seatId === seat.id)!.displayLabel;
        const ticket = await transaction.ticket.create({ data: { ticketTypeId: seat.ticketType!.id, orderId, ownerUserId: anonymous ? null : userId, qrToken: randomBytes(32).toString("base64url"), seatLabelSnapshot: frozenSeatLabel(frozen,seat.id,displayLabel), status: TicketStatus.pending_payment } });
        ticketIds.push(ticket.id);
        await transaction.seatAllocation.create({ data: { seatId: seat.id, orderId, ticketId: ticket.id } });
      }
      const result: CheckoutResponse = { orderId, kind: "ticket", paymentMode: snapshot.paymentMode, paymentLabel: snapshot.paymentLabel, amountDue, fullAmount: snapshot.fullAmount, currency, paymentLink: "", expiresAt: expiresAt.toISOString(), ticketIds, bookingId: null, emailDelivery: deliveryEmail ? { address: deliveryEmail, status: "pending_payment" } : null };
      await this.domainEvents.append(transaction, { eventType: "checkout.seats_created", aggregateType: "order", aggregateId: orderId, payload: { userId: anonymous ? null : userId, ...(anonymous ? { anonymousSessionId: userId } : {}), eventId: event.id, seatIds, amountDue } });
      return result;
    });
  }

  /**
   * The checkout pipeline shared by every kind: replay a stored response → in one transaction claim the
   * idempotency key, run the kind's selection resolver (lock inventory → read and price → snapshot → order, tickets,
   * holds) and store the response → create the payment link (or settle a zero-amount order) outside the transaction.
   * Anonymous checkouts run inside the caller's transaction and own their idempotency; they get no link here.
   */
  private async run(
    operation: string,
    userId: string,
    rawKey: string | undefined,
    input: CreateCartCheckoutRequest | CreateSeatCheckoutRequest | CreateTableCheckoutRequest | CreateTicketCheckoutRequest,
    anonymous: AnonymousCheckoutContext | undefined,
    resolve: (transaction: Prisma.TransactionClient, key: string) => Promise<CheckoutResponse>,
  ): Promise<CheckoutResponse> {
    const key = idempotencyKey(rawKey);
    const fingerprint = checkoutFingerprint(input);
    const requestedEmail = Boolean(input.emailDelivery);
    const prior = anonymous ? null : await this.replayed(userId, operation, key, fingerprint, requestedEmail);
    if (prior) {
      if (prior.paymentLink) return prior;
      const link = await this.checkoutLink(userId, prior, `checkout-${key}`);
      return { ...prior, paymentLink: link.paymentLink };
    }
    try {
      const create = async (transaction: Prisma.TransactionClient): Promise<CheckoutResponse> => {
        const replay = anonymous ? null : await claim(transaction, userId, operation, key, fingerprint, requestedEmail);
        if (replay) return replay;
        const response = await resolve(transaction, key);
        if (!anonymous) await saveResponse(transaction, userId, operation, key, response.orderId, response);
        return response;
      };
      const response = anonymous ? await create(anonymous.transaction) : await this.database.$transaction(create, { timeout: 15_000 });
      if (anonymous) return response;
      const link = await this.checkoutLink(userId, response, `checkout-${key}`);
      const finalResponse = { ...response, paymentLink: link.paymentLink };
      await this.database.idempotencyRecord.update({ where: { userId_operation_key: { userId, operation, key } }, data: { response: json(finalResponse) } });
      return finalResponse;
    } catch (error) {
      if (anonymous) throw error;
      return this.resolveRace(error, userId, operation, key, fingerprint, requestedEmail);
    }
  }

  private async checkoutLink(userId:string,checkout:Pick<CheckoutResponse,"orderId"|"amountDue">,key:string):Promise<{paymentLink:string}>{
    if(checkout.amountDue===0){await this.settlement.settleSucceeded(checkout.orderId);return{paymentLink:""};}
    return this.paymentLinks.createLink(userId,checkout.orderId,key);
  }

  async options(_userId: string, eventId: string): Promise<BookingOptions> {
    const event = await this.database.event.findFirst({
      where: { id: eventId, ...publicEventWhere },
      include: { venueLayout: true },
    });
    if (!event) throw new NotFoundException({ code: "EVENT_NOT_FOUND", message: "Event was not found" });
    if (event.venueLayout) await this.tables.expireLayoutHolds(event.venueLayout.id);
    const geometry=event.venueLayout&&publishedHallV3Schema.safeParse(event.venueLayout.layoutJson).success?canonicalHallCompatibility(await readCanonicalHall(this.database,event.venueLayout.id,event.venueLayout.layoutJson),event.sourceLocale as EventLocale):event.venueLayout?.layoutJson;
    const parsed=event.venueLayout?(publishedHallV3Schema.safeParse(event.venueLayout.layoutJson).success?{success:true as const,data:geometry}:venueLayoutSchemaAny.safeParse(geometry)):null;
    return {
      eventId,
      paymentMode: event.paymentMode,
      showFullAmountForDeposit: event.showFullAmountForDeposit,
      depositTerms: event.depositTerms,
      cancellationTerms: event.cancellationTerms,
      layout: parsed?.success ? parsed.data as BookingOptions["layout"] : null,
    };
  }

  private async resolveEmail(transaction: Prisma.TransactionClient, userId: string, choice: CheckoutEmailChoice | undefined, sessionFamilyId?: string, anonymous?: AnonymousCheckoutContext): Promise<string | null> {
    if (!choice) return null;
    if (!this.checkoutEmail) throw new ConflictException({ code: "CHECKOUT_EMAIL_UNAVAILABLE" });
    return this.checkoutEmail.resolve(transaction, userId, choice, sessionFamilyId, anonymous ? { id: anonymous.sessionId, verifiedEmail: anonymous.verifiedEmail } : undefined);
  }

  private async replayed(userId: string, operation: string, key: string, fingerprint: string, requestedEmail: boolean): Promise<CheckoutResponse | null> {
    const row = await this.database.idempotencyRecord.findUnique({ where: { userId_operation_key: { userId, operation, key } } });
    if (row && (row.requestHash ? row.requestHash !== fingerprint : requestedEmail)) throw new ConflictException({ code: "IDEMPOTENCY_CONFLICT" });
    return row?.response ? checkoutResponse(row.response) : null;
  }

  private async resolveRace(error: unknown, userId: string, operation: string, key: string, fingerprint: string, requestedEmail: boolean): Promise<CheckoutResponse> {
    if (isUniqueError(error)) {
      const prior = await this.replayed(userId, operation, key, fingerprint, requestedEmail);
      if (prior) {
        if (prior.paymentLink) return prior;
        const linked = await this.checkoutLink(userId, prior, `checkout-${key}`);
        const response = { ...prior, paymentLink: linked.paymentLink };
        await this.database.idempotencyRecord.update({ where: { userId_operation_key: { userId, operation, key } }, data: { response: json(response) } });
        return response;
      }
    }
    throw error;
  }

}

export function paymentAmounts(event:{paymentMode:EventPaymentMode},unitAmount:number,quantity:number):{amountDue:number;fullAmount:number}{
  assertCurrentSale(event);const amount=unitAmount*quantity;assertChargeTotal(amount);return {amountDue:amount,fullAmount:amount};
}
export function assertChargeTotal(amount:number){try{checkedOrderTotal([{unitAmount:amount,quantity:1,currency:"XXX"}],"XXX");}catch{throw new BadRequestException({code:"MONEY_TOTAL_OVERFLOW"});}}
export type SeatRow = { id: string; number: number; label: string; sortOrder: number };

/** Materialises legacy table capacity into relational seats once, preserving old tables as whole-table inventory. */
export async function ensureWholeTableSeats(
  transaction: Prisma.TransactionClient,
  tableId: string,
  venueLayoutId: string,
  capacity: number,
  existing: SeatRow[],
): Promise<SeatRow[]> {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new ConflictException({ code: "TABLE_SEAT_COUNT_INVALID", message: "This table has no configured seats" });
  }
  const seats = [...existing].sort((a, b) => a.sortOrder - b.sortOrder);
  if (seats.length >= capacity) return seats.slice(0, capacity);
  // These seats only fulfill capacity from the approved whole-table offer.
  await transaction.$queryRaw`SELECT set_config('ticketron.whole_table_admission', ${tableId}, true)`;
  const created: SeatRow[] = [];
  const usedNumbers = new Set(seats.map(seat => seat.number));
  let number = 1;
  for (let index = seats.length; index < capacity; index += 1) {
    while (usedNumbers.has(number)) number += 1;
    created.push(await transaction.seat.create({
      data: {
        venueLayoutId,
        tableId,
        number,
        label: String(number),
        sortOrder: index,
      },
      select: { id: true, number: true, label: true, sortOrder: true },
    }));
    number += 1;
  }
  await transaction.$queryRaw`SELECT set_config('ticketron.whole_table_admission', '', true)`;
  return [...seats, ...created];
}

/** Internal admission type keeps individual table tickets in the common ticket system without public sale. */
export async function ensureAdmissionTicketType(
  transaction: Prisma.TransactionClient,
  eventId: string,
  tableId: string,
  currency: string,
): Promise<{ id: string }> {
  const name = `__table_admission:${tableId}`;
  const existing = await transaction.ticketType.findFirst({ where: { eventId, name, isInternal: true }, select: { id: true } });
  if (existing) return existing;
  try {
    return await transaction.ticketType.create({
      data: {
        eventId,
        name,
        price: 0,
        deposit: 0,
        currency,
        quantityTotal: 1_000_000_000,
        status: TicketTypeStatus.active,
        isInternal: true,
      },
      select: { id: true },
    });
  } catch (error) {
    if (!isUniqueError(error)) throw error;
    const raced = await transaction.ticketType.findFirst({ where: { eventId, name, isInternal: true }, select: { id: true } });
    if (raced) return raced;
    throw error;
  }
}
export function frozenSeatLabel(value:Prisma.InputJsonValue,id:string,fallback:string){const saved=readCheckoutSnapshot(value),index=saved.seatIds?.indexOf(id)??-1;return saved.acceptedPolicy&&index>=0?saved.seatLabels?.[index]??fallback:fallback;}