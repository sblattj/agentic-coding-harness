// `ach status` — one "current usage snapshot" feeding every cheap-poll surface:
//   - `ach status`                 short human block            (#45)
//   - `ach status --compact`       one stable key=value line    (#45)
//   - `ach status --json`          one schema-stable object     (#45 / #62)
//   - `ach status --write-state P` atomic state file for companions (#62)
//   - `ach statusline`             Claude Code statusLine command (#61, see statusline.ts)
//
// Sources, and why: "today" spend is aggregated from exactly the records
// `ach stats --days 1` aggregates (the trailing 24h of <stateDir>/raw, plus the
// machine claude/codex/gemini transcripts only with --transcripts), so the two
// numbers agree on the same snapshot. Run counts come from the run registry
// (<stateDir>/runs); registry `totals` are NOT summed as spend, because the
// driver writes the same usage into raw/ too and that would double count.
//
// Honesty: a number this tool cannot know is null / "n/a", never 0. Block
// (5-hour window) cost comes from a BlockCostProvider; the CLI passes
// currentBlockCost (#18's currentBlock over the snapshot's own records), and
// a library caller that passes none gets null.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { HarnessError } from "../core/types.ts";
import { stateDir, readAllRecords } from "../core/store.ts";
import { effectiveStatus, listRunRecords, type RunRecord } from "../core/registry.ts";
import { writeJsonAtomic } from "../core/run-artifacts.ts";
import { createPricer } from "../core/pricing.ts";
import { scanAll } from "../monitors/transcripts.ts";
import { aggregate, fmtUsd, type AggregatableRecord } from "./lib.ts";
import { currentBlock } from "../core/usage-windows.ts";

/** Bump only on a breaking change (rename/remove/retype). Additive fields do not bump. */
export const STATUS_SCHEMA_VERSION = 1;
/** Budget state flips ok -> near at this fraction of the budget used. */
export const BUDGET_NEAR_FRACTION = 0.8;
/** Trailing window "today" covers — identical to `ach stats --days 1`. */
export const TODAY_WINDOW_MS = 86_400_000;
/** Default refresh cadence of `--write-state` without `--once` (the `ach watch` poll). */
export const DEFAULT_INTERVAL_MS = 5_000;
export const BUDGET_ENV = "AGENTIC_CODING_HARNESS_BUDGET_USD";

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

// ---------------------------------------------------------------- schema

const RunStatusEnum = z.enum(["running", "interrupted", "success", "error", "aborted", "unavailable"]);

const BudgetSchema = z.discriminatedUnion("configured", [
  z.object({ configured: z.literal(false) }),
  z.object({
    configured: z.literal(true),
    usd: z.number(),
    remainingUsd: z.number(),
    usedFraction: z.number(),
    state: z.enum(["ok", "near", "exceeded"]),
    nearFraction: z.number(),
  }),
]);

export const StatusSnapshotSchema = z.object({
  schemaVersion: z.literal(STATUS_SCHEMA_VERSION),
  generatedAt: z.string(),
  window: z.object({ kind: z.literal("trailing-24h"), since: z.string(), until: z.string() }),
  sources: z.array(z.enum(["state", "transcripts"])),
  runs: z.object({
    total: z.number().int(),
    running: z.number().int(),
    success: z.number().int(),
    error: z.number().int(),
    aborted: z.number().int(),
    interrupted: z.number().int(),
    unavailable: z.number().int(), // #60: vendor outage / no data, not a failure
  }),
  activeByAgent: z.record(z.string(), z.number().int()),
  newestRun: z
    .object({
      runId: z.string(),
      agent: z.string(),
      status: RunStatusEnum,
      startedAt: z.string(),
      durationMs: z.number().nullable(),
    })
    .nullable(),
  today: z.object({
    costUsd: z.number(),
    records: z.number().int(),
    byAgent: z.record(z.string(), z.object({ costUsd: z.number(), records: z.number().int() })),
  }),
  block: z.object({ costUsd: z.number().nullable(), source: z.enum(["unavailable", "provider"]) }),
  budget: BudgetSchema,
});

export type StatusSnapshot = z.infer<typeof StatusSnapshotSchema>;
export type BudgetView = z.infer<typeof BudgetSchema>;

/** Documented top-level key order of the snapshot (stable; new keys append). */
export const STATUS_JSON_KEYS = [
  "schemaVersion",
  "generatedAt",
  "window",
  "sources",
  "runs",
  "activeByAgent",
  "newestRun",
  "today",
  "block",
  "budget",
] as const;

// ---------------------------------------------------------------- compute

/**
 * Seam for 5-hour block accounting (#18): return the current block's cost in
 * USD, or null when unknown. Absent => block.costUsd is null ("n/a").
 * `records` are the trailing-24h records the snapshot already collected (same
 * sources as `today`), so a provider need not scan again.
 */
export type BlockCostProvider = (ctx: {
  now: number;
  stateDir: string;
  records?: readonly AggregatableRecord[];
}) => number | null | Promise<number | null>;

/**
 * The default provider `ach status` / `ach statusline` use: the open Claude
 * 5h block (currentBlock, src/core/usage-windows.ts) over the snapshot's
 * records. null when no block is open or none of its records is priced.
 * Limitation: blocks are chained from the trailing-24h records only, so a
 * block chain of continuous activity older than 24h may start differently
 * than `ach stats --blocks` over a longer window would place it.
 */
export const currentBlockCost: BlockCostProvider = ({ now, records }) => {
  if (!records) return null;
  const block = currentBlock(records, now);
  if (!block || block.records - block.unpricedRecords === 0) return null;
  return block.costUsd;
};

export interface SnapshotOptions {
  now?: number;
  /** Also scan machine claude/codex/gemini transcripts (like `ach stats` without --state-only). */
  includeTranscripts?: boolean;
  /** Budget in USD; undefined => read AGENTIC_CODING_HARNESS_BUDGET_USD (unset/invalid => unconfigured). */
  budgetUsd?: number;
  blockCost?: BlockCostProvider;
}

export function deriveBudget(costUsd: number, budgetUsd: number | undefined): BudgetView {
  if (budgetUsd === undefined) return { configured: false };
  const usedFraction = budgetUsd > 0 ? round6(costUsd / budgetUsd) : costUsd > 0 ? Infinity : 0;
  const state = usedFraction >= 1 ? "exceeded" : usedFraction >= BUDGET_NEAR_FRACTION ? "near" : "ok";
  return {
    configured: true,
    usd: budgetUsd,
    remainingUsd: round6(budgetUsd - costUsd),
    // JSON has no Infinity: a zero budget with any spend reports 1 (fully used).
    usedFraction: Number.isFinite(usedFraction) ? usedFraction : 1,
    state,
    nearFraction: BUDGET_NEAR_FRACTION,
  };
}

/** Budget from env; an unparseable value is reported, never guessed. */
export function budgetFromEnv(): { usd?: number; warning?: string } {
  const raw = process.env[BUDGET_ENV];
  if (raw === undefined || raw === "") return {};
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return { warning: `${BUDGET_ENV}='${raw}' is not a non-negative number; budget ignored` };
  return { usd: n };
}

/** Same composite identity `ach stats` dedupes on (state record vs transcript copy). */
function dedupeKey(r: {
  agent?: string;
  sessionId?: string | null;
  model?: string | null;
  ts?: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens?: number;
}): string {
  return JSON.stringify([
    r.agent ?? "",
    r.sessionId ?? "",
    r.model ?? "",
    r.ts ?? "",
    r.inputTokens,
    r.outputTokens,
    r.cacheReadTokens,
    r.cacheWriteTokens,
    r.reasoningTokens ?? 0,
  ]);
}

/**
 * The records `ach stats --days 1` aggregates. Mirrors cmdStats's collection
 * (src/cli/ach.ts); tests/status.test.ts pins parity with the real command so
 * the two cannot drift silently.
 */
async function collectTodayRecords(sinceTs: number, includeTranscripts: boolean): Promise<AggregatableRecord[]> {
  const stateRecords = await readAllRecords({ sinceTs });
  const records: AggregatableRecord[] = stateRecords.map((r) => ({
    ts: r.ts,
    agent: r.agent,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens,
    cacheWriteTokens: r.cacheWriteTokens,
    reasoningTokens: r.reasoningTokens ?? 0,
    costUsd: r.costUsd,
  }));
  if (!includeTranscripts) return records;
  const seen = new Set(stateRecords.map(dedupeKey));
  const pricer = createPricer();
  for await (const rec of scanAll()) {
    const tsMs = rec.timestamp ? Date.parse(rec.timestamp) : NaN;
    if (!Number.isFinite(tsMs) || tsMs < sinceTs) continue;
    const row = {
      ts: new Date(tsMs).toISOString(),
      agent: rec.agent,
      sessionId: rec.sessionId ?? "unknown",
      model: rec.model ?? undefined,
      inputTokens: rec.input,
      outputTokens: rec.output,
      cacheReadTokens: rec.cacheRead,
      cacheWriteTokens: rec.cacheWrite,
      reasoningTokens: rec.reasoning,
    };
    const key = dedupeKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    let costUsd: number | undefined;
    if (rec.model) {
      const cost = pricer.price({
        model: rec.model,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheWriteTokens: row.cacheWriteTokens,
      });
      if (!Number.isNaN(cost)) costUsd = cost;
    }
    records.push(costUsd === undefined ? { ...row } : { ...row, costUsd });
  }
  pricer.drainWarnings();
  return records;
}

function runEnd(rec: RunRecord, status: string, now: number): number | undefined {
  if (rec.endedAt !== undefined) return rec.endedAt;
  if (status === "running") return now;
  return rec.updatedAt;
}

export async function computeStatusSnapshot(opts: SnapshotOptions = {}): Promise<StatusSnapshot> {
  const now = opts.now ?? Date.now();
  const since = now - TODAY_WINDOW_MS;
  const dir = stateDir();
  const includeTranscripts = opts.includeTranscripts === true;

  // Runs: started inside the window, plus anything still live regardless of age.
  const runs = { total: 0, running: 0, success: 0, error: 0, aborted: 0, interrupted: 0, unavailable: 0 };
  const activeByAgent: Record<string, number> = {};
  let newest: { rec: RunRecord; status: z.infer<typeof RunStatusEnum> } | undefined;
  for (const rec of listRunRecords(dir)) {
    const status = effectiveStatus(rec, now);
    if (rec.startedAt < since && status !== "running") continue;
    runs.total += 1;
    runs[status] += 1;
    if (status === "running") activeByAgent[rec.agent] = (activeByAgent[rec.agent] ?? 0) + 1;
    if (!newest || rec.startedAt > newest.rec.startedAt) newest = { rec, status };
  }

  const todayRecords = await collectTodayRecords(since, includeTranscripts);
  const agg = aggregate(todayRecords);
  const byAgent: Record<string, { costUsd: number; records: number }> = {};
  for (const [agent, b] of Object.entries(agg.byAgent).sort(([a], [b]) => a.localeCompare(b))) {
    byAgent[agent] = { costUsd: b.costUsd, records: b.records };
  }

  let blockCostUsd: number | null = null;
  if (opts.blockCost) {
    const v = await opts.blockCost({ now, stateDir: dir, records: todayRecords });
    blockCostUsd = typeof v === "number" && Number.isFinite(v) ? round6(v) : null;
  }

  const budgetUsd = opts.budgetUsd ?? budgetFromEnv().usd;
  const end = newest ? runEnd(newest.rec, newest.status, now) : undefined;

  const snap: StatusSnapshot = {
    schemaVersion: STATUS_SCHEMA_VERSION,
    generatedAt: new Date(now).toISOString(),
    window: { kind: "trailing-24h", since: new Date(since).toISOString(), until: new Date(now).toISOString() },
    sources: includeTranscripts ? ["state", "transcripts"] : ["state"],
    runs,
    activeByAgent,
    newestRun: newest
      ? {
          runId: newest.rec.runId,
          agent: newest.rec.agent,
          status: newest.status,
          startedAt: new Date(newest.rec.startedAt).toISOString(),
          durationMs: end === undefined ? null : Math.max(0, end - newest.rec.startedAt),
        }
      : null,
    today: { costUsd: agg.totals.costUsd, records: agg.totals.records, byAgent },
    block: { costUsd: blockCostUsd, source: blockCostUsd === null ? "unavailable" : "provider" },
    budget: deriveBudget(agg.totals.costUsd, budgetUsd),
  };
  return snap;
}

// ---------------------------------------------------------------- render

/**
 * `runs=N running=N success=N error=N cost_today=$X.XXXX[ budget_left=$X.XXXX]`
 * Fixed key order; budget_left only when a budget is configured.
 */
export function formatCompact(s: StatusSnapshot): string {
  const parts = [
    `runs=${s.runs.total}`,
    `running=${s.runs.running}`,
    `success=${s.runs.success}`,
    `error=${s.runs.error}`,
    `cost_today=${fmtUsd(s.today.costUsd)}`,
  ];
  if (s.budget.configured) parts.push(`budget_left=${fmtUsd(s.budget.remainingUsd)}`);
  return parts.join(" ");
}

function fmtDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : m > 0 ? `${m}m${String(s).padStart(2, "0")}s` : `${s}s`;
}

export function formatBudgetCell(b: BudgetView): string {
  if (!b.configured) return "n/a";
  const pct = (b.usedFraction * 100).toFixed(0);
  return `${fmtUsd(b.remainingUsd)} left of ${fmtUsd(b.usd)} (${pct}% used, ${b.state})`;
}

export function formatHuman(s: StatusSnapshot): string {
  const r = s.runs;
  const active = Object.entries(s.activeByAgent)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([a, n]) => `${a}=${n}`)
    .join(" ");
  const perAgent = Object.entries(s.today.byAgent)
    .map(([a, b]) => `${a}=${fmtUsd(b.costUsd)}`)
    .join(" ");
  const nr = s.newestRun;
  const lines = [
    `runs       ${r.total} (running=${r.running} success=${r.success} error=${r.error} aborted=${r.aborted} interrupted=${r.interrupted} unavailable=${r.unavailable}) · trailing 24h`,
    `active     ${r.running}${active ? ` (${active})` : ""}`,
    `today      ${fmtUsd(s.today.costUsd)}${perAgent ? ` (${perAgent})` : ""}${s.sources.includes("transcripts") ? "" : " · state dir only"}`,
    `block      ${s.block.costUsd === null ? "n/a" : fmtUsd(s.block.costUsd)}`,
    `budget     ${formatBudgetCell(s.budget)}`,
    `newest     ${nr ? `${nr.agent} ${nr.status} ${nr.runId} · ${nr.durationMs === null ? "n/a" : fmtDuration(nr.durationMs)} wall-clock` : "-"}`,
  ];
  return lines.join("\n");
}

/** Atomic snapshot write (tmp + rename via writeJsonAtomic); creates the parent dir. */
export function writeStateFile(file: string, s: StatusSnapshot): void {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  writeJsonAtomic(file, s);
}

// ---------------------------------------------------------------- cli

function parseUsd(v: string | undefined, flag: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new HarnessError(`${flag} expects a non-negative number, got '${v}'`, "USAGE");
  return n;
}

function parseInterval(v: string | undefined): number {
  if (v === undefined) return DEFAULT_INTERVAL_MS;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HarnessError(`--interval-ms expects a positive integer, got '${v}'`, "USAGE");
  return n;
}

export async function cmdStatus(rest: string[]): Promise<number> {
  const args = parseArgs({
    args: rest,
    options: {
      compact: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      once: { type: "boolean", default: false },
      "write-state": { type: "string" },
      "interval-ms": { type: "string" },
      transcripts: { type: "boolean", default: false },
      "budget-usd": { type: "string" },
    },
    allowPositionals: false,
  });
  const v = args.values;
  if (v.compact && v.json) throw new HarnessError("--compact and --json are mutually exclusive", "USAGE");
  const intervalMs = parseInterval(v["interval-ms"]);
  let budgetUsd = parseUsd(v["budget-usd"], "--budget-usd");
  if (budgetUsd === undefined) {
    const env = budgetFromEnv();
    if (env.warning) process.stderr.write(`[warn] ${env.warning}\n`);
    budgetUsd = env.usd;
  }
  const opts: SnapshotOptions = {
    includeTranscripts: v.transcripts,
    blockCost: currentBlockCost,
    ...(budgetUsd !== undefined ? { budgetUsd } : {}),
  };

  const print = (s: StatusSnapshot) => {
    if (v.json) process.stdout.write(JSON.stringify(s, null, 2) + "\n");
    else if (v.compact) process.stdout.write(formatCompact(s) + "\n");
    else process.stdout.write(formatHuman(s) + "\n");
  };

  const target = v["write-state"];
  if (target === undefined) {
    print(await computeStatusSnapshot(opts));
    return 0;
  }
  // --write-state: silent on stdout unless --json/--compact asks for it too.
  const tick = async () => {
    const s = await computeStatusSnapshot(opts);
    writeStateFile(target, s);
    if (v.json || v.compact) print(s);
  };
  await tick();
  if (v.once) return 0;
  // Long-running companion feed: refresh on the watch cadence until killed.
  let busy = false;
  setInterval(() => {
    if (busy) return;
    busy = true;
    tick()
      .catch((e: unknown) => process.stderr.write(`[warn] status refresh failed: ${e instanceof Error ? e.message : String(e)}\n`))
      .finally(() => {
        busy = false;
      });
  }, intervalMs);
  await new Promise<never>(() => {});
  return 0; // unreachable
}
