// Kiro CLI driver adapter (adapter-lane contract, src/adapters/types.ts).
//
// Headless invocation:
//   kiro-cli chat --no-interactive --output-format stream-json --agent-engine v2 \
//     [--model M] [--agent A] [--effort E] [--require-mcp-startup] \
//     [--trust-all-tools | --trust-tools=<csv>] [--resume | --resume-id <id>] \
//     [...extraArgs] "<prompt>"
// Resume: `--resume` (last session) or `--resume-id <sessionId>`.
//
// TRUST POLICY (behaviour change, issue #2). The adapter NO LONGER passes an
// implicit `--trust-all-tools`. `spec.kiro.tools` is the only trust input:
//   'all'      -> --trust-all-tools
//   'none'     -> --trust-tools=            (empty allowlist)
//   ['a','b']  -> --trust-tools=a,b
//   undefined  -> NO trust flag at all; kiro's own native agent config decides.
// Callers that relied on the old implicit trust-all must now ask for
// `kiro: { tools: 'all' }` explicitly.
//
// EVENT PARSING. spawn() normalizes stdout through
// `createKiroNormalizer({transport:'headless'})` (src/adapters/kiro-events.ts),
// which understands both the 2.21.x `{type,data}` envelopes
// (runStarted/metadata/sessionUpdate/runFinished) and the legacy top-level
// shapes. stderr is scanned with `parseKiroStderrLine`: the
// `[warn] failed to set model 'X': Method not found` line sets
// `modelAck:'unsupported'` for the run and emits a `step` with
// `payload.kind:'modelAck'` so the evidence lands in the transcript.
// stderr is also scanned with `parseKiroStderrNotice` (kiro-events.ts) for
// non-fatal notices worth surfacing, e.g. an MCP dynamic-registration
// failure; a hit emits a `step` with `payload.kind:'stderrNotice'` (headless
// transport only — see docs/KIRO.md "stderr notices").
//
// EFFECTIVE CONFIG. Every run records a `KiroEffective` (requested config,
// resolved argv minus the prompt, trust flag, engine, agent, model, native
// session id, model ack, configHash). It reaches the driver through
// `AgentHandle.kiro()` — see PLAN-kiro-acp.md, "Handle -> driver hand-off".
// KIRO_API_KEY passes through to the child process by default (never
// stripped), so kiro-cli authenticates headless with the caller's ambient
// credentials — EXCEPT when spec.sandbox.scrubEnv asks for provider
// credentials to be scrubbed before spawn (issue #8).
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
  KiroConfig,
  KiroEffective,
  KiroModelAck,
  RunSpec as CoreRunSpec,
} from '../core/types.js';
import { createHash } from 'node:crypto';
import {
  runJsonlCli,
  launchDriverHandle,
  houseEventToCore,
  defaultSpawnFn,
  takeOnOutput,
  EventQueue,
  type HouseEventLike,
  type SpawnFn,
} from './shared.ts';
import { createKiroNormalizer, parseKiroStderrLine, parseKiroStderrNotice, type KiroNormalizer } from './kiro-events.ts';
import { launchKiroAcp } from './kiro-acp-launch.ts';
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
  /** Kiro-specific configuration (agent/engine/effort/tools/requireMcpStartup). */
  kiro?: KiroConfig;
  /** Extra argv appended verbatim after every flag, before the prompt. */
  extraArgs?: string[];
  /**
   * Sandbox policy (issue #8). Only allowedTools maps — onto the native trust
   * policy (`kiro.tools` → `--trust-tools=<csv>` / ACP) when the native
   * `kiro.tools` is not already set (native wins); disallowedTools /
   * permissionMode / mcpConfig are omitted (kiro has no flags for them; MCP
   * servers go through `kiro.mcpServers`). scrubEnv scrubs provider
   * credentials (incl. KIRO_API_KEY) from the child env before spawn.
   */
  sandbox?: RunOptions['sandbox'];
}

/**
 * Fold SandboxPolicy.allowedTools into the kiro trust policy (issue #8):
 * sets `kiro.tools = allowedTools` — the `--trust-tools=<csv>` allowlist —
 * unless the native `kiro.tools` is already set (native config wins). Pure;
 * exported for tests.
 */
export function applySandboxToKiroSpec<T extends { sandbox?: RunOptions['sandbox']; kiro?: KiroConfig }>(spec: T): T {
  const allowed = spec.sandbox?.allowedTools;
  if (!allowed?.length || spec.kiro?.tools !== undefined) return spec;
  return { ...spec, kiro: { ...spec.kiro, tools: allowed } };
}

/**
 * A `kiro-cli --version` probe running alongside a run: `value()` is
 * 'unknown' until the probe settles; `settle(p)` resolves with p's result
 * only after the probe has settled too.
 */
interface VersionProbe {
  value: () => string;
  settle: <T>(p: Promise<T>) => Promise<T>;
}

/** Ceiling for the `kiro-cli --version` probe; past it the version is 'unknown'. */
export const KIRO_VERSION_PROBE_MS = 3_000;

/** Matches the bare version number inside raw `kiro-cli --version` output. */
export const KIRO_VERSION_RE = /(\d+\.\d+\.\d+[^\s]*)/;

/**
 * Parse a `kiro-cli --version` stdout blob (e.g. `'kiro-cli 2.21.2\n'`) or a
 * bare version string (e.g. `'2.21.4-beta.1'`) down to the bare version
 * number. Returns `null` when no version-shaped substring is found (e.g.
 * `''` or `'no version here'`).
 *
 * This is the cross-transport `cliVersion` shape: headless (this file's
 * `#cliVersion`) and the preflight version check both run raw CLI stdout
 * through this parser so `result.kiro.cliVersion` reads the same bare number
 * (`2.21.2`) as ACP's `agentInfo.version`, which is already bare.
 */
export function parseKiroCliVersion(raw: string): string | null {
  return KIRO_VERSION_RE.exec(raw)?.[1] ?? null;
}

/** Default agent engine when `spec.kiro.engine` is not given. */
export const KIRO_DEFAULT_ENGINE = 'v2';

/**
 * The trust flag for a `KiroConfig.tools` policy, or null for "no flag".
 *
 * `undefined` deliberately yields null: the adapter never passes an implicit
 * `--trust-all-tools` (issue #2). Pure; exported for tests.
 */
export function kiroTrustFlag(tools: KiroConfig['tools']): string | null {
  if (tools === undefined) return null;
  if (tools === 'all') return '--trust-all-tools';
  if (tools === 'none') return '--trust-tools=';
  return `--trust-tools=${tools.join(',')}`;
}

/**
 * Build argv for `kiro-cli chat`. Pure; exported for tests. Order:
 * base flags, `--agent-engine <engine>`, `--model`, `--agent`, `--effort`,
 * `--require-mcp-startup`, the trust flag (only when `kiro.tools` is set),
 * resume flags, `extraArgs` verbatim, prompt LAST.
 */
export function buildKiroArgs(spec: KiroRunSpec): string[] {
  const kiro = spec.kiro ?? {};
  const args = [
    'chat',
    '--no-interactive',
    '--output-format',
    'stream-json',
    // TODO(v3): `--v3` fails through the MITM tap — v3's model-catalog fetch
    // to management.us-east-1.kiro.dev dies under mitmproxy with
    // ModelRegistryUnavailableError. v2 verified working through the tap.
    '--agent-engine',
    kiro.engine ?? KIRO_DEFAULT_ENGINE,
  ];
  if (spec.model) args.push('--model', spec.model);
  if (kiro.agent) args.push('--agent', kiro.agent);
  if (kiro.effort) args.push('--effort', kiro.effort);
  if (kiro.requireMcpStartup) args.push('--require-mcp-startup');
  const trust = kiroTrustFlag(kiro.tools);
  if (trust !== null) args.push(trust);
  if (spec.resume && typeof spec.resume === 'object' && spec.resume.sessionId) {
    args.push('--resume-id', spec.resume.sessionId);
  } else if (spec.resume === 'continue') {
    args.push('--resume');
  }
  if (spec.extraArgs) args.push(...spec.extraArgs);
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
 *
 * @deprecated Superseded by the normalizer in src/adapters/kiro-events.ts
 * (`createKiroNormalizer`), which handles the 2.21.x envelopes as well. Kept
 * exported for existing importers/tests; the adapter no longer calls it.
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

/**
 * Last-resort session-id sweep over one raw stdout line: any top-level
 * sessionId/session_id/sessionID string. Used only when the normalizer did not
 * recognize the envelope (see spawn()).
 */
function sniffSessionId(line: string): string | undefined {
  let obj: unknown;
  try {
    obj = JSON.parse(line.trim());
  } catch {
    return undefined;
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return undefined;
  return pickString(obj as Record<string, unknown>, ['sessionId', 'session_id', 'sessionID']);
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
 *
 * @deprecated Superseded by `createKiroNormalizer({transport:'headless'})` in
 * src/adapters/kiro-events.ts, which understands the current 2.21.x
 * `{type,data}` envelopes (this function maps them all to `step`) and
 * coalesces chunks. Kept exported for existing importers/tests; the adapter
 * no longer calls it.
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

/**
 * Parse one line to canonical events only (house convention, like codex/gemini).
 *
 * @deprecated See `parseKiroLineRecord`; use `createKiroNormalizer` from
 * src/adapters/kiro-events.ts instead.
 */
export function parseKiroLine(line: string): KiroEvent[] {
  return parseKiroLineRecord(line).events;
}

// ---------------------------------------------------------------------------
// MITM tap integration (auto-started by launch(); see KiroAdapterOptions.mitm)
// ---------------------------------------------------------------------------

/**
 * House-lane carrier for one tap record. On kiro 2.21.x the tap's token fields
 * are all zero (PLAN-kiro-acp.md § "Amendment: token counts"), so the carrier
 * declares whether the counts mean anything: `extra.tokensAvailable` is false
 * when EVERY token field in the tap record is 0 and true when any is non-zero.
 * A consumer must render `unavailable`, never `0`/`$0.0000`, on false. The tap
 * event exists mainly for the metering credits — `extra.credits`, which are
 * metering units, NOT USD, so `costUsd` stays undefined everywhere.
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

/**
 * True when the tap record carries at least one non-zero token count. All-zero
 * records are NOT token records: they are credits-only evidence.
 */
export function tapTokensAvailable(rec: CoreTokenRecord): boolean {
  return (
    num(rec.inputTokens) !== 0 ||
    num(rec.outputTokens) !== 0 ||
    num(rec.cacheReadTokens) !== 0 ||
    num(rec.cacheWriteTokens) !== 0 ||
    num(rec.reasoningTokens) !== 0
  );
}

/**
 * Convert one tap record into its house carrier event. The carrier's own token
 * fields mirror the tap record (zeros stay zeros — nothing is fabricated) and
 * `mitmRecord.extra` gains `tokensAvailable` + `source:'tap'`; `extra.credits`
 * is preserved untouched.
 */
export function mitmRecordToUsageEvent(rec: CoreTokenRecord): KiroMitmUsageEvent {
  const available = tapTokensAvailable(rec);
  const stamped: CoreTokenRecord = {
    ...rec,
    extra: { ...rec.extra, tokensAvailable: available, source: 'tap' },
  };
  return {
    type: 'usage',
    tokens: {
      inputTokens: num(rec.inputTokens),
      cacheReadTokens: num(rec.cacheReadTokens),
      cacheWriteTokens: num(rec.cacheWriteTokens),
      outputTokens: num(rec.outputTokens),
      reasoningTokens: null,
      totalTokens: null,
      durationMs: null,
      raw: rec.extra?.raw ?? rec,
    },
    mitmRecord: stamped,
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
        inputTokens: num(rec.inputTokens),
        outputTokens: num(rec.outputTokens),
        cacheReadTokens: num(rec.cacheReadTokens),
        cacheWriteTokens: num(rec.cacheWriteTokens),
        // Truthfulness marker: the four counters above are meaningless unless
        // extra.tokensAvailable is true. extra.credits survives untouched.
        extra: { ...rec.extra, tokensAvailable: tapTokensAvailable(rec), source: 'tap' },
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
  /**
   * Kiro's native (bare) session id as captured so far from any stdout line
   * carrying sessionId/session_id/sessionID. This is the id kiro-cli writes
   * on disk (~/.kiro/sessions/cli/<uuid>.jsonl); the driver-lane
   * AgentHandle.sessionId stays namespaced (`kiro-<uuid>`) for transcript
   * naming and multi-agent uniqueness, so correlation needs this bare form.
   */
  nativeSessionId(): string | undefined;
  /** Full exit state: exit code plus captured sessionId/usage. */
  result(): Promise<KiroRunResult>;
  /**
   * Requested-vs-effective evidence for this run. `cliVersion` is supplied by
   * the caller (the adapter caches one `kiro-cli --version` probe per
   * instance). Safe to call at any time; only complete once wait() settles.
   */
  effective(cliVersion: string): KiroEffective;
  /** Model acknowledgement verdict so far (see `effective()`). */
  modelAck(): KiroModelAck;
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
  /**
   * Ceiling (ms) for the one-shot `kiro-cli --version` probe; past it the
   * probe child is SIGKILLed and cliVersion reports 'unknown'. Defaults to
   * KIRO_VERSION_PROBE_MS; tests lower it.
   */
  versionProbeMs?: number;
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
  readonly #versionProbeMs: number;
  #current: { abort(): void } | null = null;
  /** Cached `kiro-cli --version` probe (one per adapter instance). */
  #cliVersionPromise: Promise<string> | null = null;

  constructor(options: KiroAdapterOptions = {}) {
    this.#command = options.command ?? process.env.KIRO_CLI_BIN ?? 'kiro-cli';
    this.#spawnFn = options.spawnFn;
    this.#mitmOpt = options.mitm;
    this.#mitmdumpBin = options.mitmdumpBin ?? process.env.MITMDUMP_BIN ?? 'mitmdump';
    this.#versionProbeMs = options.versionProbeMs ?? KIRO_VERSION_PROBE_MS;
  }

  /** House-style spawn: prompt string + run options. */
  spawn(prompt: string, opts?: RunOptions): KiroRunHandle;
  /** Task-style spawn: full spec object (model, resume). */
  spawn(task: KiroRunSpec): KiroRunHandle;
  spawn(promptOrTask: string | KiroRunSpec, opts: RunOptions = {}): KiroRunHandle {
    const raw: KiroRunSpec =
      typeof promptOrTask === 'string' ? { prompt: promptOrTask, ...opts } : promptOrTask;
    // Sandbox allowedTools folds into the native trust policy (native wins).
    const task = applySandboxToKiroSpec(raw);
    const requested: KiroConfig = task.kiro ?? {};
    const args = buildKiroArgs(task);
    // argv evidence excludes the prompt (last positional): it is run input,
    // not configuration, and keeping it out makes configHash prompt-stable.
    const argv = args.slice(0, -1);
    const normalizer: KiroNormalizer = createKiroNormalizer({ transport: 'headless' });
    const state: {
      sessionId?: string;
      usage?: CanonicalTokenRecord;
      modelAck: KiroModelAck;
    } = { modelAck: task.model ? 'unverified' : 'not-requested' };

    const handle = runJsonlCli({
      spec: {
        command: this.#command,
        args,
        cwd: task.cwd,
        env: buildKiroEnv(task.env),
        scrubEnv: task.sandbox?.scrubEnv,
      },
      onOutput: task.onOutput,
      parseLine: (line): CanonicalEvent[] => {
        const events = normalizer.pushHeadlessLine(line);
        // The normalizer only captures a session id from envelopes it knows.
        // Live kiro runs have been observed carrying the bare on-disk uuid on
        // an otherwise untyped line, so keep the old tolerant sweep as a
        // FALLBACK (never an override) for correlation/resume.
        const native = normalizer.state().nativeSessionId ?? sniffSessionId(line);
        if (native && !state.sessionId) state.sessionId = native;
        for (const event of events) {
          if (event.type === 'usage') state.usage = event.tokens as CanonicalTokenRecord;
        }
        return events;
      },
      onStderrLine: (line): CanonicalEvent[] | void => {
        const ack = parseKiroStderrLine(line);
        if (ack) {
          state.modelAck = 'unsupported';
          return [
            {
              type: 'step',
              payload: {
                kind: 'modelAck',
                transport: 'headless',
                countsAsTurn: false,
                modelAck: 'unsupported',
                model: ack.model,
                raw: line,
              },
            },
          ];
        }
        const notice = parseKiroStderrNotice(line);
        if (notice) {
          return [
            {
              type: 'step',
              payload: {
                kind: 'stderrNotice',
                transport: 'headless',
                countsAsTurn: false,
                notice: notice.notice,
                warning: notice.warning,
                raw: line,
              },
            },
          ];
        }
      },
      spawnFn: this.#spawnFn,
    });

    const effective = (cliVersion: string): KiroEffective => {
      const native = normalizer.state().nativeSessionId ?? state.sessionId;
      const eff: Record<string, unknown> = {
        argv,
        trustFlag: kiroTrustFlag(requested.tools),
        engine: requested.engine ?? KIRO_DEFAULT_ENGINE,
        ...(requested.agent !== undefined ? { agent: requested.agent } : {}),
        // A model the CLI explicitly refused is NOT effective. Anything else
        // headless is 'unverified' — the chat transport never acknowledges.
        ...(task.model !== undefined && state.modelAck !== 'unsupported' ? { model: task.model } : {}),
      };
      return {
        cliVersion,
        transport: 'headless',
        requested,
        effective: eff,
        ...(native !== undefined ? { nativeSessionId: native } : {}),
        modelAck: state.modelAck,
        // Hash over requested+effective ONLY: no env, no prompt, no cwd.
        configHash: createHash('sha256')
          .update(JSON.stringify({ requested, effective: eff }))
          .digest('hex'),
      };
    };

    const enriched: KiroRunHandle = {
      events: handle.events as AsyncIterable<KiroEvent>,
      wait: handle.wait,
      abort: handle.abort,
      sessionId: () => handle.wait().then(() => state.sessionId),
      nativeSessionId: () => state.sessionId,
      result: () =>
        handle.wait().then((exitCode) => ({
          exitCode,
          ...(state.sessionId !== undefined ? { sessionId: state.sessionId } : {}),
          ...(state.usage !== undefined ? { usage: state.usage } : {}),
        })),
      effective,
      modelAck: () => state.modelAck,
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

  /**
   * Wrap a kiro core-event mapper so every usage record carries the run's
   * native (bare) session id in `extra.kiroSessionId` — the id kiro-cli writes
   * on disk — while AgentHandle.sessionId stays namespaced (`kiro-<uuid>`).
   * Covers both stdout usage events and MITM tap carriers (extra.credits).
   */
  #mapWithNativeSession(
    handle: KiroRunHandle,
    map: (event: KiroLaneEvent) => CoreAgentEvent | null,
  ): (event: KiroLaneEvent) => CoreAgentEvent | null {
    return (event) => {
      const core = map(event);
      const native = handle.nativeSessionId();
      if (core?.type === 'usage' && native) {
        core.usage.extra = { ...core.usage.extra, kiroSessionId: native };
      }
      return core;
    };
  }

  /**
   * `kiro-cli --version`, run ONCE per adapter instance and cached (the probe
   * sends no prompt, so it is free). Goes through the injected spawnFn so
   * tests can fake it. Any failure resolves to 'unknown' rather than throwing
   * — a version probe must never fail a run.
   */
  #cliVersion(): Promise<string> {
    if (this.#cliVersionPromise) return this.#cliVersionPromise;
    this.#cliVersionPromise = new Promise<string>((resolve) => {
      let settled = false;
      const done = (value: string): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        const spawnFn = this.#spawnFn ?? defaultSpawnFn;
        const proc = spawnFn(this.#command, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        proc.stdout?.on('data', (chunk: Buffer | string) => {
          out += String(chunk);
        });
        proc.once('error', () => done('unknown'));
        proc.once('close', () =>
          done(parseKiroCliVersion(out) ?? (out.trim() === '' ? 'unknown' : out.trim())),
        );
        // Ceiling: a binary that ignores --version and hangs (or a fake that
        // does) must never hold wait() open — version.settle() waits on this.
        const ceiling = setTimeout(() => {
          if (settled) return;
          try {
            proc.kill('SIGKILL');
          } catch {
            /* already gone */
          }
          done('unknown');
        }, this.#versionProbeMs);
        ceiling.unref();
        proc.once('close', () => clearTimeout(ceiling));
      } catch {
        done('unknown');
      }
    });
    return this.#cliVersionPromise;
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
  async #startMitmTap(onRecord: (rec: CoreTokenRecord) => void): Promise<KiroMitmHandle | null> {
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
      // Attach the record listener SYNCHRONOUSLY: startKiroMitm begins parsing
      // mitmdump stdout at once, and a record that lands before launch()
      // resumes from this await would otherwise be dropped on the floor.
      mitm.on('record', onRecord);
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
  #launchWithMitmTap(
    spec: CoreRunSpec,
    mitm: KiroMitmHandle,
    version: VersionProbe,
    merged: EventQueue<KiroLaneEvent>,
  ): Promise<CoreAgentHandle> {
    // One merged stream: stdout events plus tap records interleaved (tap
    // records are pushed by the listener #startMitmTap attached). Records can
    // land after the child exits (trailing frames), so the merge closes only
    // once the tap has stopped.

    const handle = this.spawn({
      prompt: spec.prompt,
      ...(spec.resume ? { resume: { sessionId: spec.resume } } : {}),
      ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
      ...(spec.model !== undefined ? { model: spec.model } : {}),
      ...(spec.kiro !== undefined ? { kiro: spec.kiro } : {}),
      ...(spec.extraArgs !== undefined ? { extraArgs: spec.extraArgs } : {}),
      ...(spec.sandbox !== undefined ? { sandbox: spec.sandbox } : {}),
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
      mapEvent: this.#mapWithNativeSession(handle, (event) => kiroEventToCore(event)),
      // Stop the tap once the run settles (wait) or is aborted, before the
      // exit verdict resolves — no mitmdump outlives the run.
      exit: version.settle(
        handle.wait().then(async (code) => {
          await stopTap();
          return code;
        }),
      ),
      abort: () => {
        void stopTap();
        handle.abort();
      },
      fallbackSessionId: spec.resume,
      kiro: () => handle.effective(version.value()),
    });
  }

  #launchPlain(spec: CoreRunSpec, version: VersionProbe): Promise<CoreAgentHandle> {
    const handle = this.spawn({
      prompt: spec.prompt,
      ...(spec.resume ? { resume: { sessionId: spec.resume } } : {}),
      ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
      ...(spec.model !== undefined ? { model: spec.model } : {}),
      ...(spec.kiro !== undefined ? { kiro: spec.kiro } : {}),
      ...(spec.extraArgs !== undefined ? { extraArgs: spec.extraArgs } : {}),
      ...(spec.env ? { env: spec.env } : {}),
      ...(spec.sandbox !== undefined ? { sandbox: spec.sandbox } : {}),
      ...(takeOnOutput(spec) ? { onOutput: takeOnOutput(spec) } : {}),
    });
    return launchDriverHandle({
      agent: 'kiro',
      events: handle.events,
      // KiroEvent is a structural superset of HouseEventLike (step payload
      // extension); the bridge maps both.
      mapEvent: this.#mapWithNativeSession(handle, (event) =>
        houseEventToCore('kiro', event as HouseEventLike),
      ),
      exit: version.settle(handle.wait()),
      abort: () => handle.abort(),
      fallbackSessionId: spec.resume,
      kiro: () => handle.effective(version.value()),
    });
  }

  /** Driver contract (src/core/driver.ts): launch one run for a RunSpec.
   * With the tap enabled (default when mitmdump is on PATH), kiro-cli is
   * routed through the MITM proxy so per-run credit/token records are
   * captured; failures degrade to the untapped path with a warning. */
  async launch(spec: CoreRunSpec): Promise<CoreAgentHandle> {
    // Sandbox allowedTools folds into the kiro trust policy before either
    // transport consumes spec.kiro (issue #8); native kiro.tools wins.
    const effectiveSpec = applySandboxToKiroSpec(spec);
    if (effectiveSpec.kiro?.transport === 'acp')
      return launchKiroAcp(effectiveSpec, { command: this.#command, ...(this.#spawnFn ? { spawnFn: this.#spawnFn } : {}) });
    // The version probe runs CONCURRENTLY with the run: launch() must spawn
    // the child synchronously (driver/test contract — a caller may close the
    // child right after launch() returns), so the run never waits on the
    // probe. `version.settle()` makes wait() resolve only after the probe
    // did, so `handle.kiro()` read after wait() always carries the version.
    const version = this.#versionProbe();
    if (!this.#mitmRequested()) return this.#launchPlain(effectiveSpec, version);
    const merged = new EventQueue<KiroLaneEvent>();
    const mitm = await this.#startMitmTap((rec) => merged.push(mitmRecordToUsageEvent(rec)));
    if (!mitm) return this.#launchPlain(effectiveSpec, version);
    return this.#launchWithMitmTap(effectiveSpec, mitm, version, merged);
  }

  /** Start (or reuse) the cached `--version` probe as a VersionProbe. */
  #versionProbe(): VersionProbe {
    let value = 'unknown';
    const ready = this.#cliVersion().then((v) => {
      value = v;
    });
    return {
      value: () => value,
      settle: <T>(p: Promise<T>) => p.then(async (r) => (await ready, r)),
    };
  }

  /** Kill the in-flight run. */
  abort(): void {
    this.#current?.abort();
  }
}
