// Batch token accounting from CLI transcript files (ccusage-style).
//
// Sources:
//  - Claude Code: ~/.claude/projects/**/*.jsonl (assistant message usage)
//  - Codex CLI:   ~/.codex/sessions/**/rollout-*.jsonl (cumulative token_usage_record)
//  - Gemini CLI:  ~/.gemini/tmp/*/chats/*.json (per-message token usage)
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

// ---------------------------------------------------------------------------
// Canonical record
// ---------------------------------------------------------------------------

export interface CanonicalTokenRecord {
  /** Which CLI agent produced the record. */
  agent: "claude" | "codex" | "gemini";
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
  /** Thinking/reasoning tokens (subset of output). */
  reasoning: number;
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
      reasoning: usage.output_tokens_details?.thinking_tokens ?? 0,
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

const CodexSessionMetaPayloadSchema = z.object({
  id: z.string().nullish(),
});

const CodexTokenUsagePayloadSchema = z.object({
  thread_token_usage: z
    .object({
      thread_id: z.string().nullish(),
      input_tokens: z.number().nullish(),
      cached_input_tokens: z.number().nullish(),
      cache_write_input_tokens: z.number().nullish(),
      output_tokens: z.number().nullish(),
      reasoning_output_tokens: z.number().nullish(),
    })
    .nullish(),
});

interface Cumulative {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

/**
 * Parse one Codex rollout (.jsonl) into canonical records.
 *
 * payload.thread_token_usage is CUMULATIVE per thread; records are deltas
 * against the last seen cumulative for that thread. The first record of a
 * thread yields its full cumulative value. If a counter ever decreases
 * (thread reset), the negative delta is clamped to 0 per field.
 *
 * OpenAI accounting: input_tokens INCLUDES cached_input_tokens (same rule as
 * src/core/normalize.ts), so cached is subtracted from the input delta to
 * keep canonical input uncached-only.
 */
export async function parseCodexRollout(
  path: string,
): Promise<CanonicalTokenRecord[]> {
  const lastByThread = new Map<string, Cumulative>();
  let sessionId: string | null = null;
  const records: CanonicalTokenRecord[] = [];

  for await (const raw of readJsonlLines(path)) {
    const line = CodexLineSchema.safeParse(raw);
    if (!line.success) continue;
    const { type, timestamp, payload } = line.data;

    if (type === "session_meta") {
      const meta = CodexSessionMetaPayloadSchema.safeParse(payload);
      if (meta.success && meta.data.id) sessionId = meta.data.id;
      continue;
    }
    if (type !== "token_usage_record") continue;

    const parsed = CodexTokenUsagePayloadSchema.safeParse(payload);
    const usage = parsed.success ? parsed.data.thread_token_usage : undefined;
    if (!usage) continue;

    const key = usage.thread_id ?? "default";
    const current: Cumulative = {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cached_input_tokens ?? 0,
      cacheWrite: usage.cache_write_input_tokens ?? 0,
      reasoning: usage.reasoning_output_tokens ?? 0,
    };
    const prev = lastByThread.get(key);
    const delta: Cumulative = prev
      ? {
          input: Math.max(0, current.input - prev.input),
          output: Math.max(0, current.output - prev.output),
          cacheRead: Math.max(0, current.cacheRead - prev.cacheRead),
          cacheWrite: Math.max(0, current.cacheWrite - prev.cacheWrite),
          reasoning: Math.max(0, current.reasoning - prev.reasoning),
        }
      : current;
    lastByThread.set(key, current);

    records.push({
      agent: "codex",
      sessionId,
      timestamp: timestamp ?? null,
      model: null,
      input: Math.max(0, delta.input - delta.cacheRead),
      output: delta.output,
      cacheRead: delta.cacheRead,
      cacheWrite: delta.cacheWrite,
      reasoning: delta.reasoning,
    });
  }
  return records;
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
}

async function walkFiles(
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

/**
 * Yield canonical token records from every Claude, Codex, and Gemini
 * transcript on the machine. Files are walked depth-first in sorted order;
 * missing or unreadable directories are skipped silently.
 */
export async function* scanAll(
  opts: ScanOptions = {},
): AsyncGenerator<CanonicalTokenRecord> {
  const claudeDir = opts.claudeDir ?? join(homedir(), ".claude", "projects");
  const codexDir = opts.codexDir ?? join(homedir(), ".codex", "sessions");
  const geminiDir = opts.geminiDir ?? join(homedir(), ".gemini", "tmp");

  const sources: Array<[string, (filePath: string) => boolean, (p: string) => Promise<CanonicalTokenRecord[]>]> = [
    [claudeDir, isJsonl, parseClaudeTranscript],
    [codexDir, isJsonl, parseCodexRollout],
    [geminiDir, isGeminiChatFile, parseGeminiChat],
  ];

  for (const [dir, keep, parse] of sources) {
    for (const file of await walkFiles(dir, keep)) {
      for (const record of await parse(file)) {
        yield record;
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
    reasoningTokens: record.reasoning,
    ...(Number.isFinite(ts) ? { timestamp: ts } : {}),
    extra: { timestampIso: record.timestamp },
  };
}
