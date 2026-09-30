// Context-window pressure meter for the non-kiro agents (issue #21).
//
// Kiro's occupancy comes from its session store (usage-availability.ts). The
// other agents report per-call or per-turn token usage instead, so the meter
// derives occupancy from the LATEST usage (input + cache read + cache write =
// the prompt the model just saw) divided by the model's context window from
// the bundled LiteLLM extract (`max_input_tokens` in pricing-data.json).
//
// Honesty tiers, all labelled on the result:
//  - `estimated: true` + `windowSource: 'assumed'` — the window comes from a
//    bundled table, not from the provider for this run.
//  - `basis: 'last-call'` — latest single model call (claude assistant
//    messages, opencode step-finish): a real occupancy reading.
//  - `basis: 'turn-total'` — a usage record summed over a turn's model calls
//    (codex turn.completed, gemini result.stats, a claude result without
//    per-message usage): an UPPER BOUND. The overflow warning never fires off
//    an upper bound, and renderers mark it `≤`.
//  - unknown model → `available: false` (renders n/a), never a guessed window.
//
// The default table is embedded; explicit external tables are read from disk.
import { readFileSync } from 'node:fs';
import bundledPricingData from './pricing-data.json' with { type: 'json' };
import { resolveAlias } from './pricing.js';
import type { AgentEvent, CanonicalTokenRecord, UsageAvailability } from './types.js';

type ContextSnapshot = NonNullable<UsageAvailability['context']>;

/** Where window sizes come from (stamped so a reader can judge freshness). */
export const CONTEXT_WINDOW_TABLE_SOURCE =
  'LiteLLM model_prices_and_context_window.json max_input_tokens, bundled as src/core/pricing-data.json (extract of 2026-09-10)';

/** One-time overflow warning threshold, as a fraction of the window. */
export const CONTEXT_WARN_FRACTION = 0.85;

/** Tool-output token estimate: characters per token (the common rule of thumb). */
export const CHARS_PER_TOKEN_ESTIMATE = 4;

/** Agents the meter serves. Kiro is excluded: its session store owns the meter. */
const METERED_AGENTS = new Set(['claude', 'codex', 'gemini', 'opencode']);

/** Agents whose `usage` events are one model call each (else: turn/run totals). */
const PER_CALL_USAGE_AGENTS = new Set(['opencode']);

let bundledTable: Map<string, number> | null = null;

/** Build a model → max_input_tokens map (lower-cased key AND alias). */
export function loadContextWindowTable(path?: string): Map<string, number> {
  const table = new Map<string, number>();
  try {
    const raw: Record<string, unknown> = path === undefined
      ? bundledPricingData
      : JSON.parse(readFileSync(path, 'utf8'));
    for (const [key, entry] of Object.entries(raw)) {
      const max = (entry as { max_input_tokens?: unknown } | null)?.max_input_tokens;
      if (typeof max !== 'number' || !Number.isFinite(max) || max <= 0) continue;
      table.set(key.toLowerCase(), max);
      const alias = resolveAlias(key);
      if (!table.has(alias)) table.set(alias, max);
    }
  } catch {
    // An unreadable external table reports unknown windows, never guesses.
  }
  return table;
}

function defaultTable(): Map<string, number> {
  bundledTable ??= loadContextWindowTable();
  return bundledTable;
}

/**
 * Context window for a model id, or undefined when unknown. An explicit
 * window tag on the id (`claude-sonnet-4-5[1m]`) is the model's own
 * statement of its window and wins over the table.
 */
export function lookupContextWindow(model: string | undefined, table: Map<string, number> = defaultTable()): number | undefined {
  if (model === undefined) return undefined;
  const m = model.trim().toLowerCase();
  if (m === '' || m === 'unknown' || m === 'multi') return undefined;
  const tag = /\[(\d+(?:\.\d+)?)([km])\]$/.exec(m);
  if (tag) return Math.round(Number(tag[1]) * (tag[2] === 'm' ? 1_000_000 : 1_000));
  return table.get(m) ?? table.get(resolveAlias(m));
}

/**
 * Claude Code's model id for messages the CLI writes itself (e.g. "Credit
 * balance is too low"): no model call happened, and the all-zero usage it
 * carries is not an occupancy reading.
 */
const CLAUDE_SYNTHETIC_MODEL = '<synthetic>';

function usableModel(model: unknown): string | undefined {
  if (typeof model !== 'string') return undefined;
  const m = model.trim();
  if (m === '' || m === 'unknown' || m === 'multi' || m === CLAUDE_SYNTHETIC_MODEL || m.includes('+')) return undefined;
  return m;
}

function charLength(v: unknown): number {
  if (v === undefined || v === null) return 0;
  if (typeof v === 'string') return v.length;
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return 0;
  }
}

export interface ContextMeter {
  /** Feed one driver event. Returns the one-time overflow warning when this event crosses the threshold. */
  observe(event: AgentEvent): string | undefined;
  /** Current occupancy verdict; undefined when no usage has been observed. */
  snapshot(): ContextSnapshot | undefined;
  /**
   * The usage record the verdict is read from and its occupancy, known even
   * when the window is not (`snapshot()` is then `available: false` with no
   * tokens). `record` keeps its identity until a newer usage replaces it, so a
   * caller can tell which event fed the reading. Undefined before any usage.
   */
  reading(): ContextReading | undefined;
}

export interface ContextReading {
  record: CanonicalTokenRecord;
  /** input + cache read + cache write of `record`. */
  tokens: number;
  basis: 'last-call' | 'turn-total';
}

export interface ContextMeterOptions {
  agent: string;
  /** Model requested on the RunSpec (fallback when no event names one). */
  requestedModel?: string;
  /** Override the window table (tests). */
  table?: Map<string, number>;
}

/** A meter for `agent`, or null when the agent is not metered here (kiro, custom adapters). */
export function createContextMeter(opts: ContextMeterOptions): ContextMeter | null {
  if (!METERED_AGENTS.has(opts.agent)) return null;
  const table = opts.table;
  const perCallUsage = PER_CALL_USAGE_AGENTS.has(opts.agent);

  let lastCall: CanonicalTokenRecord | undefined; // per-call source (last-call basis)
  let lastTurn: CanonicalTokenRecord | undefined; // aggregate source (turn-total basis)
  let seenModel: string | undefined; // model named by a step/session/message event
  let toolChars = 0;
  let toolEvents = 0;
  let warned = false;

  const occupancy = (r: CanonicalTokenRecord): number =>
    (r.inputTokens ?? 0) + (r.cacheReadTokens ?? 0) + (r.cacheWriteTokens ?? 0);

  const snapshot = (): ContextSnapshot | undefined => {
    const basis: 'last-call' | 'turn-total' | undefined = lastCall ? 'last-call' : lastTurn ? 'turn-total' : undefined;
    const record = lastCall ?? lastTurn;
    if (basis === undefined || record === undefined) return undefined;
    const model = usableModel(record.model) ?? seenModel ?? usableModel(opts.requestedModel);
    const windowTokens = lookupContextWindow(model, table);
    if (windowTokens === undefined) {
      return { available: false, source: 'derived', ...(model !== undefined ? { model } : {}), basis, estimated: true };
    }
    const tokens = occupancy(record);
    const snap: ContextSnapshot = {
      available: true,
      source: 'derived',
      percentage: (tokens / windowTokens) * 100,
      windowTokens,
      windowSource: 'assumed',
      tokens,
      ...(model !== undefined ? { model } : {}),
      basis,
      estimated: true,
    };
    if (toolEvents > 0) {
      const toolTokens = Math.ceil(toolChars / CHARS_PER_TOKEN_ESTIMATE);
      snap.toolOutputTokens = toolTokens;
      if (tokens > 0) snap.toolOutputShare = Math.min(1, toolTokens / tokens);
    }
    return snap;
  };

  return {
    observe(event: AgentEvent): string | undefined {
      const e = event as Record<string, unknown>;
      const named = usableModel(e.model) ?? usableModel((e.data as Record<string, unknown> | undefined)?.model);
      if (named !== undefined && (event.type === 'step' || event.type === 'session_start' || event.type === 'message' || event.type === 'model_call_end')) {
        seenModel = named;
      }
      if (event.type === 'tool_result') {
        toolEvents += 1;
        toolChars += charLength(e.content);
        return undefined;
      }
      if (event.type === 'tool' && e.phase === 'result') {
        toolEvents += 1;
        toolChars += charLength(e.output);
        return undefined;
      }
      const usage = e.usage as CanonicalTokenRecord | undefined;
      if (usage === undefined || typeof usage !== 'object') return undefined;
      if ((usage.extra as Record<string, unknown> | undefined)?.tokensAvailable === false) return undefined;
      if (usage.model === CLAUDE_SYNTHETIC_MODEL) return undefined;
      if (event.type === 'message' || event.type === 'model_call_end') {
        lastCall = usage;
      } else if (event.type === 'usage') {
        if (perCallUsage) lastCall = usage;
        else lastTurn = usage;
      } else {
        return undefined;
      }
      if (warned) return undefined;
      const snap = snapshot();
      if (snap?.available !== true || snap.basis !== 'last-call' || snap.percentage === undefined) return undefined;
      if (snap.percentage / 100 < CONTEXT_WARN_FRACTION) return undefined;
      warned = true;
      return (
        `context: ${opts.agent} run crossed ${Math.round(CONTEXT_WARN_FRACTION * 100)}% of the context window ` +
        `(~${snap.tokens} of ${snap.windowTokens} tok, ${snap.percentage.toFixed(1)}%` +
        `${snap.model !== undefined ? `, ${snap.model}` : ''}; estimated, assumed window)`
      );
    },
    snapshot,
    reading(): ContextReading | undefined {
      if (lastCall) return { record: lastCall, tokens: occupancy(lastCall), basis: 'last-call' };
      if (lastTurn) return { record: lastTurn, tokens: occupancy(lastTurn), basis: 'turn-total' };
      return undefined;
    },
  };
}
