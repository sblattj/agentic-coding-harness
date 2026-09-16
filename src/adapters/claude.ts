/**
 * Claude Code driver adapter for agentic-coding-harness.
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
  SandboxPolicy,
} from '../core/types.js';
import {
  launchDriverHandle,
  mcpConfigToken,
  scrubEnvVars,
  takeOnOutput,
  toCoreTokenRecord,
  type HouseTokens,
} from './shared.ts';

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
  /**
   * Typed sandbox/permission policy (issue #8): allowedTools →
   * `--allowedTools <csv>`, disallowedTools → `--disallowedTools <csv>`,
   * permissionMode → `--permission-mode` ("ask"→"default", "dontAsk"→
   * "bypassPermissions", else verbatim), mcpConfig → `--mcp-config` (path or
   * inline JSON), scrubEnv scrubs provider credential env vars before spawn.
   */
  sandbox?: SandboxPolicy;
  /** Raw stdout tap (RunOptions.onOutput semantics; guarded, never breaks the run). */
  onOutput?: (chunk: string) => void;
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
  | {
      /**
       * Tool activity lifted out of the stream-json content blocks: a `start`
       * per `tool_use` block on an assistant line, a `result` per `tool_result`
       * block on a user line. Bridged to the core tool_call/tool_result pair by
       * claudeEventToCore().
       */
      type: 'tool';
      payload:
        | { phase: 'start'; toolCallId: string; name: string; input: unknown }
        | {
            phase: 'result';
            toolCallId: string;
            output: string | Record<string, unknown>;
            isError?: boolean;
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

const UserLineSchema = z.object({
  type: z.literal('user'),
  message: z.object({
    content: z.array(z.any()).optional(),
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

/** `tool_use` content blocks of an assistant line, in stream order. */
function toolUsesFromContent(
  content: unknown[] | undefined,
): { toolCallId: string; name: string; input: unknown }[] {
  if (!Array.isArray(content)) return [];
  const out: { toolCallId: string; name: string; input: unknown }[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type !== 'tool_use') continue;
    out.push({
      toolCallId: typeof b.id === 'string' ? b.id : '',
      name: typeof b.name === 'string' ? b.name : '',
      input: b.input,
    });
  }
  return out;
}

/**
 * `tool_result.content` is a string, an array of `{type:'text',text}` blocks
 * (joined), an arbitrary object (passed through), or absent (→ '').
 */
function toolResultContent(value: unknown): string | Record<string, unknown> {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .filter(
        (b): b is { text: string } =>
          typeof b === 'object' && b !== null && typeof (b as any).text === 'string',
      )
      .map((b) => b.text)
      .join('');
  }
  if (typeof value === 'object') return value as Record<string, unknown>;
  return String(value);
}

/** `tool_result` content blocks of a user line, in stream order. */
function toolResultsFromContent(
  content: unknown[] | undefined,
): { toolCallId: string; output: string | Record<string, unknown>; isError?: boolean }[] {
  if (!Array.isArray(content)) return [];
  const out: {
    toolCallId: string;
    output: string | Record<string, unknown>;
    isError?: boolean;
  }[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type !== 'tool_result') continue;
    out.push({
      toolCallId: typeof b.tool_use_id === 'string' ? b.tool_use_id : '',
      output: toolResultContent(b.content),
      // Only set when the provider said so, matching shared.ts (which sets
      // isError only when a status is known).
      ...(typeof b.is_error === 'boolean' ? { isError: b.is_error } : {}),
    });
  }
  return out;
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
    case 'tool': {
      const p = event.payload;
      if (p.phase === 'start') {
        return {
          type: 'tool_call',
          agent: 'claude',
          toolCallId: p.toolCallId,
          functionName: p.name,
          arguments: (p.input as Record<string, unknown> | string | undefined) ?? '',
          timestamp,
        };
      }
      return {
        type: 'tool_result',
        agent: 'claude',
        toolCallId: p.toolCallId,
        content: p.output,
        ...(p.isError !== undefined ? { isError: p.isError } : {}),
        timestamp,
      };
    }
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
  /** Harness state dir. Default: $AGENTIC_CODING_HARNESS_STATE_DIR or ~/.agentic-coding-harness/state */
  stateDir?: string;
  /** claude binary override (tests, PATH pinning). Default: 'claude'. */
  command?: string;
  /** Injectable spawn for tests. Default: node child_process.spawn. */
  spawnFn?: SpawnFn;
  /**
   * Do NOT set a per-run CLAUDE_CONFIG_DIR; let the child use Claude Code's
   * default config so a keychain-bound OAuth login (macOS, no
   * ~/.claude/.credentials.json) authenticates. Also enabled by the env var
   * AGENTIC_CODING_HARNESS_DEFAULT_CLAUDE_CONFIG=1. Trade-off: the transcript file
   * lands under ~/.claude/projects instead of the state dir, and concurrent
   * runs share one config. Issue #3.
   */
  useDefaultClaudeConfig?: boolean;
}

/** True when the run should use the default (authenticated) Claude config. */
export function useDefaultClaudeConfig(opts: ClaudeAdapterOptions, env: NodeJS.ProcessEnv = process.env): boolean {
  return opts.useDefaultClaudeConfig === true || env.AGENTIC_CODING_HARNESS_DEFAULT_CLAUDE_CONFIG === '1';
}

/**
 * SandboxPolicy → claude CLI flags (issue #8): `--allowedTools <csv>`,
 * `--disallowedTools <csv>`, `--permission-mode` ("ask"→"default",
 * "dontAsk"→"bypassPermissions", native spellings verbatim), `--mcp-config`
 * (path string verbatim, object inline JSON). Empty allow/deny lists emit no
 * flag. Pure; exported for tests. scrubEnv is handled on the env side.
 */
export function claudeSandboxArgs(sandbox: SandboxPolicy): string[] {
  const args: string[] = [];
  if (sandbox.allowedTools?.length) args.push('--allowedTools', sandbox.allowedTools.join(','));
  if (sandbox.disallowedTools?.length) args.push('--disallowedTools', sandbox.disallowedTools.join(','));
  if (sandbox.permissionMode !== undefined) {
    const mode =
      sandbox.permissionMode === 'ask'
        ? 'default'
        : sandbox.permissionMode === 'dontAsk'
          ? 'bypassPermissions'
          : sandbox.permissionMode;
    args.push('--permission-mode', mode);
  }
  if (sandbox.mcpConfig !== undefined) args.push('--mcp-config', mcpConfigToken(sandbox.mcpConfig));
  return args;
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
      process.env.AGENTIC_CODING_HARNESS_STATE_DIR ??
      path.join(os.homedir(), '.agentic-coding-harness', 'state');
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
      sandbox: spec.sandbox,
      onOutput: takeOnOutput(spec),
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
    // Sandbox scrub (issue #8) runs BEFORE the config-dir logic so ambient
    // provider credentials and an inherited CLAUDE_CONFIG_DIR are dropped,
    // while the adapter's own per-run config dir (isolation plumbing, not a
    // credential) is still applied below.
    const childEnv: NodeJS.ProcessEnv = scrubEnvVars(
      { ...process.env, ...task.env },
      task.sandbox?.scrubEnv,
    );
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
    if (task.sandbox) {
      args.push(...claudeSandboxArgs(task.sandbox));
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
      // Raw stdout tap (guarded: a consumer tap must never break the run).
      if (task.onOutput) {
        try {
          task.onOutput(chunk);
        } catch {
          /* tap errors are deliberately swallowed */
        }
      }
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
      // Tools come AFTER the message so the transcript reads text-then-tools.
      for (const use of toolUsesFromContent(message.content)) {
        this.push({ type: 'tool', payload: { phase: 'start', ...use } });
      }
      return;
    }
    if (kind === 'user') {
      // User lines carry tool_result blocks. Deliberately LENIENT: a malformed
      // user line is ignored without incrementing parseErrors, because
      // parseErrors counts only lines the adapter claims to fully understand
      // (system/assistant/result) and user lines are a permissive passthrough.
      const parsed = UserLineSchema.safeParse(raw);
      if (!parsed.success) return;
      for (const result of toolResultsFromContent(parsed.data.message.content)) {
        this.push({ type: 'tool', payload: { phase: 'result', ...result } });
      }
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
    // stream_event / other lines: ignored (forward compatible).
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
