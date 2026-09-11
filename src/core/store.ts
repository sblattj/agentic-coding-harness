// CLI-side persistence over the harness state dir.
//
// Two transcript layouts are read, both as JSONL under <stateDir>/raw/:
//  - canonical record lines: {ts, agent, sessionId, model, inputTokens, ...}
//    (written by `harness watch`; one file per agent/session)
//  - driver NDJSON event lines: {type:'usage_raw'|'usage', ...} written by
//    src/core/driver.ts as <stateDir>/raw/<agent>-<sessionId>.jsonl
// plus offsets.json for `harness watch` growth tracking.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { normalizeAuto } from "./normalize.js";
import type { CanonicalTokenRecord } from "./types.js";

const OFFSETS_VERSION = 1;
export type OffsetMap = { v: number; files: Record<string, number> };

/** Root state dir. Override with AGENT_HARNESS_STATE_DIR (tests, sandboxes). */
export function stateDir(): string {
  return (
    process.env.AGENT_HARNESS_STATE_DIR || path.join(os.homedir(), ".agent-harness")
  );
}

export function offsetsFile(): string {
  return path.join(stateDir(), "offsets.json");
}

export async function loadOffsets(): Promise<OffsetMap> {
  try {
    const raw = JSON.parse(await fs.readFile(offsetsFile(), "utf8"));
    if (raw && typeof raw === "object" && raw.files && typeof raw.files === "object") {
      return { v: OFFSETS_VERSION, files: raw.files as Record<string, number> };
    }
  } catch {
    /* first run */
  }
  return { v: OFFSETS_VERSION, files: {} };
}

export async function saveOffsets(map: OffsetMap): Promise<void> {
  await fs.mkdir(path.dirname(offsetsFile()), { recursive: true });
  await fs.writeFile(offsetsFile(), JSON.stringify({ ...map, v: OFFSETS_VERSION }, null, 2));
}

export function sanitizeSession(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** Canonical records live at <stateDir>/raw/<agent>/<sessionId>.jsonl */
export function recordPath(agent: string, sessionId: string): string {
  return path.join(stateDir(), "raw", agent, `${sanitizeSession(sessionId)}.jsonl`);
}

// ---------------------------------------------------------------- writing

async function appendJsonl(file: string, lines: string[]): Promise<void> {
  if (lines.length === 0) return;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const fh = await fs.open(file, "a");
  try {
    await fh.write(lines.join("\n") + "\n");
  } finally {
    await fh.close();
  }
}

/**
 * Append canonical records to their per-session raw file so `harness stats`
 * accumulates history across watch ticks.
 */
export async function appendRecords(records: CanonicalTokenRecord[]): Promise<void> {
  const byFile = new Map<string, CanonicalTokenRecord[]>();
  for (const r of records) {
    const agent = r.agent ?? "unknown";
    const sessionId = r.sessionId ?? "unknown";
    const f = recordPath(agent, sessionId);
    const list = byFile.get(f);
    if (list) list.push(r);
    else byFile.set(f, [r]);
  }
  await Promise.all(
    [...byFile].map(([f, rs]) => appendJsonl(f, rs.map((r) => JSON.stringify(r)))),
  );
}

// ---------------------------------------------------------------- reading

/** One internal aggregation row (ts normalized to ISO, fields defaulted). */
export interface StatRecord extends CanonicalTokenRecord {
  ts: string; // ISO-8601
  /** Always resolved by the time a record is stored (fallbacks fill "unknown"). */
  agent: string;
}

const RecordLineSchema = z
  .object({
    ts: z.union([z.string(), z.number()]).optional(),
    timestamp: z.union([z.string(), z.number()]).optional(),
    agent: z.string().optional(),
    sessionId: z.string().nullish(),
    model: z.string().nullish(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadTokens: z.number().default(0),
    cacheWriteTokens: z.number().default(0),
    reasoningTokens: z.number().default(0),
    costUsd: z.number().default(0),
    extra: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

function isoTs(v: string | number | undefined): string {
  if (typeof v === "number") return new Date(v).toISOString();
  if (typeof v === "string") {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

/**
 * Agent attribution fallbacks, in order: record's own agent field, then the
 * directory under raw/ (raw/<agent>/<session>.jsonl), then a raw-layout
 * filename prefix (<agent>-<sessionId>.jsonl).
 */
function agentFromPath(relPath: string): string | undefined {
  const segments = relPath.split(path.sep);
  if (segments.length >= 2) {
    const dir = segments[0]!;
    if (/^[a-z][a-z0-9_]*$/i.test(dir)) return dir;
  }
  const base = segments[segments.length - 1] ?? "";
  const idx = base.indexOf("-");
  if (idx <= 0) return undefined;
  const agent = base.slice(0, idx);
  return /^[a-z][a-z0-9_]*$/i.test(agent) ? agent : undefined;
}

/** Map a driver NDJSON event line to a canonical record, or null. */
function fromEventLine(line: Record<string, unknown>, fallbackAgent: string): CanonicalTokenRecord | null {
  const type = line.type;
  const ts = typeof line.timestamp === "number" ? line.timestamp : Date.now();
  if (type === "usage_raw") {
    const agent = typeof line.agent === "string" ? line.agent : fallbackAgent;
    const rec = normalizeAuto(agent, line.data, ts);
    return rec ? { ...rec, sessionId: typeof line.sessionId === "string" ? line.sessionId : undefined } : null;
  }
  if (type === "usage") {
    const usage = line.usage as CanonicalTokenRecord | undefined;
    if (!usage) return null;
    const cached = usage.cachedTokens ?? usage.cacheReadTokens ?? 0;
    return {
      agent: (usage.agent as string | undefined) ?? fallbackAgent,
      model: usage.model,
      sessionId: typeof line.sessionId === "string" ? line.sessionId : undefined,
      timestamp: ts,
      inputTokens: usage.inputTokens ?? Math.max(0, (usage.promptTokens ?? 0) - cached),
      outputTokens: usage.outputTokens ?? usage.completionTokens ?? 0,
      cacheReadTokens: usage.cacheReadTokens ?? cached,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
      reasoningTokens: usage.reasoningTokens,
      costUsd: usage.costUsd ?? 0,
      extra: usage.extra,
    };
  }
  return null;
}

/** Wrap an event-line record into a StatRecord with path-based agent fallback. */
function eventLineToStatRecord(line: Record<string, unknown>, relPath: string): StatRecord | null {
  const rec = fromEventLine(line, agentFromPath(relPath) ?? "unknown");
  if (!rec) return null;
  return { ...rec, agent: rec.agent ?? agentFromPath(relPath) ?? "unknown", ts: isoTs(rec.timestamp) };
}

function toStatRecord(parsed: z.infer<typeof RecordLineSchema>, relPath: string, line: Record<string, unknown>): StatRecord | null {
  // Driver event line (has a type we understand as an event). Pure event
  // lines are routed before RecordLineSchema in readAllRecords (the schema
  // requires top-level inputTokens/outputTokens, which they never carry);
  // typed hybrids that pass the schema route here.
  if (typeof parsed.type === "string" && parsed.inputTokens === undefined) {
    return eventLineToStatRecord(line, relPath);
  }
  // Canonical record line.
  const agent = parsed.agent ?? agentFromPath(relPath) ?? "unknown";
  return {
    ts: isoTs(parsed.ts ?? parsed.timestamp),
    agent,
    sessionId: parsed.sessionId ?? "unknown",
    model: parsed.model ?? undefined,
    inputTokens: parsed.inputTokens,
    outputTokens: parsed.outputTokens,
    cacheReadTokens: parsed.cacheReadTokens,
    cacheWriteTokens: parsed.cacheWriteTokens,
    reasoningTokens: parsed.reasoningTokens,
    costUsd: parsed.costUsd,
    extra: parsed.extra,
  };
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFilesRecursive(p)));
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

export interface ReadRecordsOptions {
  agent?: string;
  sinceTs?: number; // epoch ms, inclusive filter on record ts
}

/** Read every canonical record under <stateDir>/raw. */
export async function readAllRecords(opts: ReadRecordsOptions = {}): Promise<StatRecord[]> {
  const root = path.join(stateDir(), "raw");
  const files = await listFilesRecursive(root);
  const records: StatRecord[] = [];
  for (const f of files) {
    let text: string;
    try {
      text = await fs.readFile(f, "utf8");
    } catch {
      continue;
    }
    if (opts.agent && !text.includes(`"agent":"${opts.agent}"`)) continue;
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let json: unknown;
      try {
        json = JSON.parse(t);
      } catch {
        continue;
      }
      if (typeof json !== "object" || json === null) continue;
      const obj = json as Record<string, unknown>;
      // Driver NDJSON event line: top-level `type`, no top-level token fields,
      // so RecordLineSchema (inputTokens/outputTokens required) rejects it and
      // the line used to be silently dropped. Route typed lines to the event
      // path before schema validation; everything else parses as canonical.
      if (typeof obj.type === "string" && obj.inputTokens === undefined) {
        const rec = eventLineToStatRecord(obj, path.relative(root, f));
        if (rec) {
          if (opts.agent && rec.agent !== opts.agent) continue;
          if (opts.sinceTs !== undefined && Date.parse(rec.ts) < opts.sinceTs) continue;
          records.push(rec);
        }
        continue;
      }
      const parsed = RecordLineSchema.safeParse(json);
      if (!parsed.success) continue;
      const rec = toStatRecord(parsed.data, path.relative(root, f), obj);
      if (!rec) continue;
      if (opts.agent && rec.agent !== opts.agent) continue;
      if (opts.sinceTs !== undefined && Date.parse(rec.ts) < opts.sinceTs) continue;
      records.push(rec);
    }
  }
  return records;
}
