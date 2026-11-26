import { ExpressAdapter } from "@nestjs/platform-express";
import { describe, expect, it } from "vitest";
import { IdentityAuthController } from "./auth/identity.controller.js";
import type { IdentityAuthService } from "./auth/identity-auth.service.js";
import type { VerificationService } from "./auth/verification.service.js";
import { BookingController } from "./booking/booking.controller.js";
import type { BookingService } from "./booking/booking.service.js";
import { CreationDraftsController, draftContext } from "./creation-drafts/creation-drafts.controller.js";
import type { CreationDraftsService } from "./creation-drafts/creation-drafts.service.js";
import type { AuthService } from "./auth/auth.service.js";
import { AnonymousController } from "./orders/anonymous.controller.js";
import type { AnonymousService } from "./orders/anonymous.service.js";
import { configureHttpProxy } from "./http-proxy.js";

const WEB_CONTAINER = "172.20.0.3";
const CADDY = "172.20.0.2";

/** A request that runs Express's real `req.ip` getter behind Caddy → Next (2 trusted hops). */
function proxied(forwardedFor: string, headers: Record<string, string> = {}) {
  const app = new ExpressAdapter().getInstance();
  configureHttpProxy(app, 2);
  return Object.assign(Object.create(app.request), {
    app, socket: { remoteAddress: WEB_CONTAINER },
    headers: { "x-forwarded-for": forwardedFor, ...headers },
    method: "POST", url: "/",
  });
}

/** Counts calls per client key, like the DB buckets in VerificationService. */
function buckets() {
  const counts = new Map<string, number>();
  return { counts, hit(key: string) { counts.set(key, (counts.get(key) ?? 0) + 1); } };
}

const response = { setHeader() {} };
const A = "203.0.113.8", B = "203.0.113.9";

describe("client address behind the trusted proxy chain", () => {
  it("gives auth OTP and password-login requests one bucket per real client", async () => {
    const seen = buckets();
    const record = (input: { clientKey: string }) => { seen.hit(input.clientKey); return Promise.resolve({} as never); };
    const controller = new IdentityAuthController({ registerRequest: record, registerVerify: record, login: record, requestPasswordReset: record, verifyPasswordReset: record, browserActor: () => ({ key: "browser:test" }) } as unknown as IdentityAuthService);
    const contact = { method: "email" as const, target: "user@example.com" };
    await controller.registerRequest(contact, proxied(`${A}, ${CADDY}`), response);
    await controller.passwordLogin({ ...contact, password: "x".repeat(12) }, proxied(`${A}, ${CADDY}`));
    // A forged leading entry is to the left of the trusted hops and must not create a new bucket.
    await controller.passwordResetRequest(contact, proxied(`198.51.100.99, ${A}, ${CADDY}`), response);
    await controller.registerRequest(contact, proxied(`${B}, ${CADDY}`), response);
    expect(Object.fromEntries(seen.counts)).toEqual({ [A]: 3, [B]: 1 });
  });

  it("keys guest and signed-in checkout email verification by the real client", async () => {
    const seen = buckets();
    const quick = new AnonymousController({ requestEmail: (_raw: string, _address: string, clientKey: string) => seen.hit(clientKey), verifyEmail: (_raw: string, _a: string, _c: string, _code: string, clientKey: string) => seen.hit(clientKey) } as unknown as AnonymousService, {} as never, {} as never, {} as never);
    const bearer = `Bearer ${"a".repeat(43)}`;
    quick.requestEmail(bearer, { address: "guest@example.com" }, proxied(`${A}, ${CADDY}`));
    quick.verifyEmail(bearer, { address: "guest@example.com", challengeId: "00000000-0000-4000-8000-000000000001", code: "123456" }, proxied(`198.51.100.7, ${A}, ${CADDY}`));
    const booking = new BookingController({} as BookingService, { issue: (input: { clientKey: string }) => seen.hit(input.clientKey), verify: (input: { clientKey: string }) => seen.hit(input.clientKey) } as unknown as VerificationService);
    const user = { userId: "u1", role: "guest", sessionFamilyId: "f1" } as never;
    booking.requestEmail(user, { address: "buyer@example.com" } as never, proxied(`${B}, ${CADDY}`));
    booking.verifyEmail(user, { address: "buyer@example.com", challengeId: "c", code: "123456" } as never, proxied(`${B}, ${CADDY}`));
    expect(Object.fromEntries(seen.counts)).toEqual({ [A]: 2, [B]: 2 });
  });

  it("keys the anonymous draft network quota by the real client", async () => {
    const scopes: string[] = [];
    const config = { webOrigin: "https://site.example", hmacSecret: "test-only-draft-secret", anonymousSeconds: 60, creationHourlyLimit: 20 };
    const drafts = {
      config,
      quota: async (scope: string) => { scopes.push(scope); },
      create: async () => ({ draft: { id: "00000000-0000-4000-8000-000000000001" }, capability: "cap" }),
    } as unknown as CreationDraftsService;
    const headers = { origin: config.webOrigin, "content-type": "application/json" };
    const controller = new CreationDraftsController(drafts, {} as AuthService);
    await controller.create({ sourceLocale: "ru" }, proxied(`${A}, ${CADDY}`, headers), response);
    await controller.create({ sourceLocale: "ru" }, proxied(`198.51.100.1, ${B}, ${CADDY}`, headers), response);
    expect(scopes).toEqual([`network:${A}`, `network:${B}`]);
    const access = await draftContext(drafts, {} as AuthService, "id", proxied(`${A}, ${CADDY}`, headers));
    expect(access.quotaScope).toBe(`network:${A}`);
  });
});
