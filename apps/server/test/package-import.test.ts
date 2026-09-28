import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";

test("importing server package exits normally without opening a listener", async () => {
  const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import=tsx", "--input-type=module", "-e", "await import('./src/index.ts');"], { cwd: new URL("..", import.meta.url), stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const deadline = setTimeout(() => { child.kill(); reject(new Error("import kept a server listener alive")); }, 5000);
    child.stderr.on("data", (data) => { stderr += String(data).slice(0, 2048); });
    child.once("error", reject);
    child.once("exit", (code) => { clearTimeout(deadline); resolve({ code, stderr }); });
  });
  assert.equal(result.code, 0, result.stderr);
});
