import type { AdapterCapabilities, AgentAdapter, CanonicalEvent, RunHandle, RunOptions } from './types.ts';
import type {
  AdapterProfileCheck,
  AdapterProfileIssue,
  AgentAdapter as CoreAgentAdapter,
  AgentHandle as CoreAgentHandle,
  RunSpec as CoreRunSpec,
  SandboxPolicy,
} from '../core/types.js';
import {
  EventQueue,
  defaultSpawnFn,
  runJsonlCli,
  scrubEnvVars,
  launchDriverHandle,
  houseEventToCore,
  takeOnOutput,
  validateCliSessionProfile,
  type JsonlRunSpec,
  type SpawnFn,
} from './shared.ts';

/**
 * Cursor CLI agent (`cursor-agent`, brew cask `cursor-cli`; the same binary is
 * also installed as `agent`). Headless runs use
 * `cursor-agent --print --output-format stream-json [--force] -- <prompt>`,
 * which writes one JSON event per line on stdout.
 *
 * Evidence for the stream shapes (read from the cursor-agent 2026.10.01 bundle,
 * 9969.index.js, stream-json writer; read from code, not a captured live run,
 * since the verifying machine was not authenticated):
 *  - `system/init` {apiKeySource, cwd, session_id, model (display name),
 *    permissionMode (hard-coded "default", even with --force)}, then a `user`
 *    echo; `assistant` {message.content[{type:'text',text}]};
 *    `tool_call` started/completed {call_id, tool_call:{<kind>ToolCall:{args,result}},
 *    model_call_id, timestamp_ms}: protobuf toJson with default values emitted
 *    (args carry ""/0/false/[]), `result` a oneof (`{success}` / `{error}` ...).
 *  - `thinking` {subtype:'delta' (text) | 'completed' (no text)}; the CLI-internal
 *    `interaction_query`, `retry`, `connection`, `system/task_notification` and
 *    `system/background_shell_timeout` carry nothing we map and are ignored.
 *  - terminal `result` {subtype:'success', is_error, duration_ms, duration_api_ms,
 *    result, session_id, request_id, usage:{inputTokens, outputTokens,
 *    cacheReadTokens, cacheWriteTokens}}: inputTokens is already NET of cache
 *    reads/writes; `usage` is ABSENT when there are no counts; there is NO cost,
 *    model or num_turns field. Older builds put the camelCase counts at the top
 *    level of the result (aws-samples/sample-agent-cost-bench `parse_cursor_usage`).
 *  - Failures emit NO result event: the CLI writes to stderr and exits 1
 *    ("Error: Authentication required...", "Workspace Trust Required",
 *    "No previous chats found.", other handled errors as "Error: <msg>").
 *
 * Usage, in order (the issue's provenance rule, #24):
 *  1. The result states a cost (`total_cost_usd` / `cost_usd` / `costUsd` /
 *     `cost`; none exists in 2026.10.01, kept for forward compatibility):
 *     that figure is the cost, flagged `extra.vendorMetered` so the pricer never
 *     re-derives it from tokens -> provenance `reported`.
 *  2. The result states tokens only: the pricer computes the cost from the
 *     bundled table -> provenance `computed`, with a `stderrNotice` warning.
 *  3. Neither: no usage record, one warning. Cost is never estimated from
 *     transcript text lengths.
 */
export const CURSOR_CAPABILITIES: AdapterCapabilities = {
  headless: true,
  streaming: true,
  resume: true,
  acp: false,
  tmuxFallback: false,
};

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Result -> usage
// ---------------------------------------------------------------------------

export interface CursorResultUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** True when the result stated at least one positive token count. */
  hasTokens: boolean;
  /** CLI-stated cost in USD, or null. */
  costUsd: number | null;
}

/**
 * Field names probed for a CLI-stated cost, in order. These fields are absent
 * in cursor-agent 2026.10.01 (the result has no cost); kept for forward
 * compatibility with a build that adds one.
 */
const COST_FIELDS = ['total_cost_usd', 'cost_usd', 'costUsd', 'cost'] as const;

const INPUT_KEYS = ['inputTokens', 'input_tokens'];
const OUTPUT_KEYS = ['outputTokens', 'output_tokens'];
const CACHE_READ_KEYS = ['cacheReadTokens', 'cache_read_tokens', 'cache_read_input_tokens', 'cached_input_tokens'];
const CACHE_WRITE_KEYS = ['cacheWriteTokens', 'cache_write_tokens', 'cache_creation_input_tokens'];

/**
 * Read the usage a terminal `result` object states. Three shapes: the nested
 * camelCase `usage` (2026.10.01), top-level camelCase fields on the result
 * (older builds), and snake_case `usage.{input_tokens, output_tokens,
 * cached_input_tokens}`. The nested `usage` wins when it states any token
 * count; the top-level fields are then ignored (never summed).
 */
export function parseCursorResultUsage(result: unknown): CursorResultUsage {
  const r = isRec(result) ? result : {};
  const nested = isRec(r.usage) ? r.usage : {};
  const allKeys = [...INPUT_KEYS, ...OUTPUT_KEYS, ...CACHE_READ_KEYS, ...CACHE_WRITE_KEYS];
  const u = allKeys.some((k) => num(nested[k]) !== null) ? nested : r;
  const pick = (...keys: string[]): number => {
    for (const k of keys) {
      const v = num(u[k]);
      if (v !== null && v >= 0) return v;
    }
    return 0;
  };
  const inputTokens = pick(...INPUT_KEYS);
  const outputTokens = pick(...OUTPUT_KEYS);
  const cacheReadTokens = pick(...CACHE_READ_KEYS);
  const cacheWriteTokens = pick(...CACHE_WRITE_KEYS);
  let costUsd: number | null = null;
  for (const holder of [r, nested]) {
    for (const f of COST_FIELDS) {
      const v = num(holder[f]);
      if (v !== null && v >= 0) {
        costUsd = v;
        break;
      }
    }
    if (costUsd !== null) break;
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    hasTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens > 0,
    costUsd,
  };
}

/** `Claude 4 Sonnet` -> `claude-4-sonnet`: the init event reports a display name. */
export function cursorModelSlug(model: string): string {
  return model.trim().toLowerCase().replace(/\s+/g, '-');
}

export interface CursorUsageResult {
  events: CanonicalEvent[];
  warnings: string[];
}

/** Pure: usage stated by the result -> usage event + warnings (see the file header for the three paths). */
export function cursorUsageEvents(usage: CursorResultUsage | null, model: string | undefined): CursorUsageResult {
  const warnings: string[] = [];
  if (usage === null || (!usage.hasTokens && usage.costUsd === null)) {
    warnings.push(
      'cursor: the result event stated no usage (no tokens, no cost); tokens and cost unavailable (never estimated from text length)',
    );
    return { events: [], warnings };
  }
  const reported = usage.costUsd !== null;
  if (!reported) {
    warnings.push(
      'cursor: the CLI stated tokens but no cost; cost computed from the reported tokens with the bundled pricing table (provenance computed)',
    );
  }
  const event = {
    type: 'usage',
    tokens: {
      inputTokens: usage.inputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: null,
      totalTokens: usage.hasTokens
        ? usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
        : null,
      durationMs: null,
      raw: usage,
      extra: reported
        ? { vendorMetered: true, costBasis: 'cursor-reported', source: 'native', ...(usage.hasTokens ? {} : { tokensAvailable: false }) }
        : { costBasis: 'computed-from-tokens' },
    },
    ...(reported ? { cost: usage.costUsd! } : {}),
    ...(model !== undefined ? { model } : {}),
  } as unknown as CanonicalEvent;
  return { events: [event], warnings };
}

// ---------------------------------------------------------------------------
// Line parser (stdout stream-json)
// ---------------------------------------------------------------------------

export interface CursorParserOptions {
  /** Session (chat) id known up front (resume): announced on the first line. */
  sessionId?: string;
  /** Model passed with --model; wins over the init event's display name. */
  model?: string;
}

export interface CursorLineParser {
  parseLine(line: string): CanonicalEvent[];
  /** Called once after the last stdout line: emits the usage events and warnings. */
  finish(): CanonicalEvent[];
  sessionId(): string | undefined;
  /** True once the terminal `result` event was parsed (the run completed). */
  sawResult(): boolean;
}

/** `readToolCall` -> `read`; `{function:{name}}` -> name. */
function toolOf(toolCall: unknown): { name: string; body: Record<string, unknown> } {
  if (!isRec(toolCall)) return { name: 'unknown_tool', body: {} };
  for (const [key, value] of Object.entries(toolCall)) {
    if (key === 'function' && isRec(value) && typeof value.name === 'string') {
      return { name: value.name, body: { args: value.arguments } };
    }
    if (isRec(value)) return { name: key.replace(/ToolCall$/, '') || key, body: value };
  }
  return { name: 'unknown_tool', body: {} };
}

/** Oneof members of a tool `result` that mean the tool failed (shell: failure/timeout/rejected/spawnError/permissionDenied). */
const TOOL_FAILURE_KEYS = ['error', 'failure', 'rejected', 'timeout', 'spawnError', 'permissionDenied'] as const;

/** A failure member counts only when present and not null/undefined/"" (protobuf default-valued output). */
function toolResultFailed(res: unknown): boolean {
  if (!isRec(res)) return false;
  return TOOL_FAILURE_KEYS.some((k) => {
    const v = res[k];
    return v !== undefined && v !== null && v !== '';
  });
}

function textOf(message: unknown): string {
  if (!isRec(message) || !Array.isArray(message.content)) return '';
  return message.content
    .map((c) => (isRec(c) && typeof c.text === 'string' ? c.text : ''))
    .join('');
}

/**
 * Stateful stdout parser. Mapping (2026.10.01 bundle; see the file header):
 * `system/init` -> session + model; `assistant` -> assistant message;
 * `thinking` -> one reasoning message on `completed`; `tool_call`
 * started/completed -> tool start/result; `result` -> captured usage, plus an
 * error event when `is_error` is true or the subtype is not `success`. `user`
 * echoes, the CLI-internal types and unknown types are ignored.
 */
export function createCursorLineParser(options: CursorParserOptions = {}): CursorLineParser {
  let sessionId = options.sessionId;
  let announced = false;
  let initModel: string | undefined;
  let result: CursorResultUsage | null = null;
  let sawResult = false;
  let thinking = '';

  const announce = (): CanonicalEvent[] => {
    if (announced || sessionId === undefined) return [];
    announced = true;
    return [{ type: 'session', sessionId }];
  };

  const parseLine = (line: string): CanonicalEvent[] => {
    const evt = JSON.parse(line) as Record<string, unknown>;
    const out: CanonicalEvent[] = [];
    if (typeof evt.session_id === 'string' && evt.session_id !== '' && evt.session_id !== sessionId) {
      sessionId = evt.session_id;
      announced = false;
    }
    out.push(...announce());
    switch (evt.type) {
      case 'system': {
        // system/task_notification and system/background_shell_timeout: ignored on purpose.
        if (evt.subtype === 'init' && typeof evt.model === 'string' && evt.model !== '') initModel = evt.model;
        break;
      }
      case 'thinking': {
        if (evt.subtype === 'delta') {
          if (typeof evt.text === 'string') thinking += evt.text;
        } else if (evt.subtype === 'completed') {
          const text = thinking !== '' ? thinking : typeof evt.text === 'string' ? evt.text : '';
          thinking = '';
          if (text.trim() !== '') out.push({ type: 'message', role: 'assistant', text, reasoning: true });
        }
        break;
      }
      // interaction_query / retry / connection are CLI-internal (the CLI answers
      // its own queries and retries): ignored on purpose, never a warning.
      case 'interaction_query':
      case 'retry':
      case 'connection':
        break;
      case 'assistant': {
        const text = textOf(evt.message);
        if (text.trim() !== '') out.push({ type: 'message', role: 'assistant', text });
        break;
      }
      case 'tool_call': {
        const { name, body } = toolOf(evt.tool_call);
        const toolCallId = typeof evt.call_id === 'string' ? evt.call_id : undefined;
        if (evt.subtype === 'started') {
          out.push({
            type: 'tool',
            toolName: name,
            phase: 'start',
            ...(toolCallId !== undefined ? { toolCallId } : {}),
            input: body.args,
          });
        } else if (evt.subtype === 'completed') {
          const res = body.result;
          const failed = toolResultFailed(res);
          out.push({
            type: 'tool',
            toolName: name,
            phase: 'result',
            ...(toolCallId !== undefined ? { toolCallId } : {}),
            output: res,
            status: failed ? 'error' : 'success',
          });
        }
        break;
      }
      case 'result': {
        sawResult = true;
        result = parseCursorResultUsage(evt);
        if (evt.is_error === true || (typeof evt.subtype === 'string' && evt.subtype !== 'success')) {
          out.push({
            type: 'error',
            message: `cursor: run failed${typeof evt.result === 'string' && evt.result !== '' ? `: ${evt.result}` : ''}`,
          });
        }
        break;
      }
      default:
        break;
    }
    return out;
  };

  const finish = (): CanonicalEvent[] => {
    // A stream that never reached `result` did no accountable work (an auth
    // failure or a crash): the specific error is the story, not a usage warning.
    if (!sawResult) return [];
    const { events, warnings } = cursorUsageEvents(result, options.model ?? (initModel !== undefined ? cursorModelSlug(initModel) : undefined));
    const notices: CanonicalEvent[] = warnings.map((warning) => ({
      type: 'step',
      payload: { kind: 'stderrNotice', warning, countsAsTurn: false },
    }));
    return [...events, ...notices];
  };

  return { parseLine, finish, sessionId: () => sessionId, sawResult: () => sawResult };
}

// ---------------------------------------------------------------------------
// Error classification (stderr) and preflight
// ---------------------------------------------------------------------------

export const CURSOR_AUTH_HINT =
  'cursor: not authenticated. Run `cursor-agent login`, or set CURSOR_API_KEY (or pass --api-key).';

/**
 * Specific message for the unauthenticated CLI. Observed on cursor-agent
 * 2026.10.01 (exit 1, empty stdout):
 *   "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable."
 * and `cursor-agent status` prints "Not logged in" with exit 0.
 */
export function classifyCursorStderr(line: string): string | null {
  if (/Authentication required|Not logged in|not authenticated/i.test(line)) return CURSOR_AUTH_HINT;
  if (/Workspace Trust Required/i.test(line)) {
    return 'cursor: workspace trust required; the CLI refused to run in an untrusted directory (trust it in Cursor first, or pass --trust).';
  }
  if (/No previous chats found/i.test(line)) {
    return 'cursor: the --resume session id was not found ("No previous chats found."); start a new run or check the id.';
  }
  return null;
}

/**
 * Any other handled CLI error (`Error: <msg>`, then exit 1 with no `result`).
 * Only an error when the run produced no `result`: a non-fatal `Error:` line on
 * a completed run stays progress text.
 */
export function cursorGenericStderrError(line: string): string | null {
  const generic = /^\s*Error: (.+)/.exec(line);
  return generic ? `cursor: ${generic[1]!.trim()}` : null;
}

export interface CursorPreflightResult {
  ok: boolean;
  /** Specific operator-facing error when not ok. */
  message?: string;
}

/**
 * Prove what can be proven before a run: that the binary starts, and that it
 * is authenticated (CURSOR_API_KEY in the child env, or `<bin> status` not
 * answering "Not logged in"). An inconclusive probe (timeout, unknown output,
 * non-zero exit without a "Not logged in" line) passes: the run's own stderr
 * classifier still reports an auth failure. Never logs in, never sends a key.
 */
export async function cursorPreflight(opts: {
  command: string;
  env: Record<string, string | undefined>;
  cwd?: string;
  spawnFn?: SpawnFn;
  extraArgs?: string[];
  timeoutMs?: number;
}): Promise<CursorPreflightResult> {
  const keyed = (opts.env.CURSOR_API_KEY ?? '') !== '' || (opts.extraArgs ?? []).some((a) => a === '--api-key' || a.startsWith('--api-key='));
  if (keyed) return { ok: true };
  const spawnFn = opts.spawnFn ?? defaultSpawnFn;
  return new Promise<CursorPreflightResult>((resolve) => {
    let settled = false;
    let text = '';
    const done = (r: CursorPreflightResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    let child: ReturnType<SpawnFn>;
    try {
      child = spawnFn(opts.command, ['status'], { cwd: opts.cwd, env: opts.env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      done({ ok: false, message: missingBinary(opts.command, err) });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone */
      }
      done({ ok: true });
    }, opts.timeoutMs ?? 15_000);
    timer.unref?.();
    child.stdout?.on('data', (c: Buffer | string) => (text += String(c)));
    child.stderr?.on('data', (c: Buffer | string) => (text += String(c)));
    child.once('error', (err: Error) => {
      clearTimeout(timer);
      done({ ok: false, message: missingBinary(opts.command, err) });
    });
    child.once('close', () => {
      clearTimeout(timer);
      done(/not logged in|authentication required/i.test(text) ? { ok: false, message: CURSOR_AUTH_HINT } : { ok: true });
    });
  });
}

function missingBinary(command: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `cursor: could not start '${command}' (${detail}). Install the Cursor CLI (brew install --cask cursor-cli) or point CURSOR_AGENT_BIN at cursor-agent.`;
}

// ---------------------------------------------------------------------------
// argv and sandbox
// ---------------------------------------------------------------------------

/**
 * SandboxPolicy -> cursor-agent flags. permissionMode: plan -> `--mode plan`,
 * ask -> `--mode ask` (both read-only per --help); dontAsk and unset ->
 * `--force` (print mode "has access to all tools" but pre-approves commands
 * only with --force; whether a headless run blocks without it is UNVERIFIED).
 * allowedTools / disallowedTools have no flag (they live in cli-config.json
 * permissions) and are reported by cursorUnsupportedSandbox. Pure; exported for tests.
 */
export function cursorSandboxArgs(sandbox: SandboxPolicy | undefined): string[] {
  const mode = sandbox?.permissionMode;
  if (mode === 'plan' || mode === 'ask') return ['--mode', mode];
  return ['--force'];
}

/** SandboxPolicy fields cursor-agent cannot honour (see cursorSandboxArgs). */
export function cursorUnsupportedSandbox(sandbox: SandboxPolicy | undefined): AdapterProfileIssue[] {
  const issues: AdapterProfileIssue[] = [];
  const mode = sandbox?.permissionMode;
  if (mode !== undefined && mode !== 'dontAsk' && mode !== 'plan' && mode !== 'ask') {
    issues.push({ field: 'sandbox.permissionMode', message: `cursor-agent has no permission mode '${mode}' (expected dontAsk, plan or ask); treated as dontAsk (--force)` });
  }
  if ((sandbox?.allowedTools ?? []).length > 0 || (sandbox?.disallowedTools ?? []).length > 0) {
    issues.push({ field: 'sandbox.allowedTools', message: 'cursor-agent has no per-run tool allow/deny flags (permissions live in ~/.cursor/cli-config.json); not applied' });
  }
  if (sandbox?.mcpConfig !== undefined) {
    issues.push({ field: 'sandbox.mcpConfig', message: 'cursor-agent has no per-run MCP config flag (use `cursor-agent mcp` / .cursor/mcp.json); not applied' });
  }
  return issues;
}

/**
 * argv for one headless run. The prompt is the final positional after `--`, so
 * a leading '-' is never parsed as a flag (verified: `cursor-agent --print --
 * --version` reached the auth check instead of printing the version, while a
 * bare `--version` prints it). `--resume <chatId>` continues a chat. Pure.
 */
export function cursorArgs(
  prompt: string,
  opts: { model?: string; resume?: string; sandbox?: SandboxPolicy; extraArgs?: string[] } = {},
): string[] {
  return [
    '--print',
    '--output-format',
    'stream-json',
    '--trust',
    ...(opts.model !== undefined ? ['--model', opts.model] : []),
    ...(opts.resume !== undefined ? ['--resume', opts.resume] : []),
    ...cursorSandboxArgs(opts.sandbox),
    ...(opts.extraArgs ?? []),
    '--',
    prompt,
  ];
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface CursorAdapterOptions {
  /** Binary to invoke; defaults to $CURSOR_AGENT_BIN, else `cursor-agent` on PATH. */
  command?: string;
  /** Injectable spawn factory for tests. */
  spawnFn?: SpawnFn;
  extraArgs?: string[];
  /** Extra environment for every run's child (overlaid by the run's own env). */
  env?: Record<string, string>;
}

export class CursorAdapter implements AgentAdapter, CoreAgentAdapter {
  readonly id = 'cursor';
  readonly name = 'cursor';
  readonly capabilities: AdapterCapabilities = CURSOR_CAPABILITIES;

  #command: string;
  #spawnFn: SpawnFn | undefined;
  #extraArgs: string[];
  #env: Record<string, string> | undefined;
  #current: RunHandle | null = null;

  constructor(options: CursorAdapterOptions = {}) {
    this.#command = options.command ?? process.env.CURSOR_AGENT_BIN ?? 'cursor-agent';
    this.#spawnFn = options.spawnFn;
    this.#extraArgs = options.extraArgs ?? [];
    this.#env = options.env;
  }

  spawn(prompt: string, opts: RunOptions = {}): RunHandle {
    return this.#start(prompt, opts, opts.onOutput);
  }

  resume(sessionId: string, prompt: string, opts: RunOptions = {}): RunHandle {
    return this.#start(prompt, { ...opts, resume: sessionId }, opts.onOutput);
  }

  validateProfile(spec: CoreRunSpec): AdapterProfileCheck {
    const common = validateCliSessionProfile(spec);
    return { ...common, warnings: [...common.warnings, ...cursorUnsupportedSandbox(spec.sandbox)] };
  }

  /** Driver contract (src/core/driver.ts): preflight, then launch one run for a RunSpec. */
  async launch(spec: CoreRunSpec): Promise<CoreAgentHandle> {
    const childEnv = this.#env !== undefined || spec.env !== undefined ? { ...this.#env, ...spec.env } : undefined;
    const env = scrubEnvVars({ ...process.env, ...childEnv }, spec.sandbox?.scrubEnv);
    const extraArgs = [...this.#extraArgs, ...(spec.extraArgs ?? [])];
    const pre = await cursorPreflight({
      command: this.#command,
      env,
      ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
      ...(this.#spawnFn !== undefined ? { spawnFn: this.#spawnFn } : {}),
      extraArgs,
    });
    if (!pre.ok) {
      // In-band failure: one specific error event and exit 1, which the driver
      // classifies `unavailable` (no activity before the failure), not a
      // generic launch failure.
      const queue = new EventQueue<CanonicalEvent>();
      queue.push({ type: 'error', message: pre.message ?? CURSOR_AUTH_HINT });
      queue.close();
      return launchDriverHandle({
        agent: 'cursor',
        events: queue,
        mapEvent: (event) => houseEventToCore('cursor', event),
        exit: Promise.resolve(1),
        abort: () => {},
        ...(spec.resume !== undefined ? { fallbackSessionId: spec.resume } : {}),
        sessionIdWaitMs: 0,
      });
    }
    const handle = this.#start(
      spec.prompt,
      {
        ...(spec.model !== undefined ? { model: spec.model } : {}),
        ...(spec.resume !== undefined ? { resume: spec.resume } : {}),
        ...(spec.sandbox !== undefined ? { sandbox: spec.sandbox } : {}),
        ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
        ...(spec.env !== undefined ? { env: spec.env } : {}),
        extraArgs: spec.extraArgs ?? [],
      },
      takeOnOutput(spec),
    );
    return launchDriverHandle({
      agent: 'cursor',
      events: handle.events,
      mapEvent: (event) => {
        const core = houseEventToCore('cursor', event);
        const model = (event as { model?: unknown }).model;
        if (core?.type === 'usage' && core.usage && typeof model === 'string') {
          core.usage = { ...core.usage, model };
        }
        // Usage arrives once, in the terminal `result` event: final accounting.
        if (core?.type === 'usage') core.finalAccounting = true;
        return core;
      },
      exit: handle.wait(),
      abort: () => handle.abort(),
      fallbackSessionId: spec.resume,
    });
  }

  abort(): void {
    this.#current?.abort();
  }

  #start(prompt: string, opts: RunOptions & { resume?: string; extraArgs?: string[] }, onOutput?: (chunk: string) => void): RunHandle {
    const childEnv = this.#env !== undefined || opts.env !== undefined ? { ...this.#env, ...opts.env } : undefined;
    const spec: JsonlRunSpec = {
      command: this.#command,
      args: cursorArgs(prompt, {
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(opts.resume !== undefined ? { resume: opts.resume } : {}),
        ...(opts.sandbox !== undefined ? { sandbox: opts.sandbox } : {}),
        extraArgs: [...this.#extraArgs, ...(opts.extraArgs ?? [])],
      }),
      cwd: opts.cwd,
      env: childEnv,
      scrubEnv: opts.sandbox?.scrubEnv,
    };
    const parser = createCursorLineParser({
      ...(opts.resume !== undefined ? { sessionId: opts.resume } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
    });
    const reported = new Set<string>();
    // Generic `Error:` lines wait for stdout to end: they become errors only
    // when no `result` arrived. A line after stdout ended is decided at once.
    const pending: string[] = [];
    let stdoutEnded = false;
    const once = (message: string): CanonicalEvent[] => {
      if (reported.has(message)) return [];
      reported.add(message);
      return [{ type: 'error', message }];
    };
    const handle = runJsonlCli({
      spec,
      parseLine: parser.parseLine,
      spawnFn: this.#spawnFn,
      onOutput,
      onStderrLine: (line) => {
        const specific = classifyCursorStderr(line);
        if (specific !== null) return once(specific);
        const generic = cursorGenericStderrError(line);
        if (generic === null) return;
        if (!stdoutEnded) {
          pending.push(generic);
          return;
        }
        return parser.sawResult() ? undefined : once(generic);
      },
      onStdoutEnd: () => {
        stdoutEnded = true;
        const tail = parser.finish();
        if (!parser.sawResult()) for (const message of pending) tail.push(...once(message));
        return tail;
      },
    });
    this.#current = handle;
    void handle.wait().finally(() => {
      if (this.#current === handle) this.#current = null;
    });
    return handle;
  }
}
