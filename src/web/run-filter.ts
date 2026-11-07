// Run-list filtering for GET /api/runs (#68): a pure parse + apply pair over the
// in-memory hub snapshot, plus a bounded event-text scan for `qin=events`.
// Everything here is side-effect free except `scanEventsFor`, which reads
// transcripts through an injected, byte-capped reader.
import { effectiveStatus, type RunRecord } from "../core/registry.ts";

/** Query params that, when ANY is present, switch /api/runs to the filtered shape. */
export const RUN_FILTER_PARAMS = [
  "agent",
  "status",
  "minCost",
  "maxCost",
  "since",
  "until",
  "q",
  "qin",
  "limit",
  "offset",
] as const;

/** Bounds for `qin=events` (documented in README, "Run list filters"). */
export const EVENT_SCAN_MAX_RUNS = 200; // newest runs (after the other filters) that are scanned
export const EVENT_SCAN_MAX_BYTES = 1024 * 1024; // bytes read from the head of each transcript
export const RUN_LIMIT_MAX = 1000;

const STATUSES = ["running", "interrupted", "success", "error", "aborted", "unavailable"] as const;

export interface RunFilter {
  agents?: string[];
  statuses?: string[];
  minCost?: number;
  maxCost?: number;
  since?: number; // ms epoch, inclusive, compared with startedAt
  until?: number; // ms epoch, inclusive
  q?: string; // lowercased
  qinEvents: boolean;
  limit?: number;
  offset: number;
}

export type ParsedRunFilter = { ok: true; filter: RunFilter; active: boolean } | { ok: false; error: string };

function num(name: string, raw: string): number | string {
  if (raw.trim() === "") return `${name} must be a number`;
  const n = Number(raw);
  return Number.isFinite(n) ? n : `${name} must be a number`;
}

/** Accepts ms epoch digits or an ISO 8601 date (YYYY-MM-DD[THH:MM[:SS[.fff]][Z|+hh:mm]]); anything else is rejected. */
function when(name: string, raw: string): number | string {
  if (/^\d+$/.test(raw)) return Number(raw);
  if (!/^\d{4}-\d{2}(-\d{2})?([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(raw.trim())) {
    return `${name} must be a ms epoch or an ISO 8601 date`;
  }
  const t = Date.parse(raw.trim());
  return Number.isNaN(t) ? `${name} must be a ms epoch or an ISO 8601 date` : t;
}

function list(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

export function parseRunFilter(params: URLSearchParams): ParsedRunFilter {
  const active = RUN_FILTER_PARAMS.some((p) => params.has(p));
  const f: RunFilter = { qinEvents: false, offset: 0 };
  const agent = params.get("agent");
  if (agent !== null) f.agents = list(agent);
  const status = params.get("status");
  if (status !== null) {
    const ss = list(status);
    const bad = ss.find((s) => !(STATUSES as readonly string[]).includes(s));
    if (bad !== undefined) return { ok: false, error: `status must be a comma list of: ${STATUSES.join(", ")}` };
    f.statuses = ss;
  }
  for (const key of ["minCost", "maxCost"] as const) {
    const raw = params.get(key);
    if (raw === null) continue;
    const n = num(key, raw);
    if (typeof n === "string") return { ok: false, error: n };
    f[key] = n;
  }
  for (const key of ["since", "until"] as const) {
    const raw = params.get(key);
    if (raw === null) continue;
    const n = when(key, raw);
    if (typeof n === "string") return { ok: false, error: n };
    f[key] = n;
  }
  const q = params.get("q");
  if (q !== null && q.trim() !== "") f.q = q.trim().toLowerCase();
  const qin = params.get("qin");
  if (qin !== null) {
    if (qin !== "events" && qin !== "prompt") return { ok: false, error: "qin must be one of: prompt, events" };
    f.qinEvents = qin === "events";
  }
  const limit = params.get("limit");
  if (limit !== null) {
    const n = num("limit", limit);
    if (typeof n === "string" || !Number.isInteger(n) || n < 1 || n > RUN_LIMIT_MAX) {
      return { ok: false, error: `limit must be an integer from 1 to ${RUN_LIMIT_MAX}` };
    }
    f.limit = n;
  }
  const offset = params.get("offset");
  if (offset !== null) {
    const n = num("offset", offset);
    if (typeof n === "string" || !Number.isInteger(n) || n < 0) {
      return { ok: false, error: "offset must be a non-negative integer" };
    }
    f.offset = n;
  }
  return { ok: true, filter: f, active };
}

/** Prompt preview + resolved command line, lowercased: what plain `q=` searches. */
function summaryText(r: RunRecord): string {
  return `${r.promptPreview ?? ""}\n${(r.command ?? []).join(" ")}`.toLowerCase();
}

/** Every criterion except text search (which may need an async event scan). */
export function matchesRunFilter(r: RunRecord, f: RunFilter, now: number = Date.now()): boolean {
  if (f.agents !== undefined && f.agents.length > 0 && !f.agents.includes(r.agent)) return false;
  if (f.statuses !== undefined && f.statuses.length > 0 && !f.statuses.includes(effectiveStatus(r, now))) return false;
  if (f.minCost !== undefined || f.maxCost !== undefined) {
    // An unpriced run (no totals) has no cost, so it never satisfies a cost bound.
    const cost = r.totals?.costUsd;
    if (typeof cost !== "number") return false;
    if (f.minCost !== undefined && cost < f.minCost) return false;
    if (f.maxCost !== undefined && cost > f.maxCost) return false;
  }
  if (f.since !== undefined && !(r.startedAt >= f.since)) return false;
  if (f.until !== undefined && !(r.startedAt <= f.until)) return false;
  return true;
}

export function matchesSummaryQuery(r: RunRecord, q: string): boolean {
  return summaryText(r).includes(q);
}

/** Collect string leaves of a parsed event (depth-bounded) and test for `q`. */
function valueHasText(v: unknown, q: string, depth: number): boolean {
  if (typeof v === "string") return v.toLowerCase().includes(q);
  if (depth <= 0 || v === null || typeof v !== "object") return false;
  for (const child of Object.values(v as Record<string, unknown>)) {
    if (valueHasText(child, q, depth - 1)) return true;
  }
  return false;
}

/** True when any jsonl line (a stored AgentEvent) carries `q` in a string field. */
export function eventTextMatches(jsonlText: string, q: string): boolean {
  for (const line of jsonlText.split("\n")) {
    if (line === "") continue;
    try {
      if (valueHasText(JSON.parse(line), q, 6)) return true;
    } catch {
      // partial / chain-framing line: skip
    }
  }
  return false;
}

export interface RunPage {
  records: RunRecord[];
  total: number; // matches before limit/offset
  offset: number;
  limit: number | null;
  scan?: { scanned: number; capped: boolean; maxRuns: number; maxBytesPerRun: number };
}

/**
 * Apply `f` to `runs`. `readEvents(r)` returns up to EVENT_SCAN_MAX_BYTES of the
 * run's transcript head (or null when none); it is only called for `qin=events`
 * and only for runs that pass every other criterion and miss on the summary.
 */
export async function applyRunFilter(
  runs: RunRecord[],
  f: RunFilter,
  opts: { now?: number; readEvents?: (r: RunRecord) => Promise<string | null> } = {},
): Promise<RunPage> {
  const now = opts.now ?? Date.now();
  const base = runs.filter((r) => matchesRunFilter(r, f, now));
  let matched: RunRecord[];
  let scan: RunPage["scan"];
  if (f.q === undefined) {
    matched = base;
  } else if (!f.qinEvents || opts.readEvents === undefined) {
    matched = base.filter((r) => matchesSummaryQuery(r, f.q!));
  } else {
    // Only the newest EVENT_SCAN_MAX_RUNS summary-misses are scanned; the rest are skipped.
    const budget = new Set(
      base
        .filter((r) => !matchesSummaryQuery(r, f.q!))
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, EVENT_SCAN_MAX_RUNS)
        .map((r) => r.runId),
    );
    const misses = base.filter((r) => !matchesSummaryQuery(r, f.q!)).length;
    const hits = new Set<string>();
    for (const r of base) {
      if (matchesSummaryQuery(r, f.q)) {
        hits.add(r.runId);
      } else if (budget.has(r.runId)) {
        const text = await opts.readEvents(r);
        if (text !== null && eventTextMatches(text, f.q)) hits.add(r.runId);
      }
    }
    matched = base.filter((r) => hits.has(r.runId));
    scan = {
      scanned: budget.size,
      capped: misses > budget.size,
      maxRuns: EVENT_SCAN_MAX_RUNS,
      maxBytesPerRun: EVENT_SCAN_MAX_BYTES,
    };
  }
  const page = f.limit === undefined ? matched.slice(f.offset) : matched.slice(f.offset, f.offset + f.limit);
  const out: RunPage = { records: page, total: matched.length, offset: f.offset, limit: f.limit ?? null };
  if (scan !== undefined) out.scan = scan;
  return out;
}
