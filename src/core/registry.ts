// Run registry: one JSON file per run under <stateDir>/runs/.
//
// The driver records run lifecycle here so `ach dash` can show live + recent
// runs. Writes are atomic (tmp+rename, sync — called on hot event paths);
// reads are tolerant: a corrupt or partial file is skipped, never thrown.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  KiroEffectiveSchema,
  UsageAvailabilitySchema,
  type KiroEffective,
  type UsageAvailability,
} from "./types.ts";

// Fields marked LOCAL-PROCESS-ONLY are optional so an external producer's
// record (source:"external") validates without inventing a local pid, cwd, or
// transcript path; the driver always fills them for local runs.
export interface RunRecord {
  runId: string; // driver-generated uuid
  agent: string; // 'claude' | 'kiro' | ...
  sessionId?: string; // set once the adapter reports it
  pid?: number; // harness CLI process pid (LOCAL-PROCESS-ONLY)
  cwd?: string;
  promptPreview?: string; // first 120 chars of prompt
  startedAt: number; // ms epoch
  updatedAt?: number; // ms epoch — heartbeat
  status?: "running" | "interrupted" | "success" | "error" | "aborted"; // 'interrupted' is derived (effectiveStatus), never written to disk
  exitStatus?: string; // final RunResult.exitStatus
  totals?: {
    // running aggregates, updated per usage event
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
    credits?: number;
    /** Latest DERIVED context-window occupancy (not billed tokens). */
    contextTokens?: number;
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
  source?: "local" | "external"; // external records carry no local pid to probe
  producer?: string; // e.g. "acme-feed/bridge@1"
  endedAt?: number; // ms epoch — explicit wall-clock end for external runs
  metadata?: Record<string, unknown>; // free-form provenance (request_id, region, ...)
}

const TotalsSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  costUsd: z.number(),
  credits: z.number().optional(),
  contextTokens: z.number().optional(),
});

export const RunRecordSchema = z.object({
  runId: z.string(),
  agent: z.string(),
  sessionId: z.string().optional(),
  pid: z.number().int().optional(),
  cwd: z.string().optional(),
  promptPreview: z.string().optional(),
  startedAt: z.number(),
  updatedAt: z.number().optional(),
  status: z.enum(["running", "interrupted", "success", "error", "aborted"]).optional(),
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
  source: z.enum(["local", "external"]).default("local"),
  producer: z.string().min(1).optional(),
  endedAt: z.number().int().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
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

function parseRunRecord(text: string): RunRecord | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = RunRecordSchema.safeParse(json);
  return parsed.success ? (parsed.data as RunRecord) : null;
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
 * are never rewritten; when neither file exists the stored path comes back
 * unchanged so callers keep their existing "missing → empty" behaviour.
 */
export function resolveRawTranscript(stateDir: string, rec: RunRecord): string {
  const stored = rec.rawTranscript;
  if (stored === undefined) return ""; // external records carry no transcript path
  if (fs.existsSync(stored)) return stored;
  const relocated = path.join(stateDir, "raw", path.basename(stored));
  if (fs.existsSync(relocated)) return relocated;
  return stored;
}

export function listRunRecords(stateDir: string): RunRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(registryDir(stateDir));
  } catch {
    return [];
  }
  const out: RunRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let text: string;
    try {
      text = fs.readFileSync(path.join(registryDir(stateDir), name), "utf8");
    } catch {
      continue;
    }
    const rec = parseRunRecord(text);
    if (rec) out.push(rec);
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

/** Spec public-API helper: just the runIds of listRunRecords, newest first. */
export function listRunIds(stateDir: string): string[] {
  return listRunRecords(stateDir).map((r) => r.runId);
}

/** Live = still running, heartbeat fresh (<=15s), and the pid answers kill(pid, 0). */
export function isLive(rec: RunRecord, now: number = Date.now()): boolean {
  if (rec.source === "external") return false;
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
export function effectiveStatus(rec: RunRecord, now: number = Date.now()): RunRecord["status"] {
  if (rec.status !== "running") return rec.status;
  return isLive(rec, now) ? "running" : "interrupted";
}
