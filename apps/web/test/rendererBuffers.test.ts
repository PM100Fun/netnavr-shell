import assert from "node:assert/strict";
import test from "node:test";

import {
  appendBoundedItem,
  appendBoundedStreamText,
  SHELL_STREAM_TRUNCATION_MARKER
} from "../src/rendererBuffers.js";

test("stream text remains unchanged while it is within the limit", () => {
  assert.equal(appendBoundedStreamText("hello", " world", 64), "hello world");
});

test("stream text keeps a marked tail across repeated truncation", () => {
  const first = appendBoundedStreamText("", "0123456789".repeat(4), 32);
  assert.equal(first, `${SHELL_STREAM_TRUNCATION_MARKER}56789`);
  assert.equal(first.length, 32);

  const second = appendBoundedStreamText(first, "abc", 32);
  assert.equal(second, `${SHELL_STREAM_TRUNCATION_MARKER}89abc`);
  assert.equal(second.match(/Earlier output truncated/g)?.length, 1);
  assert.equal(second.length, 32);
});

test("stream truncation never starts with half of a surrogate pair", () => {
  const result = appendBoundedStreamText("", `${"x".repeat(30)}A😀`, 29);
  assert.equal(result, `${SHELL_STREAM_TRUNCATION_MARKER}😀`);
  assert.deepEqual(Array.from(result.slice(SHELL_STREAM_TRUNCATION_MARKER.length)), ["😀"]);
});

test("bounded item history preserves only the newest values", () => {
  assert.deepEqual(appendBoundedItem([1, 2, 3], 4, 3), [2, 3, 4]);
  assert.deepEqual(appendBoundedItem([1, 2, 3], 4, 1), [4]);
  assert.deepEqual(appendBoundedItem([], 1, 3), [1]);
});

test("buffer helpers reject invalid limits", () => {
  for (const limit of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
    assert.throws(() => appendBoundedItem([], "event", limit), RangeError);
  }
  assert.throws(
    () => appendBoundedStreamText("", "output", SHELL_STREAM_TRUNCATION_MARKER.length),
    RangeError
  );
});
