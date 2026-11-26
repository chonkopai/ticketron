import "../test-support/require-test-database.js";
import { createHash, randomUUID } from "node:crypto";
import { prisma } from "@event-platform/database";
import { ConflictException, UnauthorizedException } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { linkGuestPurchases } from "../orders/automatic-purchase-link.js";
import type { AuthConfig } from "./auth.constants.js";
import { TelegramLinkService } from "./telegram-link.service.js";

// A link token opened in Telegram binds nothing until that Telegram user confirms in the bot.
const ownerId = randomUUID(), eventId = randomUUID(), typeId = randomUUID();
const users: string[] = [ownerId], orders: string[] = [];
let telegram = BigInt(5_000_000_000 + Math.floor(Math.random() * 1_000_000_000)) * 1_000n;
const links = new TelegramLinkService(prisma, { telegramBotUsername: "test_ticket_bot" } as AuthConfig);

async function webAccount(email: string) {
  const user = await prisma.user.create({ data: { contactIdentities: { create: { method: "email", normalizedIdentifier: email, verifiedAt: new Date() } } } });
  users.push(user.id);
  return { user, family: randomUUID() };
}
async function botPurchase(telegramId: bigint) {
  const order = await prisma.order.create({ data: { type: "ticket", amount: 0, currency: "RUB", paymentStatus: "paid",
    tickets: { create: { ticketTypeId: typeId, status: "active", qrToken: randomUUID() } },
    anonymousSession: { create: { name: "Bot buyer", telegramId, chatId: telegramId, sessionHash: randomUUID(), accessHash: randomUUID(), expiresAt: new Date("2020-01-01"), accessExpiresAt: new Date("2020-01-02") } },
  }, include: { tickets: true } });
  orders.push(order.id);
  return order;
}
async function owner(orderId: string) {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { tickets: true } });
  return { buyer: order.buyerUserId, tickets: order.tickets.map(ticket => ticket.ownerUserId) };
}

beforeAll(async () => {
  await prisma.user.create({ data: { id: ownerId, role: "organizer" } });
  await prisma.event.create({ data: { id: eventId, organizerId: ownerId, title: "Link consent fixture", status: "published", date: new Date("2035-01-01"), time: new Date("1970-01-01T18:00:00Z"), timezone: "UTC", address: "Test venue" } });
  await prisma.ticketType.create({ data: { id: typeId, eventId, name: "Invitation", price: 0, currency: "RUB", quantityTotal: 100 } });
});
afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: orders } }, { entityId: { in: users } }] } });
  await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: orders } } });
  await prisma.anonymousCheckoutSession.deleteMany({ where: { orderId: { in: orders } } });
  await prisma.order.deleteMany({ where: { id: { in: orders } } });
  await prisma.event.delete({ where: { id: eventId } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.$disconnect();
});

describe("Telegram account link consent", () => {
  it("an attacker's link opened by a victim who does not press Confirm links nothing and moves no orders", async () => {
    const victimTelegram = ++telegram;
    const order = await botPurchase(victimTelegram);
    const attacker = await webAccount(`attacker-${randomUUID()}@example.test`);
    const link = await links.issue(attacker.user.id, new Date(), attacker.family);

    // The victim taps Start on the attacker's deep link.
    await links.consume({ token: link.token, telegramId: Number(victimTelegram), chatId: Number(victimTelegram) }).catch(() => undefined);

    // The attacker's account page can neither see the link as ready nor confirm it.
    expect(await links.status(attacker.user.id, attacker.family, link.token)).not.toEqual({ state: "ready" });
    await expect(links.confirm(attacker.user.id, attacker.family, link.token)).rejects.toBeInstanceOf(UnauthorizedException);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: attacker.user.id } })).telegramId).toBeNull();
    expect(await linkGuestPurchases(prisma, attacker.user.id)).toBe(0);
    expect(await owner(order.id)).toEqual({ buyer: null, tickets: [null] });
  });

  it("shows the Telegram user which account asks, and Cancel ends the link for good", async () => {
    const victimTelegram = ++telegram;
    const email = `cancel-${randomUUID()}@example.test`;
    const attacker = await webAccount(email);
    const link = await links.issue(attacker.user.id, new Date(), attacker.family);
    expect(link.token).toMatch(/^l_[A-Za-z0-9_-]{32}$/);
    expect(link.deepLinkUrl).toBe(`https://t.me/test_ticket_bot?start=${link.token}`);

    const attempt = await links.consume({ token: link.token, telegramId: Number(victimTelegram), chatId: Number(victimTelegram) });
    expect(attempt.account).toBe(`c***@e***.test`);
    expect(await links.status(attacker.user.id, attacker.family, link.token)).toEqual({ state: "waiting" });
    // Re-opening by the same Telegram user re-shows the same prompt; nobody else can take the token.
    await expect(links.consume({ token: link.token, telegramId: Number(victimTelegram), chatId: Number(victimTelegram) })).resolves.toEqual(attempt);
    await expect(links.consume({ token: link.token, telegramId: Number(++telegram), chatId: Number(telegram) })).rejects.toBeInstanceOf(UnauthorizedException);
    // Only the Telegram user who opened the link can answer for it.
    await expect(links.answer({ attemptId: attempt.attemptId, telegramId: Number(telegram), chatId: Number(telegram), decision: "confirm" })).rejects.toBeInstanceOf(UnauthorizedException);

    await expect(links.answer({ attemptId: attempt.attemptId, telegramId: Number(victimTelegram), chatId: Number(victimTelegram), decision: "cancel" })).resolves.toEqual({ state: "cancelled" });
    expect(await links.status(attacker.user.id, attacker.family, link.token)).toEqual({ state: "expired" });
    await expect(links.answer({ attemptId: attempt.attemptId, telegramId: Number(victimTelegram), chatId: Number(victimTelegram), decision: "confirm" })).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(links.consume({ token: link.token, telegramId: Number(victimTelegram), chatId: Number(victimTelegram) })).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(links.confirm(attacker.user.id, attacker.family, link.token)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(await prisma.auditLog.count({ where: { entityId: attacker.user.id, action: "identity.telegram_link_declined" } })).toBe(1);
  });

  it("links after Confirm in Telegram and then on the web, and recovers that Telegram's bot purchases", async () => {
    const ownTelegram = ++telegram;
    const order = await botPurchase(ownTelegram);
    const account = await webAccount(`owner-${randomUUID()}@example.test`);
    const link = await links.issue(account.user.id, new Date(), account.family);
    const attempt = await links.consume({ token: link.token, telegramId: Number(ownTelegram), chatId: Number(ownTelegram) });
    expect(await linkGuestPurchases(prisma, account.user.id)).toBe(0);

    await expect(links.answer({ attemptId: attempt.attemptId, telegramId: Number(ownTelegram), chatId: Number(ownTelegram), decision: "confirm", firstName: "Owner" })).resolves.toEqual({ state: "pending" });
    expect(await links.status(account.user.id, account.family, link.token)).toEqual({ state: "ready" });
    await expect(links.confirm(account.user.id, randomUUID(), link.token)).rejects.toBeInstanceOf(UnauthorizedException);
    const linked = await links.confirm(account.user.id, account.family, link.token);
    expect(linked.telegramId).toBe(ownTelegram);
    expect(linked.telegramChatId).toBe(ownTelegram);
    expect(await links.status(account.user.id, account.family, link.token)).toEqual({ state: "linked" });

    expect(await linkGuestPurchases(prisma, account.user.id)).toBe(1);
    expect(await owner(order.id)).toEqual({ buyer: account.user.id, tickets: [account.user.id] });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: order.id, action: "order.claimed" } });
    expect(audit).toMatchObject({ actorId: account.user.id, meta: { automatic: true, via: "telegram" } });
  });

  it("refreshes the chat of the account's own Telegram identity only after Confirm", async () => {
    const ownTelegram = ++telegram;
    const user = await prisma.user.create({ data: { telegramId: ownTelegram } });
    users.push(user.id);
    const link = await links.issue(user.id, new Date(), randomUUID());
    const attempt = await links.consume({ token: link.token, telegramId: Number(ownTelegram), chatId: Number(ownTelegram) });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).telegramChatId).toBeNull();
    await expect(links.answer({ attemptId: attempt.attemptId, telegramId: Number(ownTelegram), chatId: Number(ownTelegram), decision: "confirm", firstName: "Relinked" })).resolves.toEqual({ state: "linked" });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ telegramChatId: ownTelegram, name: "Relinked" });
  });

  it("cancels pending Telegram notifications addressed to a previous chat when the chat changes", async () => {
    const own = ++telegram;
    const user = await prisma.user.create({ data: { telegramId: own, telegramChatId: own + 5000n } });
    users.push(user.id);
    const stale = await prisma.notification.create({ data: { userId: user.id, telegramId: own + 5000n, channel: "telegram", type: "event.reminder", recipientKey: `user:${user.id}`, payload: { text: "x" }, nextAttemptAt: new Date() } });
    const link = await links.issue(user.id, new Date(), randomUUID());
    const attempt = await links.consume({ token: link.token, telegramId: Number(own), chatId: Number(own) });
    await links.answer({ attemptId: attempt.attemptId, telegramId: Number(own), chatId: Number(own), decision: "confirm" });
    await expect(prisma.notification.findUniqueOrThrow({ where: { id: stale.id } })).resolves.toMatchObject({ status: "failed", lastError: "RECIPIENT_PREFERENCE_OR_LINK_CHANGED" });
    await prisma.notification.delete({ where: { id: stale.id } });
  });

  it("rejects an old link token without the l_ prefix and a Telegram identity owned by someone else", async () => {
    const account = await webAccount(`legacy-${randomUUID()}@example.test`);
    const unprefixed = "A".repeat(32);
    await prisma.telegramLinkToken.create({ data: { userId: account.user.id, sessionFamilyId: account.family, tokenHash: createHash("sha256").update(unprefixed).digest("hex"), expiresAt: new Date(Date.now() + 600_000) } });
    await expect(links.consume({ token: unprefixed, telegramId: Number(++telegram), chatId: Number(telegram) })).rejects.toBeInstanceOf(UnauthorizedException);

    const taken = ++telegram;
    users.push((await prisma.user.create({ data: { telegramId: taken } })).id);
    const link = await links.issue(account.user.id, new Date(), account.family);
    await expect(links.consume({ token: link.token, telegramId: Number(taken), chatId: Number(taken) })).rejects.toBeInstanceOf(ConflictException);
  });

  it("does not auto-claim Telegram purchases for a link made before the Telegram-side confirmation existed", async () => {
    const victimTelegram = ++telegram;
    const order = await botPurchase(victimTelegram);
    const attacker = await webAccount(`old-link-${randomUUID()}@example.test`);
    // State left by the pre-fix flow: consume stored the victim as pending and the web confirmed it.
    await prisma.user.update({ where: { id: attacker.user.id }, data: { telegramId: victimTelegram, telegramChatId: victimTelegram } });
    await prisma.telegramLinkToken.create({ data: { userId: attacker.user.id, sessionFamilyId: attacker.family, tokenHash: randomUUID(), expiresAt: new Date(Date.now() - 1_000), usedAt: new Date(), pendingTelegramId: victimTelegram, pendingChatId: victimTelegram, pendingAt: new Date(), confirmedAt: new Date() } });
    expect(await linkGuestPurchases(prisma, attacker.user.id)).toBe(0);
    expect(await owner(order.id)).toEqual({ buyer: null, tickets: [null] });
  });
});
