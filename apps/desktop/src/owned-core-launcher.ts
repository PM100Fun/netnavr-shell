import { OwnedCoreLaunchError, type OwnedCore } from "./fixture-owner.js";

// The same owned-child handshake is used by Electron and Node integration
// checks. Only this child is stopped/killed; failed exit retains this handle.
export type OwnedChild = {
  onSpawn(callback: () => void): void;
  onMessage(callback: (value: unknown) => void): void;
  onExit(callback: () => void): void;
  postMessage(value: unknown): void;
  kill(): void;
};
export function launchOwnedCoreChild(child: OwnedChild, token: string, dataDirectory: string,
  signal: AbortSignal, limits = { startupMs: 5000, gracefulStopMs: 2000, finalExitMs: 3000 }): Promise<OwnedCore> {
  return new Promise((resolve, reject) => {
    let launched = false;
    let failed = false;
    let spawned = false;
    let exited = false;
    let origin = "";
    let exitCallback: (() => void) | undefined;
    let closing: Promise<void> | undefined;
    const exitWaiters = new Set<() => void>();
    const tryKill = () => { try { child.kill(); } catch { /* retain handle until actual exit */ } };
    const tryStop = () => { try { child.postMessage({ type: "stop" }); } catch { tryKill(); } };
    const owned: OwnedCore = {
      get origin() { return origin; },
      onExit: (callback) => { exitCallback = callback; if (exited) callback(); },
      close: () => {
        if (exited) return Promise.resolve();
        if (closing) return closing;
        const work = new Promise<void>((done, notConfirmed) => {
          const finish = () => { clearTimeout(graceful); clearTimeout(final); exitWaiters.delete(finish); done(); };
          const graceful = setTimeout(tryKill, limits.gracefulStopMs);
          const final = setTimeout(() => { clearTimeout(graceful); exitWaiters.delete(finish); notConfirmed(new Error("Owned exit unconfirmed")); }, limits.finalExitMs);
          exitWaiters.add(finish);
          if (spawned) tryStop();
          else tryKill();
        });
        closing = work;
        void work.finally(() => { if (closing === work) closing = undefined; }).catch(() => undefined);
        return work;
      },
    };
    const startupTimer = setTimeout(() => { void fail(); }, limits.startupMs);
    const cleanup = () => { clearTimeout(startupTimer); signal.removeEventListener("abort", abort); };
    const fail = async () => {
      if (launched || failed) return;
      failed = true;
      cleanup();
      try { await owned.close(); reject(new Error("Owned startup failed; exit confirmed")); }
      catch { reject(new OwnedCoreLaunchError(owned)); }
    };
    const abort = () => { void fail(); };
    signal.addEventListener("abort", abort, { once: true });
    child.onSpawn(() => {
      spawned = true;
      if (failed || signal.aborted) { tryStop(); return; }
      try { child.postMessage({ type: "start", token, dataDirectory }); } catch { void fail(); }
    });
    child.onMessage((value) => {
      if (launched || failed || !value || typeof value !== "object") return;
      const message = value as Record<string, unknown>;
      if (message.type === "failed") { void fail(); return; }
      if (message.type !== "ready" || typeof message.origin !== "string" ||
        !/^http:\/\/127\.0\.0\.1:\d+$/.test(message.origin)) return;
      try {
        const port = Number(new URL(message.origin).port);
        if (port < 1 || port > 65535) throw new TypeError("Invalid port");
      } catch { void fail(); return; }
      origin = message.origin;
      launched = true;
      cleanup();
      resolve(owned);
    });
    child.onExit(() => {
      exited = true;
      for (const finish of exitWaiters) finish();
      exitCallback?.();
      if (!launched && !failed) { failed = true; cleanup(); reject(new Error("Owned child exited during startup")); }
    });
    if (signal.aborted) void fail();
  });
}
