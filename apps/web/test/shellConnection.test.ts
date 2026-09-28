import assert from "node:assert/strict";
import test from "node:test";

import {
  reconnectDelayMs,
  SHELL_RECONNECT_DELAYS_MS,
  startShellConnection,
  type ShellConnectionTimerApi,
  type ShellSocket
} from "../src/shellConnection.js";

test("reconnect delays grow to a bounded five-second ceiling", () => {
  assert.deepEqual(
    Array.from({ length: 8 }, (_, attempt) => reconnectDelayMs(attempt)),
    [250, 500, 1_000, 2_000, 5_000, 5_000, 5_000, 5_000]
  );
  assert.deepEqual(SHELL_RECONNECT_DELAYS_MS, [250, 500, 1_000, 2_000, 5_000]);

  for (const attempt of [-1, 0.5, Number.POSITIVE_INFINITY]) {
    assert.throws(() => reconnectDelayMs(attempt), RangeError);
  }
});

test("an authenticated connection reconnects once per close and resets after opening", async () => {
  const timers = new FakeTimers();
  const sockets: FakeSocket[] = [];
  const publishedSockets: Array<ShellSocket | null> = [];
  const messages: string[] = [];
  let resolveCount = 0;
  let connectedCount = 0;
  let disconnectedCount = 0;

  const controller = startShellConnection({
    resolveConnection: async () => {
      resolveCount += 1;
      return {
        webSocketUrl: "ws://127.0.0.1:49152/ws",
        sessionToken: "test_session_token_0123456789abcdef"
      };
    },
    createSocket: (url, protocols) => {
      const socket = new FakeSocket(url, protocols);
      sockets.push(socket);
      return socket;
    },
    timerApi: timers,
    onSocket: (socket) => publishedSockets.push(socket),
    onConnected: () => {
      connectedCount += 1;
    },
    onDisconnected: () => {
      disconnectedCount += 1;
    },
    onMessage: (message) => messages.push(message),
    onInitializationError: () => assert.fail("connection should initialize")
  });

  await settle();
  assert.equal(resolveCount, 1);
  assert.equal(sockets.length, 1);
  assert.deepEqual(sockets[0].protocols, [
    "netnavr-shell-v3",
    "netnavr-shell-auth.test_session_token_0123456789abcdef"
  ]);

  sockets[0].open();
  sockets[0].message("first");
  assert.equal(connectedCount, 1);
  assert.deepEqual(messages, ["first"]);

  sockets[0].disconnect();
  sockets[0].disconnect();
  assert.equal(disconnectedCount, 1);
  assert.deepEqual(timers.delays, [250]);
  assert.equal(publishedSockets.at(-1), null);

  timers.runNext();
  await settle();
  assert.equal(resolveCount, 1, "credentials remain in memory for this controller only");
  assert.equal(sockets.length, 2);

  sockets[1].disconnect();
  assert.deepEqual(timers.delays, [250, 500]);
  timers.runNext();
  await settle();
  assert.equal(sockets.length, 3);

  sockets[2].open();
  sockets[2].disconnect();
  assert.deepEqual(timers.delays, [250, 500, 250]);

  controller.stop();
});

test("stopping a connected controller closes its socket without retrying", async () => {
  const timers = new FakeTimers();
  const sockets: FakeSocket[] = [];
  let disconnectedCount = 0;

  const controller = startShellConnection({
    resolveConnection: async () => ({
      webSocketUrl: "ws://127.0.0.1:49152/ws",
      sessionToken: "test_session_token_0123456789abcdef"
    }),
    createSocket: (url, protocols) => {
      const socket = new FakeSocket(url, protocols);
      sockets.push(socket);
      return socket;
    },
    timerApi: timers,
    onSocket: () => undefined,
    onConnected: () => undefined,
    onDisconnected: () => {
      disconnectedCount += 1;
    },
    onMessage: () => undefined,
    onInitializationError: () => assert.fail("connection should initialize")
  });

  await settle();
  sockets[0].open();
  controller.stop();
  controller.stop();

  assert.equal(sockets[0].closeCount, 1);
  assert.equal(disconnectedCount, 0);
  assert.equal(timers.pendingCount, 0);
});

test("stopping during backoff cancels the pending reconnect", async () => {
  const timers = new FakeTimers();
  const sockets: FakeSocket[] = [];

  const controller = startShellConnection({
    resolveConnection: async () => ({
      webSocketUrl: "ws://127.0.0.1:49152/ws",
      sessionToken: "test_session_token_0123456789abcdef"
    }),
    createSocket: (url, protocols) => {
      const socket = new FakeSocket(url, protocols);
      sockets.push(socket);
      return socket;
    },
    timerApi: timers,
    onSocket: () => undefined,
    onConnected: () => undefined,
    onDisconnected: () => undefined,
    onMessage: () => undefined,
    onInitializationError: () => assert.fail("connection should initialize")
  });

  await settle();
  sockets[0].disconnect();
  assert.equal(timers.pendingCount, 1);

  controller.stop();
  assert.equal(timers.pendingCount, 0);
  timers.runAll();
  await settle();
  assert.equal(sockets.length, 1);
});

test("initialization failure is reported without creating a retry loop", async () => {
  const timers = new FakeTimers();
  let errorCount = 0;

  const controller = startShellConnection({
    resolveConnection: async () => {
      throw new Error("missing connection bridge");
    },
    createSocket: () => assert.fail("socket should not be created"),
    timerApi: timers,
    onSocket: () => undefined,
    onConnected: () => undefined,
    onDisconnected: () => undefined,
    onMessage: () => undefined,
    onInitializationError: () => {
      errorCount += 1;
    }
  });

  await settle();
  assert.equal(errorCount, 1);
  assert.equal(timers.pendingCount, 0);
  controller.stop();
});

class FakeSocket implements ShellSocket {
  readonly url: string;
  readonly protocols: string[];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  closeCount = 0;

  constructor(url: string, protocols: string[]) {
    this.url = url;
    this.protocols = protocols;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  disconnect(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  message(data: unknown): void {
    this.onmessage?.({ data });
  }

  close(): void {
    this.closeCount += 1;
    this.readyState = 3;
    this.onclose?.();
  }

  send(): void {
    // The lifecycle controller does not send application messages.
  }
}

class FakeTimers implements ShellConnectionTimerApi {
  readonly delays: number[] = [];
  readonly #pending = new Map<number, () => void>();
  #nextHandle = 1;

  get pendingCount(): number {
    return this.#pending.size;
  }

  set(callback: () => void, delayMs: number): number {
    const handle = this.#nextHandle;
    this.#nextHandle += 1;
    this.delays.push(delayMs);
    this.#pending.set(handle, callback);
    return handle;
  }

  clear(handle: unknown): void {
    if (typeof handle === "number") this.#pending.delete(handle);
  }

  runNext(): void {
    const next = this.#pending.entries().next().value as
      | [number, () => void]
      | undefined;
    if (!next) return;
    const [handle, callback] = next;
    this.#pending.delete(handle);
    callback();
  }

  runAll(): void {
    while (this.#pending.size > 0) this.runNext();
  }
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
