import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startCore } from "@netnavr/core";
import { CORE_API_VERSION, CORE_SCHEMA_VERSION, CORE_SERVICE } from "@netnavr/core/contract";
import { fetchCoreStatus } from "../apps/desktop/src/core-status.ts";

test("Shell reads the pinned Core runtime and its identity survives restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "netnavr-integration-"));
  const databasePath = join(directory, "core.sqlite");
  let runtime: Awaited<ReturnType<typeof startCore>> | undefined;
  try {
    const corePackage = JSON.parse(await readFile(
      new URL("../package.json", import.meta.resolve("@netnavr/core")), "utf8",
    ));
    runtime = await startCore({ port: 0, databasePath });
    const initial = await fetchCoreStatus({ origin: runtime.origin });
    assert.equal(initial.state, "online");
    if (initial.state !== "online") throw new Error("Core must be online");
    assert.equal(initial.service, CORE_SERVICE);
    assert.equal(initial.apiVersion, CORE_API_VERSION);
    assert.equal(initial.schemaVersion, CORE_SCHEMA_VERSION);
    assert.equal(initial.version, corePackage.version);
    assert.match(initial.requestIds.health ?? "", /^req_/);
    assert.match(initial.requestIds.node ?? "", /^req_/);
    await runtime.close();
    const closedOrigin = runtime.origin;
    runtime = undefined;
    const offline = await fetchCoreStatus({ origin: closedOrigin });
    assert.equal(offline.state, "offline");

    runtime = await startCore({ port: 0, databasePath });
    const restarted = await fetchCoreStatus({ origin: runtime.origin });
    assert.equal(restarted.state, "online");
    if (restarted.state !== "online") throw new Error("Core must restart");
    assert.equal(restarted.nodeId, initial.nodeId);
    assert.equal(restarted.createdAt, initial.createdAt);
  } finally {
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
