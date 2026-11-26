import { Prisma, type PrismaClient } from "@event-platform/database";
import type { BotOrganizerEvents, BotOrganizerOrder, BotOrganizerOrderDetail, BotOrganizerSnapshot, BotOrganizerTab, ManagementOrderRow } from "@event-platform/shared-types";
import { HttpException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { DATABASE_CLIENT } from "../auth/auth.constants.js";
import { BOOKING_CLOCK, type BookingClock } from "../booking/booking.constants.js";
import { EventsService } from "../events/events.service.js";
import { EventNotificationsService } from "../events/event-notifications.service.js";
import { publicEventWhere } from "../events/event-moderation-policy.js";
import { botOrganizer } from "./bot-organizer-access.js";

const PAGE = 6;

@Injectable()
export class BotOrganizerService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly db: PrismaClient,
    @Inject(BOOKING_CLOCK) private readonly clock: BookingClock,
    @Inject(EventsService) private readonly eventsService: EventsService,
    @Inject(EventNotificationsService) private readonly notifications: EventNotificationsService,
  ) {}

  async events(telegramId: string, chatId: string, tab: BotOrganizerTab, page: number): Promise<BotOrganizerEvents> {
    const id = await botOrganizer(this.db, telegramId, chatId);
    const compare = tab === "today" ? Prisma.sql`"day" = "today" AND status NOT IN ('completed', 'cancelled')`
      : tab === "upcoming" ? Prisma.sql`"day" > "today" AND status NOT IN ('completed', 'cancelled')`
      : Prisma.sql`("day" < "today" OR status IN ('completed', 'cancelled'))`;
    const direction = tab === "past" ? Prisma.sql`DESC` : Prisma.sql`ASC`;
    const items = await this.db.$queryRaw<BotOrganizerEvents["items"]>`
      WITH owned AS (
        SELECT id, title, timezone, status, "salesPaused", "approvedAt", "moderationStatus",
          COALESCE(("startsAt" AT TIME ZONE timezone)::date, date::date) AS "day",
          COALESCE(("startsAt" AT TIME ZONE timezone)::time, time::time) AS "eventTime",
          (${this.clock.now().toISOString()}::timestamptz AT TIME ZONE timezone)::date AS "today"
        FROM "Event" WHERE "organizerId" = ${id}::uuid
      )
      SELECT id, title, timezone, "day"::text AS date, to_char("eventTime", 'HH24:MI') AS time,
        (status = 'published' AND "approvedAt" IS NOT NULL AND "moderationStatus" IN ('approved', 'sales_paused')) AS published,
        CASE WHEN status IN ('cancelled', 'completed') THEN status::text
             WHEN status = 'published' AND "salesPaused" THEN 'paused'
             WHEN "moderationStatus" = 'pending' THEN 'review'
             WHEN "moderationStatus" = 'rejected' THEN 'rejected' ELSE status::text END AS status
      FROM owned WHERE ${compare} ORDER BY "day" ${direction}, "eventTime" ${direction}, id
      LIMIT ${PAGE + 1} OFFSET ${(page - 1) * PAGE}
    `;
    return { items: items.slice(0, PAGE), hasNext: items.length > PAGE };
  }

  async snapshot(telegramId: string, chatId: string, eventId: string): Promise<BotOrganizerSnapshot> {
    const owner = await botOrganizer(this.db, telegramId, chatId);
    const [summary, publiclyVisible] = await Promise.all([
      this.eventsService.managementSummary(owner, eventId),
      this.db.event.findFirst({ where: { id: eventId, organizerId: owner, ...publicEventWhere }, select: { id: true } }),
    ]);
    return { ...summary, publicCard: Boolean(publiclyVisible) };
  }

  async lookup(telegramId: string, chatId: string, eventId: string, search: string) {
    const owner = await botOrganizer(this.db, telegramId, chatId);
    const result = await this.eventsService.managementOrders(owner, eventId, { search, limit: PAGE }, true);
    return { items: result.items.map(operationalOrder), hasNext: result.hasNext };
  }

  async order(telegramId: string, chatId: string, eventId: string, orderId: string, page: number): Promise<BotOrganizerOrderDetail> {
    const owner = await botOrganizer(this.db, telegramId, chatId);
    const detail = await this.eventsService.managementOrderDetail(owner, eventId, orderId);
    const start = (page - 1) * PAGE;
    const active = detail.tickets.slice(start, start + PAGE).find(ticket => ticket.status === "active");
    let deliverable = false;
    if (detail.payment.status === "paid" && active) {
      deliverable = await this.notifications.ticketResendRecipient(owner, eventId, orderId, active.id).then(() => true, error => {
        if (error instanceof HttpException && [404, 409].includes(error.getStatus())) return false;
        throw error;
      });
    }
    return { ...operationalOrder(detail), eventId,
      tickets: detail.tickets.slice(start, start + PAGE).map(({ id, status, seatLabel, typeName }) => ({
        id, status, seatLabel, typeName, canResend: deliverable && status === "active",
      })),
      hasNext: start + PAGE < detail.tickets.length,
    };
  }

  async resend(telegramId: string, chatId: string, ticketId: string, requestKey?: string) {
    const owner = await botOrganizer(this.db, telegramId, chatId);
    const ticket = await this.db.ticket.findFirst({ where: { id: ticketId, ticketType: { event: { organizerId: owner } } },
      select: { id: true, orderId: true, seatLabelSnapshot: true, ticketType: { select: { eventId: true, name: true } } } });
    if (!ticket) throw missing();
    const { eventId, name } = ticket.ticketType;
    if (requestKey) {
      const status = await this.notifications.resendTicket(owner, eventId, ticket.orderId, ticket.id, requestKey);
      return { eventId, orderId: ticket.orderId, label: ticket.seatLabelSnapshot ?? name, status };
    }
    await this.notifications.ticketResendRecipient(owner, eventId, ticket.orderId, ticket.id);
    return { eventId, orderId: ticket.orderId, label: ticket.seatLabelSnapshot ?? name, status: null };
  }

  async resendStatus(telegramId: string, chatId: string, id: string) {
    const owner = await botOrganizer(this.db, telegramId, chatId);
    const row = await this.db.broadcast.findFirst({ where: { id, type: "ticket.resend", organizerId: owner }, select: { eventId: true, audience: true } });
    const audience = row?.audience as { orderId?: string } | undefined;
    if (!row?.eventId || !audience?.orderId) throw missing();
    return { status: await this.notifications.status(owner, row.eventId, id), eventId: row.eventId, orderId: audience.orderId };
  }
}

function operationalOrder(row: ManagementOrderRow): BotOrganizerOrder {
  const { id, createdAt, resources, attendance, payment } = row;
  return { id, createdAt, buyerName: row.buyer.name, resources, attendance, payment };
}
function missing() { return new NotFoundException({ code: "ORDER_NOT_FOUND" }); }
