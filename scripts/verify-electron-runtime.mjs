import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import electron from "electron";

const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [fileURLToPath(new URL("../apps/desktop/dist/runtime-check.cjs", import.meta.url))], {
  env: environment, stdio: "inherit", windowsHide: true,
});
const deadline = setTimeout(() => { child.kill(); process.exitCode = 1; }, 30_000);
child.on("error", () => { clearTimeout(deadline); console.error("Electron runtime check could not launch"); process.exitCode = 1; });
child.on("exit", (code) => { clearTimeout(deadline); process.exitCode = code ?? 1; });
