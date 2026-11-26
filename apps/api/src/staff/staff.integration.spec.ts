import { databaseSuiteEnabled } from "@event-platform/database/test-database-guard";
import {HomepageAdvertisementsService} from "../public-events/homepage-advertisements.service.js";
import {PublicEventsService} from "../public-events/public-events.service.js";
import { PaymentService } from "../payments/payment.service.js";
import { newEventCreationDraft } from "@event-platform/shared-types";
import { CreationDraftsService } from "../creation-drafts/creation-drafts.service.js";
import { DraftPublicationService } from "../creation-drafts/draft-publication.service.js";
import { DraftMediaStorage } from "../creation-drafts/draft-media-storage.js";
import { csrfFor, type DraftAccess } from "../creation-drafts/draft-security.js";
import { TicketsService } from "../tickets/tickets.service.js";
import { EventsService } from "../events/events.service.js";
import { TicketTypesService } from "../ticket-types/ticket-types.service.js";
import { AccountService } from "../auth/account.service.js";
import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "@event-platform/database";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generate } from "otplib";
import { AppModule } from "../app.module.js";
import { hashPassword } from "../auth/password.js";
import { BookingService } from "../booking/booking.service.js";
import { TokenService } from "../auth/token.service.js";
import { AuthService } from "../auth/auth.service.js";
import { StaffAuthService, staffCookie } from "./staff-auth.service.js";
import { PlatformSupportService } from "./platform-support.service.js";
import { StaffManagementService, csvCell } from "./staff-management.service.js";
import { StaffRefundsService } from "./staff-refunds.service.js";
import { digest, type StaffPrincipal } from "./staff.config.js";
import { bootstrapModerator } from "./bootstrap.js";
import { AnonymousService, secretHash } from "../orders/anonymous.service.js";
import { EventChatService } from "../events/event-chat.service.js";
import { EventNotificationsService } from "../events/event-notifications.service.js";
import { TicketEmailDeliveryService } from "../orders/ticket-email-delivery.service.js";
import {
  DevelopmentPaymentProvider,
  type PaymentProvider,
} from "../booking/payment-provider.js";
const enabled = databaseSuiteEnabled("staff / platform integration", "STAFF_DATABASE_TEST");
const suite = enabled ? describe : describe.skip;
suite("isolated staff / platform integration", () => {
  let app: INestApplication,
    base: string,
    auth: StaffAuthService,
    support: PlatformSupportService,
    management: StaffManagementService,
    refunds: StaffRefundsService,
    privateDir: string;
  const namespace = randomUUID().slice(0, 8),
    password = "test-only-staff-password-123",
    reason = "Customer requested eligible cancellation",
    customer = randomUUID(),
    other = randomUUID(),
    organizer = randomUUID(),
    legacy = randomUUID(),
    event = randomUUID(),
    type = randomUUID();
  let admin: StaffPrincipal,
    agent: StaffPrincipal,
    adminToken: string,
    adminCsrf: string,
    agentToken: string,
    agentCsrf: string,
    customerToken: string,
    legacyToken: string,
    agentEmail: string,
    recoveryCodes: string[] = [];
  const mails: { to: string; url: string }[] = [];
  async function request(
    path: string,
    method = "GET",
    body?: unknown,
    who: "admin" | "support" | "public" | "none" = "admin",
    extra: Record<string, string> = {},
  ) {
    const staff = who === "admin" || who === "support";
    return fetch(base + path, {
      method,
      headers: {
        ...(staff
          ? {
              "x-staff-gateway": auth.config.gatewaySecret,
              "x-staff-origin": auth.config.origin,
              cookie: `${staffCookie(auth.config)}=${who === "admin" ? adminToken : agentToken}`,
              "x-staff-csrf": who === "admin" ? adminCsrf : agentCsrf,
            }
          : who === "public"
            ? { authorization: `Bearer ${customerToken}` }
            : {}),
        ...(body ? { "content-type": "application/json" } : {}),
        ...extra,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  async function enroll(email: string) {
    const login = await auth.login(email, password),
      actor = await auth.authenticate(
        login.token,
        login.session.csrf,
        true,
        true,
      ),
      enrollment = await auth.enrollment(actor),
      result = await auth.otp(
        actor,
        await generate({ secret: enrollment.secret }),
      );
    return { ...result, actor: await auth.authenticate(result.token) };
  }
  async function purchase(
    options: {
      anonymous?: boolean;
      currency?: string;
      used?: boolean;
      legacy?: boolean;
    } = {},
  ) {
    const id = randomUUID(),
      currency = options.currency ?? "KZT",
      now = new Date();
    const snapshot = options.legacy
      ? {
          eventId: event,
          eventTitle: "Historical purchase",
          itemId: type,
          itemKind: "ticket",
          itemName: "Entry",
          quantity: 2,
          amountDue: 2000,
          paymentMode: "full_payment",
        }
      : {
          version: 2,
          eventId: event,
          sourceLocale: "ru",
          contentLocale: "ru",
          title: "Integration concert",
          address: "Test street",
          startsAt: "2031-10-22T10:00:00.000Z",
          endsAt: null,
          timezone: "UTC",
          saleMode: "paid_general",
          amount: 2000,
          currency,
          acceptedAt: now.toISOString(),
          refund: {
            available: true,
            conditions: "Before entry",
            revision: 1,
            locale: "ru",
            freeCancellation: false,
          },
          items: [
            {
              resourceId: type,
              kind: "ticket",
              name: "Entry",
              quantity: 2,
              unitAmount: 1000,
            },
          ],
        };
    await prisma.order.create({
      data: {
        id,
        type: "ticket",
        buyerUserId: options.anonymous ? null : customer,
        amount: 2000,
        currency,
        paymentStatus: "paid",
        checkoutSnapshot: snapshot,
      },
    });
    await prisma.payment.create({
      data: {
        orderId: id,
        provider: "mock",
        providerRequestKey: randomUUID(),
        providerPaymentId: `dev-${id}`,
        amount: 2000,
        currency,
        status: "paid",
        webhookReceivedAt: now,
      },
    });
    await prisma.ticketType.update({
      where: { id: type },
      data: { quantitySold: { increment: 2 } },
    });
    const tickets = await Promise.all(
      [0, 1].map((_, index) =>
        prisma.ticket.create({
          data: {
            orderId: id,
            ticketTypeId: type,
            ownerUserId: options.anonymous ? null : customer,
            qrToken: randomUUID(),
            status: options.used && index === 0 ? "used" : "active",
            ...(options.used && index === 0 ? { usedAt: now } : {}),
          },
        }),
      ),
    );
    return { id, tickets };
  }
  beforeAll(async () => {
    privateDir = await mkdtemp(join(tmpdir(), "ticket-staff-integration-"));
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    auth = app.get(StaffAuthService);
    support = app.get(PlatformSupportService);
    management = app.get(StaffManagementService);
    refunds = app.get(StaffRefundsService);
    auth.config.storageDir = privateDir;
    Object.defineProperty(app.get(DraftMediaStorage), "directory", { value: join(privateDir, "event-media") });
    // Only this service instance gets a fake mail adapter. No external email is sent.
    auth.config.emailKey = "test-only";
    auth.config.emailFrom = "test@mail.example.test";
    vi.spyOn(
      auth as unknown as {
        sendEmail: (to: string, subject: string, url: string) => Promise<void>;
      },
      "sendEmail",
    ).mockImplementation(async (to, _subject, url) => {
      mails.push({ to, url });
    });
    const staff = await prisma.staffAccount.create({
      data: {
        email: `moderator-${namespace}@example.test`,
        name: "Тестовый модератор",
        role: "moderator",
        passwordHash: await hashPassword(password),
      },
    });
    const session = await enroll(staff.email);
    admin = session.actor;
    adminToken = session.token;
    adminCsrf = session.session.csrf;
    for (const old of await prisma.staffAccount.findMany({
      where: { id: { not: staff.id }, disabledAt: null },
    }))
      await auth.change(admin, old.id, {
        disabled: true,
        reason: "Retire previous disposable test fixture",
      });
    await prisma.user.createMany({
      data: [
        {
          id: customer,
          role: "guest",
          name: `Покупатель ${namespace}`,
          email: `buyer-${namespace}@example.test`,
        },
        { id: other, role: "guest", name: "Другой покупатель" },
        { id: organizer, role: "organizer", name: "Тестовый организатор" },
        { id: legacy, role: "admin", name: "Legacy public admin" },
      ],
    });
    await prisma.event.create({
      data: {
        id: event,
        organizerId: organizer,
        title: "Integration concert",
        description: "Test",
        date: new Date("2031-10-22"),
        time: new Date("1970-01-01T10:00Z"),
        timezone: "UTC",
        address: "Test street",
        status: "published",
        category: "music",
        countryCode: "KZ",
        city: "Almaty",
      },
    });
    await prisma.ticketType.create({
      data: {
        id: type,
        eventId: event,
        name: "Entry",
        price: 1000,
        currency: "KZT",
        quantityTotal: 1000,
        status: "active",
      },
    });
    await prisma.event.update({where:{id:event},data:{moderationStatus:"pending"}});
    await management.moderate(event, admin, {action:"approve"});
    await management.commission(admin, {
      basisPoints: 500,
      reason: "Explicit commission for disposable test purchases",
    });
    customerToken = (
      await app
        .get(TokenService)
        .issuePair(
          await prisma.user.findUniqueOrThrow({ where: { id: customer } }),
        )
    ).accessToken;
    legacyToken = (
      await app
        .get(TokenService)
        .issuePair(
          await prisma.user.findUniqueOrThrow({ where: { id: legacy } }),
        )
    ).accessToken;
  }, 30000);
  afterAll(async () => {
    vi.restoreAllMocks();
    if (app) await app.close();
    if (privateDir) await rm(privateDir, { recursive: true, force: true });
    await prisma.$disconnect();
  });
  it("separates staff APIs from public and legacy admin tokens, requires gateway and CSRF", async () => {
    expect(
      (
        await request("/staff/users", "GET", undefined, "none", {
          authorization: `Bearer ${legacyToken}`,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request("/staff/users", "GET", undefined, "admin", {
          cookie: "",
          authorization: `Bearer ${legacyToken}`,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(
          `/staff/users/${other}/block`,
          "POST",
          { reason },
          "admin",
          { "x-staff-csrf": "wrong" },
        )
      ).status,
    ).toBe(403);
    expect((await request("/staff/users")).status).toBe(200);
  });
  it("prevents the last enrolled Moderator from being disabled or demoted", async () => {
    await expect(
      auth.change(admin, admin.id, { disabled: true, reason }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      bootstrapModerator(prisma, "another@example.test", "Another", password),
    ).rejects.toThrow("Staff already exists");
  });
  it("invites Support with hashed single-use tokens; MFA is mandatory and encrypted", async () => {
    agentEmail = `support-${namespace}@example.test`;
    await auth.invite(admin, {
      email: agentEmail,
      name: "Тестовая поддержка",
      role: "support",
    });
    const raw = new URL(mails.at(-1)!.url).hash.slice("#invite=".length);
    expect(mails.at(-1)!.url).toContain("/admin/login#invite=");
    const token = await prisma.staffToken.findUniqueOrThrow({
      where: { tokenHash: digest(raw) },
    });
    expect(token.tokenHash).not.toBe(raw);
    await auth.accept(raw, password, "invite");
    await expect(auth.accept(raw, password, "invite")).rejects.toMatchObject({
      status: 401,
    });
    const pending = await auth.login(agentEmail, password);
    await expect(auth.authenticate(pending.token)).rejects.toMatchObject({
      status: 401,
    });
    const session = await enroll(agentEmail);
    agent = session.actor;
    agentToken = session.token;
    agentCsrf = session.session.csrf;
    recoveryCodes = session.recoveryCodes;
    const stored = await prisma.staffAccount.findUniqueOrThrow({
      where: { id: agent.id },
    });
    expect(stored.mfaSecret).not.toMatch(/^[A-Z2-7]+$/);
    expect(stored.recoveryHashes).not.toContain(recoveryCodes[0]);
    expect(
      (await request("/staff/finance", "GET", undefined, "support")).status,
    ).toBe(403);
    expect(
      (
        await request(
          `/staff/users/${other}/block`,
          "POST",
          { reason },
          "support",
        )
      ).status,
    ).toBe(403);
  });
  it("expires invitations and provides a truthful mail-unavailable recovery state", async () => {
    const email = `expired-${namespace}@example.test`;
    await auth.invite(admin, { email, name: "Expired", role: "support" });
    const raw = new URL(mails.at(-1)!.url).hash.slice("#invite=".length);
    await prisma.staffToken.update({
      where: { tokenHash: digest(raw) },
      data: { expiresAt: new Date(0) },
    });
    await expect(auth.accept(raw, password, "invite")).rejects.toMatchObject({
      status: 401,
    });
    const old = auth.config.emailKey;
    auth.config.emailKey = undefined;
    await expect(auth.recover(agentEmail)).rejects.toMatchObject({
      status: 503,
    });
    auth.config.emailKey = old;
  });
  it("recovers a staff password, consumes recovery codes once, and immediately revokes sessions", async () => {
    await auth.recover(agentEmail);
    const raw = new URL(mails.at(-1)!.url).hash.slice(7);
    await auth.accept(raw, password, "reset");
    await expect(auth.authenticate(agentToken)).rejects.toMatchObject({
      status: 401,
    });
    const login = await auth.login(agentEmail, password),
      pending = await auth.authenticate(login.token, undefined, false, true),
      result = await auth.otp(pending, recoveryCodes[0]!);
    agentToken = result.token;
    agentCsrf = result.session.csrf;
    agent = await auth.authenticate(agentToken);
    const again = await auth.login(agentEmail, password);
    await expect(
      auth.otp(
        await auth.authenticate(again.token, undefined, false, true),
        recoveryCodes[0]!,
      ),
    ).rejects.toMatchObject({ status: 401 });
  });
  it("keeps customer/organizer cases independent and excludes internal notes and impersonation", async () => {
    const input = {
      subject: "Помогите с заказом",
      text: "Первый вопрос",
      clientKey: randomUUID(),
    };
    const row = await support.create(
      { userId: customer, role: "guest" },
      input,
    );
    await support.create(
      { userId: organizer, role: "organizer" },
      { ...input, subject: "Вопрос организатора", clientKey: randomUUID() },
    );
    await expect(
      support.messages(row.id, { userId: other }, {}),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      support.message(
        row.id,
        { userId: customer },
        { text: "Fake", clientKey: randomUUID(), internal: true },
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      support.message(
        row.id,
        { userId: customer },
        { text: "Fake", clientKey: randomUUID(), authorKind: "moderator" },
      ),
    ).rejects.toMatchObject({ status: 400 });
    await support.message(row.id, agent, {
      text: "Секретная заметка",
      clientKey: randomUUID(),
      internal: true,
    });
    await support.message(row.id, agent, {
      text: "Ответ поддержки",
      clientKey: randomUUID(),
    });
    const publicMessages = await support.messages(
      row.id,
      { userId: customer },
      {},
    );
    expect(publicMessages.items.map((v) => v.text)).not.toContain(
      "Секретная заметка",
    );
    expect(publicMessages.items.map((v) => v.authorKind)).toContain("support");
    await prisma.platformCase.update({ where: { id: row.id }, data: { status: "closed" } });
    await support.message(
      row.id,
      { userId: customer },
      { text: "Ещё вопрос", clientKey: randomUUID() },
    );
    expect((await support.access(row.id, agent)).status).toBe("in_progress");
  });
  it("archives expired pending events using event-local time and preserves ongoing reviews", async () => {
    const base = { organizerId: organizer, title: "Moderation cutoff fixture", address: "Test venue",
      date: new Date("2020-01-01"), time: new Date("1970-01-01T19:00:00Z"), timezone: "Asia/Almaty" };
    const expired = await prisma.event.create({ data: { ...base, moderationStatus: "pending" } });
    const ongoing = await prisma.event.create({ data: { ...base, moderationStatus: "pending",
      startsAt: new Date("2020-01-01T13:00:00Z"), endsAt: new Date(Date.now() + 600_000) } });
    const pending = await management.events({ search: base.title, status: "pending" });
    expect(pending.items.map(event => event.id)).toEqual([ongoing.id]);
    expect(pending.items.map(event => event.ticketsSold)).toEqual([0]);
    const archived = await management.events({ search: base.title, status: "archived" });
    expect(archived.items).toMatchObject([{ id: expired.id, status: "completed", moderationStatus: "expired", revision: expired.revision + 1 }]);
    await expect(management.moderate(expired.id, admin, { action: "approve" })).rejects.toMatchObject({ status: 409 });
    expect((await prisma.event.findUniqueOrThrow({ where: { id: expired.id } })).revision).toBe(expired.revision + 1);
  });
  async function submitReviewFixture(mode: "free" | "paid_general" = "free") {
    const drafts = app.get(CreationDraftsService), publication = app.get(DraftPublicationService);
    const created = await drafts.create("ru", randomUUID()), assetId = randomUUID();
    const access: DraftAccess = { capability: created.capability, quotaScope: `browser:${randomUUID()}` };
    access.csrf = csrfFor(created.draft.id, access, drafts.config.hmacSecret, true);
    await prisma.mediaAsset.create({data:{id:assetId,draftId:created.draft.id,kind:"image",state:"ready",storageKey:`${assetId}/original`,checksum:"a".repeat(64),contentType:"image/png",bytes:100n,width:800,height:500,derivatives:{display:"display.webp",thumbnail:"thumbnail.webp"}}});
    const storage = app.get(DraftMediaStorage); await mkdir(join(storage.directory, assetId), {recursive:true}); await writeFile(join(storage.directory, assetId, "display.webp"), Buffer.from("RIFFtestWEBP"));
    const draft = newEventCreationDraft(randomUUID(), "ru");
    draft.selectedMode=mode; draft.refundsAvailable=false; draft.currency="KZT"; draft.paidGeneral=[{id:randomUUID(),active:true,amount:1000,capacity:20,content:{ru:{name:"Входной билет"}}}]; draft.content.ru={title:`Moderation ${randomUUID()}`,description:"Описание для проверки",address:"Тестовый адрес"};
    draft.classification={category:"music",countryCode:"KZ",city:"Алматы",ageRestriction:0};
    draft.schedule={startLocal:"2031-12-01T20:00",endLocal:"2031-12-01T23:00",timezone:"Asia/Almaty",startChoice:null,endChoice:null};
    draft.free.capacity=20; draft.free.content.ru={name:"Приглашение"}; draft.media.slots[0]=assetId; draft.media.cardAssetId=assetId; draft.media.backgroundAssetId=assetId;
    const saved=await drafts.mutate(created.draft.id, access, created.draft.revision,()=>draft);
    const intent=await publication.intent(saved.id,access,saved.revision);
    const owner:DraftAccess={...access,principal:{userId:organizer,role:"organizer"}};
    const result=await publication.publish(saved.id,intent.id,owner);
    owner.csrf=csrfFor(saved.id,owner,drafts.config.hmacSecret,false);
    return {id:result.eventId,assetId,draftId:saved.id,draft,owner,drafts,publication};
  }
  it("always submits new events for review and guards listings, detail, venue, media and direct registration", async()=>{
    const f=await submitReviewFixture();
    expect(await prisma.event.findUnique({where:{id:f.id}})).toMatchObject({status:"draft",moderationStatus:"pending",approvedAt:null,publishedAt:null});
    expect((await app.get(EventsService).list(organizer,{page:1,limit:100,statusGroup:"pending"})).items.map(row=>row.id)).toContain(f.id);
    expect((await fetch(`${base}/events/${f.id}`)).status).toBe(404);
    const listing=await fetch(`${base}/events?search=${encodeURIComponent(f.draft.content.ru!.title!)}&page=1&limit=20&sort=recent`);
    expect((await listing.json() as {items:unknown[]}).items).toHaveLength(0);
    expect((await fetch(`${base}/media/events/${f.id}/${f.assetId}/display`)).status).toBe(404);
    await expect(app.get(BookingService).checkoutTickets(customer,randomUUID(),{ticketTypeId:f.draft.free.id,quantity:1,termsAccepted:true,contentLocale:"ru",policyRevision:1})).rejects.toMatchObject({status:404});
    await expect(app.get(TicketTypesService).reserve(f.draft.free.id,1,new Date(Date.now()+300000))).rejects.toMatchObject({status:409});
    expect((await request(`/staff/events/${f.id}/preview`,"GET",undefined,"none")).status).toBe(403);
    const preview=await request(`/staff/events/${f.id}/preview?locale=ru`,"GET",undefined,"support");
    expect(preview.status).toBe(200); expect(await preview.json()).toMatchObject({event:{id:f.id,title:f.draft.content.ru!.title,ticketTypes:[{id:f.draft.free.id}],media:[{url:`/staff-api/events/${f.id}/media/${f.assetId}/display`}]}});
    expect((await request(`/staff/events/${f.id}/media/${f.assetId}/display`,"GET",undefined,"support")).status).toBe(200);
    expect((await request(`/staff/events/${f.id}/moderate`,"POST",{action:"approve"},"support")).status).toBe(201);
    expect((await fetch(`${base}/events/${f.id}`)).status).toBe(200);
    expect((await fetch(`${base}/media/events/${f.id}/${f.assetId}/display`)).status).toBe(200);
    expect((await prisma.event.findUniqueOrThrow({where:{id:f.id}})).approvedByStaffId).toBe(agent.id);
  });
  it("rejects with an optional reason, permits corrections and resubmission, and preserves existing paid-ticket access", async()=>{
    const f=await submitReviewFixture("paid_general");
    expect((await request(`/staff/events/${f.id}/moderate`,"POST",{action:"reject",reason:"Уточните адрес"},"support")).status).toBe(201);
    expect((await app.get(EventsService).list(organizer,{page:1,limit:100,statusGroup:"rejected"})).items.map(row=>row.id)).toContain(f.id);
    const notification=await prisma.notification.findFirstOrThrow({where:{eventId:f.id,type:"event.moderation"},orderBy:{createdAt:"desc"}});
    expect(notification.payload).toMatchObject({action:"reject",reason:"Уточните адрес",organizerEvent:true});
    const localized=await app.get(AccountService).notifications(organizer,{page:1,limit:50,locale:"en"});
    expect(localized.items.find(row=>row.id===notification.id)?.text).toContain("rejected");
    const editor=await f.publication.openOwned(f.id,f.owner),access={...f.owner,csrf:editor.csrfToken};
    const saved=await f.drafts.update(editor.id,access,editor.revision,{content:{ru:{address:"Уточнённый адрес"}}});
    await f.publication.saveOwned(editor.id,access,saved.revision);
    expect(await prisma.event.findUnique({where:{id:f.id}})).toMatchObject({moderationStatus:"pending",approvedAt:null});
    await management.moderate(f.id,admin,{action:"approve"});
    const booking=await app.get(BookingService).checkoutTickets(customer,randomUUID(),{ticketTypeId:f.draft.paidGeneral[0]!.id,quantity:1,termsAccepted:true,contentLocale:"ru",policyRevision:1});
    await app.get(BookingService).settleSucceeded(booking.orderId);
    const snapshot=(await prisma.order.findUniqueOrThrow({where:{id:booking.orderId}})).checkoutSnapshot;
    const reopened=await f.publication.openOwned(f.id,f.owner),editAccess={...f.owner,csrf:reopened.csrfToken};
    const changed=await f.drafts.update(reopened.id,editAccess,reopened.revision,{content:{ru:{title:"Изменённое название"}}});
    await f.publication.saveOwned(reopened.id,editAccess,changed.revision);
    expect((await fetch(`${base}/events/${f.id}`)).status).toBe(404);
    expect((await prisma.order.findUniqueOrThrow({where:{id:booking.orderId}})).checkoutSnapshot).toEqual(snapshot);
    expect((await app.get(TicketsService).getForUser(customer,booking.ticketIds[0]!)).status).toBe("active");
    const count=await prisma.notification.count({where:{eventId:f.id,type:"event.moderation"}});
    await expect(management.moderate(f.id,admin,{action:"approve",revision:999})).rejects.toMatchObject({status:409});
    expect(await prisma.notification.count({where:{eventId:f.id,type:"event.moderation"}})).toBe(count);
    await management.moderate(f.id,admin,{action:"reject"});
  });
  it("keeps sales pauses separate from hiding and limits support staff to review decisions",async()=>{
    const f=await submitReviewFixture(); await management.moderate(f.id,admin,{action:"approve"});
    const approved=(await prisma.event.findUniqueOrThrow({where:{id:f.id}})).approvedAt;
    expect((await request(`/staff/events/${f.id}/moderate`,"POST",{action:"pause"},"support")).status).toBe(403);
    await management.moderate(f.id,admin,{action:"pause"});
    expect((await app.get(EventsService).list(organizer,{page:1,limit:100,statusGroup:"paused"})).items.map(row=>row.id)).toContain(f.id);
    expect((await fetch(`${base}/events/${f.id}`)).status).toBe(200);
    await expect(app.get(BookingService).checkoutTickets(customer,randomUUID(),{ticketTypeId:f.draft.free.id,quantity:1,termsAccepted:true,contentLocale:"ru",policyRevision:1})).rejects.toMatchObject({status:409});
    await management.moderate(f.id,admin,{action:"hide"}); expect((await fetch(`${base}/events/${f.id}`)).status).toBe(404);
    await management.moderate(f.id,admin,{action:"unhide"});
    expect(await prisma.event.findUnique({where:{id:f.id}})).toMatchObject({moderationStatus:"sales_paused",salesPaused:true,approvedAt:approved});
    await management.moderate(f.id,admin,{action:"resume"});
    await prisma.ticketType.update({where:{id:f.draft.free.id},data:{quantitySold:{increment:1}}});
    expect((await prisma.event.findUniqueOrThrow({where:{id:f.id}})).approvedAt).toEqual(approved);
    await prisma.ticketType.update({where:{id:f.draft.free.id},data:{name:"Изменённое приглашение"}});
    expect(await prisma.event.findUnique({where:{id:f.id}})).toMatchObject({moderationStatus:"pending",approvedAt:null});
  });
  it("blocks payment resumption and settlement after approval is revoked",async()=>{
    const f=await submitReviewFixture("paid_general");await management.moderate(f.id,admin,{action:"approve"});
    const checkout=await app.get(BookingService).checkoutTickets(customer,randomUUID(),{ticketTypeId:f.draft.paidGeneral[0]!.id,quantity:1,termsAccepted:true,contentLocale:"ru",policyRevision:1});
    await prisma.event.update({where:{id:f.id},data:{description:"An edit awaiting approval"}});
    await expect(app.get(PaymentService).createLink(customer,checkout.orderId,randomUUID())).rejects.toMatchObject({status:409});
    await expect(app.get(BookingService).settleSucceeded(checkout.orderId)).rejects.toMatchObject({status:409});
    expect((await prisma.order.findUniqueOrThrow({where:{id:checkout.orderId}})).paymentStatus).toBe("pending");
  });
  it("supports a revision-checked legacy correction without changing sale resources",async()=>{
    const id=randomUUID();await prisma.event.create({data:{id,organizerId:organizer,title:"Legacy review",description:"Details",address:"Old address",date:new Date("2031-12-01"),time:new Date("1970-01-01T12:00:00Z"),status:"draft",moderationStatus:"rejected"}});
    const updated=await app.get(EventsService).reviewLegacyContent(organizer,id,{revision:1,title:"Corrected legacy",description:"Corrected details",address:"New address",date:"2031-12-01",time:"13:00",timezone:"UTC"});
    expect(updated).toMatchObject({moderationStatus:"pending",approvedAt:null,revision:2});
    await expect(app.get(EventsService).reviewLegacyContent(other,id,{revision:2,title:"Stolen",description:"Details",address:"Here",date:"2031-12-01",time:"13:00",timezone:"UTC"})).rejects.toMatchObject({status:404});
    await management.moderate(id,admin,{action:"approve"});
    const layout=await prisma.venueLayout.create({data:{eventId:id,templateName:"Hall",layoutJson:{}}});
    const table=await prisma.table.create({data:{venueLayoutId:layout.id,number:1,seats:2,price:1000,deposit:0,currency:"KZT"}});
    await management.moderate(id,admin,{action:"approve"});
    await prisma.table.update({where:{id:table.id},data:{status:"held",holdToken:randomUUID(),holdRequestKey:randomUUID(),holdExpiresAt:new Date(Date.now()+60000)}});
    expect((await prisma.event.findUniqueOrThrow({where:{id}})).approvedAt).not.toBeNull();
    await prisma.table.update({where:{id:table.id},data:{name:"Corrected table"}});
    expect((await prisma.event.findUniqueOrThrow({where:{id}})).approvedAt).toBeNull();
  });
  it("uses customer context for organizer accounts and attaches the first message atomically", async () => {
    const actor = { userId: organizer, role: "organizer" };
    const buffer = Buffer.from("%PDF-1.4\nhello\n%%EOF");
    const file = await support.upload(actor, { buffer, originalname: "first.pdf", mimetype: "application/pdf", size: buffer.length });
    const input = { subject: "Customer identity", text: "I am buying a ticket", clientKey: randomUUID(), fileIds: [file.id] };
    const row = await support.create(actor, input);
    expect(row.requesterKind).toBe("customer");
    const page = await support.messages(row.id, actor, {});
    expect(page.items[0]).toMatchObject({ authorKind: "customer", files: [{ id: file.id }] });
    expect((await support.create(actor, input)).id).toBe(row.id);
    await expect(support.create(actor, { ...input, fileIds: [] })).rejects.toMatchObject({ status: 409 });
    await support.message(row.id, actor, { text: "Follow up", clientKey: randomUUID() });
    expect((await support.messages(row.id, actor, {})).items.every(message => message.authorKind === "customer")).toBe(true);
    const orgCase = await support.create(actor, { subject: "Organizer question", text: "My event", requesterKind: "organizer", clientKey: randomUUID() });
    expect(orgCase.requesterKind).toBe("organizer");
    await expect(support.create({ userId: customer, role: "guest" }, { subject: "Fake organizer", text: "Hello", requesterKind: "organizer", clientKey: randomUUID() })).rejects.toMatchObject({ status: 403 });
    await expect(support.create({ userId: customer }, { ...input, clientKey: randomUUID() })).rejects.toMatchObject({ status: 403 });
  });
  it("loads stable earlier history while new messages arrive", async () => {
    const actor = { userId: customer };
    const row = await support.create(actor, { subject: "History cursor", text: "Initial", clientKey: randomUUID() });
    await prisma.platformMessage.createMany({ data: [0,1,2,3].map(i => ({ caseId: row.id, clientKey: randomUUID(), authorKind: "customer", text: `History ${i}`, createdAt: new Date(Date.now() + i + 1000) })) });
    const latest = await support.messages(row.id, actor, { limit: "2" });
    expect(latest.items.map(m => m.text)).toEqual(["History 2", "History 3"]);
    await support.message(row.id, agent, { text: "Arrived later", clientKey: randomUUID() });
    const older = await support.messages(row.id, actor, { limit: "2", before: latest.items[0]!.id });
    expect(older.items.map(m => m.text)).toEqual(["History 0", "History 1"]);
    expect(older.hasNext).toBe(true);
  });
  it("lets staff intervene in organizer chats without exposing internal notes or their files", async () => {
    const order = await purchase(), chat = new EventChatService(prisma);
    const publicBuffer = Buffer.from("%PDF-1.4\ncustomer attachment\n%%EOF");
    const publicFile = await support.upload({ userId: customer }, { buffer: publicBuffer, originalname: "receipt.pdf", mimetype: "application/pdf", size: publicBuffer.length });
    await chat.send(event, order.id, { kind: "guest", userId: customer }, "Where is the entrance?", randomUUID(), [publicFile.id]);
    expect((await support.file(publicFile.id, { userId: organizer })).buffer).toEqual(publicBuffer);
    await expect(support.file(publicFile.id, { userId: other })).rejects.toMatchObject({ status: 404 });
    const list = await request("/staff/organizer-chats", "GET", undefined, "support");
    expect(list.status).toBe(200);
    expect(((await list.json()) as { items: { orderId: string }[] }).items.some((item: { orderId: string }) => item.orderId === order.id)).toBe(true);
    const buffer = Buffer.from("%PDF-1.4\nstaff note\n%%EOF");
    const file = await support.upload(agent, { buffer, originalname: "private.pdf", mimetype: "application/pdf", size: buffer.length });
    await support.organizerReply(event, order.id, agent, { text: "Private investigation", internal: true, fileIds: [file.id], clientKey: randomUUID() });
    const publicStaffFile = await support.upload(agent, { buffer, originalname: "instructions.pdf", mimetype: "application/pdf", size: buffer.length });
    const input = { text: "Support is helping both of you", fileIds: [publicStaffFile.id], clientKey: randomUUID() };
    const reply = await support.organizerReply(event, order.id, agent, input);
    expect((await support.organizerReply(event, order.id, agent, input)).id).toBe(reply.id);
    const publicPage = await chat.list(event, order.id, { kind: "guest", userId: customer });
    expect(publicPage.items.map(m => m.text)).not.toContain("Private investigation");
    expect(publicPage.items).toContainEqual(expect.objectContaining({ id: reply.id, sender: "support", files: [expect.objectContaining({ id: publicStaffFile.id })] }));
    expect((await support.file(publicStaffFile.id, { userId: customer })).buffer).toEqual(buffer);
    expect((await support.file(publicStaffFile.id, { userId: organizer })).buffer).toEqual(buffer);
    expect((await chat.list(event, order.id, { kind: "organizer", userId: organizer })).items.map(m => m.id)).toContain(reply.id);
    await expect(support.file(file.id, { userId: customer })).rejects.toMatchObject({ status: 404 });
    await expect(support.file(file.id, { userId: organizer })).rejects.toMatchObject({ status: 404 });
    expect((await support.file(file.id, agent)).buffer).toEqual(buffer);
    const notifications = await prisma.notification.findMany({ where: { type: "chat.support", payload: { path: ["orderId"], equals: order.id } } });
    expect(notifications.map(n => n.userId).sort()).toEqual([customer, organizer].sort());
    expect((await support.organizerMessages(event, order.id, {})).items.some(m => m.internal)).toBe(true);
    await expect(chat.list(event, order.id, { kind: "guest", userId: other })).rejects.toMatchObject({ status: 404 });
  });
  it("paginates linked order chat inspection and records each staff access", async () => {
    const order = await purchase();
    const row = await support.create(
      { userId: customer },
      {
        subject: "Order conversation investigation",
        text: "Please inspect the discussion",
        orderId: order.id,
        clientKey: randomUUID(),
      },
    );
    await prisma.chatMessage.createMany({
      data: ["First", "Second", "Third"].map((text, index) => ({
        eventId: event,
        orderId: order.id,
        organizerId: organizer,
        guestUserId: customer,
        sender: "guest" as const,
        text,
        createdAt: new Date(1800000000000 + index),
      })),
    });
    const first = await request(
      `/staff/cases/${row.id}/order-chat?limit=2`,
      "GET",
      undefined,
      "support",
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      page: 1,
      limit: 2,
      total: 3,
      items: [{ text: "First" }, { text: "Second" }],
    });
    const next = await support.orderChat(row.id, agent, {
      page: "2",
      limit: "2",
    });
    expect(next.items.map((item) => item.text)).toEqual(["Third"]);
    expect(
      await prisma.staffAudit.count({
        where: {
          action: "support.order_chat_viewed",
          caseId: row.id,
          staffId: agent.id,
        },
      }),
    ).toBe(2);
  });
  it("requires a validated anonymous order capability, with attachment ownership", async () => {
    const order = await purchase({ anonymous: true }),
      raw = randomUUID(),
      id = randomUUID();
    await prisma.anonymousCheckoutSession.create({
      data: {
        id,
        name: "Anonymous",
        sessionHash: randomUUID(),
        accessHash: secretHash(raw),
        expiresAt: new Date(Date.now() + 600000),
        accessExpiresAt: new Date(Date.now() + 600000),
        orderId: order.id,
      },
    });
    const session = await app.get(AnonymousService).access(raw),
      actor = { anonymousSessionId: session.id, orderId: session.orderId };
    const row = await support.create(actor, {
      subject: "Anonymous order",
      text: "Help",
      clientKey: randomUUID(),
    });
    expect(
      (
        await request(
          `/platform-support/cases/${row.id}/messages`,
          "GET",
          undefined,
          "none",
          { "x-quick-access": raw },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          `/platform-support/cases/${row.id}/messages`,
          "GET",
          undefined,
          "public",
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(
          `/platform-support/cases/${row.id}/messages`,
          "GET",
          undefined,
          "none",
          { "x-quick-access": order.id },
        )
      ).status,
    ).toBe(404);
    const buffer = Buffer.from(
      "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF",
    );
    const file = await support.upload(
      actor,
      {
        buffer,
        size: buffer.length,
        mimetype: "application/pdf",
        originalname: "receipt.pdf",
      },
      row.id,
    );
    await support.message(row.id, actor, {
      text: "Файл",
      clientKey: randomUUID(),
      fileIds: [file.id],
    });
    expect((await support.file(file.id, actor)).buffer).toEqual(buffer);
    await expect(
      support.file(file.id, { userId: other }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("preserves verification versions, review messages, private files and badge revocation", async () => {
    const buffer = Buffer.from("%PDF-1.4\n<< /Type /Catalog >>\n%%EOF"),
      upload = () =>
        support.upload(
          { userId: organizer },
          {
            buffer,
            size: buffer.length,
            mimetype: "application/pdf",
            originalname: "business.pdf",
          },
        );
    let file = await upload();
    const input = {
      legalName: "Тестовая компания",
      entityType: "ooo",
      countryCode: "KZ",
      registrationId: "international-id-123",
      email: "test@example.test",
      phone: "+77000000000",
      fileIds: [file.id],
    };
    const organizerToken = (await app.get(TokenService).issuePair(
      await prisma.user.findUniqueOrThrow({ where: { id: organizer } }),
    )).accessToken;
    const submitted = await fetch(`${base}/platform-support/verification`, {
      method: "POST",
      headers: { authorization: `Bearer ${organizerToken}`, "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(submitted.status).toBe(201);
    const first = await submitted.json() as { id: string };
    const pending = await request("/staff/verifications");
    expect(pending.status).toBe(200);
    expect(await pending.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.id, organizerId: organizer, status: "pending", legalName: input.legalName }),
    ]));
    await expect(support.submit(organizer, input)).rejects.toMatchObject({
      status: 409,
    });
    await expect(support.file(file.id, agent)).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      support.file(file.id, { userId: other }),
    ).rejects.toMatchObject({ status: 404 });
    expect((await support.file(file.id, admin)).buffer).toEqual(buffer);
    expect(
      (await request(`/staff/files/${file.id}`, "GET", undefined, "support"))
        .status,
    ).toBe(403);
    await support.review(first.id, admin, {
      decision: "changes_requested",
      reason: "Добавьте актуальную регистрацию",
    });
    file = await upload();
    const next = await support.submit(organizer, {
      ...input,
      fileIds: [file.id],
    });
    expect(next.version).toBe(2);
    const approved = await request(`/staff/verifications/${next.id}/review`, "POST", {
      decision: "verified",
      reason: "Регистрация проверена модератором",
    });
    expect(approved.status).toBe(201);
    expect(await approved.json()).toMatchObject({ id: next.id, status: "verified" });
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: organizer } }))
        .organizerVerifiedAt,
    ).not.toBeNull();
    expect(
      (
        (await (
          await request(`/events/${event}`, "GET", undefined, "none")
        ).json()) as { organizer: { verified: boolean } }
      ).organizer.verified,
    ).toBe(true);
    const profile = await fetch(`${base}/me/organizer-profile`, {
      headers: { authorization: `Bearer ${organizerToken}` },
    });
    expect(profile.status).toBe(200);
    expect(await profile.json()).toMatchObject({ verified: true });
    await support.review(next.id, admin, {
      decision: "revoked",
      reason: "Предоставленные данные больше не актуальны",
    });
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: organizer } }))
        .organizerVerifiedAt,
    ).toBeNull();
    expect(
      (
        (await (
          await request(`/events/${event}`, "GET", undefined, "none")
        ).json()) as { organizer: { verified: boolean } }
      ).organizer.verified,
    ).toBe(false);
    expect(
      (await support.verification(organizer)).map((v) => v.status),
    ).toEqual(["revoked", "changes_requested"]);
  });
  it("reviews complete applications with optional reasons, protected documents and separate event approval",async()=>{
    const owner=randomUUID(),eventId=randomUUID();await prisma.user.create({data:{id:owner,name:"Verification owner",role:"organizer"}});
    await prisma.event.create({data:{id:eventId,organizerId:owner,title:"Still requires moderation",status:"draft",moderationStatus:"pending",date:new Date("2031-12-01"),time:new Date("1970-01-01T20:00:00Z"),address:"Test venue"}});
    const buffer=Buffer.from("%PDF-1.4\n<< /Type /Catalog >>\n%%EOF");
    const upload=()=>support.upload({userId:owner},{buffer,size:buffer.length,mimetype:"application/pdf",originalname:"registration.pdf"});
    let file=await upload();const input={legalName:"Review example company",entityType:"other",entityTypeDetails:"Nonprofit association",countryCode:"KZ",registrationId:"test-reg-123",email:"verify@example.test",phone:"+77001234567",fileIds:[file.id]};
    const row=await support.submit(owner,input);
    expect((await request("/staff/verifications?page=1","GET",undefined,"support")).status).toBe(403);
    const listing=await request("/staff/verifications?page=1&status=pending&search=Review");expect(listing.status).toBe(200);expect(await listing.json()).toMatchObject({items:[expect.objectContaining({id:row.id,readyForReview:true,status:"pending"})]});
    expect((await request(`/staff/verifications/${row.id}`,"GET",undefined,"none")).status).toBe(403);
    const detail=await request(`/staff/verifications/${row.id}`);expect(await detail.json()).toMatchObject({id:row.id,isLatest:true,entityTypeDetails:"Nonprofit association",documents:[{id:file.id}]});
    await expect(support.review(row.id,agent,{decision:"verified"})).rejects.toMatchObject({status:403});
    expect((await request(`/staff/verifications/${row.id}/review`,"POST",{decision:"verified"},"support")).status).toBe(403);
    expect((await request(`/staff/files/${file.id}`,"GET",undefined,"support")).status).toBe(403);
    await expect(support.file(file.id,{userId:other})).rejects.toMatchObject({status:404});
    const download=await request(`/staff/files/${file.id}`);expect(download.status).toBe(200);expect(download.headers.get("cache-control")).toBe("private, no-store");
    const approved=await request(`/staff/verifications/${row.id}/review`,"POST",{decision:"verified"});expect(approved.status).toBe(201);expect(await approved.json()).toMatchObject({status:"verified",reviewReason:null});
    expect((await prisma.user.findUniqueOrThrow({where:{id:owner}})).organizerVerifiedAt).not.toBeNull();
    expect(await prisma.event.findUnique({where:{id:eventId}})).toMatchObject({status:"draft",moderationStatus:"pending",approvedAt:null});
    expect((await fetch(`${base}/events/${eventId}`)).status).toBe(404);
    let inbox=await app.get(AccountService).notifications(owner,{page:1,limit:20,locale:"en"});expect(inbox.items.find(item=>item.type==="organizer.verification")?.text).toBe("«Review example company»: organizer verified.");
    const noticeCount=await prisma.notification.count({where:{userId:owner,type:"organizer.verification"}});
    expect((await request(`/staff/verifications/${row.id}/review`,"POST",{decision:"rejected"})).status).toBe(409);
    expect(await prisma.notification.count({where:{userId:owner,type:"organizer.verification"}})).toBe(noticeCount);
    file=await upload();const next=await support.submit(owner,{...input,fileIds:[file.id]});
    expect((await prisma.user.findUniqueOrThrow({where:{id:owner}})).organizerVerifiedAt).toBeNull();
    expect((await request(`/staff/verifications/${row.id}/review`,"POST",{decision:"revoked"})).status).toBe(409);
    await support.review(next.id,admin,{decision:"rejected",reason:"Уточните регистрационный номер"});
    inbox=await app.get(AccountService).notifications(owner,{page:1,limit:20,locale:"ru"});expect(inbox.items.some(item=>item.text.includes("Причина: Уточните регистрационный номер"))).toBe(true);
    expect((await support.verification(owner))[0]).toMatchObject({status:"rejected",reviewReason:"Уточните регистрационный номер"});
  });
  it("does not award a badge for incomplete historical application data",async()=>{
    const owner=randomUUID();await prisma.user.create({data:{id:owner,role:"organizer"}});const linked=await prisma.platformCase.create({data:{ownerId:owner,subject:"Incomplete old application"}});
    const row=await prisma.organizerVerification.create({data:{organizerId:owner,caseId:linked.id,version:1,legalName:"Incomplete company",entityType:"ip",countryCode:"KZ",registrationId:"",email:"invalid",phone:""}});
    expect(await support.verificationApplication(row.id)).toMatchObject({readyForReview:false,missingFields:expect.arrayContaining(["registrationId","email","phone","fileIds"])});
    await expect(support.review(row.id,admin,{decision:"verified"})).rejects.toMatchObject({status:409,response:{code:"VERIFICATION_INCOMPLETE"}});
    expect((await prisma.user.findUniqueOrThrow({where:{id:owner}})).organizerVerifiedAt).toBeNull();
    expect(await prisma.notification.count({where:{userId:owner,type:"organizer.verification"}})).toBe(0);
  });
  it("resolves audit objects and staff changes without altering historical records",async()=>{
    const linked=await support.create({userId:customer},{subject:"Readable audit fixture",text:"Help",clientKey:randomUUID()});
    await prisma.staffAudit.create({ data: { staffId: admin.id, role: admin.role, action: "support.updated",
      targetType: "case", targetId: linked.id, before: { assignedStaffId: null }, after: { assignedStaffId: admin.id },
    } });
    const response=await request("/staff/audit?search=Readable%20audit");expect(response.status).toBe(200);const body=await response.json() as {items:Array<Record<string,unknown>>};
    expect(body.items).toContainEqual(expect.objectContaining({action:"support.updated",target:{type:"case",id:linked.id,name:"Readable audit fixture",available:true,reference:null},relatedStaffNames:expect.objectContaining({[admin.id]:expect.any(String)})}));
    const old=await prisma.staffAudit.create({data:{staffId:null,role:"system",action:"historical.unknown",targetType:"event",targetId:randomUUID(),before:{title:"Historical named event"},after:{legacy:true}}});
    const historical=await management.audit({search:old.targetId});expect(historical.items).toContainEqual(expect.objectContaining({id:old.id,action:"historical.unknown",before:{title:"Historical named event"},target:expect.objectContaining({name:"Historical named event",available:false})}));
    expect((await request("/staff/audit","GET",undefined,"support")).status).toBe(403);
  });
  async function adEvent(title:string,approve=true) {
    const row=await prisma.event.create({data:{organizerId:organizer,title,description:"Advertisement fixture",posterUrl:"/reference-events/event-7.jpg",date:new Date("2035-12-01"),time:new Date("1970-01-01T18:00:00Z"),timezone:"UTC",address:"Fixture venue",status:"draft",moderationStatus:"pending"}});
    if(approve) await management.moderate(row.id,admin,{action:"approve"});
    return row.id;
  }
  it("authorizes homepage management and searches only approved public events without catalog alternatives",async()=>{
    const approved=await adEvent("Homepage eligible concert"),pending=await adEvent("Homepage pending concert",false),hidden=await adEvent("Homepage hidden concert"),rejected=await adEvent("Homepage rejected concert",false);
    await management.moderate(hidden,admin,{action:"hide"});await management.moderate(rejected,admin,{action:"reject"});
    for(const path of ["/staff/homepage-ads","/staff/homepage-ads/events"]) {
      expect((await request(path,"GET",undefined,"support")).status).toBe(403);
      expect((await request(path,"GET",undefined,"public")).status).toBe(403);
    }
    expect((await request("/staff/homepage-ads","POST",{eventId:approved},"support")).status).toBe(403);
    expect((await request("/staff/homepage-ads","POST",{eventId:approved},"admin",{"x-staff-csrf":""})).status).toBe(403);
    const search=await request("/staff/homepage-ads/events?search=Homepage&locale=en");expect(search.status).toBe(200);
    expect((await search.json() as {items:Array<{id:string}>}).items.map(row=>row.id)).toEqual([approved]);
    const none=await request("/staff/homepage-ads/events?search=never-matching-title");expect(await none.json()).toEqual({items:[]});
    for(const eventId of [pending,hidden,rejected]) expect((await request("/staff/homepage-ads","POST",{eventId})).status).toBe(409);
    await expect(app.get(HomepageAdvertisementsService).add(agent,{eventId:approved})).rejects.toMatchObject({status:403});
  });
  it("persists homepage order, prevents duplicate placements and supports concurrent edits and removal",async()=>{
    const one=await adEvent("Advertisement first"),two=await adEvent("Advertisement second"),three=await adEvent("Advertisement concurrent");
    expect((await request("/staff/homepage-ads","POST",{eventId:one})).status).toBe(201);
    expect((await request("/staff/homepage-ads","POST",{eventId:two})).status).toBe(201);
    expect((await request("/staff/homepage-ads","POST",{eventId:one})).status).toBe(409);
    const concurrent=await Promise.all([request("/staff/homepage-ads","POST",{eventId:three}),request("/staff/homepage-ads","POST",{eventId:three})]);expect(concurrent.map(row=>row.status).sort()).toEqual([201,409]);
    await expect(prisma.homepageAdvertisement.create({data:{eventId:one,position:99}})).rejects.toMatchObject({code:"P2002"});
    const moved=await request(`/staff/homepage-ads/${two}`,"PATCH",{direction:"up"});expect(moved.status).toBe(200);expect((await moved.json() as {items:Array<{eventId:string}>}).items.map(row=>row.eventId)).toEqual([two,one,three]);
    const fresh=new HomepageAdvertisementsService(prisma,app.get(PublicEventsService));expect((await fresh.publicList("en")).items.map(row=>row.id)).toEqual([two,one,three]);
    await request(`/staff/homepage-ads/${two}`,"PATCH",{direction:"down"});
    expect((await fresh.publicList()).items.map(row=>row.id)).toEqual([one,two,three]);
    expect((await request(`/staff/homepage-ads/${one}`,"DELETE",undefined,"support")).status).toBe(403);
    await request(`/staff/homepage-ads/${one}`,"DELETE");await request(`/staff/homepage-ads/${one}`,"DELETE");
    expect((await fresh.publicList()).items.map(row=>row.id)).toEqual([two,three]);
    expect((await prisma.homepageAdvertisement.findMany({orderBy:{position:"asc"}})).map(row=>row.position)).toEqual([0,1]);
    for(const id of [two,three])await request(`/staff/homepage-ads/${id}`,"DELETE");
    const empty=await fetch(`${base}/events/homepage-advertisements`);expect(empty.status).toBe(200);expect(empty.headers.get("cache-control")).toBe("no-store");expect(await empty.json()).toEqual({items:[]});
    expect(await prisma.staffAudit.count({where:{targetId:two,action:"homepage_ad.reordered"}})).toBe(2);
  });
  it("rechecks homepage eligibility after edits, moderation, lifecycle and organizer restrictions",async()=>{
    const id=await adEvent("Live eligibility advertisement");await request("/staff/homepage-ads","POST",{eventId:id});
    const ids=async()=>((await(await fetch(`${base}/events/homepage-advertisements?locale=en`)).json()) as {items:Array<{id:string}>}).items.map(row=>row.id);
    expect(await ids()).toEqual([id]);await management.moderate(id,admin,{action:"pause"});expect(await ids()).toEqual([id]);
    await management.moderate(id,admin,{action:"hide"});expect(await ids()).toEqual([]);expect((await app.get(HomepageAdvertisementsService).adminList()).items[0]).toMatchObject({eventId:id,eligible:false});
    await management.moderate(id,admin,{action:"unhide"});expect(await ids()).toEqual([id]);
    await prisma.event.update({where:{id},data:{description:"Changed content needs review"}});expect(await ids()).toEqual([]);
    await management.moderate(id,admin,{action:"reject"});expect(await ids()).toEqual([]);
    // Also reject inconsistent legacy records even if one moderation flag looks approved.
    for(const data of [{status:"published" as const,moderationStatus:"approved",approvedAt:null},{status:"draft" as const,moderationStatus:"approved",approvedAt:new Date()},{status:"cancelled" as const,moderationStatus:"approved",approvedAt:new Date()}]) {
      await prisma.event.update({where:{id},data});expect(await ids()).toEqual([]);
    }
    await prisma.event.update({where:{id},data:{status:"published",moderationStatus:"approved",approvedAt:new Date()}});
    await prisma.user.update({where:{id:organizer},data:{blockedAt:new Date()}});expect(await ids()).toEqual([]);
    await prisma.user.update({where:{id:organizer},data:{blockedAt:null}});
    await request(`/staff/homepage-ads/${id}`,"DELETE");
  });
  it("rejects forged and active-content documents server-side", async () => {
    const bad = Buffer.from("%PDF-1.4 /JavaScript (evil) %%EOF");
    await expect(
      support.upload(
        { userId: organizer },
        {
          buffer: bad,
          size: bad.length,
          mimetype: "application/pdf",
          originalname: "bad.pdf",
        },
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      support.upload(
        { userId: organizer },
        {
          buffer: bad,
          size: bad.length,
          mimetype: "image/png",
          originalname: "bad.png",
        },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("refunds one admission without changing the remaining QR and deduplicates concurrent retries", async () => {
    const order = await purchase(),
      key = randomUUID(),
      input = { key, ticketIds: [order.tickets[0]!.id], reason };
    const [a, b] = await Promise.all([
      refunds.request(agent, order.id, input),
      refunds.request(agent, order.id, input),
    ]);
    expect(a.id).toBe(b.id);
    expect((await refunds.process(a.id)).status).toBe("succeeded");
    expect(
      (await prisma.order.findUniqueOrThrow({ where: { id: order.id } }))
        .paymentStatus,
    ).toBe("paid");
    const unchanged = await prisma.ticket.findUniqueOrThrow({
      where: { id: order.tickets[1]!.id },
    });
    expect(unchanged).toMatchObject({
      status: "active",
      qrToken: order.tickets[1]!.qrToken,
    });
    expect((await refunds.quote(order.id)).remaining).toBe(1000);
    await refunds.request(agent, order.id, { key: randomUUID(), reason });
    expect(
      (await prisma.order.findUniqueOrThrow({ where: { id: order.id } }))
        .paymentStatus,
    ).toBe("refunded");
    expect(
      (
        await prisma.staffRefund.aggregate({
          where: { orderId: order.id, status: "succeeded" },
          _sum: { amount: true },
        })
      )._sum.amount,
    ).toBe(2000);
    await expect(
      refunds.request(agent, order.id, { key: randomUUID(), reason }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("keeps settled timestamps and refunded status on delayed duplicate payment callbacks", async () => {
    const order = await purchase(),
      booking = app.get(BookingService),
      payment = await prisma.payment.findFirstOrThrow({
        where: { orderId: order.id },
      });
    const webhook = {
      provider: "mock",
      eventId: randomUUID(),
      eventType: "payment.succeeded" as const,
      providerPaymentId: payment.providerPaymentId!,
      orderId: order.id,
      amount: 2000,
      currency: "KZT",
      occurredAt: new Date(),
      payloadHash: digest(randomUUID()),
    };
    await booking.handlePaymentWebhook(webhook);
    expect(
      (await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }))
        .webhookReceivedAt,
    ).toEqual(payment.webhookReceivedAt);
    await refunds.request(agent, order.id, { key: randomUUID(), reason });
    await booking.handlePaymentWebhook({ ...webhook, eventId: randomUUID() });
    expect(
      (await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }))
        .status,
    ).toBe("refunded");
    expect(
      (await prisma.order.findUniqueOrThrow({ where: { id: order.id } }))
        .paymentStatus,
    ).toBe("refunded");
  });
  it("rejects used tickets and unsupported legacy partials; permits an unused individual remainder", async () => {
    const order = await purchase({ used: true });
    await expect(
      refunds.request(agent, order.id, { key: randomUUID(), reason }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (
        await refunds.request(agent, order.id, {
          key: randomUUID(),
          reason,
          ticketIds: [order.tickets[1]!.id],
        })
      ).status,
    ).toBe("succeeded");
    const old = await purchase({ legacy: true });
    await expect(
      refunds.request(admin, old.id, {
        key: randomUUID(),
        reason,
        override: true,
        ticketIds: [old.tickets[0]!.id],
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (
        await refunds.request(admin, old.id, {
          key: randomUUID(),
          reason,
          override: true,
        })
      ).status,
    ).toBe("succeeded");
  });
  it("represents provider failure and uncertain outcomes without releasing admissions or over-refunding", async () => {
    const order = await purchase();
    let state: "uncertain" | "succeeded" | "failed" = "uncertain",
      calls = 0;
    const fake: PaymentProvider = {
      ...new DevelopmentPaymentProvider("http://localhost:3400", "test-only"),
      name: "mock",
      createPaymentLink: vi.fn(),
      verifyWebhook: vi.fn(),
      async requestRefund() {
        calls++;
        if (state === "uncertain") throw new Error("Timeout");
        return { status: state, providerRefundId: "test-refund-reference" };
      },
      async lookupRefund() {
        return {
          status: state === "uncertain" ? "processing" : state,
          providerRefundId: "test-refund-reference",
        };
      },
    };
    const fixedNow = new Date("2031-02-03T04:05:06.000Z");
    const service = new StaffRefundsService(prisma, fake, { now: () => fixedNow });
    const response = await service.request(agent, order.id, {
      key: randomUUID(),
      reason,
    });
    expect(response.status).toBe("processing");
    await service.process(response.id);
    expect(calls).toBe(1);
    expect(
      (
        await prisma.ticket.findUniqueOrThrow({
          where: { id: order.tickets[0]!.id },
        })
      ).status,
    ).toBe("active");
    state = "succeeded";
    await Promise.all([
      service.process(response.id),
      service.process(response.id),
    ]);
    expect(
      (
        await prisma.staffRefund.findUniqueOrThrow({
          where: { id: response.id },
        })
      ).status,
    ).toBe("succeeded");
    expect(
      (await prisma.staffRefund.findUniqueOrThrow({ where: { id: response.id } })).completedAt,
    ).toEqual(fixedNow);
    const rejected = await purchase();
    state = "failed";
    expect(
      (await service.request(agent, rejected.id, { key: randomUUID(), reason }))
        .status,
    ).toBe("failed");
    expect(
      (
        await prisma.ticket.findUniqueOrThrow({
          where: { id: rejected.tickets[0]!.id },
        })
      ).status,
    ).toBe("active");
  });
  it("resends the original ticket through the durable fake email adapter, once per request", async () => {
    const order = await purchase(),
      delivery = app.get(TicketEmailDeliveryService);
    const sender = (
      delivery as unknown as {
        sender: {
          available: () => boolean;
          send: (value: unknown) => Promise<{ id: string }>;
        };
      }
    ).sender;
    const available = vi.spyOn(sender, "available").mockReturnValue(true),
      send = vi
        .spyOn(sender, "send")
        .mockResolvedValue({ id: "fake-accepted-email" });
    await prisma.order.update({
      where: { id: order.id },
      data: {
        emailDeliveryAddress: "verified-fixture@example.test",
        emailDeliveryRequestedAt: new Date(Date.now() - 3600000),
      },
    });
    await prisma.ticketEmailDelivery.create({
      data: {
        orderId: order.id,
        recipient: "verified-fixture@example.test",
        capabilityHash: randomUUID(),
        capabilityExpiresAt: new Date(Date.now() + 3600000),
        status: "accepted",
        updatedAt: new Date(Date.now() - 3600000),
      },
    });
    const key = randomUUID();
    await Promise.all([
      management.resend(agent, order.id, key, reason),
      management.resend(agent, order.id, key, reason),
    ]);
    expect(
      (
        await prisma.ticketEmailDelivery.findUniqueOrThrow({
          where: { orderId: order.id },
        })
      ).generation,
    ).toBe(2);
    await delivery.tick();
    await delivery.tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      (
        await prisma.ticket.findUniqueOrThrow({
          where: { id: order.tickets[0]!.id },
        })
      ).qrToken,
    ).toBe(order.tickets[0]!.qrToken);
    await expect(
      management.resend(agent, order.id, randomUUID(), reason),
    ).rejects.toMatchObject({ status: 409 });
    send.mockRestore();
    available.mockRestore();
  });
  it("lets staff retry a failed resend at once and reclaims only stale dispatching claims", async () => {
    const order = await purchase();
    const op = (status: string, ageMs: number) => prisma.staffOperation.create({
      data: { staffId: agent.id, key: randomUUID(), kind: "resend", resourceId: order.id, requestHash: "x", status, createdAt: new Date(Date.now() - ageMs) },
    });
    const limited = async () => management.resend(agent, order.id, randomUUID(), reason, "telegram").then(() => false, (error: { response?: { code?: string } }) => error.response?.code === "TICKET_RESEND_LIMIT");
    const failed = await op("failed", 1000);
    expect(await limited()).toBe(false);
    await prisma.staffOperation.deleteMany({ where: { resourceId: order.id, kind: "resend", id: { not: failed.id } } });
    await prisma.staffOperation.delete({ where: { id: failed.id } });
    await op("dispatching", 60_000);
    expect(await limited()).toBe(true);
    await prisma.staffOperation.deleteMany({ where: { resourceId: order.id, kind: "resend" } });
    await op("dispatching", 6 * 60_000);
    expect(await limited()).toBe(false);
  });
  it("queues Telegram resends through the existing delivery worker without replacing QR codes", async () => {
    const order = await purchase(),
      telegram = app.get(EventNotificationsService),
      chatId = BigInt(Date.now()) + 500000000000n;
    await prisma.user.update({
      where: { id: customer },
      data: { telegramChatId: chatId },
    });
    try {
      const key = randomUUID();
      await management.resend(agent, order.id, key, reason, "telegram");
      await management.resend(agent, order.id, key, reason, "telegram");
      const photo = vi.fn(async () => "fake-telegram-message");
      await telegram.tick(async () => "fake-message", photo);
      expect(photo).toHaveBeenCalledTimes(2);
      expect(
        (
          await prisma.ticket.findUniqueOrThrow({
            where: { id: order.tickets[0]!.id },
          })
        ).qrToken,
      ).toBe(order.tickets[0]!.qrToken);
      const notifications = await prisma.notification.findMany({
        where: {
          type: "ticket.resend",
          payload: { path: ["orderId"], equals: order.id },
        },
      });
      expect(notifications).toHaveLength(2);
      expect(notifications.every((row) => row.status === "sent")).toBe(true);
    } finally {
      await prisma.user.update({
        where: { id: customer },
        data: { telegramChatId: null },
      });
    }
  });
  it("expires staff sessions, immediately observes role changes, and safely resets MFA", async () => {
    const login = await auth.login(agentEmail, password),
      pending = await auth.authenticate(login.token, undefined, false, true);
    const replacement = await auth.otp(pending, recoveryCodes[1]!);
    await prisma.staffSession.update({
      where: { id: replacement.id },
      data: { expiresAt: new Date(0) },
    });
    await expect(auth.authenticate(replacement.token)).rejects.toMatchObject({
      status: 401,
    });
    await auth.change(admin, agent.id, { role: "support", reason });
    await expect(auth.authenticate(agentToken)).rejects.toMatchObject({
      status: 401,
    });
    const next = await auth.login(agentEmail, password),
      full = await auth.otp(
        await auth.authenticate(next.token, undefined, false, true),
        recoveryCodes[2]!,
      );
    agentToken = full.token;
    agentCsrf = full.session.csrf;
    agent = await auth.authenticate(full.token);
    await expect(
      auth.resetMfa(agent, "wrong-password", recoveryCodes[3]!),
    ).rejects.toMatchObject({ status: 401 });
    await auth.resetMfa(agent, password, recoveryCodes[3]!);
    await expect(auth.authenticate(agentToken)).rejects.toMatchObject({
      status: 401,
    });
    const enrolled = await enroll(agentEmail);
    agent = enrolled.actor;
    agentToken = enrolled.token;
    agentCsrf = enrolled.session.csrf;
  });
  it("locks staff MFA per account across login sessions, audits failures, and resets on success", async () => {
    const email = `lockout-${namespace}@example.test`;
    await auth.invite(admin, { email, name: "Lockout", role: "support" });
    await auth.accept(
      new URL(mails.at(-1)!.url).hash.slice("#invite=".length),
      password,
      "invite",
    );
    const enrolled = await enroll(email),
      staffId = enrolled.actor.id,
      codes = enrolled.recoveryCodes;
    const state = () =>
      prisma.staffAccount.findUniqueOrThrow({
        where: { id: staffId },
        select: { totpFailedCount: true, totpLockedUntil: true },
      });
    const pending = async () => {
      const login = await auth.login(email, password);
      return auth.authenticate(login.token, undefined, false, true);
    };
    const clearBucket = () =>
      prisma.staffRateBucket.deleteMany({ where: { key: digest(`mfa:${staffId}`) } });
    await clearBucket();
    // Failures count per account, not per session: 3 on one session, 2 on another.
    const first = await pending(),
      second = await pending();
    for (let i = 0; i < 3; i++)
      await expect(auth.otp(first, "000000")).rejects.toMatchObject({ status: 401 });
    expect((await state()).totpFailedCount).toBe(3);
    await expect(auth.otp(second, "000000")).rejects.toMatchObject({ status: 401 });
    await expect(auth.otp(second, "000000")).rejects.toMatchObject({ status: 401 });
    const locked = await state();
    expect(locked.totpFailedCount).toBe(0);
    expect(locked.totpLockedUntil!.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    const audits = await prisma.staffAudit.findMany({
      where: { targetId: staffId, action: "staff.mfa_failed" },
    });
    expect(audits).toHaveLength(5);
    expect(JSON.stringify(audits)).not.toContain("000000");
    // While locked even a valid recovery code is rejected with 429 and not consumed.
    await expect(auth.otp(first, codes[0]!)).rejects.toMatchObject({ status: 429 });
    expect(
      (await prisma.staffAccount.findUniqueOrThrow({ where: { id: staffId } }))
        .recoveryHashes,
    ).toHaveLength(codes.length);
    // Operator reset (as documented) or expiry lets verification proceed; success resets state.
    await prisma.staffAccount.update({
      where: { id: staffId },
      data: { totpLockedUntil: new Date(Date.now() - 1000) },
    });
    await clearBucket();
    await expect(auth.otp(first, "000000")).rejects.toMatchObject({ status: 401 });
    expect((await state()).totpFailedCount).toBe(1);
    await auth.otp(first, codes[0]!);
    expect(await state()).toEqual({ totpFailedCount: 0, totpLockedUntil: null });
  });
  it("blocks direct sales for hidden events and blocked organizers while preserving old purchase support", async () => {
    await management.moderate(event, admin, { action: "hide", reason });
    await expect(purchase()).rejects.toThrow();
    await management.moderate(event, admin, { action: "unhide", reason });
    await management.block(organizer, admin, true, { reason });
    await expect(purchase()).rejects.toThrow();
    await management.block(organizer, admin, false, { reason });
    const order = await purchase();
    expect(
      (
        await management.orders({
          search: `TKT-${order.tickets[0]!.id.replaceAll("-", "")}`,
        })
      ).items.some((v) => v.id === order.id),
    ).toBe(true);
    await management.block(customer, admin, true, { reason });
    await expect(
      app.get(AuthService).authenticate(customerToken),
    ).rejects.toMatchObject({ status: 401 });
    await expect(purchase()).rejects.toThrow();
    expect(
      (await support.cases({ userId: customer }, {})).total,
    ).toBeGreaterThan(0);
    await management.block(customer, admin, false, { reason });
  });
  it("separates currencies and mock money, records external payouts once and audits reversals", async () => {
    await purchase({ currency: "USD" });
    const real = await management.finance({}),
      demo = await management.finance({
        testOnly: "true",
        organizerId: organizer,
      });
    expect(real.groups.every((v) => !v.testOnly)).toBe(true);
    expect(demo.groups.map((v) => v.currency).sort()).toEqual(["KZT", "USD"]);
    expect(demo.transactions.length).toBeGreaterThan(0);
    const input = {
      key: randomUUID(),
      organizerId: organizer,
      amount: 500,
      currency: "KZT",
      reference: `test-${namespace}`,
      paidAt: new Date().toISOString(),
      testOnly: true,
    };
    const [a, b] = await Promise.all([
      management.payout(admin, input),
      management.payout(admin, input),
    ]);
    expect(a.id).toBe(b.id);
    await management.reversePayout(admin, a.id, { reason });
    expect(
      (await prisma.organizerPayout.findUniqueOrThrow({ where: { id: a.id } }))
        .reversedAt,
    ).not.toBeNull();
    expect(csvCell(' =HYPERLINK("bad")')).toMatch(/^"'/);
  });
  it("uses the refund's actual period rather than moving it into the original sale period", async () => {
    const order = await purchase({ currency: "EUR" });
    await prisma.payment.updateMany({
      where: { orderId: order.id },
      data: { webhookReceivedAt: new Date("2020-01-01T12:00Z") },
    });
    const refund = await refunds.request(agent, order.id, {
      key: randomUUID(),
      reason,
    });
    await prisma.staffRefund.update({
      where: { id: refund.id },
      data: { completedAt: new Date("2030-01-01T12:00Z") },
    });
    const report = await management.finance({
        testOnly: "true",
        organizerId: organizer,
        from: "2030-01-01",
        to: "2030-01-02",
      }),
      group = report.groups.find((row) => row.currency === "EUR");
    expect(group).toMatchObject({
      gross: 0,
      refunds: 2000,
      commission: -100,
      outstanding: null,
    });
    expect(
      report.transactions.some(
        (row) => row.kind === "refund" && row.amount === -2000,
      ),
    ).toBe(true);
    expect(report.balances.find((row) => row.currency === "EUR")).toMatchObject(
      { gross: 2000, refunds: 2000, commission: 0, outstanding: 0 },
    );
  });
  it("preserves immutable audit records without secrets and revokes staff access immediately", async () => {
    const rows = await management.audit({ limit: "100" });
    expect(rows.items.some((v) => v.action === "payout.reversed")).toBe(true);
    const json = JSON.stringify(rows);
    expect(json).not.toContain(password);
    expect(json).not.toContain(adminToken);
    expect(json).not.toContain(recoveryCodes[0]);
    await expect(
      prisma.staffAudit.update({
        where: { id: rows.items[0]!.id },
        data: { reason: "tampered" },
      }),
    ).rejects.toThrow();
    await auth.change(admin, agent.id, { disabled: true, reason });
    expect(
      (await request("/staff/users", "GET", undefined, "support")).status,
    ).toBe(401);
    await auth.logout(admin);
    await expect(auth.authenticate(adminToken)).rejects.toMatchObject({
      status: 401,
    });
  });
});
