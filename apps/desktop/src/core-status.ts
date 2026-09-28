// Modified for the repository split: consume Core's pinned wire contract.
import { CORE_SERVICE, CORE_API_VERSION, CORE_SCHEMA_VERSION } from "@netnavr/core/contract";

export const CORE_STATUS_CHANNEL = "netnavr:core-status";
export const DEFAULT_CORE_ORIGIN = "http://127.0.0.1:8786";
export const CORE_STATUS_TIMEOUT_MS = 2_000;
export const CORE_STATUS_MAX_RESPONSE_BYTES = 16 * 1024;

const NODE_ID_PATTERN =
  /^node_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_ID_PATTERN =
  /^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type CoreStatusOnline = {
  readonly state: "online";
  readonly service: typeof CORE_SERVICE;
  readonly status: "ok";
  readonly apiVersion: typeof CORE_API_VERSION;
  readonly version: string;
  readonly uptimeSeconds: number;
  readonly nodeId: string;
  readonly createdAt: string;
  readonly schemaVersion: typeof CORE_SCHEMA_VERSION;
  readonly requestIds: {
    readonly health?: string;
    readonly node?: string;
  };
};

export type CoreStatusFailure = {
  readonly state: "offline" | "incompatible" | "error";
  readonly code:
    | "unreachable"
    | "timeout"
    | "invalid_configuration"
    | "http_status"
    | "invalid_response"
    | "unexpected_service"
    | "unsupported_api_version"
    | "unsupported_schema_version";
  readonly message: string;
  readonly requestId?: string;
};

export type CoreStatusResult = CoreStatusOnline | CoreStatusFailure;

type CoreFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type CoreStatusOptions = {
  readonly fetchImpl?: CoreFetch;
  readonly origin?: string;
  readonly timeoutMs?: number;
};

type JsonEndpointResult =
  | {
      readonly ok: true;
      readonly value: unknown;
      readonly requestId?: string;
    }
  | {
      readonly ok: false;
      readonly failure: CoreStatusFailure;
    };

export async function fetchConfiguredCoreStatus(
  configuredPort: string | undefined,
  options: Omit<CoreStatusOptions, "origin"> = {},
): Promise<CoreStatusResult> {
  let origin: string;
  try {
    origin = coreOriginFromEnvironment(configuredPort);
  } catch {
    return failure(
      "error",
      "invalid_configuration",
      "NETNAVR_CORE_PORT must be an integer between 1 and 65535",
    );
  }

  return fetchCoreStatus({ ...options, origin });
}

export function coreOriginFromEnvironment(value: string | undefined): string {
  if (value === undefined) {
    return DEFAULT_CORE_ORIGIN;
  }
  if (!/^\d+$/.test(value)) {
    throw new RangeError("Core port is invalid");
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError("Core port is invalid");
  }
  return `http://127.0.0.1:${port}`;
}

export async function fetchCoreStatus(
  options: CoreStatusOptions = {},
): Promise<CoreStatusResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  let origin: string;
  try {
    origin = normalizeCoreOrigin(options.origin ?? DEFAULT_CORE_ORIGIN);
  } catch {
    return failure(
      "error",
      "invalid_configuration",
      "Core origin must be an explicit numeric loopback endpoint",
    );
  }
  const timeoutMs = options.timeoutMs ?? CORE_STATUS_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    return failure("error", "invalid_configuration", "Core timeout is invalid");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const health = await requestJson(fetchImpl, origin, "/v1/health", controller.signal);
    if (!health.ok) return health.failure;

    const healthPayload = health.value;
    if (isRecord(healthPayload)) {
      if (typeof healthPayload.service === "string" && healthPayload.service !== CORE_SERVICE) {
        return failure(
          "incompatible",
          "unexpected_service",
          "The loopback endpoint is not NetNavr Core",
          health.requestId,
        );
      }
      if (
        typeof healthPayload.apiVersion === "string" &&
        healthPayload.apiVersion !== CORE_API_VERSION
      ) {
        return failure(
          "incompatible",
          "unsupported_api_version",
          "Core API version is not supported by this Shell",
          health.requestId,
        );
      }
    }
    if (!isCoreHealth(healthPayload)) {
      return failure(
        "error",
        "invalid_response",
        "Core health response is invalid",
        health.requestId,
      );
    }

    const node = await requestJson(fetchImpl, origin, "/v1/node", controller.signal);
    if (!node.ok) return node.failure;

    const nodePayload = node.value;
    if (
      isRecord(nodePayload) &&
      typeof nodePayload.schemaVersion === "number" &&
      nodePayload.schemaVersion !== CORE_SCHEMA_VERSION
    ) {
      return failure(
        "incompatible",
        "unsupported_schema_version",
        "Core schema version is not supported by this Shell",
        node.requestId,
      );
    }
    if (!isCoreNode(nodePayload)) {
      return failure(
        "error",
        "invalid_response",
        "Core Node response is invalid",
        node.requestId,
      );
    }

    return {
      state: "online",
      service: healthPayload.service,
      status: healthPayload.status,
      apiVersion: healthPayload.apiVersion,
      version: healthPayload.version,
      uptimeSeconds: healthPayload.uptimeSeconds,
      nodeId: nodePayload.nodeId,
      createdAt: nodePayload.createdAt,
      schemaVersion: nodePayload.schemaVersion,
      requestIds: {
        ...(health.requestId ? { health: health.requestId } : {}),
        ...(node.requestId ? { node: node.requestId } : {}),
      },
    };
  } catch {
    if (controller.signal.aborted) {
      return failure("offline", "timeout", "Core did not respond before the local timeout");
    }
    return failure("offline", "unreachable", "Core is not reachable on numeric loopback");
  } finally {
    clearTimeout(timeout);
  }
}

export function parseCoreStatusResult(value: unknown): CoreStatusResult {
  if (!isRecord(value) || typeof value.state !== "string") {
    throw new TypeError("Core status result must be an object with a state");
  }

  if (value.state === "online") {
    if (!isCoreStatusOnline(value)) {
      throw new TypeError("Core online status is invalid");
    }
    return {
      state: value.state,
      service: value.service,
      status: value.status,
      apiVersion: value.apiVersion,
      version: value.version,
      uptimeSeconds: value.uptimeSeconds,
      nodeId: value.nodeId,
      createdAt: value.createdAt,
      schemaVersion: value.schemaVersion,
      requestIds: {
        ...(value.requestIds.health ? { health: value.requestIds.health } : {}),
        ...(value.requestIds.node ? { node: value.requestIds.node } : {}),
      },
    };
  }

  if (!isCoreStatusFailure(value)) {
    throw new TypeError("Core failure status is invalid");
  }
  return {
    state: value.state,
    code: value.code,
    message: value.message,
    ...(value.requestId ? { requestId: value.requestId } : {}),
  };
}

async function requestJson(
  fetchImpl: CoreFetch,
  origin: string,
  pathname: "/v1/health" | "/v1/node",
  signal: AbortSignal,
): Promise<JsonEndpointResult> {
  const response = await fetchImpl(new URL(pathname, origin), {
    method: "GET",
    headers: { accept: "application/json" },
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
    signal,
  });
  const requestId = normalizeRequestId(response.headers.get("x-request-id"));

  if (!response.ok) {
    discardResponseBody(response);
    return {
      ok: false,
      failure: failure(
        "error",
        "http_status",
        `Core ${pathname} returned HTTP ${response.status}`,
        requestId,
      ),
    };
  }

  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    discardResponseBody(response);
    return {
      ok: false,
      failure: failure(
        "error",
        "invalid_response",
        `Core ${pathname} did not return JSON`,
        requestId,
      ),
    };
  }

  try {
    return {
      ok: true,
      value: await readBoundedJson(response),
      ...(requestId ? { requestId } : {}),
    };
  } catch (error) {
    // Let the shared request deadline retain its timeout classification.
    if (signal.aborted) throw error;
    return {
      ok: false,
      failure: failure(
        "error",
        "invalid_response",
        `Core ${pathname} response is invalid or too large`,
        requestId,
      ),
    };
  }
}

function discardResponseBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // Cleanup must not replace the diagnostic failure with another error.
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) {
      discardResponseBody(response);
      throw new TypeError("Invalid content length");
    }
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length > CORE_STATUS_MAX_RESPONSE_BYTES) {
      discardResponseBody(response);
      throw new RangeError("Core response is too large");
    }
  }

  if (!response.body) {
    throw new TypeError("Core response body is missing");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > CORE_STATUS_MAX_RESPONSE_BYTES) {
        // Cleanup must not delay or replace the size-limit diagnostic.
        void reader.cancel().catch(() => undefined);
        throw new RangeError("Core response is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
}

function normalizeCoreOrigin(value: string): string {
  const match = /^http:\/\/127\.0\.0\.1:(\d+)$/.exec(value);
  if (!match) {
    throw new TypeError("Core origin must be an explicit numeric loopback endpoint");
  }

  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("Core origin must contain a valid port");
  }
  return `http://127.0.0.1:${port}`;
}

function isCoreHealth(value: unknown): value is {
  service: typeof CORE_SERVICE;
  status: "ok";
  apiVersion: typeof CORE_API_VERSION;
  version: string;
  uptimeSeconds: number;
} {
  return (
    isRecord(value) &&
    value.service === CORE_SERVICE &&
    value.status === "ok" &&
    value.apiVersion === CORE_API_VERSION &&
    isBoundedString(value.version, 64) &&
    Number.isInteger(value.uptimeSeconds) &&
    (value.uptimeSeconds as number) >= 0
  );
}

function isCoreNode(value: unknown): value is {
  nodeId: string;
  createdAt: string;
  schemaVersion: typeof CORE_SCHEMA_VERSION;
} {
  return (
    isRecord(value) &&
    typeof value.nodeId === "string" &&
    NODE_ID_PATTERN.test(value.nodeId) &&
    typeof value.createdAt === "string" &&
    isCanonicalIsoDate(value.createdAt) &&
    value.schemaVersion === CORE_SCHEMA_VERSION
  );
}

function isCoreStatusOnline(value: Record<string, unknown>): value is CoreStatusOnline {
  return (
    value.state === "online" &&
    value.service === CORE_SERVICE &&
    value.status === "ok" &&
    value.apiVersion === CORE_API_VERSION &&
    isBoundedString(value.version, 64) &&
    Number.isInteger(value.uptimeSeconds) &&
    (value.uptimeSeconds as number) >= 0 &&
    typeof value.nodeId === "string" &&
    NODE_ID_PATTERN.test(value.nodeId) &&
    typeof value.createdAt === "string" &&
    isCanonicalIsoDate(value.createdAt) &&
    value.schemaVersion === CORE_SCHEMA_VERSION &&
    isRecord(value.requestIds) &&
    (value.requestIds.health === undefined || isRequestId(value.requestIds.health)) &&
    (value.requestIds.node === undefined || isRequestId(value.requestIds.node))
  );
}

function isCoreStatusFailure(value: Record<string, unknown>): value is CoreStatusFailure {
  if (!isBoundedString(value.message, 256)) return false;
  if (value.requestId !== undefined && !isRequestId(value.requestId)) return false;

  if (value.state === "offline") {
    return value.code === "unreachable" || value.code === "timeout";
  }
  if (value.state === "incompatible") {
    return (
      value.code === "unexpected_service" ||
      value.code === "unsupported_api_version" ||
      value.code === "unsupported_schema_version"
    );
  }
  if (value.state === "error") {
    return (
      value.code === "invalid_configuration" ||
      value.code === "http_status" ||
      value.code === "invalid_response"
    );
  }
  return false;
}

function failure(
  state: CoreStatusFailure["state"],
  code: CoreStatusFailure["code"],
  message: string,
  requestId?: string,
): CoreStatusFailure {
  return {
    state,
    code,
    message,
    ...(requestId ? { requestId } : {}),
  };
}

function normalizeRequestId(value: string | null): string | undefined {
  return value !== null && REQUEST_ID_PATTERN.test(value) ? value : undefined;
}

function isRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value);
}

function isCanonicalIsoDate(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
