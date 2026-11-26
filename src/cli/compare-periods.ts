// Period-over-period comparison for `ach stats --compare prev|prev:<dur>` (#42).
// Window math reuses time-window.ts ([since, until) semantics, tz aware); this
// module only derives the previous window, the delta arithmetic, the
// "unexplained" (aged-out transcript) signal and the text block.

import fs from "node:fs";

import { fmtInt, fmtUsd } from "./lib.ts";
import {
  civilDaysBetween,
  dayKey,
  isLocalMidnight,
  parseDuration,
  shiftCivilDays,
  type TimeWindow,
} from "./time-window.ts";
import { HarnessError } from "../core/types.ts";

const usage = (msg: string) => new HarnessError(msg, "USAGE");
const DAY_MS = 86_400_000;

export type CompareSpec = { kind: "prev" } | { kind: "offset"; ms: number; raw: string };

/** `prev` | `prev:<dur>` (dur as parseDuration: 7d, 2w, 12h). Anything else is a USAGE error. */
export function parseCompareSpec(value: string): CompareSpec {
  const v = value.trim();
  if (v === "prev") return { kind: "prev" };
  const m = /^prev:(.+)$/.exec(v);
  if (m) {
    const ms = parseDuration(m[1]!);
    if (ms === undefined || !(ms > 0)) {
      throw usage(`--compare: cannot parse offset '${m[1]}' in '${value}' (expected prev:<N>m|h|d|w with N > 0, e.g. prev:7d)`);
    }
    return { kind: "offset", ms, raw: m[1]!.trim() };
  }
  throw usage(`--compare: unknown value '${value}' (expected 'prev' or 'prev:<dur>', e.g. prev:7d)`);
}

export interface ClosedWindow {
  sinceMs: number;
  untilMs: number;
}

/**
 * The selected window and the window it is compared against. An open end
 * (--days / --since / --last without --until) means "up to now". Calendar
 * shifts keep local time of day, so Sep 1-7 compares against Aug 25-31 in the
 * selected zone, never a 30-day or DST-skewed shift.
 */
export function resolveComparePeriods(
  spec: CompareSpec,
  window: TimeWindow,
  now: number,
  timeZone: string,
): { current: ClosedWindow; previous: ClosedWindow } {
  if (window.sinceMs === undefined) {
    throw usage("--compare needs a bounded window: add --days N, --since DATE or --last D (the selected window has no start)");
  }
  const sinceMs = window.sinceMs;
  const untilMs = window.untilMs ?? now;
  if (untilMs <= sinceMs) throw usage("--compare: the selected window is empty (its end is not after its start)");
  const current = { sinceMs, untilMs };
  if (spec.kind === "prev") {
    // Whole local days (e.g. --since 2026-09-01 --until 2026-09-08): step back by
    // civil days. Otherwise (rolling --days/--last) step back by the elapsed length.
    if (isLocalMidnight(sinceMs, timeZone) && isLocalMidnight(untilMs, timeZone)) {
      const n = civilDaysBetween(sinceMs, untilMs, timeZone);
      return { current, previous: { sinceMs: shiftCivilDays(sinceMs, -n, timeZone), untilMs: sinceMs } };
    }
    return { current, previous: { sinceMs: sinceMs - (untilMs - sinceMs), untilMs: sinceMs } };
  }
  if (spec.ms % DAY_MS === 0) {
    const n = spec.ms / DAY_MS;
    return {
      current,
      previous: { sinceMs: shiftCivilDays(sinceMs, -n, timeZone), untilMs: shiftCivilDays(untilMs, -n, timeZone) },
    };
  }
  return { current, previous: { sinceMs: sinceMs - spec.ms, untilMs: untilMs - spec.ms } };
}

export interface PeriodTotals {
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number | null;
  runs: number;
  records: number;
}

export interface PeriodBucketLike {
  records: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number | null;
}

/** `tokens` = input + output + cacheRead + cacheWrite (reasoning is reported apart, it is part of output on most providers). */
export function periodTotals(b: PeriodBucketLike, runs: number): PeriodTotals {
  return {
    tokens: b.inputTokens + b.outputTokens + b.cacheReadTokens + b.cacheWriteTokens,
    inputTokens: b.inputTokens,
    outputTokens: b.outputTokens,
    cacheReadTokens: b.cacheReadTokens,
    cacheWriteTokens: b.cacheWriteTokens,
    reasoningTokens: b.reasoningTokens,
    costUsd: b.costUsd,
    runs,
    records: b.records,
  };
}

export interface CompareDelta {
  tokens: number;
  costUsd: number | null;
  runs: number;
  /** Percent change vs the previous window; null when the base is zero or unknown (never -100% or Infinity). */
  tokensPct: number | null;
  costUsdPct: number | null;
  runsPct: number | null;
}

function pct(cur: number | null, prev: number | null): number | null {
  if (cur === null || prev === null || prev === 0) return null;
  return Math.round(((cur - prev) / prev) * 10_000) / 100;
}

export function compareDelta(current: PeriodTotals, previous: PeriodTotals): CompareDelta {
  const cost = current.costUsd === null || previous.costUsd === null ? null : current.costUsd - previous.costUsd;
  return {
    tokens: current.tokens - previous.tokens,
    costUsd: cost === null ? null : Math.round(cost * 1e10) / 1e10,
    runs: current.runs - previous.runs,
    tokensPct: pct(current.tokens, previous.tokens),
    costUsdPct: pct(current.costUsd, previous.costUsd),
    runsPct: pct(current.runs, previous.runs),
  };
}

export interface UnexplainedDay {
  day: string;
  runs: number;
  tokens: number;
  costUsd: number;
}

export interface UnexplainedRun {
  startedAt: number;
  rawTranscript?: string;
  totals?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number };
}

/**
 * Days whose usage was recorded in run records but whose raw transcript file is
 * gone (`ach gc` or manual pruning) and which contributed no token records to
 * the stats read. The run record keeps its own totals, so the missing amount is
 * named here instead of the window silently shrinking. A run counts only when
 * it has a rawTranscript path, that path no longer exists, and no state record
 * carried its runId (an `ach archive` copy read with --with-warehouse
 * therefore does not count as missing).
 */
export function unexplainedDays(
  runs: readonly (UnexplainedRun & { runId: string })[],
  window: ClosedWindow,
  timeZone: string,
  hasData: ReadonlySet<string>,
  exists: (p: string) => boolean = fs.existsSync,
): { days: UnexplainedDay[]; runs: number; tokens: number; costUsd: number } {
  const byDay = new Map<string, UnexplainedDay>();
  for (const r of runs) {
    if (r.startedAt < window.sinceMs || r.startedAt >= window.untilMs) continue;
    if (!r.rawTranscript || exists(r.rawTranscript) || hasData.has(r.runId)) continue;
    const t = r.totals;
    const tokens = t ? t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens : 0;
    const day = dayKey(r.startedAt, timeZone);
    const d = byDay.get(day) ?? { day, runs: 0, tokens: 0, costUsd: 0 };
    d.runs += 1;
    d.tokens += tokens;
    d.costUsd += t?.costUsd ?? 0;
    byDay.set(day, d);
  }
  const days = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  return {
    days,
    runs: days.reduce((s, d) => s + d.runs, 0),
    tokens: days.reduce((s, d) => s + d.tokens, 0),
    costUsd: days.reduce((s, d) => s + d.costUsd, 0),
  };
}

export type Unexplained = ReturnType<typeof unexplainedDays>;

export interface ComparePeriodJson {
  since: string;
  until: string;
  totals: PeriodTotals;
  unexplained: Unexplained;
}

export function compareJson(
  cur: { window: ClosedWindow; totals: PeriodTotals; unexplained: Unexplained },
  prev: { window: ClosedWindow; totals: PeriodTotals; unexplained: Unexplained },
  spec: CompareSpec,
): {
  mode: string;
  current: ComparePeriodJson;
  previous: ComparePeriodJson;
  delta: CompareDelta;
} {
  const one = (p: typeof cur): ComparePeriodJson => ({
    since: new Date(p.window.sinceMs).toISOString(),
    until: new Date(p.window.untilMs).toISOString(),
    totals: p.totals,
    unexplained: p.unexplained,
  });
  return {
    mode: spec.kind === "prev" ? "prev" : `prev:${spec.raw}`,
    current: one(cur),
    previous: one(prev),
    delta: compareDelta(cur.totals, prev.totals),
  };
}

const signed = (n: number, f: (x: number) => string): string => (n > 0 ? "+" : n < 0 ? "-" : "") + f(Math.abs(n));
const signedPct = (p: number | null): string => (p === null ? "n/a" : `${p > 0 ? "+" : ""}${p.toFixed(1)}%`);

function rangeLabel(w: ClosedWindow, tz: string): string {
  if (isLocalMidnight(w.sinceMs, tz) && isLocalMidnight(w.untilMs, tz)) {
    return `${dayKey(w.sinceMs, tz)}..${dayKey(w.untilMs - 1, tz)}`;
  }
  return `${new Date(w.sinceMs).toISOString().slice(0, 16)}Z..${new Date(w.untilMs).toISOString().slice(0, 16)}Z`;
}

/** The compact compare block (stays inside 100 columns for realistic values). */
export function renderCompareText(
  c: ReturnType<typeof compareJson>,
  cur: ClosedWindow,
  prev: ClosedWindow,
  timeZone: string,
): string[] {
  const out: string[] = [];
  out.push(`compare   ${c.mode}  current ${rangeLabel(cur, timeZone)} vs previous ${rangeLabel(prev, timeZone)} (${timeZone}, [since, until))`);
  const row = (label: string, a: string, b: string, d: string, p: string) =>
    `  ${label.padEnd(8)} ${a.padStart(16)} ${b.padStart(16)} ${d.padStart(16)} ${p.padStart(9)}`;
  out.push(row("", "current", "previous", "delta", "delta%"));
  const t = c.current.totals;
  const p = c.previous.totals;
  const d = c.delta;
  out.push(row("tokens", fmtInt(t.tokens), fmtInt(p.tokens), signed(d.tokens, fmtInt), signedPct(d.tokensPct)));
  out.push(
    row(
      "cost",
      t.costUsd === null ? "n/a" : fmtUsd(t.costUsd),
      p.costUsd === null ? "n/a" : fmtUsd(p.costUsd),
      d.costUsd === null ? "n/a" : signed(d.costUsd, fmtUsd),
      signedPct(d.costUsdPct),
    ),
  );
  out.push(row("runs", fmtInt(t.runs), fmtInt(p.runs), signed(d.runs, fmtInt), signedPct(d.runsPct)));
  for (const [label, u] of [["previous", c.previous.unexplained], ["current", c.current.unexplained]] as const) {
    for (const day of u.days) {
      out.push(
        `  unexplained (${label}) ${day.day}: ${fmtInt(day.runs)} run(s), ${fmtInt(day.tokens)} tokens, ${fmtUsd(day.costUsd)} in run records, transcript gone (not in the totals above)`,
      );
    }
  }
  return out;
}
