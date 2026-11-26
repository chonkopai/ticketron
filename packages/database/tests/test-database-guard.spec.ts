import { afterEach, describe, expect, it, vi } from "vitest";

import {
  REFUSAL_ENV_KEY,
  REFUSED_DATABASE_URL,
  assertDisposableDatabase,
  databaseSuiteEnabled,
  disposableDatabaseProblem,
  quarantineNonDisposableDatabase,
} from "../src/test-database-guard.js";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
});

describe("test database guard", () => {
  it.each([
    "postgresql://u:p@127.0.0.1:5432/ticketron_test_1",
    "postgresql://u:p@localhost:55432/ticketron_test_20261125",
    "postgres://u@[::1]:5432/ticketron_audit",
    "postgresql://u@localhost/event_platform_v2_fresh_3",
    "postgresql://u@localhost/ticket_admin_test",
    "postgresql://u@127.0.0.1/telegram_checkout_test",
  ])("accepts disposable local database %s", (url) => {
    expect(disposableDatabaseProblem(url)).toBeNull();
  });

  it.each([
    [undefined, "not set"],
    ["postgresql://u:p@localhost:5432/event_platform", "does not match"],
    ["postgresql://u:p@localhost:5432/ticketron_test_", "does not match"],
    ["postgresql://u:p@localhost:5432/ticketron_test_1_prod", "does not match"],
    ["postgresql://u:p@db.example.com:5432/ticketron_test_1", "not localhost"],
    ["mysql://u@localhost/ticketron_test_1", "not PostgreSQL"],
  ])("refuses %s", (url, reason) => {
    expect(disposableDatabaseProblem(url)).toContain(reason);
  });

  it("never echoes credentials in the refusal", () => {
    expect(() => assertDisposableDatabase("suite", "postgresql://admin:hunter2@localhost/event_platform")).toThrow(/Refusing to run DB-backed suite "suite"/);
    try { assertDisposableDatabase("suite", "postgresql://admin:hunter2@localhost/event_platform"); } catch (error) {
      expect(String(error)).not.toContain("hunter2");
    }
  });

  it("quarantines a dev DATABASE_URL so unguarded clients cannot reach it", () => {
    const env: NodeJS.ProcessEnv = { DATABASE_URL: "postgresql://u:p@localhost:5432/event_platform" };
    expect(quarantineNonDisposableDatabase(env)).toContain("event_platform");
    expect(env.DATABASE_URL).toBe(REFUSED_DATABASE_URL);
    expect(env[REFUSAL_ENV_KEY]).toContain("event_platform");
    const disposable: NodeJS.ProcessEnv = { DATABASE_URL: "postgresql://u@127.0.0.1/ticketron_test_7" };
    expect(quarantineNonDisposableDatabase(disposable)).toBeNull();
    expect(disposable.DATABASE_URL).toBe("postgresql://u@127.0.0.1/ticketron_test_7");
  });

  it("skips a disabled gated suite loudly, and fails it under REQUIRE_DB_TESTS", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    delete process.env.DEMO_SUITE_GATE;
    delete process.env.REQUIRE_DB_TESTS;
    expect(databaseSuiteEnabled("demo", "DEMO_SUITE_GATE")).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('SKIPPED DB suite "demo"'));
    process.env.REQUIRE_DB_TESTS = "true";
    expect(() => databaseSuiteEnabled("demo", "DEMO_SUITE_GATE")).toThrow(/REQUIRE_DB_TESTS/);
  });

  it("refuses an enabled gated suite on a non-disposable database", () => {
    process.env.DEMO_SUITE_GATE = "true";
    process.env.DATABASE_URL = "postgresql://u@localhost/event_platform";
    expect(() => databaseSuiteEnabled("demo", "DEMO_SUITE_GATE")).toThrow(/Refusing/);
    process.env.DATABASE_URL = "postgresql://u@localhost/ticketron_test_2";
    expect(databaseSuiteEnabled("demo", "DEMO_SUITE_GATE")).toBe(true);
    process.env.URL_GATE = "postgresql://u@remote.example/ticketron_test_2";
    expect(() => databaseSuiteEnabled("demo", "URL_GATE", { urlFlag: true })).toThrow(/not localhost/);
  });
});
