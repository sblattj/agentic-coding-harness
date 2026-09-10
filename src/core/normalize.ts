import { z } from 'zod';
import type { CanonicalTokenRecord } from './types.js';

// ---------------------------------------------------------------------------
// Raw-shape schemas (zod-validated; extra provider keys are ignored by design).
// Each schema documents the ACTUAL wire shapes emitted by the adapters in
// src/adapters/{claude,opencode,codex,gemini}.ts.
// ---------------------------------------------------------------------------

/**
 * Claude Code stream-json: one entry of result.modelUsage (camelCase). The
 * real wire keys the map by model name and entries carry NO inner `model`
 * field (see ModelUsageEntrySchema in src/adapters/claude.ts); the optional
 * `model` below is legacy tolerance for pre-merge flattened payloads.
 */
const ClaudeModelUsageEntry = z.object({
  model: z.string().min(1).optional(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheCreationInputTokens: z.number().nonnegative().optional(),
  cacheReadInputTokens: z.number().nonnegative().optional(),
  reasoningTokens: z.number().nonnegative().optional(),
  costUSD: z.number().optional(),
});

/** Claude result line carrying the whole modelUsage map (model = record key). */
const ClaudeResultModelUsage = z.object({
  modelUsage: z.record(z.string(), ClaudeModelUsageEntry),
});

/** Claude assistant-message / result aggregate usage (snake_case). */
const ClaudeUsageBlock = z.object({
  input_tokens: z.number().nonnegative(),
  output_tokens: z.number().nonnegative(),
  cache_creation_input_tokens: z.number().nonnegative().optional(),
  cache_read_input_tokens: z.number().nonnegative().optional(),
  reasoning_tokens: z.number().nonnegative().optional(),
});

/** {model?, usage} — assistant message wrapper and result.usage fallback. */
const ClaudeUsageWrapper = z.object({
  model: z.string().min(1).optional(),
  usage: ClaudeUsageBlock,
});

/** opencode step_finish part.tokens — {input, output, reasoning,
 * cache: {read, write}}; opencode already reports input as uncached input
 * (see src/adapters/opencode.ts mapTokens). */
const OpencodeStepFinish = z.object({
  model: z.string().min(1).optional(),
  tokens: z.object({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    reasoning: z.number().nonnegative().optional(),
    cache: z
      .object({
        read: z.number().nonnegative().optional(),
        write: z.number().nonnegative().optional(),
      })
      .optional(),
  }),
});

/** codex turn.completed usage — OpenAI accounting where input_tokens
 * INCLUDES cached_input_tokens; we subtract it so canonical input stays
 * uncached-only. cache_write_input_tokens is reported separately by the CLI. */
const CodexTurnCompleted = z.object({
  input_tokens: z.number().nonnegative(),
  cached_input_tokens: z.number().nonnegative().optional(),
  cache_write_input_tokens: z.number().nonnegative().optional(),
  output_tokens: z.number().nonnegative(),
  reasoning_output_tokens: z.number().nonnegative().optional(),
});

/** gemini nested per-model stats: stats.models.<model>.tokens.{prompt,
 * candidates, cached, thought}. `cached` is a subset of prompt (billed at the
 * cache-read rate); `thought` is billable output. */
const GeminiNestedStats = z.object({
  stats: z.object({
    models: z.record(
      z.string(),
      z.object({
        tokens: z.object({
          prompt: z.number().nonnegative(),
          candidates: z.number().nonnegative(),
          cached: z.number().nonnegative().optional(),
          thought: z.number().nonnegative().optional(),
        }),
      }),
    ),
  }),
});

/** gemini flat aggregate stats (src/adapters/gemini.ts result.stats):
 * input_tokens is the TOTAL prompt (cached included); `input`, when present,
 * is already the UNCACHED slice. thoughts is informational (already inside
 * output_tokens). */
const GeminiFlatStats = z
  .object({
    input_tokens: z.number().nonnegative().optional(),
    input: z.number().nonnegative().optional(),
    output_tokens: z.number().nonnegative().optional(),
    cached: z.number().nonnegative().optional(),
    thoughts: z.number().nonnegative().optional(),
  })
  .refine(
    (s) => s.input !== undefined || s.input_tokens !== undefined || s.output_tokens !== undefined,
    { message: 'no stats fields present' },
  );

const GeminiResultFlat = z.object({ stats: GeminiFlatStats });

// kiro MITM proxy tokenUsage capture shape.
const KiroTokenUsage = z.object({
  model: z.string().min(1).optional(),
  tokenUsage: z.object({
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
    cacheReadTokens: z.number().nonnegative().optional(),
    cacheWriteTokens: z.number().nonnegative().optional(),
  }),
});

// ---------------------------------------------------------------------------
// Per-agent extractors (pure, unit-testable). Each returns null when the raw
// payload does not match — never throws, never fabricates zeros.
// ---------------------------------------------------------------------------

function record(
  agent: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  timestamp: number,
  reasoningTokens?: number,
  costUsd?: number,
): CanonicalTokenRecord {
  return {
    agent,
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    timestamp,
  };
}

/** A payload already carrying core-canonical field names — never claude wire
 * data (claude uses cacheReadInputTokens, not cacheReadTokens). */
function looksCoreCanonical(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return 'cacheReadTokens' in r || 'cacheWriteTokens' in r || 'agent' in r;
}

function sumClaudeEntries(
  entries: [string, z.infer<typeof ClaudeModelUsageEntry>][],
): { input: number; output: number; read: number; write: number; reasoning?: number; costUsd?: number } {
  let input = 0;
  let output = 0;
  let read = 0;
  let write = 0;
  let reasoning: number | undefined;
  let costUsd: number | undefined;
  for (const [, u] of entries) {
    input += u.inputTokens;
    output += u.outputTokens;
    read += u.cacheReadInputTokens ?? 0;
    write += u.cacheCreationInputTokens ?? 0;
    if (u.reasoningTokens !== undefined) reasoning = (reasoning ?? 0) + u.reasoningTokens;
    if (u.costUSD !== undefined) costUsd = (costUsd ?? 0) + u.costUSD;
  }
  return {
    input,
    output,
    read,
    write,
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

export function normalizeClaude(agent: string, raw: unknown, timestamp = Date.now()): CanonicalTokenRecord | null {
  // Legacy flattened single entry carrying an inner `model` key. Guarded so a
  // payload already in core-canonical field names is never misread as claude.
  if (!looksCoreCanonical(raw)) {
    const flat = ClaudeModelUsageEntry.safeParse(raw);
    if (flat.success) {
      const u = flat.data;
      return record(
        agent,
        u.model ?? 'unknown',
        u.inputTokens,
        u.outputTokens,
        u.cacheReadInputTokens ?? 0,
        u.cacheCreationInputTokens ?? 0,
        timestamp,
        u.reasoningTokens,
        u.costUSD,
      );
    }
  }
  // Real wire: result line with modelUsage as Record<modelName, entry>. The
  // record KEY is the model; entries carry no inner `model`. A single entry
  // keeps its model name; several are summed with a joined model name
  // (per-model events are preferred upstream).
  const result = ClaudeResultModelUsage.safeParse(raw);
  if (result.success) {
    const entries = Object.entries(result.data.modelUsage);
    if (entries.length === 0) return null;
    if (entries.length === 1) {
      const [model, u] = entries[0]!;
      return record(
        agent,
        model,
        u.inputTokens,
        u.outputTokens,
        u.cacheReadInputTokens ?? 0,
        u.cacheCreationInputTokens ?? 0,
        timestamp,
        u.reasoningTokens,
        u.costUSD,
      );
    }
    const s = sumClaudeEntries(entries);
    return record(
      agent,
      entries.map(([m]) => m).join('+'),
      s.input,
      s.output,
      s.read,
      s.write,
      timestamp,
      s.reasoning,
      s.costUsd,
    );
  }
  // Assistant message usage (flattened {model, usage} or the raw stream-json
  // line {message: {model, usage}}) and the result.usage fallback.
  let wrapper = ClaudeUsageWrapper.safeParse(raw);
  if (!wrapper.success && typeof raw === 'object' && raw !== null && 'message' in raw) {
    wrapper = ClaudeUsageWrapper.safeParse((raw as { message: unknown }).message);
  }
  if (wrapper.success) {
    const u = wrapper.data.usage;
    return record(
      agent,
      wrapper.data.model ?? 'unknown',
      u.input_tokens,
      u.output_tokens,
      u.cache_read_input_tokens ?? 0,
      u.cache_creation_input_tokens ?? 0,
      timestamp,
      u.reasoning_tokens,
    );
  }
  // Bare snake_case result.usage block passed alone. Requires at least one
  // claude-distinctive cache/reasoning key so a bare codex-shaped
  // {input_tokens, output_tokens} block is left for the codex extractor.
  if (typeof raw === 'object' && raw !== null) {
    const r = raw as Record<string, unknown>;
    const claudeDistinctive =
      'cache_read_input_tokens' in r || 'cache_creation_input_tokens' in r || 'reasoning_tokens' in r;
    if (claudeDistinctive) {
      const bare = ClaudeUsageBlock.safeParse(raw);
      if (bare.success) {
        const u = bare.data;
        return record(
          agent,
          'unknown',
          u.input_tokens,
          u.output_tokens,
          u.cache_read_input_tokens ?? 0,
          u.cache_creation_input_tokens ?? 0,
          timestamp,
          u.reasoning_tokens,
        );
      }
    }
  }
  return null;
}

export function normalizeOpencode(agent: string, raw: unknown, timestamp = Date.now()): CanonicalTokenRecord | null {
  const parsed = OpencodeStepFinish.safeParse(raw);
  if (!parsed.success) return null;
  const { tokens: t, model } = parsed.data;
  if (t.input === 0 && t.output === 0) return null;
  return record(
    agent,
    model ?? 'unknown',
    t.input,
    t.output,
    t.cache?.read ?? 0,
    t.cache?.write ?? 0,
    timestamp,
    t.reasoning,
  );
}

export function normalizeCodex(agent: string, raw: unknown, timestamp = Date.now()): CanonicalTokenRecord | null {
  const parsed = CodexTurnCompleted.safeParse(raw);
  if (!parsed.success) return null;
  const u = parsed.data;
  const cached = u.cached_input_tokens ?? 0;
  if (u.input_tokens === 0 && u.output_tokens === 0) return null;
  return record(
    agent,
    'unknown', // codex turn.completed does not carry the model name
    Math.max(0, u.input_tokens - cached), // input_tokens INCLUDES cached: canonical input is uncached-only
    u.output_tokens, // includes reasoning per OpenAI accounting
    cached,
    u.cache_write_input_tokens ?? 0,
    timestamp,
    u.reasoning_output_tokens,
  );
}

export function normalizeGemini(agent: string, raw: unknown, timestamp = Date.now()): CanonicalTokenRecord | null {
  // Nested per-model shape: stats.models.<model>.tokens.{prompt, candidates,
  // cached, thought}. input = prompt - cached; thought is billable output.
  const nested = GeminiNestedStats.safeParse(raw);
  if (nested.success) {
    const entries = Object.entries(nested.data.stats.models);
    if (entries.length === 0) return null;
    let input = 0;
    let output = 0;
    let read = 0;
    let thought = 0;
    for (const [, m] of entries) {
      const cached = m.tokens.cached ?? 0;
      input += Math.max(0, m.tokens.prompt - cached); // cached is a subset of prompt
      output += m.tokens.candidates;
      read += cached;
      thought += m.tokens.thought ?? 0;
    }
    output += thought; // thought tokens are billable output
    const model = entries.length === 1 ? entries[0]![0] : entries.map(([m]) => m).join('+');
    return record(agent, model, input, output, read, 0, timestamp, thought || undefined);
  }
  // Flat aggregate shape: stats.{input_tokens, input, output_tokens, cached,
  // thoughts}. `input` is already the uncached slice; otherwise derive it as
  // input_tokens - cached. Flat stats carry no model name.
  const flat = GeminiResultFlat.safeParse(raw);
  if (flat.success) {
    const s = flat.data.stats;
    const input = s.input ?? Math.max(0, (s.input_tokens ?? 0) - (s.cached ?? 0));
    const output = s.output_tokens ?? 0;
    const cached = s.cached ?? 0;
    if (input === 0 && output === 0 && cached === 0) return null;
    return record(agent, 'unknown', input, output, cached, 0, timestamp, s.thoughts);
  }
  return null;
}

export function normalizeKiro(agent: string, raw: unknown, timestamp = Date.now()): CanonicalTokenRecord | null {
  const parsed = KiroTokenUsage.safeParse(raw);
  if (!parsed.success) return null;
  const u = parsed.data.tokenUsage;
  if (u.inputTokens === 0 && u.outputTokens === 0) return null;
  return record(
    agent,
    parsed.data.model ?? 'unknown',
    u.inputTokens,
    u.outputTokens,
    u.cacheReadTokens ?? 0,
    u.cacheWriteTokens ?? 0,
    timestamp,
  );
}

const EXTRACTORS: Record<string, (agent: string, raw: unknown, ts: number) => CanonicalTokenRecord | null> = {
  claude: normalizeClaude,
  opencode: normalizeOpencode,
  codex: normalizeCodex,
  gemini: normalizeGemini,
  kiro: normalizeKiro,
};

/** Central dispatcher: agent name -> its extractor. Unknown agent or unrecognized shape -> null. */
export function normalizeUsage(agent: string, raw: unknown, timestamp: number = Date.now()): CanonicalTokenRecord | null {
  const extractor = EXTRACTORS[agent];
  if (!extractor) return null;
  return extractor(agent, raw, timestamp);
}

/**
 * Shape-sniffing dispatcher: tries the agent's own extractor first, then every
 * other one, first match wins. Use this at driver level where the event source
 * is trusted but the agent name may be synthetic (mock adapters, ACP peers);
 * a payload from a known provider shape is normalized regardless of which
 * agent name ran it.
 */
export function normalizeAuto(agent: string, raw: unknown, timestamp: number = Date.now()): CanonicalTokenRecord | null {
  const primary = EXTRACTORS[agent];
  const primaryResult = primary?.(agent, raw, timestamp);
  if (primaryResult) return primaryResult;
  for (const [name, extractor] of Object.entries(EXTRACTORS)) {
    if (name === agent) continue;
    const result = extractor(agent, raw, timestamp);
    if (result) return result;
  }
  return null;
}

/**
 * Sum records into one aggregate. SEMANTICS:
 *  - inputTokens, outputTokens, cacheReadTokens and cacheWriteTokens are each
 *    counted exactly once across records (inputTokens is already the
 *    uncached-only slice per the canonical convention — see
 *    CanonicalTokenRecord in core/types.ts; reasoningTokens is informational
 *    and already inside outputTokens for OpenAI/Gemini billing).
 *  - reasoningTokens and costUsd sum only over records that DEFINE them and
 *    are omitted entirely when none does — a missing cost never silently
 *    becomes $0.
 *  - The aggregate's agent/model are the sentinel 'all'; timestamp is the
 *    aggregation time, not any record's timestamp.
 */
export function sumTokens(records: CanonicalTokenRecord[]): CanonicalTokenRecord {
  const total = record('all', 'all', 0, 0, 0, 0, Date.now());
  let reasoning: number | undefined;
  let costUsd: number | undefined;
  for (const r of records) {
    total.inputTokens = (total.inputTokens ?? 0) + (r.inputTokens ?? 0);
    total.outputTokens = (total.outputTokens ?? 0) + (r.outputTokens ?? 0);
    total.cacheReadTokens = (total.cacheReadTokens ?? 0) + (r.cacheReadTokens ?? 0);
    total.cacheWriteTokens = (total.cacheWriteTokens ?? 0) + (r.cacheWriteTokens ?? 0);
    if (r.reasoningTokens !== undefined) {
      reasoning = (reasoning ?? 0) + r.reasoningTokens;
    }
    if (r.costUsd !== undefined) {
      costUsd = (costUsd ?? 0) + r.costUsd;
    }
  }
  if (reasoning !== undefined) total.reasoningTokens = reasoning;
  if (costUsd !== undefined) total.costUsd = costUsd;
  return total;
}
