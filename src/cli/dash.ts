// dash — live run dashboard over the driver registry (src/core/registry.ts).
// Default view: ANSI full-screen table redrawn ~2/s over <stateDir>/runs.
// --json dumps RunRecords (+ live flag and effectiveStatus) for tools and
// tests; no TTY falls back to that same dump with a hint on stderr.
import { parseArgs } from "node:util";
import { HarnessError } from "../core/types.ts";
import { stateDir } from "../core/store.ts";
import {
  effectiveStatus,
  isLive,
  listRunRecords,
  type RunRecord,
} from "../core/registry.ts";

const REDRAW_MS = 500;
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
  if (ctx?.available !== true || ctx.tokens === undefined) return "";
  const pct = ctx.percentage === undefined ? "" : ` (${ctx.percentage.toFixed(1)}%)`;
  return `${compact(ctx.tokens)}${pct}`;
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
};

function statusCell(rec: RunRecord, ansi: boolean, w: number): string {
  const status = effectiveStatus(rec);
  const plain = padR(GLYPHS[status], w);
  if (!ansi || status === "success") return plain;
  const glyph = status === "running" ? "●" : status === "error" ? "✗" : "!";
  return `\x1b[${status === "running" ? 32 : status === "error" ? 31 : 33}m${glyph}\x1b[0m` + plain.slice(1);
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

function tableRow(rec: RunRecord, now: number, ansi: boolean, lastW: number): string {
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
    padR(rec.lastEvent ?? "", lastW),
  ];
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

/** One rendered dashboard frame. Exported for tests (pure: no TTY, no I/O). */
export function frame(recs: RunRecord[], dir: string, showAll: boolean, width: number, ansi: boolean): string {
  const now = Date.now();
  const visible = recs.filter((r) => isVisible(r, now, showAll));
  const fixed = Object.values(COL).reduce((a, w) => a + w, 0) + Object.keys(COL).length;
  const lastW = Math.max(10, width - fixed);
  const lines: string[] = [`harness dash — ${dir}${showAll ? "  (--all)" : ""}`, HEADER];
  if (visible.length === 0) {
    lines.push(
      "no runs yet — start one with: harness run --agent claude \"your prompt\"",
    );
  } else {
    for (const r of visible) lines.push(tableRow(r, now, ansi, lastW));
  }
  lines.push("");
  lines.push(footer(visible));
  return lines.join("\n");
}

// ---------------------------------------------------------------- modes

async function liveLoop(dir: string, showAll: boolean): Promise<number> {
  const ansi = !process.env.NO_COLOR;
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

  const draw = (): void => {
    let recs: RunRecord[];
    try {
      recs = listRunRecords(dir);
    } catch {
      recs = [];
    }
    process.stdout.write("\x1b[H\x1b[2J" + frame(recs, dir, showAll, width(), ansi) + "\n");
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
    },
    allowPositionals: true,
  });
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
  return liveLoop(dir, args.values.all);
}
