import { spawn } from "node:child_process";

// Browser-only product 0.1 review. Do not silently enable the retained coding
// server, inherited provider configuration or renderer credentials.
if (!process.env.npm_execpath) throw new Error("Start the review using npm run dev");
const child = spawn(process.execPath, [process.env.npm_execpath, "run", "dev", "-w", "@netnavr/shell-web"], {
  stdio: "inherit", windowsHide: true,
});
child.on("exit", (code) => { process.exitCode = code ?? 1; });
child.on("error", () => { console.error("Browser review could not start"); process.exitCode = 1; });
