import assert from "node:assert/strict";
import test from "node:test";

import type { ShellRequestId } from "@netnavr/shell-protocol";

import {
  createRecentRunRequestIds,
  SHELL_MAX_RECENT_RUN_REQUEST_IDS
} from "../src/recentRunRequests.js";

const firstRequestId: ShellRequestId = "req_12345678-1234-4123-8123-123456789abc";
const secondRequestId: ShellRequestId = "req_22345678-1234-4123-8123-123456789abc";
const thirdRequestId: ShellRequestId = "req_32345678-1234-4123-8123-123456789abc";

test("remembers accepted request IDs", () => {
  const requestIds = createRecentRunRequestIds();

  assert.equal(SHELL_MAX_RECENT_RUN_REQUEST_IDS, 512);
  assert.equal(requestIds.has(firstRequestId), false);
  requestIds.remember(firstRequestId);
  requestIds.remember(firstRequestId);
  assert.equal(requestIds.has(firstRequestId), true);
});

test("evicts the oldest request ID while preserving the newest IDs", () => {
  const requestIds = createRecentRunRequestIds(2);

  requestIds.remember(firstRequestId);
  requestIds.remember(secondRequestId);
  requestIds.remember(thirdRequestId);

  assert.equal(requestIds.has(firstRequestId), false);
  assert.equal(requestIds.has(secondRequestId), true);
  assert.equal(requestIds.has(thirdRequestId), true);
});

test("rejects invalid request ID limits", () => {
  for (const limit of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
    assert.throws(() => createRecentRunRequestIds(limit), RangeError);
  }
});
