import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { connect } from "node:net";
import { AppServerChannel } from "../src/app-server.mjs";
import { CODEX_SYNTHETIC_CONFIG, assertCodexConfig, assertEmptyContext, parseSyntheticCompletion } from "../src/codex-policy.mjs";
import { createOfficialTunnel } from "../src/official-tunnel.mjs";

function processFixture(reply, noClose = false) {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kills = []; child.unref = () => {}; child.stdin = new Writable({ write(chunk, _enc, cb) { reply(JSON.parse(chunk), child); cb(); } });
  child.kill = (signal) => { child.kills.push(signal); if (!noClose) queueMicrotask(() => child.emit("close", null)); return true; };
  child.stdin.on("finish", () => { if (!noClose) queueMicrotask(() => child.emit("close", 0)); });
  return child;
}
test("RPC bounds input methods, matches IDs and decodes fragmented UTF-8", async () => {
  const child = processFixture((request, c) => {
    const bytes = Buffer.from(JSON.stringify({ id: request.id, result: { text: "合成" } }) + "\n");
    queueMicrotask(() => { for (const b of bytes) c.stdout.write(Buffer.from([b])); });
  });
  const channel = new AppServerChannel(child);
  await assert.rejects(channel.request("command/exec"), /METHOD_NOT_ALLOWED/);
  assert.deepEqual(await channel.request("config/read"), { text: "合成" });
  assert.equal(await channel.close(), "CONFIRMED");
});
test("capability requests, wrong IDs and malformed responses terminate without leaking payloads", async () => {
  for (const payload of [{ id: 999, result: "synthetic-secret" }, { id: 1, method: "item/tool/call", params: { token: "synthetic-secret" } }, ["synthetic-secret"]]) {
    const child = processFixture((_r, c) => queueMicrotask(() => c.stdout.write(JSON.stringify(payload) + "\n")));
    const channel = new AppServerChannel(child);
    await assert.rejects(channel.request("initialize"), (e) => !e.message.includes("secret"));
    assert.ok(child.kills.includes("SIGTERM")); assert.equal(await channel.close(), "CONFIRMED");
  }
});
test("stderr is bounded and not returned as diagnostics", async () => {
  const child = processFixture((_r, c) => queueMicrotask(() => c.stderr.write("private".repeat(100))));
  const channel = new AppServerChannel(child, { maxBytes: 64 });
  await assert.rejects(channel.request("initialize"), /OUTPUT_LIMIT/);
  assert.equal(await channel.close(), "CONFIRMED");
});
test("timeout and unresponsive close stay bounded and never report confirmed cleanup", async () => {
  const child = processFixture(() => {}, true);
  const channel = new AppServerChannel(child, { rpcTimeoutMs: 5 });
  await assert.rejects(channel.request("initialize"), /RPC_TIMEOUT/);
  assert.equal(await channel.close({ graceMs: 5, deadlineMs: 25 }), "UNCONFIRMED");
  assert.ok(child.kills.includes("SIGKILL"));
  await assert.rejects(channel.request("turn/start"), /RPC_TIMEOUT/);
});
function configFixture() {
  const config = {};
  for (const [key, value] of Object.entries(CODEX_SYNTHETIC_CONFIG)) {
    const parts = key.split("."); let at = config;
    for (const part of parts.slice(0, -1)) at = at[part] ??= {};
    at[parts.at(-1)] = structuredClone(value);
  }
  return config;
}
test("effective configuration must match every restriction; forced policy is never overwritten", () => {
  const requirements = { requirements: { allowedLoginMethods: ["chatgpt"], hooks: null } };
  assert.doesNotThrow(() => assertCodexConfig(configFixture(), requirements));
  for (const key of Object.keys(CODEX_SYNTHETIC_CONFIG)) {
    const config = configFixture(), parts = key.split("."); let at = config;
    for (const part of parts.slice(0, -1)) at = at[part];
    delete at[parts.at(-1)];
    assert.throws(() => assertCodexConfig(config, requirements), /EFFECTIVE_POLICY_MISMATCH/);
  }
  assert.throws(() => assertCodexConfig(configFixture(), { requirements: { hooks: { enabled: true } } }), /MANAGED_POLICY_REQUIRES_REVIEW/);
  for (const key of ["mcp_servers", "plugins", "hooks", "model_providers"]) {
    assert.throws(() => assertCodexConfig({ ...configFixture(), [key]: { private: { enabled: true } } }, requirements), /CUSTOMIZATION_NOT_ALLOWED/);
  }
  assert.throws(() => assertCodexConfig({ ...configFixture(), openai_base_url: "https://synthetic.invalid" }, requirements), /CUSTOMIZATION_NOT_ALLOWED/);
});
test("missing inventories cannot be mistaken for empty context", () => {
  const started = { instructionSources: [], thread: { environments: [] } };
  const skills = { data: [{ skills: [], errors: [] }] };
  assert.doesNotThrow(() => assertEmptyContext(started, skills));
  for (const bad of [{}, { instructionSources: ["private"], thread: { environments: [] } }, { instructionSources: [], thread: {} }]) {
    assert.throws(() => assertEmptyContext(bad, skills), /CONTEXT_NOT_EMPTY/);
  }
  assert.throws(() => assertEmptyContext(started, { data: [] }), /CONTEXT_NOT_EMPTY/);
  assert.throws(() => assertEmptyContext(started, { data: [{ skills: [], errors: ["private"] }] }), /CONTEXT_NOT_EMPTY/);
});
function completion(text = "alpha") { return { method: "turn/completed", params: { threadId: "thread-a", turn: { id: "turn-a", status: "completed", error: null, items: [{ type: "agentMessage", text }] } } }; }
test("only an exact marker on the same thread and turn may become a Core command", () => {
  assert.equal(parseSyntheticCompletion(completion(), "thread-a", "turn-a", "alpha").marker, "alpha");
  assert.throws(() => parseSyntheticCompletion(completion(), "thread-b", "turn-a", "alpha"), /RESPONSE_ID_MISMATCH/);
  assert.throws(() => parseSyntheticCompletion(completion(), "thread-a", "turn-b", "alpha"), /RESPONSE_ID_MISMATCH/);
  for (const bad of ["alpha\n", " beta", "beta", "alpha\nSECRET", "{\"marker\":\"alpha\"}"]) {
    assert.throws(() => parseSyntheticCompletion(completion(bad), "thread-a", "turn-a", "alpha"), /INVALID_MARKER_RESPONSE/);
  }
  const tool = completion(); tool.params.turn.items.push({ type: "commandExecution" });
  assert.throws(() => parseSyntheticCompletion(tool, "thread-a", "turn-a", "alpha"), /UNEXPECTED_RESPONSE_ITEM/);
  const cancelled = completion(); cancelled.params.turn.status = "interrupted";
  assert.deepEqual(parseSyntheticCompletion(cancelled, "thread-a", "turn-a", "alpha"), { state: "CANCELLED" });
});
test("egress rejects nonofficial CONNECT targets before opening any outbound socket", async () => {
  let opened = 0;
  const tunnel = await createOfficialTunnel({ connectSocket: () => { opened++; throw new Error("MUST_NOT_CONNECT"); } });
  try {
    for (const target of ["example.com:443", "chatgpt.com.evil.invalid:443", "chatgpt.com:80", "127.0.0.1:443", "auth.openai.com:22"]) {
      const response = await new Promise((resolve, reject) => {
        const socket = connect({ host: "127.0.0.1", port: tunnel.port }); let data = "";
        socket.once("connect", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
        socket.on("data", (chunk) => { data += chunk; }); socket.once("end", () => resolve(data)); socket.once("error", reject);
      });
      assert.match(response, /403 Forbidden/);
    }
    assert.equal(opened, 0); assert.equal(tunnel.denied, 5);
  } finally { await tunnel.close(); }
});
test("turn failure is observable without a process close notification", async () => {
  const child = processFixture(() => {}, true), channel = new AppServerChannel(child);
  channel.fail("TIMEOUT");
  assert.equal(await channel.failed, "TIMEOUT");
  assert.equal(await channel.close({ graceMs: 1, deadlineMs: 10 }), "UNCONFIRMED");
});
test("pinned protocol omission requires a known session override and empty managed layer", () => {
  const config = configFixture(); delete config.tools.experimental_request_user_input;
  const layers = [{ name: { type: "sessionFlags" }, config: { tools: { experimental_request_user_input: { enabled: false } } } },
    { name: { type: "user" }, config: { forced_login_method: "chatgpt", cli_auth_credentials_store: "file" } }, { name: { type: "system" }, config: {} }];
  assert.doesNotThrow(() => assertCodexConfig(config, { requirements: null }, layers));
  assert.throws(() => assertCodexConfig(config, {}, layers), /INVALID_PREFLIGHT/);
  assert.throws(() => assertCodexConfig(config, { requirements: null }, layers.slice(1)), /EFFECTIVE_POLICY_MISMATCH/);
  const managed = structuredClone(layers); managed[2].config = { hooks: true };
  assert.throws(() => assertCodexConfig(config, { requirements: null }, managed), /MANAGED_POLICY_REQUIRES_REVIEW/);
  const custom = structuredClone(layers); custom[1].config.skills = {};
  assert.throws(() => assertCodexConfig(config, { requirements: null }, custom), /CUSTOMIZATION_NOT_ALLOWED/);
});
test("official CONNECT keeps opaque bytes intact and closes owned sockets", async () => {
  const { createServer } = await import("node:net");
  const fixture = createServer((socket) => socket.pipe(socket));
  await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const tunnel = await createOfficialTunnel({ connectSocket: (options) => {
    assert.deepEqual(options, { host: "chatgpt.com", port: 443 });
    return connect({ host: "127.0.0.1", port: fixture.address().port });
  } });
  const socket = connect({ host: "127.0.0.1", port: tunnel.port });
  try {
    await new Promise((resolve, reject) => {
      let established = false;
      socket.once("connect", () => socket.write("CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\n\r\n"));
      socket.on("data", (data) => {
        if (!established) { assert.match(data.toString(), /200 Connection Established/); established = true; socket.write(Buffer.from([0, 1, 255, 128])); }
        else { assert.deepEqual([...data], [0, 1, 255, 128]); resolve(); }
      }); socket.once("error", reject);
    });
    assert.equal(tunnel.attempts, 1); assert.equal(tunnel.denied, 0);
  } finally { await tunnel.close(); socket.destroy(); await new Promise((resolve) => fixture.close(resolve)); }
});
