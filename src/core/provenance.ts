// Provenance labels for displayed numbers (issue #33).
//
// Every number ach shows is one of three kinds, and a reader comparing two
// figures needs to know which:
//
//   reported   came verbatim from the agent CLI / vendor (transcript token
//              counts, a CLI-stated costUSD, kiro metering credits)
//   computed   derived by ach from reported values (cost = tokens × bundled
//              price; any sum that blends reported and computed parts)
//   estimated  a heuristic (context-window occupancy derived from a percentage
//              and an assumed or stated window size)
//
// A lane the agent never reported has NO entry — it renders `n/a`, never a
// label. The numbers themselves never move: this is a sibling `provenance`
// map next to them, so consumers parsing today's JSON see no change.
//
// Pure: no I/O. Deliberately free of registry imports (registry imports this
// for its schema) — the record shapes below are structural.
import type { UsageAvailability } from "./types.ts";

export const PROVENANCE_CLASSES = ["reported", "computed", "estimated"] as const;
export type Provenance = (typeof PROVENANCE_CLASSES)[number];
/** Field name -> provenance class. A field without an entry is not labelled (n/a or untagged). */
export type ProvenanceMap = Record<string, Provenance>;

/** Compact on-screen markers. Reported numbers stay unmarked. */
export const PROVENANCE_MARKER: Readonly<Record<Provenance, string>> = {
  reported: "",
  computed: "*",
  estimated: "≈",
};

/** One-line legend shown under every surface that renders the markers. */
export const PROVENANCE_LEGEND =
  "* computed by ach (tokens x bundled price)  ≈ estimated (heuristic)  unmarked = reported by the agent CLI  n/a = not reported";

export function markerFor(p: Provenance | undefined): string {
  return p === undefined ? "" : PROVENANCE_MARKER[p];
}

export const TOKEN_LANES = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const;

/** Structural view of RunRecord.totals (see src/core/registry.ts). */
export interface RunTotalsLike {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  costSource?: "reported" | "computed";
  credits?: number;
  contextTokens?: number;
  provenance?: ProvenanceMap;
}

/**
 * Provenance of a run's totals.
 *  - token lanes: `reported` unless the usage verdict says tokens are
 *    unavailable, or (no verdict yet) nothing was counted — then absent;
 *  - costUsd: absent when usd is unavailable; else the driver's costSource;
 *    a cost with no single source (reported slices + token math) is
 *    `computed`, the conservative label; absent when nothing was priced;
 *  - credits: `reported` (vendor metering) when present;
 *  - contextTokens: always `estimated` (derived occupancy, never billed).
 */
export function runTotalsProvenance(totals: RunTotalsLike, usage?: UsageAvailability): ProvenanceMap {
  const out: ProvenanceMap = {};
  const counted = TOKEN_LANES.some((k) => totals[k] > 0);
  const tokensKnown = usage ? usage.tokens.available !== false : counted;
  if (tokensKnown) for (const k of TOKEN_LANES) out[k] = "reported";
  const usdKnown = usage ? usage.usd.available !== false : true;
  if (usdKnown) {
    if (totals.costSource !== undefined) out.costUsd = totals.costSource;
    else if (totals.costUsd > 0) out.costUsd = "computed";
  }
  if (totals.credits !== undefined) out.credits = "reported";
  if (totals.contextTokens !== undefined) out.contextTokens = "estimated";
  return out;
}

/** Structural view of a RunRecord for {@link provenanceOf}. */
export interface RunRecordLike {
  source?: "local" | "external" | "imported";
  totals?: RunTotalsLike;
  usage?: UsageAvailability;
}

/**
 * The provenance map to render for a record: the stored one when the driver
 * wrote it; otherwise derived for LOCAL records (the driver has always priced
 * totals.costUsd itself). An external producer's record without a map gets
 * `{}` — ach does not know where its numbers came from, so it claims nothing.
 */
export function provenanceOf(rec: RunRecordLike): ProvenanceMap {
  const t = rec.totals;
  if (!t) return {};
  if (t.provenance) return t.provenance;
  if (rec.source === "external") return {};
  return runTotalsProvenance(t, rec.usage);
}
