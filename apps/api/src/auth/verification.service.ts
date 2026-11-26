import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";

import type { Prisma, PrismaClient, VerificationPurpose } from "@event-platform/database";
import { BadRequestException, HttpException, Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from "@nestjs/common";
import { startIntervalWorker } from "../workers/interval-worker.js";

import { DATABASE_CLIENT } from "./auth.constants.js";
import { normalizeContact, type ContactMethod } from "./contact-identity.js";
import { VERIFICATION_CONFIG, VERIFICATION_SENDER, type VerificationConfig } from "./verification.tokens.js";
import type { VerificationSender } from "./verification-sender.js";

const CODE_TTL_MS = 5 * 60_000;
const GRANT_TTL_MS = 10 * 60_000;
const COOLDOWN_MS = 60_000;
const MAX_ATTEMPTS = 5;
const LIMIT_WINDOW_MS = 60 * 60_000;
export const AUTH_BROWSER_COOKIE = "ticket_auth_browser";
const AUTH_BROWSER_SECONDS = 30 * 24 * 60 * 60;

/** A hard hourly cap: every call counts, even rejected ones. */
type HardLimit = { key: string; max: number };
/** A slow-down bucket for limits keyed by someone else's identifier (email/phone).
 * The first `free` hits in a sliding hour pass; after that each hit must wait
 * `baseSeconds·2^(hits−free)` (capped) after the previous hit. Rejected calls are
 * not counted, so a flood cannot extend the wait, and the target recovers within
 * `capSeconds` of the last hit instead of being locked for a full hour. */
type Backoff = { key: string; free: number; baseSeconds: number; capSeconds: number; countOnPass: boolean };
type LimitRule = HardLimit | Backoff;

const ISSUE_TARGET = { free: 5, baseSeconds: 60, capSeconds: 15 * 60 };
const VERIFY_TARGET = { free: 25, baseSeconds: 5, capSeconds: 5 * 60 };
const LOGIN_TARGET = { free: 20, baseSeconds: 5, capSeconds: 5 * 60 };
const LOGIN_TARGET_CLIENT = { free: 10, baseSeconds: 60, capSeconds: 60 * 60 };

export interface VerificationContext {
  purpose: VerificationPurpose;
  method: ContactMethod;
  target: string;
  userId?: string;
  sessionFamilyId?: string;
}

export interface IssueVerification extends VerificationContext {
  /** Trusted network address, never an untrusted forwarded header. */
  clientKey: string;
  /** Per-browser key for requests without a user or session (see `browserActor`). */
  actorKey?: string;
}

export interface VerifyCode extends VerificationContext {
  challengeId: string;
  code: string;
  clientKey: string;
}

export interface ClaimGrant extends VerificationContext {
  grant: string;
}

@Injectable()
export class VerificationService implements OnModuleInit, OnModuleDestroy {
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private readonly logger = new Logger(VerificationService.name);

  constructor(
    @Inject(DATABASE_CLIENT) private readonly db: PrismaClient,
    @Inject(VERIFICATION_CONFIG) private readonly config: VerificationConfig,
    @Inject(VERIFICATION_SENDER) private readonly sender: VerificationSender,
  ) {
    if (config.hmacSecret.length < 32) throw new Error("OTP_HMAC_SECRET must contain at least 32 characters");
  }

  onModuleInit(): void {
    this.cleanupTimer = startIntervalWorker({ name: "Verification cleanup", intervalMs: 30 * 60_000, logger: this.logger, task: () => this.cleanupExpired() });
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  async issue(input: IssueVerification): Promise<{ challengeId: string; expiresAt: string; retryAfterSeconds: number }> {
    const target = normalizeContact(input.method, input.target);
    this.validateContext(input);
    if (!this.sender.available(input.method)) throw new ServiceUnavailableException({ code: "VERIFICATION_PROVIDER_UNAVAILABLE" });
    const now = new Date();
    const id = randomUUID();
    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    const expiresAt = new Date(now.getTime() + CODE_TTL_MS);
    const scope = { ...input, target };
    const result = await this.db.$transaction(async tx => {
      const { allowed, firstExceeded } = await this.applyLimits(tx, this.issueLimitKeys(scope), now);
      if (firstExceeded.includes(this.key("global", "send"))) this.logger.warn("Global OTP send cap (1000/h) reached; new verification codes are refused until the window resets");
      if (!allowed) return false;
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`otp:${input.purpose}:${input.method}:${target}`}, 0))`;
      const active = await tx.verificationChallenge.findFirst({
        where: { purpose: input.purpose, method: input.method, normalizedTarget: target, userId: input.userId ?? null, sessionFamilyId: input.sessionFamilyId ?? null, consumedAt: null, expiresAt: { gt: now } },
        orderBy: { createdAt: "desc" },
      });
      if (active?.lastSentAt && now.getTime() - active.lastSentAt.getTime() < COOLDOWN_MS) return false;
      await tx.verificationChallenge.updateMany({
        where: { purpose: input.purpose, method: input.method, normalizedTarget: target, userId: input.userId ?? null, sessionFamilyId: input.sessionFamilyId ?? null, consumedAt: null },
        data: { consumedAt: now },
      });
      await tx.verificationChallenge.create({ data: {
        id, purpose: input.purpose, method: input.method, normalizedTarget: target,
        userId: input.userId ?? null, sessionFamilyId: input.sessionFamilyId ?? null,
        secretVerifier: this.codeVerifier(id, input.purpose, target, code),
        expiresAt, lastSentAt: now, sendCount: 1,
      } });
      return true;
    });
    if (!result) throw new HttpException({ code: "VERIFICATION_RATE_LIMITED", retryAfterSeconds: 60 }, 429);
    try {
      await this.sender.send({ method: input.method, target, code, idempotencyKey: `otp/${id}` });
    } catch {
      await this.db.verificationChallenge.updateMany({ where: { id, consumedAt: null }, data: { consumedAt: new Date() } });
      throw new ServiceUnavailableException({ code: "VERIFICATION_SEND_FAILED" });
    }
    return { challengeId: id, expiresAt: expiresAt.toISOString(), retryAfterSeconds: 60 };
  }

  async verify(input: VerifyCode): Promise<{ grant: string; expiresAt: string }> {
    const target = normalizeContact(input.method, input.target);
    this.validateContext(input);
    if (!/^\d{6}$/.test(input.code)) throw new BadRequestException({ code: "INVALID_VERIFICATION_CODE" });
    const grant = randomBytes(32).toString("base64url");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + GRANT_TTL_MS);
    const result = await this.db.$transaction(async tx => {
      const { allowed } = await this.applyLimits(tx, this.verifyLimitKeys({ ...input, target }), now);
      if (!allowed) return "rate";
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`otp-challenge:${input.challengeId}`}, 0))`;
      const row = await tx.verificationChallenge.findUnique({ where: { id: input.challengeId } });
      if (!row || row.purpose !== input.purpose || row.method !== input.method || row.normalizedTarget !== target || row.userId !== (input.userId ?? null) || row.sessionFamilyId !== (input.sessionFamilyId ?? null) || row.consumedAt || row.expiresAt <= now || row.failedAttempts >= MAX_ATTEMPTS) return "invalid";
      const expected = Buffer.from(row.secretVerifier, "hex");
      const actual = Buffer.from(this.codeVerifier(row.id, row.purpose, target, input.code), "hex");
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        await tx.verificationChallenge.update({ where: { id: row.id }, data: { failedAttempts: { increment: 1 } } });
        return "invalid";
      }
      await tx.verificationChallenge.update({ where: { id: row.id }, data: { consumedAt: now } });
      await tx.verificationGrant.create({ data: {
        challengeId: row.id, tokenHash: hash(grant), purpose: row.purpose, method: row.method,
        normalizedTarget: row.normalizedTarget, userId: row.userId, sessionFamilyId: row.sessionFamilyId, expiresAt,
      } });
      return "valid";
    });
    if (result === "rate") throw new HttpException({ code: "VERIFICATION_RATE_LIMITED" }, 429);
    if (result !== "valid") throw new BadRequestException({ code: "INVALID_VERIFICATION_CODE" });
    return { grant, expiresAt: expiresAt.toISOString() };
  }

  /** Call inside the account/order transaction so a grant and its effect commit together. */
  async claimGrant(tx: Prisma.TransactionClient, input: ClaimGrant): Promise<{ method: ContactMethod; target: string }> {
    const target = normalizeContact(input.method, input.target);
    this.validateContext(input);
    const row = await tx.verificationGrant.findUnique({ where: { tokenHash: hash(input.grant) } });
    const now = new Date();
    if (!row || !grantMatches(row, input, target, now)) throw new BadRequestException({ code: "INVALID_VERIFICATION_GRANT" });
    const claimed = await tx.verificationGrant.updateMany({ where: { id: row.id, consumedAt: null, expiresAt: { gt: now } }, data: { consumedAt: now } });
    if (claimed.count !== 1) throw new BadRequestException({ code: "INVALID_VERIFICATION_GRANT" });
    return { method: row.method, target: row.normalizedTarget };
  }

  /** Cheap read-only check before expensive work (password hashing). `claimGrant`
   * stays the authoritative, atomic check inside the transaction. */
  async assertGrantUsable(input: ClaimGrant): Promise<void> {
    const target = normalizeContact(input.method, input.target);
    this.validateContext(input);
    const row = await this.db.verificationGrant.findUnique({ where: { tokenHash: hash(input.grant) } });
    if (!row || !grantMatches(row, input, target, new Date())) throw new BadRequestException({ code: "INVALID_VERIFICATION_GRANT" });
  }

  /** Per-browser actor key for anonymous code requests (register, password reset),
   * carried in a signed HttpOnly cookie. A client that drops the cookie gets a
   * fresh key each time and is still bounded by the per-client limit. */
  browserActor(cookieHeader: string | undefined): { key: string; setCookie?: string } {
    const values = cookieHeader?.split(";").map(value => value.trim()).filter(value => value.startsWith(`${AUTH_BROWSER_COOKIE}=`)) ?? [];
    const [id, signature] = values.length === 1 ? values[0]!.slice(AUTH_BROWSER_COOKIE.length + 1).split(".") : [];
    if (id && signature && /^[A-Za-z0-9_-]{43}$/.test(id) && safeEqual(signature, this.browserSignature(id))) return { key: `browser:${id}` };
    const fresh = randomBytes(32).toString("base64url");
    return { key: `browser:${fresh}`, setCookie: `${AUTH_BROWSER_COOKIE}=${fresh}.${this.browserSignature(fresh)}; Path=/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=${AUTH_BROWSER_SECONDS}` };
  }

  async cleanupExpired(): Promise<void> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60_000);
    await this.db.verificationChallenge.deleteMany({ where: { expiresAt: { lt: cutoff } } });
    await this.db.verificationRateLimit.deleteMany({ where: { windowEnd: { lt: cutoff } } });
    // Expired refresh tokens can no longer be presented (the JWT expires with the row).
    // Revoked rows are kept while a rotated token could still be replayed (reuse detection);
    // only rows that ended a family (logout, revoke-all, reuse) are dropped once revoked a day ago.
    await this.db.refreshToken.deleteMany({ where: { OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff }, replacedByTokenId: null }] } });
    // Unused, cancelled or never-confirmed link tokens. Confirmed links stay: they record how a
    // Telegram identity was attached, which automatic purchase linking checks.
    await this.db.telegramLinkToken.deleteMany({ where: { expiresAt: { lt: cutoff }, confirmedAt: null } });
  }

  /** Before a password check or reset request. The per-client cap is the hard stop;
   * failures recorded against the target only slow it down (see `Backoff`). */
  async enforceCredentialLimit(method: ContactMethod, target: string, clientKey: string): Promise<void> {
    const now = new Date();
    const { allowed } = await this.db.$transaction(tx => this.applyLimits(tx, [
      { key: this.key("login-client", clientKey), max: 100 },
      ...this.credentialFailureRules(method, target, clientKey, false),
    ], now));
    if (!allowed) throw new HttpException({ code: "LOGIN_RATE_LIMITED" }, 429);
  }

  async recordCredentialFailure(method: ContactMethod, target: string, clientKey: string): Promise<void> {
    const now = new Date();
    await this.db.$transaction(async tx => {
      for (const rule of this.credentialFailureRules(method, target, clientKey, false).sort((a, b) => a.key.localeCompare(b.key))) {
        await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`otp-limit:${rule.key}`}, 0))`;
        await this.hit(tx, rule.key, await tx.verificationRateLimit.findUnique({ where: { scopeKey: rule.key } }), now);
      }
    });
  }

  /** A correct password clears this client's failures for the target; the target-wide
   * slow-down still expires on its own. */
  async clearCredentialFailures(method: ContactMethod, target: string, clientKey: string): Promise<void> {
    await this.db.verificationRateLimit.deleteMany({ where: { scopeKey: this.key("login-pair", `${method}:${normalizeContact(method, target)}:${clientKey}`) } });
  }

  providerAvailable(method: ContactMethod): boolean { return this.sender.available(method); }

  private validateContext(input: VerificationContext): void {
    if (input.purpose === "link" && (!input.userId || !input.sessionFamilyId)) throw new BadRequestException({ code: "SESSION_REQUIRED" });
    if (input.purpose === "checkout_email" && !input.sessionFamilyId) throw new BadRequestException({ code: "CHECKOUT_SESSION_REQUIRED" });
    if (input.method === "phone" && input.purpose === "checkout_email") throw new BadRequestException({ code: "EMAIL_REQUIRED" });
  }

  private codeVerifier(id: string, purpose: VerificationPurpose, target: string, code: string): string {
    return createHmac("sha256", this.config.hmacSecret).update(`${id}:${purpose}:${target}:${code}`).digest("hex");
  }

  private key(label: string, value: string): string {
    return `${label}:${createHmac("sha256", this.config.hmacSecret).update(value).digest("hex")}`;
  }

  private browserSignature(id: string): string {
    return createHmac("sha256", this.config.hmacSecret).update(`auth-browser:${id}`).digest("base64url");
  }

  // scopeKey is VarChar(80): keep labels short (label + ":" + 64 hex chars).
  private credentialFailureRules(method: ContactMethod, target: string, clientKey: string, countOnPass: boolean): Backoff[] {
    const normalized = normalizeContact(method, target);
    return [
      { key: this.key("login-target", `${method}:${normalized}`), ...LOGIN_TARGET, countOnPass },
      { key: this.key("login-pair", `${method}:${normalized}:${clientKey}`), ...LOGIN_TARGET_CLIENT, countOnPass },
    ];
  }

  private issueLimitKeys(input: IssueVerification): LimitRule[] {
    // Never fall back to the client address: that would make the actor limit a
    // second, stricter per-client limit shared by everyone behind one address.
    const actor = input.userId ?? input.sessionFamilyId ?? input.actorKey;
    return [
      { key: this.key("target", `${input.method}:${input.target}`), ...ISSUE_TARGET, countOnPass: true },
      { key: this.key("client", input.clientKey), max: 20 },
      ...(actor ? [{ key: this.key("actor", actor), max: 10 }] : []),
      { key: this.key("global", "send"), max: 1000 },
    ];
  }

  private verifyLimitKeys(input: VerifyCode): LimitRule[] {
    return [
      { key: this.key("verify-target", `${input.method}:${input.target}`), ...VERIFY_TARGET, countOnPass: true },
      { key: this.key("verify-client", input.clientKey), max: 60 },
    ];
  }

  /** Locks every bucket in key order, then decides. Hard limits count every call;
   * slow-down buckets only count calls that pass all rules (when `countOnPass`). */
  private async applyLimits(tx: Prisma.TransactionClient, rules: LimitRule[], now: Date): Promise<{ allowed: boolean; firstExceeded: string[] }> {
    const sorted = [...rules].sort((a, b) => a.key.localeCompare(b.key));
    const rows = new Map<string, { count: number; windowEnd: Date } | null>();
    for (const rule of sorted) {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`otp-limit:${rule.key}`}, 0))`;
      rows.set(rule.key, await tx.verificationRateLimit.findUnique({ where: { scopeKey: rule.key } }));
    }
    let allowed = true;
    const firstExceeded: string[] = [];
    for (const rule of sorted) {
      const existing = rows.get(rule.key) ?? null;
      if ("max" in rule) {
        const count = !existing || existing.windowEnd <= now ? 1 : existing.count + 1;
        const windowEnd = !existing || existing.windowEnd <= now ? new Date(now.getTime() + LIMIT_WINDOW_MS) : existing.windowEnd;
        await tx.verificationRateLimit.upsert({ where: { scopeKey: rule.key }, create: { scopeKey: rule.key, count, windowEnd }, update: { count, windowEnd } });
        if (count > rule.max) allowed = false;
        if (count === rule.max + 1) firstExceeded.push(rule.key);
      } else if (backoffBlocked(existing, rule, now)) allowed = false;
    }
    if (allowed) for (const rule of sorted) if (!("max" in rule) && rule.countOnPass) await this.hit(tx, rule.key, rows.get(rule.key) ?? null, now);
    return { allowed, firstExceeded };
  }

  /** Slow-down rows store the hit count and `windowEnd = last hit + 1 h` (sliding). */
  private async hit(tx: Prisma.TransactionClient, scopeKey: string, existing: { count: number; windowEnd: Date } | null, now: Date): Promise<void> {
    const count = !existing || existing.windowEnd <= now ? 1 : existing.count + 1;
    const windowEnd = new Date(now.getTime() + LIMIT_WINDOW_MS);
    await tx.verificationRateLimit.upsert({ where: { scopeKey }, create: { scopeKey, count, windowEnd }, update: { count, windowEnd } });
  }
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

type GrantRow = { purpose: VerificationPurpose; method: string; normalizedTarget: string; userId: string | null; sessionFamilyId: string | null; consumedAt: Date | null; expiresAt: Date };
function grantMatches(row: GrantRow, input: ClaimGrant, target: string, now: Date): boolean {
  return row.purpose === input.purpose && row.method === input.method && row.normalizedTarget === target && row.userId === (input.userId ?? null) && row.sessionFamilyId === (input.sessionFamilyId ?? null) && !row.consumedAt && row.expiresAt > now;
}

/** The wait after the last hit once `free` hits were used, in milliseconds. */
export function backoffWaitMs(hits: number, rule: Pick<Backoff, "free" | "baseSeconds" | "capSeconds">): number {
  if (hits < rule.free) return 0;
  return Math.min(rule.baseSeconds * 2 ** (hits - rule.free), rule.capSeconds) * 1000;
}

function backoffBlocked(row: { count: number; windowEnd: Date } | null, rule: Backoff, now: Date): boolean {
  if (!row || row.windowEnd <= now) return false;
  const lastHit = row.windowEnd.getTime() - LIMIT_WINDOW_MS;
  return now.getTime() < lastHit + backoffWaitMs(row.count, rule);
}
