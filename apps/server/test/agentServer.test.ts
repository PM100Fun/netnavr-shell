import assert from "node:assert/strict";
import { once } from "node:events";
import { realpath } from "node:fs/promises";
import { connect } from "node:net";
import test from "node:test";

import {
  SHELL_PROTOCOL_VERSION,
  SHELL_WEBSOCKET_AUTH_PREFIX,
  SHELL_WEBSOCKET_PROTOCOL,
  type ShellEvent
} from "@netnavr/shell-protocol";
import WebSocket, { type RawData } from "ws";

import {
  SHELL_HTTP_REQUEST_ID_HEADER,
  SHELL_MAX_AUTHENTICATED_WEBSOCKET_CLIENTS,
  SHELL_MAX_HEADER_BYTES,
  startAgentServer,
  type AgentServerHandle
} from "../src/agentServer.js";

const sessionToken = "test_session_token_0123456789abcdef";
const firstRequestId = "req_12345678-1234-4123-8123-123456789abc";
const secondRequestId = "req_22345678-1234-4123-8123-123456789abc";
const thirdRequestId = "req_32345678-1234-4123-8123-123456789abc";
const staleRunId = "run_32345678-1234-4123-8123-123456789abc";
const shellHttpRequestIdPattern = /^req_[0-9a-f-]{36}$/;

test("rejects non-loopback listeners", async () => {
  await assert.rejects(
    startAgentServer({ host: "0.0.0.0", port: 0, workspaceRoot: process.cwd(), sessionToken }),
    /loopback/
  );
});

test("rejects malformed port environment values", async () => {
  const previousPort = process.env.PORT;

  try {
    for (const value of ["", " ", "\t", "8787.0", "1e3", "65536", "-1"]) {
      process.env.PORT = value;
      await assert.rejects(
        startAgentServer({ workspaceRoot: process.cwd(), sessionToken }),
        /Agent server port must be an integer between 0 and 65535/
      );
    }
  } finally {
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
  }
});

test("rejects blank workspace environment values", async () => {
  const previousWorkspace = process.env.NETNAVR_SHELL_WORKSPACE;

  try {
    for (const value of ["", " ", "\t"]) {
      process.env.NETNAVR_SHELL_WORKSPACE = value;
      await assert.rejects(
        startAgentServer({ port: 0, sessionToken }),
        /Agent server workspace must be a non-empty directory path/
      );
    }
  } finally {
    if (previousWorkspace === undefined) delete process.env.NETNAVR_SHELL_WORKSPACE;
    else process.env.NETNAVR_SHELL_WORKSPACE = previousWorkspace;
  }
});

test("serves correlated read-only diagnostics with structured errors", async () => {
  await withAgentServer(async (server) => {
    const suppliedRequestId = "req_00000000-0000-4000-8000-000000000000";
    const health = await fetch(`${server.url}/health`, {
      headers: { [SHELL_HTTP_REQUEST_ID_HEADER]: suppliedRequestId }
    });
    const healthRequestId = health.headers.get(SHELL_HTTP_REQUEST_ID_HEADER);

    assert.equal(health.status, 200);
    assert.equal(health.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(health.headers.get("cache-control"), "no-store");
    assert.equal(health.headers.get("x-content-type-options"), "nosniff");
    assert.equal(health.headers.get("access-control-allow-origin"), null);
    assert.match(healthRequestId ?? "", shellHttpRequestIdPattern);
    assert.notEqual(healthRequestId, suppliedRequestId);
    assert.deepEqual(await health.json(), { ok: true, providers: ["mock", "codex"] });

    const providers = await fetch(`${server.url}/api/providers`);
    const providersRequestId = providers.headers.get(SHELL_HTTP_REQUEST_ID_HEADER);
    assert.equal(providers.status, 200);
    assert.match(providersRequestId ?? "", shellHttpRequestIdPattern);
    assert.notEqual(providersRequestId, healthRequestId);
    assert.deepEqual(await providers.json(), { providers: ["mock", "codex"] });

    const missing = await fetch(`${server.url}/missing`);
    const missingRequestId = missing.headers.get(SHELL_HTTP_REQUEST_ID_HEADER);
    assert.equal(missing.status, 404);
    assert.match(missingRequestId ?? "", shellHttpRequestIdPattern);
    assert.deepEqual(await missing.json(), {
      error: { code: "not_found", message: "Route not found" },
      requestId: missingRequestId
    });
  });
});

test("rejects unsupported methods on known diagnostic routes", async () => {
  await withAgentServer(async (server) => {
    const response = await fetch(`${server.url}/api/providers`, { method: "POST" });
    const requestId = response.headers.get(SHELL_HTTP_REQUEST_ID_HEADER);

    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET");
    assert.match(requestId ?? "", shellHttpRequestIdPattern);
    assert.deepEqual(await response.json(), {
      error: { code: "method_not_allowed", message: "Method not allowed" },
      requestId
    });
  });
});

test("rejects diagnostic request bodies and closes the connection", async () => {
  await withAgentServer(async (server) => {
    const response = await fetch(`${server.url}/health`, {
      method: "POST",
      body: "unexpected"
    });
    const requestId = response.headers.get(SHELL_HTTP_REQUEST_ID_HEADER);

    assert.equal(response.status, 413);
    assert.equal(response.headers.get("connection"), "close");
    assert.match(requestId ?? "", shellHttpRequestIdPattern);
    assert.deepEqual(await response.json(), {
      error: {
        code: "request_body_not_allowed",
        message: "Shell read-only diagnostics do not accept request bodies"
      },
      requestId
    });
  });
});

test("rejects invalid request targets and closes the connection", async () => {
  await withAgentServer(async (server) => {
    for (const target of [
      "http://[/health",
      "http://localhost:99999/health",
      "//[/health"
    ]) {
      const response = await sendRawHttpRequest(
        server.host,
        server.port,
        [
          `GET ${target} HTTP/1.1`,
          `Host: ${server.host}:${server.port}`,
          "Connection: keep-alive",
          "",
          ""
        ].join("\r\n")
      );

      assert.match(response, /^HTTP\/1\.1 400 /, target);
      assert.match(response, /connection: close/i, target);
      assert.match(response, /cache-control: no-store/i, target);
      assert.match(response, /x-content-type-options: nosniff/i, target);
      assert.match(response, /"code":"invalid_request_target"/, target);
      assert.match(response, /"message":"Request target is invalid"/, target);
    }

    for (const target of ["/health?probe=1", `${server.url}/health?probe=1`]) {
      const response = await sendRawHttpRequest(
        server.host,
        server.port,
        [
          `GET ${target} HTTP/1.1`,
          `Host: ${server.host}:${server.port}`,
          "Connection: close",
          "",
          ""
        ].join("\r\n")
      );

      assert.match(response, /^HTTP\/1\.1 200 /, target);
    }
  });
});

test("rejects headers above the Shell diagnostic limit", async () => {
  await withAgentServer(async (server) => {
    const response = await sendRawHttpRequest(
      server.host,
      server.port,
      [
        "GET /health HTTP/1.1",
        `Host: ${server.host}:${server.port}`,
        `X-Oversized: ${"a".repeat(SHELL_MAX_HEADER_BYTES)}`,
        "Connection: close",
        "",
        ""
      ].join("\r\n")
    );

    assert.match(response, /^HTTP\/1\.1 431 /);
  });
});

test("accepts only the exact WebSocket upgrade target", async () => {
  await withAgentServer(async (server) => {
    const protocols = authenticatedProtocols();
    await assertRejectedUpgrade(`${server.webSocketUrl}?unexpected=true`, protocols, 400);
    await assertRejectedUpgrade(`${server.webSocketUrl}/`, protocols, 400);

    const wrongMethod = await sendRawHttpRequest(
      server.host,
      server.port,
      [
        "POST /ws HTTP/1.1",
        `Host: ${server.host}:${server.port}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGVzdF93ZWJzb2NrZXRfa2V5",
        `Sec-WebSocket-Protocol: ${protocols.join(", ")}`,
        "",
        ""
      ].join("\r\n")
    );
    assert.match(wrongMethod, /^HTTP\/1\.1 400 Bad Request/);
    assert.match(wrongMethod, /x-request-id: req_[0-9a-f-]{36}/i);
  });
});

test("bounds authenticated WebSocket sessions and releases capacity", async () => {
  const workspaceRoot = await realpath(process.cwd());
  const server = await startAgentServer({ port: 0, workspaceRoot, sessionToken });
  const clients: WebSocket[] = [];

  try {
    for (let index = 0; index < SHELL_MAX_AUTHENTICATED_WEBSOCKET_CLIENTS; index += 1) {
      clients.push(await openAuthenticatedSocket(server));
    }

    await assertRejectedUpgrade(server.webSocketUrl, authenticatedProtocols(), 503);

    const firstClient = clients.shift();
    assert.ok(firstClient);
    await closeWebSocket(firstClient);
    clients.push(await openAuthenticatedSocketAfterCapacityRelease(server));
  } finally {
    for (const client of clients) client.terminate();
    await server.close();
  }
});

test("shutdown is idempotent and closes authenticated sessions", async (context) => {
  const workspaceRoot = await realpath(process.cwd());
  const server = await startAgentServer({ port: 0, workspaceRoot, sessionToken });
  context.after(() => server.close());

  const socket = await openAuthenticatedSocket(server);
  const socketClosed = once(socket, "close");

  await Promise.all([server.close(), server.close()]);
  await socketClosed;
  await server.close();
  await assert.rejects(fetch(`${server.url}/health`));
});

test("requires a session token and keeps execution policy on the server", async (context) => {
  const workspaceRoot = await realpath(process.cwd());
  const server = await startAgentServer({ port: 0, workspaceRoot, sessionToken });
  context.after(() => server.close());

  const health = await fetch(`${server.url}/health`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("access-control-allow-origin"), null);

  await assertRejectedUpgrade(server.webSocketUrl, [SHELL_WEBSOCKET_PROTOCOL]);
  await assertRejectedUpgrade(server.webSocketUrl, [
    SHELL_WEBSOCKET_PROTOCOL,
    `${SHELL_WEBSOCKET_AUTH_PREFIX}wrong_session_token_0123456789abcdef`
  ]);

  const socket = new WebSocket(server.webSocketUrl, [
    SHELL_WEBSOCKET_PROTOCOL,
    `${SHELL_WEBSOCKET_AUTH_PREFIX}${sessionToken}`
  ]);
  context.after(() => socket.terminate());

  const readyMessage = waitForEvent(socket, (event) => event.type === "shell.ready");
  await once(socket, "open");
  assert.deepEqual(await readyMessage, {
    type: "shell.ready",
    protocolVersion: SHELL_PROTOCOL_VERSION,
    providers: ["mock", "codex"],
    workspace: workspaceRoot
  });

  const invalidMessage = waitForEvent(socket, (event) => event.type === "log");
  socket.send("null");
  assert.match(getLogMessage(await invalidMessage), /object with a type/);

  const unsafeMessage = waitForEvent(socket, (event) => event.type === "log");
  socket.send(
    JSON.stringify({
      type: "run",
      requestId: firstRequestId,
      request: {
        provider: "mock",
        prompt: "unsafe override",
        cwd: "/",
        sandboxMode: "danger-full-access",
        approvalPolicy: "never"
      }
    })
  );
  assert.match(getLogMessage(await unsafeMessage), /unsupported fields/);

  const completedRun = collectUntil(socket, "turn.completed");
  socket.send(
    JSON.stringify({
      type: "run",
      requestId: firstRequestId,
      request: { provider: "mock", prompt: "hello" }
    })
  );
  const events = await completedRun;
  assert.ok(events.some((event) => event.type === "agent.delta"));
  const started = events.find((event) => event.type === "run.started");
  assert.equal(started?.requestId, firstRequestId);
  assert.match(started?.runId ?? "", /^run_[0-9a-f-]{36}$/);
  assert.ok(
    events.every((event) => !("runId" in event) || event.runId === started?.runId)
  );

  const activeStarted = waitForEvent(
    socket,
    (event) => event.type === "run.started" && event.requestId === secondRequestId
  );
  socket.send(
    JSON.stringify({
      type: "run",
      requestId: secondRequestId,
      request: { provider: "mock", prompt: "keep running ".repeat(1_000) }
    })
  );
  const activeRun = await activeStarted;
  assert.equal(activeRun.type, "run.started");

  const rejectedRun = waitForEvent(
    socket,
    (event) => event.type === "run.rejected" && event.requestId === thirdRequestId
  );
  socket.send(
    JSON.stringify({
      type: "run",
      requestId: thirdRequestId,
      request: { provider: "mock", prompt: "must not replace the active run" }
    })
  );
  assert.deepEqual(await rejectedRun, {
    type: "run.rejected",
    requestId: thirdRequestId,
    reason: "run_in_progress"
  });

  const progressAfterStaleCancel = waitForEvent(
    socket,
    (event) => event.type === "agent.delta" && event.runId === activeRun.runId
  );
  const rejectedCancel = waitForEvent(
    socket,
    (event) => event.type === "cancel.rejected" && event.runId === staleRunId
  );
  socket.send(JSON.stringify({ type: "cancel", runId: staleRunId }));
  assert.deepEqual(await rejectedCancel, {
    type: "cancel.rejected",
    runId: staleRunId,
    reason: "run_not_active"
  });
  await progressAfterStaleCancel;

  const cancelledRun = waitForEvent(
    socket,
    (event) => event.type === "run.cancelled" && event.runId === activeRun.runId
  );
  socket.send(JSON.stringify({ type: "cancel", runId: activeRun.runId }));
  assert.deepEqual(await cancelledRun, {
    type: "run.cancelled",
    runId: activeRun.runId
  });

  const retriedRun = collectUntil(socket, "turn.completed");
  socket.send(
    JSON.stringify({
      type: "run",
      requestId: thirdRequestId,
      request: { provider: "mock", prompt: "accepted after overlap clears" }
    })
  );
  const retriedEvents = await retriedRun;
  assert.ok(
    retriedEvents.some(
      (event) => event.type === "run.started" && event.requestId === thirdRequestId
    )
  );

  socket.close();
  await once(socket, "close");
});

test("rejects accepted request IDs replayed across authenticated connections", async () => {
  await withAgentServer(async (server) => {
    const firstSocket = await openAuthenticatedSocket(server);
    const secondSocket = await openAuthenticatedSocket(server);

    try {
      const completedRun = collectUntil(firstSocket, "turn.completed");
      firstSocket.send(
        JSON.stringify({
          type: "run",
          requestId: firstRequestId,
          request: { provider: "mock", prompt: "accept once" }
        })
      );
      await completedRun;

      const replayRejected = waitForEvent(
        secondSocket,
        (event) => event.type === "run.rejected" && event.requestId === firstRequestId
      );
      secondSocket.send(
        JSON.stringify({
          type: "run",
          requestId: firstRequestId,
          request: { provider: "mock", prompt: "must not execute twice" }
        })
      );

      assert.deepEqual(await replayRejected, {
        type: "run.rejected",
        requestId: firstRequestId,
        reason: "request_replayed"
      });
    } finally {
      await Promise.all([closeWebSocket(firstSocket), closeWebSocket(secondSocket)]);
    }
  });
});

async function assertRejectedUpgrade(
  webSocketUrl: string,
  protocols: string[],
  expectedStatus = 401
): Promise<void> {
  const socket = new WebSocket(webSocketUrl, protocols);

  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => reject(new Error("Rejected WebSocket unexpectedly opened")));
    socket.once("unexpected-response", (_request, response) => {
      assert.equal(response.statusCode, expectedStatus);
      assert.equal(response.headers["cache-control"], "no-store");
      assert.equal(response.headers["x-content-type-options"], "nosniff");
      assert.match(String(response.headers[SHELL_HTTP_REQUEST_ID_HEADER] ?? ""), shellHttpRequestIdPattern);
      response.resume();
      resolve();
    });
    socket.once("error", () => undefined);
  });
}

function authenticatedProtocols(): string[] {
  return [
    SHELL_WEBSOCKET_PROTOCOL,
    `${SHELL_WEBSOCKET_AUTH_PREFIX}${sessionToken}`
  ];
}

async function openAuthenticatedSocket(server: AgentServerHandle): Promise<WebSocket> {
  const socket = new WebSocket(server.webSocketUrl, authenticatedProtocols());
  await once(socket, "open");
  return socket;
}

async function openAuthenticatedSocketAfterCapacityRelease(
  server: AgentServerHandle,
  timeoutMs = 2_000
): Promise<WebSocket> {
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      return await openAuthenticatedSocket(server);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !/Unexpected server response: 503/.test(error.message) ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function closeWebSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = once(socket, "close");
  socket.close();
  await closed;
}

async function withAgentServer(run: (server: AgentServerHandle) => Promise<void>): Promise<void> {
  const workspaceRoot = await realpath(process.cwd());
  const server = await startAgentServer({ port: 0, workspaceRoot, sessionToken });
  try {
    await run(server);
  } finally {
    await server.close();
  }
}

function sendRawHttpRequest(host: string, port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port }, () => socket.end(request));
    let response = "";

    socket.setEncoding("utf8");
    socket.setTimeout(2_000, () => socket.destroy(new Error("Timed out waiting for HTTP response")));
    socket.on("data", (chunk: string) => {
      response += chunk;
    });
    socket.once("error", reject);
    socket.once("end", () => resolve(response));
  });
}

function waitForEvent(socket: WebSocket, predicate: (event: ShellEvent) => boolean): Promise<ShellEvent> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onMessage = (data: RawData) => {
      const event = JSON.parse(data.toString()) as ShellEvent;
      if (!predicate(event)) return;
      cleanup();
      resolve(event);
    };
    const cleanup = () => {
      socket.off("error", onError);
      socket.off("message", onMessage);
    };

    socket.on("error", onError);
    socket.on("message", onMessage);
  });
}

function collectUntil(socket: WebSocket, terminalType: ShellEvent["type"]): Promise<ShellEvent[]> {
  return new Promise((resolve, reject) => {
    const events: ShellEvent[] = [];
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onMessage = (data: RawData) => {
      const event = JSON.parse(data.toString()) as ShellEvent;
      events.push(event);
      if (event.type !== terminalType) return;
      cleanup();
      resolve(events);
    };
    const cleanup = () => {
      socket.off("error", onError);
      socket.off("message", onMessage);
    };

    socket.on("error", onError);
    socket.on("message", onMessage);
  });
}

function getLogMessage(event: ShellEvent): string {
  assert.equal(event.type, "log");
  return event.message;
}
