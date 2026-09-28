import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";

import { CodexAgent } from "@netnavr/shell-codex-client";
import { MockAgent, ModelRouter } from "@netnavr/shell-model-router";
import {
  parseClientMessage,
  serializeShellEvent,
  SHELL_PROTOCOL_VERSION,
  SHELL_WEBSOCKET_AUTH_PREFIX,
  SHELL_WEBSOCKET_PROTOCOL,
  type ApprovalPolicy,
  type ClientMessage,
  type RunRequest,
  type SandboxMode,
  type ShellEvent,
  type ShellRunId
} from "@netnavr/shell-protocol";
import { WebSocketServer, type RawData, type WebSocket } from "ws";

import { createRecentRunRequestIds, type RecentRunRequestIds } from "./recentRunRequests.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const MAX_WEBSOCKET_PAYLOAD_BYTES = 128 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);

export const SHELL_HTTP_REQUEST_ID_HEADER = "x-request-id";
export const SHELL_MAX_HEADER_BYTES = 8 * 1024;
export const SHELL_MAX_REQUEST_BODY_BYTES = 0;
export const SHELL_HEADERS_TIMEOUT_MS = 5_000;
export const SHELL_REQUEST_TIMEOUT_MS = 10_000;
export const SHELL_KEEP_ALIVE_TIMEOUT_MS = 5_000;
export const SHELL_MAX_REQUESTS_PER_SOCKET = 100;
export const SHELL_MAX_AUTHENTICATED_WEBSOCKET_CLIENTS = 4;

export type ShellHttpErrorCode =
  | "invalid_request_target"
  | "method_not_allowed"
  | "not_found"
  | "request_body_not_allowed";

export type ShellHttpErrorEnvelope = {
  error: {
    code: ShellHttpErrorCode;
    message: string;
  };
  requestId: string;
};

export type AgentServerOptions = {
  host?: string;
  port?: number;
  workspaceRoot?: string;
  sessionToken?: string;
  sandboxMode?: SandboxMode;
  approvalPolicy?: ApprovalPolicy;
};

export type AgentServerHandle = {
  host: string;
  port: number;
  url: string;
  webSocketUrl: string;
  workspaceRoot: string;
  sessionToken: string;
  close: () => Promise<void>;
};

export async function startAgentServer(options: AgentServerOptions = {}): Promise<AgentServerHandle> {
  const host = normalizeLoopbackHost(options.host);
  const port = normalizePort(options.port ?? process.env.PORT);
  const workspaceRoot = await resolveWorkspaceRoot(options.workspaceRoot ?? process.env.NETNAVR_SHELL_WORKSPACE);
  const sessionToken = normalizeSessionToken(options.sessionToken ?? process.env.NETNAVR_SHELL_SESSION_TOKEN);
  const sandboxMode = options.sandboxMode ?? "read-only";
  const approvalPolicy = options.approvalPolicy ?? "never";

  const router = new ModelRouter();
  router.register(new MockAgent());
  router.register(new CodexAgent());
  const recentRunRequestIds = createRecentRunRequestIds();

  const server = http.createServer(
    {
      headersTimeout: SHELL_HEADERS_TIMEOUT_MS,
      insecureHTTPParser: false,
      keepAliveTimeout: SHELL_KEEP_ALIVE_TIMEOUT_MS,
      maxHeaderSize: SHELL_MAX_HEADER_BYTES,
      requestTimeout: SHELL_REQUEST_TIMEOUT_MS,
      requireHostHeader: true
    },
    (request, response) => {
      routeHttpRequest(request, response, router);
    }
  );
  server.maxRequestsPerSocket = SHELL_MAX_REQUESTS_PER_SOCKET;

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES,
    handleProtocols: (protocols) => (protocols.has(SHELL_WEBSOCKET_PROTOCOL) ? SHELL_WEBSOCKET_PROTOCOL : false)
  });

  server.on("upgrade", (request, socket, head) => {
    const requestId = createRequestId();
    if (request.method !== "GET" || request.url !== "/ws") {
      rejectWebSocketUpgrade(socket, 400, "Bad Request", requestId);
      return;
    }

    const offeredProtocols = parseWebSocketProtocols(request.headers["sec-websocket-protocol"]);

    if (
      !offeredProtocols.includes(SHELL_WEBSOCKET_PROTOCOL) ||
      !hasValidSessionProtocol(offeredProtocols, sessionToken)
    ) {
      rejectWebSocketUpgrade(socket, 401, "Unauthorized", requestId);
      return;
    }

    if (wss.clients.size >= SHELL_MAX_AUTHENTICATED_WEBSOCKET_CLIENTS) {
      rejectWebSocketUpgrade(socket, 503, "Service Unavailable", requestId);
      return;
    }

    wss.handleUpgrade(request, socket, head, (webSocket) => {
      wss.emit("connection", webSocket, request);
    });
  });

  wss.on("connection", (socket) => {
    let activeRun: ActiveRun | null = null;
    send(socket, {
      type: "shell.ready",
      protocolVersion: SHELL_PROTOCOL_VERSION,
      providers: router.providers(),
      workspace: workspaceRoot
    });

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        send(socket, { type: "log", level: "error", message: "Binary client messages are not supported" });
        return;
      }

      void handleClientMessage(data, socket, {
        getActiveRun: () => activeRun,
        setActiveRun: (run) => {
          activeRun = run;
        },
        router,
        recentRunRequestIds,
        workspaceRoot,
        sandboxMode,
        approvalPolicy
      }).catch((error: unknown) => {
        send(socket, {
          type: "log",
          level: "error",
          message: error instanceof Error ? error.message : "Unable to handle client message"
        });
      });
    });

    socket.on("close", () => {
      activeRun?.controller.abort();
      activeRun = null;
    });

    socket.on("error", () => {
      activeRun?.controller.abort();
      activeRun = null;
    });
  });

  await listen(server, host, port);
  const actualPort = getListeningPort(server);
  const urlHost = host === "::1" ? "[::1]" : host;
  let closePromise: Promise<void> | undefined;

  return {
    host,
    port: actualPort,
    url: `http://${urlHost}:${actualPort}`,
    webSocketUrl: `ws://${urlHost}:${actualPort}/ws`,
    workspaceRoot,
    sessionToken,
    close: () => {
      closePromise ??= closeAgentServer(server, wss);
      return closePromise;
    }
  };
}

type ActiveRun = {
  runId: ShellRunId;
  controller: AbortController;
};

type MessageContext = {
  getActiveRun: () => ActiveRun | null;
  setActiveRun: (run: ActiveRun | null) => void;
  router: ModelRouter;
  recentRunRequestIds: RecentRunRequestIds;
  workspaceRoot: string;
  sandboxMode: SandboxMode;
  approvalPolicy: ApprovalPolicy;
};

async function handleClientMessage(data: RawData, socket: WebSocket, context: MessageContext): Promise<void> {
  let rawMessage: unknown;
  try {
    rawMessage = JSON.parse(data.toString());
  } catch {
    send(socket, { type: "log", level: "error", message: "Client message must be valid JSON" });
    return;
  }

  const parsed = parseClientMessage(rawMessage);
  if (!parsed.ok) {
    send(socket, { type: "log", level: "error", message: parsed.error });
    return;
  }

  const message: ClientMessage = parsed.value;
  if (message.type === "cancel") {
    const activeRun = context.getActiveRun();
    if (!activeRun || activeRun.runId !== message.runId) {
      send(socket, { type: "cancel.rejected", runId: message.runId, reason: "run_not_active" });
      return;
    }

    activeRun.controller.abort();
    return;
  }

  if (context.recentRunRequestIds.has(message.requestId)) {
    send(socket, { type: "run.rejected", requestId: message.requestId, reason: "request_replayed" });
    return;
  }

  if (context.getActiveRun()) {
    send(socket, { type: "run.rejected", requestId: message.requestId, reason: "run_in_progress" });
    return;
  }

  context.recentRunRequestIds.remember(message.requestId);
  const runId = createRunId();
  const activeAbort = new AbortController();
  context.setActiveRun({ runId, controller: activeAbort });

  const request: RunRequest = {
    runId,
    ...message.request,
    cwd: context.workspaceRoot,
    sandboxMode: context.sandboxMode,
    approvalPolicy: context.approvalPolicy
  };

  send(socket, {
    type: "run.started",
    requestId: message.requestId,
    runId,
    provider: request.provider
  });

  let sawTerminalEvent = false;
  try {
    for await (const event of context.router.run(request, activeAbort.signal)) {
      if (activeAbort.signal.aborted) break;
      send(socket, event);
      if (event.type === "turn.completed" || event.type === "turn.failed") {
        sawTerminalEvent = true;
        if (context.getActiveRun()?.runId === runId) {
          context.setActiveRun(null);
        }
        break;
      }
    }

    if (!activeAbort.signal.aborted && !sawTerminalEvent) {
      send(socket, {
        type: "turn.failed",
        runId,
        provider: request.provider,
        error: "Agent run ended without a terminal event"
      });
    }
  } catch (error) {
    if (!activeAbort.signal.aborted) {
      send(socket, {
        type: "turn.failed",
        runId,
        provider: request.provider,
        error: error instanceof Error ? error.message : "Agent run failed"
      });
    }
  } finally {
    if (context.getActiveRun()?.runId === runId) {
      if (activeAbort.signal.aborted) {
        send(socket, { type: "run.cancelled", runId });
      }
      context.setActiveRun(null);
    }
  }
}

function createRunId(): ShellRunId {
  return `run_${randomUUID()}`;
}

function createRequestId(): string {
  return `req_${randomUUID()}`;
}

function routeHttpRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  router: ModelRouter
): void {
  const requestId = createRequestId();

  if (requestHasBody(request)) {
    request.resume();
    writeError(
      response,
      413,
      requestId,
      "request_body_not_allowed",
      "Shell read-only diagnostics do not accept request bodies",
      { connection: "close" }
    );
    return;
  }

  let pathname: string;
  try {
    pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  } catch {
    request.resume();
    writeError(
      response,
      400,
      requestId,
      "invalid_request_target",
      "Request target is invalid",
      { connection: "close" }
    );
    return;
  }

  const isKnownRoute = pathname === "/health" || pathname === "/api/providers";
  if (isKnownRoute && request.method !== "GET") {
    writeError(response, 405, requestId, "method_not_allowed", "Method not allowed", { allow: "GET" });
    return;
  }

  if (request.method === "GET" && pathname === "/health") {
    writeJson(response, 200, { ok: true, providers: router.providers() }, requestId);
    return;
  }

  if (request.method === "GET" && pathname === "/api/providers") {
    writeJson(response, 200, { providers: router.providers() }, requestId);
    return;
  }

  writeError(response, 404, requestId, "not_found", "Route not found");
}

function requestHasBody(request: http.IncomingMessage): boolean {
  if (request.headers["transfer-encoding"] !== undefined) return true;

  const contentLength = request.headers["content-length"];
  if (contentLength === undefined) return false;

  const values = Array.isArray(contentLength) ? contentLength : [contentLength];
  return values.some((value) => {
    const normalized = value.trim();
    if (!/^\d+$/.test(normalized)) return true;

    const length = Number(normalized);
    return !Number.isSafeInteger(length) || length > SHELL_MAX_REQUEST_BODY_BYTES;
  });
}

function normalizeLoopbackHost(host: string | undefined): string {
  const normalized = host?.trim() || DEFAULT_HOST;
  if (!LOOPBACK_HOSTS.has(normalized)) {
    throw new Error(`Agent server host must be a numeric loopback address; received ${normalized}`);
  }
  return normalized;
}

function normalizePort(value: number | string | undefined): number {
  if (value === undefined) return DEFAULT_PORT;

  if (typeof value === "string" && !/^\d+$/.test(value)) {
    throw new Error("Agent server port must be an integer between 0 and 65535");
  }

  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("Agent server port must be an integer between 0 and 65535");
  }
  return port;
}

async function resolveWorkspaceRoot(configuredRoot: string | undefined): Promise<string> {
  const root = configuredRoot === undefined ? process.cwd() : configuredRoot.trim();
  if (root.length === 0) {
    throw new Error("Agent server workspace must be a non-empty directory path");
  }

  const candidate = path.resolve(root);
  const resolved = await realpath(candidate);
  const details = await stat(resolved);
  if (!details.isDirectory()) throw new Error("Agent server workspace must be a directory");
  return resolved;
}

function normalizeSessionToken(token: string | undefined): string {
  if (token === undefined) return randomBytes(32).toString("base64url");
  const normalized = token.trim();
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(normalized)) {
    throw new Error("Agent server session token must be 32-256 base64url characters");
  }
  return normalized;
}

function parseWebSocketProtocols(header: string | string[] | undefined): string[] {
  if (header === undefined) return [];
  return (Array.isArray(header) ? header.join(",") : header)
    .split(",")
    .map((protocol) => protocol.trim())
    .filter(Boolean);
}

function hasValidSessionProtocol(protocols: readonly string[], sessionToken: string): boolean {
  const expected = `${SHELL_WEBSOCKET_AUTH_PREFIX}${sessionToken}`;
  return protocols.some((protocol) => safeEqual(protocol, expected));
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function rejectWebSocketUpgrade(
  socket: Duplex,
  statusCode: number,
  statusText: string,
  requestId: string
): void {
  if (socket.destroyed) return;
  socket.end(
    [
      `HTTP/1.1 ${statusCode} ${statusText}`,
      "Connection: close",
      "Content-Length: 0",
      "Cache-Control: no-store",
      "X-Content-Type-Options: nosniff",
      `${SHELL_HTTP_REQUEST_ID_HEADER}: ${requestId}`,
      "",
      ""
    ].join("\r\n")
  );
}

function closeAgentServer(server: http.Server, wss: WebSocketServer): Promise<void> {
  const serverClosed = new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });

  for (const client of wss.clients) client.terminate();
  const webSocketServerClosed = new Promise<void>((resolve, reject) => {
    wss.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });

  return Promise.all([serverClosed, webSocketServerClosed]).then(() => undefined);
}

function listen(server: http.Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function getListeningPort(server: http.Server): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Agent server did not expose a TCP address");
  return address.port;
}

function send(socket: WebSocket, event: ShellEvent): void {
  if (socket.readyState !== socket.OPEN) return;
  const serialized = serializeShellEvent(event);
  if (!serialized.ok) {
    throw new TypeError(`Server produced an invalid Shell event: ${serialized.error}`);
  }
  try {
    socket.send(serialized.value);
  } catch {
    socket.close(1011, "Unable to serialize server event");
  }
}

function writeJson(
  response: http.ServerResponse,
  status: number,
  body: unknown,
  requestId: string,
  additionalHeaders: http.OutgoingHttpHeaders = {}
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "cache-control": "no-store",
    ...additionalHeaders,
    "content-length": Buffer.byteLength(payload),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    [SHELL_HTTP_REQUEST_ID_HEADER]: requestId
  });
  response.end(payload);
}

function writeError(
  response: http.ServerResponse,
  status: number,
  requestId: string,
  code: ShellHttpErrorCode,
  message: string,
  additionalHeaders: http.OutgoingHttpHeaders = {}
): void {
  const body: ShellHttpErrorEnvelope = {
    error: { code, message },
    requestId
  };
  writeJson(response, status, body, requestId, additionalHeaders);
}
