import { randomBytes } from "node:crypto";
import type { FixtureCommandInput, FixtureCommandResult } from "@netnavr/core/fixture-contract";
import { bridgeFailure, FixtureClient, type FixtureBridgeResult, type FixtureLifecycle,
  type FixtureReadout } from "./fixture-bridge.js";

export type OwnedCore = { origin: string; close(): Promise<void>; onExit(callback: () => void): void };
export type LaunchOwnedCore = (token: string, signal: AbortSignal) => Promise<OwnedCore>;
export class OwnedCoreLaunchError extends Error {
  constructor(readonly owned: OwnedCore) { super("Owned child exit unconfirmed"); }
}

// This owner knows only the child it created. It never adopts NETNAVR_CORE_PORT,
// external processes, real user databases or a renderer-supplied origin.
export class FixtureOwner {
  private lifecycle: FixtureLifecycle["state"] = "stopped";
  private handle?: OwnedCore;
  private client?: FixtureClient;
  private generation = 0;
  private pendingCommands = new Set<string>();
  private startup?: Promise<FixtureBridgeResult<FixtureReadout>>;
  private shutdown?: Promise<FixtureBridgeResult<FixtureReadout>>;
  private controller?: AbortController;

  constructor(private readonly launch: LaunchOwnedCore) {}

  binding(): { generation: number; signal: AbortSignal } | undefined {
    return this.client && this.controller && this.pendingCommands.size === 0 ? { generation: this.generation, signal: this.controller.signal } : undefined;
  }
  submitBound(input: FixtureCommandInput, binding: { generation: number; signal: AbortSignal }) {
    return binding.generation === this.generation && binding.signal === this.controller?.signal && !binding.signal.aborted
      ? this.submit(input) : Promise.resolve(bridgeFailure("stale_session", "Core changed during provider execution"));
  }
  start(): Promise<FixtureBridgeResult<FixtureReadout>> {
    if (this.shutdown) return Promise.resolve(bridgeFailure("stopping", "Wait until the engineering Core has stopped"));
    if (this.startup) return this.startup;
    if (this.client) return this.state();
    if (this.handle) return Promise.resolve(bridgeFailure("shutdown_unconfirmed", "Stop the previous owned Core before starting another"));
    const generation = ++this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.lifecycle = "starting";
    const token = randomBytes(32).toString("base64url");
    const work = (async () => this.launch(token, controller.signal))().then(async (handle) => {
      if (generation !== this.generation || controller.signal.aborted) {
        try { await handle.close(); } catch { this.handle = handle; throw new Error("Owned child exit unknown"); }
        return bridgeFailure("cancelled", "Engineering Core startup was cancelled");
      }
      this.handle = handle;
      this.client = new FixtureClient(handle.origin, token);
      handle.onExit(() => {
        if (this.handle !== handle) return;
        this.handle = undefined;
        this.client = undefined;
        controller.abort();
        this.lifecycle = "error";
      });
      const response = await this.client.state(controller.signal);
      if (!response.ok) {
        this.client = undefined;
        controller.abort();
        await handle.close();
        this.handle = undefined;
        this.lifecycle = "error";
        return response;
      }
      if (generation !== this.generation || controller.signal.aborted) {
        return bridgeFailure("cancelled", "Engineering Core startup was cancelled");
      }
      this.lifecycle = "online";
      return { ok: true as const, value: { state: "online" as const, fixture: response.value } };
    }).catch(async (error: unknown) => {
      if (error instanceof OwnedCoreLaunchError) {
        const unconfirmed = error.owned;
        this.handle = unconfirmed;
        this.client = undefined;
        controller.abort();
        unconfirmed.onExit(() => { if (this.handle === unconfirmed) { this.handle = undefined; this.lifecycle = "error"; } });
        if (generation === this.generation) this.lifecycle = "error";
        return bridgeFailure("shutdown_unconfirmed", "Owned Core startup failed and its exit was not confirmed; retry Stop");
      }
      if (generation === this.generation && this.handle) {
        const failedHandle = this.handle;
        this.client = undefined;
        controller.abort();
        try { await failedHandle.close(); this.handle = undefined; } catch { /* preserve owner for retry */ }
      }
      if (generation === this.generation) this.lifecycle = "error";
      return bridgeFailure(controller.signal.aborted ? "cancelled" : "startup_failed",
        controller.signal.aborted ? "Engineering Core startup was cancelled" : "Engineering Core could not start; verify the packaged Node/SQLite runtime");
    });
    // Keep one request per owner; no token is returned in a lifecycle readout.
    this.startup = work;
    void work.finally(() => { if (this.startup === work) this.startup = undefined; });
    return work;
  }
  async state(): Promise<FixtureBridgeResult<FixtureReadout>> {
    const client = this.client;
    if (!client) return { ok: true, value: { state: this.lifecycle } };
    const response = await client.state(this.controller?.signal);
    return response.ok ? { ok: true, value: { state: this.lifecycle, fixture: response.value } } : response;
  }
  submit(input: FixtureCommandInput): Promise<FixtureBridgeResult<FixtureCommandResult>> {
    if (!this.client) return Promise.resolve(bridgeFailure("not_started", "Start the engineering Core explicitly first"));
    if (this.pendingCommands.size >= 128 && !this.pendingCommands.has(input.commandId)) return Promise.resolve(bridgeFailure("pending_limit", "Read or stop pending engineering commands first"));
    const generation = this.generation;
    this.pendingCommands.add(input.commandId);
    return this.client.submit(input, this.controller?.signal).then((result) => {
      if (generation === this.generation && result.ok && result.value.status !== "pending") this.pendingCommands.delete(input.commandId);
      return result;
    });
  }
  read(commandId: string): Promise<FixtureBridgeResult<FixtureCommandResult>> {
    const generation = this.generation;
    return this.client ? this.client.read(commandId, this.controller?.signal).then((result) => { if (generation === this.generation && result.ok && result.value.status !== "pending") this.pendingCommands.delete(commandId); return result; }) : Promise.resolve(bridgeFailure("not_started", "The engineering Core is not running"));
  }
  cancel(commandId: string): Promise<FixtureBridgeResult<FixtureCommandResult>> {
    const generation = this.generation;
    return this.client ? this.client.cancel(commandId, this.controller?.signal).then((result) => { if (generation === this.generation && result.ok && result.value.status !== "pending") this.pendingCommands.delete(commandId); return result; }) : Promise.resolve(bridgeFailure("not_started", "The engineering Core is not running"));
  }
  stop(): Promise<FixtureBridgeResult<FixtureReadout>> {
    if (this.shutdown) return this.shutdown;
    ++this.generation;
    this.pendingCommands.clear();
    this.lifecycle = "stopping";
    this.controller?.abort();
    const handle = this.handle;
    this.handle = undefined;
    this.client = undefined;
    const pending = this.startup;
    const work = (async (): Promise<FixtureBridgeResult<FixtureReadout>> => {
      try {
        await handle?.close();
        await pending;
        if (this.handle) throw new Error("Late child exit not confirmed");
        this.lifecycle = "stopped";
        return { ok: true, value: { state: "stopped" } };
      } catch {
        if (handle) this.handle = handle;
        this.lifecycle = "error";
        return bridgeFailure("shutdown_failed", "The owned engineering Core could not stop cleanly");
      }
    })();
    this.shutdown = work;
    void work.finally(() => { if (this.shutdown === work) this.shutdown = undefined; });
    return work;
  }
}
