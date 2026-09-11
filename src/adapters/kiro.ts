// Kiro CLI driver adapter (adapter-lane contract, src/adapters/types.ts).
//
// Headless invocation:
//   kiro-cli chat --no-interactive --trust-all-tools --output-format stream-json --v3 "<prompt>"
// Resume: `--resume` (last session) or `--resume-id <sessionId>`.
// KIRO_API_KEY passes through to the child process, never stripped, so
// kiro-cli authenticates headless with the caller's ambient credentials.
//
// Token metering: kiro-cli's own stream-json usage events are under-documented;
// the reliable source is the MITM tap in src/monitors/kiro-mitm.ts. launch()
// auto-starts it (default when mitmdump is on PATH), routes the child through
// the proxy (HTTPS_PROXY/SSL_CERT_FILE via tapEnv), and interleaves the tap's
// credit/token records with the stdout events.
//
// TODO-MERGE: the `step` variant below is a kiro-specific extension of
// CanonicalEvent (task spec: unknown stream-json events -> {type:'step',
// payload: raw}). Mirrors the opencode extension; when CanonicalEvent grows
// it, delete KiroEvent and return CanonicalEvent[] everywhere.

import type { AdapterCapabilities, CanonicalEvent, CanonicalTokenRecord, RunOptions } from './types.ts';
import type {
  AgentAdapter as CoreAgentAdapter,
  AgentEvent as CoreAgentEvent,
  AgentHandle as CoreAgentHandle,
  CanonicalTokenRecord as CoreTokenRecord,
  RunSpec as CoreRunSpec,
} from '../core/types.js';
import { runJsonlCli, launchDriverHandle, houseEventToCore, EventQueue, type HouseEventLike, type SpawnFn } from './shared.ts';
import { findKiroMitmPort, mitmdumpAvailable, startKiroMitm, tapEnv, type KiroMitmHandle } from '../monitors/kiro-mitm.js';

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
 * --output-format stream-json --v3 [--resume | --resume-id <id>]
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
    // TODO(v3): `--v3` fails through the MITM tap — v3's model-catalog fetch
    // to management.us-east-1.kiro.dev dies under mitmproxy with
    // ModelRegistryUnavailableError. v2 verified working through the tap.
    '--agent-engine',
    'v2',
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
// MITM tap integration (auto-started by launch(); see KiroAdapterOptions.mitm)
// ---------------------------------------------------------------------------

/**
 * House-lane carrier for one tap record. Token counts are deliberately zero:
 * counts flow from the stdout usage events, and the tap event exists for the
 * metering credits — `extra.credits`, which are metering units, NOT USD, so
 * `costUsd` stays undefined everywhere.
 */
export interface KiroMitmUsageEvent {
  type: 'usage';
  /** Zeroed adapter token record (counts come from stdout usage events). */
  tokens: CanonicalTokenRecord;
  /** Core CanonicalTokenRecord from parseMitmLine(); credits in extra.credits. */
  mitmRecord: CoreTokenRecord;
}

/** House events the kiro lane can emit: stream events plus tap carriers. */
export type KiroLaneEvent = KiroEvent | KiroMitmUsageEvent;

/** Convert one tap record into its zero-token house carrier event. */
export function mitmRecordToUsageEvent(rec: CoreTokenRecord): KiroMitmUsageEvent {
  return {
    type: 'usage',
    tokens: {
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: null,
      totalTokens: null,
      durationMs: null,
      raw: rec.extra?.raw ?? rec,
    },
    mitmRecord: rec,
  };
}

/**
 * Kiro lane event -> core AgentEvent. Tap carriers map directly so
 * `extra.credits` survives the bridge; everything else goes through the
 * shared house bridge.
 */
export function kiroEventToCore(event: KiroLaneEvent): CoreAgentEvent | null {
  if (event.type === 'usage' && 'mitmRecord' in event) {
    const rec = event.mitmRecord;
    const timestamp = Date.now();
    return {
      type: 'usage',
      agent: 'kiro',
      usage: {
        agent: 'kiro',
        ...(typeof rec.model === 'string' && rec.model !== '' ? { model: rec.model } : {}),
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        extra: rec.extra,
        timestamp,
      },
      data: rec.extra?.raw,
      timestamp,
    };
  }
  return houseEventToCore('kiro', event as HouseEventLike);
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
  /**
   * Auto-start the MITM credit/token tap (src/monitors/kiro-mitm.ts) on
   * launch(). Default: auto — on when mitmdump resolves (PATH probe, cached)
   * and no test spawnFn was injected; an explicit true/false always wins.
   * True with mitmdump missing degrades gracefully (warning, run continues
   * untapped).
   */
  mitm?: boolean;
  /** mitmdump binary for the tap; defaults to $MITMDUMP_BIN or `mitmdump`. */
  mitmdumpBin?: string;
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
  readonly #mitmOpt: boolean | undefined;
  readonly #mitmdumpBin: string;
  #current: { abort(): void } | null = null;

  constructor(options: KiroAdapterOptions = {}) {
    this.#command = options.command ?? process.env.KIRO_CLI_BIN ?? 'kiro-cli';
    this.#spawnFn = options.spawnFn;
    this.#mitmOpt = options.mitm;
    this.#mitmdumpBin = options.mitmdumpBin ?? process.env.MITMDUMP_BIN ?? 'mitmdump';
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

  /** Resolve the mitm option: explicit wins; the default is auto — the PATH
   * probe result, except an injected test spawnFn keeps unit runs tap-less. */
  #mitmRequested(): boolean {
    if (this.#mitmOpt !== undefined) return this.#mitmOpt;
    if (this.#spawnFn) return false;
    return mitmdumpAvailable(this.#mitmdumpBin);
  }

  /**
   * Start the tap: probe done, first bindable port in 8900-8999, mitmdump
   * with the inline addon. Returns null (with a stderr warning) when the tap
   * is unavailable — the run proceeds untapped either way.
   */
  async #startMitmTap(): Promise<KiroMitmHandle | null> {
    if (!mitmdumpAvailable(this.#mitmdumpBin)) {
      process.stderr.write(
        `[warn] kiro: mitmdump ("${this.#mitmdumpBin}") not found; running without the credit/token tap\n`,
      );
      return null;
    }
    const port = await findKiroMitmPort();
    if (port === null) {
      process.stderr.write('[warn] kiro: no free port in 8900-8999 for the MITM tap; running without it\n');
      return null;
    }
    try {
      const mitm = startKiroMitm(port, { mitmdumpBin: this.#mitmdumpBin });
      mitm.on('error', (err: Error) => {
        process.stderr.write(`[warn] kiro: MITM tap failed: ${err.message}; continuing without tap records\n`);
      });
      return mitm;
    } catch (err) {
      process.stderr.write(
        `[warn] kiro: MITM tap failed to start (${err instanceof Error ? err.message : String(err)}); running without it\n`,
      );
      return null;
    }
  }

  /** launch() with the tap: merged stdout+tap event stream, tap env on the
   * child, tap stopped (graceful SIGTERM) when the run settles or aborts. */
  #launchWithMitmTap(spec: CoreRunSpec, mitm: KiroMitmHandle): Promise<CoreAgentHandle> {
    // One merged stream: stdout events plus tap records interleaved. Records
    // can land after the child exits (trailing frames), so the merge closes
    // only once the tap has stopped.
    const merged = new EventQueue<KiroLaneEvent>();
    mitm.on('record', (rec: CoreTokenRecord) => merged.push(mitmRecordToUsageEvent(rec)));

    const handle = this.spawn({
      prompt: spec.prompt,
      ...(spec.resume ? { resume: { sessionId: spec.resume } } : {}),
      ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
      // tapEnv's NodeJS.ProcessEnv typing is `string | undefined` per key;
      // both keys are always set, so the cast is safe for the child env.
      env: { ...(spec.env ?? {}), ...(tapEnv(mitm.port) as Record<string, string>) },
    });

    let stopped = false;
    const stopTap = async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      await mitm.stop(); // graceful SIGTERM, SIGKILL after the grace period
    };

    void (async () => {
      try {
        for await (const event of handle.events) merged.push(event);
      } catch {
        /* the bridge surfaces stream errors; keep draining so we close */
      }
      try {
        await handle.wait();
      } catch {
        /* exit already settled */
      }
      await stopTap();
      merged.close();
    })();

    return launchDriverHandle({
      agent: 'kiro',
      events: merged,
      mapEvent: (event) => kiroEventToCore(event),
      // Stop the tap once the run settles (wait) or is aborted, before the
      // exit verdict resolves — no mitmdump outlives the run.
      exit: handle.wait().then(async (code) => {
        await stopTap();
        return code;
      }),
      abort: () => {
        void stopTap();
        handle.abort();
      },
      fallbackSessionId: spec.resume,
    });
  }

  #launchPlain(spec: CoreRunSpec): Promise<CoreAgentHandle> {
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

  /** Driver contract (src/core/driver.ts): launch one run for a RunSpec.
   * With the tap enabled (default when mitmdump is on PATH), kiro-cli is
   * routed through the MITM proxy so per-run credit/token records are
   * captured; failures degrade to the untapped path with a warning. */
  async launch(spec: CoreRunSpec): Promise<CoreAgentHandle> {
    if (!this.#mitmRequested()) return this.#launchPlain(spec);
    const mitm = await this.#startMitmTap();
    if (!mitm) return this.#launchPlain(spec);
    return this.#launchWithMitmTap(spec, mitm);
  }

  /** Kill the in-flight run. */
  abort(): void {
    this.#current?.abort();
  }
}
