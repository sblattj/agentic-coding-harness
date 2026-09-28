// Cost display modes for `ach stats` (issue #28).
//
// A CLI-reported cost and our own token × bundled-price math disagree in
// practice (pricing snapshots drift, cache tiers, enterprise discounts), so
// stats lets the user pick which number to trust and labels every figure with
// where it came from instead of silently blending the two.
//
//   auto       CLI-reported when present, else computed (the historical default)
//   calculate  always token × bundled price, even when a reported number exists
//   display    CLI-reported verbatim; null when absent, never computed

import { HarnessError } from "../core/types.ts";
import type { CostSource, UsageBucket } from "./lib.ts";

export const COST_MODES = ["auto", "calculate", "display"] as const;
export type CostMode = (typeof COST_MODES)[number];

export const COST_MODE_ENV = "AGENTIC_CODING_HARNESS_COST_MODE";

/** A reported and a computed cost disagree when they differ by MORE than this. */
export const COST_DISAGREEMENT_PCT = 1;

/**
 * Resolve the effective mode: the flag wins, then the env var, then `auto`.
 * An empty env var counts as unset. A bad name throws BAD_COST_MODE listing
 * the valid modes and naming where the bad value came from.
 */
export function resolveCostMode(flag: string | undefined, env: string | undefined): CostMode {
  const fromFlag = flag !== undefined;
  const raw = fromFlag ? flag : env !== undefined && env !== "" ? env : undefined;
  if (raw === undefined) return "auto";
  if ((COST_MODES as readonly string[]).includes(raw)) return raw as CostMode;
  throw new HarnessError(
    `unknown cost mode '${raw}' from ${fromFlag ? "--cost-mode" : COST_MODE_ENV} (expected one of: ${COST_MODES.join(", ")})`,
    "BAD_COST_MODE",
  );
}

/** Pick one record's cost under `mode`. An empty object = no cost (contributes nothing). */
export function selectCost(
  mode: CostMode,
  reported: number | undefined,
  computed: number | undefined,
): { costUsd?: number; costSource?: CostSource } {
  const pick = (v: number | undefined, source: CostSource) => (v === undefined ? {} : { costUsd: v, costSource: source });
  if (mode === "display") return pick(reported, "reported");
  if (mode === "calculate") return pick(computed, "computed");
  return reported !== undefined ? pick(reported, "reported") : pick(computed, "computed");
}

export interface CostDisagreement {
  reported: number;
  computed: number;
  /** reported − computed, USD. */
  deltaUsd: number;
  /** |reported − computed| / max(|reported|, |computed|) × 100 (symmetric; no divide-by-zero). */
  deltaPct: number;
}

/** Non-null when both values exist and differ by more than {@link COST_DISAGREEMENT_PCT}. */
export function costDisagreement(
  reported: number | undefined,
  computed: number | undefined,
  thresholdPct: number = COST_DISAGREEMENT_PCT,
): CostDisagreement | null {
  if (reported === undefined || computed === undefined) return null;
  const denom = Math.max(Math.abs(reported), Math.abs(computed));
  if (denom === 0) return null;
  const deltaUsd = reported - computed;
  const deltaPct = (Math.abs(deltaUsd) / denom) * 100;
  return deltaPct > thresholdPct ? { reported, computed, deltaUsd, deltaPct } : null;
}

const usd = (n: number): string => `$${n.toFixed(6)}`;

export function formatDisagreement(label: string, d: CostDisagreement): string {
  const sign = d.deltaUsd >= 0 ? "+" : "-";
  return `cost disagreement: ${label} reported=${usd(d.reported)} computed=${usd(d.computed)} delta=${sign}${usd(Math.abs(d.deltaUsd))} (${d.deltaPct.toFixed(2)}%)`;
}

/** A stats bucket as emitted: costUsd is null when the mode found no cost to show. */
export type CostModeBucket = Omit<UsageBucket, "costUsd"> & { costUsd: number | null };

/**
 * `auto` keeps costUsd numeric (0 for an unpriced bucket, byte-identical to the
 * pre-mode output). `display` / `calculate` report null when no record in the
 * bucket had a cost of the one source they accept, so "nothing reported" is
 * never rendered as "$0".
 */
export function applyCostMode(b: UsageBucket, mode: CostMode): CostModeBucket {
  if (mode === "auto") return b;
  const none = b.costBySource.reported === null && b.costBySource.computed === null;
  return none ? { ...b, costUsd: null } : b;
}
