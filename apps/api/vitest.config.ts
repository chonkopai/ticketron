import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

import { quarantineNonDisposableDatabase } from "@event-platform/database/test-database-guard";
import { defineConfig } from "vitest/config";

// CI and explicit test-DB runs never fall back to the developer's root `.env`.
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const explicitTestEnvironment = Boolean(process.env.CI || process.env.TEST_DATABASE_URL);
const envPath = process.env.ENV_FILE ?? (explicitTestEnvironment ? undefined : fileURLToPath(new URL("../../.env", import.meta.url)));
if (process.env.ENV_FILE && !existsSync(process.env.ENV_FILE)) throw new Error(`ENV_FILE does not exist: ${process.env.ENV_FILE}`);
if (envPath && existsSync(envPath)) loadEnvFile(envPath);

// Workers inherit this env: a non-disposable DATABASE_URL is replaced by an unreachable one.
const refusal = quarantineNonDisposableDatabase();
if (refusal) console.warn(`\n⚠️  [test-db-guard] ${refusal}; DB-backed suites will refuse to run.\n`);

export default defineConfig({
  test: {
    environment: "node",
    // API integration specs share one local PostgreSQL database; serialize files
    // so global fixture assertions cannot race with another suite's cleanup.
    fileParallelism: false,
    include: ["src/**/*.spec.{ts,mjs}"],
    // Empties the (guard-approved) disposable DB before each file; no-op otherwise.
    setupFiles: ["./src/test-support/reset-test-database.setup.ts"],
  },
});
