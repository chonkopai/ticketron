import { databaseSuiteEnabled } from "@event-platform/database/test-database-guard";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "reflect-metadata";
import { prisma, type User } from "@event-platform/database";
import type { BotOperationalPreview, BotOperationalResult, BotConversationInbox, BotConversationPage, BotOrganizerOrderDetail, BotOrganizerSnapshot, EventChatPage, EventNotificationStatus, ManagementEventSummary } from "@event-platform/shared-types";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TokenService } from "../auth/token.service.js";
import { BookingService } from "../booking/booking.service.js";
import { DevelopmentPaymentProvider } from "../booking/payment-provider.js";
import { RefundService } from "../booking/refund.service.js";
import { StaffManagementService } from "../staff/staff-management.service.js";
import { TicketEmailDeliveryService } from "../orders/ticket-email-delivery.service.js";
import { PublicEventsService } from "../public-events/public-events.service.js";
import { TransactionalNotificationsService } from "../events/transactional-notifications.service.js";
import { EventsService } from "../events/events.service.js";
import { EventNotificationsService } from "../events/event-notifications.service.js";
import { AnonymousService } from "../orders/anonymous.service.js";
import { PaymentService } from "../payments/payment.service.js";
import { BotModule } from "./bot.module.js";
import { BotConversationsService } from "./bot-conversations.service.js";
import { EventChatService } from "../events/event-chat.service.js";
import { BotOrganizerService } from "./bot-organizer.service.js";
import { verifiedQuickSession } from "../test-support/verified-quick-session.js";

const enabled = databaseSuiteEnabled("Telegram companion", "TELEGRAM_COMPANION_DB_TEST");

describe.runIf(enabled)("Telegram companion across web and bot routes", () => {
  const secret = () => process.env.BOT_API_SECRET!;
  const telegramBase = BigInt(Date.now()) * 100n + BigInt(Math.floor(Math.random() * 50));
  let app: INestApplication, owner: User, buyer: User, other: User, origin: string;
  let organizerAccess: string, buyerAccess: string;
  let attachmentDir: string;
  const priorStorage = process.env.PRIVATE_SUPPORT_STORAGE_DIR;
  const telegram = (offset: number) => telegramBase + BigInt(offset);
  const context = (n: bigint) => ({ telegramId: String(n), chatId: String(n) });
  const organizer = () => context(owner.telegramId!);
  const guest = () => context(buyer.telegramId!);
  const outsider = () => context(other.telegramId!);

  beforeAll(async () => {
    attachmentDir = await mkdtemp(join(tmpdir(), "ticket-companion-"));
    process.env.PRIVATE_SUPPORT_STORAGE_DIR = attachmentDir;
    const localFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, options) => {
      if (new URL(String(input)).hostname !== "127.0.0.1") return Promise.reject(new Error("External requests disabled in companion tests"));
      return localFetch(input, options);
    });
    app = await NestFactory.create(BotModule, { logger: false, abortOnError: false });
    await app.listen(0, "127.0.0.1");
    origin = await app.getUrl();
    [owner, buyer, other] = await Promise.all([
      prisma.user.create({ data: { role: "organizer", telegramId: telegram(1), telegramChatId: telegram(1) } }),
      prisma.user.create({ data: { name: "Amina Fixture", phone: "+12025550103", telegramId: telegram(2), telegramChatId: telegram(2) } }),
      prisma.user.create({ data: { role: "organizer", telegramId: telegram(3), telegramChatId: telegram(3) } }),
    ]);
    organizerAccess = (await app.get(TokenService).issuePair(owner)).accessToken;
    buyerAccess = (await app.get(TokenService).issuePair(buyer)).accessToken;
    await prisma.telegramGuestPreference.create({ data: { telegramId: owner.telegramId!, locale: "en" } });
  });

  afterAll(async () => {
    await app?.close();
    vi.restoreAllMocks();
    await prisma.$disconnect();
    if (attachmentDir) await rm(attachmentDir, { recursive: true, force: true });
    if (priorStorage === undefined) delete process.env.PRIVATE_SUPPORT_STORAGE_DIR;
    else process.env.PRIVATE_SUPPORT_STORAGE_DIR = priorStorage;
  });

  function request(path: string, auth: Record<string, string>, body?: object) {
    return fetch(origin + path, { method: body ? "POST" : "GET",
      headers: { ...auth, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  function bot(path: string, who: ReturnType<typeof context>, body?: object) {
    return request("/bot/companion/" + path, { "x-bot-api-secret": secret() }, { ...who, ...body });
  }
  async function response<T>(promise: Promise<Response>): Promise<T> {
    const returned = await promise;
    if (!returned.ok) throw new Error(`Fixture route returned ${returned.status}: ${(await returned.json() as { code?: string }).code ?? ""}`);
    return returned.json() as Promise<T>;
  }
  async function event(title: string, date = "2035-03-02", timezone = "Asia/Almaty", eventOwner = owner.id) {
    return prisma.event.create({ data: {
      title, organizerId: eventOwner, sourceLocale: "en", date: new Date(date), time: new Date("1970-01-01T20:00:00Z"), timezone,
      address: "Fixture venue", cancellationTerms: "Fixture refund available", status: "draft",
    } });
  }
  async function approve(id: string) {
    await prisma.event.update({ where: { id }, data: { status: "published", moderationStatus: "approved", approvedAt: new Date() } });
  }
  async function admission(eventId: string, price = 12000) {
    return prisma.ticketType.create({ data: { eventId, name: "Fixture admission", status: "active", quantityTotal: 5, price, currency: "KZT" } });
  }
  async function settle(orderId: string) {
    const payment = await prisma.payment.findFirstOrThrow({ where: { orderId } });
    const signed = DevelopmentPaymentProvider.signWebhook({
      orderId, providerPaymentId: payment.providerPaymentId!, amount: payment.amount, currency: payment.currency,
      eventId: randomUUID(), eventType: "payment.succeeded",
    }, process.env.PAYMENT_PROVIDER_WEBHOOK_SECRET!, Math.floor(Date.now() / 1000));
    await app.get(BookingService).handlePaymentWebhook(app.get(PaymentService).verifyWebhook("mock", signed.rawBody,
      { "x-payment-signature": signed.headers["x-payment-signature"] }));
  }

  it("replays a failed webhook update and keeps completed deliveries deduped", async () => {
    const update = { botId: "fixture", updateId: String(telegram(90)), payloadHash: "a".repeat(64) };
    const headers = { "x-bot-api-secret": secret() };
    const claim = () => response(request("/bot/updates/claim", headers, update));
    expect(await claim()).toEqual({ process: true });
    // A redelivery while the first run owns the lease is dropped, not retried.
    expect(await claim()).toEqual({ process: false });
    expect((await request("/bot/updates/complete", headers, { ...update, failed: true })).ok).toBe(true);
    expect(await claim()).toEqual({ process: true });
    expect((await request("/bot/updates/complete", headers, update)).ok).toBe(true);
    expect(await claim()).toEqual({ process: false });
    expect((await request("/bot/updates/claim", headers, { ...update, payloadHash: "b".repeat(64) })).status).toBe(409);
  });

  it("deduplicates an anonymous inquiry, queues a generic alert, restores unread, and denies a forwarded thread", async () => {
    const { id } = await event("Inquiry fixture");
    const anon = context(telegram(9));
    await approve(id);
    const payload = { side: "guest", kind: "event", text: "Could I use the side entrance?", requestKey: randomUUID() };
    expect(await response(bot(`inquiry/${id}`, anon))).toEqual({ threadId: null });
    const [thread, retry] = await Promise.all([
      response<{ id: string }>(bot(`thread/${id}/send`, anon, payload)),
      response<{ id: string }>(bot(`thread/${id}/send`, anon, payload)),
    ]);
    expect(retry.id).toBe(thread.id);
    expect(await prisma.chatMessage.count({ where: { inquiryId: thread.id } })).toBe(1);
    expect((await bot(`thread/${thread.id}`, outsider(), { side: "guest", kind: "inquiry", page: 1 })).status).toBe(404);
    expect((await bot(`thread/${thread.id}`, outsider(), { side: "organizer", kind: "inquiry", page: 1 })).status).toBe(404);
    expect((await bot(`thread/${thread.id}`, organizer(), { side: "organizer", kind: "order", page: 1 })).status).toBe(404);
    expect((await request("/bot/companion/inbox", {}, { ...organizer(), side: "organizer", page: 1 })).status).toBe(401);
    const alerts = vi.fn(async () => "fixture-message");
    await app.get(EventNotificationsService).tick(alerts);
    expect(alerts).toHaveBeenCalledWith(organizer().chatId, "You have a new message in Ticketron.", undefined, { label: "Open conversation", start: `c_a_i_${thread.id}` });
    const restarted = new BotConversationsService(prisma, new EventChatService(prisma));
    const inbox = await restarted.inbox(organizer().telegramId, organizer().chatId, "organizer", 1, id);
    expect(inbox.items).toMatchObject([{ id: thread.id, kind: "inquiry", unread: 1 }]);
    await response(bot(`thread/${thread.id}`, organizer(), { side: "organizer", kind: "inquiry", page: 1 }));
    expect((await restarted.inbox(organizer().telegramId, organizer().chatId, "organizer", 1, id)).items[0]?.unread).toBe(0);
    await response(bot(`thread/${thread.id}/send`, organizer(), { side: "organizer", kind: "inquiry", text: "Yes, the west entrance is accessible.", requestKey: randomUUID() }));
    expect((await response<BotConversationInbox>(bot("inbox", anon, { side: "guest", page: 1 }))).items).toMatchObject([{ id: thread.id, unread: 1 }]);
    await app.get(EventNotificationsService).tick(alerts);
    expect(alerts).toHaveBeenCalledWith(anon.chatId, "У вас новое сообщение в Ticketron.", undefined, { label: "Открыть переписку", start: `c_g_i_${thread.id}` });
    await response(bot(`inquiry/${thread.id}/close`, organizer()));
    const history = await response<BotConversationPage>(bot(`thread/${thread.id}`, anon, { side: "guest", kind: "inquiry", page: 1 }));
    expect(history.thread.closed).toBe(true);
    expect(history.items.map(item => item.sender)).toEqual(["guest", "organizer"]);
    const closed = await bot(`thread/${thread.id}/send`, anon, { side: "guest", kind: "inquiry", text: "A follow-up", requestKey: randomUUID() });
    expect(await closed.json()).toMatchObject({ code: "INQUIRY_CLOSED" });
  });

  it("shares web and bot order history and read state, including verified anonymous orders", async () => {
    const { id } = await event("Order chat fixture");
    const type = await admission(id);
    await approve(id);
    const order = await app.get(BookingService).checkoutTickets(buyer.id, randomUUID(), { ticketTypeId: type.id, quantity: 1, termsAccepted: true });
    const website = `/me/events/${id}/orders/${order.orderId}/chat`;
    const webAuth = { authorization: `Bearer ${buyerAccess}` };
    // An existing, already accepted file from the private upload pipeline.
    const file = Buffer.from("%PDF-1.4\n%%EOF");
    const storageKey = `${randomUUID()}.pdf`;
    await writeFile(join(attachmentDir, storageKey), file, { mode: 0o600 });
    const attachment = await prisma.privateUpload.create({ data: { name: "Fixture attachment.pdf", mime: "application/pdf", size: file.length, storageKey, ownerId: buyer.id } });
    await response(request(website, webAuth, { text: "Website question", requestKey: randomUUID(), fileIds: [attachment.id] }));
    const organizerHistory = await response<BotConversationPage>(bot(`thread/${order.orderId}`, organizer(), { side: "organizer", kind: "order", page: 1 }));
    expect(organizerHistory.items.map(item => item.text)).toEqual(["Website question"]);
    expect(organizerHistory.items[0]?.files).toMatchObject([{ id: attachment.id }]);
    const asset = await bot(`attachments/${attachment.id}`, organizer(), { side: "organizer" });
    expect(asset.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.from(await asset.arrayBuffer())).toEqual(file);
    expect((await bot(`attachments/${attachment.id}`, outsider(), { side: "organizer" })).status).toBe(404);
    const reply = { side: "organizer", kind: "order", text: "Telegram answer", requestKey: randomUUID() };
    await response(bot(`thread/${order.orderId}/send`, organizer(), reply));
    await response(bot(`thread/${order.orderId}/send`, organizer(), reply));
    const webHistory = await response<EventChatPage>(request(website, webAuth));
    expect(webHistory.items.map(item => item.text)).toEqual(["Website question", "Telegram answer"]);
    expect(webHistory.items[0]?.readAt).toBeTruthy();
    await response(request(website + "/read", webAuth, {}));
    expect((await response<BotConversationInbox>(bot("inbox", guest(), { side: "guest", page: 1 }))).items).toMatchObject([{ id: order.orderId, unread: 0 }]);
    await expect(bot(`thread/${order.orderId}`, outsider(), { side: "guest", kind: "order", page: 1 })).resolves.toMatchObject({ status: 404 });
    const anonymous = app.get(AnonymousService);
    const verified = context(telegram(10));
    const receipt = await verifiedQuickSession("Verified fixture guest", verified.telegramId);
    const quick = await anonymous.checkout(receipt.sessionToken, randomUUID(), "ticket", { ticketTypeId: type.id, quantity: 1, termsAccepted: true });
    await response(bot(`thread/${quick.orderId}/send`, verified, { kind: "order", side: "guest", text: "Guest needs help", requestKey: randomUUID() }));
    const quickPage = await response<EventChatPage>(request(`/quick/events/${id}/orders/${quick.orderId}/chat`, { authorization: `Bearer ${receipt.accessToken}` }));
    expect(quickPage.items.map(item => item.text)).toEqual(["Guest needs help"]);
    await expect(bot(`thread/${quick.orderId}`, outsider(), { kind: "order", side: "guest", page: 1 })).resolves.toMatchObject({ status: 404 });
  });

  it("applies public visibility and caps new inquiries across events", async () => {
    const account = context(telegram(20));
    const fixtures = await Promise.all(Array.from({ length: 5 }, (_, index) => event(`Inquiry limit ${index + 1}`)));
    const hidden = fixtures.at(-1)!;
    expect((await bot(`inquiry/${hidden.id}`, account)).status).toBe(404);
    const send = (eventId: string) => bot(`thread/${eventId}/send`, account, {
      kind: "event", side: "guest", text: "A fixture question", requestKey: randomUUID(),
    });
    expect((await send(hidden.id)).status).toBe(404);
    for (const fixture of fixtures.slice(0, 4)) {
      await approve(fixture.id);
      await response(send(fixture.id));
    }
    await approve(hidden.id);
    const capped = await send(hidden.id);
    expect(await capped.json()).toMatchObject({ code: "CHAT_RATE_LIMITED" });
    expect(await prisma.eventInquiry.count({ where: { guestTelegramId: telegram(20) } })).toBe(4);
  });

  it("revalidates the update audience and tracks blocked, retrying, accepted and read separately", async () => {
    const { id } = await event("Operational fixture");
    const type = await admission(id);
    const blocked = await prisma.user.create({ data: { telegramId: telegram(31), telegramChatId: telegram(31) } });
    const retry = await prisma.user.create({ data: { telegramId: telegram(32) } });
    await approve(id);
    for (const account of [buyer, blocked, retry]) {
      const checkout = await app.get(BookingService).checkoutTickets(account.id, randomUUID(), { ticketTypeId: type.id, quantity: 1, termsAccepted: true });
      await settle(checkout.orderId);
    }
    const draftInput = { type: "venue", text: "Use the east entrance.", requestKey: randomUUID() };
    const before = await response<BotOperationalPreview>(bot(`updates/${id}/draft`, organizer(), draftInput));
    expect(before).toMatchObject({ text: "Operational fixture\n\nUse the east entrance.", audienceCount: 3, reachableCount: 2 });
    expect((await bot(`updates/${id}/draft`, outsider(), draftInput)).status).toBe(404);
    expect((await bot(`updates/${before.id}/confirm`, outsider(), { review: before.review })).status).toBe(404);
    await prisma.user.update({ where: { id: retry.id }, data: { telegramChatId: telegram(32) } });
    const fresh = await response<BotOperationalResult>(bot(`updates/${before.id}/confirm`, organizer(), { review: before.review }));
    if (!("preview" in fresh)) throw new Error("Expected fresh preview");
    expect(fresh.preview.reachableCount).toBe(3);
    const confirm = () => response<BotOperationalResult>(bot(`updates/${before.id}/confirm`, organizer(), { review: fresh.preview.review }));
    const queued = await confirm();
    expect(await confirm()).toEqual(queued);
    if (!("delivery" in queued)) throw new Error("Expected delivery");
    const broadcastId = queued.delivery.id;
    const original = globalThis.fetch;
    let rejectRetry = true;
    globalThis.fetch = (async (input, options) => {
      if (new URL(String(input)).hostname !== "api.telegram.org") return original(input, options);
      const body = JSON.parse(String(options?.body));
      if (body.text !== before.text) return Response.json({ ok: true, result: { message_id: 11 } });
      expect(body.reply_markup.inline_keyboard[0][0].url).toMatch(new RegExp(`start=e_${id}$`));
      if (body.chat_id === String(telegram(31))) return Response.json({ ok: false, error_code: 403 });
      if (body.chat_id === String(telegram(32)) && rejectRetry) return Response.json({ ok: false, error_code: 429, parameters: { retry_after: 240 } });
      return Response.json({ ok: true, result: { message_id: 12 } });
    }) as typeof fetch;
    const worker = app.get(EventNotificationsService);
    try {
      await worker.tick();
      expect(await worker.status(owner.id, id, broadcastId)).toMatchObject({ inboxReadCount: 0, counts: { accepted: 1, failed: 1, queued: 1 } });
      const waiting = await prisma.notification.findFirstOrThrow({ where: { broadcastId, channel: "telegram", lastError: "RATE_LIMITED" } });
      expect(waiting.nextAttemptAt!.getTime() - Date.now()).toBeGreaterThan(200_000);
      await prisma.notification.update({ where: { id: waiting.id }, data: { nextAttemptAt: new Date(0) } });
      rejectRetry = false;
      await worker.tick();
    } finally { globalThis.fetch = original; }
    const inboxCopy = await prisma.notification.findFirstOrThrow({ where: { broadcastId, userId: blocked.id, channel: "in_app" } });
    await response(bot(`alerts/${inboxCopy.id}/read`, context(telegram(31))));
    const history = await response<{ items: EventNotificationStatus[] }>(bot(`updates/${id}/history`, organizer(), { page: 1 }));
    expect(history.items).toMatchObject([{ id: broadcastId, inboxReadCount: 1, counts: { accepted: 2, failed: 1, queued: 0 } }]);
    await response(bot("preferences", guest(), { key: "eventReminders", enabled: false }));
    expect(await response(bot("preferences", guest()))).toMatchObject({ eventReminders: false });
    const flag = process.env.TELEGRAM_BOT_ORGANIZER_ENABLED;
    process.env.TELEGRAM_BOT_ORGANIZER_ENABLED = "false";
    try {
      expect((await bot(`updates/${id}/history`, organizer(), { page: 1 })).status).toBe(403);
      expect((await bot("preferences", guest())).status).toBe(201);
    } finally {
      if (flag === undefined) delete process.env.TELEGRAM_BOT_ORGANIZER_ENABLED;
      else process.env.TELEGRAM_BOT_ORGANIZER_ENABLED = flag;
    }
  });

  it("queues a website edit only after approval and sends the current public card link", async () => {
    const { id } = await event("Website edit fixture");
    const type = await admission(id);
    await approve(id);
    const original = await prisma.event.update({ where: { id }, data: { publishedAt: new Date() } });
    const booking = app.get(BookingService), worker = app.get(EventNotificationsService);
    const order = await booking.checkoutTickets(buyer.id, randomUUID(), { ticketTypeId: type.id, quantity: 1, termsAccepted: true });
    await settle(order.orderId);
    await app.get(EventsService).reviewLegacyContent(owner.id, id, { revision: original.revision, title: original.title,
      description: "A fixture description", address: "New fixture venue", date: "2035-03-03", time: "20:00", timezone: "Asia/Almaty" });
    const dispatcher = app.get(TransactionalNotificationsService);
    await dispatcher.tick();
    expect(await prisma.broadcast.count({ where: { eventId: id, type: "event.change" } })).toBe(0);
    const publicEvents = app.get(PublicEventsService);
    await expect(publicEvents.get(id, new Date(), "en")).rejects.toMatchObject({ status: 404 });
    const staff = await prisma.staffAccount.create({ data: { email: `${randomUUID()}@example.test`, name: "Test moderator", role: "moderator" } });
    const moderation = new StaffManagementService(prisma, app.get(TicketEmailDeliveryService), booking, worker);
    await moderation.moderate(id, { id: staff.id, role: "moderator", sessionId: randomUUID(), authenticated: true }, { action: "approve" });
    await dispatcher.tick();
    await dispatcher.tick();
    expect(await prisma.broadcast.count({ where: { eventId: id, type: "event.change" } })).toBe(1);
    await expect(publicEvents.get(id, new Date(), "en")).resolves.toMatchObject({ address: "New fixture venue", date: "2035-03-03" });
    const send = vi.fn(async () => "fixture-accepted");
    await worker.tick(send);
    expect(send).toHaveBeenCalledWith(guest().chatId, expect.stringContaining("New fixture venue"), undefined, expect.objectContaining({ start: `e_${id}` }));
    await app.get(RefundService).request(owner.id, id, order.orderId, "Fixture completed refund");
    await dispatcher.tick();
    const refund = await prisma.notification.findFirst({ where: { eventId: id, type: "refund.succeeded", channel: "telegram", userId: buyer.id } });
    expect(refund?.payload).toMatchObject({ orderId: order.orderId });
  });

  it("uses venue-local dates and the web dashboard metrics, and resends a single existing admission", async () => {
    const localEvent = await event("Local midnight fixture", "2035-02-18");
    const utcEvent = await event("UTC midnight fixture", "2035-02-18", "UTC");
    await approve(utcEvent.id);
    const local = new BotOrganizerService(prisma, { now: () => new Date("2035-02-17T19:30:00Z") }, app.get(EventsService), app.get(EventNotificationsService));
    expect((await local.events(organizer().telegramId, organizer().chatId, "today", 1)).items.map(row => row.id)).toContain(localEvent.id);
    expect((await local.events(organizer().telegramId, organizer().chatId, "today", 1)).items.map(row => row.id)).not.toContain(utcEvent.id);
    expect((await local.events(outsider().telegramId, outsider().chatId, "upcoming", 1)).items).toEqual([]);
    const { id } = localEvent;
    const type = await admission(id);
    const layout = await prisma.venueLayout.create({ data: { eventId: id, templateName: "Fixture", layoutJson: { version: 1, canvas: { width: 800, height: 600 }, tables: [] } } });
    const table = await prisma.table.create({ data: { venueLayoutId: layout.id, number: 1, seats: 2, price: 30000, deposit: 0, currency: "KZT" } });
    await approve(id);
    const booking = app.get(BookingService);
    const first = await booking.checkoutTable(buyer.id, randomUUID(), { tableId: table.id, termsAccepted: true });
    await settle(first.orderId);
    const second = await booking.checkoutTickets(buyer.id, randomUUID(), { ticketTypeId: type.id, quantity: 1, termsAccepted: true });
    await settle(second.orderId);
    await app.get(RefundService).request(owner.id, id, second.orderId, "Fixture refund requested");
    const snapshot = await response<BotOrganizerSnapshot>(bot(`events/${id}`, organizer()));
    const web = await response<ManagementEventSummary>(request(`/organizer/events/${id}/management-summary`, { authorization: `Bearer ${organizerAccess}` }));
    expect(snapshot.inventory).toEqual(web.inventory);
    expect(snapshot.money).toEqual(web.money);
    expect(snapshot.orders).toEqual(web.orders);
    expect(snapshot.inventory.wholeTables.sold).toBe(1);
    expect(snapshot.money.completedRefunds).toEqual([{ amount: 12000, currency: "KZT" }]);
    const lookup = await response<{ items: Array<{ id: string; buyerName: string; buyer?: unknown }> }>(bot(`events/${id}/lookup`, organizer(), { search: "Amina" }));
    expect(lookup.items).toContainEqual(expect.objectContaining({ id: first.orderId, buyerName: "Amina Fixture" }));
    expect((await response<{ items: Array<{ id: string }> }>(bot(`events/${id}/lookup`, organizer(), { search: `№${first.orderId.slice(0, 8)}` }))).items).toMatchObject([{ id: first.orderId }]);
    expect(JSON.stringify(lookup)).not.toContain(buyer.phone);
    expect((await response<{ items: unknown[] }>(bot(`events/${id}/lookup`, organizer(), { search: buyer.phone }))).items).toEqual([]);
    expect((await bot(`events/${id}`, outsider())).status).toBe(404);
    expect((await bot(`events/${utcEvent.id}/orders/${first.orderId}`, organizer(), { page: 1 })).status).toBe(404);

    const detail = await response<BotOrganizerOrderDetail>(bot(`events/${id}/orders/${first.orderId}`, organizer(), { page: 1 }));
    const ticketId = detail.tickets.find(ticket => ticket.canResend)!.id;
    const before = await prisma.ticket.findMany({ where: { orderId: first.orderId }, select: { id: true, qrToken: true }, orderBy: { id: "asc" } });
    expect((await bot(`tickets/${ticketId}/resend`, outsider(), { requestKey: randomUUID() })).status).toBe(404);
    expect((await response<{ status: unknown }>(bot(`tickets/${ticketId}/resend`, organizer()))).status).toBeNull();
    const confirm = { requestKey: randomUUID() };
    const queued = await response<{ status: EventNotificationStatus }>(bot(`tickets/${ticketId}/resend`, organizer(), confirm));
    const repeat = await response<{ status: EventNotificationStatus }>(bot(`tickets/${ticketId}/resend`, organizer(), confirm));
    expect(repeat.status.id).toBe(queued.status.id);
    const deliver = vi.fn(async () => "fixture-photo");
    await app.get(EventNotificationsService).tick(async () => "fixture-text", deliver);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect((await response<{ status: EventNotificationStatus }>(bot(`resends/${queued.status.id}`, organizer()))).status.counts.accepted).toBe(1);
    expect(await prisma.ticket.findMany({ where: { orderId: first.orderId }, select: { id: true, qrToken: true }, orderBy: { id: "asc" } })).toEqual(before);
    expect(await prisma.order.findUnique({ where: { id: first.orderId }, select: { paymentStatus: true } })).toEqual({ paymentStatus: "paid" });
    await prisma.user.update({ where: { id: owner.id }, data: { role: "guest" } });
    try {
      expect((await bot(`events/${id}`, organizer())).status).toBe(403);
      expect((await bot(`tickets/${ticketId}/resend`, organizer(), confirm)).status).toBe(403);
    } finally {
      await prisma.user.update({ where: { id: owner.id }, data: { role: "organizer" } });
    }
  });
});
