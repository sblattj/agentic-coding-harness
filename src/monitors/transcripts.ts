// Batch token accounting from CLI transcript files (ccusage-style).
//
// Sources:
//  - Claude Code: ~/.claude/projects/**/*.jsonl (assistant message usage)
//  - Codex CLI:   ~/.codex/sessions/**/rollout-*.jsonl (cumulative token_usage_record
//                 and event_msg/token_count snapshots, deduped; #142)
//  - Gemini CLI:  ~/.gemini/tmp/*/chats/*.json (per-message token usage)
//  - Prime Agent: ~/.prime/agent/sessions + session-artifacts (see ./prime.ts)
//  - Amp / Goose / Qwen Code: read-only sources registered in
//    ./transcript-sources.ts (contract + matrix: docs/transcript-adapters.md)
//
// TODO-MERGE: CanonicalTokenRecord is declared locally (task spec shape:
// input/output/cacheRead/cacheWrite/reasoning + agent/sessionId/timestamp/model).
// src/core/types.ts now carries harness fields (inputTokens/outputTokens/
// cacheReadTokens/cacheWriteTokens/reasoningTokens/agent/model/timestamp) that
// match this module's semantics — input is uncached-only in both. Merge by
// replacing the local interface with the central one (adding sessionId) and
// deleting toCanonicalTokenRecord(); it bridges for now.

import type { CanonicalTokenRecord as CentralTokenRecord } from "../core/types.ts";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { z } from "zod";
import { isPrimeSessionFile, parsePrimeSession } from "./prime.ts";
import { copilotSessionStateRoot, isCopilotEventsFile, parseCopilotSession } from "./copilot.ts";
import { TRANSCRIPT_SOURCES, type TranscriptSourceAgent } from "./transcript-sources.ts";

// ---------------------------------------------------------------------------
// Canonical record
// ---------------------------------------------------------------------------

export interface CanonicalTokenRecord {
  source?: "transcript";
  sourcePath?: string;
  /** Which CLI agent produced the record. amp/goose/qwen are read-only
   * transcript sources (src/monitors/transcript-sources.ts). */
  agent: "claude" | "codex" | "gemini" | "amp" | "goose" | "qwen" | "cursor" | "prime" | "copilot";
  /** Session identifier when the source exposes one, else null. */
  sessionId: string | null;
  /** ISO-8601 timestamp when the source exposes one, else null. */
  timestamp: string | null;
  /** Model name when the source exposes one, else null. */
  model: string | null;
  /** Non-cached prompt tokens. */
  input: number;
  /** Completion tokens (reasoning is a subset, not additive). */
  output: number;
  /** Prompt tokens served from cache. */
  cacheRead: number;
  /** Prompt tokens written to cache. */
  cacheWrite: number;
  /**
   * 1h-TTL subset of cacheWrite (claude usage.cache_creation
   * .ephemeral_1h_input_tokens, issue #105). Absent when the source has no split.
   */
  cacheWrite1h?: number;
  /** Thinking/reasoning tokens (subset of output). */
  reasoning: number;
  /** Working directory the session ran in, when the source records it (claude line `cwd`, codex session_meta). */
  cwd?: string;
  /**
   * Vendor-metered cost in USD (copilot: AIU at $0.01). Present only when the
   * vendor stated one; token math is never a substitute (#23).
   */
  costUsd?: number;
  /** Producer extras carried to the central record (copilot: vendorMetered, credits = AIU, creditUnit). */
  extra?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Shared JSONL reader
// ---------------------------------------------------------------------------

async function* readJsonlLines(path: string): AsyncGenerator<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.replace(/^\uFEFF/, "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed);
    } catch {
      // Malformed line: skip, batch accounting must not die on one bad record.
    }
  }
}

// ---------------------------------------------------------------------------
// Claude Code transcripts
// ---------------------------------------------------------------------------

const ClaudeUsageSchema = z.object({
  input_tokens: z.number().nullish(),
  cache_creation_input_tokens: z.number().nullish(),
  cache_read_input_tokens: z.number().nullish(),
  output_tokens: z.number().nullish(),
  // Cache-write TTL split (issue #105); a non-object parses as absent so a
  // malformed split never drops the record.
  cache_creation: z.preprocess(
    (v) => (typeof v === "object" && v !== null && !Array.isArray(v) ? v : undefined),
    z.object({ ephemeral_1h_input_tokens: z.number().nullish() }).optional(),
  ),
  // usage.iterations[] (if present) is deliberately NOT declared: reading it
  // would double-count tokens already covered by the top-level fields.
  output_tokens_details: z
    .object({ thinking_tokens: z.number().nullish() })
    .nullish(),
});

const ClaudeMessageSchema = z.object({
  id: z.string().nullish(),
  model: z.string().nullish(),
  timestamp: z.string().nullish(),
  usage: ClaudeUsageSchema.nullish(),
});

const ClaudeLineSchema = z.object({
  type: z.string().nullish(),
  timestamp: z.string().nullish(),
  sessionId: z.string().nullish(),
  requestId: z.string().nullish(),
  cwd: z.string().nullish(),
  message: ClaudeMessageSchema.nullish(),
});

/**
 * Parse one Claude Code transcript (.jsonl) into canonical records.
 *
 * - Keeps only type=='assistant' lines whose message.usage is non-null.
 * - Dedupes on (message.id, requestId); a later line with the same key
 *   replaces the earlier one (streaming writes partial records).
 * - Never descends into usage.iterations[] (would double count).
 */
export async function parseClaudeTranscript(
  path: string,
): Promise<CanonicalTokenRecord[]> {
  const byKey = new Map<string, CanonicalTokenRecord>();
  for await (const raw of readJsonlLines(path)) {
    const line = ClaudeLineSchema.safeParse(raw);
    if (!line.success) continue;
    const rec = line.data;
    const msg = rec.message;
    if (rec.type !== "assistant" || !msg?.usage) continue;
    // Claude Code's locally generated messages (issue #116) carry no billable usage.
    if (msg.model === "<synthetic>") continue;
    const usage = msg.usage;
    const key = `${msg.id ?? ""}\u0000${rec.requestId ?? ""}`;
    byKey.set(key, {
      agent: "claude",
      sessionId: rec.sessionId ?? null,
      timestamp: rec.timestamp ?? msg.timestamp ?? null,
      model: msg.model ?? null,
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
      ...(typeof usage.cache_creation?.ephemeral_1h_input_tokens === "number"
        ? { cacheWrite1h: usage.cache_creation.ephemeral_1h_input_tokens }
        : {}),
      reasoning: usage.output_tokens_details?.thinking_tokens ?? 0,
      ...(rec.cwd ? { cwd: rec.cwd } : {}),
    });
  }
  return [...byKey.values()];
}

const SUBAGENT_FILE_RE = /^agent-.*\.jsonl$/;

/**
 * Parse a Claude Code session: the main `<sessionId>.jsonl` transcript plus,
 * when present, all `<sessionId>/subagents/agent-*.jsonl` files.
 */
export async function parseClaudeSession(
  dir: string,
  sessionId: string,
): Promise<CanonicalTokenRecord[]> {
  const records: CanonicalTokenRecord[] = [];
  const main = join(dir, `${sessionId}.jsonl`);
  if (existsSync(main)) {
    records.push(...(await parseClaudeTranscript(main)));
  }
  const subDir = join(dir, sessionId, "subagents");
  if (existsSync(subDir)) {
    const files = (await readdir(subDir))
      .filter((f) => SUBAGENT_FILE_RE.test(f))
      .sort();
    for (const f of files) {
      records.push(...(await parseClaudeTranscript(join(subDir, f))));
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// Codex CLI rollouts
// ---------------------------------------------------------------------------

const CodexLineSchema = z.object({
  type: z.string().nullish(),
  timestamp: z.string().nullish(),
  payload: z.unknown().optional(),
});

const CodexThreadSpawnSchema = z.object({
  parent_thread_id: z.string().nullish(),
  depth: z.number().nullish(),
});

const CodexSessionMetaPayloadSchema = z.object({
  id: z.string().nullish(),
  cwd: z.string().nullish(),
  timestamp: z.string().nullish(),
  parent_thread_id: z.string().nullish(),
  forked_from_id: z.string().nullish(),
  subagent_history_start_ordinal: z.number().int().nullish(),
  /** Spawn path of a sub-agent ("/root/<name>"); absent on a top-level session. */
  agent_path: z.string().nullish(),
  // `source` is a string ("cli", "exec", ...) for a top-level session and
  // {subagent:{thread_spawn:{parent_thread_id, depth}}} for a spawned child.
  source: z.unknown().optional(),
});

const CodexCountsSchema = z.object({
  input_tokens: z.number().nullish(),
  cached_input_tokens: z.number().nullish(),
  cache_write_input_tokens: z.number().nullish(),
  output_tokens: z.number().nullish(),
  reasoning_output_tokens: z.number().nullish(),
});

/** Legacy line: {type:"token_usage_record", payload:{thread_token_usage, usage?, turn_id?}}. */
const CodexTokenUsagePayloadSchema = z.object({
  thread_id: z.string().nullish(),
  turn_id: z.string().nullish(),
  thread_token_usage: CodexCountsSchema.extend({ thread_id: z.string().nullish() }).nullish(),
  usage: CodexCountsSchema.nullish(),
});

/** Modern line: {type:"event_msg", payload:{type:"token_count", info:{total_token_usage, last_token_usage, model_context_window}}}. */
const CodexTokenCountPayloadSchema = z.object({
  type: z.literal("token_count"),
  info: z
    .object({
      total_token_usage: CodexCountsSchema.nullish(),
      last_token_usage: CodexCountsSchema.nullish(),
      model_context_window: z.number().nullish(),
    })
    .nullish(),
});

const CodexTurnContextPayloadSchema = z.object({
  turn_id: z.string().nullish(),
  model: z.string().nullish(),
  effort: z.string().nullish(),
});

interface Cumulative {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

/**
 * Tokens of ONE model call from a native per-call usage object (modern
 * `last_token_usage`, legacy `usage`). Same convention as the record: `input`
 * is UNCACHED (cached_input_tokens subtracted), reasoning is inside output.
 */
export interface CodexCallTokens {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
}

/**
 * Codex-native provenance riding on a record's `extra.codex` (issues #140,
 * #142). Every field is optional: present only when the rollout stated it.
 */
export interface CodexRecordMeta {
  /** Which native line produced the counted delta. */
  format: "token_usage_record" | "token_count";
  /** Native turn the usage belongs to (turn_context / token_usage_record turn_id). */
  turnId?: string;
  /** Where `model` came from: the session's own turn_context (observed, never requested). */
  modelSource?: "turn_context";
  /** Observed reasoning effort from the same turn_context. */
  effort?: string;
  /** Latest model call's tokens (token_count `last_token_usage` or legacy `usage`). */
  lastCall?: CodexCallTokens;
  /** Context window the CLI stated for that call (token_count `model_context_window`). */
  contextWindow?: number;
  /** Provenance of contextWindow: stated natively by the rollout's token_count line. */
  contextWindowSource?: "token_count";
  /** Parent thread of a spawned child session (session_meta parent_thread_id / source.subagent.thread_spawn). */
  parentSessionId?: string;
  /** Spawn depth of a child session (source.subagent.thread_spawn.depth). */
  depth?: number;
  /** Session this one was forked from; its replayed history is never counted here. */
  forkedFromId?: string;
  /** Child threads this session spawned, discovered from its own events. */
  childSessionIds?: string[];
}

/** Session-level view of one rollout file (records plus the relationships around them). */
export interface CodexRolloutSession {
  sessionId: string | null;
  parentSessionId: string | null;
  forkedFromId: string | null;
  depth: number | null;
  /** Child thread ids discovered from this session's own (non-replayed) events. */
  childSessionIds: string[];
  /** Observed models / efforts from this session's own turn_context lines, first-seen order. */
  models: string[];
  efforts: string[];
  /** This session's own turns in order, with the model/effort each turn_context observed. */
  turns: Array<{ turnId: string; model?: string; effort?: string }>;
  /** Lines treated as replayed ancestor history (not counted, not attributed). */
  replayedLines: number;
  /** Usage snapshots seen per format, and snapshots skipped as repeats of an already counted total. */
  snapshots: { legacy: number; modern: number; repeated: number };
  records: CanonicalTokenRecord[];
}

function sameCumulative(a: Cumulative, b: Cumulative): boolean {
  return a.input === b.input && a.output === b.output && a.cacheRead === b.cacheRead && a.cacheWrite === b.cacheWrite && a.reasoning === b.reasoning;
}

/** A native snapshot field that is absent keeps the previous value (never resets to 0). */
function cumulativeOf(c: z.infer<typeof CodexCountsSchema>, prev: Cumulative | undefined): Cumulative {
  return {
    input: c.input_tokens ?? prev?.input ?? 0,
    output: c.output_tokens ?? prev?.output ?? 0,
    cacheRead: c.cached_input_tokens ?? prev?.cacheRead ?? 0,
    cacheWrite: c.cache_write_input_tokens ?? prev?.cacheWrite ?? 0,
    reasoning: c.reasoning_output_tokens ?? prev?.reasoning ?? 0,
  };
}

function callTokensOf(c: z.infer<typeof CodexCountsSchema>): CodexCallTokens {
  const cached = c.cached_input_tokens ?? 0;
  return {
    input: Math.max(0, (c.input_tokens ?? 0) - cached),
    cacheRead: cached,
    cacheWrite: c.cache_write_input_tokens ?? 0,
    output: c.output_tokens ?? 0,
    reasoning: c.reasoning_output_tokens ?? 0,
  };
}

/** Millisecond time of a UUIDv7 (codex thread/turn ids), else undefined. */
export function uuidV7Ms(id: string | null | undefined): number | undefined {
  if (typeof id !== "string") return undefined;
  const hex = id.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex) || hex[12] !== "7") return undefined;
  return parseInt(hex.slice(0, 12), 16);
}

/**
 * Child thread ids a codex event names as THIS session's sub-agents.
 * SubAgentActivity (item_completed item, or the event_msg form) also reports
 * activity of the session's own parent and siblings (a child "interacting"
 * with `/root`), so an id counts as a child only when its agent_path is a
 * strict descendant of this session's agent_path (`/root` for a top-level
 * session); a pathless report counts only when it is a spawn (`started`).
 * Structured fields only, never free text.
 */
function childIdsOf(payload: unknown, ownPath: string): string[] {
  if (payload === null || typeof payload !== "object") return [];
  const p = payload as Record<string, unknown>;
  const activity =
    p.type === "sub_agent_activity"
      ? p
      : p.type === "item_completed" && p.item !== null && typeof p.item === "object" && (p.item as Record<string, unknown>).type === "SubAgentActivity"
        ? (p.item as Record<string, unknown>)
        : undefined;
  if (activity === undefined) return [];
  const id = activity.agent_thread_id;
  if (typeof id !== "string" || id === "") return [];
  const path = activity.agent_path;
  if (typeof path === "string") return path.startsWith(`${ownPath.replace(/\/+$/, "")}/`) ? [id] : [];
  return activity.kind === "started" ? [id] : [];
}

/**
 * Parse one Codex rollout (.jsonl) into a session view: canonical records plus
 * parent/child relationships and observed model/effort (issues #140, #142).
 *
 * Usage: two native formats carry CUMULATIVE per-thread totals — legacy
 * `token_usage_record.thread_token_usage` and modern `event_msg`/`token_count`
 * `info.total_token_usage`. Real rollouts write both, usually with identical
 * totals one line apart, but they are NOT one counter: a context-compaction
 * call lands in the legacy total only, after which the modern total lags it
 * for the rest of the file. So exactly one format counts per file — legacy
 * when the file has any token_usage_record, else modern — and the other only
 * contributes per-call metadata (lastCall, contextWindow) to the latest
 * counted record. Each counted snapshot becomes a delta against the previous
 * one of its thread; a snapshot equal to the previous one is a repeat and is
 * never counted again. A counter that decreases (thread reset) clamps that
 * field's delta to 0.
 *
 * OpenAI accounting: input_tokens INCLUDES cached_input_tokens (same rule as
 * src/core/normalize.ts), so cached is subtracted to keep canonical input
 * uncached-only; reasoning is a subset of output and is never added to it.
 *
 * Identity: the FIRST session_meta is this session. A spawned/forked child
 * replays its ancestor's history first (the parent's session_meta and
 * turn_context, and for a fork its cumulative token snapshots). Those lines
 * are never attributed here: their snapshots only seed the baseline, and
 * their models/children belong to the parent. The replay ends after
 * `subagent_history_start_ordinal` lines when the CLI states it, else (a
 * fork without it) at the first task_started whose UUIDv7 turn id postdates
 * this session's creation.
 */
export async function parseCodexRolloutSession(path: string): Promise<CodexRolloutSession> {
  const lastByThread = new Map<string, Cumulative>();
  const lastRecordByThread = new Map<string, CanonicalTokenRecord>();
  const turns = new Map<string, { model?: string; effort?: string }>();
  const session: CodexRolloutSession = {
    sessionId: null,
    parentSessionId: null,
    forkedFromId: null,
    depth: null,
    childSessionIds: [],
    models: [],
    efforts: [],
    turns: [],
    replayedLines: 0,
    snapshots: { legacy: 0, modern: 0, repeated: 0 },
    records: [],
  };
  const children = new Set<string>();
  let cwd: string | undefined;
  let ownPath = "/root";
  let currentTurn: string | undefined;
  let current: { model?: string; effort?: string } = {};
  // Replay state (child/fork sessions only).
  let replayThroughIndex = -1;
  let replayUntilOwnTurnAfterMs: number | undefined;
  let index = -1;

  const metaOf = (): Partial<CodexRecordMeta> => ({
    ...(session.parentSessionId ? { parentSessionId: session.parentSessionId } : {}),
    ...(session.depth !== null ? { depth: session.depth } : {}),
    ...(session.forkedFromId ? { forkedFromId: session.forkedFromId } : {}),
  });

  const lines: unknown[] = [];
  for await (const raw of readJsonlLines(path)) lines.push(raw);
  // Format preference (see above): legacy counts whenever the file has it.
  const countedFormat: CodexRecordMeta["format"] = lines.some(
    (l) => l !== null && typeof l === "object" && (l as { type?: unknown }).type === "token_usage_record",
  )
    ? "token_usage_record"
    : "token_count";

  for (const raw of lines) {
    index += 1;
    const line = CodexLineSchema.safeParse(raw);
    if (!line.success) continue;
    const { type, timestamp, payload } = line.data;
    const p = (payload !== null && typeof payload === "object" ? payload : {}) as Record<string, unknown>;

    // ---- identity: the first session_meta is this session; later ones are replayed ancestors.
    if (type === "session_meta") {
      if (session.sessionId !== null) {
        session.replayedLines += 1;
        continue;
      }
      const meta = CodexSessionMetaPayloadSchema.safeParse(payload);
      if (!meta.success) continue;
      const m = meta.data;
      if (m.id) session.sessionId = m.id;
      if (m.cwd) cwd = m.cwd;
      if (m.agent_path) ownPath = m.agent_path;
      const spawn =
        m.source !== null && typeof m.source === "object"
          ? CodexThreadSpawnSchema.safeParse(((m.source as Record<string, unknown>).subagent as Record<string, unknown> | undefined)?.thread_spawn)
          : undefined;
      const parent = m.parent_thread_id ?? (spawn?.success ? spawn.data.parent_thread_id : null) ?? null;
      if (parent) session.parentSessionId = parent;
      if (spawn?.success && typeof spawn.data.depth === "number") session.depth = spawn.data.depth;
      if (m.forked_from_id) session.forkedFromId = m.forked_from_id;
      if (typeof m.subagent_history_start_ordinal === "number") {
        replayThroughIndex = index + m.subagent_history_start_ordinal;
      } else if (m.forked_from_id) {
        const created = m.timestamp ? Date.parse(m.timestamp) : timestamp ? Date.parse(timestamp) : NaN;
        replayUntilOwnTurnAfterMs = Number.isFinite(created) ? created : undefined;
        if (replayUntilOwnTurnAfterMs === undefined) replayUntilOwnTurnAfterMs = Number.NEGATIVE_INFINITY;
      }
      continue;
    }

    // ---- replay boundary
    if (replayUntilOwnTurnAfterMs !== undefined && type === "event_msg" && p.type === "task_started") {
      const turnMs = uuidV7Ms(typeof p.turn_id === "string" ? p.turn_id : undefined);
      // An id we cannot date ends the replay: under-claiming the parent's
      // history is safer than silently counting it twice.
      if (turnMs === undefined || turnMs >= replayUntilOwnTurnAfterMs) replayUntilOwnTurnAfterMs = undefined;
    }
    const replayed = index <= replayThroughIndex || replayUntilOwnTurnAfterMs !== undefined;
    if (replayed) session.replayedLines += 1;

    // ---- observed model / effort (own turns only)
    if (type === "turn_context") {
      if (replayed) continue;
      const ctx = CodexTurnContextPayloadSchema.safeParse(payload);
      if (!ctx.success) continue;
      current = {
        ...(ctx.data.model ? { model: ctx.data.model } : {}),
        ...(ctx.data.effort ? { effort: ctx.data.effort } : {}),
      };
      if (ctx.data.turn_id) {
        currentTurn = ctx.data.turn_id;
        if (!turns.has(ctx.data.turn_id)) session.turns.push({ turnId: ctx.data.turn_id, ...current });
        turns.set(ctx.data.turn_id, current);
      }
      if (current.model && !session.models.includes(current.model)) session.models.push(current.model);
      if (current.effort && !session.efforts.includes(current.effort)) session.efforts.push(current.effort);
      continue;
    }

    if (type === "event_msg" && !replayed) {
      for (const id of childIdsOf(payload, ownPath)) if (id !== session.sessionId) children.add(id);
    }

    // ---- usage snapshots (both formats feed one cumulative tracker per thread)
    let snapshot: z.infer<typeof CodexCountsSchema> | null | undefined;
    let call: z.infer<typeof CodexCountsSchema> | null | undefined;
    let window: number | undefined;
    let threadKey: string;
    let turnId: string | undefined;
    let format: CodexRecordMeta["format"];
    if (type === "token_usage_record") {
      const parsed = CodexTokenUsagePayloadSchema.safeParse(payload);
      if (!parsed.success || !parsed.data.thread_token_usage) continue;
      snapshot = parsed.data.thread_token_usage;
      call = parsed.data.usage;
      threadKey = parsed.data.thread_token_usage.thread_id ?? parsed.data.thread_id ?? session.sessionId ?? "default";
      turnId = parsed.data.turn_id ?? undefined;
      format = "token_usage_record";
      if (!replayed) session.snapshots.legacy += 1;
    } else if (type === "event_msg" && p.type === "token_count") {
      const parsed = CodexTokenCountPayloadSchema.safeParse(payload);
      const info = parsed.success ? parsed.data.info : undefined;
      if (!info?.total_token_usage) continue;
      snapshot = info.total_token_usage;
      call = info.last_token_usage;
      window = typeof info.model_context_window === "number" && info.model_context_window > 0 ? info.model_context_window : undefined;
      threadKey = session.sessionId ?? "default";
      turnId = currentTurn;
      format = "token_count";
      if (!replayed) session.snapshots.modern += 1;
    } else {
      continue;
    }

    const callMeta: Partial<CodexRecordMeta> = {
      ...(call ? { lastCall: callTokensOf(call) } : {}),
      ...(window !== undefined ? { contextWindow: window, contextWindowSource: "token_count" as const } : {}),
    };
    const counts = format === countedFormat;
    const prev = counts ? lastByThread.get(threadKey) : undefined;
    const cur = counts ? cumulativeOf(snapshot, prev) : undefined;
    if (counts) lastByThread.set(threadKey, cur!);
    // Replayed ancestor snapshots only seed the baseline (a fork's counter continues from them).
    if (replayed) continue;

    if (!counts || (prev !== undefined && sameCumulative(prev, cur!))) {
      // The non-counting format, or a repeat of an already counted total:
      // enrich the latest counted record, never count again.
      if (counts) session.snapshots.repeated += 1;
      const last = lastRecordByThread.get(counts ? threadKey : session.sessionId ?? "default") ?? session.records.at(-1);
      const meta = last?.extra?.codex as CodexRecordMeta | undefined;
      if (meta) {
        if (meta.lastCall === undefined && callMeta.lastCall) meta.lastCall = callMeta.lastCall;
        if (meta.contextWindow === undefined && callMeta.contextWindow !== undefined) {
          meta.contextWindow = callMeta.contextWindow;
          meta.contextWindowSource = "token_count";
        }
        if (meta.turnId === undefined && turnId !== undefined) meta.turnId = turnId;
      }
      continue;
    }

    const now = cur!;
    const delta: Cumulative = prev
      ? {
          input: Math.max(0, now.input - prev.input),
          output: Math.max(0, now.output - prev.output),
          cacheRead: Math.max(0, now.cacheRead - prev.cacheRead),
          cacheWrite: Math.max(0, now.cacheWrite - prev.cacheWrite),
          reasoning: Math.max(0, now.reasoning - prev.reasoning),
        }
      : now;

    const turn = (turnId !== undefined ? turns.get(turnId) : undefined) ?? current;
    const meta: CodexRecordMeta = {
      format,
      ...(turnId !== undefined ? { turnId } : {}),
      ...(turn.model ? { modelSource: "turn_context" as const } : {}),
      ...(turn.effort ? { effort: turn.effort } : {}),
      ...callMeta,
      ...metaOf(),
    };
    const record: CanonicalTokenRecord = {
      agent: "codex",
      sessionId: session.sessionId,
      timestamp: timestamp ?? null,
      model: turn.model ?? null,
      input: Math.max(0, delta.input - delta.cacheRead),
      output: delta.output,
      cacheRead: delta.cacheRead,
      cacheWrite: delta.cacheWrite,
      reasoning: delta.reasoning,
      ...(cwd ? { cwd } : {}),
      extra: { codex: meta },
    };
    session.records.push(record);
    lastRecordByThread.set(threadKey, record);
  }

  session.childSessionIds = [...children];
  if (session.childSessionIds.length > 0) {
    for (const r of session.records) (r.extra!.codex as CodexRecordMeta).childSessionIds = session.childSessionIds;
  }
  return session;
}

/** Parse one Codex rollout (.jsonl) into canonical records (see parseCodexRolloutSession). */
export async function parseCodexRollout(
  path: string,
): Promise<CanonicalTokenRecord[]> {
  return (await parseCodexRolloutSession(path)).records;
}

// ---------------------------------------------------------------------------
// Codex parent/child reconciliation (#142)
// ---------------------------------------------------------------------------

/** Token totals in canonical lanes (input uncached-only; reasoning inside output). */
export interface CodexTokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

/** One session's usage as the reconciler sees it. */
export interface CodexSessionUsage {
  sessionId: string;
  parentSessionId?: string | null;
  childSessionIds?: string[];
  tokens: CodexTokenTotals;
  records: number;
}

/**
 * Accounting scope of one root session tree:
 * - `session`: no child session was discovered; the root's own usage is the whole.
 * - `parent-only`: children exist but none of their usage was found.
 * - `child-inclusive`: the total includes at least one child's usage.
 */
export type CodexAccountingScope = "session" | "parent-only" | "child-inclusive";

export interface CodexAccountingRoot {
  rootSessionId: string;
  /** False when a child names a parent whose usage was not found: the root's own usage is unknown. */
  rootFound: boolean;
  /** Every descendant id discovered from either side (parent events or child session_meta). */
  childSessionIds: string[];
  countedChildSessionIds: string[];
  /** Discovered children with no usage found: their usage is UNKNOWN, not zero. */
  missingChildSessionIds: string[];
  scope: CodexAccountingScope;
  /** True only when the root and every discovered child were found. */
  complete: boolean;
  /** Sum over the sessions found (each counted once). */
  tokens: CodexTokenTotals;
}

export interface CodexAccounting {
  roots: CodexAccountingRoot[];
  summary: {
    roots: number;
    complete: number;
    partial: number;
    scopes: Record<CodexAccountingScope, number>;
    childSessions: number;
    countedChildSessions: number;
    missingChildSessions: number;
    missingRootSessions: number;
  };
}

function zeroTotals(): CodexTokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

function addTotals(a: CodexTokenTotals, b: CodexTokenTotals): void {
  a.input += b.input;
  a.output += b.output;
  a.cacheRead += b.cacheRead;
  a.cacheWrite += b.cacheWrite;
  a.reasoning += b.reasoning;
}

/**
 * Reconcile codex sessions into root trees (#142). Each session's usage is
 * counted once (sessions sharing an id are merged); a child's total never
 * includes its parent's replayed history (parseCodexRolloutSession drops it),
 * so summing the tree double-counts nothing. A tree is `complete` only when
 * the root and every discovered child were found; missing children are
 * listed, never zero-filled.
 */
export function reconcileCodexSessions(sessions: Iterable<CodexSessionUsage>): CodexAccounting {
  const byId = new Map<string, CodexSessionUsage>();
  for (const s of sessions) {
    const prev = byId.get(s.sessionId);
    if (prev === undefined) {
      byId.set(s.sessionId, { ...s, tokens: { ...s.tokens }, childSessionIds: [...(s.childSessionIds ?? [])] });
      continue;
    }
    addTotals(prev.tokens, s.tokens);
    prev.records += s.records;
    prev.parentSessionId = prev.parentSessionId ?? s.parentSessionId;
    for (const c of s.childSessionIds ?? []) if (!prev.childSessionIds!.includes(c)) prev.childSessionIds!.push(c);
  }
  const parentOf = new Map<string, string>();
  const kids = new Map<string, Set<string>>();
  const link = (parent: string, child: string): void => {
    if (parent === child) return;
    if (!parentOf.has(child)) parentOf.set(child, parent);
    let set = kids.get(parent);
    if (!set) kids.set(parent, (set = new Set()));
    set.add(child);
  };
  for (const s of byId.values()) {
    if (s.parentSessionId) link(s.parentSessionId, s.sessionId);
    for (const c of s.childSessionIds ?? []) link(s.sessionId, c);
  }
  const rootOf = (id: string): string => {
    const seen = new Set<string>();
    let cur = id;
    while (parentOf.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = parentOf.get(cur)!;
    }
    return cur;
  };
  const rootIds = new Set<string>();
  for (const id of byId.keys()) rootIds.add(rootOf(id));

  const roots: CodexAccountingRoot[] = [];
  for (const rootId of [...rootIds].sort()) {
    const descendants: string[] = [];
    const queue = [...(kids.get(rootId) ?? [])];
    const seen = new Set<string>([rootId]);
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      descendants.push(id);
      queue.push(...(kids.get(id) ?? []));
    }
    const tokens = zeroTotals();
    const rootFound = byId.has(rootId);
    if (rootFound) addTotals(tokens, byId.get(rootId)!.tokens);
    const counted: string[] = [];
    const missing: string[] = [];
    for (const id of descendants) {
      const s = byId.get(id);
      if (s === undefined) missing.push(id);
      else {
        counted.push(id);
        addTotals(tokens, s.tokens);
      }
    }
    const scope: CodexAccountingScope = descendants.length === 0 ? "session" : counted.length === 0 ? "parent-only" : "child-inclusive";
    roots.push({
      rootSessionId: rootId,
      rootFound,
      childSessionIds: descendants,
      countedChildSessionIds: counted,
      missingChildSessionIds: missing,
      scope,
      complete: rootFound && missing.length === 0,
      tokens,
    });
  }
  const scopes: Record<CodexAccountingScope, number> = { session: 0, "parent-only": 0, "child-inclusive": 0 };
  for (const r of roots) scopes[r.scope] += 1;
  return {
    roots,
    summary: {
      roots: roots.length,
      complete: roots.filter((r) => r.complete).length,
      partial: roots.filter((r) => !r.complete).length,
      scopes,
      childSessions: roots.reduce((n, r) => n + r.childSessionIds.length, 0),
      countedChildSessions: roots.reduce((n, r) => n + r.countedChildSessionIds.length, 0),
      missingChildSessions: roots.reduce((n, r) => n + r.missingChildSessionIds.length, 0),
      missingRootSessions: roots.filter((r) => !r.rootFound).length,
    },
  };
}

/**
 * Group codex records (parseCodexRollout / scanAll rows, read via
 * `extra.codex`) into per-session usage for reconcileCodexSessions. Records
 * without a session id are skipped: they cannot join a tree.
 */
export function codexSessionUsageFromRecords(
  records: Iterable<{ agent: string; sessionId?: string | null; input?: number; inputTokens?: number; output?: number; outputTokens?: number; cacheRead?: number; cacheReadTokens?: number; cacheWrite?: number; cacheWriteTokens?: number; reasoning?: number; reasoningTokens?: number; extra?: Record<string, unknown> }>,
): CodexSessionUsage[] {
  const out = new Map<string, CodexSessionUsage>();
  for (const r of records) {
    if (r.agent !== "codex" || !r.sessionId || r.sessionId === "unknown") continue;
    let s = out.get(r.sessionId);
    if (!s) out.set(r.sessionId, (s = { sessionId: r.sessionId, parentSessionId: null, childSessionIds: [], tokens: zeroTotals(), records: 0 }));
    s.records += 1;
    s.tokens.input += r.input ?? r.inputTokens ?? 0;
    s.tokens.output += r.output ?? r.outputTokens ?? 0;
    s.tokens.cacheRead += r.cacheRead ?? r.cacheReadTokens ?? 0;
    s.tokens.cacheWrite += r.cacheWrite ?? r.cacheWriteTokens ?? 0;
    s.tokens.reasoning += r.reasoning ?? r.reasoningTokens ?? 0;
    const meta = r.extra?.codex as CodexRecordMeta | undefined;
    if (meta?.parentSessionId) s.parentSessionId = meta.parentSessionId;
    for (const c of meta?.childSessionIds ?? []) if (!s.childSessionIds!.includes(c)) s.childSessionIds!.push(c);
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------
// Gemini CLI chats
// ---------------------------------------------------------------------------

const GeminiChatSchema = z.object({
  messages: z
    .array(
      z.object({
        model: z.string().nullish(),
        timestamp: z.string().nullish(),
        tokens: z
          .object({
            input: z.number().nullish(),
            output: z.number().nullish(),
            cached: z.number().nullish(),
            thoughts: z.number().nullish(),
          })
          .nullish(),
      }),
    )
    .nullish(),
});

/**
 * Parse one Gemini CLI chat file (~/.gemini/tmp/<hash>/chats/<id>.json).
 *
 * tokens.cached is a subset of tokens.input, so it maps to cacheRead and is
 * subtracted from input to avoid double counting. sessionId is the chat file
 * stem; cacheWrite does not exist in the Gemini usage model and stays 0.
 */
export async function parseGeminiChat(
  path: string,
): Promise<CanonicalTokenRecord[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return [];
  }
  const parsed = GeminiChatSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.messages) return [];

  const records: CanonicalTokenRecord[] = [];
  for (const msg of parsed.data.messages) {
    if (!msg.tokens) continue;
    const cached = msg.tokens.cached ?? 0;
    const totalInput = msg.tokens.input ?? 0;
    records.push({
      agent: "gemini",
      sessionId: basename(path, extname(path)),
      timestamp: msg.timestamp ?? null,
      model: msg.model ?? null,
      input: Math.max(0, totalInput - cached),
      output: msg.tokens.output ?? 0,
      cacheRead: cached,
      cacheWrite: 0,
      reasoning: msg.tokens.thoughts ?? 0,
    });
  }
  return records;
}

// ---------------------------------------------------------------------------
// scanAll
// ---------------------------------------------------------------------------

export interface ScanOptions {
  /** Claude projects dir containing *.jsonl transcripts. */
  claudeDir?: string;
  /** Codex sessions dir containing rollout *.jsonl files. */
  codexDir?: string;
  /** Gemini tmp dir containing <hash>/chats/*.json files. */
  geminiDir?: string;
  /** Prime Agent dir (~/.prime/agent) holding sessions/ and session-artifacts/. */
  primeDir?: string;
  /** Copilot CLI session-state dir (${COPILOT_HOME:-~/.copilot}/session-state) holding <id>/events.jsonl. */
  copilotDir?: string;
  /** Root overrides for the read-only sources in TRANSCRIPT_SOURCES
   * (amp/goose/qwen); an omitted agent uses its defaultRoots(homedir()). */
  sourceRoots?: Partial<Record<TranscriptSourceAgent, string[]>>;
}

export async function walkFiles(
  dir: string,
  keep: (filePath: string) => boolean,
): Promise<string[]> {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries;
    try {
      entries = await readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && keep(full)) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

function isJsonl(filePath: string): boolean {
  return extname(filePath) === ".jsonl";
}

function isGeminiChatFile(filePath: string): boolean {
  return extname(filePath) === ".json" && basename(dirname(filePath)) === "chats";
}

/** One machine transcript source: root dir, file filter, per-file parser. */
export interface TranscriptSource {
  agent: CanonicalTokenRecord["agent"];
  dir: string;
  keep: (filePath: string) => boolean;
  parse: (filePath: string) => Promise<CanonicalTokenRecord[]>;
}

/**
 * The native (launchable) transcript sources: one entry per CLI, with the
 * ScanOptions key that overrides its root and its root under a home-shaped
 * dir. Together with TRANSCRIPT_SOURCES (read-only sources) this is the ONE
 * registry scanAll, `ach watch`, `ach archive` and the `--agent` validation
 * of `ach stats` / `ach archive` derive from (tests/transcript-source-registry.test.ts).
 */
const NATIVE_TRANSCRIPT_SOURCES = [
  { agent: "claude", option: "claudeDir", root: (home: string) => join(home, ".claude", "projects"), keep: isJsonl, parse: parseClaudeTranscript },
  { agent: "codex", option: "codexDir", root: (home: string) => join(home, ".codex", "sessions"), keep: isJsonl, parse: parseCodexRollout },
  { agent: "gemini", option: "geminiDir", root: (home: string) => join(home, ".gemini", "tmp"), keep: isGeminiChatFile, parse: parseGeminiChat },
  { agent: "prime", option: "primeDir", root: (home: string) => join(home, ".prime", "agent"), keep: isPrimeSessionFile, parse: parsePrimeSession },
  // #23: launchable (ach run --agent copilot) AND monitored, like prime. $COPILOT_HOME relocates it.
  { agent: "copilot", option: "copilotDir", root: copilotSessionStateRoot, keep: isCopilotEventsFile, parse: parseCopilotSession },
] as const satisfies ReadonlyArray<{
  agent: CanonicalTokenRecord["agent"];
  option: "claudeDir" | "codexDir" | "geminiDir" | "primeDir" | "copilotDir";
  root: (home: string) => string;
  keep: (filePath: string) => boolean;
  parse: (filePath: string) => Promise<CanonicalTokenRecord[]>;
}>;

/** Every agent with machine transcripts ach reads, native first, then read-only. */
export function transcriptAgentNames(): string[] {
  return [...NATIVE_TRANSCRIPT_SOURCES.map((s) => s.agent), ...TRANSCRIPT_SOURCES.map((s) => s.agent)];
}

/**
 * The machine transcript sources scanAll walks, with ScanOptions overrides
 * applied (defaults: ~/.claude/projects, ~/.codex/sessions, ~/.gemini/tmp,
 * ~/.prime/agent, then each read-only source's defaultRoots). Shared with the warehouse
 * (src/core/warehouse.ts) so `ach archive` snapshots exactly the files
 * `ach stats` reads, and with `ach watch`.
 */
export function transcriptSources(opts: ScanOptions = {}): TranscriptSource[] {
  return [
    ...NATIVE_TRANSCRIPT_SOURCES.map((src) => ({
      agent: src.agent,
      dir: opts[src.option] ?? src.root(homedir()),
      keep: src.keep,
      parse: src.parse,
    })),
    ...TRANSCRIPT_SOURCES.flatMap((src) =>
      (opts.sourceRoots?.[src.agent as TranscriptSourceAgent] ?? src.defaultRoots(homedir())).map((dir) => ({ ...src, dir }))),
  ];
}

/** ScanOptions for a home-shaped root (<root>/.claude/projects, ...): every registry source re-rooted. */
export function scanOptionsForRoot(root: string): Required<ScanOptions> {
  const native = Object.fromEntries(NATIVE_TRANSCRIPT_SOURCES.map((src) => [src.option, src.root(root)])) as Pick<
    Required<ScanOptions>,
    "claudeDir" | "codexDir" | "geminiDir" | "primeDir" | "copilotDir"
  >;
  return {
    ...native,
    // #22 read-only sources resolve under the same home-shaped root.
    sourceRoots: Object.fromEntries(TRANSCRIPT_SOURCES.map((src) => [src.agent, src.defaultRoots(root)])) as Partial<
      Record<TranscriptSourceAgent, string[]>
    >,
  };
}

/**
 * Yield canonical token records from every Claude, Codex, and Gemini
 * transcript on the machine, then every read-only source in
 * TRANSCRIPT_SOURCES (amp, goose, qwen). Files are walked depth-first in
 * sorted order; missing or unreadable directories are skipped silently.
 * Records a read-only parser could not read are skipped and reported via
 * drainTranscriptWarnings() (./transcript-warnings.ts).
 */
export async function* scanAll(
  opts: ScanOptions = {},
): AsyncGenerator<CanonicalTokenRecord> {
  const sources = transcriptSources(opts);
  const seenFiles = new Set<string>();

  for (const { dir, keep, parse } of sources) {
    for (const file of await walkFiles(dir, keep)) {
      if (seenFiles.has(file)) continue;
      seenFiles.add(file);
      for (const record of await parse(file)) {
        yield { ...record, source: "transcript", sourcePath: file };
      }
    }
  }
}

/**
 * Bridge a monitor record to the central CanonicalTokenRecord shape in
 * src/core/types.ts. input is already uncached-only on both sides, so it maps
 * straight to inputTokens; sessionId rides the central record's sessionId
 * field (added at merge), and the ISO timestamp travels in `extra`.
 */
export function toCanonicalTokenRecord(
  record: CanonicalTokenRecord,
): CentralTokenRecord {
  const ts = record.timestamp ? Date.parse(record.timestamp) : NaN;
  return {
    agent: record.agent,
    sessionId: record.sessionId,
    model: record.model ?? undefined,
    inputTokens: record.input,
    outputTokens: record.output,
    cacheReadTokens: record.cacheRead,
    cacheWriteTokens: record.cacheWrite,
    ...(record.cacheWrite1h !== undefined ? { cacheWrite1hTokens: record.cacheWrite1h } : {}),
    reasoningTokens: record.reasoning,
    ...(Number.isFinite(ts) ? { timestamp: ts } : {}),
    ...(record.costUsd !== undefined ? { costUsd: record.costUsd } : {}),
    extra: { ...record.extra, timestampIso: record.timestamp },
  };
}
