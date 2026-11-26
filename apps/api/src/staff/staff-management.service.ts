import { auditPresentation } from "./staff-audit-presentation.js";
import {
  BadRequestException,
  ForbiddenException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
  type OnModuleDestroy,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { BOOKING_CLOCK, SystemBookingClock, type BookingClock } from "../booking/booking.constants.js";
import { Prisma, type PrismaClient } from "@event-platform/database";
import {
  commissionSchema,
  moderateEventSchema,
  eventModerationActions,
  eventModerationNotice,
  hasEventEnded,
  payoutSchema,
  reasonSchema,
} from "@event-platform/shared-types";
import { DATABASE_CLIENT } from "../auth/auth.constants.js";
import { startIntervalWorker } from "../workers/interval-worker.js";
import {
  type StaffPrincipal,
  parse,
  pageOf,
  staffAudit,
  digest,
} from "./staff.config.js";
import { validId } from "./platform-support.service.js";
import { TicketEmailDeliveryService } from "../orders/ticket-email-delivery.service.js";
import { financeFacts, dateFilter } from "./staff-finance.js";
import { EventNotificationsService } from "../events/event-notifications.service.js";
import { BookingService } from "../booking/booking.service.js";
import { releaseOrderInventory } from "../booking/order-release.service.js";
import { guestEventTiming } from "../tickets/guest-ticket-details.js";
const RESEND_LEASE_MS = 5 * 60 * 1000;
const userSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  role: true,
  blockedAt: true,
  blockedReason: true,
  organizerVerifiedAt: true,
  commissionBps: true,
  createdAt: true,
} satisfies Prisma.UserSelect;
const eventSelect = {
  id: true,
  title: true,
  organizerId: true,
  date: true,
  time: true,
  timezone: true,
  status: true,
  moderationStatus: true,
  approvedAt: true,
  salesPaused: true,
  revision: true,
  updatedAt: true,
  moderationReason: true,
  paymentMode: true,
  category: true,
  city: true,
  createdAt: true,
  organizer: {
    select: {
      id: true,
      name: true,
      organizerVerifiedAt: true,
      blockedAt: true,
    },
  },
} satisfies Prisma.EventSelect;
const orderSelect = {
  id: true,
  type: true,
  buyerUserId: true,
  amount: true,
  currency: true,
  paymentStatus: true,
  createdAt: true,
  commissionAmount: true,
  commissionBps: true,
  emailDeliveryAddress: true,
  checkoutSnapshot: true,
  buyer: { select: userSelect },
  anonymousSession: {
    select: { id: true, name: true, verifiedEmail: true, deliveredAt: true },
  },
  ticketEmailDelivery: {
    select: {
      status: true,
      acceptedAt: true,
      attempts: true,
      lastErrorCode: true,
    },
  },
  tickets: {
    select: {
      id: true,
      status: true,
      usedAt: true,
      refundedAt: true,
      seatLabelSnapshot: true,
      ticketTypeId: true,
      ticketType: {
        select: {
          name: true,
          eventId: true,
          event: { select: { title: true, organizerId: true } },
        },
      },
    },
  },
  payments: {
    select: {
      id: true,
      provider: true,
      providerPaymentId: true,
      amount: true,
      currency: true,
      status: true,
      createdAt: true,
    },
  },
  refundRequest: {
    select: {
      id: true,
      status: true,
      amount: true,
      completedAt: true,
      lastError: true,
    },
  },
} satisfies Prisma.OrderSelect;
export function csvCell(value: unknown) {
  const raw = String(value ?? "");
  const safe = /^[\s]*[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}
@Injectable()
export class StaffManagementService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StaffManagementService.name);
  private moderationTimer?: ReturnType<typeof setInterval>;

  onModuleInit() {
    if (process.env.NODE_ENV === "test") return;
    this.moderationTimer = startIntervalWorker({
      name: "Moderation review archiver",
      intervalMs: 60_000,
      logger: this.logger,
      runImmediately: true,
      task: () => this.archiveExpiredReviews(),
    });
  }

  onModuleDestroy() {
    clearInterval(this.moderationTimer);
  }

  private archiveExpiredReviews(id?: string) {
    return this.db.$executeRaw`
      UPDATE "Event" AS event
      SET status = 'completed', "moderationStatus" = 'expired', revision = revision + 1, "updatedAt" = now()
      WHERE event.status IN ('draft', 'published') AND event."moderationStatus" = 'pending'
        ${id ? Prisma.sql`AND event.id = ${id}::uuid` : Prisma.empty}
        AND GREATEST(event."endsAt", COALESCE(event."startsAt",
          (event.date + date_trunc('minute', event.time::interval)::time) AT TIME ZONE
            (SELECT name FROM pg_timezone_names WHERE name = event.timezone))) <= now()
    `;
  }

  constructor(
    @Inject(DATABASE_CLIENT) readonly db: PrismaClient,
    @Inject(TicketEmailDeliveryService)
    private delivery: TicketEmailDeliveryService,
    @Inject(BookingService) private booking: BookingService,
    @Inject(EventNotificationsService)
    private telegram: EventNotificationsService,
    @Optional() @Inject(BOOKING_CLOCK) private clock: BookingClock = new SystemBookingClock(),
  ) {}
  async users(query: Record<string, string | undefined>) {
    const { page, limit, skip } = pageOf(query),
      q = query.search?.trim().slice(0, 160);
    const where: Prisma.UserWhereInput = {
      ...(query.tab === "organizers"
        ? { role: { in: ["organizer", "admin"] } }
        : { role: "guest" }),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { email: { contains: q, mode: "insensitive" } },
              { phone: { contains: q } },
              {
                contactIdentities: {
                  some: {
                    normalizedIdentifier: { contains: q, mode: "insensitive" },
                  },
                },
              },
              ...(/^[0-9a-f-]{36}$/i.test(q) ? [{ id: q }] : []),
            ],
          }
        : {}),
    };
    const [rows, total] = await this.db.$transaction([
      this.db.user.findMany({
        where,
        select: userSelect,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
      }),
      this.db.user.count({ where }),
    ]);
    return {
      items: rows,
      total,
      page,
      limit,
      hasNext: skip + rows.length < total,
    };
  }
  async user(id: string, actor: StaffPrincipal) {
    validId(id);
    const row = await this.db.user.findUnique({
      where: { id },
      select: {
        ...userSelect,
        organizerProfile: true,
        contactIdentities: {
          select: {
            method: true,
            normalizedIdentifier: true,
            verifiedAt: true,
          },
        },
      },
    });
    if (!row) throw new NotFoundException();
    const [orders, cases, eventsCreated, ticketsSold, history] =
      await Promise.all([
        this.db.order.findMany({
          where: { buyerUserId: id },
          select: orderSelect,
          orderBy: { createdAt: "desc" },
          take: 20,
        }),
        this.db.platformCase.findMany({
          where: { ownerId: id },
          orderBy: { updatedAt: "desc" },
          take: 20,
        }),
        this.db.event.count({ where: { organizerId: id } }),
        this.db.ticket.count({
          where: {
            ticketType: { event: { organizerId: id } },
            status: { in: ["active", "paid", "used"] },
          },
        }),
        actor.role === "moderator"
          ? this.db.staffAudit.findMany({
              where: { targetId: id },
              orderBy: { createdAt: "desc" },
              take: 50,
            })
          : Promise.resolve([]),
      ]);
    return { ...row, orders, cases, eventsCreated, ticketsSold, history };
  }
  async block(
    id: string,
    actor: StaffPrincipal,
    blocked: boolean,
    body: unknown,
  ) {
    validId(id);
    const { reason } = parse(reasonSchema, body);
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id=${id}::uuid FOR UPDATE`;
      const current = await tx.user.findUniqueOrThrow({ where: { id } });
      const row = await tx.user.update({
        where: { id },
        data: {
          blockedAt: blocked ? new Date() : null,
          blockedReason: blocked ? reason : null,
          credentialVersion: { increment: 1 },
        },
        select: userSelect,
      });
      await tx.refreshToken.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await staffAudit(
        tx,
        actor,
        blocked ? "user.blocked" : "user.unblocked",
        "user",
        id,
        reason,
        { blocked: !!current.blockedAt },
        { blocked },
      );
      return row;
    });
  }
  async warning(id: string, actor: StaffPrincipal, body: unknown) {
    validId(id);
    const { reason } = parse(reasonSchema, body);
    await this.db.user.findUniqueOrThrow({ where: { id } });
    await this.db.$transaction((tx) =>
      staffAudit(tx, actor, "organizer.warning", "user", id, reason),
    );
    return { recorded: true };
  }
  async events(query: Record<string, string | undefined>) {
    await this.archiveExpiredReviews();
    const { page, limit, skip } = pageOf(query);
    const where: Prisma.EventWhereInput = {
      ...(query.search
        ? {
            title: {
              contains: query.search.slice(0, 160),
              mode: "insensitive",
            },
          }
        : {}),
      ...(query.organizerId ? { organizerId: validId(query.organizerId) } : {}),
      ...(query.status ? eventStateFilter(query.status) : {}),
      ...(query.from || query.to
        ? { date: dateFilter(query.from, query.to) }
        : {}),
    };
    const [rows, total] = await this.db.$transaction([
      this.db.event.findMany({
        where,
        select: { ...eventSelect, _count: { select: { ticketTypes: true } } },
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
      }),
      this.db.event.count({ where }),
    ]);
    const types = rows.length
      ? await this.db.ticketType.findMany({
          where: { eventId: { in: rows.map((row) => row.id) } },
          select: {
            eventId: true,
            _count: {
              select: {
                tickets: { where: { status: { in: ["paid", "active", "used"] } } },
              },
            },
          },
        })
      : [];
    const sold = new Map<string, number>();
    for (const type of types) {
      sold.set(type.eventId, (sold.get(type.eventId) ?? 0) + type._count.tickets);
    }
    const items = rows.map((row) => ({ ...row, ticketsSold: sold.get(row.id) ?? 0 }));
    return { items, total, page, limit, hasNext: skip + rows.length < total };
  }
  async event(id: string) {
    validId(id);
    await this.archiveExpiredReviews(id);
    const event = await this.db.event.findUniqueOrThrow({
      where: { id },
      select: {
        ...eventSelect,
        description: true,
        address: true,
        cancellationTerms: true,
      },
    });
    const [affected, outcomes, refundWork, notifications] = await Promise.all([
      this.db.order.count({
        where: {
          tickets: { some: { ticketType: { eventId: id } } },
          paymentStatus: "paid",
        },
      }),
      this.db.notification.groupBy({
        by: ["channel", "status"],
        where: { eventId: id, type: "event.cancellation" },
        _count: { _all: true },
      }),
      this.db.staffRefund.groupBy({
        by: ["status"],
        where: {
          orderId: {
            in: (
              await this.db.order.findMany({
                where: { tickets: { some: { ticketType: { eventId: id } } } },
                select: { id: true },
              })
            ).map((v) => v.id),
          },
        },
        _count: { _all: true },
      }),
      this.db.outboxEvent.findFirst({
        where: { aggregateId: id, eventType: "event.cancelled" },
        select: { processedAt: true, lastError: true, attempts: true },
      }),
    ]);
    return {
      ...event,
      affectedPaidOrders: affected,
      notificationOutcomes: outcomes.map((row) => ({
        channel: row.channel,
        status: row.status,
        count: row._count._all,
      })),
      refundWork: refundWork.map((row) => ({
        status: row.status,
        count: row._count._all,
      })),
      notificationRequest: notifications,
    };
  }
  async moderate(id: string, actor: StaffPrincipal, body: unknown) {
    validId(id);
    const input = parse(moderateEventSchema, body);
    await this.archiveExpiredReviews(id);
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Event" WHERE id=${id}::uuid FOR UPDATE`;
      const current = await tx.event.findUniqueOrThrow({
        where: { id },
        include: { organizer: { select: { blockedAt: true } } },
      });
      if (
        current.organizer.blockedAt &&
        ["approve", "unhide", "resume"].includes(input.action)
      )
        throw new ConflictException({ code: "ORGANIZER_BLOCKED" });
      if (actor.role !== "moderator" && !["approve", "reject"].includes(input.action)) throw new ForbiddenException({ code: "MODERATOR_REQUIRED" });
      if (input.revision !== undefined && input.revision !== current.revision) throw new ConflictException({ code: "EVENT_REVISION_CONFLICT" });
      if ((current.moderationStatus === "pending" && hasEventEnded(guestEventTiming(current))) || !eventModerationActions(current, actor.role).includes(input.action)) throw new ConflictException({ code: "EVENT_MODERATION_STATE_CHANGED" });
      if (input.action === "resume" && current.paymentMode === "deposit") throw new ConflictException({ code: "LEGACY_DEPOSIT_SALES_CLOSED" });
      const mapping = { approve: current.salesPaused ? "sales_paused" : "approved", reject: "rejected", hide: "hidden", unhide: current.salesPaused ? "sales_paused" : "approved", pause: "sales_paused", resume: "approved", cancel: "cancelled" };
      const row = await tx.event.update({
        where: { id },
        data: {
          moderationStatus: mapping[input.action],
          moderationReason: input.reason || null,
          ...(input.action === "approve" ? { status: "published", approvedAt: new Date(), approvedByStaffId: actor.id, publishedAt: current.publishedAt ?? new Date() } : {}),
          ...(input.action === "reject" ? { approvedAt: null, approvedByStaffId: null } : {}),
          ...(input.action === "pause" || input.action === "resume" ? { salesPaused: input.action === "pause" } : {}),
          ...(input.action === "cancel" ? { status: "cancelled" } : {}),
        },
        select: eventSelect,
      });
      // Approved edits enter the existing buyer-notification workflow only now.
      if (input.action === "approve" && current.publishedAt) {
        const submission = await tx.auditLog.findFirst({ where: { entityType: "event", entityId: id, action: "event.submitted" }, orderBy: { createdAt: "desc" }, select: { meta: true } });
        const meta = submission?.meta && typeof submission.meta === "object" && !Array.isArray(submission.meta) ? submission.meta : {};
        if (Array.isArray(meta.changedFields) && meta.changedFields.length) await tx.outboxEvent.create({ data: { eventType: "event.updated", aggregateType: "event", aggregateId: id, payload: { changedFields: meta.changedFields, eventUpdatedAt: row.updatedAt.toISOString() } } });
      }
      if (input.action === "cancel" && input.notify) {
        const existing = await tx.outboxEvent.findFirst({
          where: { aggregateId: id, eventType: "event.cancelled" },
        });
        if (!existing)
          await tx.outboxEvent.create({
            data: {
              eventType: "event.cancelled",
              aggregateType: "event",
              aggregateId: id,
              payload: { eventId: id, reason: input.reason, staff: true },
            },
          });
      }
      await staffAudit(
        tx,
        actor,
        `event.${input.action}`,
        "event",
        id,
        input.reason,
        { title:current.title, status: current.status, moderationStatus: current.moderationStatus },
        {
          title:row.title,
          status: row.status,
          moderationStatus: row.moderationStatus,
          notify: input.notify,
        },
      );
      await tx.notification.create({ data: { userId: current.organizerId, eventId: id, channel: "in_app", type: "event.moderation", status: "sent", sentAt: new Date(), payload: {
        text: eventModerationNotice(current.title, input.action, input.reason, "ru"), eventTitle: current.title, action: input.action, reason: input.reason || null, organizerEvent: true,
      } } });
      return row;
    });
  }
  async orders(query: Record<string, string | undefined>) {
    const { page, limit, skip } = pageOf(query),
      q = query.search?.trim().slice(0, 160);
    const compact = q?.replace(/^TKT-/i, "").replaceAll("-", "");
    const uuid =
      compact && /^[a-f0-9]{32}$/i.test(compact)
        ? `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`
        : null;
    const shortIds =
      q && /^#?[a-f0-9]{8}$/i.test(q)
        ? await this.db.$queryRaw<
            Array<{ id: string }>
          >`SELECT id FROM "Order" WHERE right(id::text,8)=lower(${q.replace(/^#/, "")}) LIMIT 100`
        : [];
    const where: Prisma.OrderWhereInput = {
      ...(query.organizerId
        ? {
            tickets: {
              some: {
                ticketType: {
                  event: { organizerId: validId(query.organizerId) },
                },
              },
            },
          }
        : {}),
      ...(query.eventId
        ? {
            tickets: {
              some: { ticketType: { eventId: validId(query.eventId) } },
            },
          }
        : {}),
      ...(q
        ? {
            OR: [
              ...(shortIds.length
                ? [{ id: { in: shortIds.map((row) => row.id) } }]
                : []),
              ...(uuid
                ? [{ id: uuid }, { tickets: { some: { id: uuid } } }]
                : []),
              { buyer: { name: { contains: q, mode: "insensitive" } } },
              { buyer: { email: { contains: q, mode: "insensitive" } } },
              { buyer: { phone: { contains: q } } },
              {
                anonymousSession: {
                  name: { contains: q, mode: "insensitive" },
                },
              },
              {
                anonymousSession: {
                  verifiedEmail: { contains: q, mode: "insensitive" },
                },
              },
              {
                tickets: {
                  some: {
                    ticketType: {
                      event: { title: { contains: q, mode: "insensitive" } },
                    },
                  },
                },
              },
            ],
          }
        : {}),
    };
    const [items, total] = await this.db.$transaction([
      this.db.order.findMany({
        where,
        select: orderSelect,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
      }),
      this.db.order.count({ where }),
    ]);
    return {
      items: items.map((row) => ({
        ...row,
        emailDeliveryAddress: undefined,
        buyer: row.buyer ? { id: row.buyer.id, name: row.buyer.name } : null,
        anonymousSession: row.anonymousSession
          ? { id: row.anonymousSession.id, name: row.anonymousSession.name }
          : null,
        checkoutSnapshot: undefined,
      })),
      total,
      page,
      limit,
      hasNext: skip + items.length < total,
    };
  }
  async order(id: string) {
    validId(id);
    const row = await this.db.order.findUniqueOrThrow({
      where: { id },
      select: orderSelect,
    });
    const [refunds, operations, telegramDelivery] = await Promise.all([
      this.db.staffRefund.findMany({
        where: { orderId: id },
        orderBy: { createdAt: "desc" },
      }),
      this.db.staffOperation.findMany({
        where: { resourceId: id },
        select: { id: true, kind: true, status: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 30,
      }),
      this.db.notification.findMany({
        where: {
          type: "ticket.resend",
          payload: { path: ["orderId"], equals: id },
        },
        select: {
          status: true,
          sentAt: true,
          lastError: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        take: 30,
      }),
    ]);
    return { ...row, refunds, operations, telegramDelivery };
  }
  async resend(
    actor: StaffPrincipal,
    id: string,
    key: string,
    reason: string,
    channel: "auto" | "email" | "telegram" = "auto",
  ) {
    validId(id);
    validId(key);
    if (reason.trim().length < 3 || reason.length > 500)
      throw new BadRequestException();
    const requestHash = digest(`${id}:${reason}:${channel}`);
    const operation = await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`staff-resend:${id}`},0))`;
      const prior = await tx.staffOperation.findUnique({
        where: { kind_key: { kind: "resend", key } },
      });
      if (prior) {
        if (
          prior.staffId !== actor.id ||
          prior.resourceId !== id ||
          prior.requestHash !== requestHash
        )
          throw new ConflictException({ code: "IDEMPOTENCY_KEY_REUSED" });
        if (prior.status === "dispatching" && prior.createdAt < new Date(Date.now() - RESEND_LEASE_MS)) {
          // The claiming process crashed before finishing; release the stale claim so staff can retry.
          await tx.staffOperation.updateMany({ where: { id: prior.id, status: "dispatching" }, data: { status: "failed" } });
          return { ...prior, status: "failed" };
        }
        return prior;
      }
      const now = Date.now();
      const recent = await tx.staffOperation.findFirst({
        where: {
          resourceId: id,
          kind: "resend",
          createdAt: { gt: new Date(now - 600000) },
          status: { not: "failed" },
          NOT: { status: "dispatching", createdAt: { lt: new Date(now - RESEND_LEASE_MS) } },
        },
      });
      if (recent) throw new ConflictException({ code: "TICKET_RESEND_LIMIT" });
      const row = await tx.staffOperation.create({
        data: {
          staffId: actor.id,
          key,
          kind: "resend",
          resourceId: id,
          requestHash,
        },
      });
      await staffAudit(
        tx,
        actor,
        "ticket.resend_requested",
        "order",
        id,
        reason,
      );
      return row;
    });
    if (operation.status !== "pending") return { status: operation.status };
    const claim = await this.db.staffOperation.updateMany({
      where: { id: operation.id, status: "pending" },
      data: { status: "dispatching" },
    });
    if (!claim.count) return { status: "dispatching" };
    try {
      const order = await this.db.order.findUniqueOrThrow({
        where: { id },
        select: {
          emailDeliveryAddress: true,
          tickets: {
            where: { status: "active" },
            select: {
              id: true,
              ticketType: {
                select: { event: { select: { id: true, organizerId: true } } },
              },
            },
          },
        },
      });
      const selectedChannel =
        channel === "auto"
          ? order.emailDeliveryAddress && this.delivery.available()
            ? "email"
            : "telegram"
          : channel;
      const broadcastIds: string[] = [];
      if (selectedChannel === "email") await this.delivery.resend(id);
      else {
        if (!order.tickets.length)
          throw new ConflictException({ code: "TICKET_NOT_ACTIVE" });
        for (const ticket of order.tickets) {
          const hash = digest(`staff-ticket:${key}:${ticket.id}`),
            requestKey = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
            event = ticket.ticketType.event;
          const result = await this.telegram.resendTicket(
            event.organizerId,
            event.id,
            id,
            ticket.id,
            requestKey,
            actor,
          );
          broadcastIds.push(result.id);
        }
      }
      await this.db.$transaction(async (tx) => {
        await tx.staffOperation.update({
          where: { id: operation.id },
          data: {
            status: "queued",
            response: { channel: selectedChannel, broadcastIds },
          },
        });
        await staffAudit(
          tx,
          actor,
          "ticket.resend_queued",
          "order",
          id,
          reason,
          undefined,
          { operationId: operation.id, channel: selectedChannel, broadcastIds },
        );
      });
      return { status: "queued", channel: selectedChannel };
    } catch (error) {
      await this.db.$transaction(async (tx) => {
        await tx.staffOperation.update({
          where: { id: operation.id },
          data: { status: "failed" },
        });
        await staffAudit(
          tx,
          actor,
          "ticket.resend_failed",
          "order",
          id,
          reason,
          undefined,
          { operationId: operation.id },
        );
      });
      throw error;
    }
  }
  async cancelUnpaid(
    actor: StaffPrincipal,
    id: string,
    key: string,
    reason: string,
  ) {
    validId(id);
    validId(key);
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`order:${id}`},0))`;
      const order = await tx.order.findUniqueOrThrow({
        where: { id },
        include: {
          tickets: {
            include: { ticketType: { select: { isInternal: true } } },
          },
          booking: true,
        },
      });
      if (order.paymentStatus === "paid" && order.amount > 0)
        throw new ConflictException({ code: "PAID_ORDER_REQUIRES_REFUND" });
      const old = await tx.staffOperation.findUnique({
        where: { kind_key: { kind: "cancel", key } },
      });
      if (old) {
        if (
          old.resourceId !== id ||
          old.staffId !== actor.id ||
          old.requestHash !== digest(reason)
        )
          throw new ConflictException();
        return { cancelled: true };
      }
      if (order.tickets.some((t) => t.status === "used"))
        throw new ConflictException({ code: "USED_TICKET" });
      if (order.paymentStatus === "pending")
        await this.booking.failOrderInTransaction(tx, id, "released");
      else if (order.amount === 0 && order.paymentStatus === "paid") {
        // Shared release: takes the table lock and clears the table's hold fields too.
        await releaseOrderInventory(tx, id, {
          terminalTicketStatus: "cancelled",
          reason: "cancelled",
          now: this.clock.now(),
        });
        await tx.order.update({
          where: { id },
          data: { paymentStatus: "cancelled" },
        });
      } else if (order.paymentStatus !== "cancelled")
        throw new ConflictException({ code: "ORDER_NOT_CANCELLABLE" });
      await tx.staffOperation.create({
        data: {
          staffId: actor.id,
          key,
          kind: "cancel",
          resourceId: id,
          requestHash: digest(reason),
          status: "completed",
        },
      });
      await staffAudit(tx, actor, "order.cancelled", "order", id, reason);
      return { cancelled: true };
    });
  }
  async audit(query: Record<string, string | undefined>) {
    const { page, limit, skip } = pageOf(query);
    const search=query.search?.trim().slice(0,100);
    const matches=search?await Promise.all([
      this.db.event.findMany({where:{title:{contains:search,mode:"insensitive"}},select:{id:true},take:100}),
      this.db.platformCase.findMany({where:{subject:{contains:search,mode:"insensitive"}},select:{id:true},take:100}),
      this.db.organizerVerification.findMany({where:{legalName:{contains:search,mode:"insensitive"}},select:{id:true},take:100}),
      this.db.user.findMany({where:{OR:[{name:{contains:search,mode:"insensitive"}},{organizerProfile:{organizationName:{contains:search,mode:"insensitive"}}}]},select:{id:true},take:100}),
    ]):[];
    const where: Prisma.StaffAuditWhereInput = {
      ...(query.search
        ? {
            OR: [
              { action: { contains: query.search.slice(0, 100), mode:"insensitive" } },
              { staff: {name:{contains:query.search.slice(0,100),mode:"insensitive"}} },
              { targetId: {in:matches.flat().map(row=>row.id)} },
              { targetId: { contains: query.search.slice(0, 100) } },
            ],
          }
        : {}),
      ...(query.staffId ? { staffId: validId(query.staffId) } : {}),
    };
    const [items, total] = await this.db.$transaction([
      this.db.staffAudit.findMany({
        where,
        include: { staff: { select: { name: true, email: true } } },
        skip,
        take: limit,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
      this.db.staffAudit.count({ where }),
    ]);
    return { items:await auditPresentation(this.db,items), total, page, limit, hasNext: skip + items.length < total };
  }
  async issues() {
    const [missingTickets, failedDelivery, stuckRefunds, mismatches, outboxPending, outboxDead, ticketEmailBacklog] =
      await Promise.all([
        this.db.order.findMany({
          where: { paymentStatus: "paid", tickets: { none: {} } },
          select: { id: true, amount: true, currency: true },
          take: 20,
        }),
        this.db.ticketEmailDelivery.findMany({
          where: { status: { in: ["failed", "uncertain"] } },
          select: { orderId: true, status: true, lastErrorCode: true },
          take: 20,
        }),
        this.db.staffRefund.findMany({
          where: {
            status: "processing",
            createdAt: { lt: new Date(Date.now() - 300000) },
          },
          select: { id: true, orderId: true, status: true, lastError: true },
          take: 20,
        }),
        this.db.outboxEvent.findMany({
          where: { eventType: "payment.review_required" },
          select: { aggregateId: true, occurredAt: true },
          orderBy: { occurredAt: "desc" },
          take: 20,
        }),
        this.db.outboxEvent.count({ where: { processedAt: null, deadAt: null } }),
        this.db.outboxEvent.count({ where: { deadAt: { not: null } } }),
        // queued and sending are the non-terminal ticket email states; accepted, failed and uncertain are final.
        this.db.ticketEmailDelivery.count({ where: { status: { in: ["queued", "sending"] } } }),
      ]);
    return { missingTickets, failedDelivery, stuckRefunds, mismatches, queues: { outboxPending, outboxDead, ticketEmailBacklog } };
  }
  async commission(actor: StaffPrincipal, body: unknown) {
    const input = parse(commissionSchema, body);
    return this.db.$transaction(async (tx) => {
      const key = input.organizerId ?? "commission.default";
      let previous: number | null;
      if (input.organizerId) {
        const current = await tx.user.findUniqueOrThrow({
          where: { id: input.organizerId },
        });
        if (!["organizer", "admin"].includes(current.role))
          throw new ConflictException({ code: "ORGANIZER_REQUIRED" });
        previous = current.commissionBps;
        await tx.user.update({
          where: { id: input.organizerId },
          data: { commissionBps: input.basisPoints },
        });
      } else {
        previous =
          (await tx.platformSetting.findUnique({ where: { key } }))?.value ??
          null;
        await tx.platformSetting.upsert({
          where: { key },
          create: { key, value: input.basisPoints },
          update: { value: input.basisPoints },
        });
      }
      await staffAudit(
        tx,
        actor,
        "commission.changed",
        input.organizerId ? "user" : "setting",
        key,
        input.reason,
        { basisPoints: previous },
        { basisPoints: input.basisPoints },
      );
      return { basisPoints: input.basisPoints };
    });
  }
  async finance(query: Record<string, string | undefined>) {
    if (query.organizerId) validId(query.organizerId);
    if (query.eventId) validId(query.eventId);
    const result = await financeFacts(this.db, query);
    const lifetime =
      query.from || query.to || query.eventId
        ? await financeFacts(this.db, {
            testOnly: String(result.testOnly),
            ...(query.organizerId ? { organizerId: query.organizerId } : {}),
            ...(query.eventId && !query.organizerId
              ? {
                  organizerId: (
                    await this.db.event.findUniqueOrThrow({
                      where: { id: query.eventId },
                      select: { organizerId: true },
                    })
                  ).organizerId,
                }
              : {}),
          })
        : result;
    const payouts = await this.db.organizerPayout.findMany({
      where: {
        testOnly: result.testOnly,
        ...(query.organizerId ? { organizerId: query.organizerId } : {}),
      },
      orderBy: { paidAt: "desc" },
      take: 100,
    });
    return {
      ...result,
      balances: lifetime.groups,
      groups: result.groups.map((group) => ({
        ...group,
        ...(query.from || query.to || query.eventId
          ? { outstanding: null }
          : {}),
        ...(query.eventId ? { payouts: null } : {}),
      })),
      payouts,
      defaultCommissionBps:
        (
          await this.db.platformSetting.findUnique({
            where: { key: "commission.default" },
          })
        )?.value ?? null,
      providerFeesAvailable: false,
      disputesAvailable: false,
    };
  }
  async payout(actor: StaffPrincipal, body: unknown) {
    const input = parse(payoutSchema, body);
    if (new Date(input.paidAt) > new Date())
      throw new BadRequestException({ code: "PAYOUT_DATE_FUTURE" });
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`payout:${input.organizerId}:${input.currency}`},0))`;
      const existing = await tx.organizerPayout.findUnique({
        where: { requestKey: input.key },
      });
      if (existing) {
        if (
          existing.organizerId !== input.organizerId ||
          existing.amount !== input.amount ||
          existing.currency !== input.currency ||
          existing.reference !== input.reference ||
          existing.testOnly !== input.testOnly ||
          existing.paidAt.toISOString() !== input.paidAt
        )
          throw new ConflictException({ code: "PAYOUT_KEY_REUSED" });
        return existing;
      }
      const user = await tx.user.findUniqueOrThrow({
        where: { id: input.organizerId },
      });
      if (!["organizer", "admin"].includes(user.role))
        throw new ConflictException({ code: "PAYOUT_ORGANIZER_UNAVAILABLE" });
      const { key, ...data } = input;
      const row = await tx.organizerPayout.create({
        data: {
          ...data,
          paidAt: new Date(data.paidAt),
          staffId: actor.id,
          requestKey: key,
        },
      });
      await staffAudit(
        tx,
        actor,
        "payout.recorded",
        "payout",
        row.id,
        "External payout recorded",
        undefined,
        {
          organizerId: row.organizerId,
          amount: row.amount,
          currency: row.currency,
          reference: row.reference,
          testOnly: row.testOnly,
        },
      );
      return row;
    });
  }
  async reversePayout(actor: StaffPrincipal, id: string, body: unknown) {
    validId(id);
    const { reason } = parse(reasonSchema, body);
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "OrganizerPayout" WHERE id=${id}::uuid FOR UPDATE`;
      const row = await tx.organizerPayout.findUniqueOrThrow({ where: { id } });
      if (row.reversedAt) return row;
      const updated = await tx.organizerPayout.update({
        where: { id },
        data: { reversedAt: new Date(), reversalReason: reason },
      });
      await staffAudit(tx, actor, "payout.reversed", "payout", id, reason);
      return updated;
    });
  }
}

function eventStateFilter(state: string): Prisma.EventWhereInput {
  switch (state) {
    case "pending": return { moderationStatus: "pending", status: { notIn: ["cancelled", "completed"] } };
    case "approved": case "open": return { status: "published", approvedAt: { not: null }, moderationStatus: "approved", salesPaused: false };
    case "sales_paused": case "paused": return { status: "published", approvedAt: { not: null }, moderationStatus: "sales_paused" };
    case "rejected": return { moderationStatus: "rejected", status: { notIn: ["cancelled", "completed"] } };
    case "hidden": return { moderationStatus: "hidden", status: { notIn: ["cancelled", "completed"] } };
    case "archived": return { status: "completed", moderationStatus: "expired" };
    case "completed": return { status: "completed", moderationStatus: { not: "expired" } };
    case "cancelled": return { status: state };
    case "clear": case "draft": return { status: "draft", moderationStatus: "clear" };
    default: throw new BadRequestException({ code: "EVENT_FILTER_INVALID" });
  }
}
