import { databaseSuiteEnabled } from "@event-platform/database/test-database-guard";
import { createHmac, randomUUID } from "node:crypto";

import { createPrismaClient, type PrismaClient } from "@event-platform/database";
import { BadRequestException, Logger, ServiceUnavailableException } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { VerificationService } from "./verification.service.js";
import { ResendVerificationSender, type VerificationMessage, type VerificationSender } from "./verification-sender.js";

describe("Resend verification adapter", () => {
  it("stays unavailable without credentials and redacts provider failures", async () => {
    const sender = new ResendVerificationSender();
    expect(sender.available("email")).toBe(false);
    expect(sender.available("phone")).toBe(false);
    await expect(sender.send({ method: "email", target: "a@example.com", code: "123456", idempotencyKey: "otp/test" })).rejects.toBeInstanceOf(ServiceUnavailableException);
    const fetchMock = vi.fn(async (_url: string, _options: RequestInit) => ({ ok: false }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const configured = new ResendVerificationSender("re_testsecret", "tickets@mail.example.test");
      await expect(configured.send({ method: "email", target: "a@example.com", code: "123456", idempotencyKey: "otp/test" })).rejects.toMatchObject({ response: { code: "VERIFICATION_SEND_FAILED" } });
      const request = fetchMock.mock.calls[0];
      expect(request?.[0]).toBe("https://api.resend.com/emails");
      expect(request?.[1]?.headers).toMatchObject({ "Idempotency-Key": "otp/test" });
    } finally { vi.unstubAllGlobals(); }
  });
});

const testUrl = process.env.VERIFICATION_TEST_DATABASE_URL;
const integration = databaseSuiteEnabled("verification challenge", "VERIFICATION_TEST_DATABASE_URL", { urlFlag: true }) ? describe : describe.skip;

integration("verification challenge with isolated PostgreSQL", () => {
  let db: PrismaClient;
  let service: VerificationService;
  const messages: VerificationMessage[] = [];
  const sender: VerificationSender = { available: method => method === "email", send: async message => { messages.push(message); } };

  beforeAll(() => {
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = testUrl;
    db = createPrismaClient();
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
    service = new VerificationService(db, { hmacSecret: "test-only-verification-hmac-secret-long-enough" }, sender);
  });
  afterAll(async () => { await db?.$disconnect(); });

  it("binds proof to purpose and target, commits wrong attempts, and prevents grant replay", async () => {
    const target = `${randomUUID()}@example.com`;
    const request = { purpose: "register" as const, method: "email" as const, target, clientKey: randomUUID() };
    const issued = await service.issue(request);
    const message = messages.at(-1)!;
    const persisted = await db.verificationChallenge.findUniqueOrThrow({ where: { id: issued.challengeId } });
    expect(persisted.secretVerifier).not.toContain(message.code);
    await expect(service.verify({ ...request, purpose: "checkout_email", challengeId: issued.challengeId, code: message.code })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.verify({ ...request, challengeId: issued.challengeId, code: "000000" === message.code ? "000001" : "000000" })).rejects.toBeInstanceOf(BadRequestException);
    expect((await db.verificationChallenge.findUniqueOrThrow({ where: { id: issued.challengeId } })).failedAttempts).toBe(1);
    const proof = await service.verify({ ...request, challengeId: issued.challengeId, code: message.code });
    await expect(db.$transaction(tx => service.claimGrant(tx, { ...request, purpose: "link", grant: proof.grant }))).rejects.toBeInstanceOf(BadRequestException);
    await db.$transaction(tx => service.claimGrant(tx, { ...request, grant: proof.grant }));
    await expect(db.$transaction(tx => service.claimGrant(tx, { ...request, grant: proof.grant }))).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.verify({ ...request, challengeId: issued.challengeId, code: message.code })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("invalidates an older generation and accepts only one concurrent verification", async () => {
    const target = `${randomUUID()}@example.com`;
    const request = { purpose: "register" as const, method: "email" as const, target, clientKey: randomUUID() };
    const first = await service.issue(request);
    const oldCode = messages.at(-1)!.code;
    await db.verificationChallenge.update({ where: { id: first.challengeId }, data: { lastSentAt: new Date(Date.now() - 61_000) } });
    const second = await service.issue(request);
    const newCode = messages.at(-1)!.code;
    await expect(service.verify({ ...request, challengeId: first.challengeId, code: oldCode })).rejects.toBeInstanceOf(BadRequestException);
    const outcomes = await Promise.allSettled([
      service.verify({ ...request, challengeId: second.challengeId, code: newCode }),
      service.verify({ ...request, challengeId: second.challengeId, code: newCode }),
    ]);
    expect(outcomes.filter(x => x.status === "fulfilled")).toHaveLength(1);
  });

  it("rejects expired codes and an unconfigured phone provider", async () => {
    const target = `${randomUUID()}@example.com`;
    const request = { purpose: "register" as const, method: "email" as const, target, clientKey: randomUUID() };
    const issued = await service.issue(request);
    const code = messages.at(-1)!.code;
    await db.verificationChallenge.update({ where: { id: issued.challengeId }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    await expect(service.verify({ ...request, challengeId: issued.challengeId, code })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.issue({ purpose: "register", method: "phone", target: "+12025550123", clientKey: randomUUID() })).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("locks after five wrong codes and enforces a shared target send budget", async () => {
    const target = `${randomUUID()}@example.com`;
    const request = { purpose: "register" as const, method: "email" as const, target, clientKey: randomUUID() };
    const first = await service.issue(request);
    const correct = messages.at(-1)!.code;
    const wrong = correct === "000000" ? "000001" : "000000";
    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(service.verify({ ...request, challengeId: first.challengeId, code: wrong })).rejects.toBeInstanceOf(BadRequestException);
    }
    expect((await db.verificationChallenge.findUniqueOrThrow({ where: { id: first.challengeId } })).failedAttempts).toBe(5);
    await expect(service.verify({ ...request, challengeId: first.challengeId, code: correct })).rejects.toBeInstanceOf(BadRequestException);
    for (let requestNumber = 1; requestNumber < 5; requestNumber++) {
      const last = await db.verificationChallenge.findFirstOrThrow({ where: { purpose: "register", method: "email", normalizedTarget: target }, orderBy: { createdAt: "desc" } });
      await db.verificationChallenge.update({ where: { id: last.id }, data: { lastSentAt: new Date(Date.now() - 61_000) } });
      await service.issue(request);
    }
    await expect(service.issue(request)).rejects.toMatchObject({ status: 429 });
  });

  it("survives a service restart and closes a challenge when sending fails", async () => {
    const target = `${randomUUID()}@example.com`;
    const request = { purpose: "register" as const, method: "email" as const, target, clientKey: randomUUID() };
    const issued = await service.issue(request);
    const code = messages.at(-1)!.code;
    const restarted = new VerificationService(db, { hmacSecret: "test-only-verification-hmac-secret-long-enough" }, sender);
    await expect(restarted.verify({ ...request, challengeId: issued.challengeId, code })).resolves.toHaveProperty("grant");

    const failingTarget = `${randomUUID()}@example.com`;
    const failing = new VerificationService(db, { hmacSecret: "test-only-verification-hmac-secret-long-enough" }, {
      available: () => true,
      send: async () => { throw new Error("private provider payload"); },
    });
    await expect(failing.issue({ ...request, target: failingTarget })).rejects.toMatchObject({ response: { code: "VERIFICATION_SEND_FAILED" } });
    const closed = await db.verificationChallenge.findFirstOrThrow({ where: { normalizedTarget: failingTarget }, orderBy: { createdAt: "desc" } });
    expect(closed.consumedAt).not.toBeNull();
  });
  // Bucket keys as VerificationService stores them, so a test can move a bucket's last hit into the past.
  const bucket = (label: string, value: string) => `${label}:${createHmac("sha256", "test-only-verification-hmac-secret-long-enough").update(value).digest("hex")}`;
  const age = async (scopeKey: string, minutes: number) => {
    const row = await db.verificationRateLimit.findUniqueOrThrow({ where: { scopeKey } });
    await db.verificationRateLimit.update({ where: { scopeKey }, data: { windowEnd: new Date(row.windowEnd.getTime() - minutes * 60_000) } });
  };

  it("limits anonymous code requests per browser, not per shared client address", async () => {
    const clientKey = randomUUID(), browserA = `browser:${randomUUID()}`, browserB = `browser:${randomUUID()}`;
    const request = (actorKey: string) => service.issue({ purpose: "register", method: "email", target: `${randomUUID()}@example.com`, clientKey, actorKey });
    for (let sent = 0; sent < 10; sent++) await request(browserA);
    await expect(request(browserA)).rejects.toMatchObject({ status: 429 });
    // A second browser behind the same address is not blocked by the first browser's actor bucket.
    await expect(request(browserB)).resolves.toHaveProperty("challengeId");
  });

  it("signs the per-browser actor cookie and rejects forged values", () => {
    const fresh = service.browserActor(undefined);
    expect(fresh.setCookie).toMatch(/^ticket_auth_browser=[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]+; Path=\/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=\d+$/);
    const cookie = fresh.setCookie!.split(";")[0]!;
    expect(service.browserActor(`other=1; ${cookie}`)).toEqual({ key: fresh.key });
    const forged = service.browserActor(`${cookie.slice(0, -2)}xx`);
    expect(forged.setCookie).toBeDefined();
    expect(forged.key).not.toBe(fresh.key);
  });

  it("slows a targeted password-login flood down instead of locking the victim out for an hour", async () => {
    const victim = `${randomUUID()}@example.com`;
    for (let attacker = 0; attacker < 20; attacker++) {
      await service.enforceCredentialLimit("email", victim, `attacker-${attacker}-${randomUUID()}`);
      await service.recordCredentialFailure("email", victim, `attacker-${attacker}-${randomUUID()}`);
    }
    const victimClient = randomUUID();
    await expect(service.enforceCredentialLimit("email", victim, victimClient)).rejects.toMatchObject({ status: 429 });
    // Rejected calls during the wait do not extend it.
    for (let flood = 0; flood < 30; flood++) await expect(service.enforceCredentialLimit("email", victim, `flood-${flood}`)).rejects.toMatchObject({ status: 429 });
    await age(bucket("login-target", `email:${victim}`), 6);
    await expect(service.enforceCredentialLimit("email", victim, victimClient)).resolves.toBeUndefined();
  });

  it("blocks repeated password failures from one client without blocking other clients", async () => {
    const target = `${randomUUID()}@example.com`, attacker = randomUUID();
    for (let attempt = 0; attempt < 10; attempt++) {
      await service.enforceCredentialLimit("email", target, attacker);
      await service.recordCredentialFailure("email", target, attacker);
    }
    await expect(service.enforceCredentialLimit("email", target, attacker)).rejects.toMatchObject({ status: 429 });
    await expect(service.enforceCredentialLimit("email", target, randomUUID())).resolves.toBeUndefined();
    await service.clearCredentialFailures("email", target, attacker);
    await expect(service.enforceCredentialLimit("email", target, attacker)).resolves.toBeUndefined();
  });

  it("recovers a target's code requests within minutes after a send flood", async () => {
    const target = `${randomUUID()}@example.com`;
    // Separate checkout sessions skip the per-challenge resend cooldown, so only the target bucket applies.
    const request = () => service.issue({ purpose: "checkout_email", method: "email", target, sessionFamilyId: randomUUID(), clientKey: randomUUID() });
    for (let sent = 0; sent < 5; sent++) await request();
    await expect(request()).rejects.toMatchObject({ status: 429 });
    await age(bucket("target", `email:${target}`), 2);
    await expect(request()).resolves.toHaveProperty("challengeId");
  });

  it("logs once when the global send cap is reached", async () => {
    const global = bucket("global", "send");
    await db.verificationRateLimit.upsert({ where: { scopeKey: global }, create: { scopeKey: global, count: 1000, windowEnd: new Date(Date.now() + 60 * 60_000) }, update: { count: 1000, windowEnd: new Date(Date.now() + 60 * 60_000) } });
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      for (let attempt = 0; attempt < 2; attempt++) await expect(service.issue({ purpose: "register", method: "email", target: `${randomUUID()}@example.com`, clientKey: randomUUID(), actorKey: randomUUID() })).rejects.toMatchObject({ status: 429 });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("Global OTP send cap");
    } finally {
      warn.mockRestore();
      await db.verificationRateLimit.delete({ where: { scopeKey: global } });
    }
  });
});
