import { startCore } from "@netnavr/core";

// A utility-process entry, bundled with the exact pinned Core. Private IPC only;
// never read credentials, user data paths or launch settings from environment.
type ParentPort = { on(name: "message", callback: (event: { data: unknown }) => void): void; postMessage(value: unknown): void };
const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
let runtime: Awaited<ReturnType<typeof startCore>> | undefined;
let initialized = false;
let closing = false;
const send = (value: unknown): void => {
  if (parentPort) parentPort.postMessage(value);
  else process.send?.(value as object);
};

async function receive(value: unknown): Promise<void> {
  if (!value || typeof value !== "object") return;
  const message = value as Record<string, unknown>;
  if (message.type === "stop") {
    closing = true;
    await runtime?.close();
    send({ type: "stopped" });
    process.exit(0);
  }
  if (message.type !== "start" || initialized || closing) return;
  initialized = true;
  try {
    if (typeof message.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(message.token) ||
      typeof message.dataDirectory !== "string" ||
      Object.keys(message).some((key) => !["type", "token", "dataDirectory"].includes(key))) throw new TypeError("Invalid launch");
    runtime = await startCore({ port: 0, databasePath: ":memory:", fixtureProbe: { token: message.token, dataDirectory: message.dataDirectory } });
    if (closing) { await runtime.close(); process.exit(0); }
    send({ type: "ready", origin: runtime.origin });
  } catch {
    send({ type: "failed", code: "startup_failed" });
    process.exitCode = 1;
  }
}

// Node's IPC form exists only to exercise the same bundled worker outside GUI
// tests. Electron ships its own Node runtime through utilityProcess.fork.
if (parentPort) parentPort.on("message", (event) => { void receive(event.data); });
else if (process.send) process.on("message", (value) => { void receive(value); });
else throw new Error("Core worker requires an owned private IPC parent");
process.on("disconnect", () => {
  closing = true;
  void Promise.resolve(runtime?.close()).finally(() => process.exit(0));
});
