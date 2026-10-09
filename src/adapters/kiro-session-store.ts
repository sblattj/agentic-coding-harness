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
  /** Which on-disk layout this was parsed from: the v2 engine's
   *  `cli/<uuid>.json` or the v3 engine's `<16hex>/sess_<id>/` directory. */
  format?: 'cli-v2' | 'v3';
  /** `false` when the layout carries NO token fields at all (v3). Distinct from
   *  the v2 store whose counters exist but are all zero; downstream must never
   *  read a `false` here as "zero tokens", nor let it make tokens available. */
  hasTokenData?: boolean;
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

function sumTurnCredits(turns: readonly KiroStoreTurn[]): number | null {
  let total: number | null = null;
  for (const t of turns) {
    if (t.credits === null) continue;
    total = (total ?? 0) + t.credits;
  }
  return total;
}

function lastTurnContextPercentage(turns: readonly KiroStoreTurn[]): number | undefined {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const pct = turns[i]?.finalContextUsagePercentage ?? turns[i]?.contextUsagePercentage;
    if (pct !== undefined) return pct;
  }
  return undefined;
}

/**
 * Scope a store to the turns appended AFTER the first `priorTurnCount` ones.
 * kiro's store is per SESSION: a resumed run finds every earlier run's turns
 * in it, so credits/tokens summed over `turns` would over-report. Turns have no
 * id or timestamp in the store, but the array is append-only, so the count read
 * before the run is an exact boundary. `creditsTotal` and the context reading
 * are recomputed over the kept turns; model / window stay session-level. A
 * count of 0 (fresh session) returns the store unchanged. A count larger than
 * the store (store shrank or was replaced) cannot be a boundary, so the whole
 * store is kept rather than inventing an empty slice.
 */
export function sliceKiroSessionStore(
  store: ParsedKiroSessionStore,
  priorTurnCount: number,
): ParsedKiroSessionStore {
  if (!Number.isInteger(priorTurnCount) || priorTurnCount <= 0 || priorTurnCount > store.turns.length) {
    return store;
  }
  const turns = store.turns.slice(priorTurnCount);
  const lastContextUsagePercentage = lastTurnContextPercentage(turns);
  const { lastContextUsagePercentage: _drop, ...rest } = store;
  void _drop;
  return {
    ...rest,
    turns,
    creditsTotal: sumTurnCredits(turns),
    ...(lastContextUsagePercentage !== undefined ? { lastContextUsagePercentage } : {}),
  };
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

  const creditsTotal = sumTurnCredits(turns);

  const modelInfo = isRecord(state.rts_model_state) && isRecord(state.rts_model_state.model_info)
    ? state.rts_model_state.model_info
    : undefined;

  // Latest context reading: walk backwards so a partially-written final turn
  // falls back to the previous complete one.
  let lastContextUsagePercentage = lastTurnContextPercentage(turns);
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
    format: 'cli-v2',
    ...(model !== undefined ? { model } : {}),
    ...(modelInfo && num(modelInfo.context_window_tokens) !== undefined
      ? { contextWindowTokens: num(modelInfo.context_window_tokens) as number }
      : {}),
    turns,
    creditsTotal,
    ...(lastContextUsagePercentage !== undefined ? { lastContextUsagePercentage } : {}),
  };
}

/**
 * Parse a kiro v3-engine session directory (`session.json` + `messages.jsonl`).
 *
 * The v3 store carries NO token fields. What it has per model call is context
 * % (`session_metadata` key `contextUsage`, `value.usagePercentage`) and, once
 * per prompt turn, a `usage_summary` whose `promptTurnSummaries[].usage` is the
 * credits that turn cost. Measured on 31 real files: exactly one usage_summary
 * per `executionId`, one summary entry each, so it is a PER-TURN charge, not a
 * running total. Each unique `executionId` becomes one turn; a repeated id (a
 * rewritten record) replaces the earlier one rather than adding to it, and
 * entries inside one record are summed. Token counters are 0 on every turn only
 * because `KiroStoreTurn` requires numbers: `hasTokenData: false` is the signal.
 *
 * Total and pure: never throws; unparsable lines (a half-written tail) are
 * skipped. Returns null when neither file yields anything recognizable.
 */
export function parseKiroV3Session(
  sessionJson: unknown,
  messagesJsonl: string,
): ParsedKiroSessionStore | null {
  const meta = isRecord(sessionJson) ? sessionJson : undefined;
  const sessionModel = meta ? text(meta.modelId) : undefined;

  const turnsById = new Map<string, KiroStoreTurn>();
  const order: string[] = [];
  let pendingPct: number | undefined;
  let lastPct: number | undefined;
  let recognized = meta !== undefined && text(meta.id) !== undefined;
  let anon = 0;

  for (const line of messagesJsonl.split('\n')) {
    if (line.trim() === '') continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(rec) || !isRecord(rec.payload)) continue;
    const payload = rec.payload;
    if (typeof payload.type !== 'string') continue;
    recognized = true;
    if (payload.type === 'session_metadata') {
      if (payload.key === 'contextUsage' && isRecord(payload.value)) {
        const pct = num(payload.value.usagePercentage);
        if (pct !== undefined) {
          pendingPct = pct;
          lastPct = pct;
        }
      }
    } else if (payload.type === 'usage_summary') {
      let credits: number | null = null;
      if (Array.isArray(payload.promptTurnSummaries)) {
        for (const entry of payload.promptTurnSummaries) {
          if (!isRecord(entry)) continue;
          const v = num(entry.usage);
          if (v === undefined) continue;
          credits = (credits ?? 0) + v;
        }
      }
      const id = text(payload.executionId) ?? text(rec.id) ?? `anon-${anon++}`;
      if (!turnsById.has(id)) order.push(id);
      turnsById.set(id, {
        ...(sessionModel !== undefined ? { model: sessionModel } : {}),
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        ...(pendingPct !== undefined ? { contextUsagePercentage: pendingPct } : {}),
        credits,
      });
    }
  }
  if (!recognized) return null;

  const turns = order.map((id) => turnsById.get(id) as KiroStoreTurn);
  return {
    format: 'v3',
    hasTokenData: false,
    ...(sessionModel !== undefined ? { model: sessionModel } : {}),
    turns,
    creditsTotal: sumTurnCredits(turns),
    ...(lastPct !== undefined ? { lastContextUsagePercentage: lastPct } : {}),
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

/**
 * Directory of the v3-engine store for a `sess_<id>` native session id:
 * `<sessions root>/<16hex>/sess_<id>/`, where the sessions root is the parent
 * of `kiroSessionsDir()`. The `<16hex>` bucket is not derivable from the id, so
 * the root is scanned. Same id safety rules as `locateKiroSessionStore`; null
 * when nothing matches. Never throws.
 */
export async function locateKiroV3SessionDir(
  nativeSessionId: string | undefined | null,
  opts: { dir?: string } = {},
): Promise<string | null> {
  if (typeof nativeSessionId !== 'string' || !nativeSessionId.startsWith('sess_')) return null;
  if (nativeSessionId.includes('/') || nativeSessionId.includes('\\') || nativeSessionId.includes('..')) {
    return null;
  }
  const root = path.dirname(kiroSessionsDir(opts));
  let buckets: string[];
  try {
    buckets = await fs.readdir(root);
  } catch {
    return null;
  }
  for (const bucket of buckets.sort()) {
    const candidate = path.join(root, bucket, nativeSessionId);
    try {
      const stat = await fs.stat(path.join(candidate, 'messages.jsonl'));
      if (stat.isFile()) return candidate;
    } catch {
      // not in this bucket
    }
  }
  return null;
}

async function readKiroV3Store(dir: string): Promise<KiroSessionStoreResult> {
  let messages: string;
  try {
    messages = await fs.readFile(path.join(dir, 'messages.jsonl'), 'utf8');
  } catch (err) {
    return { ok: false, reason: `kiro v3 session store unreadable (${dir}): ${err instanceof Error ? err.message : String(err)}` };
  }
  let sessionJson: unknown;
  try {
    sessionJson = JSON.parse(await fs.readFile(path.join(dir, 'session.json'), 'utf8'));
  } catch {
    sessionJson = undefined; // model is optional; messages.jsonl alone is usable
  }
  const store = parseKiroV3Session(sessionJson, messages);
  if (store === null) return { ok: false, reason: `kiro v3 session store has no recognizable records (${dir})` };
  return { ok: true, path: dir, store };
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
    const v3Dir = await locateKiroV3SessionDir(nativeSessionId, opts);
    if (v3Dir !== null) return readKiroV3Store(v3Dir);
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
