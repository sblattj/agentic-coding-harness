// Read-only Goose (block/goose) session-store parser.
//
// Where: sessions.db (SQLite) under ~/.local/share/goose/sessions/,
// ~/Library/Application Support/goose/sessions/, or
// ~/.local/share/Block/goose/sessions/ (default locations as read by ccusage
// rust/adapters/goose/src/paths.rs @ a0a1fc53; DB_NAME = "sessions.db" in
// block/goose crates/goose/src/session/session_manager.rs @ 98c626d7).
//
// Schema (block/goose session_manager.rs @ 98c626d7, CREATE TABLE sessions /
// usage_ledger):
//  - usage_ledger: one row per model call (created_timestamp = unix seconds
//    via strftime('%s','now'), model, input/output/total/cache_read/
//    cache_write tokens). Rows with cost_source 'carried_forward' back-fill
//    pre-ledger usage and have no model. Preferred when the table exists.
//  - sessions.accumulated_* : per-session running totals. Used only for DBs
//    that predate usage_ledger -> one record per SESSION, timestamped at
//    sessions.created_at (SQLite CURRENT_TIMESTAMP, i.e. UTC).
//  - Goose normalises input_tokens to be cache-INCLUSIVE
//    (goose-provider-types conversation/token_usage.rs
//    Usage::from_cache_exclusive_input folds cache read+write into input), so
//    canonical input = input - cache_read - cache_write.
//
// Reads go through the `sqlite3` CLI in -readonly mode, the same mechanism
// as src/adapters/opencode.ts statsViaCli (better-sqlite3 is deliberately
// not a dependency). Any failure (not a database, sqlite3 missing, locked)
// is a warning and an empty result, never a throw.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CanonicalTokenRecord } from "./transcripts.ts";
import { warnTranscript, type WarnFn } from "./transcript-warnings.ts";

const execFileAsync = promisify(execFile);

type Row = Record<string, unknown>;

const num = (v: unknown): number => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
};
const isNullish = (v: unknown): boolean => v === null || v === undefined;

async function query(dbPath: string, sql: string): Promise<Row[]> {
  const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", dbPath, sql], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const text = stdout.trim();
  if (text === "") return [];
  const parsed: unknown = JSON.parse(text);
  return Array.isArray(parsed) ? (parsed as Row[]) : [];
}

/** "YYYY-MM-DD HH:MM:SS" (SQLite CURRENT_TIMESTAMP, UTC) or ISO -> ISO-8601. */
function sqliteTimestampToIso(v: unknown): string | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  const t = v.trim();
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?$/.exec(t);
  const ms = m ? Date.parse(`${m[1]}T${m[2]}${m[3] ?? ""}Z`) : Date.parse(t);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function unixSecondsToIso(v: unknown): string | null {
  const s = num(v);
  return s > 0 ? new Date(s * 1000).toISOString() : null;
}

function toRecord(
  sessionId: string,
  timestamp: string | null,
  model: string | null,
  inputInclusive: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
): CanonicalTokenRecord {
  return {
    agent: "goose",
    sessionId,
    timestamp,
    model,
    input: Math.max(0, inputInclusive - cacheRead - cacheWrite),
    output,
    cacheRead,
    cacheWrite,
    reasoning: 0,
  };
}

export async function parseGooseDb(
  dbPath: string,
  warn: WarnFn = warnTranscript,
): Promise<CanonicalTokenRecord[]> {
  try {
    const hasLedger = (
      await query(dbPath, "SELECT name FROM sqlite_master WHERE type='table' AND name='usage_ledger'")
    ).length > 0;
    return hasLedger ? await fromLedger(dbPath) : await fromSessions(dbPath, warn);
  } catch (err) {
    const msg = (err as { stderr?: string; message?: string }).stderr?.trim() || (err as Error).message;
    warn(`goose: skipped unreadable session store ${dbPath}: ${msg}`);
    return [];
  }
}

async function fromLedger(dbPath: string): Promise<CanonicalTokenRecord[]> {
  const rows = await query(
    dbPath,
    `SELECT session_id, created_timestamp, model, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens
       FROM usage_ledger ORDER BY id`,
  );
  const out: CanonicalTokenRecord[] = [];
  for (const r of rows) {
    const input = num(r.input_tokens);
    const output = num(r.output_tokens);
    const cacheRead = num(r.cache_read_tokens);
    const cacheWrite = num(r.cache_write_tokens);
    if (input + output + cacheRead + cacheWrite === 0) continue;
    out.push(
      toRecord(
        String(r.session_id),
        unixSecondsToIso(r.created_timestamp),
        typeof r.model === "string" && r.model.trim() !== "" ? r.model : null,
        input,
        output,
        cacheRead,
        cacheWrite,
      ),
    );
  }
  return out;
}

async function fromSessions(dbPath: string, warn: WarnFn): Promise<CanonicalTokenRecord[]> {
  // SELECT * so pre-cache-column schemas still read: absent columns are undefined.
  const rows = await query(dbPath, "SELECT * FROM sessions ORDER BY created_at, id");
  const out: CanonicalTokenRecord[] = [];
  for (const r of rows) {
    const id = String(r.id);
    if (isNullish(r.accumulated_input_tokens) && isNullish(r.accumulated_output_tokens)) {
      // input_tokens/output_tokens on the session row hold the LAST call's
      // usage (session_manager.rs binds current_usage there), not a total.
      if (num(r.input_tokens) + num(r.output_tokens) > 0) {
        warn(`goose: ${dbPath}: skipped session ${id}: no accumulated_* totals (per-call columns are not session totals)`);
      }
      continue;
    }
    const input = num(r.accumulated_input_tokens);
    const output = num(r.accumulated_output_tokens);
    const cacheRead = num(r.accumulated_cache_read_tokens);
    const cacheWrite = num(r.accumulated_cache_write_tokens);
    if (input + output + cacheRead + cacheWrite === 0) continue;
    let model: string | null = null;
    if (typeof r.model_config_json === "string" && r.model_config_json.trim() !== "") {
      try {
        const cfg: unknown = JSON.parse(r.model_config_json);
        const name = (cfg as { model_name?: unknown } | null)?.model_name;
        if (typeof name === "string" && name.trim() !== "") model = name;
      } catch {
        warn(`goose: ${dbPath}: session ${id}: unparseable model_config_json; model unknown`);
      }
    }
    out.push(toRecord(id, sqliteTimestampToIso(r.created_at), model, input, output, cacheRead, cacheWrite));
  }
  return out;
}
