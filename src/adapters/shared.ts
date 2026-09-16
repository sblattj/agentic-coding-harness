import { randomUUID } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import type { CanonicalEvent, RunHandle, RunOptions } from './types.ts';
import type {
  AdapterExit,
  AgentEvent as CoreAgentEvent,
  AgentHandle as CoreAgentHandle,
  CanonicalTokenRecord as CoreTokenRecord,
  KiroEffective,
} from '../core/types.js';

/**
 * Injectable child-process factory. Tests supply a fake that replays recorded
 * NDJSON fixtures through the exact same stdout/stderr plumbing production
 * uses; the default is node's spawn with shell:false.
 */
export type SpawnFn = (
  command: string,
  args: string[],
  opts: SpawnOptions,
) => ChildProcessLike;

export interface ChildProcessLike {
  stdout: Readable | null;
  stderr: Readable | null;
  stdin: Writable | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: 'error', listener: (err: Error) => void): this;
}

export const defaultSpawnFn: SpawnFn = (command, args, opts) =>
  nodeSpawn(command, args, { ...opts, shell: false });

/** Accumulates stdout chunks and yields complete newline-terminated lines. */
export class LineAssembler {
  #buf = '';

  push(chunk: string): string[] {
    this.#buf += chunk;
    const lines: string[] = [];
    let idx: number;
    while ((idx = this.#buf.indexOf('\n')) !== -1) {
      lines.push(this.#buf.slice(0, idx).replace(/\r$/, ''));
      this.#buf = this.#buf.slice(idx + 1);
    }
    return lines;
  }

  /** Flush any trailing unterminated line (crash mid-line still yields data). */
  flush(): string[] {
    const rest = this.#buf.replace(/\r$/, '');
    this.#buf = '';
    return rest.length > 0 ? [rest] : [];
  }
}

type QueueState<T> =
  | { kind: 'open'; buffered: T[]; wake: (() => void) | null }
  | { kind: 'closed'; buffered: T[] };

/** Push-based async iterable of events (house CanonicalEvent by default). */
export class EventQueue<T = CanonicalEvent> implements AsyncIterable<T> {
  #state: QueueState<T> = { kind: 'open', buffered: [], wake: null };

  push(...events: T[]): void {
    // A zero-event push (e.g. a parsed line that maps to nothing) must not
    // wake a parked consumer: the wake closure treats "woken with an empty
    // buffer" as end-of-stream, which only close() may signal.
    if (events.length === 0) return;
    const s = this.#state;
    if (s.kind !== 'open') return;
    s.buffered.push(...events);
    const wake = s.wake;
    s.wake = null;
    wake?.();
  }

  /** Stop accepting events; consumers may still drain what was buffered. */
  close(): void {
    const s = this.#state;
    if (s.kind !== 'open') return;
    this.#state = { kind: 'closed', buffered: s.buffered };
    s.wake?.();
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const s = this.#state;
        if (s.buffered.length > 0) {
          return Promise.resolve({ value: s.buffered.shift()!, done: false });
        }
        if (s.kind === 'closed') {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          s.wake = () => {
            s.wake = null;
            if (s.buffered.length > 0) {
              resolve({ value: s.buffered.shift()!, done: false });
            } else {
              // Woken by close() with nothing buffered.
              resolve({ value: undefined, done: true });
            }
          };
        });
      },
    };
  }
}

export interface JsonlRunSpec {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  /**
   * SandboxPolicy.scrubEnv (issue #8): `true` removes the known provider
   * credential/config-dir vars from the merged child env just before spawn;
   * a string array removes exactly those names. Applied AFTER spec.env
   * overlays process.env.
   */
  scrubEnv?: boolean | string[];
}

export interface JsonlRunConfig {
  spec: JsonlRunSpec;
  /** Parse one stdout JSONL record into zero or more canonical events. */
  parseLine: (line: string) => CanonicalEvent[];
  spawnFn?: SpawnFn;
  /** Grace period between SIGTERM and SIGKILL on abort. */
  killGraceMs?: number;
  /**
   * Raw stdout tap: called with each stdout chunk EXACTLY as received (chunk
   * boundaries preserved, no line assembly) BEFORE the chunk is fed to
   * parseLine — so raw stdout is populated alongside canonical events. A
   * throwing tap never breaks the run (the exception is swallowed).
   */
  onOutput?: (chunk: string) => void;
  /**
   * Optional stderr hook. stderr lines are ALWAYS forwarded as `progress`
   * events (unchanged behaviour); when this is present it is called first for
   * every non-blank line and any events it returns are pushed BEFORE the
   * progress event. Used by the kiro adapter to turn
   * `[warn] failed to set model ...` into a `step` with `payload.kind:'modelAck'`.
   */
  onStderrLine?: (line: string) => CanonicalEvent[] | void;
}

/**
 * Extract a function-typed `onOutput` from a passthrough RunSpec/RunOptions
 * (RunSpecSchema is .passthrough(), so callers can smuggle anything in).
 * Returns undefined for anything that is not a function.
 */
export function takeOnOutput(spec: { onOutput?: unknown; [key: string]: unknown }): ((chunk: string) => void) | undefined {
  return typeof spec.onOutput === 'function' ? (spec.onOutput as (chunk: string) => void) : undefined;
}

// ---------------------------------------------------------------------------
// Sandbox policy translation helpers (issue #8)
// ---------------------------------------------------------------------------

/**
 * Provider credential / config-dir env vars removed by
 * SandboxPolicy.scrubEnv:true before spawn. Credentials for the five backed
 * CLIs (claude: ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
 * CLAUDE_CODE_OAUTH_TOKEN; codex: OPENAI_API_KEY; gemini: GEMINI_API_KEY,
 * GOOGLE_API_KEY, GOOGLE_APPLICATION_CREDENTIALS; kiro: KIRO_API_KEY plus
 * the AWS_* chain it authenticates through) and the config-dir overrides
 * that point a child at the caller's real authenticated config.
 * Harness-managed vars (e.g. the per-run CLAUDE_CONFIG_DIR the claude
 * adapter creates) are re-applied by each adapter after the scrub.
 */
export const PROVIDER_CREDENTIAL_ENV_VARS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'KIRO_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'OPENCODE_CONFIG',
];

/**
 * Return a copy of `env` with the scrubbed vars removed (issue #8):
 * `true` drops PROVIDER_CREDENTIAL_ENV_VARS; a string array drops exactly
 * those names; undefined/false returns the input unchanged (no copy).
 */
export function scrubEnvVars<T extends Record<string, string | undefined>>(
  env: T,
  policy: boolean | string[] | undefined,
): T {
  if (policy === undefined || policy === false) return env;
  const drop = policy === true ? PROVIDER_CREDENTIAL_ENV_VARS : policy;
  const out = { ...env };
  for (const name of drop) delete out[name];
  return out;
}

/**
 * SandboxPolicy.mcpConfig as a CLI token: a string (file path) passes through
 * verbatim; an object is JSON-stringified for CLIs that accept inline JSON.
 */
export function mcpConfigToken(mcpConfig: string | Record<string, unknown>): string {
  return typeof mcpConfig === 'string' ? mcpConfig : JSON.stringify(mcpConfig);
}

/**
 * Shared run loop: spawn the CLI, feed stdout JSONL through parseLine, forward
 * stderr as progress events, and surface a non-zero exit as an error event.
 */
export function runJsonlCli(config: JsonlRunConfig): RunHandle {
  const { spec, parseLine } = config;
  const onStderrLine = config.onStderrLine;
  const onOutput = config.onOutput;
  const spawnFn = config.spawnFn ?? defaultSpawnFn;
  const killGraceMs = config.killGraceMs ?? 5000;

  const queue = new EventQueue();
  let child: ChildProcessLike | null = null;
  let killed = false;
  let resolveExit: ((code: number) => void) | null = null;
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  const settleExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    resolveExit?.(code !== null ? code : signal ? -1 : 0);
  };

  const start = (): ChildProcessLike => {
    const opts: SpawnOptions = {
      cwd: spec.cwd,
      // Snapshot the merged env (never alias live process.env into the
      // spawn options) and apply scrubEnv (issue #8) so ambient credentials
      // and anything layered in via spec.env are both covered.
      env: scrubEnvVars({ ...process.env, ...spec.env }, spec.scrubEnv),
      stdio: ['pipe', 'pipe', 'pipe'],
    };
    const proc = spawnFn(spec.command, spec.args, opts);
    child = proc;

    proc.once('error', (err: Error) => {
      queue.push({ type: 'error', message: `failed to spawn ${spec.command}: ${err.message}` });
    });

    const assembler = new LineAssembler();
    proc.stdout?.on('data', (chunk: Buffer | string) => {
      // Raw tap first (exact chunk, boundaries preserved), always guarded:
      // a consumer tap must never break the run loop.
      if (onOutput) {
        try {
          onOutput(String(chunk));
        } catch {
          /* tap errors are deliberately swallowed */
        }
      }
      for (const line of assembler.push(String(chunk))) {
        if (line.trim() === '') continue;
        try {
          queue.push(...parseLine(line));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          queue.push({ type: 'error', message: `unparseable stdout line: ${message}` });
        }
      }
    });
    proc.stdout?.on('end', () => {
      for (const line of assembler.flush()) {
        if (line.trim() === '') continue;
        try {
          queue.push(...parseLine(line));
        } catch {
          queue.push({ type: 'error', message: 'unparseable trailing stdout line' });
        }
      }
    });

    const stderrAsm = new LineAssembler();
    const emitStderr = (line: string): void => {
      if (line.trim() === '') return;
      if (onStderrLine) {
        try {
          const extra = onStderrLine(line);
          if (extra) queue.push(...extra);
        } catch {
          /* a stderr hook must never break the run */
        }
      }
      queue.push({ type: 'progress', text: line });
    };
    proc.stderr?.on('data', (chunk: Buffer | string) => {
      for (const line of stderrAsm.push(String(chunk))) emitStderr(line);
    });
    proc.stderr?.on('end', () => {
      for (const line of stderrAsm.flush()) emitStderr(line);
    });

    proc.stdin?.end();

    proc.once('close', (code, signal) => {
      settleExit(code, signal);
      if (!killed && code !== null && code !== 0) {
        queue.push({
          type: 'error',
          message: `${spec.command} exited with code ${code}${signal ? ` (signal ${signal})` : ''}`,
        });
      }
      queue.close();
    });

    return proc;
  };

  // Spawn eagerly: constructing a run starts the process, so abort() works
  // immediately and wait() cannot double-start.
  start();

  const abort = (): void => {
    if (!child || killed) return;
    killed = true;
    child.kill('SIGTERM');
    const dying = child;
    const timer = setTimeout(() => {
      try {
        dying.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, killGraceMs);
    timer.unref?.();
  };

  const wait = (): Promise<number> => exitPromise;

  return { events: queue, wait, abort };
}

// ---------------------------------------------------------------------------
// Driver-contract bridge (src/core/types.ts)
//
// Maps the adapter-lane vocabulary (CanonicalEvent / CanonicalTokenRecord from
// ./types.ts, plus the per-adapter `step` / `usage.cost` extensions) onto the
// core AgentEvent union and AgentHandle shape consumed by src/core/driver.ts.
// ---------------------------------------------------------------------------

/** House token record (adapters/types.ts) — input is UNCACHED input only. */
export interface HouseTokens {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number | null;
  totalTokens: number | null;
  durationMs: number | null;
  raw: unknown;
  /**
   * Producer sidecar (kiro credits metering: `credits`, `creditsCumulative`,
   * `tokensAvailable:false`, `contextUsagePercentage`, …). MERGED through the
   * bridge below — never rebuilt — so the driver, registry and report can tell
   * "credits only, tokens unavailable" from "zero tokens".
   */
  extra?: Record<string, unknown>;
}

/** House event or a lane extension ({type:'step'} from opencode, {type:'step',
 *  payload} from kiro, {type:'usage', cost} from opencode). */
export type HouseEventLike =
  | CanonicalEvent
  | { type: 'step'; payload?: unknown }
  | { type: 'usage'; tokens: HouseTokens; cost?: number | null };

export function toCoreTokenRecord(
  agent: string,
  tokens: HouseTokens,
  opts: { model?: string; costUsd?: number } = {},
): CoreTokenRecord {
  return {
    agent,
    model: opts.model ?? 'unknown',
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    cacheReadTokens: tokens.cacheReadTokens ?? 0,
    cacheWriteTokens: tokens.cacheWriteTokens ?? 0,
    ...(tokens.reasoningTokens !== null && tokens.reasoningTokens !== undefined
      ? { reasoningTokens: tokens.reasoningTokens }
      : {}),
    ...(opts.costUsd !== undefined ? { costUsd: opts.costUsd } : {}),
    // Bridge extras: the house-level totals FIRST, then the producer's own
    // `extra` on top. Merging (not rebuilding) is what carries kiro's
    // `credits` / `tokensAvailable:false` to the driver — see the note in
    // src/adapters/kiro-events.ts.
    extra: {
      totalTokens: tokens.totalTokens,
      durationMs: tokens.durationMs,
      raw: tokens.raw,
      ...(tokens.extra ?? {}),
    },
  };
}

/**
 * Map one house event onto the core AgentEvent union (mirrors the bridging in
 * src/core/driver.ts). Session ids ride the top-level `sessionId` field so
 * launchDriverHandle can capture them; usage events carry a pre-normalized
 * CanonicalTokenRecord on `usage` (the driver prices from that without
 * re-normalizing). Unknown event types are dropped (returns null).
 */
export function houseEventToCore(agent: string, event: HouseEventLike): CoreAgentEvent | null {
  const timestamp = Date.now();
  switch (event.type) {
    case 'session':
      return { type: 'session', agent, sessionId: event.sessionId, timestamp };
    case 'step': {
      const ext = event as { type: 'step'; payload?: unknown };
      return {
        type: 'step',
        agent,
        ...(ext.payload !== undefined ? { data: ext.payload } : {}),
        timestamp,
      };
    }
    case 'message':
      return {
        type: 'message',
        agent,
        source: event.role === 'assistant' ? 'agent' : event.role,
        content: event.text,
        ...(event.reasoning === true ? { reasoning: true } : {}),
        timestamp,
      };
    case 'tool': {
      if (event.phase === 'start') {
        return {
          type: 'tool_call',
          agent,
          toolCallId: event.toolCallId ?? '',
          functionName: event.toolName,
          arguments: (event.input as Record<string, unknown> | string | undefined) ?? '',
          timestamp,
        };
      }
      return {
        type: 'tool_result',
        agent,
        toolCallId: event.toolCallId ?? '',
        content: (event.output as string | Record<string, unknown> | undefined) ?? '',
        ...(event.status !== undefined ? { isError: event.status === 'error' } : {}),
        timestamp,
      };
    }
    case 'usage': {
      const ext = event as { type: 'usage'; tokens: HouseTokens; cost?: number | null };
      const costUsd = ext.cost ?? undefined;
      return {
        type: 'usage',
        agent,
        usage: toCoreTokenRecord(agent, ext.tokens, { costUsd }),
        data: ext.tokens.raw,
        timestamp,
      };
    }
    case 'progress':
      return { type: 'progress', agent, text: event.text, timestamp };
    case 'error':
      return { type: 'error', agent, message: event.message, timestamp };
    default:
      return null;
  }
}

/** Adapter exit verdict from the child's exit code and the abort flag. */
export function exitCodeToStatus(code: number, aborted: boolean): AdapterExit {
  if (aborted) return 'aborted';
  return code === 0 ? 'success' : 'error';
}

export interface DriverLaunchConfig<TEvent> {
  agent: string;
  /** House event stream; completes when the run ends. */
  events: AsyncIterable<TEvent>;
  /** One house event to zero+ core events. */
  mapEvent: (event: TEvent) => CoreAgentEvent | CoreAgentEvent[] | null | undefined;
  /** Resolves with the child's exit code (-1 on signal). */
  exit: Promise<number>;
  /** Kill the in-flight run (SIGTERM, existing escalation logic OK). */
  abort: () => void;
  /** True once abort() was requested out-of-band (e.g. adapter-level sweep). */
  isAborted?: () => boolean;
  /** Session id captured so far, when the source tracks it out-of-band. */
  liveSessionId?: () => string | undefined;
  fallbackSessionId?: string;
  /** How long launch() waits for a stream-captured session id (default 2s). */
  sessionIdWaitMs?: number;
  /**
   * Handle -> driver hand-off for the kiro requested-vs-effective config.
   * Passed straight through to `AgentHandle.kiro` (src/core/types.ts); kiro
   * runs only, and only meaningful once wait() has settled.
   */
  kiro?: () => KiroEffective | undefined;
}

/**
 * Wrap a house run (events + exit code + abort) in the core AgentHandle
 * contract: attach() yields mapped core events, wait() resolves the adapter
 * exit verdict, and sessionId settles to the first id the stream reports (or
 * the fallback / spec.resume id when the CLI never emits one).
 */
export async function launchDriverHandle<TEvent>(config: DriverLaunchConfig<TEvent>): Promise<CoreAgentHandle> {
  const { agent, events, mapEvent, exit, sessionIdWaitMs } = config;
  const queue = new EventQueue<CoreAgentEvent>();
  let liveId: string | undefined;
  let resolveCaptured: (() => void) | undefined;
  const captured = new Promise<void>((resolve) => {
    resolveCaptured = resolve;
  });

  const noteSession = (event: CoreAgentEvent): void => {
    if (!liveId && typeof event.sessionId === 'string' && event.sessionId !== '') {
      liveId = event.sessionId;
      resolveCaptured?.();
    }
  };

  // Pump eagerly so events buffer while the caller is still awaiting launch(),
  // and so sessionId capture starts immediately.
  void (async () => {
    try {
      for await (const houseEvent of events) {
        const mapped = mapEvent(houseEvent);
        if (!mapped) continue;
        for (const coreEvent of Array.isArray(mapped) ? mapped : [mapped]) {
          noteSession(coreEvent);
          queue.push(coreEvent);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      queue.push({ type: 'error', agent, content: `event stream failed: ${message}`, timestamp: Date.now() });
    } finally {
      queue.close();
    }
  })();

  // Namespaced fallback (`<agent>-<uuid>`): load-bearing for transcript file
  // naming (<stateDir>/raw/<agent>-<sessionId>.jsonl) and multi-agent
  // uniqueness — adapters must NOT replace it with their native id. Kiro
  // surfaces its bare on-disk id alongside, via extra.kiroSessionId on usage
  // records (KiroAdapter.#mapWithNativeSession) and KiroRunHandle.nativeSessionId().
  const fallback = config.fallbackSessionId ?? `${agent}-${randomUUID()}`;
  let aborted = false;
  const handle: CoreAgentHandle = {
    get sessionId() {
      return config.liveSessionId?.() ?? liveId ?? fallback;
    },
    attach: (): AsyncIterable<CoreAgentEvent> => queue,
    abort: (): void => {
      if (aborted) return;
      aborted = true;
      config.abort();
    },
    wait: (): Promise<AdapterExit> =>
      exit.then((code) => exitCodeToStatus(code, aborted || (config.isAborted?.() ?? false))),
    ...(config.kiro ? { kiro: config.kiro } : {}),
  };

  if ((sessionIdWaitMs ?? 2000) > 0) {
    await Promise.race([
      captured,
      exit.then(() => undefined),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, sessionIdWaitMs ?? 2000);
        timer.unref?.();
      }),
    ]);
  }
  return handle;
}
