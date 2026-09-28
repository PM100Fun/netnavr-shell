import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { startCore } from "@netnavr/core";
import { FixtureClient, parseFixtureInput, parseFixtureState, parseFixtureCommandResult,
  FIXTURE_RESPONSE_LIMIT } from "../src/fixture-bridge.js";
import { FixtureOwner, type OwnedCore } from "../src/fixture-owner.js";

test("private fixture client completes a real authenticated, bounded Core round trip", async () => {
  const token = randomBytes(32).toString("base64url");
  const core = await startCore({ port: 0, databasePath: ":memory:", fixtureProbe: { token } });
  try {
    const client = new FixtureClient(core.origin, token);
    const input = { commandId: `cmd_${randomUUID()}`, operation: "set-marker" as const, marker: "alpha" as const };
    const initial = await client.state();
    assert.equal(initial.ok, true);
    if (!initial.ok) throw new Error("state unavailable");
    assert.equal(initial.value.marker, "empty");
    const submitted = await client.submit(input);
    assert.equal(submitted.ok, true);
    const completed = await waitForCompletion(client, input.commandId);
    assert.equal(completed.status, "completed");
    assert.equal(completed.state.marker, "alpha");
    assert.equal(completed.state.revision, 1);
    const repeated = await client.submit(input);
    assert.equal(repeated.ok, true);
    if (repeated.ok) assert.deepEqual(repeated.value, completed);
    const conflict = await client.submit({ ...input, marker: "beta" });
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.equal(conflict.error.code, "probe_id_conflict");
    const cancelledCompleted = await client.cancel(input.commandId);
    assert.equal(cancelledCompleted.ok, true);
    if (cancelledCompleted.ok) assert.equal(cancelledCompleted.value.state.marker, "alpha");
    const badAuth = await new FixtureClient(core.origin, randomBytes(32).toString("base64url")).state();
    assert.equal(badAuth.ok, false);
    if (!badAuth.ok) assert.equal(badAuth.error.code, "probe_unauthorized");
  } finally { await core.close(); }
});

test("fixture cancellation and timeout preserve earlier committed state", async () => {
  const token = randomBytes(32).toString("base64url");
  const core = await startCore({ port: 0, databasePath: ":memory:", fixtureProbe: { token } });
  try {
    const client = new FixtureClient(core.origin, token);
    const id = `cmd_${randomUUID()}`;
    await client.submit({ commandId: id, operation: "set-marker", marker: "beta", delayMs: 500 });
    const cancelled = await client.cancel(id);
    assert.equal(cancelled.ok, true);
    if (cancelled.ok) { assert.equal(cancelled.value.status, "cancelled"); assert.equal(cancelled.value.state.marker, "empty"); }
    const timedId = `cmd_${randomUUID()}`;
    await client.submit({ commandId: timedId, operation: "set-marker", marker: "alpha", delayMs: 500, timeoutMs: 10 });
    const timedOut = await waitForCompletion(client, timedId);
    assert.equal(timedOut.status, "timed_out");
    assert.equal(timedOut.state.revision, 0);
  } finally { await core.close(); }
});

test("renderer inputs cannot smuggle URLs, paths, commands or unsafe IDs", () => {
  const input = { commandId: `cmd_${randomUUID()}`, operation: "set-marker", marker: "alpha" };
  assert.equal(parseFixtureInput(input).marker, "alpha");
  for (const invalid of [
    { ...input, token: "secret" }, { ...input, origin: "http://example.com" },
    { ...input, dataDirectory: "user-data" }, { ...input, operation: "execute" },
    { ...input, marker: "arbitrary text" }, { ...input, commandId: "../secrets" },
    { ...input, delayMs: 501 }, { ...input, timeoutMs: 0 }, { ...input, timeoutMs: 1001 },
  ]) assert.throws(() => parseFixtureInput(invalid));
  assert.throws(() => parseFixtureState({ contractVersion: "fixture-v2" }));
  assert.throws(() => parseFixtureCommandResult({ status: "completed", state: { marker: "alpha" } }));
});

test("client cleans oversized response without waiting for cancellation and redacts peer errors", async () => {
  let cancelled = false;
  const client = new FixtureClient("http://127.0.0.1:12345", randomBytes(32).toString("base64url"), async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(FIXTURE_RESPONSE_LIMIT + 1)); },
    cancel() { cancelled = true; return new Promise(() => undefined); },
  }), { headers: { "content-type": "application/json" } }));
  const failed = await Promise.race([client.state(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("cleanup hung")), 1000))]);
  assert.equal(failed.ok, false);
  assert.equal(cancelled, true);
  const redacted = new FixtureClient("http://127.0.0.1:12345", randomBytes(32).toString("base64url"), async () => Response.json({ error: { code: "probe_busy", message: "secret-token-and-private-path" } }, { status: 409 }));
  const rejected = await redacted.state();
  assert.equal(rejected.ok, false);
  assert.doesNotMatch(JSON.stringify(rejected), /secret-token|private-path/);
});

test("valid-shaped replies with a wrong command ID or an old Core session are rejected", async () => {
  const initialState = { contractVersion: "fixture-v1", fixtureSessionId: `fixture_${randomUUID()}`,
    persistence: "memory-only", fixtureSchemaVersion: 1, commandPersistence: "session-only", marker: "empty", revision: 0 };
  const expectedId = `cmd_${randomUUID()}`;
  let reply: unknown = initialState;
  const client = new FixtureClient("http://127.0.0.1:12345", randomBytes(32).toString("base64url"), async () => Response.json(reply));
  assert.equal((await client.state()).ok, true);
  const makeResult = (commandId: string, state = initialState) => ({ contractVersion: "fixture-v1", fixtureSessionId: state.fixtureSessionId,
    commandId, operation: "set-marker", status: "completed", state });
  reply = makeResult(`cmd_${randomUUID()}`);
  assert.equal((await client.read(expectedId)).ok, false);
  assert.equal((await client.cancel(expectedId)).ok, false);
  assert.equal((await client.submit({ commandId: expectedId, operation: "set-marker", marker: "alpha" })).ok, false);
  reply = makeResult(expectedId, { ...initialState, fixtureSessionId: `fixture_${randomUUID()}` });
  assert.equal((await client.read(expectedId)).ok, false);
  reply = { ...initialState, fixtureSessionId: `fixture_${randomUUID()}` };
  assert.equal((await client.state()).ok, false);
  reply = makeResult(expectedId);
  assert.equal((await client.read(expectedId)).ok, true);
});

test("owner does not start on reads, deduplicates startup, and only closes its Core", async () => {
  const unrelated = await startCore({ port: 0, databasePath: ":memory:" });
  let launches = 0;
  let closed = 0;
  const owner = new FixtureOwner(async (token) => {
    launches++;
    const core = await startCore({ port: 0, databasePath: ":memory:", fixtureProbe: { token } });
    let onExit: () => void = () => undefined;
    return { origin: core.origin, onExit: (callback) => { onExit = callback; }, close: async () => { await core.close(); closed++; onExit(); } };
  });
  try {
    assert.deepEqual(await owner.state(), { ok: true, value: { state: "stopped" } });
    assert.equal(launches, 0);
    const [first, second] = await Promise.all([owner.start(), owner.start()]);
    assert.deepEqual(first, second);
    assert.equal(launches, 1);
    assert.equal((await owner.stop()).ok, true);
    assert.equal(closed, 1);
    assert.equal((await fetch(`${unrelated.origin}/v1/health`)).status, 200);
    assert.equal((await owner.submit({ commandId: `cmd_${randomUUID()}`, operation: "set-marker", marker: "alpha" })).ok, false);
  } finally { await owner.stop(); await unrelated.close(); }
});

test("owner cancels startup and cleans a child that finishes after stop", async () => {
  let finishLaunch: (value: OwnedCore) => void = () => undefined;
  let closes = 0;
  const owner = new FixtureOwner(() => new Promise((resolve) => { finishLaunch = resolve; }));
  const starting = owner.start();
  const stopping = owner.stop();
  finishLaunch({ origin: "http://127.0.0.1:12345", onExit: () => undefined, close: async () => { closes++; } });
  assert.equal((await starting).ok, false);
  assert.equal((await stopping).ok, true);
  assert.equal(closes, 1);
  assert.deepEqual(await owner.state(), { ok: true, value: { state: "stopped" } });
});

test("owner preserves failed shutdown ownership and retries instead of reporting stopped", async () => {
  let attempts = 0;
  const owner = new FixtureOwner(async (token) => {
    const core = await startCore({ port: 0, databasePath: ":memory:", fixtureProbe: { token } });
    return { origin: core.origin, onExit: () => undefined, close: async () => {
      if (++attempts === 1) throw new Error("exit not confirmed");
      await core.close();
    } };
  });
  await owner.start();
  assert.equal((await owner.stop()).ok, false);
  assert.deepEqual(await owner.state(), { ok: true, value: { state: "error" } });
  assert.equal((await owner.stop()).ok, true);
  assert.equal(attempts, 2);
  assert.deepEqual(await owner.state(), { ok: true, value: { state: "stopped" } });
});

async function waitForCompletion(client: FixtureClient, id: string) {
  for (let count = 0; count < 30; count++) {
    const response = await client.read(id);
    if (!response.ok) throw new Error(response.error.code);
    if (response.value.status !== "pending") return response.value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("command did not complete");
}
