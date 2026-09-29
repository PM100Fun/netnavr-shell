import { StringDecoder } from "node:string_decoder";

// This transport has no arbitrary RPC entry point: model input is assembled by
// the synthetic provider, and every server-initiated capability request fails.
const METHODS = new Set(["initialize", "config/read", "configRequirements/read",
  "account/read", "skills/list", "thread/start", "turn/start", "turn/interrupt"]);
export class AppServerChannel {
  #child; #next = 0; #pending = new Map(); #buffer = ""; #decoder = new StringDecoder("utf8");
  #bytes = 0; #fault; #closed = false; #closing; #onEvent; #closeResolve; #failureResolve;
  constructor(child, { onEvent = () => {}, maxBytes = 2_097_152, rpcTimeoutMs = 10_000 } = {}) {
    this.#child = child; this.#onEvent = onEvent; this.rpcTimeoutMs = rpcTimeoutMs;
    this.failed = new Promise((resolve) => { this.#failureResolve = resolve; });
    this.closed = new Promise((resolve) => { this.#closeResolve = resolve; });
    const count = (chunk) => {
      this.#bytes += Buffer.byteLength(chunk);
      if (this.#bytes > maxBytes) { this.fail("OUTPUT_LIMIT"); return false; }
      return !this.#fault;
    };
    child.stderr.on("data", count); // Count diagnostics, never retain or expose them.
    child.stdout.on("data", (chunk) => {
      if (!count(chunk)) return;
      this.#buffer += this.#decoder.write(chunk);
      while (this.#buffer.includes("\n") && !this.#fault) {
        const split = this.#buffer.indexOf("\n");
        const line = this.#buffer.slice(0, split); this.#buffer = this.#buffer.slice(split + 1);
        let message;
        try { message = JSON.parse(line); } catch { this.fail("INVALID_PROTOCOL"); break; }
        if (!message || typeof message !== "object" || Array.isArray(message)) { this.fail("INVALID_PROTOCOL"); break; }
        if (message.method && message.id !== undefined) { this.fail("UNEXPECTED_CAPABILITY_REQUEST"); break; }
        if (message.id !== undefined) {
          const pending = this.#pending.get(message.id);
          if (!pending) { this.fail("UNEXPECTED_RESPONSE"); break; }
          clearTimeout(pending.timer); this.#pending.delete(message.id);
          if (message.error || !("result" in message)) {
            const error = new Error("RPC_REJECTED"); error.rpcMethod = pending.method;
            error.rpcCode = Number.isSafeInteger(message.error?.code) ? message.error.code : null;
            const diagnostic = String(message.error?.message ?? "").toLowerCase();
            error.rpcHints = ["network", "proxy", "permission", "decode", "parse", "auth", "refresh", "config", "workspace", "policy", "login", "request", "account", "unavailable"].filter((word) => diagnostic.includes(word));
            pending.reject(error);
          }
          else pending.resolve(message.result);
        } else if (typeof message.method === "string") {
          try { this.#onEvent(message); } catch { this.fail("INVALID_EVENT"); }
        } else this.fail("INVALID_PROTOCOL");
      }
    });
    child.stdin.on("error", () => this.fail("PIPE_FAILED"));
    child.once("error", () => this.fail("SPAWN_FAILED"));
    child.once("close", () => {
      this.#closed = true;
      for (const p of this.#pending.values()) { clearTimeout(p.timer); p.reject(new Error("PROCESS_CLOSED")); }
      this.#pending.clear(); this.#closeResolve();
    });
  }
  get fault() { return this.#fault; }
  request(method, params = {}) {
    if (!METHODS.has(method)) return Promise.reject(new Error("METHOD_NOT_ALLOWED"));
    if (this.#fault || this.#closed || this.#closing) return Promise.reject(new Error(this.#fault ?? "PROCESS_CLOSED"));
    return new Promise((resolve, reject) => {
      const id = ++this.#next;
      const timer = setTimeout(() => this.fail("RPC_TIMEOUT"), this.rpcTimeoutMs);
      this.#pending.set(id, { resolve, reject, timer, method });
      try { this.#child.stdin.write(JSON.stringify({ id, method, params }) + "\n"); }
      catch { this.fail("PIPE_FAILED"); }
    });
  }
  initialized() {
    if (this.#fault || this.#closed) throw new Error(this.#fault ?? "PROCESS_CLOSED");
    this.#child.stdin.write('{"method":"initialized","params":{}}\n');
  }
  fail(code) {
    if (this.#fault) return;
    this.#fault = code; this.#buffer = ""; this.#failureResolve(code);
    for (const p of this.#pending.values()) { clearTimeout(p.timer); p.reject(new Error(code)); }
    this.#pending.clear();
    try { this.#child.kill("SIGTERM"); } catch { /* close() records the outcome. */ }
  }
  close({ graceMs = 500, deadlineMs = 1_500 } = {}) {
    if (this.#closing) return this.#closing;
    this.#closing = (async () => {
      if (this.#closed) return "CONFIRMED";
      try { this.#child.stdin.end(); } catch { /* Bounded termination below. */ }
      const soft = setTimeout(() => { try { this.#child.kill("SIGTERM"); } catch {} }, graceMs);
      const hard = setTimeout(() => { try { this.#child.kill("SIGKILL"); } catch {} }, Math.max(graceMs, deadlineMs - 100));
      let deadline;
      await Promise.race([this.closed, new Promise((resolve) => { deadline = setTimeout(resolve, deadlineMs); })]);
      clearTimeout(soft); clearTimeout(hard); clearTimeout(deadline);
      if (!this.#closed) {
        this.fail("PROCESS_CLEANUP_UNCONFIRMED");
        this.#child.stdin.destroy(); this.#child.stdout.destroy(); this.#child.stderr.destroy(); this.#child.unref();
      }
      return this.#closed ? "CONFIRMED" : "UNCONFIRMED";
    })();
    return this.#closing;
  }
}
