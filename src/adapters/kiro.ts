// Kiro CLI driver adapter (adapter-lane contract, src/adapters/types.ts).
//
// Headless invocation:
//   kiro-cli chat --no-interactive --trust-all-tools --output-format stream-json --engine v3 "<prompt>"
// Resume: `--resume` (last session) or `--resume-id <sessionId>`.
// KIRO_API_KEY passes through to the child process, never stripped, so
// kiro-cli authenticates headless with the caller's ambient credentials.
//
// Token metering: kiro-cli's own stream-json usage events are under-documented;
// the reliable source is the MITM tap in src/monitors/kiro-mitm.ts (launch the
// CLI with HTTPS_PROXY/SSL_CERT_FILE — see that module's header).
//
// TODO-MERGE: the `step` variant below is a kiro-specific extension of
// CanonicalEvent (task spec: unknown stream-json events -> {type:'step',
// payload: raw}). Mirrors the opencode extension; when CanonicalEvent grows
// it, delete KiroEvent and return CanonicalEvent[] everywhere.

import type { AdapterCapabilities, CanonicalEvent, CanonicalTokenRecord, RunOptions } from './types.ts';
import type {
  AgentAdapter as CoreAgentAdapter,
  AgentHandle as CoreAgentHandle,
  RunSpec as CoreRunSpec,
} from '../core/types.js';
import { runJsonlCli, launchDriverHandle, houseEventToCore, type HouseEventLike, type SpawnFn } from './shared.ts';

export const KIRO_CAPABILITIES: AdapterCapabilities = {
  headless: true,
  streaming: true,
  resume: true,
  acp: true,
  tmuxFallback: true,
};

export interface KiroRunSpec extends RunOptions {
  prompt: string;
  model?: string;
  /** `--resume-id <id>`, or 'continue' for `--resume` (last session). */
  resume?: { sessionId: string } | 'continue';
}

/**
 * Build argv for `kiro-cli chat --no-interactive --trust-all-tools
 * --output-format stream-json --engine v3 [--resume | --resume-id <id>]
 * "<prompt>"`. Pure; exported for tests. The prompt is always the final
 * positional argument.
 */
export function buildKiroArgs(spec: KiroRunSpec): string[] {
  const args = [
    'chat',
    '--no-interactive',
    '--trust-all-tools',
    '--output-format',
    'stream-json',
    '--engine',
    'v3',
  ];
  if (spec.resume && typeof spec.resume === 'object' && spec.resume.sessionId) {
    args.push('--resume-id', spec.resume.sessionId);
  } else if (spec.resume === 'continue') {
    args.push('--resume');
  }
  args.push(spec.prompt);
  return args;
}

export function buildKiroEnv(extra: Record<string, string> = {}): Record<string, string> {
  // Wholesale inheritance is deliberate: KIRO_API_KEY (and the AWS_* chain)
  // flow through untouched; `extra` only overlays.
  return { ...(process.env as Record<string, string>), ...extra };
}

// CanonicalEvent now carries the kiro `step` variant (payload-carrying);
// KiroEvent remains as a compat alias.
export type KiroEvent = CanonicalEvent;

const SESSION_TYPES = new Set(['session', 'session_start']);
const MESSAGE_TYPES = new Set(['assistant', 'assistant_message', 'assistantResponse', 'message']);
const TOOL_START_TYPES = new Set(['tool_use', 'toolUse', 'toolInvocation']);
const TOOL_RESULT_TYPES = new Set(['tool_result', 'toolResult']);
const USAGE_TYPES = new Set(['usage', 'metering', 'token_usage']);
const ERROR_TYPES = new Set(['error', 'systemError']);

function pickString(o: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    if (typeof o[k] === 'string') return o[k] as string;
  }
  return undefined;
}

function num(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return 0;
}

/**
 * kiro token accounting in either field vocabulary: the MITM tap's AWS
 * EventStream names (uncachedInputTokens / cacheReadInputTokens /
 * cacheWriteInputTokens / totalTokens) or plain names (inputTokens /
 * cacheReadTokens / cacheWriteTokens / totalTokens) — into the adapter-lane
 * CanonicalTokenRecord.
 */
export function mapKiroTokens(o: Record<string, unknown>): CanonicalTokenRecord {
  const tu = (o.tokenUsage ?? o.usage ?? o) as Record<string, unknown>;
  return {
    inputTokens: num(tu.inputTokens ?? tu.uncachedInputTokens),
    cacheReadTokens: num(tu.cacheReadTokens ?? tu.cacheReadInputTokens),
    cacheWriteTokens: num(tu.cacheWriteTokens ?? tu.cacheWriteInputTokens),
    outputTokens: num(tu.outputTokens),
    reasoningTokens: null,
    totalTokens: num(tu.totalTokens ?? tu.total) || null,
    durationMs: null,
    raw: o,
  };
}

export interface ParsedKiroLine {
  events: KiroEvent[];
  /** sessionId from any line that carries one (resume capture). */
  sessionId?: string;
}

/**
 * Tolerant JSONL mapper for `kiro-cli --output-format stream-json`. The event
 * schema is under-documented, so: known envelope types map to canonical
 * events; any other typed JSON object maps to {type:'step', payload: raw};
 * non-JSON lines (banners, warnings) yield no events rather than throwing.
 */
export function parseKiroLineRecord(line: string): ParsedKiroLine {
  let obj: unknown;
  try {
    obj = JSON.parse(line.trim());
  } catch {
    return { events: [] };
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return { events: [] };
  const o = obj as Record<string, unknown>;
  const sessionId = pickString(o, ['sessionId', 'session_id', 'sessionID']);
  const events: KiroEvent[] = [];
  const type = typeof o.type === 'string' ? o.type : '';
  if (SESSION_TYPES.has(type) && sessionId) {
    events.push({ type: 'session', sessionId });
  } else if (MESSAGE_TYPES.has(type)) {
    const role = pickString(o, ['role']);
    events.push({
      type: 'message',
      role: role === 'user' || role === 'system' ? role : 'assistant',
      text: pickString(o, ['text', 'content', 'message']) ?? '',
    });
  } else if (TOOL_START_TYPES.has(type)) {
    events.push({
      type: 'tool',
      toolName: pickString(o, ['name', 'tool_name', 'toolName']) ?? 'unknown',
      phase: 'start',
      ...(pickString(o, ['toolCallId', 'tool_call_id', 'id'])
        ? { toolCallId: pickString(o, ['toolCallId', 'tool_call_id', 'id']) }
        : {}),
      input: o.input ?? o.arguments ?? o.args ?? null,
    });
  } else if (TOOL_RESULT_TYPES.has(type)) {
    events.push({
      type: 'tool',
      toolName: pickString(o, ['name', 'tool_name', 'toolName']) ?? 'unknown',
      phase: 'result',
      ...(pickString(o, ['toolCallId', 'tool_call_id', 'id'])
        ? { toolCallId: pickString(o, ['toolCallId', 'tool_call_id', 'id']) }
        : {}),
      output: o.output ?? o.result ?? o.content ?? null,
      ...(typeof o.isError === 'boolean' ? { status: o.isError ? ('error' as const) : ('success' as const) } : {}),
    });
  } else if (USAGE_TYPES.has(type)) {
    events.push({ type: 'usage', tokens: mapKiroTokens(o) });
  } else if (ERROR_TYPES.has(type)) {
    events.push({ type: 'error', message: pickString(o, ['message', 'error', 'reason']) ?? 'unknown error' });
  } else {
    // Unknown (or type-less) event shapes -> opaque step (tolerant contract).
    events.push({ type: 'step', payload: o });
  }
  return { events, sessionId };
}

/** Parse one line to canonical events only (house convention, like codex/gemini). */
export function parseKiroLine(line: string): KiroEvent[] {
  return parseKiroLineRecord(line).events;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface KiroRunResult {
  exitCode: number;
  sessionId?: string;
  usage?: CanonicalTokenRecord;
}

export interface KiroRunHandle {
  /** Canonical event stream (with kiro `step` extensions); ends on child exit. */
  events: AsyncIterable<KiroEvent>;
  /** Resolves with the child's exit code (-1 on signal). */
  wait(): Promise<number>;
  /** Kill the child (SIGTERM, then SIGKILL after a grace period). */
  abort(): void;
  /** Resolves once the run ends with the captured sessionId (for resume). */
  sessionId(): Promise<string | undefined>;
  /** Full exit state: exit code plus captured sessionId/usage. */
  result(): Promise<KiroRunResult>;
}

export interface KiroAdapterOptions {
  /** Binary to invoke; defaults to $KIRO_CLI_BIN or `kiro-cli` on PATH. */
  command?: string;
  /** Injectable spawn factory for tests. */
  spawnFn?: SpawnFn;
}

/**
 * Kiro CLI adapter.
 *
 * Headless `kiro-cli chat ... --output-format stream-json` with pipes, stdout
 * JSONL parsed into canonical events via the shared runJsonlCli loop. Resume
 * with `--resume-id <sessionId>` / `--resume`.
 */
export class KiroAdapter implements CoreAgentAdapter {
  readonly id = 'kiro';
  readonly name = 'kiro';
  readonly capabilities: AdapterCapabilities = KIRO_CAPABILITIES;

  readonly #command: string;
  readonly #spawnFn: SpawnFn | undefined;
  #current: { abort(): void } | null = null;

  constructor(options: KiroAdapterOptions = {}) {
    this.#command = options.command ?? process.env.KIRO_CLI_BIN ?? 'kiro-cli';
    this.#spawnFn = options.spawnFn;
  }

  /** House-style spawn: prompt string + run options. */
  spawn(prompt: string, opts?: RunOptions): KiroRunHandle;
  /** Task-style spawn: full spec object (model, resume). */
  spawn(task: KiroRunSpec): KiroRunHandle;
  spawn(promptOrTask: string | KiroRunSpec, opts: RunOptions = {}): KiroRunHandle {
    const task: KiroRunSpec =
      typeof promptOrTask === 'string' ? { prompt: promptOrTask, ...opts } : promptOrTask;
    const state: { sessionId?: string; usage?: CanonicalTokenRecord } = {};
    const handle = runJsonlCli({
      spec: {
        command: this.#command,
        args: buildKiroArgs(task),
        cwd: task.cwd,
        env: buildKiroEnv(task.env),
      },
      parseLine: (line): CanonicalEvent[] => {
        const parsed = parseKiroLineRecord(line);
        if (parsed.sessionId) state.sessionId = parsed.sessionId;
        for (const event of parsed.events) {
          if (event.type === 'usage') state.usage = event.tokens;
        }
        // KiroEvent[] is a strict superset of CanonicalEvent[] at runtime
        // (step events); the shared loop only types the base union.
        return parsed.events as CanonicalEvent[];
      },
      spawnFn: this.#spawnFn,
    });
    const enriched: KiroRunHandle = {
      events: handle.events as AsyncIterable<KiroEvent>,
      wait: handle.wait,
      abort: handle.abort,
      sessionId: () => handle.wait().then(() => state.sessionId),
      result: () => handle.wait().then((exitCode) => ({ exitCode, ...state })),
    };
    this.#current = enriched;
    void enriched.wait().finally(() => {
      if (this.#current === enriched) this.#current = null;
    });
    return enriched;
  }

  /** House-style resume: continue a prior session (`--resume-id <sessionId>`). */
  resume(sessionId: string, prompt: string, opts: RunOptions = {}): KiroRunHandle {
    return this.spawn({ prompt, resume: { sessionId }, ...opts });
  }

  /** Driver contract (src/core/driver.ts): launch one run for a RunSpec. */
  async launch(spec: CoreRunSpec): Promise<CoreAgentHandle> {
    const handle = this.spawn({
      prompt: spec.prompt,
      ...(spec.resume ? { resume: { sessionId: spec.resume } } : {}),
      ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
      ...(spec.env ? { env: spec.env } : {}),
    });
    return launchDriverHandle({
      agent: 'kiro',
      events: handle.events,
      // KiroEvent is a structural superset of HouseEventLike (step payload
      // extension); the bridge maps both.
      mapEvent: (event) => houseEventToCore('kiro', event as HouseEventLike),
      exit: handle.wait(),
      abort: () => handle.abort(),
      fallbackSessionId: spec.resume,
    });
  }

  /** Kill the in-flight run. */
  abort(): void {
    this.#current?.abort();
  }
}
