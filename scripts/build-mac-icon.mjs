import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") throw new Error("ICNS generation requires macOS sips and iconutil");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "assets/icons/Gemini_Generated_Image_a9ydkya9ydkya9yd.jpeg");
const build = path.join(root, "build");
mkdirSync(build, { recursive: true });
const temporary = mkdtempSync(path.join(build, "mac-icon-"));
const iconset = path.join(temporary, "netnavr.iconset");
mkdirSync(iconset);
try {
  // Preserve the complete selected artwork, including its existing background.
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const filename = `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`;
      execFileSync("/usr/bin/sips", ["-s", "format", "png", "-z", String(size * scale), String(size * scale), source, "--out", path.join(iconset, filename)], { stdio: "pipe" });
    }
  }
  execFileSync("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", path.join(root, "assets/icons/netnavr.icns")], { stdio: "inherit" });
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
