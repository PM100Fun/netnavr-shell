import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  normalizeTrustedExternalUrl,
  parseShellConnectionInfo,
} from "../src/security.js";

const desktopMainSource = readFileSync(
  new URL("../src/main.ts", import.meta.url),
  "utf8",
);
const webAppSource = readFileSync(
  new URL("../../web/src/App.tsx", import.meta.url),
  "utf8",
);
const preloadSource = readFileSync(
  new URL("../src/preload.ts", import.meta.url),
  "utf8",
);
const webIndexSource = readFileSync(
  new URL("../../web/index.html", import.meta.url),
  "utf8",
);

test("desktop connection credentials stay out of renderer URLs", () => {
  assert.doesNotMatch(desktopMainSource, /URLSearchParams/);
  assert.doesNotMatch(desktopMainSource, /loadFile\([^)]*,\s*{\s*hash:/);
  assert.doesNotMatch(webAppSource, /window\.location\.hash/);
  assert.match(desktopMainSource, /preload:/);
  assert.match(desktopMainSource, /event\.senderFrame\?\.url === rendererUrl/);
});

test("desktop uses an OS-assigned loopback port", () => {
  assert.match(desktopMainSource, /port:\s*0/);
  assert.doesNotMatch(desktopMainSource, /port:\s*8787/);
});

test("renderer declares a restrictive content security policy", () => {
  assert.match(webIndexSource, /Content-Security-Policy/);
  assert.match(webIndexSource, /object-src 'none'/);
  assert.match(webIndexSource, /frame-ancestors 'none'/);
});

test("connection bridge accepts only explicit loopback WebSocket endpoints", () => {
  const safeConnection = {
    webSocketUrl: "ws://127.0.0.1:49152/ws",
    sessionToken: "test_session_token_0123456789abcdef",
  };
  assert.deepEqual(parseShellConnectionInfo(safeConnection), safeConnection);

  for (const webSocketUrl of [
    "ws://localhost:49152/ws",
    "ws://0.0.0.0:49152/ws",
    "wss://127.0.0.1:49152/ws",
    "ws://127.0.0.1:49152/other",
    "ws://127.0.0.1/ws",
    "ws://127.0.0.1:49152/ws?token=secret",
  ]) {
    assert.throws(
      () => parseShellConnectionInfo({ ...safeConnection, webSocketUrl }),
      /loopback \/ws endpoint/,
    );
  }
});

test("external navigation accepts credential-free HTTPS URLs only", () => {
  assert.match(desktopMainSource, /will-navigate/);
  assert.equal(
    normalizeTrustedExternalUrl("https://github.com/PM100Fun/NetNavr"),
    "https://github.com/PM100Fun/NetNavr",
  );

  for (const url of [
    "http://example.com",
    "javascript:alert(1)",
    "file:///tmp/secret",
    "mailto:test@example.com",
    "https://user:password@example.com",
    "not a URL",
  ]) {
    assert.equal(normalizeTrustedExternalUrl(url), null);
  }
});

test("Core status stays behind the trusted preload bridge", () => {
  assert.match(desktopMainSource, /fetchConfiguredCoreStatus/);
  assert.match(desktopMainSource, /isTrustedRenderer\(event\)/);
  assert.match(preloadSource, /getCoreStatus/);
  assert.match(preloadSource, /parseCoreStatusResult/);
  assert.match(webAppSource, /window\.netnavr\.getCoreStatus/);
  assert.doesNotMatch(webAppSource, /127\.0\.0\.1:8786/);
  assert.doesNotMatch(webAppSource, /\/v1\/(?:health|node)/);
});

test("renderer targets cancellation and ignores stale run events", () => {
  assert.match(webAppSource, /type:\s*"run",\s*requestId,\s*request/);
  assert.match(webAppSource, /type:\s*"cancel",\s*runId/);
  assert.match(webAppSource, /eventRunId\s*!==\s*activeRunIdRef\.current/);
  assert.match(webAppSource, /pendingRequestIdRef\.current\s*\|\|\s*activeRunIdRef\.current/);
  assert.doesNotMatch(webAppSource, /JSON\.stringify\(\{\s*type:\s*"cancel"\s*\}\)/);
});
