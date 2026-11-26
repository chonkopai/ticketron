import { copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const source = new URL("../src/telegram-seats/", import.meta.url);
const output = new URL("../dist/telegram-seats/", import.meta.url);

await build({
  entryPoints: [fileURLToPath(new URL("app.tsx", source))],
  outdir: fileURLToPath(output),
  bundle: true,
  minify: true,
  jsx: "automatic",
  target: ["es2022", "safari15.4"],
  define: { "process.env.NODE_ENV": '"production"' },
});
await copyFile(new URL("index.html", source), new URL("index.html", output));
