// Adapted from T3 Tools Inc., MIT licensed.
// Source: de251fc2971a884cb5b1305ba4daf309dc8cccb0
// apps/desktop/vite.config.ts and scripts/lib/desktop-external-packages.ts.
// Keep bundle external policy and artifact file policy together. NetNavr does
// not enable T3's cloud/native/IDE packages. Core is bundled into its own worker.
export function isDesktopRuntimeExternal(id) {
  return id === "electron" || id.startsWith("electron/") || id.startsWith("node:");
}
export const DESKTOP_ENTRY_FILES = Object.freeze({
  main: "apps/desktop/dist/main.cjs",
  preload: "apps/desktop/dist/preload.cjs",
  coreWorker: "apps/desktop/dist/core-worker.cjs",
});

export const DESKTOP_BUNDLE_OPTIONS = Object.freeze({
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  sourcemap: true,
  plugins: [{ name: "desktop-runtime-boundary", setup(build) {
    build.onResolve({ filter: /^(electron(?:\/|$)|node:)/ }, (args) => ({ path: args.path, external: true }));
  } }],
});
