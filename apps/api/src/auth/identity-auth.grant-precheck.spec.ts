import { BadRequestException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hashPassword = vi.hoisted(() => vi.fn(async () => "hash"));
vi.mock("./password.js", () => ({ hashPassword, checkPassword: vi.fn(async () => false) }));

const { IdentityAuthService } = await import("./identity-auth.service.js");
const { VerificationService } = await import("./verification.service.js");

/** No grant exists, so every completion must be rejected before Argon2 runs. */
function service() {
  const tx = { verificationGrant: { findUnique: vi.fn(async () => null), updateMany: vi.fn() } };
  const db = { verificationGrant: tx.verificationGrant, $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)) };
  const verification = new VerificationService(db as never, { hmacSecret: "test-only-verification-hmac-secret-long-enough" }, { available: () => true, send: async () => undefined });
  return new IdentityAuthService(db as never, {} as never, verification);
}

describe("grant validation before password hashing", () => {
  beforeEach(() => hashPassword.mockClear());
  const grant = "g".repeat(43);

  it("rejects an unknown registration grant without hashing", async () => {
    await expect(service().registerComplete({ method: "email", target: "a@example.com", grant, firstName: "A", lastName: "B", password: "p".repeat(12) })).rejects.toBeInstanceOf(BadRequestException);
    expect(hashPassword).not.toHaveBeenCalled();
  });

  it("rejects an unknown password-reset grant without hashing", async () => {
    await expect(service().completePasswordReset({ method: "email", target: "a@example.com", grant, newPassword: "p".repeat(12) })).rejects.toBeInstanceOf(BadRequestException);
    expect(hashPassword).not.toHaveBeenCalled();
  });

  it("rejects an unknown link grant without hashing the new password", async () => {
    const principal = { userId: "u1", role: "guest", sessionFamilyId: "f1", authenticatedAt: Math.floor(Date.now() / 1000) } as never;
    await expect(service().completeLink(principal, { method: "email", target: "a@example.com", grant, password: "p".repeat(12) })).rejects.toBeInstanceOf(BadRequestException);
    expect(hashPassword).not.toHaveBeenCalled();
  });
});
