import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, lstat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { AppServerChannel } from "./app-server.mjs";
import { createOfficialTunnel } from "./official-tunnel.mjs";
import { CODEX_SYNTHETIC_CONFIG, CODEX_SYNTHETIC_VERSION, SYNTHETIC_INSTRUCTIONS,
  assertCodexConfig, assertEmptyContext, parseSyntheticCompletion } from "./codex-policy.mjs";

const SAFE_CODES = new Set(["INVALID_PREFLIGHT", "EFFECTIVE_POLICY_MISMATCH", "MANAGED_POLICY_REQUIRES_REVIEW",
  "CUSTOMIZATION_NOT_ALLOWED", "OFFICIAL_PROVIDER_REQUIRED", "CONTEXT_NOT_EMPTY", "RESPONSE_ID_MISMATCH",
  "UNEXPECTED_RESPONSE_ITEM", "INVALID_MARKER_RESPONSE", "OUTPUT_LIMIT", "INVALID_PROTOCOL", "RPC_REJECTED",
  "UNEXPECTED_CAPABILITY_REQUEST", "UNEXPECTED_RESPONSE", "INVALID_EVENT", "RPC_TIMEOUT", "PIPE_FAILED",
  "SPAWN_FAILED", "PROCESS_CLOSED", "PROCESS_CLEANUP_UNCONFIRMED", "UNSUPPORTED_VERSION", "AUTH_REQUIRED",
  "UNSAFE_HOME", "UNSAFE_EXECUTABLE", "UNSUPPORTED_PLATFORM", "CANCELLED", "TIMEOUT", "EGRESS_REJECTED"]);

export function syntheticSeatbelt({ executable, home, fixture, port }) {
  // All paths are canonical and validated before interpolation. Root-only read
  // is needed by macOS getcwd/dyld; it does not grant recursive personal reads.
  const q = (value) => JSON.stringify(value);
  return `(version 1)
(allow default)
(deny file-read-data)
(allow file-read-data (literal "/") (subpath "/System/Library") (subpath "/usr/lib") (subpath "/usr/share") (subpath "/Library/Apple") (subpath "/private/var/db") (subpath "/private/etc/ssl") (subpath "/dev") (subpath ${q(executable.slice(0, executable.indexOf(".app/") + 4))}) (subpath ${q(home)}) (subpath ${q(fixture)}))
(deny file-write*)
(allow file-write* (subpath ${q(home)}) (subpath ${q(fixture)}) (literal "/dev/null"))
(deny process-exec)
(allow process-exec (literal ${q(executable)}))
(deny network*)
(allow network-outbound (remote ip "localhost:${port}"))
`;
}

// Main-process configuration only. Renderer input is limited to alpha/beta and
// cancellation; paths, environment, RPC, prompts and routing are never exposed.
export class CodexSyntheticProvider {
  #options; #busy = false; #controller; #channel; #cleanupUnconfirmed = false; #phase = "IDLE";
  constructor({ executable, dedicatedHome, evidenceRoot }) {
    this.#options = { executable, dedicatedHome, evidenceRoot };
  }
  cancel() {
    if (!this.#controller) return { state: "NO_ACTIVE_RUN" };
    this.#controller.abort(); return { state: "CANCEL_REQUESTED" };
  }
  status() { return { phase: this.#phase, busy: this.#busy, cleanupUnconfirmed: this.#cleanupUnconfirmed }; }
  get cleanupUnconfirmed() { return this.#cleanupUnconfirmed; }
  preflight() { return this.#execute(null); }
  run(marker, { signal } = {}) {
    if (!["alpha", "beta"].includes(marker)) throw new TypeError("INVALID_MARKER");
    return this.#execute(marker, signal);
  }
  async #execute(marker, signal) {
    const runId = `provider_${randomUUID()}`;
    if (this.#busy) return { state: "BUSY", runId, modelRequest: false };
    if (this.#cleanupUnconfirmed) return { state: "PROCESS_CLEANUP_UNCONFIRMED", runId, modelRequest: false };
    if (signal?.aborted) return { state: "CANCELLED", runId, modelRequest: false };
    this.#busy = true; this.#phase = "PREFLIGHT"; this.#controller = new AbortController();
    const abort = signal ? AbortSignal.any([signal, this.#controller.signal]) : this.#controller.signal;
    let tunnel, channel, timer, cancelTimer, modelRequest = false, result, threadId, turnId;
    let completionResolve;
    const completion = new Promise((resolve) => { completionResolve = resolve; });
    const events = [];
    const cancel = () => {
      clearTimeout(cancelTimer);
      cancelTimer = setTimeout(() => channel?.fail("CANCELLED"), 3_000);
      if (turnId && channel && !channel.fault) {
        void channel.request("turn/interrupt", { threadId, turnId }).catch(() => channel.fail("CANCELLED"));
      } else channel?.fail("CANCELLED");
    };
    try {
      if (process.platform !== "darwin" || process.arch !== "x64") throw new Error("UNSUPPORTED_PLATFORM");
      const { executable, dedicatedHome: home, evidenceRoot } = this.#options;
      for (const p of [executable, home, evidenceRoot]) {
        if (typeof p !== "string" || !isAbsolute(p) || /[\r\n\0]/.test(p) || await realpath(p) !== p) throw new Error("UNSAFE_HOME");
      }
      if (!executable.endsWith(".app/Contents/MacOS/codex") || !executable.includes(".app/") || !(await lstat(executable)).isFile()) throw new Error("UNSAFE_EXECUTABLE");
      if (home === process.env.HOME || home === join(process.env.HOME ?? "", ".codex") ||
        !(await lstat(home)).isDirectory() || ((await lstat(home)).mode & 0o077) !== 0) throw new Error("UNSAFE_HOME");
      const fixture = await mkdtemp(join(evidenceRoot, "synthetic-"));
      await mkdir(join(fixture, "tmp"), { mode: 0o700 });
      tunnel = await createOfficialTunnel();
      const policy = join(fixture, "boundary.sb");
      await writeFile(policy, syntheticSeatbelt({ executable, home, fixture, port: tunnel.port }), { mode: 0o600 });
      if (abort.aborted) throw new Error("CANCELLED");
      const overrides = Object.entries(CODEX_SYNTHETIC_CONFIG).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]);
      const child = spawn("/usr/bin/sandbox-exec", ["-f", policy, executable, "app-server", ...overrides], {
        cwd: fixture, shell: false, stdio: ["pipe", "pipe", "pipe"],
        env: { HOME: process.env.HOME, PATH: "/usr/bin:/bin", TMPDIR: join(fixture, "tmp"), CODEX_HOME: home,
          HTTPS_PROXY: `http://127.0.0.1:${tunnel.port}`, HTTP_PROXY: `http://127.0.0.1:${tunnel.port}`,
          ALL_PROXY: `http://127.0.0.1:${tunnel.port}`, https_proxy: `http://127.0.0.1:${tunnel.port}`, http_proxy: `http://127.0.0.1:${tunnel.port}` }
      });
      channel = new AppServerChannel(child, { onEvent: (event) => {
        if (event.method === "turn/completed") { events.push(event); if (events.length > 1) throw new Error(); completionResolve(event); }
      }});
      this.#channel = channel;
      timer = setTimeout(() => channel.fail("TIMEOUT"), 60_000);
      abort.addEventListener("abort", cancel, { once: true });
      const hello = await channel.request("initialize", { clientInfo: { name: "netnavr_synthetic_probe", version: "0.1.0" }, capabilities: { experimentalApi: true } });
      if (typeof hello.userAgent !== "string" || !hello.userAgent.includes(`/${CODEX_SYNTHETIC_VERSION} `) || hello.codexHome !== home) throw new Error("UNSUPPORTED_VERSION");
      channel.initialized();
      const effective = await channel.request("config/read", { cwd: fixture, includeLayers: true });
      const requirements = await channel.request("configRequirements/read");
      assertCodexConfig(effective.config, requirements, effective.layers);
      const account = await channel.request("account/read", { refreshToken: false });
      if (account.account?.type !== "chatgpt") throw new Error("AUTH_REQUIRED");
      const started = await channel.request("thread/start", { cwd: fixture, ephemeral: true, environments: [],
        dynamicTools: [], selectedCapabilityRoots: [], baseInstructions: SYNTHETIC_INSTRUCTIONS,
        developerInstructions: SYNTHETIC_INSTRUCTIONS, approvalPolicy: "never", sandbox: "read-only",
        model: "gpt-5.5", config: CODEX_SYNTHETIC_CONFIG });
      const skills = await channel.request("skills/list", { cwds: [fixture], forceReload: true });
      assertEmptyContext(started, skills);
      threadId = started.thread.id;
      if (typeof threadId !== "string" || threadId.length > 128) throw new Error("INVALID_PREFLIGHT");
      if (abort.aborted) throw new Error("CANCELLED");
      if (marker === null) result = { state: "CONTEXT_VERIFIED", remoteValidity: "NOT_VERIFIED" };
      else {
        modelRequest = true;
        const turn = await channel.request("turn/start", { threadId, input: [{ type: "text", text: `Return only ${marker}.`, text_elements: [] }],
          environments: [], approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false } });
        turnId = turn.turn?.id;
        if (typeof turnId !== "string" || turnId.length > 128) throw new Error("INVALID_PREFLIGHT");
        this.#phase = "RUNNING";
        if (abort.aborted) cancel();
        const done = await Promise.race([completion, channel.failed.then((code) => { throw new Error(code); }), channel.closed.then(() => { throw new Error(channel.fault ?? "PROCESS_CLOSED"); })]);
        result = parseSyntheticCompletion(done, threadId, turnId, marker);
        // Cancel wins before any Core commit, even if a completed response raced it.
        if (abort.aborted) result = { state: "CANCELLED" };
        if (channel.fault) throw new Error(channel.fault);
      }
      // Blocked background destinations remain blocked and are reported.
      // Their attempted connection does not invalidate a completed safe turn.
    } catch (error) {
      result = { state: abort.aborted ? "CANCELLED" : SAFE_CODES.has(error.message) ? error.message : "PREFLIGHT_FAILED",
        ...(error.rpcMethod ? { stage: error.rpcMethod, rpcCode: error.rpcCode, rpcHints: error.rpcHints } : {}),
        ...(Object.hasOwn(CODEX_SYNTHETIC_CONFIG, error.policyKey ?? "") ? { policyKey: error.policyKey } : {}),
        ...(error.layerSummary ? { layerSummary: error.layerSummary } : {}),
        ...(["mcp_servers", "plugins", "hooks", "model_providers", "instructions", "model_instructions_file", "experimental_compact_prompt_file", "model_catalog_json", "openai_base_url", "chatgpt_base_url", "experimental_thread_store_endpoint"].includes(error.control) ? { control: error.control } : {}) };
    } finally {
      clearTimeout(timer); clearTimeout(cancelTimer); abort.removeEventListener("abort", cancel);
      const cleanup = channel ? await channel.close() : "CONFIRMED";
      if (cleanup !== "CONFIRMED") { this.#cleanupUnconfirmed = true; result = { state: "PROCESS_CLEANUP_UNCONFIRMED" }; }
      if (tunnel) { result.egress = { attempts: tunnel.attempts, denied: tunnel.denied, denialKinds: tunnel.denialKinds }; await tunnel.close(); }
      this.#channel = null; this.#controller = null; this.#busy = false; this.#phase = "IDLE";
    }
    return { ...result, runId, modelRequest };
  }
}
