// Run registry: one JSON file per run under <stateDir>/runs/.
//
// The driver records run lifecycle here so `agh dash` can show live + recent
// runs. Writes are atomic (tmp+rename, sync — called on hot event paths);
// reads are tolerant: a corrupt or partial file is skipped, never thrown.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

export interface RunRecord {
  runId: string; // driver-generated uuid
  agent: string; // 'claude' | 'kiro' | ...
  sessionId?: string; // set once the adapter reports it
  pid: number; // harness CLI process pid
  cwd: string;
  promptPreview: string; // first 120 chars of prompt
  startedAt: number; // ms epoch
  updatedAt: number; // ms epoch — heartbeat
  status: "running" | "interrupted" | "success" | "error" | "aborted"; // 'interrupted' is derived (effectiveStatus), never written to disk
  exitStatus?: string; // final RunResult.exitStatus
  totals: {
    // running aggregates, updated per usage event
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
    credits?: number;
  };
  lastEvent?: string; // one-line preview of the latest event
  rawTranscript: string; // absolute path to <stateDir>/raw/<agent>-<session>.jsonl
}

const TotalsSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  costUsd: z.number(),
  credits: z.number().optional(),
});

const RunRecordSchema = z.object({
  runId: z.string(),
  agent: z.string(),
  sessionId: z.string().optional(),
  pid: z.number().int(),
  cwd: z.string(),
  promptPreview: z.string(),
  startedAt: z.number(),
  updatedAt: z.number(),
  status: z.enum(["running", "interrupted", "success", "error", "aborted"]),
  exitStatus: z.string().optional(),
  totals: TotalsSchema,
  lastEvent: z.string().optional(),
  rawTranscript: z.string(),
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

/** Live = still running, heartbeat fresh (<=15s), and the pid answers kill(pid, 0). */
export function isLive(rec: RunRecord, now: number = Date.now()): boolean {
  if (rec.status !== "running") return false;
  if (now - rec.updatedAt > 15_000) return false;
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
