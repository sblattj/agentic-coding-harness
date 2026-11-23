import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import type { AdapterCapabilities, CanonicalEvent, CanonicalTokenRecord, RunOptions } from './types.ts';
import type {
  AdapterProfileCheck,
  AgentAdapter as CoreAgentAdapter,
  AgentHandle as CoreAgentHandle,
  RunSpec as CoreRunSpec,
} from '../core/types.js';
import {
  runJsonlCli,
  launchDriverHandle,
  houseEventToCore,
  takeOnOutput,
  validateCliSessionProfile,
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
// Native wire schemas (recorded from `opencode run --format json`, v1.18.30; the same
// shape is emitted unchanged by 2.2.5 and 2.3.2, which omit tokens.total).
// Envelope: {"type":"step_start"|"text"|"tool_use"|"step_finish", timestamp,
// sessionID, part:{...}}; part types use dashes ("step-start"). A tool_use
// envelope carries a part {type:"tool", tool, callID, state:{status, input,
// output|error, title}}, emitted once the call is completed or errored
// (recorded on 1.19.0). Unknown envelope types (reasoning, ...) are skipped
// but still yield their sessionID.
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

const toolPartSchema = z
  .object({
    type: z.literal('tool'),
    tool: z.string(),
    callID: z.string().nullish(),
    state: z
      .object({
        status: z.string().nullish(),
        input: z.unknown().optional(),
        output: z.unknown().optional(),
        error: z.unknown().optional(),
        title: z.string().nullish(),
        time: z.object({ start: z.number().nullish(), end: z.number().nullish() }).passthrough().nullish(),
      })
      .passthrough()
      .nullish(),
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
    // opencode 2.x omits `total`; derive it from the parts so usage stays comparable.
    totalTokens:
      tokens.total ??
      (tokens.input != null || tokens.output != null
        ? (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.reasoning ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0)
        : null),
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
  const tool = toolPartSchema.safeParse(part);
  if (tool.success) {
    events.push(...mapToolPart(tool.data));
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

/**
 * One opencode tool part -> canonical tool events. `opencode run --format json`
 * emits the part once, already completed (or errored), so a finished part
 * yields the start and the result together, sharing the callID; each carries
 * the part's own `state.time` start/end, so per-tool latency stays real. A part that
 * is still pending/running (serve snapshots) yields only the start.
 */
function mapToolPart(p: z.infer<typeof toolPartSchema>): OpencodeEvent[] {
  const st = p.state ?? {};
  const id = p.callID ?? undefined;
  const start: OpencodeEvent = {
    type: 'tool',
    phase: 'start',
    toolName: p.tool,
    ...(id !== undefined ? { toolCallId: id } : {}),
    ...(st.input !== undefined ? { input: st.input } : {}),
    ...(typeof st.title === 'string' && st.title !== '' ? { title: st.title } : {}),
    ...(typeof st.time?.start === 'number' ? { timestamp: st.time.start } : {}),
  };
  if (st.status !== 'completed' && st.status !== 'error') return [start];
  const failed = st.status === 'error';
  const output = failed ? st.error : st.output;
  const result: OpencodeEvent = {
    type: 'tool',
    phase: 'result',
    toolName: p.tool,
    ...(id !== undefined ? { toolCallId: id } : {}),
    ...(output !== undefined ? { output } : {}),
    status: failed ? 'error' : 'success',
    ...(typeof st.time?.end === 'number' ? { timestamp: st.time.end } : {}),
  };
  return [start, result];
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
 * tool_use -> tool start + result (same callID); step_finish -> usage (CanonicalTokenRecord from part.tokens, cost from
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
    case 'tool_use':
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
   * Extra `opencode run` args, appended verbatim after the built flags (e.g.
   * `--agent <name>`, `--variant high`). Headless only: the `opencode serve`
   * path spawns no child, so it reports them as not applied.
   */
  extraArgs?: string[];
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
 * [--session <id> | --continue] [...extraArgs]`. Pure; exported for tests.
 */
export function buildRunArgs(spec: OpencodeRunSpec): string[] {
  const args = ['run', spec.prompt, '--format', 'json'];
  if (spec.model) args.push('--model', spec.model);
  if (spec.resume === 'continue') {
    args.push('--continue');
  } else if (spec.resume && typeof spec.resume === 'object' && spec.resume.sessionId) {
    args.push('--session', spec.resume.sessionId);
  }
  if (spec.extraArgs?.length) args.push(...spec.extraArgs);
  return args;
}

const PASSWORD_HINT =
  'set the serve password: pass the serverPassword adapter option, or export OPENCODE_PASSWORD ' +
  '(OPENCODE_SERVER_PASSWORD also works); the username is always "opencode"';

/** Parse a serve response as JSON; an HTML/non-JSON body (e.g. the web UI) throws, never parsed as data. */
async function readServeJson(res: Response, base: string, route: string): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    const ct = res.headers?.get('content-type') ?? 'unknown content-type';
    throw new Error(`opencode serve (${base}): ${route} returned a non-JSON body (${ct}); not an opencode JSON API`);
  }
}

function serveRouteError(base: string, route: string, status: number, sentPassword = false): string {
  if (status === 401 && sentPassword) {
    return `opencode serve (${base}): ${route} -> 401 unauthorized; the serve rejected the password that was sent (check serverPassword / OPENCODE_PASSWORD matches the serve's OPENCODE_PASSWORD)`;
  }
  if (status === 401) return `opencode serve (${base}): ${route} -> 401 unauthorized; ${PASSWORD_HINT}`;
  return `opencode serve (${base}): ${route} -> ${status}`;
}

type ServeApi = 'v1' | 'v2';

interface V2Message {
  id?: string;
  type?: string;
  outcome?: string;
  error?: unknown;
  content?: Array<{ type?: string; text?: string }>;
  cost?: number;
  tokens?: OpencodeTokens;
  time?: { completed?: number };
}

function v2ErrorText(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const e = err as { message?: unknown; name?: unknown; _tag?: unknown };
    if (typeof e.message === 'string') return e.message;
    return JSON.stringify(err).slice(0, 300);
  }
  return 'unknown error';
}

/**
 * Map one opencode 2.x assistant message (flat {content:[text|reasoning|tool], tokens, cost})
 * to canonical events: step, one message per text block, usage. The v1 part
 * shapes differ (parts with step-start/step-finish), so this is a separate mapper
 * that emits the same canonical events.
 */
function mapV2Assistant(m: V2Message): OpencodeEvent[] {
  const events: OpencodeEvent[] = [{ type: 'step' }];
  for (const c of m.content ?? []) {
    if (c.type === 'text' && typeof c.text === 'string' && c.text !== '') {
      events.push({ type: 'message', role: 'assistant', text: c.text });
    }
  }
  if (m.tokens && m.time?.completed !== undefined) {
    events.push({ type: 'usage', tokens: mapTokens(m.tokens, m.cost), cost: m.cost ?? 0 });
  }
  return events;
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
  /**
   * Basic-auth password (user "opencode") for a serve that has one. Default
   * $OPENCODE_PASSWORD, then $OPENCODE_SERVER_PASSWORD. opencode 2.x serves always
   * require it; for a serve ach did not start, the caller must supply it.
   */
  serverPassword?: string;
  /** preferServer on 2.x: max wait for the turn to finish (ms). Default 600000. */
  serverTimeoutMs?: number;
  /** preferServer on 2.x: poll interval for the turn (ms). Default 500. */
  serverPollMs?: number;
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
  #serverPassword: string | undefined;
  #serverTimeoutMs: number;
  #serverPollMs: number;
  #spawnFn: SpawnFn | undefined;
  #fetchImpl: typeof fetch;
  #current: { abort(): void } | null = null;

  constructor(options: OpenCodeAdapterOptions = {}) {
    this.#command = options.command ?? 'opencode';
    this.#serverUrl = options.serverUrl;
    this.#serverPassword = options.serverPassword;
    this.#serverTimeoutMs = options.serverTimeoutMs ?? 600_000;
    this.#serverPollMs = options.serverPollMs ?? 500;
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

  /**
   * Adapter-owned profile validation (issue #9): the shared model/resume
   * surface (model flag, `-s <sessionId>` resume) must be sane CLI tokens.
   */
  validateProfile(spec: CoreRunSpec): AdapterProfileCheck {
    return validateCliSessionProfile(spec);
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
      ...(spec.extraArgs !== undefined ? { extraArgs: spec.extraArgs } : {}),
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

  /** v2: stop a session's turn on the server. Best effort, bounded to 3 s, never throws. */
  async #interrupt(base: string, sid: string, headers: Record<string, string>): Promise<void> {
    try {
      await this.#fetchImpl(`${base}/api/session/${encodeURIComponent(sid)}/interrupt`, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // ignore
    }
  }

  /**
   * Secondary path: talk to a running `opencode serve`. The API generation is
   * detected from the server (GET /api/info: JSON with a 2.x version = v2; an HTML
   * or 404 answer = v1). v1: create session, POST the message, map the returned
   * parts. v2 (JSON under /api/*, Basic auth): create session, POST the prompt,
   * poll the session's messages until its idle message, map assistant messages.
   * Both yield the same canonical events.
   */
  #runViaServer(task: OpencodeRunSpec): OpencodeRunHandle {
    const queue = new EventQueue();
    const controller = new AbortController();
    const state: { sessionId?: string; usage?: CanonicalTokenRecord; cost?: number } = {};
    let exitCode = 0;

    const base = (this.#serverUrl ?? process.env.OPENCODE_SERVER_URL ?? DEFAULT_SERVER_URL).replace(/\/+$/, '');
    // One deadline for the whole run: every request is bounded by what is left of it (plus the abort controller).
    const deadline = Date.now() + this.#serverTimeoutMs;
    // A ref'd timer, not AbortSignal.timeout(): that timer is unref'd, so a stalled request with no live
    // socket would let the event loop drain before the deadline fires. Cleared when the run settles.
    // The timer runs on the monotonic clock and Date.now() on the wall clock; they can disagree by a millisecond
    // or more, so the timer firing is itself proof the deadline passed (`timedOut`), whatever Date.now() says.
    let timedOut = false;
    const pastDeadline = (): boolean => timedOut || Date.now() >= deadline;
    const deadlineController = new AbortController();
    const deadlineTimer = setTimeout(() => {
      timedOut = true;
      deadlineController.abort(new Error(`deadline ${this.#serverTimeoutMs} ms`));
    }, this.#serverTimeoutMs);
    const runSignal = AbortSignal.any([controller.signal, deadlineController.signal]);
    const signalFor = (): AbortSignal => runSignal;
    const timeoutMessage = `opencode serve (${base}): turn did not finish within ${this.#serverTimeoutMs} ms`;
    const password = this.#serverPassword ?? process.env.OPENCODE_PASSWORD ?? process.env.OPENCODE_SERVER_PASSWORD;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (password) headers.authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
    const note = (events: OpencodeEvent[]): void => {
      for (const event of events) {
        if (event.type === 'usage') {
          state.usage = event.tokens;
          state.cost = event.cost;
        }
      }
      queue.push(...events);
    };

    const detect = async (): Promise<ServeApi> => {
      const res = await this.#fetchImpl(`${base}/api/info`, { method: 'GET', headers, signal: signalFor() });
      if (res.status === 401) throw new Error(serveRouteError(base, 'GET /api/info', 401, !!password));
      if (!res.ok) return 'v1';
      let info: unknown;
      try {
        info = await res.json();
      } catch {
        return 'v1'; // 1.x answers unknown paths with its web UI (HTML)
      }
      const version = (info as { version?: unknown } | null)?.version;
      const major = typeof version === 'string' ? Number(version.split('.')[0]) : NaN;
      return Number.isFinite(major) && major >= 2 ? 'v2' : 'v1';
    };

    const runV1 = async (): Promise<void> => {
      const createRes = await this.#fetchImpl(`${base}/session`, {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
        signal: signalFor(),
      });
      if (!createRes.ok) throw new Error(serveRouteError(base, 'POST /session', createRes.status, !!password));
      const session = (await readServeJson(createRes, base, 'POST /session')) as { id?: string };
      if (!session.id) throw new Error('opencode serve: session response missing id');
      state.sessionId = session.id;
      queue.push({ type: 'session', sessionId: session.id });

      const body: Record<string, unknown> = { parts: [{ type: 'text', text: task.prompt }] };
      const model = task.model ? splitModelId(task.model) : undefined;
      if (model) body.model = model;

      const msgRes = await this.#fetchImpl(
        `${base}/session/${encodeURIComponent(session.id)}/message`,
        { method: 'POST', headers, body: JSON.stringify(body), signal: signalFor() },
      );
      if (!msgRes.ok) {
        throw new Error(serveRouteError(base, 'POST /session/:id/message', msgRes.status, !!password));
      }
      const data = (await readServeJson(msgRes, base, 'POST /session/:id/message')) as { parts?: unknown[] };
      for (const part of data.parts ?? []) {
        const mapped = mapPart(part, state.sessionId, false);
        if (mapped.sessionId) state.sessionId = mapped.sessionId;
        note(mapped.events);
      }
    };

    const v2Call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
      const res = await this.#fetchImpl(`${base}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signalFor(),
      });
      const route = `${method} ${path.replace(/ses_[^/?]+/, ':id')}`;
      if (!res.ok) throw new Error(serveRouteError(base, route, res.status, !!password));
      return readServeJson(res, base, route);
    };

    /** All messages of a session, oldest first, following the cursor. */
    const v2Messages = async (sid: string): Promise<V2Message[]> => {
      const out: V2Message[] = [];
      let path = `/api/session/${encodeURIComponent(sid)}/message?order=asc&limit=200`;
      for (let page = 0; page < 1000; page++) {
        const r = (await v2Call('GET', path)) as { data?: unknown; cursor?: { next?: unknown } } | null;
        if (!r || !Array.isArray(r.data)) throw new Error(`opencode serve (${base}): GET /api/session/:id/message returned no data[]`);
        out.push(...(r.data as V2Message[]));
        const next = r.cursor?.next;
        if (typeof next !== 'string' || next === '' || r.data.length === 0) break;
        path = `/api/session/${encodeURIComponent(sid)}/message?limit=200&cursor=${encodeURIComponent(next)}`;
      }
      return out;
    };

    let v2Session: string | undefined;
    const runV2 = async (): Promise<void> => {
      const createBody: Record<string, unknown> = {};
      const model = task.model ? splitModelId(task.model) : undefined;
      if (model) createBody.model = { id: model.modelID, providerID: model.providerID };
      if (task.cwd) createBody.location = { directory: task.cwd };
      const created = (await v2Call('POST', '/api/session', createBody)) as { data?: { id?: unknown } } | null;
      const sid = created?.data?.id;
      if (typeof sid !== 'string' || sid === '') throw new Error('opencode serve: session response missing data.id');
      state.sessionId = sid;
      v2Session = sid;
      queue.push({ type: 'session', sessionId: sid });

      const prompted = (await v2Call('POST', `/api/session/${encodeURIComponent(sid)}/prompt`, { text: task.prompt })) as {
        data?: { id?: unknown };
      } | null;
      const userId = prompted?.data?.id;
      if (typeof userId !== 'string' || userId === '') throw new Error('opencode serve: prompt response missing data.id');

      for (;;) {
        if (pastDeadline()) throw new Error(timeoutMessage);
        const messages = await v2Messages(sid);
        const at = messages.findIndex((m) => m.id === userId);
        const after = at < 0 ? [] : messages.slice(at + 1);
        const idle = after.find((m) => m.type === 'idle');
        if (idle) {
          for (const m of after) {
            if (m.type !== 'assistant') continue;
            note(mapV2Assistant(m));
            if (m.error !== undefined && m.error !== null) queue.push({ type: 'error', message: v2ErrorText(m.error) });
          }
          if (idle.outcome !== 'succeeded') {
            exitCode = 1;
            if (!after.some((m) => m.type === 'assistant' && m.error != null)) {
              const why = idle.error != null ? v2ErrorText(idle.error) : `turn ${idle.outcome ?? 'ended'}`;
              queue.push({ type: 'error', message: why });
            }
          } else if (after.some((m) => m.type === 'assistant' && m.error != null)) {
            exitCode = 1;
          }
          return;
        }
        await new Promise((r) => setTimeout(r, this.#serverPollMs));
      }
    };

    const run = (async () => {
      try {
        if (task.extraArgs?.length) {
          // The serve path spawns no child, so there is no argv to append to; say so rather than drop them silently.
          queue.push({
            type: 'progress',
            text: `opencode serve path: extraArgs not applied (no child process): ${task.extraArgs.join(' ')}`,
          });
        }
        const api = await detect();
        if (api === 'v2') await runV2();
        else await runV1();
      } catch (err) {
        let message = err instanceof Error ? err.message : String(err);
        if (!controller.signal.aborted && pastDeadline()) {
          // Deadline hit (possibly mid-request): report the timeout and stop the turn server-side.
          message = timeoutMessage;
          if (v2Session) await this.#interrupt(base, v2Session, headers);
        }
        queue.push({ type: 'error', message });
        exitCode = 1;
      } finally {
        clearTimeout(deadlineTimer);
        queue.close();
      }
    })();

    return {
      events: queue as AsyncIterable<OpencodeEvent>,
      wait: () => run.then(() => exitCode),
      abort: () => {
        controller.abort();
        // v2: the turn keeps running server-side after the client drops; interrupt it (best effort).
        if (v2Session) {
          void this.#interrupt(base, v2Session, headers);
        }
      },
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
