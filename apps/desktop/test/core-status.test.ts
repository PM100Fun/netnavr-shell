import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CORE_STATUS_MAX_RESPONSE_BYTES,
  coreOriginFromEnvironment,
  fetchConfiguredCoreStatus,
  fetchCoreStatus,
  parseCoreStatusResult,
} from "../src/core-status.js";

const health = {
  service: "netnavr-core",
  status: "ok",
  apiVersion: "v1",
  version: "0.2.1",
  uptimeSeconds: 12,
};

const node = {
  nodeId: "node_12345678-1234-4123-8123-123456789abc",
  createdAt: "2026-08-23T00:00:00.000Z",
  schemaVersion: 1,
};

test("reads health and persistent Node identity through bounded GET requests", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const responses = [
    jsonResponse(health, "req_12345678-1234-4123-8123-123456789abc"),
    jsonResponse(node, "req_abcdefab-cdef-4abc-8def-abcdefabcdef"),
  ];

  const result = await fetchCoreStatus({
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), init });
      const response = responses.shift();
      if (!response) throw new Error("Unexpected request");
      return response;
    },
  });

  assert.deepEqual(
    requests.map(({ url }) => url),
    [
      "http://127.0.0.1:8786/v1/health",
      "http://127.0.0.1:8786/v1/node",
    ],
  );
  for (const request of requests) {
    assert.equal(request.init?.method, "GET");
    assert.equal(request.init?.credentials, "omit");
    assert.equal(request.init?.redirect, "error");
    assert.equal(request.init?.body, undefined);
    const headers = new Headers(request.init?.headers);
    assert.equal(headers.get("accept"), "application/json");
    assert.equal(headers.get("authorization"), null);
  }
  assert.deepEqual(result, {
    state: "online",
    ...health,
    ...node,
    requestIds: {
      health: "req_12345678-1234-4123-8123-123456789abc",
      node: "req_abcdefab-cdef-4abc-8def-abcdefabcdef",
    },
  });
});

test("rejects JSON media-type lookalikes on both Core endpoints", async () => {
  for (const endpoint of ["/v1/health", "/v1/node"]) {
    for (const contentType of ["application/jsonp", "application/json-seq", "application/json-invalid; charset=utf-8", "application/json, text/plain"]) {
      let cancelled = false;
      let requests = 0;
      const result = await fetchCoreStatus({
        fetchImpl: async (input) => {
          requests++;
          const path = new URL(String(input)).pathname;
          if (path !== endpoint) return jsonResponse(path === "/v1/health" ? health : node);
          return new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(JSON.stringify(path === "/v1/health" ? health : node)));
              controller.close();
            },
            cancel() { cancelled = true; },
          }), { headers: { "content-type": contentType } });
        },
      });
      assert.equal(result.state, "error", contentType);
      assert.equal(result.code, "invalid_response");
      assert.equal(cancelled, true);
      assert.equal(requests, endpoint === "/v1/health" ? 1 : 2);
    }
  }
});

test("accepts exact JSON media types with case and parameter variations", async () => {
  for (const contentType of ["application/json", "Application/JSON", "application/json; charset=utf-8", "APPLICATION/JSON ; charset=UTF-8"]) {
    const result = await fetchCoreStatus({
      fetchImpl: async (input) => new Response(JSON.stringify(
        new URL(String(input)).pathname === "/v1/health" ? health : node,
      ), { headers: { "content-type": contentType } }),
    });
    assert.equal(result.state, "online", contentType);
  }
});

test("classifies another loopback service as incompatible", async () => {
  const result = await fetchCoreStatus({
    fetchImpl: async () =>
      jsonResponse(
        { ...health, service: "another-service" },
        "req_12345678-1234-4123-8123-123456789abc",
      ),
  });

  assert.deepEqual(result, {
    state: "incompatible",
    code: "unexpected_service",
    message: "The loopback endpoint is not NetNavr Core",
    requestId: "req_12345678-1234-4123-8123-123456789abc",
  });
});

test("classifies unsupported API and schema versions separately", async () => {
  const apiResult = await fetchCoreStatus({
    fetchImpl: async () => jsonResponse({ ...health, apiVersion: "v2" }),
  });
  assert.equal(apiResult.state, "incompatible");
  assert.equal(apiResult.code, "unsupported_api_version");

  const responses = [jsonResponse(health), jsonResponse({ ...node, schemaVersion: 2 })];
  const schemaResult = await fetchCoreStatus({
    fetchImpl: async () => responses.shift() ?? jsonResponse({}),
  });
  assert.equal(schemaResult.state, "incompatible");
  assert.equal(schemaResult.code, "unsupported_schema_version");
});

test("rejects malformed and oversized Core responses", async () => {
  const malformed = await fetchCoreStatus({
    fetchImpl: async () => jsonResponse({ ...health, uptimeSeconds: "12" }),
  });
  assert.equal(malformed.state, "error");
  assert.equal(malformed.code, "invalid_response");

  const oversized = await fetchCoreStatus({
    fetchImpl: async () =>
      new Response(JSON.stringify({ padding: "x".repeat(CORE_STATUS_MAX_RESPONSE_BYTES) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  assert.equal(oversized.state, "error");
  assert.equal(oversized.code, "invalid_response");
});

test("oversized streams return diagnostics without waiting for cancellation", async () => {
  for (const endpoint of ["/v1/health", "/v1/node"]) {
    for (const cleanup of ["pending", "rejected"]) {
      let cancelled = false;
      const response = new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(CORE_STATUS_MAX_RESPONSE_BYTES + 1));
        },
        cancel() {
          cancelled = true;
          return cleanup === "pending" ? new Promise<void>(() => {}) : Promise.reject(new Error("cleanup failed"));
        },
      }), { headers: { "content-type": "application/json" } });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          fetchCoreStatus({
            timeoutMs: 50,
            fetchImpl: async (input) => new URL(String(input)).pathname === endpoint ? response : jsonResponse(health),
          }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("status query blocked on cleanup")), 500);
          }),
        ]);
        assert.equal(result.state, "error");
        assert.equal(result.code, "invalid_response");
        assert.equal(cancelled, true);
        assert.equal(response.body?.locked, false);
      } finally {
        clearTimeout(timer);
      }
    }
  }
});

test("releases Core response reader locks after success and read failure", async () => {
  const responses = [jsonResponse(health), jsonResponse(node)];
  let index = 0;
  assert.equal((await fetchCoreStatus({ fetchImpl: async () => responses[index++]! })).state, "online");
  for (const response of responses) assert.equal(response.body?.locked, false);
  const broken = new Response(new ReadableStream({
    start(controller) { controller.error(new Error("stream failed")); },
  }), { headers: { "content-type": "application/json" } });
  const result = await fetchCoreStatus({ fetchImpl: async () => broken });
  assert.equal(result.state, "error");
  assert.equal(result.code, "invalid_response");
  assert.equal(broken.body?.locked, false);
});

test("reports HTTP failures with a valid diagnostic request ID", async () => {
  const result = await fetchCoreStatus({
    fetchImpl: async () =>
      jsonResponse(
        { error: { code: "not_found", message: "Route not found" } },
        "req_12345678-1234-4123-8123-123456789abc",
        404,
      ),
  });

  assert.deepEqual(result, {
    state: "error",
    code: "http_status",
    message: "Core /v1/health returned HTTP 404",
    requestId: "req_12345678-1234-4123-8123-123456789abc",
  });
});

test("cancels response bodies when Core status responses will not be read", async () => {
  const cases = [
    { status: 503, contentType: "application/json", expectedCode: "http_status" },
    { status: 200, contentType: "text/plain", expectedCode: "invalid_response" },
  ] as const;

  for (const { status, contentType, expectedCode } of cases) {
    let bodyCancelled = false;
    const response = new Response(
      new ReadableStream({
        cancel() {
          bodyCancelled = true;
        },
      }),
      { status, headers: { "content-type": contentType } },
    );

    const result = await fetchCoreStatus({
      fetchImpl: async () => response,
    });

    assert.equal(result.state, "error");
    assert.equal(result.code, expectedCode);
    assert.equal(bodyCancelled, true);
  }
});

test("cancels bodies rejected by Content-Length without changing diagnostics", async () => {
  for (const endpoint of ["/v1/health", "/v1/node"]) {
    for (const length of ["invalid", "-1", String(CORE_STATUS_MAX_RESPONSE_BYTES + 1), "9007199254740992"]) {
      for (const rejectCleanup of [false, true]) {
        let cancelled = false;
        let requests = 0;
        const response = new Response(new ReadableStream({
          cancel() {
            cancelled = true;
            if (rejectCleanup) return Promise.reject(new Error("cleanup failed"));
          },
        }), { headers: {
          "content-type": "application/json",
          "content-length": length,
          "x-request-id": "req_12345678-1234-4123-8123-123456789abc",
        } });
        const result = await fetchCoreStatus({
          fetchImpl: async (input) => {
            requests++;
            return new URL(String(input)).pathname === endpoint ? response : jsonResponse(health);
          },
        });
        assert.equal(cancelled, true, `${endpoint}: ${length}`);
        assert.deepEqual(result, {
          state: "error",
          code: "invalid_response",
          message: `Core ${endpoint} response is invalid or too large`,
          requestId: "req_12345678-1234-4123-8123-123456789abc",
        });
        assert.equal(requests, endpoint === "/v1/health" ? 1 : 2);
      }
    }
  }
});

test("separates an unreachable Core from a local timeout", async () => {
  const unreachable = await fetchCoreStatus({
    fetchImpl: async () => {
      throw new TypeError("connection refused");
    },
  });
  assert.equal(unreachable.state, "offline");
  assert.equal(unreachable.code, "unreachable");

  const timedOut = await fetchCoreStatus({
    timeoutMs: 5,
    fetchImpl: async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      }),
  });
  assert.equal(timedOut.state, "offline");
  assert.equal(timedOut.code, "timeout");
});

for (const endpoint of ["/v1/health", "/v1/node"]) {
  test(`reports a timeout while reading ${endpoint} response body`, async () => {
    const requests: string[] = [];
    const result = await fetchCoreStatus({
      timeoutMs: 20,
      fetchImpl: async (input, init) => {
        const pathname = new URL(String(input)).pathname;
        requests.push(pathname);
        if (pathname !== endpoint) return jsonResponse(health);
        const signal = init?.signal;
        assert.ok(signal);
        return new Response(new ReadableStream({
          start(controller) {
            const abort = () => controller.error(new DOMException("aborted", "AbortError"));
            if (signal.aborted) abort();
            else signal.addEventListener("abort", abort, { once: true });
          },
        }), { headers: { "content-type": "application/json" } });
      },
    });
    assert.equal(result.state, "offline");
    assert.equal(result.code, "timeout");
    assert.deepEqual(requests, endpoint === "/v1/health"
      ? ["/v1/health"] : ["/v1/health", "/v1/node"]);
  });
}

test("accepts only explicit numeric loopback Core ports", async () => {
  assert.equal(coreOriginFromEnvironment(undefined), "http://127.0.0.1:8786");
  assert.equal(coreOriginFromEnvironment("80"), "http://127.0.0.1:80");
  assert.equal(coreOriginFromEnvironment("9000"), "http://127.0.0.1:9000");
  for (const value of ["0", "65536", "localhost", "8786/path", " 8786"] as const) {
    assert.throws(() => coreOriginFromEnvironment(value), /Core port is invalid/);
  }

  let called = false;
  const invalid = await fetchConfiguredCoreStatus("localhost", {
    fetchImpl: async () => {
      called = true;
      return jsonResponse(health);
    },
  });
  assert.equal(called, false);
  assert.equal(invalid.state, "error");
  assert.equal(invalid.code, "invalid_configuration");

  const wrongOrigin = await fetchCoreStatus({
    origin: "http://localhost:8786",
    fetchImpl: async () => {
      called = true;
      return jsonResponse(health);
    },
  });
  assert.equal(called, false);
  assert.equal(wrongOrigin.state, "error");
  assert.equal(wrongOrigin.code, "invalid_configuration");
});

test("the preload parser rejects poisoned Core status values", () => {
  const online = {
    state: "online",
    ...health,
    ...node,
    requestIds: {},
  };
  assert.deepEqual(parseCoreStatusResult(online), online);
  assert.throws(
    () => parseCoreStatusResult({ ...online, nodeId: "not-a-node" }),
    /Core online status is invalid/,
  );
  assert.throws(
    () =>
      parseCoreStatusResult({
        state: "error",
        code: "http_status",
        message: "x".repeat(257),
      }),
    /Core failure status is invalid/,
  );
});

function jsonResponse(payload: unknown, requestId?: string, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(requestId ? { "x-request-id": requestId } : {}),
    },
  });
}
