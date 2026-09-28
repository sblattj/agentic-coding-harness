// dash — live run dashboard over the driver registry (src/core/registry.ts).
// Default view: ANSI full-screen table redrawn ~2/s over <stateDir>/runs.
// --json dumps RunRecords (+ live flag and effectiveStatus) for tools and
// tests; no TTY falls back to that same dump with a hint on stderr.
import { parseArgs } from "node:util";
import { HarnessError } from "../core/types.ts";
import { stateDir } from "../core/store.ts";
import { describeAlert } from "../core/budget-alerts.ts";
import { PACE_WINDOWS, paceFromSamples, type Pace, type PaceSample } from "../core/usage-windows.ts";
import {
  effectiveStatus,
  isLive,
  listRunRecords,
  type RunRecord,
} from "../core/registry.ts";
import { collectQuota, dashQuotaCell, type QuotaRow } from "../core/quota.ts";

const REDRAW_MS = 500;
/** Quota sources are files on disk (rollouts, statusline snapshot); re-read at most this often. */
const QUOTA_REFRESH_MS = 30_000;
const QUOTA_W = 9;
const HOUR_MS = 3_600_000;

// ---------------------------------------------------------------- formatting

function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function fmtCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

function fmtCredits(c: number | undefined): string {
  return c === undefined ? "" : `${c.toFixed(2)}cr`;
}

// Truthful usage (RunResult.usage / RunRecord.usage): a run whose agent
// reports no token counts prints `n/a`, never `0`, and no `$0.0000` cost.
// A record WITHOUT `usage` (written before this landed) renders exactly as
// before — the checks are `=== false`, not falsy.
function tokensUnavailable(rec: RunRecord): boolean {
  return rec.usage?.tokens.available === false;
}

function usdUnavailable(rec: RunRecord): boolean {
  return rec.usage?.usd.available === false;
}

/** `ctx 10.0k (5.0%)` — DERIVED occupancy, visually distinct from billed tokens. */
function fmtContext(rec: RunRecord): string {
  const ctx = rec.usage?.context;
  if (ctx === undefined) return ""; // pre-#21 record: unchanged
  // #21: a run whose occupancy is unknowable (e.g. unknown model window) is n/a, never guessed.
  if (ctx.available !== true || ctx.tokens === undefined) return "n/a";
  const pct = ctx.percentage === undefined ? "" : ` (${ctx.percentage.toFixed(1)}%)`;
  // An upper-bound (turn-total) estimate is marked "≤".
  return `${ctx.basis === "turn-total" ? "≤" : ""}${compact(ctx.tokens)}${pct}`;
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

function padR(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
}

function padL(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : " ".repeat(w - s.length) + s;
}

// STATUS glyphs: plain ASCII base, colored when the terminal allows it
// (● green running / ✓ success / ✗ red error / ! yellow aborted, and the
// same ! yellow for interrupted — derived via effectiveStatus, never stored).
type Status = NonNullable<RunRecord["status"]>;
const GLYPHS: Record<Status, string> = {
  running: "*",
  success: "+",
  error: "x",
  aborted: "!",
  interrupted: "!",
  unavailable: "?", // CLI/service outage, no task verdict (#60)
};

// Second STATUS character: the post-run checker verdict (`ach run --verify`,
// #29) — ✓ green pass / ✗ red fail / ? yellow error when the terminal allows
// color, ASCII p / f / e otherwise; blank when the run was never verified.
const VERIFY_PLAIN = { pass: "p", fail: "f", error: "e" } as const;
const VERIFY_ANSI = { pass: "\x1b[32m✓\x1b[0m", fail: "\x1b[31m✗\x1b[0m", error: "\x1b[33m?\x1b[0m" } as const;

function statusCell(rec: RunRecord, ansi: boolean, w: number): string {
  const status = effectiveStatus(rec);
  const v = rec.verify?.status;
  const plain = padR(GLYPHS[status] + (v !== undefined ? VERIFY_PLAIN[v] : ""), w);
  if (!ansi) return plain;
  const mark = v !== undefined ? VERIFY_ANSI[v] : "";
  const rest = plain.slice(v !== undefined ? 2 : 1);
  if (status === "success") return GLYPHS[status] + mark + rest;
  const glyph = status === "running" ? "●" : status === "error" ? "✗" : "!";
  return `\x1b[${status === "running" ? 32 : status === "error" ? 31 : 33}m${glyph}\x1b[0m` + mark + rest;
}

// ---------------------------------------------------------------- table

const COL = {
  status: 3,
  agent: 8,
  runId: 8,
  session: 8,
  elapsed: 7,
  in: 8,
  out: 8,
  cache: 8,
  cost: 8,
  credits: 8,
  ctx: 14,
} as const;

const HEADER =
  `${padR("STATUS", COL.status)} ${padR("AGENT", COL.agent)} ${padR("RUNID", COL.runId)} ` +
  `${padR("SESSION", COL.session)} ${padR("ELAPSED", COL.elapsed)} ${padL("IN", COL.in)} ` +
  `${padL("OUT", COL.out)} ${padL("CACHE", COL.cache)} ${padL("COST", COL.cost)} ` +
  `${padL("CREDITS", COL.credits)} ${padL("CTX", COL.ctx)} LAST EVENT`;

// Default view: live runs plus finished runs from the last hour; --all
// widens to every record on disk (dash prunes display, never files).
function isVisible(rec: RunRecord, now: number, showAll: boolean): boolean {
  if (showAll) return true;
  if (isLive(rec, now)) return true;
  return rec.status !== "running" && now - (rec.updatedAt ?? rec.startedAt) < HOUR_MS;
}

function tableRow(rec: RunRecord, now: number, ansi: boolean, lastW: number, quota?: QuotaRow[]): string {
  const live = isLive(rec, now);
  const end = live ? now : (rec.updatedAt ?? rec.startedAt);
  // Local records always carry totals; an exotic record without one still
  // renders a row (zeros) rather than crashing the table.
  const t = rec.totals ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
  const cache = t.cacheReadTokens + t.cacheWriteTokens;
  const cells = [
    statusCell(rec, ansi, COL.status),
    padR(rec.agent, COL.agent),
    padR(rec.runId.slice(0, COL.runId), COL.runId),
    padR((rec.sessionId ?? "-").slice(0, COL.session), COL.session),
    padL(fmtElapsed(end - rec.startedAt), COL.elapsed),
    padL(tokensUnavailable(rec) ? "n/a" : compact(t.inputTokens), COL.in),
    padL(tokensUnavailable(rec) ? "n/a" : compact(t.outputTokens), COL.out),
    padL(tokensUnavailable(rec) ? "n/a" : compact(cache), COL.cache),
    padL(usdUnavailable(rec) ? "n/a" : fmtCost(t.costUsd), COL.cost),
    padL(fmtCredits(t.credits), COL.credits),
    padL(fmtContext(rec), COL.ctx),
  ];
  // QUOTA: vendor-reported headroom for this row's agent (src/core/quota.ts),
  // only when the caller supplied quota rows — legacy frames stay unchanged.
  if (quota !== undefined) cells.push(padL(dashQuotaCell(quota, rec.agent), QUOTA_W));
  cells.push(padR(rec.lastEvent ?? "", lastW));
  return cells.join(" ");
}

function footer(visible: RunRecord[]): string {
  let input = 0;
  let output = 0;
  let cost = 0;
  let credits = 0;
  let hasCredits = false;
  for (const r of visible) {
    // Unavailable rows contribute nothing: a fleet total must not silently
    // absorb a credits-only run as "0 tokens, $0".
    const t = r.totals;
    if (t !== undefined && !tokensUnavailable(r)) {
      input += t.inputTokens;
      output += t.outputTokens;
    }
    if (t !== undefined && !usdUnavailable(r)) cost += t.costUsd;
    if (t?.credits !== undefined) {
      credits += t.credits;
      hasCredits = true;
    }
  }
  const parts = [
    `${visible.length} run${visible.length === 1 ? "" : "s"}`,
    `in ${compact(input)}`,
    `out ${compact(output)}`,
    `cost ${fmtCost(cost)}`,
  ];
  if (hasCredits) parts.push(`credits ${fmtCredits(credits)}`);
  parts.push("q quit");
  return parts.join("  ");
}

// ---------------------------------------------------------------- pace (#19)

/**
 * Per-run cumulative samples across redraws, so the trailing-window rate is
 * refresh-to-refresh rather than a lifetime average. Every run is seeded with
 * the true observation {startedAt, $0, 0 tok}; with no redraw history the
 * rate degrades to the average since start (paceFromSamples interpolates).
 */
export class PaceTracker {
  private readonly samples = new Map<string, PaceSample[]>();

  observe(rec: RunRecord, t: number): void {
    const list = this.samples.get(rec.runId) ?? [];
    list.push(sampleOf(rec, t));
    // Keep one sample at/before the longest window's start for interpolation.
    while (list.length > 2 && list[1]!.t <= t - PACE_WINDOWS["1h"]) list.shift();
    this.samples.set(rec.runId, list);
  }

  /** Drop runs no longer live so an ended run's pace never lingers. */
  retain(liveIds: Set<string>): void {
    for (const id of this.samples.keys()) if (!liveIds.has(id)) this.samples.delete(id);
  }

  pace(rec: RunRecord, now: number, budgetUsd: number | undefined): Pace {
    const seed: PaceSample = {
      t: rec.startedAt,
      costUsd: usdUnavailable(rec) ? null : 0,
      tokens: tokensUnavailable(rec) ? null : 0,
    };
    const hist = this.samples.get(rec.runId) ?? [sampleOf(rec, now)];
    return paceFromSamples([seed, ...hist], { now, ...(budgetUsd !== undefined ? { budgetUsd } : {}) });
  }
}

function sampleOf(rec: RunRecord, t: number): PaceSample {
  const tot = rec.totals;
  return {
    t,
    costUsd: tot === undefined || usdUnavailable(rec) ? null : tot.costUsd,
    tokens:
      tot === undefined || tokensUnavailable(rec)
        ? null
        : tot.inputTokens + tot.outputTokens + tot.cacheReadTokens + tot.cacheWriteTokens,
  };
}

function hhmmLocal(isoTs: string): string {
  const d = new Date(isoTs);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function paceRow(rec: RunRecord, p: Pace): string {
  const cell = (w: Pace["windows"]["1h"]): string =>
    `${w.usdPerHour === null ? "n/a" : `$${w.usdPerHour.toFixed(4)}/h`} ${w.tokensPerMinute === null ? "n/a" : `${w.tokensPerMinute.toFixed(1)} tok/min`}`;
  const parts = [`pace  ${rec.runId.slice(0, COL.runId)}`, `15m ${cell(p.windows["15m"])}`, `1h ${cell(p.windows["1h"])}`];
  if (p.budget === "exhausted") parts.push(`budget exhausted ($${p.spentUsd?.toFixed(4)} of $${p.budgetUsd})`);
  else if (p.budget === "ok") {
    const eta = p.windows["1h"].etaBudgetHit ?? p.windows["15m"].etaBudgetHit;
    parts.push(`budget $${p.budgetUsd} hit at ${eta === null ? "n/a" : hhmmLocal(eta)}`);
  }
  return parts.join("  ");
}

export interface FrameOptions {
  /** ETA target for the pace row (dash --budget-usd / env). */
  budgetUsd?: number;
  /** Redraw-to-redraw sample history; omitted → average since run start. */
  tracker?: PaceTracker;
  /** Rows from collectQuota (#17): adds the QUOTA column; omitted = legacy frame. */
  quota?: QuotaRow[];
}

/** One rendered dashboard frame. Exported for tests (pure: no TTY, no I/O). */
export function frame(
  recs: RunRecord[],
  dir: string,
  showAll: boolean,
  width: number,
  ansi: boolean,
  opts: FrameOptions = {},
): string {
  const quota = opts.quota;
  const now = Date.now();
  const visible = recs.filter((r) => isVisible(r, now, showAll));
  const extra = quota === undefined ? 0 : QUOTA_W + 1;
  const fixed = Object.values(COL).reduce((a, w) => a + w, 0) + Object.keys(COL).length + extra;
  const lastW = Math.max(10, width - fixed);
  const header = quota === undefined ? HEADER : HEADER.replace(" LAST EVENT", ` ${padL("QUOTA", QUOTA_W)} LAST EVENT`);
  const lines: string[] = [`harness dash — ${dir}${showAll ? "  (--all)" : ""}`];
  // Banner rows (#20): one per visible run that crossed a budget / near-limit
  // threshold, showing its latest alert. Data-derived from RunRecord.alerts,
  // so every refresh shows the same banner — the engine already fired once.
  for (const r of visible) {
    const last = r.alerts?.[r.alerts.length - 1];
    if (last === undefined) continue;
    const text = `ALERT ${r.runId.slice(0, 8)} ${r.agent} ${describeAlert(last)}`;
    lines.push(ansi ? `\x1b[33m${text}\x1b[0m` : text);
  }
  lines.push(header);
  if (visible.length === 0) {
    lines.push(
      "no runs yet — start one with: harness run --agent claude \"your prompt\"",
    );
  } else {
    for (const r of visible) lines.push(tableRow(r, now, ansi, lastW, quota));
  }
  // Pace rows: live runs only, so a finished run's row disappears instead of
  // freezing at its last rate.
  const live = visible.filter((r) => isLive(r, now));
  opts.tracker?.retain(new Set(live.map((r) => r.runId)));
  if (live.length > 0) lines.push("");
  for (const r of live) {
    opts.tracker?.observe(r, now);
    lines.push(paceRow(r, (opts.tracker ?? new PaceTracker()).pace(r, now, opts.budgetUsd)));
  }
  lines.push("");
  lines.push(footer(visible));
  return lines.join("\n");
}

// ---------------------------------------------------------------- modes

async function liveLoop(dir: string, showAll: boolean, budgetUsd: number | undefined): Promise<number> {
  const ansi = !process.env.NO_COLOR;
  const tracker = new PaceTracker();
  const frameOpts: FrameOptions = { tracker, ...(budgetUsd !== undefined ? { budgetUsd } : {}) };
  const width = (): number => process.stdout.columns ?? 120;
  process.stdout.write(ansi ? "\x1b[?1049h\x1b[?25l" : "");

  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const stdin = process.stdin;

  const onKey = (buf: Buffer): void => {
    for (const b of buf) {
      if (b === 0x71 /* q */ || b === 0x03 /* Ctrl-C */) {
        cleanup();
        process.exit(0);
      }
    }
  };
  const onSignal = (): void => {
    cleanup();
    process.exit(0);
  };

  function cleanup(): void {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    stdin.removeListener("data", onKey);
    try {
      if (stdin.isTTY) stdin.setRawMode(false);
    } catch {
      /* stdin already gone */
    }
    stdin.pause();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    if (ansi) process.stdout.write("\x1b[?25h\x1b[?1049l");
  }

  let quota: QuotaRow[] | undefined;
  let quotaAt = 0;
  const refreshQuota = (): void => {
    if (Date.now() - quotaAt < QUOTA_REFRESH_MS) return;
    quotaAt = Date.now();
    collectQuota({ stateDir: dir })
      .then((rows) => {
        quota = rows;
      })
      .catch(() => {
        /* quota is best-effort; the column shows n/a until a read succeeds */
      });
  };

  const draw = (): void => {
    refreshQuota();
    let recs: RunRecord[];
    try {
      recs = listRunRecords(dir);
    } catch {
      recs = [];
    }
    process.stdout.write(
      "\x1b[H\x1b[2J" + frame(recs, dir, showAll, width(), ansi, { ...frameOpts, quota: quota ?? [] }) + "\n",
    );
  };

  if (stdin.isTTY && typeof stdin.setRawMode === "function") {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onKey);
  }
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  draw();
  timer = setInterval(draw, REDRAW_MS);
  await new Promise<never>(() => {});
  return 0; // unreachable: the promise above never resolves
}

// ---------------------------------------------------------------- command

export async function cmdDash(rest: string[]): Promise<number> {
  const args = parseArgs({
    args: rest,
    options: {
      json: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      dir: { type: "string" },
      "budget-usd": { type: "string" },
    },
    allowPositionals: true,
  });
  // Same flag-over-env rule as `ach run --budget-usd`.
  const budgetRaw = args.values["budget-usd"] ?? (process.env.AGENTIC_CODING_HARNESS_BUDGET_USD || undefined);
  let budgetUsd: number | undefined;
  if (budgetRaw !== undefined) {
    budgetUsd = Number(budgetRaw);
    if (!Number.isFinite(budgetUsd) || budgetUsd < 0) {
      throw new HarnessError(`dash --budget-usd expects a non-negative number, got '${budgetRaw}'`, "USAGE");
    }
  }
  if (args.values.dir === undefined && rest.some((a) => a.startsWith("--dir"))) {
    throw new HarnessError("dash --dir expects a state directory path", "USAGE");
  }
  const dir = args.values.dir ?? stateDir();
  if (args.values.json || !process.stdout.isTTY) {
    if (!args.values.json) {
      process.stderr.write("dash: stdout is not a TTY — dumping JSON (pass --json to silence this hint)\n");
    }
    const recs = listRunRecords(dir).map((r) => ({
      ...r,
      live: isLive(r),
      effectiveStatus: effectiveStatus(r),
    }));
    process.stdout.write(JSON.stringify(recs, null, 2) + "\n");
    return 0;
  }
  return liveLoop(dir, args.values.all, budgetUsd);
}
