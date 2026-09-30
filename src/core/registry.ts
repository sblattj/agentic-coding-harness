// Run registry: one JSON file per run under <stateDir>/runs/.
//
// The driver records run lifecycle here so `ach dash` can show live + recent
// runs. Writes are atomic (tmp+rename, sync — called on hot event paths);
// reads are tolerant: a corrupt or partial file is skipped, never thrown.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { findArchivedRaw } from "./warehouse-index.ts";
import {
  KiroEffectiveSchema,
  UsageAvailabilitySchema,
  type KiroEffective,
  type UsageAvailability,
} from "./types.ts";
import { VerifyResultSchema, type VerifyResult } from "./verify.ts";
import { PROVENANCE_CLASSES, type ProvenanceMap } from "./provenance.ts";
import type { RunSeal } from "./hash-chain.ts";

// Fields marked LOCAL-PROCESS-ONLY are optional so an external producer's
// record (source:"external") validates without inventing a local pid, cwd, or
// transcript path; the driver always fills them for local runs.
export interface RunRecord {
  runId: string; // driver-generated uuid
  agent: string; // 'claude' | 'kiro' | ...
  sessionId?: string; // set once the adapter reports it
  pid?: number; // harness CLI process pid (LOCAL-PROCESS-ONLY)
  cwd?: string;
  branch?: string; // git branch of cwd at run start (#47); absent when detached or not a repo
  commit?: string; // short HEAD sha at run start (#47); the only marker of a detached HEAD
  promptPreview?: string; // first 120 chars of prompt
  startedAt: number; // ms epoch
  updatedAt?: number; // ms epoch — heartbeat
  status?: "running" | "interrupted" | "success" | "error" | "aborted" | "unavailable"; // 'unavailable': CLI/service outage, no task verdict (#60); 'interrupted' is derived (effectiveStatus), never written to disk
  exitStatus?: string; // final RunResult.exitStatus
  totals?: {
    // running aggregates, updated per usage event
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
    /** Which cost path fed costUsd (issue #28); absent when both or neither did. */
    costSource?: "reported" | "computed";
    credits?: number;
    /** Latest DERIVED context-window occupancy (not billed tokens). */
    contextTokens?: number;
    /** Per-field provenance (issue #33): reported | computed | estimated; a lane with no entry is n/a. */
    provenance?: ProvenanceMap;
  };
  lastEvent?: string; // one-line preview of the latest event
  rawTranscript?: string; // absolute path to <stateDir>/raw/<agent>-<session>.jsonl (LOCAL-PROCESS-ONLY)
  /** Dashboard mirror of RunResult.kiro (kiro runs only). */
  kiro?: Pick<KiroEffective, "transport" | "modelAck" | "nativeSessionId" | "cliVersion">;
  /** Dashboard mirror of RunResult.usage. */
  usage?: UsageAvailability;
  // --- public run-record contract (0.9.0): provenance + labeling ---
  experiment?: string; // compare-view grouping label
  variant?: string; // compare-view variant within an experiment
  workflow?: string; // e.g. "implement" | "review" | "plan"
  source?: "local" | "external" | "imported"; // external/imported records carry no local pid to probe; imported = `ach import` (#25)
  producer?: string; // e.g. "acme-feed/bridge@1"
  endedAt?: number; // ms epoch — explicit wall-clock end for external runs
  metadata?: Record<string, unknown>; // free-form provenance (request_id, region, ...)
  /** Additive audit trail: one entry per aggregate `ach audit --fix` rewrote. */
  corrections?: RunCorrection[];
  /** Threshold crossings fired during the run (#20), oldest first; dash banner + web. */
  alerts?: RunAlert[];
  // --- custom agents (#37/#38); absent on built-in adapter runs ---
  metering?: "tap" | "none"; // "none": no usage source — tokens/cost are n/a, not 0
  command?: string[]; // resolved argv, prompt redacted as <prompt:N chars>
  // --- outcome scoring + repeat trials (0.11.0, #29/#57/#89) ---
  /** Post-run checker verdict (`ach run --verify`); absent when no checker ran. */
  verify?: VerifyResult;
  /** `ach run --repeat N` membership: shared group id, 0-based index, group size. */
  repeat?: RepeatMembership;
  /** Later `ach regrade` verdicts, oldest first; `verify` is never rewritten. */
  regrades?: VerifyResult[];
  /** Latency metrics (#32) derived at finalize from the run's events (deriveLatency). */
  latency?: RunLatency;
  /** Terminal seal of the raw transcript's hash chain (#59); `ach verify-run` anchor. */
  seal?: RunSeal;
}

/** Shape of src/core/latency.ts LatencyMetrics; null = not measurable from the log. */
export type RunLatency = z.infer<typeof RunLatencySchema>;

export interface RepeatMembership {
  group: string;
  index: number;
  count: number;
}

/** One fired budget alert / near-limit warning (mirror of a budget.alert event). */
export interface RunAlert {
  at: number; // ms epoch
  family: "budget" | "near-limit";
  metric: "usd" | "turns" | "wall" | "context";
  threshold: number; // fraction in (0, 1]
  value: number; // observed value (usd | turns | ms | context percentage points)
  limit: number; // the cap it is a fraction of
}

export interface RunCorrection {
  at: number; // ms epoch
  field: string; // e.g. "totals.cacheReadTokens" | "usage.usd.value"
  from: number;
  to: number;
  by?: string; // e.g. "ach audit --fix"
}

const RunCorrectionSchema = z.object({
  at: z.number(),
  field: z.string().min(1),
  from: z.number(),
  to: z.number(),
  by: z.string().optional(),
});

const DurationStatsSchema = z.object({
  count: z.number(),
  totalMs: z.number(),
  avgMs: z.number(),
  p50Ms: z.number(),
  p95Ms: z.number(),
  maxMs: z.number(),
});

export const RunLatencySchema = z.object({
  ttft: DurationStatsSchema.nullable(),
  modelCalls: DurationStatsSchema.nullable(),
  outputTokensPerSec: z.number().nullable(),
  tpotMs: z.number().nullable(),
  tools: z.array(DurationStatsSchema.extend({ name: z.string(), errors: z.number() })),
});

const TotalsSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  costUsd: z.number(),
  costSource: z.enum(["reported", "computed"]).optional(),
  credits: z.number().optional(),
  contextTokens: z.number().optional(),
  provenance: z.record(z.string(), z.enum(PROVENANCE_CLASSES)).optional(),
});

export const RunRecordSchema = z.object({
  runId: z.string(),
  agent: z.string(),
  sessionId: z.string().optional(),
  pid: z.number().int().optional(),
  cwd: z.string().optional(),
  branch: z.string().optional(),
  commit: z.string().optional(),
  promptPreview: z.string().optional(),
  startedAt: z.number(),
  updatedAt: z.number().optional(),
  status: z.enum(["running", "interrupted", "success", "error", "aborted", "unavailable"]).optional(),
  exitStatus: z.string().optional(),
  totals: TotalsSchema.optional(),
  lastEvent: z.string().optional(),
  rawTranscript: z.string().optional(),
  kiro: KiroEffectiveSchema.pick({
    transport: true,
    modelAck: true,
    nativeSessionId: true,
    cliVersion: true,
  }).optional(),
  usage: UsageAvailabilitySchema.optional(),
  experiment: z.string().min(1).optional(),
  variant: z.string().min(1).optional(),
  workflow: z.string().min(1).optional(),
  source: z.enum(["local", "external", "imported"]).default("local"),
  producer: z.string().min(1).optional(),
  endedAt: z.number().int().optional(),
  metering: z.enum(["tap", "none"]).optional(),
  command: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  corrections: z.array(RunCorrectionSchema).optional(),
  alerts: z
    .array(
      z.object({
        at: z.number(),
        family: z.enum(["budget", "near-limit"]),
        metric: z.enum(["usd", "turns", "wall", "context"]),
        threshold: z.number(),
        value: z.number(),
        limit: z.number(),
      }),
    )
    .optional(),
  verify: VerifyResultSchema.optional(),
  repeat: z
    .object({ group: z.string().min(1), index: z.number().int().min(0), count: z.number().int().min(1) })
    .optional(),
  regrades: z.array(VerifyResultSchema).optional(),
  latency: RunLatencySchema.optional(),
  seal: z
    .object({
      v: z.literal(1),
      algo: z.literal("sha256"),
      eventCount: z.number().int().min(0),
      lastHash: z.string().regex(/^[0-9a-f]{64}$/),
      sealHash: z.string().regex(/^[0-9a-f]{64}$/),
      totalsHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
      at: z.number(),
    })
    .optional(),
});

export function registryDir(stateDir: string): string {
  return path.join(stateDir, "runs");
}

/** Atomic write: <runId>.json.tmp-<pid> then rename. */
export function writeRunRecord(stateDir: string, rec: RunRecord): void {
  const dir = registryDir(stateDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${rec.runId}.json`);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
  fs.renameSync(tmp, file);
}

function isErrnoException(e: unknown): e is NodeJS.ErrnoException {
  return typeof e === "object" && e !== null && "code" in e;
}

type ParsedRunRecord = { ok: true; record: RunRecord } | { ok: false; reason: string };

function parseRunRecordDetailed(text: string): ParsedRunRecord {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  const parsed = RunRecordSchema.safeParse(json);
  if (parsed.success) return { ok: true, record: parsed.data as RunRecord };
  const issue = parsed.error.issues[0];
  const where = issue && issue.path.length > 0 ? issue.path.join(".") : "(root)";
  return { ok: false, reason: `schema: ${where}: ${issue?.message ?? "invalid"}` };
}

function parseRunRecord(text: string): RunRecord | null {
  const r = parseRunRecordDetailed(text);
  return r.ok ? r.record : null;
}

export function readRunRecord(stateDir: string, runId: string): RunRecord | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(registryDir(stateDir), `${runId}.json`), "utf8");
  } catch {
    return null;
  }
  return parseRunRecord(text);
}

/**
 * Resolve a record's transcript path, tolerating a state dir that moved.
 *
 * Records store an ABSOLUTE `rawTranscript` written at run time, so every run
 * predating commit 77cf64e (`~/.agent-harness` → `~/.agentic-coding-harness`)
 * still points at a directory that no longer exists. When the stored path is
 * gone but a file of the same basename sits under the CURRENT
 * `<stateDir>/raw/`, that relocated path is returned instead. Records on disk
 * are never rewritten. When neither exists but `ach archive` snapshotted the
 * file into <stateDir>/warehouse, the newest archived copy is returned. When
 * none of those exist the stored path comes back
 * unchanged so callers keep their existing "missing → empty" behaviour.
 */
export function resolveRawTranscript(stateDir: string, rec: RunRecord): string {
  const stored = rec.rawTranscript;
  if (stored === undefined) return ""; // external records carry no transcript path
  if (fs.existsSync(stored)) return stored;
  const relocated = path.join(stateDir, "raw", path.basename(stored));
  if (fs.existsSync(relocated)) return relocated;
  // #79: the live file was pruned — fall back to the newest `ach archive` copy.
  return findArchivedRaw(stateDir, path.basename(stored)) ?? stored;
}

/** A `<stateDir>/runs/*.json` file that could not be parsed as a RunRecord. */
export interface SkippedRunRecord {
  file: string;
  reason: string;
}

/**
 * Every parseable run record (newest first) plus the files that were not.
 * A file that is not JSON or fails the schema is COUNTED in `skipped` so
 * callers can surface it — never dropped silently. A file that disappears
 * between readdir and read (the atomic-rename / prune race) is not a
 * malformed record and is ignored, as before.
 */
export function scanRunRecords(stateDir: string): { records: RunRecord[]; skipped: SkippedRunRecord[] } {
  let names: string[];
  try {
    names = fs.readdirSync(registryDir(stateDir));
  } catch {
    return { records: [], skipped: [] };
  }
  const records: RunRecord[] = [];
  const skipped: SkippedRunRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let text: string;
    try {
      text = fs.readFileSync(path.join(registryDir(stateDir), name), "utf8");
    } catch {
      continue;
    }
    const r = parseRunRecordDetailed(text);
    if (r.ok) records.push(r.record);
    else skipped.push({ file: name, reason: r.reason });
  }
  records.sort((a, b) => b.startedAt - a.startedAt);
  return { records, skipped };
}

/** One stderr-ready warning line for skipped records, or null when none were skipped. */
export function skippedRunRecordsWarning(stateDir: string, skipped: readonly SkippedRunRecord[]): string | null {
  if (skipped.length === 0) return null;
  const MAX = 3;
  const shown = skipped.slice(0, MAX).map((s) => `${s.file} (${s.reason})`).join("; ");
  const more = skipped.length > MAX ? `; +${skipped.length - MAX} more` : "";
  return `[warn] registry: skipped ${skipped.length} unreadable run record(s) in ${registryDir(stateDir)}: ${shown}${more}`;
}

export function listRunRecords(stateDir: string): RunRecord[] {
  return scanRunRecords(stateDir).records;
}

/** Spec public-API helper: just the runIds of listRunRecords, newest first. */
export function listRunIds(stateDir: string): string[] {
  return listRunRecords(stateDir).map((r) => r.runId);
}

/** Live = still running, heartbeat fresh (<=15s), and the pid answers kill(pid, 0). */
export function isLive(rec: RunRecord, now: number = Date.now()): boolean {
  if (rec.source === "external" || rec.source === "imported") return false;
  if (rec.pid === undefined) return false;
  if (rec.status !== "running") return false;
  if (rec.updatedAt === undefined || now - rec.updatedAt > 15_000) return false;
  try {
    process.kill(rec.pid, 0);
  } catch (e) {
    if (isErrnoException(e) && e.code === "ESRCH") return false;
  }
  return true;
}

/** Consumer view of status: a `running` record whose process is gone (dead
 *  pid or stale heartbeat — see isLive) reports `interrupted` without the
 *  file being mutated; terminal states pass through unchanged. */
export function effectiveStatus(rec: RunRecord, now: number = Date.now()): NonNullable<RunRecord["status"]> {
  // A record with no status at all (external producer) is never "running":
  // it reports interrupted, same derived verdict as a dead local process.
  if (rec.status === undefined) return "interrupted";
  if (rec.status !== "running") return rec.status;
  return isLive(rec, now) ? "running" : "interrupted";
}
