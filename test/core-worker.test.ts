import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { CORE_VERSION } from "@netnavr/core";
import { FixtureClient } from "../apps/desktop/src/fixture-bridge.ts";

test("bundled Core worker retains its Core version and isolated fixture across restart", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "netnavr-worker-test-")));
  const dataDirectory = join(directory, "fixture-v1");
  let stop: (() => Promise<void>) | undefined;
  try {
    const first = await launch(dataDirectory);
    stop = first.stop;
    const client = new FixtureClient(first.origin, first.token);
    const health = await fetch(`${first.origin}/v1/health`).then((response) => response.json()) as { version: string };
    assert.equal(health.version, CORE_VERSION);
    const state = await client.state();
    assert.equal(state.ok, true);
    if (!state.ok) throw new Error("No initial state");
    const commandId = `cmd_${randomUUID()}`;
    assert.equal((await client.submit({ commandId, operation: "set-marker", marker: "alpha" })).ok, true);
    for (let attempt = 0; attempt < 30; attempt++) {
      const result = await client.read(commandId);
      if (result.ok && result.value.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const written = await client.state();
    assert.equal(written.ok, true);
    if (written.ok) assert.equal(written.value.marker, "alpha");
    await stop(); stop = undefined;
    const second = await launch(dataDirectory);
    stop = second.stop;
    const secondClient = new FixtureClient(second.origin, second.token);
    const restarted = await secondClient.state();
    assert.equal(restarted.ok, true);
    if (restarted.ok) {
      assert.equal(restarted.value.marker, "alpha");
      assert.equal(restarted.value.revision, 1);
      assert.notEqual(restarted.value.fixtureSessionId, state.value.fixtureSessionId);
    }
    assert.equal((await secondClient.read(commandId)).ok, false);
    assert.equal((await new FixtureClient(second.origin, first.token).state()).ok, false);
  } finally { await stop?.(); await rm(directory, { recursive: true, force: true }); }
});

test("real fork cancellation waits for its owned worker to exit before rejection", async () => {
  // CI observed a Node 24.19 native callback-scope abort on Linux/macOS during
  // this immediate fork/kill sequence inside node:test. Keep the lifecycle in an
  // ordinary Node process; any native abort or missing exit still fails here.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [
    "--import=tsx", fileURLToPath(new URL("./harness/real-core-cancellation.mjs", import.meta.url)),
  ], { env, timeout: 12000, maxBuffer: 64 * 1024, encoding: "utf8" });
  assert.equal(stderr, "");
  const result = JSON.parse(stdout);
  assert.equal(result.scenario, "real-core-startup-cancellation");
  assert.equal(result.workerCreated, true);
  assert.equal(result.abortBeforeReady, true);
  assert.equal(result.actualExitBeforeRejection, true);
  assert.equal(result.rejectedAfterConfirmedExit, true);
  assert.equal(result.workerClosed, true);
  assert.ok(result.workerExitCode === 0 || result.workerExitSignal === "SIGTERM");
});

async function launch(dataDirectory: string) {
  const token = randomBytes(32).toString("base64url");
  const child = fork(new URL("../apps/desktop/dist/core-worker.cjs", import.meta.url), [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const origin = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("worker startup timeout")); }, 5000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`worker exit ${code}`)); });
    child.on("message", (message: unknown) => {
      if (message && typeof message === "object" && "type" in message && message.type === "ready" && "origin" in message && typeof message.origin === "string") {
        clearTimeout(timer); resolve(message.origin);
      }
    });
    child.send({ type: "start", token, dataDirectory });
  });
  return { origin, token, stop: () => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("worker shutdown timeout")); }, 5000);
    child.once("exit", (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error("worker shutdown failed")); });
    child.send({ type: "stop" });
  }) };
}
