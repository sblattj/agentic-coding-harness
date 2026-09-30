// audit — re-derive every RunRecord's recorded aggregates from the run's raw
// transcript and report per-run deltas (issue #34).
//
// WHAT IS AUDITED
//   RunRecords under <stateDir>/runs/*.json that carry `totals`. Fields:
//   inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd.
//   The canonical per-session records under <stateDir>/raw/<agent>/ are NOT
//   audited: nothing records an aggregate over them (`ach stats` sums them on
//   the fly), so there is no recorded number to compare against.
//
// PRIMARY SOURCE
//   The driver NDJSON transcript <stateDir>/raw/<agent>-<session>.jsonl
//   (resolveRawTranscript tolerates a moved state dir). Only `usage` and
//   `usage_raw` lines count, exactly as in the driver.
//
// INDEPENDENT RE-DERIVATION
//   The driver's recorded totals come from each usage event's pre-normalized
//   `usage` record (fromPreNormalized → bumpRegistryTotals in
//   src/core/driver.ts). The audit ignores those token fields and re-parses the
//   event's `data` payload — the adapter's raw usage object, kept "verbatim for
//   audit" — with extractors owned by this file, preferring the per-model
//   breakdown (claude `models[]`, gemini `models{}`) over the payload's own
//   aggregate. Each event is labeled by how it was re-derived:
//     raw        — this file's extractor parsed `data` (independent path)
//     normalizer — only src/core/normalize.ts recognized `data` (the same
//                  parser the driver uses for `usage_raw` lines)
//     event      — no parseable `data`; fell back to the event's recorded
//                  `usage` fields (re-sums the aggregate, not the parse)
//   Cost is recomputed by pricing each re-derived record with the CURRENT
//   pricing tables (createPricer), so a pricing-table change surfaces as cost
//   drift. A record the pricer cannot price (NaN) makes the run's cost
//   `unpriceable`: reported distinctly, never as a delta or a pass.
import fs from "node:fs";
import { parseArgs } from "node:util";
import { AGENTS, HarnessError, isKnownAgent, type CanonicalTokenRecord } from "../core/types.ts";
import { stateDir as defaultStateDir } from "../core/store.ts";
import { resolveDirFlag } from "./lib.ts";
import { normalizeAuto } from "../core/normalize.ts";
import { createPricer, type Pricer } from "../core/pricing.ts";
import {
  isLive,
  listRunRecords,
  registryDir,
  resolveRawTranscript,
  writeRunRecord,
  type RunRecord,
} from "../core/registry.ts";
import path from "node:path";
import type { ChainStatus } from "../core/hash-chain.ts";
import { verifyRunRecord } from "./verify-run.ts";

export const AUDIT_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "costUsd",
] as const;
export type AuditField = (typeof AUDIT_FIELDS)[number];
type TokenField = Exclude<AuditField, "costUsd">;
const TOKEN_FIELDS: readonly TokenField[] = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"];

/** Absolute slack per field on top of --tolerance-pct: exact for token counts,
 *  float-rounding epsilon for USD. */
export const ABS_EPSILON: Record<AuditField, number> = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 1e-9,
};

export type FieldStatus = "ok" | "drift" | "unpriceable";
export type RunAuditStatus = "ok" | "drift" | "unverifiable";
export type Derivation = "raw" | "normalizer" | "event";

type Nums = Record<AuditField, number>;
type MaybeNums = Record<AuditField, number | null>;

export interface AuditRow {
  runId: string;
  agent: string;
  sessionId?: string;
  /** UTC day of startedAt (same bucketing as `ach stats --json` byDay). */
  day: string;
  startedAt: number;
  status: RunAuditStatus;
  /** Why the run is unverifiable. */
  reason?: string;
  transcript?: string;
  /** Count of usage events per re-derivation path. */
  derivation: Record<Derivation, number>;
  recorded: Nums | null;
  recomputed: MaybeNums | null;
  delta: MaybeNums | null;
  deltaPct: MaybeNums | null;
  fieldStatus: Record<AuditField, FieldStatus> | null;
  /** --fix outcome: fields rewritten, or why the fix was skipped. */
  fixed?: AuditField[];
  fixSkipped?: string;
  /** Hash-chain verdict of the transcript (#59, `ach verify-run`), checked before any --fix. */
  chain?: ChainStatus;
  /** First broken link when chain is "tampered". */
  chainBreak?: string;
}

export interface AuditSummary {
  runs: number;
  ok: number;
  drift: number;
  unverifiable: number;
  costUnpriceable: number;
  fixed: number;
  /** Drifted runs still drifted after --fix (or without it). */
  unresolvedDrift: number;
}

export interface AuditResult {
  tolerancePct: number;
  rows: AuditRow[];
  summary: AuditSummary;
  /** Sums over verifiable rows, stats-compatible field names. */
  total: { recorded: Nums; recomputed: MaybeNums };
}

export interface AuditOptions {
  stateDir: string;
  agent?: string;
  sinceTs?: number;
  tolerancePct?: number;
  fix?: boolean;
  pricer?: Pricer;
  now?: () => number;
}

// ---------------------------------------------------------------- extraction

type Tok = Record<TokenField, number>;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
function n0(v: unknown): number {
  return isNum(v) ? v : 0;
}

/** Raw extractor result. cacheWrite1h is the 1h-TTL subset of
 *  tok.cacheWriteTokens (issue #105), priced at its own rate; absent when the
 *  payload carries no split. */
type RawTokens = { tok: Tok; model?: string; cacheWrite1h?: number };

/** claude adapter usage payload {input, output, cacheRead, cacheWrite,
 *  cacheWrite1h?, models[]} (src/adapters/claude.ts): input is already
 *  uncached. Per-model slices are summed when every one is well-formed;
 *  otherwise the top-level aggregate. The 1h split is record-level (claude's
 *  modelUsage has none), so it is read from the top level either way. */
function fromClaudeHouse(d: Record<string, unknown>): RawTokens | null {
  if (!isNum(d.input) || !isNum(d.output) || !("cacheRead" in d || Array.isArray(d.models))) return null;
  const models = Array.isArray(d.models) ? d.models : [];
  const wellFormed =
    models.length > 0 && models.every((m) => isObj(m) && isNum(m.input) && isNum(m.output));
  const ttl = isNum(d.cacheWrite1h) ? { cacheWrite1h: d.cacheWrite1h } : {};
  if (wellFormed) {
    const tok: Tok = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    for (const m of models as Record<string, unknown>[]) {
      tok.inputTokens += n0(m.input);
      tok.outputTokens += n0(m.output);
      tok.cacheReadTokens += n0(m.cacheRead);
      tok.cacheWriteTokens += n0(m.cacheWrite);
    }
    const first = models[0] as Record<string, unknown>;
    return { tok, ...(models.length === 1 && typeof first.model === "string" ? { model: first.model } : {}), ...ttl };
  }
  return {
    tok: {
      inputTokens: d.input,
      outputTokens: d.output,
      cacheReadTokens: n0(d.cacheRead),
      cacheWriteTokens: n0(d.cacheWrite),
    },
    ...ttl,
  };
}

/** opencode step_finish {tokens:{input, output, cache:{read, write}}, cost}:
 *  input is already uncached (src/adapters/opencode.ts mapTokens). */
function fromOpencode(d: Record<string, unknown>): { tok: Tok } | null {
  const t = d.tokens;
  if (!isObj(t) || !isNum(t.input) || !isNum(t.output)) return null;
  const cache = isObj(t.cache) ? t.cache : {};
  return {
    tok: { inputTokens: t.input, outputTokens: t.output, cacheReadTokens: n0(cache.read), cacheWriteTokens: n0(cache.write) },
  };
}

/** kiro tap / legacy {tokenUsage:{uncachedInputTokens|inputTokens, ...}}. */
function fromKiro(d: Record<string, unknown>): { tok: Tok; model?: string } | null {
  const tu = d.tokenUsage;
  if (!isObj(tu)) return null;
  const input = isNum(tu.inputTokens) ? tu.inputTokens : tu.uncachedInputTokens;
  if (!isNum(input) || !isNum(tu.outputTokens)) return null;
  return {
    tok: {
      inputTokens: input,
      outputTokens: tu.outputTokens,
      cacheReadTokens: n0(isNum(tu.cacheReadTokens) ? tu.cacheReadTokens : tu.cacheReadInputTokens),
      cacheWriteTokens: n0(isNum(tu.cacheWriteTokens) ? tu.cacheWriteTokens : tu.cacheWriteInputTokens),
    },
    ...(typeof d.model === "string" && d.model !== "" ? { model: d.model } : {}),
  };
}

/** gemini flat result.stats {input_tokens (total prompt), input (uncached),
 *  cached, output_tokens, models:{<m>:{...same}}}. Per-model sum preferred. */
function geminiSlice(s: Record<string, unknown>): Tok | null {
  if (!isNum(s.output_tokens)) return null;
  const cached = n0(s.cached);
  const input = isNum(s.input) ? s.input : isNum(s.input_tokens) ? Math.max(0, s.input_tokens - cached) : null;
  if (input === null) return null;
  return { inputTokens: input, outputTokens: s.output_tokens, cacheReadTokens: cached, cacheWriteTokens: 0 };
}
function fromGeminiFlat(d: Record<string, unknown>): { tok: Tok; model?: string } | null {
  if ("cached_input_tokens" in d) return null; // codex
  if (!("cached" in d || "input" in d || isObj(d.models))) return null;
  if (isObj(d.models)) {
    const entries = Object.entries(d.models);
    const slices = entries.map(([, v]) => (isObj(v) ? geminiSlice(v) : null));
    if (entries.length > 0 && slices.every((s) => s !== null)) {
      const tok: Tok = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      for (const s of slices as Tok[]) for (const f of TOKEN_FIELDS) tok[f] += s[f];
      return { tok, ...(entries.length === 1 ? { model: entries[0]![0] } : {}) };
    }
  }
  const tok = geminiSlice(d);
  return tok ? { tok } : null;
}

/** codex turn.completed usage: input_tokens INCLUDES cached_input_tokens. */
function fromCodex(d: Record<string, unknown>): { tok: Tok } | null {
  if (!isNum(d.input_tokens) || !isNum(d.output_tokens)) return null;
  const cached = n0(d.cached_input_tokens);
  return {
    tok: {
      inputTokens: Math.max(0, d.input_tokens - cached),
      outputTokens: d.output_tokens,
      cacheReadTokens: cached,
      cacheWriteTokens: n0(d.cache_write_input_tokens),
    },
  };
}

const RAW_EXTRACTORS: Record<string, (d: Record<string, unknown>) => RawTokens | null> = {
  claude: fromClaudeHouse,
  opencode: fromOpencode,
  kiro: fromKiro,
  gemini: fromGeminiFlat,
  codex: fromCodex,
};

/** The run's own agent first, then every other shape (mock/ACP agent names). */
export function extractRawTokens(agent: string, data: unknown): RawTokens | null {
  if (!isObj(data)) return null;
  const own = RAW_EXTRACTORS[agent];
  const hit = own?.(data);
  if (hit) return hit;
  for (const [name, fn] of Object.entries(RAW_EXTRACTORS)) {
    if (name === agent) continue;
    const r = fn(data);
    if (r) return r;
  }
  return null;
}

// ---------------------------------------------------------------- transcript replay

interface Replay {
  tok: Tok;
  cost: number | null; // null = unpriceable
  derivation: Record<Derivation, number>;
}

function eventTs(v: unknown): number | undefined {
  if (isNum(v)) return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

function replayLines(agent: string, lines: Record<string, unknown>[], pricer: Pricer): Replay {
  const tok: Tok = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const derivation: Record<Derivation, number> = { raw: 0, normalizer: 0, event: 0 };
  let cost: number | null = 0;
  for (const ev of lines) {
    const pre = isObj(ev.usage) ? (ev.usage as Partial<CanonicalTokenRecord> & Record<string, unknown>) : undefined;
    const data = ev.data !== undefined ? ev.data : isObj(pre?.extra) ? (pre!.extra as Record<string, unknown>).raw : undefined;
    let t: Tok | null = null;
    let model: string | undefined;
    let cacheWrite1h: number | undefined;
    let how: Derivation;
    const raw = extractRawTokens(agent, data);
    if (raw) {
      t = raw.tok;
      model = raw.model;
      cacheWrite1h = raw.cacheWrite1h;
      how = "raw";
    } else {
      const norm = data !== undefined ? normalizeAuto(agent, data, 0) : null;
      if (norm) {
        t = {
          inputTokens: norm.inputTokens ?? 0,
          outputTokens: norm.outputTokens ?? 0,
          cacheReadTokens: norm.cacheReadTokens ?? 0,
          cacheWriteTokens: norm.cacheWriteTokens ?? 0,
        };
        model = norm.model;
        cacheWrite1h = norm.cacheWrite1hTokens;
        how = "normalizer";
      } else if (pre) {
        const cached = n0(pre.cachedTokens ?? pre.cacheReadTokens);
        t = {
          inputTokens: isNum(pre.inputTokens) ? pre.inputTokens : Math.max(0, n0(pre.promptTokens) - n0(pre.cachedTokens)),
          outputTokens: isNum(pre.outputTokens) ? pre.outputTokens : n0(pre.completionTokens),
          cacheReadTokens: isNum(pre.cacheReadTokens) ? pre.cacheReadTokens : cached,
          cacheWriteTokens: n0(pre.cacheWriteTokens),
        };
        if (isNum(pre.cacheWrite1hTokens)) cacheWrite1h = pre.cacheWrite1hTokens;
        how = "event";
      } else {
        continue; // nothing the driver would have counted either
      }
    }
    derivation[how]++;
    const extra = isObj(pre?.extra) ? (pre!.extra as Record<string, unknown>) : undefined;
    // Placeholder zeros (kiro 2.21.x): never summed, never priced — the driver
    // rule in bumpRegistryTotals / the pricing branch, mirrored exactly.
    if (extra?.tokensAvailable === false) continue;
    for (const f of TOKEN_FIELDS) tok[f] += t[f];
    if (cost === null) continue;
    const rec: CanonicalTokenRecord = {
      agent,
      model: typeof pre?.model === "string" && pre.model !== "" ? pre.model : (model ?? "unknown"),
      ...t,
      ...(cacheWrite1h !== undefined ? { cacheWrite1hTokens: cacheWrite1h } : {}),
      ...(extra !== undefined || data !== undefined ? { extra: { ...(extra ?? {}), ...(data !== undefined ? { raw: data } : {}) } } : {}),
    };
    const c = pricer.price(rec);
    cost = Number.isNaN(c) ? null : cost + c;
  }
  return { tok, cost, derivation };
}

function readLines(file: string): Record<string, unknown>[] | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const j: unknown = JSON.parse(s);
      if (isObj(j) && (j.type === "usage" || j.type === "usage_raw")) out.push(j);
    } catch {
      /* torn line: skipped, same as every other reader */
    }
  }
  return out;
}

// ---------------------------------------------------------------- audit

function withinTolerance(field: AuditField, recorded: number, recomputed: number, pct: number): boolean {
  const d = Math.abs(recorded - recomputed);
  if (d <= ABS_EPSILON[field]) return true;
  return pct > 0 && d <= (pct / 100) * Math.abs(recomputed);
}

function emptyNums(): Nums {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
}

export function auditRuns(opts: AuditOptions): AuditResult {
  const pct = opts.tolerancePct ?? 0;
  const pricer = opts.pricer ?? createPricer();
  const now = opts.now ?? Date.now;
  const all = listRunRecords(opts.stateDir);

  // A resumed session appends to the same <agent>-<session>.jsonl, so several
  // records can share one transcript: each owns [startedAt, next startedAt).
  const owners = new Map<string, RunRecord[]>();
  for (const r of all) {
    const t = resolveRawTranscript(opts.stateDir, r);
    if (!t) continue;
    owners.set(t, [...(owners.get(t) ?? []), r]);
  }
  for (const list of owners.values()) list.sort((a, b) => a.startedAt - b.startedAt);
  const lineCache = new Map<string, Record<string, unknown>[] | null>();

  const rows: AuditRow[] = [];
  const total = { recorded: emptyNums(), recomputed: emptyNums() as MaybeNums };
  const summary: AuditSummary = { runs: 0, ok: 0, drift: 0, unverifiable: 0, costUnpriceable: 0, fixed: 0, unresolvedDrift: 0 };

  const selected = all
    .filter((r) => (opts.agent ? r.agent === opts.agent : true))
    .filter((r) => (opts.sinceTs !== undefined ? r.startedAt >= opts.sinceTs : true))
    .sort((a, b) => a.startedAt - b.startedAt);

  for (const rec of selected) {
    const base = {
      runId: rec.runId,
      agent: rec.agent,
      ...(rec.sessionId !== undefined ? { sessionId: rec.sessionId } : {}),
      day: new Date(rec.startedAt).toISOString().slice(0, 10),
      startedAt: rec.startedAt,
      derivation: { raw: 0, normalizer: 0, event: 0 },
    };
    summary.runs++;
    const unverifiable = (reason: string, transcript?: string): void => {
      summary.unverifiable++;
      rows.push({
        ...base,
        status: "unverifiable",
        reason,
        ...(transcript ? { transcript } : {}),
        recorded: null,
        recomputed: null,
        delta: null,
        deltaPct: null,
        fieldStatus: null,
      });
    };
    if (!rec.totals) {
      unverifiable("no recorded totals");
      continue;
    }
    const transcript = resolveRawTranscript(opts.stateDir, rec);
    if (!transcript) {
      unverifiable(
        rec.source === "imported"
          ? "imported record (transcript history, not an ach run)"
          : "no raw transcript path (external record)",
      );
      continue;
    }
    if (!lineCache.has(transcript)) lineCache.set(transcript, readLines(transcript));
    const lines = lineCache.get(transcript);
    if (!lines) {
      unverifiable("raw transcript missing", transcript);
      continue;
    }
    const peers = owners.get(transcript) ?? [rec];
    let mine = lines;
    if (peers.length > 1) {
      const i = peers.findIndex((p) => p.runId === rec.runId);
      const lo = rec.startedAt;
      const hi = peers[i + 1]?.startedAt ?? Infinity;
      mine = lines.filter((l) => {
        const ts = eventTs(l.timestamp);
        return ts !== undefined && ts >= lo && ts < hi;
      });
    }
    const replay = replayLines(rec.agent, mine, pricer);

    const recorded: Nums = {
      inputTokens: rec.totals.inputTokens,
      outputTokens: rec.totals.outputTokens,
      cacheReadTokens: rec.totals.cacheReadTokens,
      cacheWriteTokens: rec.totals.cacheWriteTokens,
      costUsd: rec.totals.costUsd,
    };
    const recomputed: MaybeNums = { ...replay.tok, costUsd: replay.cost };
    const delta = {} as MaybeNums;
    const deltaPct = {} as MaybeNums;
    const fieldStatus = {} as Record<AuditField, FieldStatus>;
    for (const f of AUDIT_FIELDS) {
      const rc = recomputed[f];
      if (rc === null) {
        delta[f] = null;
        deltaPct[f] = null;
        fieldStatus[f] = "unpriceable";
        continue;
      }
      const d = recorded[f] - rc;
      delta[f] = d;
      deltaPct[f] = rc === 0 ? (d === 0 ? 0 : null) : (d / rc) * 100;
      fieldStatus[f] = withinTolerance(f, recorded[f], rc, pct) ? "ok" : "drift";
    }
    const drifted = AUDIT_FIELDS.filter((f) => fieldStatus[f] === "drift");
    if (fieldStatus.costUsd === "unpriceable") summary.costUnpriceable++;
    // #59: audit proves the totals follow from the log; the chain proves the
    // log (and the sealed totals) were not edited. One sha256 pass per run,
    // taken BEFORE --fix so the verdict describes the record as found.
    const chain = verifyRunRecord(opts.stateDir, rec);
    const row: AuditRow = {
      ...base,
      derivation: replay.derivation,
      status: drifted.length > 0 ? "drift" : "ok",
      transcript,
      recorded,
      recomputed,
      delta,
      deltaPct,
      fieldStatus,
      chain: chain.status,
      ...(chain.firstBad ? { chainBreak: `line ${chain.firstBad.line}: ${chain.firstBad.reason}` } : {}),
    };
    for (const f of AUDIT_FIELDS) {
      total.recorded[f] += recorded[f];
      const rc = recomputed[f];
      total.recomputed[f] = rc === null || total.recomputed[f] === null ? null : (total.recomputed[f] as number) + rc;
    }
    if (drifted.length > 0) {
      summary.drift++;
      if (opts.fix) {
        const outcome = applyFix(opts.stateDir, rec, drifted, recomputed, now());
        if (outcome.ok) {
          row.fixed = drifted;
          summary.fixed++;
        } else {
          row.fixSkipped = outcome.reason;
          summary.unresolvedDrift++;
        }
      } else {
        summary.unresolvedDrift++;
      }
    } else {
      summary.ok++;
    }
    rows.push(row);
  }
  return { tolerancePct: pct, rows, summary, total };
}

/**
 * Rewrite the drifted totals from the recomputed values and append one
 * `corrections` entry per rewritten field. Patches the ON-DISK JSON (not the
 * zod-parsed record) so no defaulted field is silently added.
 */
function applyFix(
  stateDir: string,
  rec: RunRecord,
  fields: AuditField[],
  recomputed: MaybeNums,
  at: number,
): { ok: true } | { ok: false; reason: string } {
  if (isLive(rec)) return { ok: false, reason: "run is live (the driver would overwrite the fix)" };
  const file = path.join(registryDir(stateDir), `${rec.runId}.json`);
  let doc: Record<string, unknown>;
  try {
    const j: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isObj(j) || !isObj(j.totals)) return { ok: false, reason: "record unreadable" };
    doc = j;
  } catch (err) {
    return { ok: false, reason: `record unreadable (${err instanceof Error ? err.message : String(err)})` };
  }
  const totals = doc.totals as Record<string, unknown>;
  const corrections: Array<Record<string, unknown>> = Array.isArray(doc.corrections) ? [...doc.corrections] : [];
  for (const f of fields) {
    const to = recomputed[f];
    if (to === null) continue; // unpriceable is never "drift"; defensive
    corrections.push({ at, field: `totals.${f}`, from: totals[f], to, by: "ach audit --fix" });
    totals[f] = to;
    // RunRecord.usage.usd.value mirrors totals.costUsd; keep the mirror honest.
    if (f === "costUsd") {
      const usd = isObj(doc.usage) && isObj(doc.usage.usd) ? doc.usage.usd : undefined;
      if (usd && isNum(usd.value)) {
        corrections.push({ at, field: "usage.usd.value", from: usd.value, to, by: "ach audit --fix" });
        usd.value = to;
      }
    }
  }
  doc.corrections = corrections;
  try {
    writeRunRecord(stateDir, doc as unknown as RunRecord);
  } catch (err) {
    return { ok: false, reason: `write failed (${err instanceof Error ? err.message : String(err)})` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------- CLI

export const AUDIT_USAGE = `ach audit [--agent A] [--days N] [--json] [--tolerance-pct P] [--fix] [--state-dir <stateDir>]
  (--dir is an alias of --state-dir.)
  Re-derives each RunRecord's totals (input/output/cacheRead/cacheWrite tokens
  and costUsd, <stateDir>/runs/*.json) from the run's raw transcript
  (<stateDir>/raw/<agent>-<session>.jsonl): tokens re-parsed from each usage
  event's raw payload, not the adapter's pre-normalized record; cost re-priced
  with the current pricing tables. Canonical raw/<agent>/ records carry no
  recorded aggregate and are not audited.
  --tolerance-pct P  allowed |recorded - recomputed| as % of recomputed
                     (default 0: exact tokens, 1e-9 USD rounding slack)
  --fix              rewrite drifted totals and append RunRecord.corrections
  exit 0: no unresolved drift · 1: drift. Unverifiable runs (no totals, no or
  missing transcript) and unpriceable costs are reported, not failed.`;

function optNum(v: string | undefined, flag: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) {
    throw new HarnessError(`${flag} expects a non-negative number, got '${v}'`, "USAGE");
  }
  return n;
}

function fmt(f: AuditField, v: number | null): string {
  if (v === null) return "n/a";
  return f === "costUsd" ? `$${v.toFixed(6)}` : String(v);
}

function fmtDelta(f: AuditField, d: number | null, pct: number | null): string {
  if (d === null) return "n/a";
  const sign = d > 0 ? "+" : d < 0 ? "-" : "±";
  const abs = f === "costUsd" ? `$${Math.abs(d).toFixed(6)}` : String(Math.abs(d));
  return `Δ ${sign}${abs}${pct === null ? "" : `, ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`}`;
}

export function formatAuditText(res: AuditResult): string {
  const out: string[] = [];
  for (const r of res.rows) {
    const head = `${r.runId}  ${r.agent.padEnd(8)} ${r.day}  ${r.status.toUpperCase()}`;
    if (r.status === "unverifiable") {
      out.push(`${head}  (${r.reason})`);
      continue;
    }
    const via = (Object.entries(r.derivation) as [Derivation, number][])
      .filter(([, c]) => c > 0)
      .map(([k, c]) => `${k}=${c}`)
      .join(" ");
    const tags = [
      via ? `via ${via}` : "no usage events",
      r.fieldStatus?.costUsd === "unpriceable" ? "cost unpriceable" : "",
      r.fixed ? `fixed: ${r.fixed.join(",")}` : "",
      r.fixSkipped ? `fix skipped: ${r.fixSkipped}` : "",
      r.chain ? `chain ${r.chain === "tampered" ? `TAMPERED (${r.chainBreak ?? "broken"})` : r.chain}` : "",
    ].filter(Boolean);
    out.push(`${head}  (${tags.join("; ")})`);
    for (const f of AUDIT_FIELDS) {
      const st = r.fieldStatus![f];
      if (st === "ok") continue;
      if (st === "unpriceable") {
        out.push(`  ${f}: ${fmt(f, r.recorded![f])} vs n/a (unpriceable model; cannot recompute)`);
        continue;
      }
      out.push(`  ${f}: ${fmt(f, r.recorded![f])} vs ${fmt(f, r.recomputed![f])} (${fmtDelta(f, r.delta![f], r.deltaPct![f])})`);
    }
  }
  const s = res.summary;
  out.push(
    `audited ${s.runs} run(s) at tolerance ${res.tolerancePct}%: ok=${s.ok} drift=${s.drift} unverifiable=${s.unverifiable} cost-unpriceable=${s.costUnpriceable}` +
      (s.fixed > 0 ? ` fixed=${s.fixed}` : "") +
      ` → ${s.unresolvedDrift === 0 ? "PASS" : "FAIL"}`,
  );
  return out.join("\n") + "\n";
}

export async function cmdAudit(rest: string[]): Promise<number> {
  const args = parseArgs({
    args: rest,
    options: {
      agent: { type: "string" },
      days: { type: "string" },
      json: { type: "boolean", default: false },
      "tolerance-pct": { type: "string" },
      fix: { type: "boolean", default: false },
      dir: { type: "string" },
      "state-dir": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });
  if (args.values.help) {
    process.stdout.write(AUDIT_USAGE + "\n");
    return 0;
  }
  const stateDirFlag = resolveDirFlag(args.values, "state-dir");
  const agent = args.values.agent;
  if (agent && !isKnownAgent(agent)) {
    throw new HarnessError(`unknown agent '${agent}' (expected one of: ${AGENTS.join(", ")})`, "UNKNOWN_AGENT");
  }
  const days = optNum(args.values.days, "--days");
  const tolerancePct = optNum(args.values["tolerance-pct"], "--tolerance-pct") ?? 0;
  const pricer = createPricer();
  const res = auditRuns({
    stateDir: stateDirFlag ?? defaultStateDir(),
    ...(agent ? { agent } : {}),
    ...(days !== undefined ? { sinceTs: Date.now() - days * 86_400_000 } : {}),
    tolerancePct,
    fix: args.values.fix,
    pricer,
  });
  for (const w of new Set(pricer.drainWarnings())) process.stderr.write(`[warn] ${w}\n`);
  process.stdout.write(args.values.json ? JSON.stringify(res, null, 2) + "\n" : formatAuditText(res));
  return res.summary.unresolvedDrift === 0 ? 0 : 1;
}
