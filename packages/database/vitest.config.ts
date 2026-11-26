import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";
import { defineConfig } from "vitest/config";

import { quarantineNonDisposableDatabase } from "./src/test-database-guard.js";

// CI and explicit test-DB runs never fall back to the developer's root `.env`.
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const explicitTestEnvironment = Boolean(process.env.CI || process.env.TEST_DATABASE_URL);
if (process.env.ENV_FILE && !existsSync(process.env.ENV_FILE)) throw new Error(`ENV_FILE does not exist: ${process.env.ENV_FILE}`);
const envPath = process.env.ENV_FILE ?? (explicitTestEnvironment ? undefined : fileURLToPath(new URL("../../.env", import.meta.url)));
if (envPath) loadDotenv({ path: envPath, override: false, quiet: true });

const refusal = quarantineNonDisposableDatabase();
if (refusal) console.warn(`\n⚠️  [test-db-guard] ${refusal}; DB-backed suites will refuse to run.\n`);

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.spec.ts"],
    testTimeout: 10_000,
  },
});
