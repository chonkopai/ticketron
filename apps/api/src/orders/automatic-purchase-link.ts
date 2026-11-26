import type { Prisma, PrismaClient } from "@event-platform/database";

/** Recover purchases using persisted, verified identities, never receipt-link storage or profile email. */
export async function linkGuestPurchases(database: PrismaClient, userId: string, orderId?: string): Promise<number> {
  // Read paths (My events, account pages) call this on every request. Almost always there is
  // nothing to link, so check without a transaction or lock first and only then take them.
  if (!await hasLinkCandidates(database, userId, orderId)) return 0;
  return database.$transaction(async tx => {
    // Identity mutations use this same lock. Concurrent logins/account requests serialize here.
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`identity-user:${userId}`}, 0))`;
    const matching = await linkableSessions(tx, userId, orderId);
    if (!matching) return 0;
    const sessions = await tx.anonymousCheckoutSession.findMany({ where: { ...matching, order: UNCLAIMED_ORDER }, orderBy: { orderId: "asc" }, select: { id: true, orderId: true, telegramId: true } });
    let linked = 0;
    for (const candidate of sessions) {
      const orderId = candidate.orderId!;
      // Share the order lock with explicit receipt claims and payment settlement.
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`order:${orderId}`}, 0))`;
      const session = await tx.anonymousCheckoutSession.findFirst({ where: { ...matching, id: candidate.id, orderId }, select: { id: true } });
      if (!session) continue;
      const changed = await tx.order.updateMany({ where: {
        id: orderId, buyerUserId: null, paymentStatus: { in: ["paid", "refunded", "cancelled"] },
        tickets: { none: { ownerUserId: { not: null }, NOT: { ownerUserId: userId } } },
      }, data: { buyerUserId: userId } });
      if (!changed.count) continue;
      await tx.ticket.updateMany({ where: { orderId, ownerUserId: null }, data: { ownerUserId: userId } });
      await tx.anonymousCheckoutSession.update({ where: { id: session.id }, data: { claimedAt: new Date(), claimHash: null, claimExpiresAt: null } });
      await tx.chatMessage.updateMany({ where: { orderId, guestUserId: null }, data: { guestUserId: userId } });
      await tx.auditLog.create({ data: { actorId: userId, action: "order.claimed", entityType: "order", entityId: orderId, meta: { automatic: true, via: candidate.telegramId !== null ? "telegram" : "email" } } });
      await tx.outboxEvent.create({ data: { eventType: "order.claimed", aggregateType: "order", aggregateId: orderId, payload: { userId } } });
      linked++;
    }
    return linked;
  }, { timeout: 30_000 });
}

const UNCLAIMED_ORDER: Prisma.OrderWhereInput = { buyerUserId: null, paymentStatus: { in: ["paid", "refunded", "cancelled"] } };

async function hasLinkCandidates(database: PrismaClient, userId: string, orderId?: string): Promise<boolean> {
  const matching = await linkableSessions(database, userId, orderId);
  return matching !== null && await database.anonymousCheckoutSession.findFirst({ where: { ...matching, order: UNCLAIMED_ORDER }, select: { id: true } }) !== null;
}

/** Sessions this user's verified identities may claim, or null when the user has none. */
async function linkableSessions(db: PrismaClient | Prisma.TransactionClient, userId: string, orderId?: string): Promise<Prisma.AnonymousCheckoutSessionWhereInput | null> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { telegramId: true, contactIdentities: { where: { method: "email" }, select: { normalizedIdentifier: true } } } });
  if (!user) return null;
  const identities: Prisma.AnonymousCheckoutSessionWhereInput[] = [];
  // A Telegram identity attached through a web link the Telegram user never confirmed in
  // the bot (links made before the consent step) does not prove ownership of that Telegram's orders.
  if (user.telegramId !== null && !await db.telegramLinkToken.findFirst({ where: { userId, confirmedAt: { not: null }, pendingTelegramId: user.telegramId, telegramConfirmedAt: null }, select: { id: true } })) {
    identities.push({ telegramId: user.telegramId });
  }
  const emails = user.contactIdentities.map(identity => identity.normalizedIdentifier);
  // Preserve the checkout's primary recipient: an email delivery address cannot take a Telegram buyer's order.
  if (emails.length) identities.push({ telegramId: null, verifiedEmail: { in: emails } });
  if (!identities.length) return null;
  return { OR: identities, claimedAt: null, orderId: orderId ?? { not: null } };
}
