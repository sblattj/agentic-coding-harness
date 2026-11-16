// Bounded run list for the dashboard (#198). With a few hundred local
// sessions the full snapshot is tens of MB (about 26k records here), which
// the /grid tab cannot hold. When `ach web` configures a window, every list
// view (bare GET /api/runs, the runs=1 socket snapshot and each runs push)
// carries only the newest page of slim records; older runs stay reachable
// through `GET /api/runs?order=newest&offset=<nextOffset>&limit=<pageSize>`
// and a single record through `GET /api/runs/<runId>`. Pure functions.
import { effectiveStatus, type RunRecord } from "../core/registry.ts";
import type { VerifyResult } from "../core/verify.ts";

export interface RunListWindow {
  /** Only runs started within this many ms of now make page one; undefined = no age bound. */
  recentMs?: number;
  /** Newest runs per page (page one and every "load older" page). */
  pageSize: number;
}

export const DEFAULT_RECENT_MS = 7 * 86_400_000;
export const DEFAULT_PAGE_SIZE = 200;

export interface WindowedRuns {
  /** Page one: newest-first, plus any live run outside it. */
  records: RunRecord[];
  /** Every run the server holds. */
  total: number;
  /** Offset into the newest-first order where "load older" continues. */
  nextOffset: number;
  window: { recentMs: number | null; pageSize: number };
}

/** Newest first; runId breaks ties so paging is stable across requests. */
export function newestFirst(runs: RunRecord[]): RunRecord[] {
  return [...runs].sort((a, b) => (b.startedAt - a.startedAt) || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
}

/** A run whose tile is still streaming: never pushed off page one. */
export function isListLive(r: RunRecord, now: number): boolean {
  if (r.source === "external") return r.endedAt == null && r.metadata?.source !== "transcript";
  return effectiveStatus(r, now) === "running";
}

function slimVerify(v: VerifyResult): VerifyResult {
  if (v.outputTail === undefined) return v;
  const { outputTail: _drop, ...rest } = v;
  return rest;
}

/**
 * List-payload shape of a record: drops the fields no list view renders and
 * that dominate record size (the verify command's output tail, the
 * transcript seal, the audit-correction trail). The full record is one
 * `GET /api/runs/<runId>` away.
 */
export function slimRunRecord(r: RunRecord): RunRecord {
  if (r.verify === undefined && r.regrades === undefined && r.seal === undefined && r.corrections === undefined) return r;
  const { seal: _seal, corrections: _corrections, ...rest } = r;
  const out: RunRecord = rest;
  if (r.verify !== undefined) out.verify = slimVerify(r.verify);
  if (r.regrades !== undefined) out.regrades = r.regrades.map(slimVerify);
  return out;
}

export function windowRuns(runs: RunRecord[], win: RunListWindow, now: number = Date.now()): WindowedRuns {
  const ordered = newestFirst(runs);
  const since = win.recentMs === undefined ? -Infinity : now - win.recentMs;
  // Newest-first means the in-window runs are a prefix of `ordered`.
  let n = 0;
  while (n < ordered.length && n < win.pageSize && ordered[n]!.startedAt >= since) n++;
  const records = ordered.slice(0, n);
  for (let i = n; i < ordered.length; i++) if (isListLive(ordered[i]!, now)) records.push(ordered[i]!);
  return {
    records: records.map(slimRunRecord),
    total: ordered.length,
    nextOffset: n,
    window: { recentMs: win.recentMs ?? null, pageSize: win.pageSize },
  };
}
