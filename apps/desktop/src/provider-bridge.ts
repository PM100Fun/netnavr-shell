import { parseFixtureCommandResult } from "./fixture-bridge.js";
import type { FixtureCommandResult } from "@netnavr/core/fixture-contract";
export const PROVIDER_CHANNELS = Object.freeze({ status: "netnavr:provider:status", preflight: "netnavr:provider:preflight", run: "netnavr:provider:run", cancel: "netnavr:provider:cancel" });
export type ProviderReadout = { state: string; busy: boolean; modelRequest: boolean; runId?: string; core?: FixtureCommandResult };
export function parseProviderMarker(value: unknown): "alpha" | "beta" {
  if (value !== "alpha" && value !== "beta") throw new TypeError("Only alpha or beta is allowed");
  return value;
}
export function parseProviderReadout(value: unknown): ProviderReadout {
  if (!value || typeof value !== "object") throw new TypeError("Invalid provider response");
  const v = value as Record<string, unknown>;
  if (typeof v.state !== "string" || !/^[A-Z_]{1,64}$/.test(v.state) || typeof v.busy !== "boolean" || typeof v.modelRequest !== "boolean" ||
    (v.runId !== undefined && (typeof v.runId !== "string" || !/^provider_[a-f0-9-]{36}$/.test(v.runId)))) throw new TypeError("Invalid provider response");
  return { state: v.state, busy: v.busy, modelRequest: v.modelRequest,
    ...(typeof v.runId === "string" ? { runId: v.runId } : {}), ...(v.core !== undefined ? { core: parseFixtureCommandResult(v.core) } : {}) };
}
