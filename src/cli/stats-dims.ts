// Extra `ach stats` grouping dimensions, kept out of lib.ts aggregate() so the
// base totals/byAgent/byDay contract stays untouched:
//
//  - byModel (#27): runtime-scoped `agent/model` rows split from the per-model
//    slices adapters carry under extra.raw.models; optional model x day table;
//    opt-in merging (--merge-models + alias map) into bare model rows.
//  - byProject (#43): rollup by repository root of the run's cwd, with a
//    friendly-name alias map; `unknown` when the record has no cwd.
//  - cacheHitRatio (#69) on every row (see src/core/cache-ratio.ts).
//
// Honesty rules: an unpriced model's cost is null (never $0) and it is listed
// in unpricedModels; a record with no per-model slices whose model label is a
// composite ("a+b", "multi") or absent goes to the explicit `unattributed`
// bucket, never into a guessed dominant model.
import fs from "node:fs";
import { bucketKey } from "./time-window.ts";
import { selectCost, type CostMode } from "./cost-mode.ts";
import os from "node:os";
import path from "node:path";
import { cacheHitRatio, fmtCacheHit } from "../core/cache-ratio.ts";
import type { Pricer } from "../core/pricing.ts";
import type { RunRecord } from "../core/registry.ts";
import { HarnessError } from "../core/types.ts";
import { emptyBucket, fmtInt, fmtUsd, type AggregatableRecord, type UsageBucket } from "./lib.ts";

export const UNATTRIBUTED = "unattributed";
export const UNKNOWN_PROJECT = "unknown";

/** A stats row plus the optional fields the extra dimensions read. */
export interface DimRecord extends AggregatableRecord {
  sessionId?: string | null;
  model?: string | null;
  extra?: Record<string, unknown>;
  /** 1h-TTL subset of cacheWriteTokens (issue #105), when the producer split it. */
  cacheWrite1hTokens?: number;
  /** Working directory of the run, when known (run registry / transcript). */
  cwd?: string | null;
}

/** Per-model row: cost is null when any contribution could not be priced. */
export interface ModelBucket extends Omit<UsageBucket, "costUsd"> {
  costUsd: number | null;
  cacheHitRatio: number | null;
}

export interface RatioBucket extends Omit<UsageBucket, "costUsd"> {
  costUsd: number | null;
  cacheHitRatio: number | null;
}

export interface DimOptions {
  costMode?: CostMode;
  timeZone?: string;
  /** Prices slices that carry no CLI-reported cost. Without it they are unpriced. */
  pricer?: Pricer;
  /** Merge scoped `agent/model` rows into bare model rows (after aliasing). */
  mergeModels?: boolean;
  /** model -> canonical name, applied only when mergeModels is set. */
  modelAliases?: Record<string, string>;
  /** Build the model x day table. */
  byModelDay?: boolean;
  /** Build the byProject rollup. */
  byProject?: boolean;
  /** absolute path -> friendly project name. */
  projectAliases?: Record<string, string>;
}

export interface DimAggregates {
  byModel: Record<string, ModelBucket>;
  /** Sorted `agent/model` (or merged) keys whose cost is null. */
  unpricedModels: string[];
  byModelDay?: Record<string, Record<string, ModelBucket>>;
  byProject?: Record<string, RatioBucket>;
}

// ---------------------------------------------------------------- per-model

interface Slice {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** 1h-TTL subset of cacheWrite, when the slice itself carries a split. */
  cacheWrite1h?: number;
  reasoning: number;
  costUsd?: number;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Per-model slices from extra.raw.models (≥1 well-formed entries), else null. */
function usageSlices(extra: Record<string, unknown> | undefined): Slice[] | null {
  const models = (extra as { raw?: { models?: unknown } } | undefined)?.raw?.models;
  if (!Array.isArray(models) || models.length === 0) return null;
  const out: Slice[] = [];
  for (const entry of models) {
    if (typeof entry !== "object" || entry === null) return null;
    const e = entry as Record<string, unknown>;
    if (typeof e.model !== "string" || e.model === "") return null;
    out.push({
      model: e.model,
      input: num(e.input),
      output: num(e.output),
      cacheRead: num(e.cacheRead),
      cacheWrite: num(e.cacheWrite),
      ...(typeof e.cacheWrite1h === "number" && Number.isFinite(e.cacheWrite1h) ? { cacheWrite1h: e.cacheWrite1h } : {}),
      reasoning: num(e.reasoning),
      ...(typeof e.costUsd === "number" && Number.isFinite(e.costUsd) ? { costUsd: e.costUsd } : {}),
    });
  }
  return out;
}

/** A label that names no single model: absent, a sentinel, or a joined list. */
function isCompositeLabel(model: string | null | undefined): boolean {
  return !model || model === "multi" || model === "unknown" || model.includes("+");
}

interface Contribution {
  model: string; // UNATTRIBUTED when not attributable
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number | null;
}

function priceSlice(pricer: Pricer | undefined, s: Slice, oneHourShare: number): number | null {
  if (!pricer) return null;
  const cost = pricer.price({
    model: s.model,
    inputTokens: s.input,
    outputTokens: s.output,
    cacheReadTokens: s.cacheRead,
    cacheWriteTokens: s.cacheWrite,
    cacheWrite1hTokens: s.cacheWrite1h ?? s.cacheWrite * oneHourShare,
  });
  pricer.drainWarnings(); // surfaced once as unpricedModels, not per slice
  return Number.isFinite(cost) ? cost : null;
}

function contributions(r: DimRecord, pricer: Pricer | undefined, mode: CostMode = "auto"): Contribution[] {
  const slices = usageSlices(r.extra);
  if (slices) {
    // Same TTL rule as Pricer.price (issue #105): claude's per-model slices
    // carry no TTL split, so the record-level 1h share applies to each.
    const writes = slices.reduce((a, s) => a + s.cacheWrite, 0);
    const share =
      typeof r.cacheWrite1hTokens === "number" && writes > 0 ? Math.min(1, Math.max(0, r.cacheWrite1hTokens / writes)) : 0;
    return slices.map((s) => ({
      model: s.model,
      inputTokens: s.input,
      outputTokens: s.output,
      cacheReadTokens: s.cacheRead,
      cacheWriteTokens: s.cacheWrite,
      reasoningTokens: s.reasoning,
      // CLI-reported slice cost first; a lone slice IS the record, so the
      // record's cost is its cost; otherwise price the slice at its own rates.
      costUsd:
        (slices.length === 1 && r.costUsd !== undefined ? r.costUsd : selectCost(mode, s.costUsd, priceSlice(pricer, s, share) ?? undefined).costUsd ?? null),
    }));
  }
  return [
    {
      model: isCompositeLabel(r.model) ? UNATTRIBUTED : r.model!,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheReadTokens: r.cacheReadTokens,
      cacheWriteTokens: r.cacheWriteTokens,
      reasoningTokens: r.reasoningTokens,
      costUsd: r.costUsd ?? null,
    },
  ];
}

function emptyModelBucket(): ModelBucket {
  return { ...emptyBucket(), costUsd: 0, cacheHitRatio: null };
}

function addContribution(b: ModelBucket, c: Contribution): void {
  b.records += 1;
  b.inputTokens += c.inputTokens;
  b.outputTokens += c.outputTokens;
  b.cacheReadTokens += c.cacheReadTokens;
  b.cacheWriteTokens += c.cacheWriteTokens;
  b.reasoningTokens += c.reasoningTokens;
  b.costUsd = b.costUsd === null || c.costUsd === null ? null : b.costUsd + c.costUsd;
  if (c.costUsd === null) b.unpricedRecords += 1;
}

function finishModel(b: ModelBucket): ModelBucket {
  if (b.costUsd !== null) b.costUsd = Math.round(b.costUsd * 1e6) / 1e6;
  b.cacheHitRatio = cacheHitRatio(b);
  return b;
}

/** `agent/model` by default; the bare (aliased) model name when merging. */
export function modelKey(agent: string, model: string, opts: Pick<DimOptions, "mergeModels" | "modelAliases"> = {}): string {
  if (!opts.mergeModels) return `${agent}/${model}`;
  return opts.modelAliases?.[model] ?? model;
}

// ---------------------------------------------------------------- projects

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

const rootCache = new Map<string, string>();

/**
 * Repository root of a cwd: the SHORTEST (outermost) enclosing directory that
 * holds a `.git` entry, so a nested worktree or submodule groups with the repo
 * that contains it. The home directory and filesystem root are never
 * candidates (a dotfiles repo at ~ must not swallow every project). A non-git
 * or missing directory keys on the cwd itself.
 */
export function projectRoot(cwd: string): string {
  const start = path.resolve(expandHome(cwd));
  const hit = rootCache.get(start);
  if (hit !== undefined) return hit;
  const home = path.resolve(os.homedir());
  let found: string | undefined;
  let dir = start;
  for (;;) {
    const parent = path.dirname(dir);
    if (dir === parent || dir === home) break;
    if (fs.existsSync(path.join(dir, ".git"))) found = dir;
    dir = parent;
  }
  const root = found ?? start;
  rootCache.set(start, root);
  return root;
}

function parseAliasObject(raw: unknown, source: string): Record<string, string> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new HarnessError(`${source}: expected a JSON object of {"<path>": "<name>"}`, "USAGE");
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== "string" || v === "") {
      throw new HarnessError(`${source}: alias for '${k}' must be a non-empty string`, "USAGE");
    }
    out[path.resolve(expandHome(k))] = v;
  }
  return out;
}

/**
 * Project alias map, layered (later wins): the
 * AGENTIC_CODING_HARNESS_PROJECT_ALIASES JSON, then a --project-aliases JSON
 * file, then repeated --project-alias <path>=<name> pairs. Keys are absolute
 * paths (a leading ~ expands to the home directory).
 */
export function loadProjectAliases(src: { envJson?: string; file?: string; pairs?: string[] }): Record<string, string> {
  let out: Record<string, string> = {};
  if (src.envJson && src.envJson.trim() !== "") {
    let raw: unknown;
    try {
      raw = JSON.parse(src.envJson);
    } catch (e) {
      throw new HarnessError(
        `AGENTIC_CODING_HARNESS_PROJECT_ALIASES is not valid JSON: ${e instanceof Error ? e.message : e}`,
        "USAGE",
      );
    }
    out = { ...out, ...parseAliasObject(raw, "AGENTIC_CODING_HARNESS_PROJECT_ALIASES") };
  }
  if (src.file) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(src.file, "utf8"));
    } catch (e) {
      throw new HarnessError(
        `--project-aliases '${src.file}': ${e instanceof Error ? e.message : e}`,
        "USAGE",
      );
    }
    out = { ...out, ...parseAliasObject(raw, `--project-aliases '${src.file}'`) };
  }
  for (const pair of src.pairs ?? []) {
    const eq = pair.lastIndexOf("=");
    if (eq <= 0 || eq === pair.length - 1) {
      throw new HarnessError(`--project-alias expects <path>=<name> (got '${pair}')`, "USAGE");
    }
    out[path.resolve(expandHome(pair.slice(0, eq)))] = pair.slice(eq + 1);
  }
  return out;
}

/** <from>=<to> pairs for --model-alias. */
export function parseModelAliases(pairs: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs ?? []) {
    const eq = pair.indexOf("=");
    if (eq <= 0 || eq === pair.length - 1) {
      throw new HarnessError(`--model-alias expects <model>=<name> (got '${pair}')`, "USAGE");
    }
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

/**
 * Project identity of a cwd: the repo root, renamed by the longest alias key
 * that equals or contains the root (or the cwd itself). No cwd -> `unknown`.
 */
export function projectOf(
  cwd: string | null | undefined,
  aliases: Record<string, string> = {},
): { name: string; root: string | null } {
  if (!cwd) return { name: UNKNOWN_PROJECT, root: null };
  const root = projectRoot(cwd);
  const abs = path.resolve(expandHome(cwd));
  let best: string | undefined;
  for (const key of Object.keys(aliases)) {
    const covers = (p: string) => p === key || p.startsWith(key.endsWith(path.sep) ? key : key + path.sep);
    if ((covers(root) || covers(abs)) && (best === undefined || key.length > best.length)) best = key;
  }
  return { name: best !== undefined ? aliases[best]! : root, root };
}

/** True when a record's project matches a --project value (alias name or path). */
export function projectMatches(cwd: string | null | undefined, want: string, aliases: Record<string, string>): boolean {
  const p = projectOf(cwd, aliases);
  if (p.name === want) return true;
  return p.root !== null && p.root === path.resolve(expandHome(want));
}

/** Index RunRecord.cwd by agent+session (and session alone as a fallback). */
export function cwdIndex(runs: Pick<RunRecord, "agent" | "sessionId" | "cwd">[]): (agent: string, sessionId: string | null | undefined) => string | undefined {
  const exact = new Map<string, string>();
  const bySession = new Map<string, string>();
  for (const run of runs) {
    if (!run.sessionId || !run.cwd) continue;
    exact.set(`${run.agent}\u0000${run.sessionId}`, run.cwd);
    bySession.set(run.sessionId, run.cwd);
  }
  return (agent, sessionId) => {
    if (!sessionId) return undefined;
    return exact.get(`${agent}\u0000${sessionId}`) ?? bySession.get(sessionId);
  };
}

// ---------------------------------------------------------------- aggregate

export function aggregateDims(records: DimRecord[], opts: DimOptions = {}): DimAggregates {
  const byModel: Record<string, ModelBucket> = {};
  const byModelDay: Record<string, Record<string, ModelBucket>> = {};
  const byProject: Record<string, RatioBucket> = {};
  for (const r of records) {
    const day = opts.timeZone ? bucketKey(r.ts, "day", opts.timeZone) : r.ts ? r.ts.slice(0, 10) : "unknown";
    for (const c of contributions(r, opts.pricer, opts.costMode)) {
      const key = modelKey(r.agent, c.model, opts);
      addContribution((byModel[key] ??= emptyModelBucket()), c);
      if (opts.byModelDay) addContribution(((byModelDay[day] ??= {})[key] ??= emptyModelBucket()), c);
    }
    if (opts.byProject) {
      const name = projectOf(r.cwd, opts.projectAliases).name;
      const b = (byProject[name] ??= { ...emptyBucket(), cacheHitRatio: null });
      b.records += 1;
      b.inputTokens += r.inputTokens;
      b.outputTokens += r.outputTokens;
      b.cacheReadTokens += r.cacheReadTokens;
      b.cacheWriteTokens += r.cacheWriteTokens;
      b.reasoningTokens += r.reasoningTokens;
      b.costUsd = b.costUsd === null || r.costUsd === undefined ? null : b.costUsd + r.costUsd;
      if (r.costUsd === undefined) b.unpricedRecords += 1;
    }
  }
  for (const b of Object.values(byModel)) finishModel(b);
  for (const cells of Object.values(byModelDay)) for (const b of Object.values(cells)) finishModel(b);
  for (const b of Object.values(byProject)) {
    if (b.costUsd !== null) b.costUsd = Math.round(b.costUsd * 1e6) / 1e6;
    b.cacheHitRatio = cacheHitRatio(b);
  }
  const out: DimAggregates = {
    byModel,
    unpricedModels: Object.entries(byModel)
      .filter(([k, b]) => b.costUsd === null && !isUnattributedKey(k))
      .map(([k]) => k)
      .sort(),
  };
  if (opts.byModelDay) out.byModelDay = byModelDay;
  if (opts.byProject) out.byProject = byProject;
  return out;
}

function isUnattributedKey(k: string): boolean {
  return k === UNATTRIBUTED || k.endsWith(`/${UNATTRIBUTED}`);
}

// ---------------------------------------------------------------- CLI glue

export type ByDim = "model" | "project";
export const BY_DIMS: readonly ByDim[] = ["model", "project"];

/** --by values (repeatable and/or comma-joined) -> the set of extra dimensions. */
export function parseByDims(values: string[] | undefined): Set<ByDim> {
  const out = new Set<ByDim>();
  for (const v of values ?? []) {
    for (const part of v.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (!(BY_DIMS as readonly string[]).includes(part)) {
        throw new HarnessError(`unknown --by '${part}' (expected one of: ${BY_DIMS.join(", ")})`, "USAGE");
      }
      out.add(part as ByDim);
    }
  }
  return out;
}

/** Cache-hit ratios for the base aggregate buckets (kept out of their shapes). */
export function baseCacheRatios(agg: {
  totals: UsageBucket;
  byAgent: Record<string, UsageBucket>;
  byDay: Record<string, UsageBucket>;
  byWeek?: Record<string, UsageBucket>;
  byMonth?: Record<string, UsageBucket>;
}): { byWeek?: Record<string, number | null>; byMonth?: Record<string, number | null>; total: number | null; byAgent: Record<string, number | null>; byDay: Record<string, number | null> } {
  const map = (m: Record<string, UsageBucket>) =>
    Object.fromEntries(Object.entries(m).map(([k, b]) => [k, cacheHitRatio(b)]));
  return { total: cacheHitRatio(agg.totals), byAgent: map(agg.byAgent), byDay: map(agg.byDay), ...(agg.byWeek ? { byWeek: map(agg.byWeek) } : {}), ...(agg.byMonth ? { byMonth: map(agg.byMonth) } : {}) };
}

/** One text row, same columns as the base stats lines plus cacheHit. */
export function statsLine(label: string, b: Omit<UsageBucket, "costUsd"> & { costUsd: number | null }): string {
  return `${label.padEnd(9)} records=${fmtInt(b.records)} input=${fmtInt(b.inputTokens)} output=${fmtInt(b.outputTokens)} cacheRead=${fmtInt(b.cacheReadTokens)} cacheWrite=${fmtInt(b.cacheWriteTokens)} reasoning=${fmtInt(b.reasoningTokens)} cost=${b.costUsd === null ? "n/a" : fmtUsd(b.costUsd)} cacheHit=${fmtCacheHit(cacheHitRatio(b))}`;
}

/** Text sections for the extra dimensions. byModel prints only with --by model. */
export function renderDimsText(dims: DimAggregates, show: { model: boolean; project: boolean }): string[] {
  const lines: string[] = [];
  const sorted = <T>(m: Record<string, T>) => Object.entries(m).sort(([a], [b]) => a.localeCompare(b));
  if (show.model) {
    lines.push("-- by model");
    for (const [k, b] of sorted(dims.byModel)) lines.push(statsLine(k, b));
    if (dims.byModelDay) {
      lines.push("-- model x day");
      for (const [day, cells] of sorted(dims.byModelDay)) {
        for (const [k, b] of sorted(cells)) lines.push(statsLine(`${day} ${k}`, b));
      }
    }
  }
  if (show.project && dims.byProject) {
    lines.push("-- by project");
    for (const [k, b] of sorted(dims.byProject)) lines.push(statsLine(k, b));
  }
  return lines;
}
