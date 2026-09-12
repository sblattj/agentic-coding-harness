/**
 * Claude Code driver adapter for agent-harness.
 *
 * Spawns the `claude` CLI headless (`-p`) with stream-json output, parses the
 * NDJSON stdout stream into harness AgentEvents, and exposes attach()/abort().
 *
 * The local types below remain exported for the adapter-lane tests; the driver
 * contract (src/core/driver.ts) is satisfied additively via `name`,
 * `capabilities`, and `launch(spec)` which maps this file's local events onto
 * the core AgentEvent / CanonicalTokenRecord shapes.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import type {
  AgentAdapter as CoreAgentAdapter,
  AgentEvent as CoreAgentEvent,
  AgentHandle as CoreAgentHandle,
  CanonicalTokenRecord as CoreTokenRecord,
  RunSpec as CoreRunSpec,
} from '../core/types.js';
import { launchDriverHandle, toCoreTokenRecord, type HouseTokens } from './shared.ts';

// ---------------------------------------------------------------------------
// Local adapter-lane types (kept exported for existing tests; the core
// AgentEvent/CanonicalTokenRecord shapes are bridged in launch() below)
// ---------------------------------------------------------------------------

export interface RunSpec {
  prompt: string;
  maxTurns?: number;
  /** Session id from a previous run; passed to claude as `--resume`. */
  resume?: string;
  cwd?: string;
  env?: Record<string, string>;
  extraArgs?: string[];
}

export interface ModelTokenUsage {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Subset of output spent on extended thinking. */
  reasoning: number;
  costUsd?: number;
}

export interface CanonicalTokenRecord {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Subset of output spent on extended thinking. */
  reasoning: number;
  /** result.total_cost_usd (whole run). Omitted for per-message usage. */
  costUsd?: number;
  /** Per-model breakdown (result.modelUsage). */
  models: ModelTokenUsage[];
}

export type AgentEvent =
  | { type: 'step'; payload: { sessionId?: string; model?: string } }
  | {
      type: 'message';
      payload: {
        role: 'assistant';
        model?: string;
        text?: string;
        usage?: CanonicalTokenRecord;
      };
    }
  | { type: 'usage'; payload: CanonicalTokenRecord }
  | {
      type: 'aborted';
      payload: { exitCode: number | null; signal: string | null };
    }
  | {
      type: 'error';
      payload: {
        exitCode: number | null;
        signal: string | null;
        message?: string;
        stderrTail?: string;
      };
    };

// ---------------------------------------------------------------------------
// Child-process seam (injectable for tests)
// ---------------------------------------------------------------------------

export interface HarnessChildProcess {
  stdout: Readable | null;
  stderr: Readable | null;
  on(event: 'close', listener: (code: number | null, signal: string | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  kill(signal?: string): boolean;
  pid?: number;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => HarnessChildProcess;

// ---------------------------------------------------------------------------
// Claude stream-json schemas (stdlib + zod only)
// ---------------------------------------------------------------------------

/** Tolerant number: missing/NaN/null coerces to 0 so forward-compat streams never throw. */
const safeNum = z.preprocess(
  (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0),
  z.number(),
);

const ClaudeUsageSchema = z.object({
  input_tokens: safeNum,
  output_tokens: safeNum,
  cache_creation_input_tokens: safeNum,
  cache_read_input_tokens: safeNum,
  reasoning_tokens: safeNum,
});

const InitLineSchema = z.object({
  type: z.literal('system'),
  subtype: z.string().optional(),
  session_id: z.string().optional(),
  model: z.string().optional(),
});

const AssistantLineSchema = z.object({
  type: z.literal('assistant'),
  message: z.object({
    model: z.string().optional(),
    content: z.array(z.any()).optional(),
    usage: ClaudeUsageSchema.optional(),
  }),
  session_id: z.string().optional(),
});

const ModelUsageEntrySchema = z.object({
  inputTokens: safeNum,
  cacheCreationInputTokens: safeNum,
  cacheReadInputTokens: safeNum,
  outputTokens: safeNum,
  reasoningTokens: safeNum,
  costUSD: z.number().optional(),
});

const ResultLineSchema = z.object({
  type: z.literal('result'),
  subtype: z.string().optional(),
  session_id: z.string().optional(),
  is_error: z.boolean().optional(),
  total_cost_usd: z.number().optional(),
  usage: ClaudeUsageSchema.optional(),
  modelUsage: z.record(z.string(), ModelUsageEntrySchema).optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_TURNS = 250;
const ABORT_ESCALATE_MS = 5_000;
const STDERR_TAIL_LIMIT = 8 * 1024;

function textFromContent(content: unknown[] | undefined): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter(
      (b): b is { type: 'text'; text: string } =>
        typeof b === 'object' && b !== null && (b as any).type === 'text' &&
        typeof (b as any).text === 'string',
    )
    .map((b) => b.text)
    .join('');
  return text.length > 0 ? text : undefined;
}

function canonicalFromMessageUsage(
  u: z.infer<typeof ClaudeUsageSchema>,
  model?: string,
): CanonicalTokenRecord {
  return {
    input: u.input_tokens,
    output: u.output_tokens,
    cacheRead: u.cache_read_input_tokens,
    cacheWrite: u.cache_creation_input_tokens,
    reasoning: u.reasoning_tokens,
    models: model
      ? [
          {
            model,
            input: u.input_tokens,
            output: u.output_tokens,
            cacheRead: u.cache_read_input_tokens,
            cacheWrite: u.cache_creation_input_tokens,
            reasoning: u.reasoning_tokens,
          },
        ]
      : [],
  };
}

/**
 * Build the CanonicalTokenRecord from `result.modelUsage`, preferring it over
 * the aggregate `result.usage` (modelUsage carries the cache read/write and
 * reasoning splits per model plus per-model cost).
 */
function canonicalFromModelUsage(
  mu: z.infer<typeof ResultLineSchema>['modelUsage'],
  totalCostUsd: number | undefined,
): CanonicalTokenRecord | undefined {
  if (!mu) return undefined;
  const models: ModelTokenUsage[] = Object.entries(mu).map(([model, v]) => ({
    model,
    input: v.inputTokens,
    output: v.outputTokens,
    cacheRead: v.cacheReadInputTokens,
    cacheWrite: v.cacheCreationInputTokens,
    reasoning: v.reasoningTokens,
    ...(v.costUSD !== undefined ? { costUsd: v.costUSD } : {}),
  }));
  const sum = (pick: (m: ModelTokenUsage) => number) => models.reduce((a, m) => a + pick(m), 0);
  const record: CanonicalTokenRecord = {
    input: sum((m) => m.input),
    output: sum((m) => m.output),
    cacheRead: sum((m) => m.cacheRead),
    cacheWrite: sum((m) => m.cacheWrite),
    reasoning: sum((m) => m.reasoning),
    models,
    ...(totalCostUsd !== undefined ? { costUsd: totalCostUsd } : {}),
  };
  return record;
}

/**
 * Model label for the aggregated core record: the model itself when only one
 * appears; otherwise the dominant one BY COST (reported costUsd), falling
 * back to the 'multi' sentinel when no slice carries a cost. Never first/last
 * — the provider's modelUsage key order is not usage order (the haiku
 * sub-agent probe can sort first while opus carries ~99% of the cost).
 */
function modelLabel(models: ModelTokenUsage[]): string | undefined {
  if (models.length === 0) return undefined;
  if (models.length === 1) return models[0]!.model;
  let dominant: ModelTokenUsage | undefined;
  for (const m of models) {
    if (typeof m.costUsd !== 'number') continue;
    if (dominant === undefined || m.costUsd > dominant.costUsd!) dominant = m;
  }
  return dominant?.model ?? 'multi';
}

/**
 * Claude-local usage record → core CanonicalTokenRecord. Anthropic's
 * input_tokens is already UNCACHED input (cache reads/writes are separate
 * fields), so it maps 1:1 onto inputTokens/cacheReadTokens/cacheWriteTokens.
 *
 * Aggregate totals deliberately KEEP every reported token — including
 * sub-agent/probe calls that never appear in the session JSONL (observed: 950
 * haiku input tokens present in modelUsage but absent from the transcript;
 * kept because they were real API calls). Pricing must therefore never treat
 * the aggregate as a single model: the pricer sums the per-model breakdown
 * carried in extra.raw.models, billing the probe at haiku rates and the
 * main-model tokens at theirs.
 */
function claudeUsageToCore(record: CanonicalTokenRecord): CoreTokenRecord {
  const tokens: HouseTokens = {
    inputTokens: record.input,
    cacheReadTokens: record.cacheRead,
    cacheWriteTokens: record.cacheWrite,
    outputTokens: record.output,
    reasoningTokens: record.reasoning,
    totalTokens: null,
    durationMs: null,
    raw: record,
  };
  const model = modelLabel(record.models);
  return toCoreTokenRecord('claude', tokens, {
    ...(model !== undefined ? { model } : {}),
    ...(record.costUsd !== undefined ? { costUsd: record.costUsd } : {}),
  });
}

/** Claude-local AgentEvent → core AgentEvent (driver lane). */
function claudeEventToCore(event: AgentEvent): CoreAgentEvent {
  const timestamp = Date.now();
  switch (event.type) {
    case 'step':
      return {
        type: 'step',
        agent: 'claude',
        sessionId: event.payload.sessionId,
        model: event.payload.model,
        data: event.payload,
        timestamp,
      };
    case 'message':
      return {
        type: 'message',
        agent: 'claude',
        source: 'agent',
        model: event.payload.model,
        content: event.payload.text ?? '',
        ...(event.payload.usage
          ? { usage: claudeUsageToCore(event.payload.usage) }
          : {}),
        timestamp,
      };
    case 'usage':
      return {
        type: 'usage',
        agent: 'claude',
        usage: claudeUsageToCore(event.payload),
        data: event.payload,
        timestamp,
      };
    case 'aborted':
      // AbortedEvent: exitCode/signal ride on `data` (claude-lane vocabulary).
      return { type: 'aborted', agent: 'claude', data: event.payload, timestamp };
    case 'error':
      return {
        type: 'error',
        agent: 'claude',
        message: event.payload.message ?? 'claude run failed',
        data: event.payload,
        timestamp,
      };
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface ClaudeAdapterOptions {
  /** Harness state dir. Default: $AGENT_HARNESS_STATE_DIR or ~/.agent-harness/state */
  stateDir?: string;
  /** claude binary override (tests, PATH pinning). Default: 'claude'. */
  command?: string;
  /** Injectable spawn for tests. Default: node child_process.spawn. */
  spawnFn?: SpawnFn;
  /**
   * Do NOT set a per-run CLAUDE_CONFIG_DIR; let the child use Claude Code's
   * default config so a keychain-bound OAuth login (macOS, no
   * ~/.claude/.credentials.json) authenticates. Also enabled by the env var
   * AGENT_HARNESS_DEFAULT_CLAUDE_CONFIG=1. Trade-off: the transcript file
   * lands under ~/.claude/projects instead of the state dir, and concurrent
   * runs share one config. Issue #3.
   */
  useDefaultClaudeConfig?: boolean;
}

/** True when the run should use the default (authenticated) Claude config. */
export function useDefaultClaudeConfig(opts: ClaudeAdapterOptions, env: NodeJS.ProcessEnv = process.env): boolean {
  return opts.useDefaultClaudeConfig === true || env.AGENT_HARNESS_DEFAULT_CLAUDE_CONFIG === '1';
}

export class ClaudeCodeAdapter implements CoreAgentAdapter {
  readonly name = 'claude';
  readonly capabilities = capabilities();
  /** claude enforces budget.maxTurns itself via --max-turns. */
  readonly enforcesBudget = true;

  private readonly opts: Required<Pick<ClaudeAdapterOptions, 'stateDir' | 'command'>> &
    ClaudeAdapterOptions;
  private readonly events: AgentEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private child: HarnessChildProcess | null = null;
  private done = false;
  private aborted = false;
  private sawResult = false;
  private parseErrors = 0;
  private stderrTail = '';
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private exitInfo: { code: number | null; signal: string | null } | null = null;
  private exitResolve: ((v: { code: number | null; signal: string | null; aborted: boolean }) => void) | null = null;
  private readonly exitDeferred = new Promise<{ code: number | null; signal: string | null; aborted: boolean }>(
    (resolve) => {
      this.exitResolve = resolve;
    },
  );
  /** Per-run CLAUDE_CONFIG_DIR (transcripts captured by construction). */
  configDir: string | null = null;
  sessionId: string | null = null;
  /** Runners started by launch() on this adapter; abort() sweeps them. */
  private readonly launchedRunners = new Set<{ abort(): void }>();

  constructor(options: ClaudeAdapterOptions = {}) {
    const stateDir =
      options.stateDir ??
      process.env.AGENT_HARNESS_STATE_DIR ??
      path.join(os.homedir(), '.agent-harness', 'state');
    this.opts = { ...options, stateDir, command: options.command ?? 'claude' };
  }

  /**
   * Driver contract (src/core/driver.ts): launch one run for a core RunSpec.
   * Each call wraps a fresh single-run adapter instance, so one driver-facing
   * adapter can hold several concurrent runs.
   */
  async launch(spec: CoreRunSpec): Promise<CoreAgentHandle> {
    const runner = new ClaudeCodeAdapter(this.opts);
    runner.spawn({
      prompt: spec.prompt,
      resume: spec.resume,
      maxTurns: spec.budget?.maxTurns,
      cwd: spec.cwd,
      env: spec.env,
      extraArgs: spec.extraArgs,
    });
    this.launchedRunners.add(runner);
    void runner.waitExit().finally(() => this.launchedRunners.delete(runner));
    return launchDriverHandle({
      agent: 'claude',
      events: runner.attach(),
      mapEvent: (event) => claudeEventToCore(event),
      exit: runner
        .waitExit()
        .then((r) => r.code ?? (r.signal !== null ? -1 : 1)),
      abort: () => runner.abort(),
      isAborted: () => runner.wasAborted(),
      liveSessionId: () => runner.sessionId ?? undefined,
      fallbackSessionId: spec.resume,
    });
  }

  /** True once abort() was requested on this run. */
  wasAborted(): boolean {
    return this.aborted;
  }

  /** Resolves on run end with the child's exit state (for the launch bridge). */
  waitExit(): Promise<{ code: number | null; signal: string | null; aborted: boolean }> {
    return this.exitDeferred;
  }

  spawn(task: RunSpec): void {
    if (this.child) throw new Error('claude adapter: spawn called twice on the same adapter');

    const runId = task.resume ?? randomUUID();
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...task.env };
    if (useDefaultClaudeConfig(this.opts)) {
      // Default config: a custom CLAUDE_CONFIG_DIR cannot see a keychain-bound
      // OAuth token ("Not logged in · Please run /login"), so drop any
      // inherited override too and leave configDir null.
      delete childEnv.CLAUDE_CONFIG_DIR;
    } else {
      const configDir = path.join(this.opts.stateDir, 'claude-runs', runId);
      mkdirSync(configDir, { recursive: true });
      this.configDir = configDir;
      childEnv.CLAUDE_CONFIG_DIR = configDir;
    }

    const args: string[] = [
      '-p',
      task.prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--max-turns',
      String(task.maxTurns ?? DEFAULT_MAX_TURNS),
    ];
    if (task.resume) {
      args.push('--resume', task.resume);
    }
    if (task.extraArgs?.length) {
      args.push(...task.extraArgs);
    }

    const spawnFn: SpawnFn = this.opts.spawnFn ?? ((cmd, a, o) => nodeSpawn(cmd, a, o) as never);
    const child = spawnFn(this.opts.command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: task.cwd,
      env: childEnv,
    });
    this.child = child;

    // NDJSON buffering across chunk boundaries.
    let buf = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) this.handleLine(line);
      }
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
    });

    child.on('error', (err: Error) => {
      this.push({
        type: 'error',
        payload: {
          exitCode: null,
          signal: null,
          message: `claude failed to spawn: ${err.message}`,
          stderrTail: this.stderrTail,
        },
      });
      this.finish();
    });

    child.on('close', (code, signal) => {
      if (buf.trim()) this.handleLine(buf.trim());
      buf = '';
      this.handleClose(code, signal);
    });
  }

  /** Async generator yielding events as they arrive (replays anything buffered first). */
  async *attach(): AsyncGenerator<AgentEvent> {
    let cursor = 0;
    for (;;) {
      while (cursor < this.events.length) {
        yield this.events[cursor++]!;
      }
      if (this.done) return;
      // notify() clears all waiters on every push, so no per-waiter cleanup needed.
      await new Promise<void>((resolve) => this.waiters.add(resolve));
    }
  }

  /**
   * SIGTERM the child. claude traps SIGTERM and exits with code 143; the
   * adapter treats that as a clean abort (`aborted` event, no `error`).
   * Escalates to SIGKILL after a grace period.
   */
  abort(): void {
    for (const runner of this.launchedRunners) runner.abort();
    if (!this.child || this.done || this.aborted) return;
    this.aborted = true;
    this.child.kill('SIGTERM');
    this.killTimer = setTimeout(() => {
      if (!this.done) this.child?.kill('SIGKILL');
    }, ABORT_ESCALATE_MS);
    this.killTimer.unref?.();
  }

  private handleLine(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      this.parseErrors++;
      return;
    }
    if (typeof raw !== 'object' || raw === null || !('type' in raw)) {
      this.parseErrors++;
      return;
    }
    const kind = (raw as { type: unknown }).type;
    if (kind === 'system') {
      const parsed = InitLineSchema.safeParse(raw);
      if (!parsed.success) {
        this.parseErrors++;
        return;
      }
      if (parsed.data.subtype !== 'init') return;
      if (parsed.data.session_id) this.sessionId = parsed.data.session_id;
      this.push({
        type: 'step',
        payload: { sessionId: parsed.data.session_id, model: parsed.data.model },
      });
      return;
    }
    if (kind === 'assistant') {
      const parsed = AssistantLineSchema.safeParse(raw);
      if (!parsed.success) {
        this.parseErrors++;
        return;
      }
      const { message } = parsed.data;
      this.push({
        type: 'message',
        payload: {
          role: 'assistant',
          model: message.model,
          text: textFromContent(message.content),
          usage: message.usage
            ? canonicalFromMessageUsage(message.usage, message.model)
            : undefined,
        },
      });
      return;
    }
    if (kind === 'result') {
      const parsed = ResultLineSchema.safeParse(raw);
      if (!parsed.success) {
        this.parseErrors++;
        return;
      }
      this.sawResult = true;
      if (parsed.data.session_id) this.sessionId = parsed.data.session_id;
      const record =
        canonicalFromModelUsage(parsed.data.modelUsage, parsed.data.total_cost_usd) ??
        (parsed.data.usage
          ? canonicalFromMessageUsage(parsed.data.usage)
          : undefined);
      if (record) this.push({ type: 'usage', payload: record });
      return;
    }
    // user / stream_event / other lines: ignored (forward compatible).
  }

  private handleClose(code: number | null, signal: string | null): void {
    if (this.done) return;
    this.exitInfo = { code, signal };
    this.clearKillTimer();
    // Any close after abort() was requested is a clean abort — including the
    // SIGKILL escalation path (137) and claude's own trapped-SIGTERM exit 143.
    const cleanAbort = this.aborted;
    if (cleanAbort) {
      this.push({ type: 'aborted', payload: { exitCode: code, signal } });
    } else if ((code ?? 1) !== 0) {
      this.push({
        type: 'error',
        payload: {
          exitCode: code,
          signal,
          message: this.sawResult
            ? `claude exited ${code} after emitting result`
            : `claude exited ${code} without emitting a result`,
          stderrTail: this.stderrTail,
        },
      });
    }
    this.finish();
  }

  private push(event: AgentEvent): void {
    this.events.push(event);
    this.notify();
  }

  private finish(): void {
    this.done = true;
    this.exitResolve?.({
      code: this.exitInfo?.code ?? null,
      signal: this.exitInfo?.signal ?? null,
      aborted: this.aborted,
    });
    this.notify();
  }

  private notify(): void {
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  private clearKillTimer(): void {
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
  }
}

const CLAUDE_CAPABILITIES = {
  headless: true,
  streaming: true,
  resume: true,
  acp: false,
  tmuxFallback: true,
} as const;

export function capabilities() {
  return CLAUDE_CAPABILITIES;
}

export default ClaudeCodeAdapter;
