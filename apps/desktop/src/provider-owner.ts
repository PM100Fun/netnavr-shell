import { randomUUID } from "node:crypto";
import type { CodexSyntheticProvider, SyntheticResult } from "../../../packages/provider-probe/src/codex-synthetic.mjs";
import type { FixtureOwner } from "./fixture-owner.js";
import { parseProviderMarker, parseProviderReadout, type ProviderReadout } from "./provider-bridge.js";

type Provider = Pick<CodexSyntheticProvider, "preflight" | "run" | "cancel" | "status" | "cleanupUnconfirmed">;
// One owner serializes the safe provider and its final Core write. Renderer
// input never supplies paths, prompts, model names, credentials or Core IDs.
export class ProviderOwner {
  private active?: Promise<ProviderReadout>;
  private controller?: AbortController;
  private committing = false;
  private last: ProviderReadout = { state: "NOT_CONFIGURED", busy: false, modelRequest: false };
  constructor(private readonly provider: Provider | undefined, private readonly core: FixtureOwner) {
    if (provider) this.last.state = "READY";
  }
  get busy() { return this.active !== undefined; }
  status(): ProviderReadout {
    return this.busy ? { state: this.committing ? "COMMITTING" : this.provider?.status().phase ?? "PREFLIGHT", busy: true, modelRequest: this.provider?.status().phase === "RUNNING" }
      : parseProviderReadout(this.last);
  }
  preflight() { return this.begin(null); }
  run(input: unknown) { return this.begin(parseProviderMarker(input)); }
  cancel(): ProviderReadout {
    if (!this.active) return { state: "NO_ACTIVE_RUN", busy: false, modelRequest: false };
    if (this.committing) return { state: "COMMIT_IN_PROGRESS", busy: true, modelRequest: true };
    this.controller?.abort(); this.provider?.cancel();
    return { state: "CANCEL_REQUESTED", busy: true, modelRequest: this.provider?.status().phase === "RUNNING" };
  }
  async stop(): Promise<boolean> {
    this.cancel(); await this.active;
    return this.provider?.cleanupUnconfirmed !== true;
  }
  private begin(marker: "alpha" | "beta" | null): Promise<ProviderReadout> {
    if (this.active) return Promise.resolve({ state: "BUSY", busy: true, modelRequest: false });
    if (!this.provider) return Promise.resolve(this.status());
    const provider = this.provider;
    const controller = this.controller = new AbortController();
    // Queue work so active is assigned before any await or immediate rejection.
    const work = Promise.resolve().then(async (): Promise<ProviderReadout> => {
      const binding = this.core.binding();
      const signal = binding ? AbortSignal.any([controller.signal, binding.signal]) : controller.signal;
      let initial;
      if (marker !== null) {
        initial = await this.core.state();
        if (!binding || !initial.ok || initial.value.state !== "online" || !initial.value.fixture) return { state: "CORE_NOT_READY", busy: false, modelRequest: false };
      }
      if (signal.aborted) return { state: "CANCELLED", busy: false, modelRequest: false };
      const response: SyntheticResult = marker === null ? await provider.preflight() : await provider.run(marker, { signal });
      const base = { state: response.state, runId: response.runId, modelRequest: response.modelRequest, busy: false };
      if (response.state !== "COMPLETED" || marker === null) return base;
      if (signal.aborted) return { ...base, state: "CANCELLED" };
      if (response.marker !== marker || !response.threadId || !response.turnId) return { ...base, state: "INVALID_MARKER_RESPONSE" };
      const current = await this.core.state();
      if (signal.aborted || !binding || !current.ok || !current.value.fixture || !initial?.ok || !initial.value.fixture ||
        current.value.fixture.fixtureSessionId !== initial.value.fixture.fixtureSessionId || current.value.fixture.revision !== initial.value.fixture.revision) return { ...base, state: "CORE_CHANGED" };
      this.committing = true;
      let result = await this.core.submitBound({ commandId: `cmd_${randomUUID()}`, operation: "set-marker", marker, delayMs: 0, timeoutMs: 1000 }, binding);
      for (let attempt = 0; result.ok && result.value.status === "pending" && attempt < 20; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        result = await this.core.read(result.value.commandId);
      }
      if (!result.ok) return { ...base, state: "CORE_COMMIT_FAILED" };
      if (result.value.status !== "completed" || result.value.state.marker !== marker || result.value.fixtureSessionId !== initial.value.fixture.fixtureSessionId) return { ...base, state: "CORE_COMMIT_UNCONFIRMED" };
      return { ...base, state: "COMPLETED", core: result.value };
    }).catch((): ProviderReadout => ({ state: "PROVIDER_FAILED", busy: false, modelRequest: false }));
    this.active = work;
    void work.then((result) => { this.last = parseProviderReadout(result); this.active = undefined; this.controller = undefined; this.committing = false; });
    return work;
  }
}
