// Run registry + token records + budget for one desk host (#204). Owner: metering seat.
import type { HostSpec, HostState } from "./types.ts";

export interface UsageSample {
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Engine-reported cost; null/0 from an unpriced provider -> computed by the ach pricer when the model is known. */
  costUsd: number | null;
  /** Engine message id; a repeated id replaces (not adds to) the earlier sample. */
  messageId?: string;
  at: number;
}

export interface HostMeter {
  /** Writes the RunRecord (status running, desk info, parentRunId, cwd, agent, sessionId). */
  begin(o: { sessionId?: string; pid: number }): void;
  usage(s: UsageSample): void;
  /** updatedAt heartbeat + lastEvent preview. */
  heartbeat(state: HostState, lastEvent?: string): void;
  /** Budget check: true when spec.budgetUsd is set and the run's cost crossed it (an alert is recorded once). */
  overBudget(): boolean;
  finish(status: "success" | "error" | "aborted"): void;
  totals(): { costUsd: number | null; inputTokens: number; outputTokens: number };
}

export function createHostMeter(_spec: HostSpec): HostMeter {
  throw new Error("desks: createHostMeter not implemented yet");
}
