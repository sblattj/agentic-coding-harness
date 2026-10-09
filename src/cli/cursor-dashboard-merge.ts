// Pure merge rules for `ach stats`: how imported Cursor dashboard rows (the
// billed truth) replace the other Cursor rows that describe the same requests.
//  1. JSON row (sessionId = cursor-agent session_id): drops every `ach run`
//     cursor state record of that session.
//  2. CSV row (no sessionId): drops ONE unconsumed cursor state record whose
//     input/cacheRead/output match exactly and whose ts is within +-10 min;
//     the row inherits that record's session.
//  3. Cursor IDE-store rows inside the dashboard span [min ts, max ts] are
//     dropped (see inDashboardSpan); outside the span they are kept.
import type { CanonicalTokenRecord } from "../monitors/transcripts.ts";

export const DASHBOARD_MATCH_WINDOW_MS = 10 * 60_000;

export interface StateLike {
  agent: string;
  sessionId?: string | null;
  ts?: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface DashboardMatch<S> {
  rec: CanonicalTokenRecord;
  /** The dashboard sessionId, else the session inherited from a replaced state record. */
  sessionId: string | null;
  /** State records this row replaced (first one supplies inherited cwd/branch). */
  replaced: S[];
}

export interface DashboardReconciliation<S> {
  /** Parallel to the dashboard input. */
  matches: DashboardMatch<S>[];
  /** Every state record to remove from the stats rows. */
  dropped: Set<S>;
}

const ms = (t: string | null | undefined): number => (t ? Date.parse(t) : NaN);

export function reconcileDashboardWithState<S extends StateLike>(
  dash: CanonicalTokenRecord[],
  state: S[],
): DashboardReconciliation<S> {
  const cursor = state.filter((s) => s.agent === "cursor");
  const dropped = new Set<S>();
  const bySession = new Map<string, S[]>();
  for (const s of cursor) {
    if (!s.sessionId) continue;
    const l = bySession.get(s.sessionId);
    if (l) l.push(s); else bySession.set(s.sessionId, [s]);
  }
  const matches: DashboardMatch<S>[] = [];
  // JSON rows first so a state record of a known session is never claimed by a CSV row.
  for (const rec of dash) {
    if (!rec.sessionId) continue;
    for (const s of bySession.get(rec.sessionId) ?? []) dropped.add(s);
  }
  for (const rec of dash) {
    if (rec.sessionId) {
      matches.push({ rec, sessionId: rec.sessionId, replaced: bySession.get(rec.sessionId) ?? [] });
      continue;
    }
    const t = ms(rec.timestamp);
    let best: S | undefined;
    let bestGap = Infinity;
    if (Number.isFinite(t)) {
      for (const s of cursor) {
        if (dropped.has(s)) continue;
        if (s.inputTokens !== rec.input || s.cacheReadTokens !== rec.cacheRead || s.outputTokens !== rec.output) continue;
        const gap = Math.abs(ms(s.ts) - t);
        if (gap <= DASHBOARD_MATCH_WINDOW_MS && gap < bestGap) { best = s; bestGap = gap; }
      }
    }
    if (best) dropped.add(best);
    matches.push({ rec, sessionId: best?.sessionId ?? null, replaced: best ? [best] : [] });
  }
  return { matches, dropped };
}

export interface DashboardSpan { minMs: number; maxMs: number }

/** [min, max] timestamp of the whole stored dashboard (before windowing), or null when empty. */
export function dashboardSpan(dash: CanonicalTokenRecord[]): DashboardSpan | null {
  let minMs = Infinity;
  let maxMs = -Infinity;
  for (const r of dash) {
    const t = ms(r.timestamp);
    if (!Number.isFinite(t)) continue;
    if (t < minMs) minMs = t;
    if (t > maxMs) maxMs = t;
  }
  return Number.isFinite(minMs) ? { minMs, maxMs } : null;
}

export function inDashboardSpan(span: DashboardSpan | null, tMs: number): boolean {
  return span !== null && Number.isFinite(tMs) && tMs >= span.minMs && tMs <= span.maxMs;
}
