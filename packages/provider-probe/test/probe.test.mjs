import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { ProviderProbe, PROBE_LIMITS, providerBounds, statusEnvironment } from "../src/index.mjs";

// These injected processes test the wrapper, not any actual model/provider result.
function fakeProcess({ output = "codex-cli 0.158.0-alpha.2.1\n", code = 0, pending = false, noClose = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
    if (!noClose) queueMicrotask(() => child.emit("close", null));
    return true;
  };
  if (!pending) queueMicrotask(() => {
    child.stdout.emit("data", Buffer.from(output));
    child.emit("close", code);
  });
  return child;
}

function injected(sequence = [{}]) {
  const calls = [];
  const probe = new ProviderProbe({
    findExecutable: async () => "synthetic-official-cli",
    spawnProcess: (exe, args, options) => {
      const child = fakeProcess(sequence[calls.length]);
      calls.push({ exe, args, options, child });
      return child;
    }
  });
  return { probe, calls };
}

test("default status runs only version in a fresh fixture and removes it afterwards", async () => {
  const { probe, calls } = injected();
  const result = await probe.status("codex");
  assert.equal(result.state, "INSTALLED");
  assert.equal(result.version, "0.158.0-alpha.2.1");
  assert.equal(result.auth.state, "NOT_CHECKED");
  assert.equal(result.modelRequest, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["--version"]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsHide, true);
  await assert.rejects(access(calls[0].options.cwd));
});

test("environment drops model API credentials, routing, hooks and proxy variables", () => {
  const env = statusEnvironment({ PATH: "path", HOME: "official-home", CODEX_HOME: "official-store",
    OPENAI_API_KEY: "synthetic-secret", ANTHROPIC_API_KEY: "synthetic-secret", CODEX_ACCESS_TOKEN: "synthetic-secret",
    OPENAI_BASE_URL: "https://synthetic.invalid", HTTP_PROXY: "synthetic", CLAUDE_CODE_SHELL: "synthetic-hook" });
  assert.deepEqual(env, { PATH: "path", HOME: "official-home", CODEX_HOME: "official-store" });
});

test("missing official CLI does not install, authenticate, or start a child", async () => {
  let invoked = false;
  const probe = new ProviderProbe({ findExecutable: async () => null, spawnProcess: () => { invoked = true; } });
  assert.equal((await probe.status("claude", { checkAuth: true })).state, "NOT_INSTALLED");
  assert.equal(invoked, false);
});

test("Codex existing ChatGPT login is a local status, not remote validity or response", async () => {
  const { probe, calls } = injected([{}, { output: "Logged in using ChatGPT\n" }]);
  const result = await probe.status("codex", { checkAuth: true });
  assert.deepEqual(result.auth, { state: "PRESENT", kind: "chatgpt", remoteValidity: "NOT_VERIFIED" });
  assert.deepEqual(calls[1].args, ["login", "status"]);
});

test("not logged in is distinct from installation failure and no login starts", async () => {
  const { probe, calls } = injected([{}, { output: "Not logged in\n", code: 1 }]);
  assert.equal((await probe.status("codex", { checkAuth: true })).auth.state, "NOT_LOGGED_IN");
  assert.equal(calls.length, 2);
});

test("unsupported auth and unknown diagnostics cannot leak raw API keys or emails", async () => {
  for (const output of ["Logged in using an API key - synthetic-secret", "Error synthetic-secret user@synthetic.invalid"]) {
    const { probe } = injected([{}, { output }]);
    const result = await probe.status("codex", { checkAuth: true });
    assert.ok(["UNSUPPORTED_AUTH", "UNKNOWN"].includes(result.auth.state));
    assert.doesNotMatch(JSON.stringify(result), /synthetic-secret|user@/);
  }
});

test("Claude status JSON is projected to official auth kind only", async () => {
  const { probe, calls } = injected([{ output: "2.1.268 (Claude Code)\n" }, {
    output: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "private@synthetic.invalid",
      organizationId: "private-org", accessToken: "synthetic-secret" })
  }]);
  const result = await probe.status("claude", { checkAuth: true });
  assert.equal(result.auth.kind, "claude.ai");
  assert.doesNotMatch(JSON.stringify(result), /private|synthetic-secret/);
  assert.deepEqual(calls[1].args, ["auth", "status"]);
});

test("Claude auth exit code and body must agree", async () => {
  const { probe } = injected([{ output: "2.1.268 (Claude Code)" }, {
    output: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }), code: 1
  }]);
  assert.equal((await probe.status("claude", { checkAuth: true })).auth.state, "UNKNOWN");
});

test("unknown version output is rejected and discarded before any auth call", async () => {
  const { probe, calls } = injected([{ output: "codex-cli 0.158.0\nprivate-extra" }]);
  const result = await probe.status("codex", { checkAuth: true });
  assert.equal(result.state, "UNSUPPORTED_VERSION_OUTPUT");
  assert.doesNotMatch(JSON.stringify(result), /private-extra/);
  assert.equal(calls.length, 1);
});

test("overlimit multibyte diagnostics terminate the owned child and discard all output", async () => {
  const { probe, calls } = injected([{ output: "秘".repeat(PROBE_LIMITS.maxOutputBytes / 2) }]);
  const result = await probe.status("codex");
  assert.equal(result.state, "OUTPUT_LIMIT");
  assert.equal(result.termination, "CONFIRMED");
  assert.deepEqual(calls[0].child.kills, ["SIGTERM"]);
  assert.doesNotMatch(JSON.stringify(result), /秘/);
});

test("timeout and cancellation keep separate terminal states", async () => {
  const first = injected([{ pending: true }]);
  const timeout = await first.probe.status("codex", { timeoutMs: 5 });
  assert.equal(timeout.state, "TIMEOUT");
  assert.equal(timeout.termination, "CONFIRMED");
  const second = injected([{ pending: true }]);
  const pending = second.probe.status("codex");
  while (!second.calls.length) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(second.probe.cancel().state, "CANCEL_REQUESTED");
  assert.equal((await pending).state, "CANCELLED");
  assert.equal(second.probe.cancel().state, "NO_ACTIVE_PROBE");
});

test("no close after cancellation is explicitly unconfirmed and still bounded", async () => {
  const { probe, calls } = injected([{ pending: true, noClose: true }]);
  const result = await probe.status("codex", { timeoutMs: 5 });
  assert.equal(result.state, "TIMEOUT");
  assert.equal(result.termination, "UNCONFIRMED");
  assert.equal((await probe.status("codex")).state, "PROCESS_CLEANUP_UNCONFIRMED");
  assert.equal(calls.length, 1);
});

test("cancel during executable discovery prevents the later spawn", async () => {
  let release;
  let spawned = false;
  const waiting = new Promise((resolve) => { release = resolve; });
  const probe = new ProviderProbe({ findExecutable: () => waiting,
    spawnProcess: () => { spawned = true; return fakeProcess(); } });
  const pending = probe.status("codex");
  assert.equal(probe.cancel().state, "CANCEL_REQUESTED");
  release("synthetic-cli");
  assert.equal((await pending).state, "CANCELLED");
  assert.equal(spawned, false);
});

test("concurrent status rejects even during async executable discovery", async () => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const probe = new ProviderProbe({ findExecutable: () => waiting, spawnProcess: () => fakeProcess() });
  const first = probe.status("codex");
  assert.equal((await probe.status("claude")).state, "BUSY");
  release("synthetic-cli");
  assert.equal((await first).state, "INSTALLED");
});

test("pre-abort does not spawn, and a new operation works after cancellation", async () => {
  const { probe, calls } = injected([{ pending: true }, {}]);
  const abort = new AbortController();
  abort.abort();
  assert.equal((await probe.status("codex", { signal: abort.signal })).state, "CANCELLED");
  assert.equal(calls.length, 0);
  const freshAbort = new AbortController();
  const pending = probe.status("codex", { signal: freshAbort.signal });
  while (!calls.length) await new Promise((resolve) => setTimeout(resolve, 1));
  freshAbort.abort();
  assert.equal((await pending).state, "CANCELLED");
  assert.equal((await probe.status("codex")).state, "INSTALLED");
});

test("process errors return a stable safe code and permit retry", async () => {
  const { probe, calls } = injected([{ pending: true }, {}]);
  const pending = probe.status("codex");
  while (!calls.length) await new Promise((resolve) => setTimeout(resolve, 1));
  calls[0].child.emit("error", new Error("synthetic-secret"));
  assert.equal((await pending).state, "SPAWN_FAILED");
  assert.equal((await probe.status("codex")).state, "INSTALLED");
});

test("real synthetic Node child cancellation confirms exit without touching another child", async () => {
  let owned;
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { windowsHide: true, stdio: "ignore" });
  const probe = new ProviderProbe({ findExecutable: async () => process.execPath,
    spawnProcess: () => {
      owned = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      return owned;
    } });
  try {
    const pending = probe.status("codex");
    while (!owned) await new Promise((resolve) => setTimeout(resolve, 1));
    probe.cancel();
    const result = await pending;
    assert.equal(result.state, "CANCELLED");
    assert.equal(result.termination, "CONFIRMED");
    assert.notEqual(owned.exitCode === null && owned.signalCode === null, true);
    assert.equal(unrelated.exitCode, null);
    assert.equal(unrelated.signalCode, null);
  } finally {
    unrelated.kill();
    owned?.kill();
  }
});

test("model run is failed closed before discovery or spawn regardless of provider", () => {
  const probe = new ProviderProbe({ findExecutable: () => { throw new Error("discovery must not run"); },
    spawnProcess: () => { throw new Error("spawn must not run"); } });
  for (const provider of ["codex", "claude"]) {
    assert.equal(probe.run(provider).code, "ISOLATION_NOT_VERIFIED");
    assert.equal(probe.run(provider).realResponse, "NOT_EXECUTED");
    assert.equal(providerBounds(provider).candidate, "NOT_CANDIDATE");
  }
});

test("invalid provider and timeout fail before discovery or execution", async () => {
  const { probe, calls } = injected();
  await assert.rejects(probe.status("other"), /UNKNOWN_PROVIDER/);
  await assert.rejects(probe.status("codex", { timeoutMs: PROBE_LIMITS.maxTimeoutMs + 1 }), /INVALID_TIMEOUT/);
  assert.equal(calls.length, 0);
});
