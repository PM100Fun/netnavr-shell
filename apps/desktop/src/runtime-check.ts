import assert from "node:assert/strict";
import { mkdtemp, realpath, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { app } from "electron";
import { CORE_VERSION } from "@netnavr/core";
import { FixtureOwner, OwnedCoreLaunchError } from "./fixture-owner.js";
import { createElectronCoreLauncher } from "./electron-core-launcher.js";

// Explicit no-window technical check. This does not install an App or prove Mac
// GUI behavior, signing, Gatekeeper, Provider isolation or user acceptance.
async function run(): Promise<void> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "netnavr-electron-check-")));
  const profile = path.join(directory, "electron-profile");
  await mkdir(profile, { mode: 0o700 });
  app.setPath("userData", profile);
  await app.whenReady();
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE runtime_check(value INTEGER); INSERT INTO runtime_check VALUES(1)");
  assert.equal(sqlite.prepare("SELECT value FROM runtime_check").get()?.value, 1);
  sqlite.close();
  const bundleDirectory = __dirname;
  const launch = createElectronCoreLauncher(path.join(bundleDirectory, "core-worker.cjs"), () => path.join(directory, "fixture-v1"));
  let privateOrigin = "";
  const owner = new FixtureOwner(async (token, signal) => {
    const handle = await launch(token, signal);
    privateOrigin = handle.origin;
    return handle;
  });
  try {
    const first = await owner.start();
    assert.equal(first.ok, true);
    if (!first.ok || !first.value.fixture) throw new Error("Missing initial fixture");
    const health = await fetch(`${privateOrigin}/v1/health`).then((response) => response.json()) as { version: string };
    assert.equal(health.version, CORE_VERSION, "worker must retain its fixed Core package version");
    const commandId = `cmd_${randomUUID()}`;
    assert.equal((await owner.submit({ commandId, operation: "set-marker", marker: "beta" })).ok, true);
    let completed = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      const result = await owner.read(commandId);
      assert.equal(result.ok, true);
      if (result.ok && result.value.status === "completed") { completed = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(completed, true);
    assert.equal((await owner.stop()).ok, true);
    const cancelledStartup = new AbortController();
    const starting = launch(randomBytes(32).toString("base64url"), cancelledStartup.signal);
    cancelledStartup.abort();
    let cancellationConfirmed = false;
    try { await starting; } catch (error) {
      if (error instanceof OwnedCoreLaunchError) { await error.owned.close(); throw new Error("Cancelled utility exit was initially unconfirmed"); }
      cancellationConfirmed = true;
    }
    assert.equal(cancellationConfirmed, true, "cancelled utility startup must reject only after its actual exit");
    const restarted = await owner.start();
    assert.equal(restarted.ok, true);
    if (!restarted.ok || !restarted.value.fixture) throw new Error("Missing restart fixture");
    assert.equal(restarted.value.fixture.marker, "beta");
    assert.equal(restarted.value.fixture.revision, 1);
    assert.notEqual(restarted.value.fixture.fixtureSessionId, first.value.fixture.fixtureSessionId);
    assert.equal((await owner.read(commandId)).ok, false, "old command ledger is session-only");
    assert.equal((await owner.stop()).ok, true);
    console.log(JSON.stringify({ result: "PASS", platform: process.platform, arch: process.arch,
      node: process.versions.node, electron: process.versions.electron, coreVersion: health.version,
      sqlite: "PASS", ownedUtilityProcess: "PASS", startupCancellation: "PASS", restartReadback: "PASS", guiInstall: "NOT_EXECUTED" }));
  } finally {
    const closed = await owner.stop();
    if (!closed.ok) throw new Error("Owned utility process exit unconfirmed");
    await rm(directory, { recursive: true, force: true });
  }
}
void run().then(() => app.exit(0), () => {
  console.error(JSON.stringify({ result: "FAIL", code: "electron_runtime_check_failed", platform: process.platform, arch: process.arch }));
  app.exit(1);
});
