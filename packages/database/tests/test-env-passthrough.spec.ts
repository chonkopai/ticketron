import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Regression: turbo's strict env mode drops variables that are not
// declared, so a test gate missing from turbo.json silently disables its suite.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const turbo = JSON.parse(readFileSync(join(root, "turbo.json"), "utf8")) as {
  globalEnv?: string[];
  globalPassThroughEnv?: string[];
  tasks: Record<string, { env?: string[]; passThroughEnv?: string[] }>;
};
const declared = new Set([
  ...(turbo.globalEnv ?? []),
  ...(turbo.globalPassThroughEnv ?? []),
  ...(turbo.tasks.test?.env ?? []),
  ...(turbo.tasks.test?.passThroughEnv ?? []),
]);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "generated") return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sources(path) : /\.(ts|mjs)$/.test(entry.name) ? [path] : [];
  });
}

const gatePattern = /\b([A-Z][A-Z0-9_]*(?:_DB_TEST|DATABASE_TESTS?|_TEST_DATABASE_URL))\b/g;

describe("turbo test env passthrough", () => {
  it("declares every DB test gate and the test env selectors for the test task", () => {
    const gates = new Set<string>();
    for (const dir of ["apps/api/src", "apps/bot/src", "packages/database/tests"]) {
      for (const file of sources(join(root, dir))) for (const match of readFileSync(file, "utf8").matchAll(gatePattern)) gates.add(match[1]!);
    }
    for (const name of ["ENV_FILE", "TEST_DATABASE_URL", "REQUIRE_DB_TESTS", "CI"]) gates.add(name);
    expect(gates.size).toBeGreaterThan(10);
    expect([...gates].filter((name) => !declared.has(name)).sort()).toEqual([]);
  });
});
