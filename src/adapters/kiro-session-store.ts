// Kiro session-store reader — wave 2/F of the kiro-acp plan (amendment
// 2026-09-12 "token counts", rule 3).
//
// kiro-cli persists its own per-session record at
//   $KIRO_SESSIONS_DIR/<nativeSessionId>.json   (default ~/.kiro/sessions/cli/)
// and that file is the ONLY place on 2.21.x that carries
//   * the per-turn token counters (`input_token_count`, `output_token_count`,
//     `cache_read_input_token_count`, `cache_write_input_token_count`) — all
//     ZERO on every run measured so far, which is exactly why we read them
//     rather than assume,
//   * the effective model per turn (`model`) — headless `--model` is ignored on
//     2.21.2, so the store shows `"auto"` there and the real id when the ACP
//     transport set it,
//   * the context-window size (`rts_model_state.model_info.context_window_tokens`),
//   * `metering_usage[]` credits, a third reconciliation source next to the
//     stream `metadata` frames and the MITM tap.
//
// PARSING IS PURE and TOTAL: `parseKiroSessionStore` never throws and never
// invents a number — a field it cannot read comes back `undefined`/`null`, not
// `0`. Only `locateKiroSessionStore`/`readKiroSessionStore` touch the disk.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** One `session_state.conversation_metadata.user_turn_metadatas[]` entry. */
export interface KiroStoreTurn {
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  contextUsagePercentage?: number;
  finalContextUsagePercentage?: number;
  /** Sum of `metering_usage[].value` for the turn; null when the key is absent. */
  credits: number | null;
}

export interface ParsedKiroSessionStore {
  /** `rts_model_state.model_info.model_id`, else the last turn's `model`. */
  model?: string;
  contextWindowTokens?: number;
  turns: KiroStoreTurn[];
  /** Sum of every turn's credits; null when no turn reported any. */
  creditsTotal: number | null;
  /** Latest (final, else running) context percentage across the turns. */
  lastContextUsagePercentage?: number;
}

export interface KiroSessionStoreFailure {
  ok: false;
  /** Why the store is unusable — surfaced as a warning, never thrown. */
  reason: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Token counters default to 0 only because the field's ABSENCE and its zero
 *  value are indistinguishable in this store; `tokens.available` is decided by
 *  computeUsageAvailability from the values, never from this default. */
function count(v: unknown): number {
  return num(v) ?? 0;
}

function text(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** Sum `metering_usage[].value`; null when the array is missing or has no
 *  numeric entry (an empty array means "no charge reported", also null). */
function sumMetering(v: unknown): number | null {
  if (!Array.isArray(v)) return null;
  let total: number | null = null;
  for (const entry of v) {
    if (!isRecord(entry)) continue;
    const value = num(entry.value);
    if (value === undefined) continue;
    total = (total ?? 0) + value;
  }
  return total;
}

/**
 * Parse a kiro session-store document. Returns null for anything that is not a
 * recognizable store (wrong shape, no `session_state`); a store with zero turns
 * parses fine and yields `turns: []`.
 */
export function parseKiroSessionStore(json: unknown): ParsedKiroSessionStore | null {
  if (!isRecord(json)) return null;
  const state = json.session_state;
  if (!isRecord(state)) return null;

  const meta = isRecord(state.conversation_metadata) ? state.conversation_metadata : undefined;
  const rawTurns = meta && Array.isArray(meta.user_turn_metadatas) ? meta.user_turn_metadatas : [];

  const turns: KiroStoreTurn[] = [];
  for (const t of rawTurns) {
    if (!isRecord(t)) continue;
    turns.push({
      ...(text(t.model) !== undefined ? { model: text(t.model) as string } : {}),
      inputTokens: count(t.input_token_count),
      outputTokens: count(t.output_token_count),
      cacheReadTokens: count(t.cache_read_input_token_count),
      cacheWriteTokens: count(t.cache_write_input_token_count),
      ...(num(t.context_usage_percentage) !== undefined
        ? { contextUsagePercentage: num(t.context_usage_percentage) as number }
        : {}),
      ...(num(t.final_context_usage_percentage) !== undefined
        ? { finalContextUsagePercentage: num(t.final_context_usage_percentage) as number }
        : {}),
      credits: sumMetering(t.metering_usage),
    });
  }

  let creditsTotal: number | null = null;
  for (const t of turns) {
    if (t.credits === null) continue;
    creditsTotal = (creditsTotal ?? 0) + t.credits;
  }

  const modelInfo = isRecord(state.rts_model_state) && isRecord(state.rts_model_state.model_info)
    ? state.rts_model_state.model_info
    : undefined;

  // Latest context reading: walk backwards so a partially-written final turn
  // falls back to the previous complete one.
  let lastContextUsagePercentage: number | undefined;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const pct = turns[i]?.finalContextUsagePercentage ?? turns[i]?.contextUsagePercentage;
    if (pct !== undefined) {
      lastContextUsagePercentage = pct;
      break;
    }
  }
  if (lastContextUsagePercentage === undefined && meta && isRecord(meta.last_context_usage)) {
    lastContextUsagePercentage = num(meta.last_context_usage.percentage);
  }

  // Prefer the store's own model_info; fall back to the newest turn that named
  // a model (a resumed session can carry several).
  let model = modelInfo ? text(modelInfo.model_id) : undefined;
  if (model === undefined) {
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      if (turns[i]?.model !== undefined) {
        model = turns[i]?.model;
        break;
      }
    }
  }

  return {
    ...(model !== undefined ? { model } : {}),
    ...(modelInfo && num(modelInfo.context_window_tokens) !== undefined
      ? { contextWindowTokens: num(modelInfo.context_window_tokens) as number }
      : {}),
    turns,
    creditsTotal,
    ...(lastContextUsagePercentage !== undefined ? { lastContextUsagePercentage } : {}),
  };
}

/** Directory kiro-cli writes its CLI session stores to. */
export function kiroSessionsDir(opts: { dir?: string } = {}): string {
  return opts.dir ?? process.env.KIRO_SESSIONS_DIR ?? path.join(os.homedir(), '.kiro', 'sessions', 'cli');
}

/**
 * Path of the store for a native session id, or null when the id is empty,
 * unsafe (path separators — never let an agent-reported id escape the dir), or
 * the file does not exist.
 */
export async function locateKiroSessionStore(
  nativeSessionId: string | undefined | null,
  opts: { dir?: string } = {},
): Promise<string | null> {
  if (typeof nativeSessionId !== 'string' || nativeSessionId === '') return null;
  if (nativeSessionId.includes('/') || nativeSessionId.includes('\\') || nativeSessionId.includes('..')) {
    return null;
  }
  const file = path.join(kiroSessionsDir(opts), `${nativeSessionId}.json`);
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return null;
  } catch {
    return null;
  }
  return file;
}

export type KiroSessionStoreResult =
  | { ok: true; path: string; store: ParsedKiroSessionStore }
  | KiroSessionStoreFailure;

/**
 * Locate + read + parse in one call. Never throws: a missing file, unreadable
 * file, bad JSON or unrecognized shape all come back as `{ok:false, reason}`.
 */
export async function readKiroSessionStore(
  nativeSessionId: string | undefined | null,
  opts: { dir?: string } = {},
): Promise<KiroSessionStoreResult> {
  const file = await locateKiroSessionStore(nativeSessionId, opts);
  if (file === null) {
    return { ok: false, reason: `no kiro session store for session id ${nativeSessionId ?? '(none)'}` };
  }
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    return { ok: false, reason: `kiro session store unreadable (${file}): ${err instanceof Error ? err.message : String(err)}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: `kiro session store is not valid JSON (${file})` };
  }
  const store = parseKiroSessionStore(json);
  if (store === null) return { ok: false, reason: `kiro session store has no session_state (${file})` };
  return { ok: true, path: file, store };
}
