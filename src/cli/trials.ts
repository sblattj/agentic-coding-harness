// Trials: outcome verification (#29), repeat groups (#57), and the
// per-repeat-group rollup `ach stats` prints (#57 → #30).
//
// `ach run` stays a thin shell over these helpers. The driver itself is not
// touched: the verifier runs AFTER driver.run() has settled (its final
// registry write is synchronous and forced), and the verdict + labels are
// patched onto the run's registry file here. A run without --verify /
// --repeat / --experiment / --variant never reaches annotateRunRecord, so
// its record is byte-identical to before.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Driver } from "../core/driver.ts";
import { patchRunRecord, registryDir, type RepeatMembership, type RunRecord } from "../core/registry.ts";
import { HermeticSyncError, runHermetic, type RunHermeticOptions } from "../core/hermetic.ts";
import { repeatStats, type RepeatStats } from "../core/repeat-stats.ts";
import { HarnessError, type RunResult, type RunSpec } from "../core/types.ts";
import { runVerifier, type VerifyResult } from "../core/verify.ts";

export interface VerifyRequest {
  command: string;
  timeoutMs: number;
  cwd: string;
  /** Checker env (default process.env); `ach trial --matrix` adds ACH_* cell vars. */
  env?: NodeJS.ProcessEnv;
}

export interface RunLabels {
  experiment?: string;
  variant?: string;
  /** `ach trial --matrix` cell identity (#56): agent:task:model:trialN. */
  cellId?: string;
}

/** Merge `patch` into the run's registry file, reading the RAW JSON (not the
 *  schema-parsed view, which would inject defaults like source:"local").
 *  Returns false when the record does not exist or cannot be rewritten. */
export function annotateRunRecord(stateDir: string, runId: string, patch: Partial<RunRecord>): boolean {
  return patchRunRecord(stateDir, runId, patch);
}

/** Read one registry record as raw JSON (see annotateRunRecord). */
export function readRawRunRecord(stateDir: string, runId: string): RunRecord | null {
  // Run ids are uuids; refuse anything that could walk out of runs/.
  if (runId === "" || runId.includes("/") || runId.includes("\\") || runId.startsWith(".")) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(registryDir(stateDir), `${runId}.json`), "utf8")) as RunRecord;
  } catch {
    return null;
  }
}

export interface TrialOutcome {
  index: number;
  result?: RunResult;
  verify?: VerifyResult;
  /** driver.run() threw (launch failure etc.) — the child still counts as attempted. */
  error?: string;
  /** HarnessError code of the throw (e.g. UNAVAILABLE → exit 20 under the ladder). */
  errorCode?: string;
  repeat?: RepeatMembership;
  /** Registry annotation failed (record missing/unwritable) — surfaced as a warning. */
  annotateFailed?: boolean;
}

/** A child "passed the gate" when the agent succeeded and, if a checker ran,
 *  the checker passed. This is what the CLI exit code reflects. */
export function outcomeOk(o: TrialOutcome): boolean {
  if (o.result?.exitStatus !== "success") return false;
  return o.verify === undefined || o.verify.status === "pass";
}

export interface RunOnceOptions {
  driver: Pick<Driver, "run">;
  agent: string;
  spec: RunSpec;
  stateDir: string;
  verify?: VerifyRequest;
  labels?: RunLabels;
  repeat?: RepeatMembership;
  /**
   * #106: run in a hermetic temp copy of spec.cwd (src/core/hermetic.ts),
   * synced back BEFORE the verifier runs, so the checker sees the edits.
   */
  hermetic?: Omit<RunHermeticOptions, "stateDir">;
}

/** Verify + annotate one settled run. Throws only if driver.run (or the
 *  hermetic preparation / sync-back) throws. */
export async function runOnce(opts: RunOnceOptions): Promise<TrialOutcome> {
  let result: RunResult;
  try {
    result =
      opts.hermetic !== undefined
        ? await runHermetic(opts.driver, opts.agent, opts.spec, { ...opts.hermetic, stateDir: opts.stateDir })
        : await opts.driver.run(opts.agent, opts.spec);
  } catch (err) {
    // #113: sync-back failed but the run itself settled. Keep what it
    // produced: grade --verify against the KEPT temp copy (the original
    // workspace never received the edits), label the record, and hand the
    // partial outcome to the caller on the error so `--json` can still emit it.
    if (err instanceof HermeticSyncError && err.result !== undefined) {
      const partial: TrialOutcome = { index: opts.repeat?.index ?? 0, result: err.result };
      if (opts.repeat !== undefined) partial.repeat = opts.repeat;
      if (opts.verify !== undefined) {
        partial.verify = await runVerifier({
          command: opts.verify.command,
          cwd: err.keptDir,
          env: opts.verify.env ?? process.env,
          timeoutMs: opts.verify.timeoutMs,
        });
      }
      const patch: Partial<RunRecord> = {
        ...(opts.labels?.experiment !== undefined ? { experiment: opts.labels.experiment } : {}),
        ...(opts.labels?.variant !== undefined ? { variant: opts.labels.variant } : {}),
        ...(opts.labels?.cellId !== undefined ? { cellId: opts.labels.cellId } : {}),
        ...(opts.repeat !== undefined ? { repeat: opts.repeat } : {}),
        ...(partial.verify !== undefined ? { verify: partial.verify } : {}),
      };
      if (Object.keys(patch).length > 0 && !annotateRunRecord(opts.stateDir, err.result.runId, patch)) {
        partial.annotateFailed = true;
      }
      err.partial = partial;
    }
    throw err;
  }
  const outcome: TrialOutcome = { index: opts.repeat?.index ?? 0, result };
  if (opts.repeat !== undefined) outcome.repeat = opts.repeat;
  if (opts.verify !== undefined) {
    outcome.verify = await runVerifier({
      command: opts.verify.command,
      cwd: opts.verify.cwd,
      env: opts.verify.env ?? process.env,
      timeoutMs: opts.verify.timeoutMs,
    });
  }
  const patch: Partial<RunRecord> = {
    ...(opts.labels?.experiment !== undefined ? { experiment: opts.labels.experiment } : {}),
    ...(opts.labels?.variant !== undefined ? { variant: opts.labels.variant } : {}),
    ...(opts.labels?.cellId !== undefined ? { cellId: opts.labels.cellId } : {}),
    ...(opts.repeat !== undefined ? { repeat: opts.repeat } : {}),
    ...(outcome.verify !== undefined ? { verify: outcome.verify } : {}),
  };
  if (Object.keys(patch).length > 0 && !annotateRunRecord(opts.stateDir, result.runId, patch)) {
    outcome.annotateFailed = true;
  }
  return outcome;
}

export interface RepeatOptions extends Omit<RunOnceOptions, "repeat"> {
  count: number;
  parallel?: number;
  /** Called as each child settles (for streaming summaries). */
  onSettled?: (o: TrialOutcome) => void;
  /** Group id override (tests); a fresh uuid otherwise. */
  group?: string;
}

export interface RepeatGroupResult {
  group: string;
  count: number;
  outcomes: TrialOutcome[];
}

/** Run `count` fresh sessions of the same spec, at most `parallel` at a time
 *  (default 1: sequential). A child that fails or throws never stops the
 *  rest; outcomes come back ordered by index. */
export async function runRepeatGroup(opts: RepeatOptions): Promise<RepeatGroupResult> {
  const group = opts.group ?? randomUUID();
  const width = Math.max(1, Math.min(opts.parallel ?? 1, opts.count));
  const outcomes: TrialOutcome[] = new Array(opts.count);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < opts.count) {
      const index = next++;
      const repeat: RepeatMembership = { group, index, count: opts.count };
      let outcome: TrialOutcome;
      try {
        // A fresh spec object per child: no runId is shared, so the driver
        // mints a new id and the adapter launches a brand-new session.
        const { runId: _drop, ...spec } = opts.spec;
        void _drop;
        outcome = await runOnce({ ...opts, spec: spec as RunSpec, repeat });
      } catch (err) {
        outcome = {
          // #113: a hermetic sync failure still carries the settled run + verdict.
          ...(err instanceof HermeticSyncError && err.partial !== undefined ? err.partial : {}),
          index,
          repeat,
          error: err instanceof Error ? err.message : String(err),
          ...(err instanceof HarnessError ? { errorCode: err.code } : {}),
        };
      }
      outcomes[index] = outcome;
      opts.onSettled?.(outcome);
    }
  };
  await Promise.all(Array.from({ length: width }, () => worker()));
  return { group, count: opts.count, outcomes };
}

/** Repeat statistics over a group's VERIFIED outcomes (undefined when no
 *  child ran a checker). Verifier errors count as not-passed. */
export function outcomeStats(outcomes: readonly TrialOutcome[]): RepeatStats | undefined {
  return repeatStats(outcomes.filter((o) => o.verify !== undefined).map((o) => o.verify!.status === "pass"));
}

// ------------------------------------------------------ stats rollup (#57)

export interface RepeatGroupRollup {
  group: string;
  agent: string;
  experiment?: string;
  variant?: string;
  /** Declared group size (--repeat N). */
  count: number;
  /** Records found on disk for the group (≤ count when interrupted). */
  runs: number;
  succeeded: number;
  /** undefined when any member's USD cost is unknowable (usage.usd.available === false). */
  totalCostUsd?: number;
  meanCostUsd?: number;
  /** Present when at least one member carries a run-time verify verdict. */
  verified?: number;
  passed?: number;
  stats?: RepeatStats;
  startedAt: number;
}

/** Group registry records by `repeat.group`; newest group first. */
export function repeatGroupRollup(records: readonly RunRecord[]): RepeatGroupRollup[] {
  const groups = new Map<string, RunRecord[]>();
  for (const rec of records) {
    const g = rec.repeat?.group;
    if (g === undefined) continue;
    const list = groups.get(g) ?? [];
    list.push(rec);
    groups.set(g, list);
  }
  const out: RepeatGroupRollup[] = [];
  for (const [group, recs] of groups) {
    const first = recs[0]!;
    const costKnown = recs.every((r) => r.usage?.usd.available !== false);
    const total = recs.reduce((s, r) => s + (r.totals?.costUsd ?? 0), 0);
    const verified = recs.filter((r) => r.verify !== undefined);
    const stats = repeatStats(verified.map((r) => r.verify!.status === "pass"));
    out.push({
      group,
      agent: first.agent,
      ...(first.experiment !== undefined ? { experiment: first.experiment } : {}),
      ...(first.variant !== undefined ? { variant: first.variant } : {}),
      count: Math.max(...recs.map((r) => r.repeat!.count)),
      runs: recs.length,
      succeeded: recs.filter((r) => r.exitStatus === "success").length,
      ...(costKnown ? { totalCostUsd: total, meanCostUsd: total / recs.length } : {}),
      ...(stats !== undefined ? { verified: stats.k, passed: stats.passes, stats } : {}),
      startedAt: Math.min(...recs.map((r) => r.startedAt)),
    });
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

/** One text line per group for `ach stats`. */
export function formatRepeatGroupLine(g: RepeatGroupRollup, fmtUsd: (n: number) => string): string {
  const parts = [
    `repeat    ${g.group.slice(0, 8)}`,
    `agent=${g.agent}`,
    ...(g.experiment !== undefined ? [`experiment=${g.experiment}`] : []),
    ...(g.variant !== undefined ? [`variant=${g.variant}`] : []),
    `runs=${g.runs}/${g.count}`,
    `succeeded=${g.succeeded}`,
    ...(g.stats !== undefined ? [`pass=${g.passed}/${g.verified}`, formatStatsInline(g.stats)] : []),
    `cost=${g.totalCostUsd === undefined ? "n/a" : fmtUsd(g.totalCostUsd)}`,
    `mean=${g.meanCostUsd === undefined ? "n/a" : fmtUsd(g.meanCostUsd)}`,
  ];
  return parts.join(" ");
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

/** `pass@1=66.7% [20.8%–93.9%] pass^3=0.0% any-pass@3=100.0%` (k ≥ 2) or `pass@1=100.0% (k=1, no CI)`. */
export function formatStatsInline(s: RepeatStats): string {
  if (s.wilsonLo === undefined || s.wilsonHi === undefined) return `pass@1=${pct(s.passAt1)} (k=1, no CI)`;
  return (
    `pass@1=${pct(s.passAt1)} [${pct(s.wilsonLo)}–${pct(s.wilsonHi)}]` +
    ` pass^${s.k}=${pct(s.passHatK ?? 0)} any-pass@${s.k}=${pct(s.anyPassAtK ?? 0)}`
  );
}

/** `pass (exit 0, 1.2s)` — the verify line of a run summary. */
export function formatVerifyLine(v: VerifyResult): string {
  const secs = `${(v.durationMs / 1000).toFixed(1)}s`;
  const detail = v.timedOut
    ? `timed out after ${secs}`
    : v.exitCode !== null
      ? `exit ${v.exitCode}, ${secs}`
      : `${v.error ?? (v.signal ? `signal ${v.signal}` : "did not run")}, ${secs}`;
  return `verify     ${v.status} (${detail})`;
}
