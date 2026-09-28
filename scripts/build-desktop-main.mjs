import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DESKTOP_BUNDLE_OPTIONS, DESKTOP_ENTRY_FILES } from "./lib/desktop-runtime.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

await build({
  entryPoints: [path.join(root, "apps/desktop/src/main.ts")],
  outfile: path.join(root, DESKTOP_ENTRY_FILES.main),
  ...DESKTOP_BUNDLE_OPTIONS,
  logLevel: "info"
});

await build({
  entryPoints: [path.join(root, "apps/desktop/src/preload.ts")],
  outfile: path.join(root, DESKTOP_ENTRY_FILES.preload),
  ...DESKTOP_BUNDLE_OPTIONS,
  logLevel: "info"
});

await build({
  entryPoints: [path.join(root, "apps/desktop/src/core-worker.ts")],
  outfile: path.join(root, DESKTOP_ENTRY_FILES.coreWorker),
  ...DESKTOP_BUNDLE_OPTIONS,
  logLevel: "info",
});

await build({
  entryPoints: [path.join(root, "apps/desktop/src/runtime-check.ts")],
  outfile: path.join(root, "apps/desktop/dist/runtime-check.cjs"),
  ...DESKTOP_BUNDLE_OPTIONS,
  logLevel: "info",
});
