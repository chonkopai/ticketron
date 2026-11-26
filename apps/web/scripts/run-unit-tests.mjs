// Bundles the web `node:test` specs with the workspace esbuild and runs them with `node --test`.
import { spawnSync } from "node:child_process";
import { globSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const webRoot = fileURLToPath(new URL("../", import.meta.url));
// Inside node_modules so bundled bare imports (`next/server.js`, react, …) resolve from apps/web.
const outdir = join(webRoot, "node_modules/.cache/web-unit-tests");
const filter = process.argv.slice(2);
const entryPoints = globSync("src/**/*.spec.{ts,tsx,mjs}", { cwd: webRoot })
  .filter((path) => filter.length === 0 || filter.some((part) => path.includes(part)))
  .sort()
  .map((path) => join(webRoot, path));
if (entryPoints.length === 0) {
  console.error("No web spec files found");
  process.exit(1);
}

rmSync(outdir, { recursive: true, force: true });
await build({
  entryPoints,
  outdir,
  outbase: join(webRoot, "src"),
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  jsx: "automatic",
  outExtension: { ".js": ".mjs" },
  loader: { ".css": "empty" },
  logLevel: "error",
  plugins: [{
    name: "next-node-extensions",
    setup(builder) {
      builder.onResolve({ filter: /^next\/(link|server|navigation|headers|image)$/ },
        (args) => ({ path: `${args.path}.js`, external: true }));
    },
  }],
});

const bundles = entryPoints.map((path) => join(outdir, relative(join(webRoot, "src"), path).replace(/\.(ts|tsx|mjs)$/, ".mjs")));
console.log(`Bundled ${bundles.length} web spec files; running node --test`);
// Specs read fixtures by repo-root-relative paths (apps/web/src/...), as the original runner assumed.
const result = spawnSync(process.execPath, ["--test", ...bundles], { cwd: join(webRoot, "../.."), stdio: "inherit" });
process.exit(result.status ?? 1);
