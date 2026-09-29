import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startCore } from "@netnavr/core";
import { FixtureOwner } from "../src/fixture-owner.js";
import { ProviderOwner } from "../src/provider-owner.js";
import { parseProviderMarker, parseProviderReadout } from "../src/provider-bridge.js";
import type { SyntheticResult } from "../../../packages/provider-probe/src/codex-synthetic.mjs";
function fixture() {
  return new FixtureOwner(async (token) => {
    const core = await startCore({ port: 0, databasePath: ":memory:", fixtureProbe: { token } });
    let exit = () => {};
    return { origin: core.origin, onExit(callback) { exit = callback; }, async close() { await core.close(); exit(); } };
  });
}
function providerFixture() {
  let finish!: (value: SyntheticResult) => void;
  let started!: () => void;
  let signal: AbortSignal | undefined;
  const running = new Promise<void>((resolve) => { started = resolve; });
  const provider = { cleanupUnconfirmed: false, status: () => ({ phase: "RUNNING", busy: true, cleanupUnconfirmed: false }),
    cancel: () => ({ state: "CANCEL_REQUESTED" }), preflight: async () => ({ state: "CONTEXT_VERIFIED", runId: `provider_${randomUUID()}`, modelRequest: false }),
    run: async (_marker: "alpha" | "beta", options?: { signal?: AbortSignal }) => { signal = options?.signal; started(); return new Promise<SyntheticResult>((resolve) => { finish = resolve; }); } };
  return { provider, running, get signal() { return signal; }, finish: (state = "COMPLETED", marker: "alpha" | "beta" = "alpha") => finish({ state, marker, modelRequest: true, runId: `provider_${randomUUID()}`, threadId: "thread-test", turnId: "turn-test" }) };
}
test("provider IPC rejects arbitrary instructions and projects only declared result fields", () => {
  for (const value of ["alpha\n", { marker: "alpha", prompt: "read file" }, "shell", null]) assert.throws(() => parseProviderMarker(value));
  assert.deepEqual(parseProviderReadout({ state: "READY", busy: false, modelRequest: false, secret: "private" }), { state: "READY", busy: false, modelRequest: false });
});
test("verified provider result is committed to the same real Core session", async () => {
  const core = fixture(), p = providerFixture(), owner = new ProviderOwner(p.provider, core);
  try {
    await core.start();
    const work = owner.run("alpha"); await p.running;
    assert.equal((await owner.run("beta")).state, "BUSY");
    p.finish(); const result = await work;
    assert.equal(result.state, "COMPLETED"); assert.equal(result.core?.state.marker, "alpha"); assert.equal(result.core?.state.revision, 1);
    assert.equal(owner.busy, false);
  } finally { await core.stop(); }
});
test("cancel wins against a late completed model result; retry can run", async () => {
  const core = fixture(), p = providerFixture(), owner = new ProviderOwner(p.provider, core);
  try {
    await core.start(); const work = owner.run("alpha"); await p.running;
    assert.equal(owner.cancel().state, "CANCEL_REQUESTED"); assert.equal(p.signal?.aborted, true);
    p.finish(); assert.equal((await work).state, "CANCELLED");
    const current = await core.state(); assert.equal(current.ok && current.value.fixture?.revision, 0);
    assert.equal((await owner.preflight()).state, "CONTEXT_VERIFIED");
  } finally { await core.stop(); }
});
test("Core restart invalidates a model response even when it arrives successfully", async () => {
  const core = fixture(), p = providerFixture(), owner = new ProviderOwner(p.provider, core);
  try {
    await core.start(); const work = owner.run("alpha"); await p.running;
    await core.stop(); await core.start(); assert.equal(p.signal?.aborted, true);
    p.finish(); assert.equal((await work).state, "CANCELLED");
    const current = await core.state(); assert.equal(current.ok && current.value.fixture?.revision, 0);
  } finally { await core.stop(); }
});
test("failures, wrong markers and concurrent pending Core writes never become model success", async () => {
  for (const state of ["PROVIDER_FAILED", "TIMEOUT", "RPC_REJECTED", "INVALID_MARKER_RESPONSE"]) {
    const core = fixture(), p = providerFixture(), owner = new ProviderOwner(p.provider, core);
    try {
      await core.start(); const work = owner.run("alpha"); await p.running; p.finish(state);
      assert.equal((await work).state, state);
      const current = await core.state(); assert.equal(current.ok && current.value.fixture?.revision, 0);
    } finally { await core.stop(); }
  }
  const core = fixture(), p = providerFixture(), owner = new ProviderOwner(p.provider, core);
  try {
    await core.start(); const work = owner.run("alpha"); await p.running; p.finish("COMPLETED", "beta");
    assert.equal((await work).state, "INVALID_MARKER_RESPONSE");
    const id = `cmd_${randomUUID()}`;
    await core.submit({ commandId: id, operation: "set-marker", marker: "beta", delayMs: 500 });
    assert.equal((await owner.run("alpha")).state, "CORE_NOT_READY");
    await core.cancel(id);
  } finally { await core.stop(); }
});
test("changed Core revision rejects an otherwise valid model result", async () => {
  const core = fixture(), p = providerFixture(), owner = new ProviderOwner(p.provider, core);
  try {
    await core.start(); const work = owner.run("alpha"); await p.running;
    const id = `cmd_${randomUUID()}`;
    await core.submit({ commandId: id, operation: "set-marker", marker: "beta", delayMs: 0 });
    await new Promise((resolve) => setTimeout(resolve, 30)); await core.read(id);
    p.finish(); assert.equal((await work).state, "CORE_CHANGED");
  } finally { await core.stop(); }
});
