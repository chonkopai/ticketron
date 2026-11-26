vi.mock("../orders/automatic-purchase-link.js", () => ({ linkGuestPurchases: vi.fn().mockResolvedValue(0) }));
import type { PrismaClient, User } from "@event-platform/database";
import { UnauthorizedException } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthConfig } from "./auth.constants.js";
import { TokenService } from "./token.service.js";

interface StoredRefreshToken {
  id: string;
  userId: string;
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedByTokenId: string | null;
  familyCreatedAt: Date | null;
  createdAt: Date;
}

function fixture(config: Partial<AuthConfig> = {}) {
    const user = fixtureUser();
    const records: StoredRefreshToken[] = [];
    const refreshToken = {
      create: async ({ data }: { data: Omit<StoredRefreshToken, "createdAt" | "revokedAt" | "replacedByTokenId"> }) => {
        records.push({
          ...data,
          createdAt: new Date(),
          revokedAt: null,
          replacedByTokenId: null,
        });
        return records.at(-1);
      },
      findUnique: async ({ where }: { where: { tokenHash: string } }) => {
        const record = records.find((item) => item.tokenHash === where.tokenHash);
        return record ? { ...record, user } : null;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; revokedAt: null; expiresAt: { gt: Date } } | { familyId: string; userId: string; revokedAt: null };
        data: { revokedAt: Date };
      }) => {
        if ("familyId" in where) {
          let count = 0;
          for (const record of records) if (record.familyId === where.familyId && record.userId === where.userId && !record.revokedAt) { record.revokedAt = data.revokedAt; count++; }
          return { count };
        }
        const record = records.find(
          (item) =>
            item.id === where.id && !item.revokedAt && item.expiresAt > where.expiresAt.gt,
        );
        if (!record) return { count: 0 };
        record.revokedAt = data.revokedAt;
        return { count: 1 };
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { replacedByTokenId: string };
      }) => {
        const record = records.find((item) => item.id === where.id);
        if (!record) throw new Error("Refresh token fixture was not found");
        record.replacedByTokenId = data.replacedByTokenId;
        return record;
      },
    };
    const audit: Array<{ action: string; meta: unknown }> = [];
    const auditLog = { create: async ({ data }: { data: { action: string; meta: unknown } }) => { audit.push(data); return data; } };
    const database = {
      refreshToken,
      $transaction: async (callback: (transaction: { refreshToken: typeof refreshToken; auditLog: typeof auditLog; $queryRaw: () => Promise<unknown> }) => unknown) =>
        callback({ refreshToken, auditLog, $queryRaw: async () => [{ ok: 1 }] }),
    } as unknown as PrismaClient;
    const service = new TokenService(database, { accessTokenSecret: "a".repeat(32), refreshTokenSecret: "b".repeat(32), ...config } as AuthConfig);
    return { service, user, records, audit };
}

afterEach(() => { vi.useRealTimers(); });

describe("TokenService refresh rotation", () => {
  // Deliberate behaviour change. This used to assert that the newer token stayed valid.
  it("revokes the whole family and audits it when an already rotated token is presented again", async () => {
    const { service, user, records, audit } = fixture();
    const original = await service.issuePair(user);
    const rotated = await service.rotate(original.refreshToken);
    expect(rotated).toMatchObject({ accessExpiresInSeconds: 900, refreshExpiresInSeconds: 2_592_000 });

    await expect(service.rotate(original.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(service.rotate(rotated.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(records.every(record => record.revokedAt)).toBe(true);
    expect(audit).toEqual([{ actorId: user.id, action: "session.refresh_reuse_detected", entityType: "user", entityId: user.id, meta: { familyId: records[0]!.familyId, revokedTokens: 1 } }]);
  });

  it("rejects a logged-out family without treating it as reuse", async () => {
    const { service, user, audit } = fixture();
    const original = await service.issuePair(user);
    await service.revokeFamily(original.refreshToken);
    await expect(service.rotate(original.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(audit).toEqual([]);
  });

  it("ends a session at its absolute lifetime however often it is refreshed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2026-11-01T00:00:00.000Z");
    vi.setSystemTime(start);
    const day = 24 * 60 * 60 * 1_000;
    const { service, user, records } = fixture({ refreshFamilyMaxAgeSeconds: 60 * 24 * 60 * 60 });
    let tokens = await service.issuePair(user);
    for (const offset of [25, 50, 59]) {
      vi.setSystemTime(new Date(start.getTime() + offset * day));
      tokens = await service.rotate(tokens.refreshToken);
    }
    // The last token is capped at the family's 60-day limit instead of sliding 30 days further.
    expect(tokens.refreshExpiresInSeconds).toBe(24 * 60 * 60);
    expect(records.at(-1)!.expiresAt).toEqual(new Date(start.getTime() + 60 * day));
    expect(records.every(record => record.familyCreatedAt?.getTime() === start.getTime())).toBe(true);
    vi.setSystemTime(new Date(start.getTime() + 61 * day));
    await expect(service.rotate(tokens.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("refuses a legacy row older than the limit even if its token has not expired", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2026-11-01T00:00:00.000Z");
    vi.setSystemTime(start);
    const { service, user, records } = fixture({ refreshFamilyMaxAgeSeconds: 3_600 });
    const tokens = await service.issuePair(user);
    records[0]!.familyCreatedAt = new Date(start.getTime() - 2 * 3_600_000);
    await expect(service.rotate(tokens.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

function fixtureUser(): User {
  const now = new Date();
  return {
    id: "00000000-0000-4000-8000-000000000101",
    telegramId: 101n,
    telegramChatId: null,
    role: "guest",
    name: "Тестовый гость",
    firstName: null,
    lastName: null,
    passwordHash: null,
    credentialVersion: 0,
    photoUrl: null,
    phone: null,
    email: null,
    blockedAt: null, blockedReason: null, organizerVerifiedAt: null, commissionBps: null,
    defaultCity: null,
    defaultCountry: null,
    preferredCurrency: null,
    createdAt: now,
    updatedAt: now,
  };
}
