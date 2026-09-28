import assert from "node:assert/strict";
import test from "node:test";

import {
  parseClientMessage,
  parseShellEvent,
  serializeShellEvent,
  SHELL_MAX_DIAGNOSTIC_CODE_UNITS,
  SHELL_MAX_EVENT_TEXT_CODE_UNITS,
  SHELL_PROTOCOL_VERSION,
  SHELL_WEBSOCKET_PROTOCOL,
} from "@netnavr/shell-protocol";

const requestId = "req_12345678-1234-4123-8123-123456789abc";
const runId = "run_22345678-1234-4123-8123-123456789abc";

test("protocol v3 requires validated request and run correlation IDs", () => {
  assert.equal(SHELL_PROTOCOL_VERSION, 3);
  assert.equal(SHELL_WEBSOCKET_PROTOCOL, "netnavr-shell-v3");

  assert.equal(
    parseClientMessage({
      type: "run",
      requestId,
      request: { provider: "mock", prompt: "hello" },
    }).ok,
    true,
  );
  assert.equal(
    parseClientMessage({
      type: "cancel",
      runId,
    }).ok,
    true,
  );

  for (const message of [
    { type: "run", request: { provider: "mock", prompt: "missing request ID" } },
    {
      type: "run",
      requestId: "req_not-a-uuid",
      request: { provider: "mock", prompt: "invalid request ID" },
    },
    { type: "cancel" },
    { type: "cancel", runId: "run_not-a-uuid" },
  ]) {
    assert.equal(parseClientMessage(message).ok, false);
  }
});

test("protocol v3 rejects incompatible or uncorrelated server events", () => {
  assert.equal(
    parseShellEvent({
      type: "shell.ready",
      protocolVersion: SHELL_PROTOCOL_VERSION,
      providers: ["mock"],
      workspace: "C:\\workspace",
    }).ok,
    true,
  );
  assert.equal(
    parseShellEvent({
      type: "shell.ready",
      protocolVersion: 1,
      providers: ["mock"],
      workspace: "C:\\workspace",
    }).ok,
    false,
  );
  assert.equal(
    parseShellEvent({
      type: "turn.completed",
      runId,
      provider: "mock",
      usage: null,
    }).ok,
    true,
  );
  assert.equal(
    parseShellEvent({
      type: "turn.completed",
      provider: "mock",
      usage: null,
    }).ok,
    false,
  );
  assert.equal(
    parseShellEvent({
      type: "run.rejected",
      requestId,
      reason: "request_replayed",
    }).ok,
    true,
  );
  assert.equal(
    parseShellEvent({
      type: "run.rejected",
      requestId,
      reason: "request_duplicate",
    }).ok,
    false,
  );
});

test("protocol v3 strips upstream payloads before serializing server events", () => {
  const source = {
    type: "item.completed",
    runId,
    provider: "codex",
    ignored: { secret: 1n },
    item: {
      id: "item-1",
      type: "agent_message",
      status: "completed",
      title: "Response",
      text: "bounded output",
      raw: { secret: 1n },
    },
  };

  const parsed = parseShellEvent(source);
  if (!parsed.ok) assert.fail(parsed.error);
  assert.deepEqual(parsed.value, {
    type: "item.completed",
    runId,
    provider: "codex",
    item: {
      id: "item-1",
      type: "agent_message",
      status: "completed",
      title: "Response",
      text: "bounded output",
    },
  });

  const serialized = serializeShellEvent(source);
  if (!serialized.ok) assert.fail(serialized.error);
  assert.deepEqual(JSON.parse(serialized.value), parsed.value);

  const usage = serializeShellEvent({
    type: "turn.completed",
    runId,
    provider: "codex",
    usage: {
      inputTokens: 12,
      cachedInputTokens: 3,
      outputTokens: 8,
      reasoningOutputTokens: 2,
      ignored: { secret: 1n },
    },
  });
  if (!usage.ok) assert.fail(usage.error);
  assert.deepEqual(JSON.parse(usage.value), {
    type: "turn.completed",
    runId,
    provider: "codex",
    usage: {
      inputTokens: 12,
      cachedInputTokens: 3,
      outputTokens: 8,
      reasoningOutputTokens: 2,
    },
  });
});

test("protocol v3 rejects oversized text and invalid usage counters", () => {
  assert.equal(
    parseShellEvent({
      type: "agent.delta",
      runId,
      provider: "mock",
      text: "x".repeat(SHELL_MAX_EVENT_TEXT_CODE_UNITS),
    }).ok,
    true,
  );
  assert.equal(
    parseShellEvent({
      type: "agent.delta",
      runId,
      provider: "mock",
      text: "x".repeat(SHELL_MAX_EVENT_TEXT_CODE_UNITS + 1),
    }).ok,
    false,
  );
  assert.equal(
    parseShellEvent({
      type: "log",
      level: "error",
      message: "x".repeat(SHELL_MAX_DIAGNOSTIC_CODE_UNITS + 1),
    }).ok,
    false,
  );

  for (const inputTokens of [-1, 1.5, Number.POSITIVE_INFINITY]) {
    assert.equal(
      parseShellEvent({
        type: "turn.completed",
        runId,
        provider: "mock",
        usage: {
          inputTokens,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
        },
      }).ok,
      false,
    );
  }
});
