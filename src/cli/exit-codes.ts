// Automation exit-code ladder (agentic-coding-harness#31). Opt-in via
// `--exit-codes ladder` on `run` / `stats` / `watch` (and any command that
// reports "nothing to report", e.g. a future `status`); the default mode
// (`binary`) is exactly the historical 0/1 contract, so no existing script
// changes behaviour. The table, with one trigger per code, is documented in
// docs/EXIT-CODES.md — keep the two in sync.
//
//   0  ok             run succeeded (and is not near a limit) / there is data
//   10 near-limit     run succeeded but used >= NEAR_LIMIT_FRACTION of a
//                     configured AND measurable budget (usd, maxTurns, wallMs)
//   11 limit-hit      run ended budget_exceeded or turn_limit
//   20 indeterminate  run ended with no task verdict: exitStatus unavailable
//                     (missing binary, no auth, outage — see #60)
//   30 no-data        a reporting command found nothing to report
//   1  error          everything else: task failure (error), timeout,
//                     aborted, cancelled, and every argument/usage error
//
// A ratio is only computed on a dimension the run could MEASURE: a run whose
// usage says USD is unavailable (kiro: credits only) never reads "near the
// USD budget" — that would be an estimate, not a measurement.

import { countsAsTurn } from "../core/driver.ts";
import { HarnessError, type RunResult } from "../core/types.ts";

export type ExitCodeMode = "binary" | "ladder";

export const EXIT_CODES = {
  ok: 0,
  error: 1,
  nearLimit: 10,
  limitHit: 11,
  indeterminate: 20,
  noData: 30,
} as const;

/** A successful run at or above this fraction of any budget exits 10. */
export const NEAR_LIMIT_FRACTION = 0.8;

/** `--exit-codes <binary|ladder>`; absent means binary (historical 0/1). */
export function parseExitCodesMode(value: string | undefined): ExitCodeMode {
  if (value === undefined || value === "binary") return "binary";
  if (value === "ladder") return "ladder";
  throw new HarnessError(`--exit-codes expects 'ladder' or 'binary', got '${value}'`, "USAGE");
}

/** The budget dimensions the ladder can judge (RunSpec.budget subset). */
export interface LadderBudget {
  usd?: number;
  maxTurns?: number;
  wallMs?: number;
}

export interface BudgetFraction {
  dimension: "usd" | "maxTurns" | "wallMs";
  used: number;
  limit: number;
  fraction: number;
}

/**
 * used/limit for every budget dimension that was configured (> 0) and that
 * the run could measure. Pure; exported for tests and for callers that want
 * to print which dimension tripped the near-limit code.
 */
export function budgetFractions(result: RunResult, opts: { budget?: LadderBudget; agent?: string }): BudgetFraction[] {
  const out: BudgetFraction[] = [];
  const b = opts.budget ?? {};
  if (b.usd !== undefined && b.usd > 0 && result.usage?.usd.available !== false) {
    out.push({ dimension: "usd", used: result.totalCost, limit: b.usd, fraction: result.totalCost / b.usd });
  }
  if (b.maxTurns !== undefined && b.maxTurns > 0) {
    const agent = opts.agent ?? result.agent ?? "";
    const turns = result.events.filter((e) => e.type === "step" && countsAsTurn(agent, e)).length;
    out.push({ dimension: "maxTurns", used: turns, limit: b.maxTurns, fraction: turns / b.maxTurns });
  }
  if (b.wallMs !== undefined && b.wallMs > 0) {
    out.push({ dimension: "wallMs", used: result.durationMs, limit: b.wallMs, fraction: result.durationMs / b.wallMs });
  }
  return out;
}

/** Process exit code for a settled `ach run`. */
export function runExitCode(
  result: RunResult,
  opts: { mode: ExitCodeMode; budget?: LadderBudget; agent?: string },
): number {
  if (opts.mode === "binary") return result.exitStatus === "success" ? EXIT_CODES.ok : EXIT_CODES.error;
  switch (result.exitStatus) {
    case "success":
      return budgetFractions(result, opts).some((f) => f.fraction >= NEAR_LIMIT_FRACTION)
        ? EXIT_CODES.nearLimit
        : EXIT_CODES.ok;
    case "budget_exceeded":
    case "turn_limit":
      return EXIT_CODES.limitHit;
    case "unavailable":
      return EXIT_CODES.indeterminate;
    default:
      return EXIT_CODES.error;
  }
}

/** Exit code for a reporting command (`stats`, `status`) that found `count` items. */
export function noDataExitCode(count: number, mode: ExitCodeMode): number {
  return mode === "ladder" && count === 0 ? EXIT_CODES.noData : EXIT_CODES.ok;
}
