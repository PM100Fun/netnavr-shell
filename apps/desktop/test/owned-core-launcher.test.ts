import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { launchOwnedCoreChild, type OwnedChild } from "../src/owned-core-launcher.js";
import { FixtureOwner, OwnedCoreLaunchError } from "../src/fixture-owner.js";

function childFixture() {
  let spawned: () => void = () => undefined;
  let message: (value: unknown) => void = () => undefined;
  let exited: () => void = () => undefined;
  let stops = 0;
  let kills = 0;
  let shouldExit = false;
  const child: OwnedChild = {
    onSpawn: (callback) => { spawned = callback; }, onMessage: (callback) => { message = callback; },
    onExit: (callback) => { exited = callback; },
    postMessage: (value) => { if ((value as { type?: string }).type === "stop") { stops++; if (shouldExit) exited(); } },
    kill: () => { kills++; if (shouldExit) exited(); },
  };
  return { child, spawn: () => spawned(), message: (value: unknown) => message(value), allowExit: () => { shouldExit = true; }, stats: () => ({ stops, kills }) };
}
const limits = { startupMs: 100, gracefulStopMs: 5, finalExitMs: 15 };

test("failed startup rejects only after exit, or retains the exact child for retry", async () => {
  const fake = childFixture();
  const signal = new AbortController();
  const starting = launchOwnedCoreChild(fake.child, randomBytes(32).toString("base64url"), "fixture-v1", signal.signal, limits);
  fake.spawn();
  signal.abort();
  // A valid late ready response must not convert cancelled startup into success.
  fake.message({ type: "ready", origin: "http://127.0.0.1:12345" });
  let error: unknown;
  try { await starting; assert.fail("startup accepted after cancellation"); } catch (caught) { error = caught; }
  assert.ok(error instanceof OwnedCoreLaunchError);
  assert.deepEqual(fake.stats(), { stops: 1, kills: 1 });
  fake.allowExit();
  await error.owned.close();
  assert.equal(fake.stats().stops, 2, "failed close promise must allow a retry on the same child");
});

test("owner retains an unconfirmed late child and refuses another startup", async () => {
  const fake = childFixture();
  let launches = 0;
  const owner = new FixtureOwner((token, signal) => {
    launches++;
    return launchOwnedCoreChild(fake.child, token, "fixture-v1", signal, limits);
  });
  const starting = owner.start();
  fake.spawn();
  fake.message({ type: "failed" });
  const failed = await starting;
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.equal(failed.error.code, "shutdown_unconfirmed");
  assert.equal((await owner.start()).ok, false);
  assert.equal(launches, 1);
  fake.allowExit();
  assert.equal((await owner.stop()).ok, true);
  assert.deepEqual(await owner.state(), { ok: true, value: { state: "stopped" } });
});
