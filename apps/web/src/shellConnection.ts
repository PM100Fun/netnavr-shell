import {
  SHELL_WEBSOCKET_AUTH_PREFIX,
  SHELL_WEBSOCKET_PROTOCOL
} from "@netnavr/shell-protocol";

export type ShellConnectionInfo = {
  webSocketUrl: string;
  sessionToken: string;
};

export type ShellSocket = {
  readonly readyState: number;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  close(): void;
  send(data: string): void;
};

export type ShellConnectionController = {
  stop(): void;
};

export type ShellConnectionTimerApi = {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
};

type StartShellConnectionOptions = {
  resolveConnection(): Promise<ShellConnectionInfo>;
  onSocket(socket: ShellSocket | null): void;
  onConnected(): void;
  onDisconnected(): void;
  onMessage(data: string): void;
  onInitializationError(): void;
  createSocket?(url: string, protocols: string[]): ShellSocket;
  timerApi?: ShellConnectionTimerApi;
};

export const SHELL_RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000] as const;

const defaultTimerApi: ShellConnectionTimerApi = {
  set: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clear: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>)
};

export function reconnectDelayMs(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 0) {
    throw new RangeError("Reconnect attempt must be a non-negative safe integer");
  }

  return SHELL_RECONNECT_DELAYS_MS[
    Math.min(attempt, SHELL_RECONNECT_DELAYS_MS.length - 1)
  ];
}

export function startShellConnection(
  options: StartShellConnectionOptions
): ShellConnectionController {
  const timerApi = options.timerApi ?? defaultTimerApi;
  const createSocket =
    options.createSocket ??
    ((url: string, protocols: string[]) =>
      new WebSocket(url, protocols) as unknown as ShellSocket);
  const reconnect = createReconnectScheduler(timerApi);

  let active = true;
  let connecting = false;
  let connectionInfo: ShellConnectionInfo | null = null;
  let socket: ShellSocket | null = null;

  async function connect(): Promise<void> {
    if (!active || connecting || socket) return;
    connecting = true;

    try {
      connectionInfo ??= await options.resolveConnection();
      if (!active) return;

      const nextSocket = createSocket(connectionInfo.webSocketUrl, [
        SHELL_WEBSOCKET_PROTOCOL,
        `${SHELL_WEBSOCKET_AUTH_PREFIX}${connectionInfo.sessionToken}`
      ]);
      socket = nextSocket;

      nextSocket.onopen = () => {
        if (!active || socket !== nextSocket) return;
        reconnect.reset();
        options.onConnected();
      };
      nextSocket.onclose = () => {
        if (!active || socket !== nextSocket) return;
        detachSocket(nextSocket);
        socket = null;
        options.onSocket(null);
        options.onDisconnected();
        reconnect.schedule(() => void connect());
      };
      nextSocket.onmessage = (event) => {
        if (!active || socket !== nextSocket || typeof event.data !== "string") return;
        options.onMessage(event.data);
      };

      options.onSocket(nextSocket);
    } catch {
      if (active) options.onInitializationError();
    } finally {
      connecting = false;
    }
  }

  void connect();

  return {
    stop() {
      if (!active) return;
      active = false;
      reconnect.cancel();

      const currentSocket = socket;
      socket = null;
      options.onSocket(null);
      if (currentSocket) {
        detachSocket(currentSocket);
        currentSocket.close();
      }
    }
  };
}

function createReconnectScheduler(timerApi: ShellConnectionTimerApi) {
  let attempt = 0;
  let timerHandle: unknown | null = null;

  function cancel(): void {
    if (timerHandle === null) return;
    timerApi.clear(timerHandle);
    timerHandle = null;
  }

  return {
    schedule(callback: () => void): boolean {
      if (timerHandle !== null) return false;

      const delayMs = reconnectDelayMs(attempt);
      attempt += 1;
      timerHandle = timerApi.set(() => {
        timerHandle = null;
        callback();
      }, delayMs);
      return true;
    },
    reset(): void {
      cancel();
      attempt = 0;
    },
    cancel
  };
}

function detachSocket(socket: ShellSocket): void {
  socket.onopen = null;
  socket.onclose = null;
  socket.onmessage = null;
}
