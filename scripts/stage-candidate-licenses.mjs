import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktop = path.join(root, "apps/desktop/dist/licenses");
const web = path.join(root, "apps/web/dist/licenses");
const webRequire = createRequire(path.join(root, "apps/web/package.json"));
await mkdir(desktop, { recursive: true });
await mkdir(web, { recursive: true });
for (const name of ["LICENSE", "NOTICE"]) {
  await copyFile(path.join(root, "node_modules/@netnavr/core", name), path.join(desktop, `netnavr-core.${name}`));
}
for (const name of ["react", "react-dom", "scheduler", "lucide-react"]) {
  await copyFile(path.join(path.dirname(webRequire.resolve(`${name}/package.json`)), "LICENSE"), path.join(web, `${name}.LICENSE`));
}
console.log("Staged pinned Core notices and renderer dependency licenses for the local App build");
