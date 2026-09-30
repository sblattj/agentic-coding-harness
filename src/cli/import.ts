// import — turn existing local agent transcripts into first-class RunRecords
// (issue #25), so a new user's dash / web / compare views show history on day
// one instead of an empty registry.
//
// WHAT IS WRITTEN
//   One RunRecord per native session under <stateDir>/runs/<runId>.json,
//   tagged `source: "imported"`, carrying the transcript's native sessionId,
//   per-session token totals (tokens as the CLI reported them, cost computed
//   from the bundled price table) and the transcript paths in `metadata`.
//   NOTHING is written under <stateDir>/raw/: that is what keeps `ach stats`
//   from double counting (see DOUBLE COUNTING below).
//
// IDEMPOTENT
//   runId is derived from (agent, sessionId), and the record carries no
//   wall-clock field (no importedAt, no Date.now()), so a second import over
//   the same transcripts rewrites nothing and reports every session as
//   `unchanged`. A session that grew since the last import is `updated`.
//
// NATIVE DEDUPE
//   A (agent, sessionId) already owned by a non-imported RunRecord (an
//   `ach run`, or an external feed) is skipped and reported, never duplicated.
//
// DOUBLE COUNTING
//   `ach stats` sums tokens from two stores only: harness state NDJSON under
//   <stateDir>/raw (readAllRecords) and the machine transcripts themselves
//   (scanAll), deduped by a composite key. RunRecord.totals never feed those
//   sums; the registry only feeds run-level rollups (runs, outcomes, cwd).
//   An imported session is therefore counted once — from its transcript —
//   whether or not it has been imported; import only adds the `imported`
//   origin label (`ach stats --origin`). Outcome rollups exclude imported
//   records because an imported session carries no task verdict.
//
// LANES
//   Only claude is importable today. A lane is a machine transcript source
//   from src/monitors/transcripts.ts (transcriptSources) plus a corruption
//   probe for its file format; adding codex/gemini is an IMPORT_LANES entry.
import { createHash } from "node:crypto";
import fs from "node:fs";
import { isDeepStrictEqual, parseArgs } from "node:util";
import path from "node:path";
import { HarnessError } from "../core/types.ts";
import { stateDir as defaultStateDir } from "../core/store.ts";
import { createPricer, type Pricer } from "../core/pricing.ts";
import { readRunRecord, scanRunRecords, writeRunRecord, type RunRecord } from "../core/registry.ts";
import type { ProvenanceMap } from "../core/provenance.ts";
import {
  scanOptionsForRoot,
  transcriptSources,
  walkFiles,
  type CanonicalTokenRecord,
  type ScanOptions,
} from "../monitors/transcripts.ts";
import { resolveDirFlag } from "./lib.ts";

export const DEFAULT_IMPORT_DAYS = 30;
export const IMPORT_PRODUCER = "ach import";

/** Outcome of probing one transcript file before parsing it. */
export interface ProbeResult {
  /** Set when the file is unusable: reported as an error line, import continues. */
  error?: string;
  /** Malformed lines skipped in an otherwise usable file (e.g. a live session's partial tail). */
  malformedLines: number;
}

/**
 * JSONL probe: the shared transcript parsers deliberately swallow read errors
 * and bad lines, so import checks the file itself. Unreadable, or non-empty
 * with zero parseable JSON lines, is corrupt; some bad lines are a warning.
 */
export function probeJsonl(file: string): ProbeResult {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    return { error: `unreadable: ${e instanceof Error ? e.message : String(e)}`, malformedLines: 0 };
  }
  let lines = 0;
  let bad = 0;
  for (const line of text.replace(/^﻿/, "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    lines++;
    try {
      JSON.parse(t);
    } catch {
      bad++;
    }
  }
  if (lines > 0 && bad === lines) return { error: `corrupt: none of ${lines} line(s) is valid JSON`, malformedLines: bad };
  return { malformedLines: bad };
}

interface ImportLane {
  /** Corruption probe for this lane's file format. */
  probe: (file: string) => ProbeResult;
}

/** Importable agents. codex/gemini follow by adding a lane (their parsers already exist in transcripts.ts). */
export const IMPORT_LANES: Readonly<Record<string, ImportLane>> = {
  claude: { probe: probeJsonl },
};

export function importableAgents(): string[] {
  return Object.keys(IMPORT_LANES);
}

export type SessionOutcome = "imported" | "updated" | "unchanged" | "skipped-native" | "skipped-outside-window";

export interface ImportSessionRow {
  agent: string;
  sessionId: string;
  runId: string;
  outcome: SessionOutcome;
  startedAt: number;
  endedAt: number;
  /** For skipped-native: the runId that already owns this session. */
  ownerRunId?: string;
}

export interface ImportFileError {
  file: string;
  error: string;
}

export interface ImportResult {
  agent: string;
  stateDir: string;
  transcriptDir: string;
  days: number;
  sinceMs: number;
  dryRun: boolean;
  filesScanned: number;
  sessions: ImportSessionRow[];
  errors: ImportFileError[];
  warnings: string[];
  summary: Record<SessionOutcome, number> & { sessions: number; errors: number };
}

/** Deterministic runId for an imported session: same (agent, session) → same file. */
export function importedRunId(agent: string, sessionId: string): string {
  return `imported-${agent}-${createHash("sha256").update(`${agent}\0${sessionId}`).digest("hex").slice(0, 24)}`;
}

interface SessionAcc {
  sessionId: string;
  files: Set<string>;
  records: CanonicalTokenRecord[];
  mtimeMs: number;
}

/** Fold one session's canonical records into an imported RunRecord (pure; no wall clock). */
export function buildImportedRecord(agent: string, acc: SessionAcc, pricer: Pricer): RunRecord {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let unpriced = 0;
  let first = Infinity;
  let last = -Infinity;
  let cwd: string | undefined;
  const models = new Map<string, number>();
  for (const r of acc.records) {
    input += r.input;
    output += r.output;
    cacheRead += r.cacheRead;
    cacheWrite += r.cacheWrite;
    const ts = r.timestamp ? Date.parse(r.timestamp) : NaN;
    if (Number.isFinite(ts)) {
      first = Math.min(first, ts);
      last = Math.max(last, ts);
    }
    if (cwd === undefined && r.cwd) cwd = r.cwd;
    if (r.model) models.set(r.model, (models.get(r.model) ?? 0) + 1);
    const price = r.model
      ? pricer.price({ model: r.model, inputTokens: r.input, outputTokens: r.output, cacheReadTokens: r.cacheRead, cacheWriteTokens: r.cacheWrite, ...(r.cacheWrite1h !== undefined ? { cacheWrite1hTokens: r.cacheWrite1h } : {}) })
      : NaN;
    if (Number.isFinite(price)) cost += price;
    else unpriced++;
  }
  // No timestamps at all: fall back to the newest file mtime (stable across re-imports).
  if (!Number.isFinite(first)) first = last = Math.floor(acc.mtimeMs);
  const allPriced = unpriced === 0;
  const provenance: ProvenanceMap = {
    inputTokens: "reported",
    outputTokens: "reported",
    cacheReadTokens: "reported",
    cacheWriteTokens: "reported",
    ...(allPriced ? { costUsd: "computed" as const } : {}),
  };
  const modelList = [...models.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([m]) => m);
  return {
    runId: importedRunId(agent, acc.sessionId),
    agent,
    sessionId: acc.sessionId,
    ...(cwd !== undefined ? { cwd } : {}),
    startedAt: first,
    updatedAt: last,
    endedAt: last,
    // No status: an imported session carries no task verdict (see header).
    totals: {
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      costUsd: Math.round(cost * 1e9) / 1e9,
      ...(allPriced ? { costSource: "computed" as const } : {}),
      provenance,
    },
    lastEvent: "source: imported",
    usage: {
      tokens: { available: true, source: "session-store", scope: "run" },
      credits: { available: false },
      usd: { available: allPriced },
    },
    source: "imported",
    producer: IMPORT_PRODUCER,
    metadata: {
      origin: "transcript-import",
      transcripts: [...acc.files].sort(),
      models: modelList,
      messages: acc.records.length,
      ...(unpriced > 0 ? { unpricedMessages: unpriced } : {}),
    },
  };
}

export interface ImportOptions {
  agent: string;
  stateDir: string;
  /** Scan options for the transcript source (default: the real home dirs). */
  scan?: ScanOptions;
  days?: number;
  now?: number;
  dryRun?: boolean;
  pricer?: Pricer;
}

export async function importSessions(opts: ImportOptions): Promise<ImportResult> {
  const lane = IMPORT_LANES[opts.agent];
  if (!lane) {
    throw new HarnessError(`ach import: agent '${opts.agent}' is not importable yet (supported: ${importableAgents().join(", ")})`, "UNKNOWN_AGENT");
  }
  const days = opts.days ?? DEFAULT_IMPORT_DAYS;
  const now = opts.now ?? Date.now();
  const sinceMs = now - days * 86_400_000;
  const pricer = opts.pricer ?? createPricer();
  const sources = transcriptSources(opts.scan ?? {}).filter((s) => s.agent === opts.agent);
  const errors: ImportFileError[] = [];
  const warnings: string[] = [];
  const bySession = new Map<string, SessionAcc>();
  let filesScanned = 0;
  const seenFiles = new Set<string>();
  for (const src of sources) {
    for (const file of await walkFiles(src.dir, src.keep)) {
      if (seenFiles.has(file)) continue;
      seenFiles.add(file);
      filesScanned++;
      const probe = lane.probe(file);
      if (probe.error) {
        errors.push({ file, error: probe.error });
        continue;
      }
      if (probe.malformedLines > 0) warnings.push(`${file}: skipped ${probe.malformedLines} malformed line(s)`);
      let records: CanonicalTokenRecord[];
      try {
        records = await src.parse(file);
      } catch (e) {
        errors.push({ file, error: `parse failed: ${e instanceof Error ? e.message : String(e)}` });
        continue;
      }
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(file).mtimeMs;
      } catch {
        // raced with a prune: the parsed records still stand
      }
      // A Claude subagent file (<session>/subagents/agent-*.jsonl) carries its
      // parent's sessionId on every line, so grouping by record sessionId folds
      // it into the parent session. A line with no sessionId falls back to the
      // file's basename (Claude names the main transcript <sessionId>.jsonl).
      const fallback = path.basename(file, path.extname(file));
      for (const r of records) {
        const sid = r.sessionId ?? fallback;
        let acc = bySession.get(sid);
        if (!acc) {
          acc = { sessionId: sid, files: new Set(), records: [], mtimeMs: 0 };
          bySession.set(sid, acc);
        }
        acc.files.add(file);
        acc.records.push(r);
        acc.mtimeMs = Math.max(acc.mtimeMs, mtimeMs);
      }
    }
  }

  // Sessions already owned by a native (non-imported) run.
  const owners = new Map<string, string>();
  for (const r of scanRunRecords(opts.stateDir).records) {
    if (r.source === "imported" || !r.sessionId) continue;
    owners.set(`${r.agent}\0${r.sessionId}`, r.runId);
  }

  const sessions: ImportSessionRow[] = [];
  for (const acc of [...bySession.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId))) {
    const rec = buildImportedRecord(opts.agent, acc, pricer);
    const base = { agent: opts.agent, sessionId: acc.sessionId, runId: rec.runId, startedAt: rec.startedAt, endedAt: rec.endedAt! };
    const owner = owners.get(`${opts.agent}\0${acc.sessionId}`);
    if (owner !== undefined) {
      sessions.push({ ...base, outcome: "skipped-native", ownerRunId: owner });
      continue;
    }
    if (rec.endedAt! < sinceMs) {
      sessions.push({ ...base, outcome: "skipped-outside-window" });
      continue;
    }
    const existing = readRunRecord(opts.stateDir, rec.runId);
    // Compare through a JSON round-trip: the on-disk form is what must stay identical.
    if (existing !== null && isDeepStrictEqual(JSON.parse(JSON.stringify(existing)), JSON.parse(JSON.stringify(rec)))) {
      sessions.push({ ...base, outcome: "unchanged" });
      continue;
    }
    if (!opts.dryRun) writeRunRecord(opts.stateDir, rec);
    sessions.push({ ...base, outcome: existing === null ? "imported" : "updated" });
  }
  warnings.push(...pricer.drainWarnings());

  const summary = {
    sessions: sessions.length,
    imported: 0,
    updated: 0,
    unchanged: 0,
    "skipped-native": 0,
    "skipped-outside-window": 0,
    errors: errors.length,
  };
  for (const s of sessions) summary[s.outcome]++;
  return {
    agent: opts.agent,
    stateDir: opts.stateDir,
    transcriptDir: sources.map((s) => s.dir).join(path.delimiter),
    days,
    sinceMs,
    dryRun: opts.dryRun === true,
    filesScanned,
    sessions,
    errors,
    warnings: [...new Set(warnings)],
    summary,
  };
}

export function formatImportText(res: ImportResult): string {
  const out: string[] = [];
  for (const e of res.errors) out.push(`error     ${e.file}: ${e.error}`);
  for (const s of res.sessions) {
    if (s.outcome === "skipped-native") out.push(`skipped   ${s.agent} session=${s.sessionId} (already recorded by native run ${s.ownerRunId})`);
  }
  const s = res.summary;
  // Out-of-window sessions are usually most of a machine's history: one line
  // with the count (each session is listed in --json).
  if (s["skipped-outside-window"] > 0) {
    out.push(`skipped   ${s["skipped-outside-window"]} ${res.agent} session(s) outside window (last activity before ${new Date(res.sinceMs).toISOString()}; widen with --days)`);
  }
  out.push(
    `${res.dryRun ? "dry-run: would import" : "imported"} ${res.agent}: files=${res.filesScanned} sessions=${s.sessions} ` +
      `imported=${s.imported} updated=${s.updated} unchanged=${s.unchanged} ` +
      `skipped-native=${s["skipped-native"]} skipped-outside-window=${s["skipped-outside-window"]} errors=${s.errors} ` +
      `(window: last ${res.days}d, registry: ${path.join(res.stateDir, "runs")})`,
  );
  return out.join("\n") + "\n";
}

export const IMPORT_USAGE = `ach import --agent claude [--days N=${DEFAULT_IMPORT_DAYS}] [--transcript-dir <root>] [--state-dir <stateDir>] [--dry-run] [--json]`;

export async function cmdImport(rest: string[]): Promise<number> {
  const args = parseArgs({
    args: rest,
    options: {
      agent: { type: "string" },
      days: { type: "string" },
      json: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      dir: { type: "string" },
      "state-dir": { type: "string" },
      "transcript-dir": { type: "string" },
    },
    allowPositionals: false,
  });
  const agent = args.values.agent;
  if (!agent) throw new HarnessError(`import requires --agent <${importableAgents().join("|")}>`, "USAGE");
  let days: number | undefined;
  if (args.values.days !== undefined) {
    days = Number(args.values.days);
    if (!Number.isFinite(days) || days <= 0) throw new HarnessError(`--days expects a positive number, got '${args.values.days}'`, "USAGE");
  }
  // --state-dir (alias --dir) is the registry to write, as in `ach audit`;
  // --transcript-dir is the home-shaped root to read, as in `ach stats`.
  const stateDirFlag = resolveDirFlag(args.values, "state-dir");
  const transcriptDir = args.values["transcript-dir"];
  const res = await importSessions({
    agent,
    stateDir: stateDirFlag ?? defaultStateDir(),
    ...(transcriptDir ? { scan: scanOptionsForRoot(path.resolve(transcriptDir)) } : {}),
    ...(days !== undefined ? { days } : {}),
    dryRun: args.values["dry-run"],
  });
  for (const w of res.warnings) process.stderr.write(`[warn] ${w}\n`);
  process.stdout.write(args.values.json ? JSON.stringify(res, null, 2) + "\n" : formatImportText(res));
  // A corrupt transcript is an error line, not a failed import.
  return 0;
}

// ---------------------------------------------------------------- stats glue

/** `ach stats --origin`: which provenance of token rows / runs to count. */
export const STATS_ORIGINS = ["all", "native", "imported", "transcript"] as const;
export type StatsOrigin = Exclude<(typeof STATS_ORIGINS)[number], "all">;

export function parseStatsOrigin(v: string | undefined): (typeof STATS_ORIGINS)[number] {
  if (v === undefined) return "all";
  if ((STATS_ORIGINS as readonly string[]).includes(v)) return v as (typeof STATS_ORIGINS)[number];
  throw new HarnessError(`--origin: unknown value '${v}' (expected one of: ${STATS_ORIGINS.join(", ")})`, "USAGE");
}

/**
 * Classify stats rows by origin. `native`: harness state rows, and transcript
 * rows of a session an `ach run` owns; `imported`: transcript rows of a
 * session `ach import` recorded; `transcript`: machine transcript rows not
 * (yet) in the registry. Classification never changes the numbers.
 */
export function statsOriginIndex(runs: readonly RunRecord[]): {
  originOf: (row: { source: "state" | "transcript"; agent?: string; sessionId?: string | null }) => StatsOrigin;
  runOrigin: (rec: RunRecord) => StatsOrigin;
  hasImported: boolean;
} {
  const imported = new Set<string>();
  const native = new Set<string>();
  for (const r of runs) {
    if (!r.sessionId) continue;
    (r.source === "imported" ? imported : native).add(`${r.agent}\0${r.sessionId}`);
  }
  return {
    originOf: (row) => {
      if (row.source === "state") return "native";
      const key = `${row.agent ?? ""}\0${row.sessionId ?? ""}`;
      if (native.has(key)) return "native";
      if (imported.has(key)) return "imported";
      return "transcript";
    },
    runOrigin: (rec) => (rec.source === "imported" ? "imported" : "native"),
    hasImported: imported.size > 0,
  };
}

/** The ccusage hint (#25): offer `ach import` first, ccusage as the alternative. */
export function ccusageHintText(): string {
  return (
    "hint: run `ach import --agent claude --days 30` to pull existing Claude Code history into the ach registry " +
    "(dash/web/compare show it as imported runs); 'ccusage' is also installed — run `ccusage` for its batch usage reports.\n"
  );
}
