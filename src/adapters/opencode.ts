import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import type { AdapterCapabilities, CanonicalEvent, CanonicalTokenRecord, RunOptions } from './types.ts';
import type {
  AgentAdapter as CoreAgentAdapter,
  AgentHandle as CoreAgentHandle,
  RunSpec as CoreRunSpec,
} from '../core/types.js';
import {
  runJsonlCli,
  launchDriverHandle,
  houseEventToCore,
  takeOnOutput,
  type HouseEventLike,
  LineAssembler,
  EventQueue,
  type SpawnFn,
} from './shared.ts';

// The `step` variant and `usage.cost` now live on CanonicalEvent itself
// (src/adapters/types.ts); OpenCodeRunHandle is therefore structurally
// compatible with the adapter-lane RunHandle contract.

export const OPENCODE_CAPABILITIES: AdapterCapabilities = {
  headless: true,
  streaming: true,
  resume: true,
  acp: true,
  tmuxFallback: true,
};

const DEFAULT_SERVER_URL = 'http://127.0.0.1:4096';

// ---------------------------------------------------------------------------
// Native wire schemas (recorded from `opencode run --format json`, v1.18.30).
// Envelope: {"type":"step_start"|"text"|"step_finish", timestamp, sessionID,
// part:{...}}; part types use dashes ("step-start"). Unknown envelope types
// (tool, reasoning, ...) are skipped but still yield their sessionID.
// ---------------------------------------------------------------------------

const opencodeEnvelopeSchema = z.object({
  type: z.string(),
  sessionID: z.string().nullish(),
  part: z.unknown(),
});

const tokenCacheSchema = z.object({
  read: z.number().nullish(),
  write: z.number().nullish(),
});

const opencodeTokensSchema = z.object({
  total: z.number().nullish(),
  input: z.number().nullish(),
  output: z.number().nullish(),
  reasoning: z.number().nullish(),
  cache: tokenCacheSchema.nullish(),
});

const stepStartPartSchema = z.object({ type: z.literal('step-start') }).passthrough();

const textPartSchema = z
  .object({
    type: z.literal('text'),
    text: z.string(),
  })
  .passthrough();

const stepFinishPartSchema = z
  .object({
    type: z.literal('step-finish'),
    reason: z.string().nullish(),
    tokens: opencodeTokensSchema,
    cost: z.number().nullish(),
  })
  .passthrough();

type OpencodeTokens = z.infer<typeof opencodeTokensSchema>;

// CanonicalEvent now carries the opencode `step` variant and `usage.cost`
// (the former TODO-MERGE gap); OpencodeEvent remains as a compat alias.
export type OpencodeEvent = CanonicalEvent;

export interface OpencodeRunResult {
  exitCode: number;
  sessionId?: string;
  usage?: CanonicalTokenRecord;
  cost?: number;
}

export interface OpencodeRunHandle {
  /** Canonical event stream; completes when the run ends. */
  events: AsyncIterable<OpencodeEvent>;
  /** Resolves with the exit code (0 for clean server runs, -1 on signal). */
  wait(): Promise<number>;
  /** Kill the child (SIGTERM, then SIGKILL after a grace period). */
  abort(): void;
  /** Resolves once the run ends with the captured sessionID (for resume). */
  sessionId(): Promise<string | undefined>;
  /** Full exit state: exit code plus captured sessionId/usage/cost. */
  result(): Promise<OpencodeRunResult>;
}

export interface ParsedOpencodeLine {
  events: OpencodeEvent[];
  /** sessionID from the envelope or part, on every event line that carries one. */
  sessionId?: string;
}

function mapTokens(tokens: OpencodeTokens, cost: number | null | undefined): CanonicalTokenRecord {
  return {
    inputTokens: tokens.input ?? 0,
    cacheReadTokens: tokens.cache?.read ?? 0,
    cacheWriteTokens: tokens.cache?.write ?? 0,
    outputTokens: tokens.output ?? 0,
    reasoningTokens: tokens.reasoning ?? null,
    totalTokens: tokens.total ?? null,
    durationMs: null,
    raw: { tokens, cost: cost ?? 0 },
  };
}

/**
 * Map one native opencode part to canonical events. Shared by the NDJSON
 * parser and the `opencode serve` HTTP path (both emit the same part shapes).
 */
function mapPart(
  part: unknown,
  fallbackSessionId: string | undefined,
  emitSession: boolean,
): { events: OpencodeEvent[]; sessionId?: string } {
  const sessionId = partSessionId(part) ?? fallbackSessionId;
  const events: OpencodeEvent[] = [];
  if (emitSession && sessionId) events.push({ type: 'session', sessionId });

  if (stepStartPartSchema.safeParse(part).success) {
    events.push({ type: 'step' });
    return { events, sessionId };
  }
  const text = textPartSchema.safeParse(part);
  if (text.success) {
    events.push({ type: 'message', role: 'assistant', text: text.data.text });
    return { events, sessionId };
  }
  const finish = stepFinishPartSchema.safeParse(part);
  if (finish.success) {
    const usageEvent: OpencodeEvent = {
      type: 'usage',
      tokens: mapTokens(finish.data.tokens, finish.data.cost),
      cost: finish.data.cost ?? 0,
    };
    events.push(usageEvent);
    return { events, sessionId };
  }
  return { events, sessionId };
}

function partSessionId(part: unknown): string | undefined {
  if (part && typeof part === 'object' && 'sessionID' in part) {
    const v = (part as { sessionID: unknown }).sessionID;
    if (typeof v === 'string') return v;
  }
  return undefined;
}

/**
 * Parse one NDJSON line from `opencode run --format json`.
 * step_start -> session + step events; text -> assistant message;
 * step_finish -> usage (CanonicalTokenRecord from part.tokens, cost from
 * part.cost). Unknown event types are skipped, but their sessionID is still
 * reported so resume capture never misses a line. Malformed JSON throws so
 * the run loop can surface it as an error event.
 */
export function parseOpencodeLineRecord(line: string): ParsedOpencodeLine {
  const evt = opencodeEnvelopeSchema.parse(JSON.parse(line));
  switch (evt.type) {
    case 'step_start': {
      const mapped = mapPart(evt.part, evt.sessionID ?? undefined, true);
      return mapped;
    }
    case 'text':
      return mapPart(evt.part, evt.sessionID ?? undefined, false);
    case 'step_finish':
      return mapPart(evt.part, evt.sessionID ?? undefined, false);
    default:
      return { events: [], sessionId: evt.sessionID ?? partSessionId(evt.part) };
  }
}

/** Parse one line to canonical events only (house convention, like codex/gemini). */
export function parseOpencodeLine(line: string): OpencodeEvent[] {
  return parseOpencodeLineRecord(line).events;
}

// ---------------------------------------------------------------------------
// Run spec / CLI args
// ---------------------------------------------------------------------------

export interface OpencodeRunSpec extends RunOptions {
  prompt: string;
  /** "provider/model" (e.g. "anthropic/claude-haiku-4-5"); omit for default. */
  model?: string;
  /** Resume via `-s <sessionId>`, or `-c` to continue the last session. */
  resume?: { sessionId: string } | 'continue';
  /** POST to a running `opencode serve` instead of spawning a child. */
  preferServer?: boolean;
  /**
   * Sandbox policy (issue #8): `opencode run` has no CLI flags for
   * allowedTools/disallowedTools/permissionMode/mcpConfig — those fields are
   * omitted (use extraArgs, e.g. `--config permission.edit=deny`). Only
   * scrubEnv applies (child-process runs; the `opencode serve` path spawns
   * no child).
   */
  sandbox?: RunOptions['sandbox'];
}

/**
 * Build argv for `opencode run "<prompt>" --format json [--model <model>]
 * [--session <id> | --continue]`. Pure; exported for tests.
 */
export function buildRunArgs(spec: OpencodeRunSpec): string[] {
  const args = ['run', spec.prompt, '--format', 'json'];
  if (spec.model) args.push('--model', spec.model);
  if (spec.resume === 'continue') {
    args.push('--continue');
  } else if (spec.resume && typeof spec.resume === 'object' && spec.resume.sessionId) {
    args.push('--session', spec.resume.sessionId);
  }
  return args;
}

/** Split "provider/model" at the first slash (model ids may contain more). */
export function splitModelId(model: string): { providerID: string; modelID: string } | undefined {
  const idx = model.indexOf('/');
  if (idx <= 0) return undefined;
  return { providerID: model.slice(0, idx), modelID: model.slice(idx + 1) };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface OpenCodeAdapterOptions {
  /** Binary to invoke; defaults to `opencode` on PATH. */
  command?: string;
  /** Base URL of a running `opencode serve`; default $OPENCODE_SERVER_URL or http://127.0.0.1:4096. */
  serverUrl?: string;
  /** Injectable spawn factory for tests. */
  spawnFn?: SpawnFn;
  /** Injectable fetch for the server path (tests). */
  fetchImpl?: typeof fetch;
}

/**
 * OpenCode driver adapter.
 *
 * Primary path: headless `opencode run "<prompt>" --format json` with pipes,
 * NDJSON parsed into canonical events (via the shared runJsonlCli loop).
 * Secondary path (`preferServer`): POST to a running `opencode serve`
 * ($OPENCODE_SERVER_URL, default http://127.0.0.1:4096) — create session,
 * post message, map the returned parts to the same canonical events.
 * Resume: `-s <sessionId>` or `-c` (continue last session) from
 * OpencodeRunSpec.resume / the house resume() method.
 */
export class OpenCodeAdapter implements CoreAgentAdapter {
  readonly id = 'opencode';
  readonly name = 'opencode';
  readonly capabilities: AdapterCapabilities = OPENCODE_CAPABILITIES;

  #command: string;
  #serverUrl: string | undefined;
  #spawnFn: SpawnFn | undefined;
  #fetchImpl: typeof fetch;
  #current: { abort(): void } | null = null;

  constructor(options: OpenCodeAdapterOptions = {}) {
    this.#command = options.command ?? 'opencode';
    this.#serverUrl = options.serverUrl;
    this.#spawnFn = options.spawnFn;
    this.#fetchImpl = options.fetchImpl ?? fetch;
  }

  /** House-style spawn: prompt string + run options. */
  spawn(prompt: string, opts?: RunOptions): OpencodeRunHandle;
  /** Task-style spawn: full spec object (model, resume, preferServer). */
  spawn(task: OpencodeRunSpec): OpencodeRunHandle;
  spawn(promptOrTask: string | OpencodeRunSpec, opts: RunOptions = {}): OpencodeRunHandle {
    const task: OpencodeRunSpec =
      typeof promptOrTask === 'string' ? { prompt: promptOrTask, ...opts } : promptOrTask;
    const handle = task.preferServer ? this.#runViaServer(task) : this.#runHeadless(task);
    this.#current = handle;
    void handle.wait().finally(() => {
      if (this.#current === handle) this.#current = null;
    });
    return handle;
  }

  /** House-style resume: continue a prior session by id (`-s <sessionId>`). */
  resume(sessionId: string, prompt: string, opts: RunOptions = {}): OpencodeRunHandle {
    return this.spawn({ prompt, resume: { sessionId }, ...opts });
  }

  /** Driver contract (src/core/driver.ts): launch one run for a RunSpec. */
  async launch(spec: CoreRunSpec): Promise<CoreAgentHandle> {
    const task: OpencodeRunSpec = {
      prompt: spec.prompt,
      ...(spec.model !== undefined ? { model: spec.model } : {}),
      ...(spec.resume ? { resume: { sessionId: spec.resume } } : {}),
      ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
      ...(spec.env ? { env: spec.env } : {}),
      ...(spec.preferServer === true ? { preferServer: true } : {}),
      ...(spec.sandbox !== undefined ? { sandbox: spec.sandbox } : {}),
      ...(takeOnOutput(spec) ? { onOutput: takeOnOutput(spec) } : {}),
    };
    const handle = this.spawn(task);
    return launchDriverHandle({
      agent: 'opencode',
      events: handle.events,
      // OpencodeEvent is a structural superset of HouseEventLike (step events,
      // usage.cost); the bridge maps both.
      mapEvent: (event) => houseEventToCore('opencode', event as HouseEventLike),
      exit: handle.wait(),
      abort: () => handle.abort(),
      fallbackSessionId: spec.resume,
    });
  }

  /** Kill the in-flight run (headless child or server request). */
  abort(): void {
    this.#current?.abort();
  }

  /**
   * Async generator over parsed canonical events from an in-flight run's
   * stdout. Accepts a Readable or anything with `.stdout` (a ChildProcess).
   * Headless runs with event streams should use spawn(); this is the escape
   * hatch for attaching to a child you did not create.
   */
  async *attach(
    source: NodeJS.ReadableStream | { stdout: NodeJS.ReadableStream | null },
  ): AsyncGenerator<OpencodeEvent, void, void> {
    // @types/node's NodeJS.ReadableStream is web-stream shaped (no .on);
    // every real input here is a node Readable (ChildProcess.stdout).
    const stream = (
      (source as { stdout?: NodeJS.ReadableStream | null }).stdout ?? source
    ) as import('node:stream').Readable;
    const assembler = new LineAssembler();
    const queue = new EventQueue();
    const feed = (chunk: unknown) => {
      for (const line of assembler.push(String(chunk))) {
        if (line.trim() === '') continue;
        try {
          // Superset of CanonicalEvent[]; see #runHeadless.
          queue.push(...(parseOpencodeLine(line) as CanonicalEvent[]));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          queue.push({ type: 'error', message: `unparseable stdout line: ${message}` });
        }
      }
    };
    stream.on('data', feed);
    stream.on('end', () => {
      for (const line of assembler.flush()) {
        if (line.trim() !== '') {
          try {
            // Superset of CanonicalEvent[]; see #runHeadless.
            queue.push(...(parseOpencodeLine(line) as CanonicalEvent[]));
          } catch {
            queue.push({ type: 'error', message: 'unparseable trailing stdout line' });
          }
        }
      }
      queue.close();
    });
    stream.on('error', (err: Error) => {
      queue.push({ type: 'error', message: `stdout error: ${err.message}` });
      queue.close();
    });
    yield* queue;
  }

  #runHeadless(task: OpencodeRunSpec): OpencodeRunHandle {
    const state: { sessionId?: string; usage?: CanonicalTokenRecord; cost?: number } = {};
    const parseLine = (line: string): OpencodeEvent[] => {
      const parsed = parseOpencodeLineRecord(line);
      // Capture sessionID from every event line for resume.
      if (parsed.sessionId) state.sessionId = parsed.sessionId;
      for (const event of parsed.events) {
        if (event.type === 'usage') {
          state.usage = event.tokens;
          state.cost = event.cost;
        }
      }
      return parsed.events;
    };
    const handle = runJsonlCli({
      spec: {
        command: this.#command,
        args: buildRunArgs(task),
        cwd: task.cwd,
        env: task.env,
        scrubEnv: task.sandbox?.scrubEnv,
      },
      // OpencodeEvent[] is a strict superset of CanonicalEvent[] at runtime
      // (step events, usage.cost); the shared loop only types the base union.
      parseLine: parseLine as (line: string) => CanonicalEvent[],
      spawnFn: this.#spawnFn,
      onOutput: task.onOutput,
    });
    return this.#enrich(handle, () => handle.wait().then((exitCode) => ({ exitCode, ...state })));
  }

  #enrich(
    handle: { events: AsyncIterable<OpencodeEvent>; wait(): Promise<number>; abort(): void },
    result: () => Promise<OpencodeRunResult>,
  ): OpencodeRunHandle {
    return {
      events: handle.events,
      wait: handle.wait,
      abort: handle.abort,
      sessionId: () => result().then((r) => r.sessionId),
      result,
    };
  }

  /**
   * Secondary path: POST to a running `opencode serve`. Creates a session,
   * posts the message, and maps the returned parts (same shapes as the NDJSON
   * stream) to canonical events. Non-streaming: the server returns the
   * completed assistant message.
   */
  #runViaServer(task: OpencodeRunSpec): OpencodeRunHandle {
    const queue = new EventQueue();
    const controller = new AbortController();
    const state: { sessionId?: string; usage?: CanonicalTokenRecord; cost?: number } = {};
    let exitCode = 0;

    const base = (this.#serverUrl ?? process.env.OPENCODE_SERVER_URL ?? DEFAULT_SERVER_URL).replace(/\/+$/, '');
    const headers = { 'content-type': 'application/json' };

    const run = (async () => {
      try {
        const createRes = await this.#fetchImpl(`${base}/session`, {
          method: 'POST',
          headers,
          body: JSON.stringify({}),
          signal: controller.signal,
        });
        if (!createRes.ok) throw new Error(`opencode serve: POST /session -> ${createRes.status}`);
        const session = (await createRes.json()) as { id?: string };
        if (!session.id) throw new Error('opencode serve: session response missing id');
        state.sessionId = session.id;
        queue.push({ type: 'session', sessionId: session.id });

        const body: Record<string, unknown> = { parts: [{ type: 'text', text: task.prompt }] };
        const model = task.model ? splitModelId(task.model) : undefined;
        if (model) body.model = model;

        const msgRes = await this.#fetchImpl(
          `${base}/session/${encodeURIComponent(session.id)}/message`,
          { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal },
        );
        if (!msgRes.ok) {
          throw new Error(`opencode serve: POST /session/${session.id}/message -> ${msgRes.status}`);
        }
        const data = (await msgRes.json()) as { parts?: unknown[] };
        for (const part of data.parts ?? []) {
          const mapped = mapPart(part, state.sessionId, false);
          if (mapped.sessionId) state.sessionId = mapped.sessionId;
          for (const event of mapped.events) {
            if (event.type === 'usage') {
              state.usage = event.tokens;
              state.cost = event.cost;
            }
          }
          queue.push(...mapped.events);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        queue.push({ type: 'error', message });
        exitCode = 1;
      } finally {
        queue.close();
      }
    })();

    return {
      events: queue as AsyncIterable<OpencodeEvent>,
      wait: () => run.then(() => exitCode),
      abort: () => controller.abort(),
      sessionId: () => run.then(() => state.sessionId),
      result: () => run.then(() => ({ exitCode, ...state })),
    };
  }

  // -------------------------------------------------------------------------
  // Stats: read-only query against opencode's SQLite store
  // -------------------------------------------------------------------------

  /** See top-level statsFromDb (kept as a method for adapter consumers). */
  async statsFromDb(dbPath: string = defaultOpencodeDbPath(), limit = 20): Promise<OpencodeSessionStat[]> {
    return statsFromDb(dbPath, limit);
  }
}

/**
 * Top-level read-only session stats from opencode's SQLite database
 * (default ~/.local/share/opencode/opencode.db), newest first.
 * Under Bun this opens the DB read-only via bun:sqlite; under Node it shells
 * out to the `sqlite3` CLI in readonly mode (an in-process Node driver would
 * need better-sqlite3, deliberately left out of the dependency set).
 */
export async function statsFromDb(dbPath: string = defaultOpencodeDbPath(), limit = 20): Promise<OpencodeSessionStat[]> {
  if (isBun()) return statsViaBun(dbPath, limit);
  return statsViaCli(dbPath, limit);
}

function isBun(): boolean {
  return (globalThis as { Bun?: unknown }).Bun !== undefined;
}

export interface OpencodeSessionStat {
  id: string;
  cost: number;
  tokens_input: number;
  tokens_output: number;
  tokens_reasoning: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  time_created: number;
}

export function defaultOpencodeDbPath(home: string = process.env.HOME ?? ''): string {
  return `${home}/.local/share/opencode/opencode.db`;
}

const STATS_SQL = `
  SELECT id, cost, tokens_input, tokens_output, tokens_reasoning,
         tokens_cache_read, tokens_cache_write, time_created
  FROM session
  ORDER BY time_created DESC
  LIMIT ?
`;

interface BunDatabase {
  query(sql: string): { all: (...params: unknown[]) => unknown[] };
  close(): void;
}

/** Bun path: bun:sqlite opened readonly. Dynamic import keeps this loadable under Node. */
export async function statsViaBun(dbPath: string, limit: number): Promise<OpencodeSessionStat[]> {
  const specifier = 'bun:sqlite';
  const { Database } = (await import(specifier)) as {
    Database: new (path: string, opts: { readonly: boolean }) => BunDatabase;
  };
  const db = new Database(dbPath, { readonly: true });
  try {
    return normalizeStats(db.query(STATS_SQL).all(limit));
  } finally {
    db.close();
  }
}

/** Node path: readonly `sqlite3` CLI via execSync (better-sqlite3 not bundled by design). */
export function statsViaCli(dbPath: string, limit: number): OpencodeSessionStat[] {
  const sql = STATS_SQL.replace('LIMIT ?', `LIMIT ${Number(limit)}`);
  const out = execSync(['sqlite3', '-readonly', '-json', shellQuote(dbPath), shellQuote(sql)].join(' '), {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
  if (out === '') return [];
  return normalizeStats(JSON.parse(out));
}

function normalizeStats(rows: unknown[]): OpencodeSessionStat[] {
  const list = z
    .array(
      z.object({
        id: z.string(),
        cost: z.number(),
        tokens_input: z.number(),
        tokens_output: z.number(),
        tokens_reasoning: z.number(),
        tokens_cache_read: z.number(),
        tokens_cache_write: z.number(),
        time_created: z.number(),
      }),
    )
    .parse(rows);
  return list;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
