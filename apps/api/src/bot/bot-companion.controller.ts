import { EVENT_NOTIFICATION_TYPES } from "@event-platform/shared-types";
import { EventNotificationsService } from "../events/event-notifications.service.js";
import { type PrismaClient } from "@event-platform/database";
import { DATABASE_CLIENT } from "../auth/auth.constants.js";
import { botOrganizer } from "./bot-organizer-access.js";
import { BotGuestService } from "./bot-guest.service.js";
import type { BotConversationRef } from "@event-platform/shared-types";
import { BadRequestException, Body, Controller, Header, Inject, Param, ParseUUIDPipe, Post, StreamableFile, UseGuards } from "@nestjs/common";
import { BotApiGuard } from "../auth/auth.guards.js";
import { BotConversationsService } from "./bot-conversations.service.js";
import { BotOrganizerService } from "./bot-organizer.service.js";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const parseId = new ParseUUIDPipe({ version: "4" });

@Controller("bot/companion")
@UseGuards(BotApiGuard)
export class BotCompanionController {
  constructor(
    @Inject(BotConversationsService) private readonly conversations: BotConversationsService,
    @Inject(BotOrganizerService) private readonly organizer: BotOrganizerService,
    @Inject(EventNotificationsService) private readonly updates: EventNotificationsService,
    @Inject(DATABASE_CLIENT) private readonly database: PrismaClient,
    @Inject(BotGuestService) private readonly guests: BotGuestService,
  ) {}

  @Post("inbox") @Header("Cache-Control", "no-store")
  inbox(@Body() body: unknown) {
    const input = record(body);
    return this.conversations.inbox(...actor(input), side(input.side), page(input.page), input.eventId == null ? undefined : id(input.eventId));
  }

  @Post("inquiry/:id") @Header("Cache-Control", "no-store")
  forEvent(@Param("id", parseId) eventId: string, @Body() body: unknown) {
    return this.conversations.forEvent(...actor(record(body)), eventId);
  }

  @Post("thread/:id") @Header("Cache-Control", "no-store")
  thread(@Param("id", parseId) threadId: string, @Body() body: unknown) {
    const input = record(body);
    return this.conversations.open(...actor(input), reference(input, threadId), page(input.page));
  }

  @Post("thread/:id/send") @Header("Cache-Control", "no-store")
  send(@Param("id", parseId) threadId: string, @Body() body: unknown) {
    const input = record(body);
    const ref = input.kind === "event" && input.side === "guest" ? { kind: "event" as const, side: "guest" as const, id: threadId } : reference(input, threadId);
    if (typeof input.text !== "string" || input.text.length > 2000) throw invalid();
    return this.conversations.send(...actor(input), ref, input.text, id(input.requestKey));
  }

  @Post("inquiry/:id/close") @Header("Cache-Control", "no-store")
  close(@Param("id", parseId) inquiryId: string, @Body() body: unknown) {
    return this.conversations.close(...actor(record(body)), inquiryId);
  }

  @Post("attachments/:id") @Header("Cache-Control", "private, no-store") @Header("X-Content-Type-Options", "nosniff")
  async attachment(@Param("id", parseId) fileId: string, @Body() body: unknown) {
    const input = record(body);
    const file = await this.conversations.attachment(...actor(input), side(input.side), fileId);
    const name = encodeURIComponent(file.name).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16)}`);
    return new StreamableFile(file.buffer, { type: file.mime, disposition: `attachment; filename*=UTF-8''${name}` });
  }

  @Post("updates/:id/draft") @Header("Cache-Control", "no-store")
  async updateDraft(@Param("id", parseId) eventId: string, @Body() body: unknown) {
    const input = record(body);
    const type = EVENT_NOTIFICATION_TYPES.find(type => type === input.type);
    if (!type || typeof input.text !== "string" || input.text.length > 1000) throw invalid();
    return this.updates.operationalDraft(await botOrganizer(this.database, ...actor(input)), eventId, type, input.text, id(input.requestKey));
  }

  @Post("updates/:id/confirm") @Header("Cache-Control", "no-store")
  async confirmUpdate(@Param("id", parseId) draftId: string, @Body() body: unknown) {
    const input = record(body);
    if (typeof input.review !== "string" || !/^[a-zA-Z0-9_-]{20}$/.test(input.review)) throw invalid();
    return this.updates.operationalConfirm(await botOrganizer(this.database, ...actor(input)), draftId, input.review);
  }

  @Post("updates/:id/history") @Header("Cache-Control", "no-store")
  async updateHistory(@Param("id", parseId) eventId: string, @Body() body: unknown) {
    const input = record(body);
    return this.updates.operationalHistory(await botOrganizer(this.database, ...actor(input)), eventId, page(input.page));
  }

  @Post("preferences") @Header("Cache-Control", "no-store")
  preferences(@Body() body: unknown) {
    const input = record(body);
    if (input.key === undefined) return this.guests.preferences(...actor(input));
    if ((input.key !== "eventReminders" && input.key !== "transactionalTicketDelivery") || typeof input.enabled !== "boolean") throw invalid();
    return this.guests.preferences(...actor(input), { [input.key]: input.enabled });
  }

  @Post("alerts/:id/read") @Header("Cache-Control", "no-store")
  readAlert(@Param("id", parseId) notificationId: string, @Body() body: unknown) {
    return this.guests.readAlert(...actor(record(body)), notificationId);
  }

  @Post("events") @Header("Cache-Control", "no-store")
  events(@Body() body: unknown) {
    const input = record(body);
    if (input.tab !== "today" && input.tab !== "upcoming" && input.tab !== "past") throw invalid();
    return this.organizer.events(...actor(input), input.tab, page(input.page));
  }

  @Post("events/:id") @Header("Cache-Control", "no-store")
  snapshot(@Param("id", parseId) eventId: string, @Body() body: unknown) {
    return this.organizer.snapshot(...actor(record(body)), eventId);
  }

  @Post("events/:id/lookup") @Header("Cache-Control", "no-store")
  lookup(@Param("id", parseId) eventId: string, @Body() body: unknown) {
    const input = record(body);
    if (typeof input.search !== "string" || input.search.length > 80) throw invalid();
    const query = input.search.trim().replace(/^[№#]\s*/, "");
    if (query.length < 2) throw invalid();
    return this.organizer.lookup(...actor(input), eventId, query);
  }

  @Post("events/:id/orders/:orderId") @Header("Cache-Control", "no-store")
  order(@Param("id", parseId) eventId: string, @Param("orderId", parseId) orderId: string, @Body() body: unknown) {
    const input = record(body);
    return this.organizer.order(...actor(input), eventId, orderId, page(input.page));
  }

  @Post("tickets/:id/resend") @Header("Cache-Control", "no-store")
  resend(@Param("id", parseId) ticketId: string, @Body() body: unknown) {
    const input = record(body);
    return this.organizer.resend(...actor(input), ticketId, input.requestKey == null ? undefined : id(input.requestKey));
  }

  @Post("resends/:id") @Header("Cache-Control", "no-store")
  resendStatus(@Param("id", parseId) broadcastId: string, @Body() body: unknown) {
    return this.organizer.resendStatus(...actor(record(body)), broadcastId);
  }
}

function reference(input: Record<string, unknown>, threadId: string): BotConversationRef {
  if (input.kind !== "order" && input.kind !== "inquiry") throw invalid();
  return { side: side(input.side), kind: input.kind, id: threadId };
}
function side(value: unknown) {
  if (value !== "guest" && value !== "organizer") throw invalid();
  return value;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function actor(input: Record<string, unknown>): [string, string] {
  if (typeof input.telegramId !== "string" || typeof input.chatId !== "string") throw invalid();
  return [input.telegramId, input.chatId];
}
function id(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) throw invalid();
  return value.toLowerCase();
}
function page(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 1000) throw invalid();
  return value;
}
function invalid() { return new BadRequestException({ code: "BOT_REQUEST_INVALID" }); }
