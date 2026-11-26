import "../test-support/require-test-database.js";
import { randomUUID } from "node:crypto";
import { prisma } from "@event-platform/database";
import { UnauthorizedException } from "@nestjs/common";
import { afterAll, describe, expect, it } from "vitest";

import type { AuthConfig } from "./auth.constants.js";
import { AuthService } from "./auth.service.js";
import { SessionsController } from "./sessions.controller.js";
import { TokenService } from "./token.service.js";
import { VerificationService } from "./verification.service.js";

// Refresh-session hardening and token cleanup against PostgreSQL.
const config = { accessTokenSecret: "a".repeat(32), refreshTokenSecret: "b".repeat(32) } as AuthConfig;
const tokens = new TokenService(prisma, config);
const auth = new AuthService(prisma, config, tokens, {} as never);
const sessions = new SessionsController(tokens);
const users: string[] = [];

async function account() {
  const user = await prisma.user.create({ data: { name: "Session fixture" } });
  users.push(user.id);
  return user;
}

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { entityId: { in: users } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.$disconnect();
});

describe("refresh sessions", () => {
  it("revokes the family on reuse of a rotated token so a thief's chain dies with the victim's", async () => {
    const user = await account();
    const stolen = await tokens.issuePair(user);
    const attacker = await tokens.rotate(stolen.refreshToken);
    // The victim's tab still holds the rotated token and presents it.
    await expect(tokens.rotate(stolen.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(tokens.rotate(attacker.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(await prisma.refreshToken.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { entityId: user.id, action: "session.refresh_reuse_detected" } })).toBe(1);
  });

  it("stores the family start, keeps it on rotation and refuses a family past the absolute lifetime", async () => {
    const user = await account();
    const issued = await tokens.issuePair(user);
    const first = await prisma.refreshToken.findFirstOrThrow({ where: { userId: user.id } });
    expect(first.familyCreatedAt).not.toBeNull();
    const next = await tokens.rotate(issued.refreshToken);
    const rows = await prisma.refreshToken.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } });
    expect(rows.map(row => row.familyCreatedAt?.getTime())).toEqual([first.familyCreatedAt!.getTime(), first.familyCreatedAt!.getTime()]);

    await prisma.refreshToken.updateMany({ where: { userId: user.id }, data: { familyCreatedAt: new Date(Date.now() - 61 * 24 * 60 * 60 * 1_000) } });
    await expect(tokens.rotate(next.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("lists live sessions and signs out everywhere, including access tokens, for a passwordless account", async () => {
    const user = await account();
    const phone = await tokens.issuePair(user);
    const laptop = await tokens.issuePair(user);
    const principal = await auth.authenticate(laptop.accessToken);
    await tokens.rotate(phone.refreshToken);

    const list = await sessions.list(principal);
    expect(list.items).toHaveLength(2);
    expect(list.items.filter(item => item.current)).toEqual([expect.objectContaining({ id: principal.sessionFamilyId })]);

    await expect(sessions.revokeAll(principal)).resolves.toEqual({ revoked: 2 });
    await expect(auth.authenticate(laptop.accessToken)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(tokens.rotate(laptop.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException);
    expect((await tokens.listSessions(user.id, undefined)).items).toEqual([]);
    expect(await prisma.auditLog.count({ where: { entityId: user.id, action: "session.revoked_all" } })).toBe(1);
  });
});

describe("token cleanup", () => {
  it("purges expired and family-ending refresh rows and stale link tokens, keeping what reuse detection and linking need", async () => {
    const user = await account();
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000), soon = new Date(Date.now() + 24 * 60 * 60 * 1_000);
    const family = randomUUID();
    const head = await prisma.refreshToken.create({ data: { userId: user.id, familyId: family, tokenHash: randomUUID(), expiresAt: soon } });
    const rotated = await prisma.refreshToken.create({ data: { userId: user.id, familyId: family, tokenHash: randomUUID(), expiresAt: soon, revokedAt: old, replacedByTokenId: head.id } });
    const expired = await prisma.refreshToken.create({ data: { userId: user.id, familyId: randomUUID(), tokenHash: randomUUID(), expiresAt: old } });
    const loggedOut = await prisma.refreshToken.create({ data: { userId: user.id, familyId: randomUUID(), tokenHash: randomUUID(), expiresAt: soon, revokedAt: old } });
    const staleLink = await prisma.telegramLinkToken.create({ data: { userId: user.id, tokenHash: randomUUID(), expiresAt: old } });
    const usedLink = await prisma.telegramLinkToken.create({ data: { userId: user.id, tokenHash: randomUUID(), expiresAt: old, usedAt: old } });
    const confirmedLink = await prisma.telegramLinkToken.create({ data: { userId: user.id, tokenHash: randomUUID(), expiresAt: old, usedAt: old, confirmedAt: old } });
    const liveLink = await prisma.telegramLinkToken.create({ data: { userId: user.id, tokenHash: randomUUID(), expiresAt: soon } });

    const verification = new VerificationService(prisma, { hmacSecret: "h".repeat(32) }, { send: async () => undefined } as never);
    await verification.cleanupExpired();

    const refresh = new Set((await prisma.refreshToken.findMany({ where: { userId: user.id }, select: { id: true } })).map(row => row.id));
    expect([head.id, rotated.id].every(id => refresh.has(id))).toBe(true);
    expect([expired.id, loggedOut.id].some(id => refresh.has(id))).toBe(false);
    const linkIds = new Set((await prisma.telegramLinkToken.findMany({ where: { userId: user.id }, select: { id: true } })).map(row => row.id));
    expect([...linkIds].sort()).toEqual([confirmedLink.id, liveLink.id].sort());
    expect(linkIds.has(staleLink.id) || linkIds.has(usedLink.id)).toBe(false);
  });
});
