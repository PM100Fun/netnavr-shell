import { spawn } from "node:child_process";
import { mkdtemp, realpath, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

export const PROBE_LIMITS = Object.freeze({
  timeoutMs: 5_000,
  maxTimeoutMs: 15_000,
  maxOutputBytes: 16_384,
  killGraceMs: 250
});

const PROVIDERS = Object.freeze(["codex", "claude"]);
const ENV_KEYS = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP",
  "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "CODEX_HOME"
]);

function assertProvider(provider) {
  if (!PROVIDERS.includes(provider)) throw new TypeError("UNKNOWN_PROVIDER");
}

// Keep the official tool's own credential store; never copy or deserialize it.
// API keys, provider routing and proxy variables are not inherited by the child.
export function statusEnvironment(source = process.env) {
  return Object.fromEntries(Object.entries(source).filter(([key, value]) =>
    ENV_KEYS.has(key.toUpperCase()) && typeof value === "string"));
}

export async function resolveExecutable(provider, env = process.env, platform = process.platform) {
  assertProvider(provider);
  const path = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  const names = platform === "win32" ? [`${provider}.exe`] : [provider];
  for (const entry of path.split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(entry.replace(/^"|"$/g, ""), name);
      try {
        if ((await stat(candidate)).isFile()) return await realpath(candidate);
      } catch { /* Missing PATH entries are normal. */ }
    }
  }
  return null;
}

function parseVersion(provider, output) {
  // Deliberately accept only known version-line shapes, not arbitrary CLI text.
  const pattern = provider === "codex"
    ? /^codex-cli (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$/
    : /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?) \(Claude Code\)\s*$/;
  return output.trim().match(pattern)?.[1] ?? null;
}

function authSummary(provider, output, code) {
  if (provider === "codex") {
    if (code === 0 && output.trim() === "Logged in using ChatGPT") {
      return { state: "PRESENT", kind: "chatgpt", remoteValidity: "NOT_VERIFIED" };
    }
    if (code === 1 && output.trim() === "Not logged in") {
      return { state: "NOT_LOGGED_IN", kind: null, remoteValidity: "NOT_VERIFIED" };
    }
    if (/Logged in using (?:an API key|API key|Amazon Bedrock|access token|personal access token)/.test(output)) {
      return { state: "UNSUPPORTED_AUTH", kind: "non-chatgpt", remoteValidity: "NOT_VERIFIED" };
    }
  } else {
    try {
      const data = JSON.parse(output);
      // Account name, email, organization and unknown fields never leave this parser.
      if (code === 1 && data.loggedIn === false) return { state: "NOT_LOGGED_IN", kind: null, remoteValidity: "NOT_VERIFIED" };
      if (code === 0 && data.loggedIn === true && data.authMethod === "claude.ai") {
        return { state: "PRESENT", kind: "claude.ai", remoteValidity: "NOT_VERIFIED" };
      }
      if (code === 0 && data.loggedIn === true) return { state: "UNSUPPORTED_AUTH", kind: "non-claude.ai", remoteValidity: "NOT_VERIFIED" };
    } catch { /* Unknown formats are rejected, never echoed. */ }
  }
  return { state: "UNKNOWN", kind: null, remoteValidity: "NOT_VERIFIED" };
}

export function providerBounds(provider) {
  assertProvider(provider);
  return {
    provider,
    modelRequests: "BLOCKED",
    candidate: "NOT_CANDIDATE",
    code: "ISOLATION_NOT_VERIFIED",
    reasons: provider === "codex" ? [
      "Global CODEX_HOME instructions and host skills have not been excluded from synthetic model context; project_doc_max_bytes=0 is insufficient.",
      "Read-only sandbox does not by itself restrict all file reads to the synthetic fixture.",
      "A verified runtime tool boundary and context preflight are required before enabling a real model turn."
    ] : [
      "Installed CLI, existing official login and managed settings have not been verified.",
      "No-tools, customization, MCP and egress restrictions require actual platform verification."
    ],
    limits: { ...PROBE_LIMITS },
    realResponse: "NOT_EXECUTED",
    realCancellation: "NOT_EXECUTED",
    fileAndCommandCounterexamples: "NOT_EXECUTED",
    networkAndQuota: "NOT_EXECUTED"
  };
}

// The handle belongs to this child only. There is no PID-based cancellation API,
// shell invocation, arbitrary command API, or model-run path in this M0 probe.
export class ProviderProbe {
  #spawn;
  #resolve;
  #active = null;
  #busy = false;
  #abort = null;
  #cleanupUnconfirmed = false;
  #env;

  constructor({ spawnProcess = spawn, findExecutable = resolveExecutable, env = process.env } = {}) {
    this.#spawn = spawnProcess;
    this.#resolve = findExecutable;
    this.#env = statusEnvironment(env);
  }

  cancel() {
    if (!this.#abort) return { state: "NO_ACTIVE_PROBE" };
    this.#abort.abort();
    return { state: "CANCEL_REQUESTED" };
  }

  run(provider) {
    return providerBounds(provider);
  }

  async status(provider, { checkAuth = false, signal, timeoutMs = PROBE_LIMITS.timeoutMs } = {}) {
    assertProvider(provider);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > PROBE_LIMITS.maxTimeoutMs) {
      throw new TypeError("INVALID_TIMEOUT");
    }
    if (this.#busy) return { provider, state: "BUSY", version: null, modelRequest: false };
    if (this.#cleanupUnconfirmed) return { provider, state: "PROCESS_CLEANUP_UNCONFIRMED", version: null, modelRequest: false };
    if (signal?.aborted) return { provider, state: "CANCELLED", version: null, modelRequest: false };
    this.#busy = true;
    this.#abort = new AbortController();
    signal = signal ? AbortSignal.any([signal, this.#abort.signal]) : this.#abort.signal;
    let cwd;
    try {
      const executable = await this.#resolve(provider, this.#env);
      if (signal.aborted) return { provider, state: "CANCELLED", version: null, modelRequest: false };
      if (!executable) return { provider, state: "NOT_INSTALLED", version: null, modelRequest: false };
      cwd = await mkdtemp(join(tmpdir(), "netnavr-provider-status-"));
      const versionResult = await this.#command(executable, ["--version"], cwd, signal, timeoutMs);
      if (versionResult.state !== "EXITED" || versionResult.code !== 0) {
        return { provider, state: versionResult.state === "EXITED" ? "CLI_FAILED" : versionResult.state,
          ...(versionResult.termination ? { termination: versionResult.termination } : {}), version: null, modelRequest: false };
      }
      const version = parseVersion(provider, versionResult.output);
      if (!version) return { provider, state: "UNSUPPORTED_VERSION_OUTPUT", version: null, modelRequest: false };
      const result = { provider, state: "INSTALLED", version, modelRequest: false,
        compatibility: "NOT_EVALUATED", auth: { state: "NOT_CHECKED", kind: null, remoteValidity: "NOT_VERIFIED" } };
      if (checkAuth) {
        const args = provider === "codex" ? ["login", "status"] : ["auth", "status"];
        const auth = await this.#command(executable, args, cwd, signal, timeoutMs);
        result.auth = auth.state === "EXITED" ? authSummary(provider, auth.output, auth.code)
          : { state: auth.state, ...(auth.termination ? { termination: auth.termination } : {}), kind: null, remoteValidity: "NOT_VERIFIED" };
      }
      return result;
    } finally {
      // Only the fresh directory returned by mkdtemp is removed, never a caller path.
      const root = resolve(tmpdir());
      try {
        if (cwd?.startsWith(root + (process.platform === "win32" ? "\\" : "/"))) {
          await rm(cwd, { recursive: true, force: true });
        }
      } finally { this.#busy = false; this.#abort = null; }
    }
  }

  #command(executable, args, cwd, signal, timeoutMs) {
    return new Promise((resolveResult) => {
      if (signal?.aborted) { resolveResult({ state: "CANCELLED" }); return; }
      let child;
      let settled = false;
      let stopReason = null;
      let output = "";
      let bytes = 0;
      let timer;
      let hardKill;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(hardKill);
        signal?.removeEventListener("abort", onAbort);
        if (this.#active === stop) this.#active = null;
        if (result.termination === "UNCONFIRMED") this.#cleanupUnconfirmed = true;
        resolveResult(result);
      };
      const stop = (reason) => {
        if (settled || stopReason) return;
        stopReason = reason;
        output = "";
        try { child.kill("SIGTERM"); } catch { /* close/error or deadline still settle. */ }
        hardKill = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* Outcome remains explicit. */ }
          // Avoid an unbounded wait if a broken process API never delivers close.
          finish({ state: reason, termination: "UNCONFIRMED" });
        }, PROBE_LIMITS.killGraceMs);
      };
      const onAbort = () => stop("CANCELLED");
      try {
        child = this.#spawn(executable, args, { cwd, env: this.#env, shell: false,
          windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      } catch { finish({ state: "SPAWN_FAILED" }); return; }
      this.#active = stop;
      const onData = (chunk) => {
        if (settled || stopReason) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > PROBE_LIMITS.maxOutputBytes) { stop("OUTPUT_LIMIT"); return; }
        output += chunk.toString();
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.once("error", () => finish({ state: "SPAWN_FAILED" }));
      child.once("close", (code) => finish(stopReason ? { state: stopReason, termination: "CONFIRMED" }
        : { state: "EXITED", code, output }));
      timer = setTimeout(() => stop("TIMEOUT"), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }
}
