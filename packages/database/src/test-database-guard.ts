/**
 * Shared guard for every DB-backed test suite. Tests may only touch a local,
 * explicitly disposable PostgreSQL database; anything else (the dev database
 * from the root `.env`, a remote host) is refused.
 *
 * This module has no Prisma import, so importing it never opens a connection.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Disposable database names. `ticketron_test_<digits>` is the generic pattern;
 * the others are kept for the existing regression, V2 rehearsal, staff and Telegram
 * suites so their documented setups keep working.
 */
export const DISPOSABLE_DATABASE_NAME =
  /^(ticketron_test_\d+|ticketron_audit|event_platform_v2_(fresh|legacy)_\d+|ticket_admin_test\w*|telegram_checkout_test\w*)$/;

/** Unreachable URL substituted for a refused DATABASE_URL so no client can connect by accident. */
export const REFUSED_DATABASE_URL = "postgresql://refused:refused@127.0.0.1:1/refused_non_disposable_database";

/** Env key carrying the refusal reason from the vitest config into test workers. */
export const REFUSAL_ENV_KEY = "TEST_DATABASE_GUARD_REFUSAL";

/** Returns why `url` is not a disposable test database, or null when it is. Never echoes credentials. */
export function disposableDatabaseProblem(url: string | undefined): string | null {
  if (!url) return "DATABASE_URL is not set";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "DATABASE_URL is not a valid URL";
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) return `DATABASE_URL protocol ${parsed.protocol} is not PostgreSQL`;
  if (!LOCAL_HOSTS.has(parsed.hostname)) return `database host "${parsed.hostname}" is not localhost`;
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!DISPOSABLE_DATABASE_NAME.test(name)) {
    return `database "${name}" does not match the disposable pattern (e.g. ticketron_test_<digits>)`;
  }
  return null;
}

export function refusalMessage(suite: string, problem: string): string {
  return (
    `[test-db-guard] Refusing to run DB-backed suite "${suite}": ${problem}. ` +
    "DB tests only run against a local disposable PostgreSQL database named like ticketron_test_<digits>. " +
    "Provide it with ENV_FILE=/path/to/test.env or TEST_DATABASE_URL=postgresql://…@127.0.0.1:5432/ticketron_test_1."
  );
}

/** Throws unless `url` is a disposable local test database. */
export function assertDisposableDatabase(suite: string, url: string | undefined = process.env.DATABASE_URL): void {
  const problem = process.env[REFUSAL_ENV_KEY] && url === REFUSED_DATABASE_URL ? process.env[REFUSAL_ENV_KEY] : disposableDatabaseProblem(url);
  if (problem) throw new Error(refusalMessage(suite, problem));
}

/**
 * For the vitest config: if DATABASE_URL is not disposable, replace it with an
 * unreachable URL (so an unguarded suite cannot reach the dev DB) and record the reason.
 */
export function quarantineNonDisposableDatabase(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.DATABASE_URL === REFUSED_DATABASE_URL) return env[REFUSAL_ENV_KEY] ?? null;
  const problem = disposableDatabaseProblem(env.DATABASE_URL);
  if (!problem) {
    delete env[REFUSAL_ENV_KEY];
    return null;
  }
  env[REFUSAL_ENV_KEY] = problem;
  env.DATABASE_URL = REFUSED_DATABASE_URL;
  return problem;
}

/**
 * Gate for opt-in DB suites. Returns true when `flag` is enabled (and asserts the
 * DB is disposable). When disabled it prints a visible warning, or throws when
 * REQUIRE_DB_TESTS=true so CI cannot pass with silently skipped suites.
 * `flag` is either an env var that must equal "true", or (urlFlag) an env var holding a DB URL.
 */
export function databaseSuiteEnabled(
  suite: string,
  flag: string,
  options: { url?: string | undefined; urlFlag?: boolean } = {},
): boolean {
  const value = process.env[flag];
  const enabled = options.urlFlag ? Boolean(value) : value === "true";
  if (enabled) {
    assertDisposableDatabase(suite, options.url ?? (options.urlFlag ? value : process.env.DATABASE_URL));
    return true;
  }
  const hint = options.urlFlag ? `${flag}=<disposable database URL>` : `${flag}=true`;
  if (process.env.REQUIRE_DB_TESTS === "true") {
    throw new Error(`[test-db-guard] REQUIRE_DB_TESTS=true but DB suite "${suite}" is disabled; set ${hint}.`);
  }
  console.warn(`\n⚠️  [test-db-guard] SKIPPED DB suite "${suite}" (set ${hint} with a disposable database to run it).\n`);
  return false;
}
