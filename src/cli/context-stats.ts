// Per-run context-window pressure for `ach stats --json` (issue #21).
//
// One row per registry RunRecord so scripts can catch context pressure
// without a dashboard. A value the run could not know is `null` — never 0 —
// and toolOutputShare is omitted (not zero) when the run had no tool events.
import type { RunLatency, RunRecord } from "../core/registry.ts";

export interface RunContextRow {
  runId: string;
  agent: string;
  startedAt: number;
  status: string | null;
  model: string | null;
  /**
   * Occupancy: tokens ÷ windowTokens × 100; null when unknowable (unknown
   * model, no usage, pre-#21 record, or only aggregate turn-total usage — #141).
   */
  contextPercentage: number | null;
  /** Occupied tokens (latest call); null when occupancy is unknowable, incl. turn-total. */
  contextTokens: number | null;
  /** #141: cumulative input + cache tokens of the latest aggregate (turn-total) usage; NOT occupancy. Null when none. */
  cumulativeTokens: number | null;
  windowTokens: number | null;
  windowSource: "session-store" | "derived" | "assumed" | "reported" | null;
  /** 'last-call' = occupancy reading; 'turn-total' = cumulative usage only (occupancy null). */
  basis: "last-call" | "turn-total" | null;
  /** True when derived from usage + the bundled window table. */
  estimated: boolean;
  toolOutputShare?: number;
  /** Latency metrics (#32) the driver recorded at finalize; absent when none were measurable. */
  latency?: RunLatency;
}

export function runContextRows(
  records: RunRecord[],
  opts: { agent?: string; sinceTs?: number } = {},
): RunContextRow[] {
  const rows: RunContextRow[] = [];
  for (const rec of records) {
    if (opts.agent !== undefined && rec.agent !== opts.agent) continue;
    if (opts.sinceTs !== undefined && rec.startedAt < opts.sinceTs) continue;
    const ctx = rec.usage?.context;
    // #141: a turn-total reading is cumulative usage, never occupancy.
    const aggregate = ctx?.basis === "turn-total";
    const known = ctx?.available === true && !aggregate;
    rows.push({
      runId: rec.runId,
      agent: rec.agent,
      startedAt: rec.startedAt,
      status: rec.status ?? null,
      model: ctx?.model ?? null,
      contextPercentage: known ? (ctx.percentage ?? null) : null,
      contextTokens: known ? (ctx.tokens ?? null) : null,
      cumulativeTokens: ctx?.cumulativeTokens ?? (aggregate ? (ctx.tokens ?? null) : null),
      windowTokens: ctx?.available === true ? (ctx.windowTokens ?? null) : null,
      windowSource: ctx?.available === true ? (ctx.windowSource ?? null) : null,
      basis: ctx?.basis ?? null,
      estimated: ctx?.estimated === true,
      ...(known && ctx.toolOutputShare !== undefined ? { toolOutputShare: ctx.toolOutputShare } : {}),
      ...(rec.latency !== undefined ? { latency: rec.latency } : {}),
    });
  }
  return rows.sort((a, b) => a.startedAt - b.startedAt);
}
