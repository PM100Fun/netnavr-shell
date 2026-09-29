export type SyntheticMarker = "alpha" | "beta";
export type SyntheticResult = { state: string; runId: string; modelRequest: boolean; marker?: SyntheticMarker; threadId?: string; turnId?: string };
export class CodexSyntheticProvider {
  constructor(options: { executable: string; dedicatedHome: string; evidenceRoot: string });
  readonly cleanupUnconfirmed: boolean;
  status(): { phase: string; busy: boolean; cleanupUnconfirmed: boolean };
  cancel(): { state: string };
  preflight(): Promise<SyntheticResult>;
  run(marker: SyntheticMarker, options?: { signal?: AbortSignal }): Promise<SyntheticResult>;
}
