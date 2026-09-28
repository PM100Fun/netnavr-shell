import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchOwnedCoreChild } from "../../apps/desktop/src/owned-core-launcher.ts";

// Deliberately do not import node:test: this exercises the production handshake
// without the test runner's async scope. Native crashes are never caught, and
// the enclosing test requires a normal process exit plus this complete result.
assert.equal(process.env.NODE_TEST_CONTEXT, undefined);
const directory = await realpath(await mkdtemp(join(tmpdir(), "netnavr-worker-cancel-")));
let child;
let childExited = false;
let childClosed = false;
let readyObserved = false;
let actualExitBeforeRejection = false;
let rejectedAfterConfirmedExit = false;
let abortBeforeReady = false;
let workerStderr = "";
let exit;
let closed;
try {
  child = fork(new URL("../../apps/desktop/dist/core-worker.cjs", import.meta.url), [], {
    execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    workerStderr += chunk;
    assert.ok(Buffer.byteLength(workerStderr) <= 64 * 1024, "worker diagnostics exceeded the harness limit");
  });
  assert.ok(Number.isInteger(child.pid) && child.pid > 0, "a real owned worker must be created");
  exit = new Promise((resolve) => child.once("exit", () => { childExited = true; resolve(); }));
  closed = new Promise((resolve) => child.once("close", () => { childClosed = true; resolve(); }));
  const controller = new AbortController();
  const starting = launchOwnedCoreChild({
    onSpawn: (callback) => { child.once("spawn", callback); },
    onMessage: (callback) => {
      child.on("message", (value) => {
        if (value && typeof value === "object" && value.type === "ready") readyObserved = true;
        callback(value);
      });
    },
    onExit: (callback) => { child.once("exit", callback); },
    postMessage: (value) => { child.send(value); },
    kill: () => { child.kill(); },
  }, randomBytes(32).toString("base64url"), join(directory, "fixture-v1"), controller.signal);
  abortBeforeReady = !readyObserved;
  controller.abort();
  assert.equal(abortBeforeReady, true, "cancellation must precede the real worker's ready message");
  await assert.rejects(starting, (error) => {
    actualExitBeforeRejection = childExited;
    assert.equal(childExited, true, "the launcher must observe actual exit before rejecting");
    assert.equal(error.message, "Owned startup failed; exit confirmed");
    rejectedAfterConfirmedExit = true;
    return true;
  });
  await closed;
  assert.ok(child.exitCode === 0 || child.signalCode === "SIGTERM", `unexpected worker termination: ${workerStderr}`);
  assert.doesNotMatch(workerStderr, /Assertion failed|Native stack trace/i, "a native worker assertion must fail the test");
} finally {
  if (child && !childExited) {
    child.kill();
    await exit;
  }
  await closed;
  await rm(directory, { recursive: true, force: true });
}
assert.equal(childClosed, true);
console.log(JSON.stringify({
  scenario: "real-core-startup-cancellation",
  workerCreated: true,
  abortBeforeReady,
  actualExitBeforeRejection,
  rejectedAfterConfirmedExit,
  workerClosed: childClosed,
  workerExitCode: child.exitCode,
  workerExitSignal: child.signalCode,
}));
