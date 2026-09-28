import {
  FIXTURE_CONTRACT_VERSION,
  FIXTURE_SCHEMA_VERSION,
  FIXTURE_VERSION_HEADER,
  FIXTURE_STATE_PATH,
  FIXTURE_COMMANDS_PATH,
  FIXTURE_MAX_DELAY_MS,
  FIXTURE_MAX_TIMEOUT_MS,
  type FixtureCommandInput,
  type FixtureCommandResult,
  type FixtureState,
} from "@netnavr/core/fixture-contract";

export const FIXTURE_CHANNELS = Object.freeze({
  start: "netnavr:fixture:start",
  stop: "netnavr:fixture:stop",
  state: "netnavr:fixture:state",
  submit: "netnavr:fixture:submit",
  read: "netnavr:fixture:read",
  cancel: "netnavr:fixture:cancel",
});
export const FIXTURE_RESPONSE_LIMIT = 16 * 1024;
export const FIXTURE_REQUEST_TIMEOUT_MS = 2_000;
const COMMAND_ID = /^cmd_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SESSION_ID = /^fixture_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type FixtureBridgeFailure = { ok: false; error: { code: string; message: string } };
export type FixtureBridgeResult<T> = { ok: true; value: T } | FixtureBridgeFailure;
export type FixtureLifecycle = { state: "stopped" | "starting" | "online" | "stopping" | "error" };
export type FixtureReadout = FixtureLifecycle & { fixture?: FixtureState };

export function parseFixtureInput(value: unknown): FixtureCommandInput {
  if (!record(value) || Object.keys(value).some((key) => !["commandId", "operation", "marker", "delayMs", "timeoutMs"].includes(key)) ||
    !isCommandId(value.commandId) || value.operation !== "set-marker" ||
    (value.marker !== "alpha" && value.marker !== "beta") ||
    (value.delayMs !== undefined && !boundedInteger(value.delayMs, 0, FIXTURE_MAX_DELAY_MS)) ||
    (value.timeoutMs !== undefined && !boundedInteger(value.timeoutMs, 1, FIXTURE_MAX_TIMEOUT_MS))) {
    throw new TypeError("Only a bounded synthetic marker command is allowed");
  }
  return { commandId: value.commandId, operation: "set-marker", marker: value.marker,
    ...(value.delayMs !== undefined ? { delayMs: value.delayMs as number } : {}),
    ...(value.timeoutMs !== undefined ? { timeoutMs: value.timeoutMs as number } : {}) };
}
export function parseFixtureCommandId(value: unknown): string {
  if (!isCommandId(value)) throw new TypeError("Invalid engineering command ID");
  return value;
}
export function parseFixtureState(value: unknown): FixtureState {
  if (!record(value) || value.contractVersion !== FIXTURE_CONTRACT_VERSION ||
    typeof value.fixtureSessionId !== "string" || !SESSION_ID.test(value.fixtureSessionId) ||
    typeof value.persistence !== "string" || !["memory-only", "isolated-fixture"].includes(value.persistence) ||
    value.fixtureSchemaVersion !== FIXTURE_SCHEMA_VERSION || value.commandPersistence !== "session-only" ||
    typeof value.marker !== "string" || !["empty", "alpha", "beta"].includes(value.marker) ||
    !Number.isSafeInteger(value.revision) || (value.revision as number) < 0) throw new TypeError("Invalid Core fixture state");
  // Project only declared fields. A compromised peer cannot smuggle credentials.
  return { contractVersion: FIXTURE_CONTRACT_VERSION, fixtureSessionId: value.fixtureSessionId,
    persistence: value.persistence as FixtureState["persistence"], fixtureSchemaVersion: FIXTURE_SCHEMA_VERSION,
    commandPersistence: "session-only", marker: value.marker as FixtureState["marker"], revision: value.revision as number };
}
export function parseFixtureCommandResult(value: unknown): FixtureCommandResult {
  if (!record(value) || value.contractVersion !== FIXTURE_CONTRACT_VERSION || !isCommandId(value.commandId) ||
    value.operation !== "set-marker" || typeof value.status !== "string" || !["pending", "completed", "cancelled", "timed_out", "storage_error"].includes(value.status)) {
    throw new TypeError("Invalid Core fixture command result");
  }
  const state = parseFixtureState(value.state);
  if (value.fixtureSessionId !== state.fixtureSessionId) throw new TypeError("Mismatched fixture session");
  return { contractVersion: FIXTURE_CONTRACT_VERSION, fixtureSessionId: state.fixtureSessionId,
    commandId: value.commandId, operation: "set-marker", status: value.status as FixtureCommandResult["status"], state };
}

export function parseBridgeResult<T>(value: unknown, parser: (value: unknown) => T): FixtureBridgeResult<T> {
  if (!record(value)) throw new TypeError("Invalid desktop response");
  if (value.ok === true) return { ok: true, value: parser(value.value) };
  if (value.ok === false && record(value.error) && typeof value.error.code === "string" &&
    /^[a-z_]{1,64}$/.test(value.error.code) && typeof value.error.message === "string" && value.error.message.length <= 256) {
    return { ok: false, error: { code: value.error.code, message: value.error.message } };
  }
  throw new TypeError("Invalid desktop response");
}
export function parseFixtureReadout(value: unknown): FixtureReadout {
  if (!record(value) || typeof value.state !== "string" || !["stopped", "starting", "online", "stopping", "error"].includes(value.state)) {
    throw new TypeError("Invalid fixture lifecycle");
  }
  return { state: value.state as FixtureLifecycle["state"],
    ...(value.fixture !== undefined ? { fixture: parseFixtureState(value.fixture) } : {}) };
}

export class FixtureClient {
  private sessionId?: string;
  constructor(private readonly origin: string, private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch) {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin) ||
      Number(new URL(origin).port) < 1 || Number(new URL(origin).port) > 65_535 ||
      !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new TypeError("Invalid private Core connection");
  }
  state(signal?: AbortSignal): Promise<FixtureBridgeResult<FixtureState>> {
    return this.request(FIXTURE_STATE_PATH, "GET", (value) => {
      const state = parseFixtureState(value);
      this.checkSession(state.fixtureSessionId);
      return state;
    }, undefined, signal);
  }
  submit(input: FixtureCommandInput, signal?: AbortSignal): Promise<FixtureBridgeResult<FixtureCommandResult>> {
    return this.request(FIXTURE_COMMANDS_PATH, "POST", (value) => this.checkCommand(value, input.commandId), parseFixtureInput(input), signal);
  }
  read(commandId: string, signal?: AbortSignal): Promise<FixtureBridgeResult<FixtureCommandResult>> {
    return this.request(`${FIXTURE_COMMANDS_PATH}/${parseFixtureCommandId(commandId)}`, "GET", (value) => this.checkCommand(value, commandId), undefined, signal);
  }
  cancel(commandId: string, signal?: AbortSignal): Promise<FixtureBridgeResult<FixtureCommandResult>> {
    return this.request(`${FIXTURE_COMMANDS_PATH}/${parseFixtureCommandId(commandId)}/cancel`, "POST", (value) => this.checkCommand(value, commandId), undefined, signal);
  }
  private checkSession(sessionId: string): void {
    if (this.sessionId !== undefined && this.sessionId !== sessionId) throw new TypeError("Stale Core fixture session");
    this.sessionId = sessionId;
  }
  private checkCommand(value: unknown, commandId: string): FixtureCommandResult {
    const result = parseFixtureCommandResult(value);
    if (result.commandId !== commandId) throw new TypeError("Mismatched Core command ID");
    this.checkSession(result.fixtureSessionId);
    return result;
  }
  private async request<T>(pathname: string, method: "GET" | "POST", parse: (value: unknown) => T,
    body?: FixtureCommandInput, signal?: AbortSignal): Promise<FixtureBridgeResult<T>> {
    const deadline = AbortSignal.timeout(FIXTURE_REQUEST_TIMEOUT_MS);
    let received = false;
    try {
      const response = await this.fetchImpl(`${this.origin}${pathname}`, {
        method, headers: { Authorization: `Bearer ${this.token}`, [FIXTURE_VERSION_HEADER]: FIXTURE_CONTRACT_VERSION,
          ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer",
      });
      received = true;
      if (response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
        discard(response); return bridgeFailure("invalid_response", "Core returned an invalid engineering response");
      }
      const value = await readBoundedJson(response);
      if (!response.ok) {
        // Preserve a safe code, never peer-supplied error text or request tokens.
        const code = record(value) && record(value.error) && typeof value.error.code === "string" &&
          /^[a-z_]{1,64}$/.test(value.error.code) ? value.error.code : "http_status";
        return bridgeFailure(code, `Core rejected the engineering request (HTTP ${response.status})`);
      }
      return { ok: true, value: parse(value) };
    } catch {
      return bridgeFailure(signal?.aborted ? "cancelled" : deadline.aborted ? "timeout" : received ? "invalid_response" : "unavailable",
        signal?.aborted ? "Engineering request was cancelled" : deadline.aborted ? "Core request timed out" : received ? "Core returned an invalid or stale engineering response" : "Core engineering request could not be completed");
    }
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > FIXTURE_RESPONSE_LIMIT)) {
    discard(response); throw new RangeError("Response size limit");
  }
  if (!response.body) throw new TypeError("Missing response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > FIXTURE_RESPONSE_LIMIT) {
        void reader.cancel().catch(() => undefined);
        throw new RangeError("Response size limit");
      }
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
function discard(response: Response): void {
  try { void response.body?.cancel().catch(() => undefined); } catch { /* keep diagnostic */ }
}
export function bridgeFailure(code: string, message: string): FixtureBridgeFailure {
  return { ok: false, error: { code, message } };
}
function isCommandId(value: unknown): value is string { return typeof value === "string" && COMMAND_ID.test(value); }
function boundedInteger(value: unknown, min: number, max: number): boolean { return Number.isInteger(value) && (value as number) >= min && (value as number) <= max; }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
