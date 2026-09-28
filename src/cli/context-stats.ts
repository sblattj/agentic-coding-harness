// Per-run context-window pressure for `ach stats --json` (issue #21).
//
// One row per registry RunRecord so scripts can catch context pressure
// without a dashboard. A value the run could not know is `null` — never 0 —
// and toolOutputShare is omitted (not zero) when the run had no tool events.
import type { RunRecord } from "../core/registry.ts";

export interface RunContextRow {
  runId: string;
  agent: string;
  startedAt: number;
  status: string | null;
  model: string | null;
  /** tokens ÷ windowTokens × 100; null when unknowable (unknown model, no usage, pre-#21 record). */
  contextPercentage: number | null;
  contextTokens: number | null;
  windowTokens: number | null;
  windowSource: "session-store" | "assumed" | null;
  /** 'last-call' = occupancy reading; 'turn-total' = upper bound. */
  basis: "last-call" | "turn-total" | null;
  /** True when derived from usage + the bundled window table. */
  estimated: boolean;
  toolOutputShare?: number;
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
    const known = ctx?.available === true;
    rows.push({
      runId: rec.runId,
      agent: rec.agent,
      startedAt: rec.startedAt,
      status: rec.status ?? null,
      model: ctx?.model ?? null,
      contextPercentage: known ? (ctx.percentage ?? null) : null,
      contextTokens: known ? (ctx.tokens ?? null) : null,
      windowTokens: known ? (ctx.windowTokens ?? null) : null,
      windowSource: known ? (ctx.windowSource ?? null) : null,
      basis: ctx?.basis ?? null,
      estimated: ctx?.estimated === true,
      ...(known && ctx.toolOutputShare !== undefined ? { toolOutputShare: ctx.toolOutputShare } : {}),
    });
  }
  return rows.sort((a, b) => a.startedAt - b.startedAt);
}
