import { linkGuestPurchases } from "../orders/automatic-purchase-link.js";
import { createHash, randomUUID } from "node:crypto";

import type { Prisma, PrismaClient, User } from "@event-platform/database";
import type { AccountSessionList, AuthTokens } from "@event-platform/shared-types";
import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { jwtVerify, SignJWT, type JWTPayload } from "jose";

import { AUTH_CONFIG, DATABASE_CLIENT, type AuthConfig } from "./auth.constants.js";

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Absolute session lifetime: a refresh family cannot be extended past this age. */
export const DEFAULT_REFRESH_FAMILY_MAX_AGE_SECONDS = 60 * 24 * 60 * 60;
const ISSUER = "event-platform-api";
const AUDIENCE = "event-platform";

type TokenDatabase = Pick<Prisma.TransactionClient, "refreshToken">;
const REUSED = Symbol("refresh-token-reused");

interface EventPlatformClaims extends JWTPayload {
  tokenType?: "access" | "refresh";
  role?: string;
  familyId?: string;
  credentialVersion?: number;
  authTime?: number;
}

@Injectable()
export class TokenService {
  private readonly accessKey: Uint8Array;
  private readonly refreshKey: Uint8Array;
  private readonly familyMaxAgeMs: number;

  constructor(
    @Inject(DATABASE_CLIENT) private readonly database: PrismaClient,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {
    const encoder = new TextEncoder();
    this.accessKey = encoder.encode(config.accessTokenSecret);
    this.refreshKey = encoder.encode(config.refreshTokenSecret);
    this.familyMaxAgeMs = (config.refreshFamilyMaxAgeSeconds ?? DEFAULT_REFRESH_FAMILY_MAX_AGE_SECONDS) * 1_000;
  }

  async issuePair(user: User): Promise<AuthTokens> {
    await linkGuestPurchases(this.database, user.id);
    const authTime = Math.floor(Date.now() / 1_000);
    return this.createPair(user, this.database, randomUUID(), authTime, new Date(authTime * 1_000));
  }

  async rotate(refreshToken: string): Promise<AuthTokens> {
    const claims = await this.verify(refreshToken, this.refreshKey, "refresh");
    const credentialVersion = claims.credentialVersion ?? 0;
    const authTime = claims.authTime ?? claims.iat;
    if (!claims.jti || !claims.sub || !claims.familyId || !Number.isInteger(credentialVersion) || !Number.isInteger(authTime)) throw new UnauthorizedException();

    const tokenHash = hashToken(refreshToken);
    const now = new Date();

    const result = await this.database.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`refresh-family:${claims.familyId}`}, 0))`;
      const stored = await transaction.refreshToken.findUnique({
        where: { tokenHash },
        include: { user: true },
      });

      // A token that was already rotated is being presented again: either the holder or a thief
      // has a stale copy. Revoke the whole family so neither chain survives (committed before 401).
      if (stored && stored.revokedAt && stored.replacedByTokenId && stored.id === claims.jti && stored.userId === claims.sub && stored.familyId === claims.familyId) {
        const revoked = await transaction.refreshToken.updateMany({ where: { familyId: stored.familyId, userId: stored.userId, revokedAt: null }, data: { revokedAt: now } });
        await transaction.auditLog.create({ data: { actorId: stored.userId, action: "session.refresh_reuse_detected", entityType: "user", entityId: stored.userId, meta: { familyId: stored.familyId, revokedTokens: revoked.count } } });
        return REUSED;
      }

      if (
        !stored ||
        stored.id !== claims.jti ||
        stored.userId !== claims.sub ||
        stored.familyId !== claims.familyId ||
        stored.user.credentialVersion !== credentialVersion ||
        stored.revokedAt ||
        stored.expiresAt <= now
      ) {
        throw new UnauthorizedException("Refresh token is invalid or has already been used");
      }
      const familyCreatedAt = stored.familyCreatedAt ?? new Date(authTime! * 1_000);
      if (now.getTime() - familyCreatedAt.getTime() >= this.familyMaxAgeMs) throw new UnauthorizedException("Session has reached its maximum age");

      const claimed = await transaction.refreshToken.updateMany({
        where: { id: stored.id, revokedAt: null, expiresAt: { gt: now } },
        data: { revokedAt: now },
      });
      if (claimed.count !== 1) throw new UnauthorizedException("Refresh token was already rotated");

      const pair = await this.createPair(stored.user, transaction, stored.familyId, authTime!, familyCreatedAt);
      const nextClaims = await this.verify(pair.refreshToken, this.refreshKey, "refresh");
      if (!nextClaims.jti) throw new UnauthorizedException();

      await transaction.refreshToken.update({
        where: { id: stored.id },
        data: { replacedByTokenId: nextClaims.jti },
      });

      return pair;
    });
    if (result === REUSED) throw new UnauthorizedException("Refresh token was already used; the session has been revoked");
    return result;
  }

  /** Signed-in sessions: one entry per live refresh family (its current token). */
  async listSessions(userId: string, currentFamilyId: string | undefined, now = new Date()): Promise<AccountSessionList> {
    const heads = await this.database.refreshToken.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: "desc" },
      select: { familyId: true, familyCreatedAt: true, createdAt: true, expiresAt: true },
      take: 100,
    });
    return { items: heads.map(head => ({
      id: head.familyId,
      startedAt: (head.familyCreatedAt ?? head.createdAt).toISOString(),
      lastUsedAt: head.createdAt.toISOString(),
      expiresAt: head.expiresAt.toISOString(),
      current: head.familyId === currentFamilyId,
    })) };
  }

  /** Sign out everywhere: access tokens die with the credential version, refresh families are revoked. */
  async revokeAllSessions(userId: string): Promise<{ revoked: number }> {
    return this.database.$transaction(async transaction => {
      await transaction.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`identity-user:${userId}`}, 0))`;
      await transaction.user.update({ where: { id: userId }, data: { credentialVersion: { increment: 1 } } });
      const revoked = await transaction.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
      await transaction.auditLog.create({ data: { actorId: userId, action: "session.revoked_all", entityType: "user", entityId: userId, meta: { revokedTokens: revoked.count } } });
      return { revoked: revoked.count };
    });
  }

  async revokeFamily(refreshToken: string): Promise<void> {
    const claims = await this.verify(refreshToken, this.refreshKey, "refresh");
    if (!claims.jti || !claims.sub || !claims.familyId) throw new UnauthorizedException();
    await this.database.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`refresh-family:${claims.familyId}`}, 0))`;
      const stored = await transaction.refreshToken.findUnique({ where: { tokenHash: hashToken(refreshToken) }, select: { id: true, userId: true, familyId: true } });
      if (!stored || stored.id !== claims.jti || stored.userId !== claims.sub || stored.familyId !== claims.familyId) throw new UnauthorizedException();
      await transaction.refreshToken.updateMany({ where: { familyId: stored.familyId, userId: stored.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    });
  }

  async verifyAccess(accessToken: string): Promise<{ userId: string; credentialVersion: number; sessionFamilyId?: string; authenticatedAt: number }> {
    const claims = await this.verify(accessToken, this.accessKey, "access");
    const credentialVersion = claims.credentialVersion ?? 0;
    const authTime = claims.authTime ?? claims.iat;
    if (!claims.sub || !Number.isInteger(credentialVersion) || !Number.isInteger(authTime)) throw new UnauthorizedException();
    return { userId: claims.sub, credentialVersion, ...(claims.familyId ? { sessionFamilyId: claims.familyId } : {}), authenticatedAt: authTime! };
  }

  private async createPair(
    user: User,
    database: TokenDatabase,
    familyId: string,
    authTime: number,
    familyCreatedAt: Date,
  ): Promise<AuthTokens> {
    const issuedAt = Math.floor(Date.now() / 1_000);
    // Never outlive the family's absolute lifetime.
    const refreshExpiresAt = Math.min(issuedAt + REFRESH_TOKEN_TTL_SECONDS, Math.floor((familyCreatedAt.getTime() + this.familyMaxAgeMs) / 1_000));
    const refreshExpiresInSeconds = Math.max(1, refreshExpiresAt - issuedAt);
    const accessTokenId = randomUUID();
    const refreshTokenId = randomUUID();
    const accessToken = await new SignJWT({ tokenType: "access", role: user.role, familyId, credentialVersion: user.credentialVersion, authTime })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(user.id)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setJti(accessTokenId)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + ACCESS_TOKEN_TTL_SECONDS)
      .sign(this.accessKey);
    const refreshToken = await new SignJWT({
      tokenType: "refresh",
      role: user.role,
      familyId,
      credentialVersion: user.credentialVersion,
      authTime,
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(user.id)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setJti(refreshTokenId)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + refreshExpiresInSeconds)
      .sign(this.refreshKey);

    await database.refreshToken.create({
      data: {
        id: refreshTokenId,
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        familyId,
        familyCreatedAt,
        expiresAt: new Date((issuedAt + refreshExpiresInSeconds) * 1_000),
      },
    });

    return {
      accessToken,
      refreshToken,
      accessExpiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
      refreshExpiresInSeconds,
    };
  }

  private async verify(
    token: string,
    key: Uint8Array,
    expectedType: "access" | "refresh",
  ): Promise<EventPlatformClaims> {
    try {
      const { payload } = await jwtVerify<EventPlatformClaims>(token, key, {
        algorithms: ["HS256"],
        issuer: ISSUER,
        audience: AUDIENCE,
        requiredClaims: ["sub", "jti", "iat", "exp"],
        clockTolerance: 5,
      });
      if (payload.tokenType !== expectedType) throw new UnauthorizedException();
      return payload;
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException("JWT is invalid or expired");
    }
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
