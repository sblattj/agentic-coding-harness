import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeAuto } from './normalize.js';
import { createPricer, isVendorMetered, pricedSources, sortModelCosts, type Pricer } from './pricing.js';
import { notifyRunEnd, type NotifyExec } from './notify.ts';
import { sumWebhookTokens, type EventWebhook } from './event-webhook.ts';
import { writeRunRecord, type RunRecord } from './registry.ts';
import { RunArtifacts, exitStatusToRunStatus, type RunInvocation } from './run-artifacts.ts';
import { ChainWriter, canonicalTotals } from './hash-chain.ts';
import { computeUsageAvailability, liveUsageAvailability } from './usage-availability.js';
import { codexSessionsRoot, readCodexNativeUsage, requestedCodexEffort } from './codex-native.ts';
import { createContextMeter } from './context-meter.js';
import { classifyLaunchError, createAvailabilityTracker } from './availability.ts';
import { gitBranchInfo } from './git-branch.ts';
import { prContextFor, resolvePr } from './git-pr.ts';
import { runTotalsProvenance } from './provenance.ts';
import { parseRunSpec } from './validate.js';
import { applyEffortToSpec, resolveEffort } from './effort.ts';
import { composePrompt, type AttachmentManifest } from './attachments.js';
import { readKiroSessionStore, sliceKiroSessionStore, type ParsedKiroSessionStore } from '../adapters/kiro-session-store.js';
import type { AdapterExit, AdapterProfileCheck, AgentAdapter, AgentEvent, AgentHandle, CanonicalTokenRecord, EventTimestamp, ExitStatus, KiroEffective, RunResult, RunSpec, UsageEvent } from './types.js';
import { HarnessError } from './types.js';
import { assertInsideWorkspace } from './workspace.js';
import { ClaudeCodeAdapter } from '../adapters/claude.js';
import { OpenCodeAdapter } from '../adapters/opencode.js';
import { KiroAdapter } from '../adapters/kiro.js';
import { CodexAdapter } from '../adapters/codex.js';
import { GeminiAdapter } from '../adapters/gemini.js';
import { AgyAdapter } from '../adapters/agy.js';
import { PrimeAdapter } from '../adapters/prime.js';
import { KiroIdeAdapter } from '../adapters/kiro-ide.js';
import { CopilotAdapter } from '../adapters/copilot.js';
import { CursorAdapter } from '../adapters/cursor.js';
import { NullAdapter } from '../adapters/null.js';
import { scrubEnvVars, takeOnOutput } from '../adapters/shared.js';
import { childTraceEnv, resolveRunTraceContext } from './trace-context.ts';
import { DEFAULT_COOLDOWN_MS, cooldownMsFromEnv, createRunAlerts, describeAlert, type AlertMetric, type FiredAlert } from './budget-alerts.ts';
import type { BudgetAlertEvent } from './types.js';
import { createLatencyAccumulator, hasLatency } from './latency.ts';
import { EventTail } from './event-retention.ts';
import { findAncestorInstructions } from './ancestor-instructions.ts';
import { providerLimitReason } from './provider-limit.ts';
import { STRIPPED, captureEvent, captureEventPreview, resolveCaptureMode, stripContent, type CaptureMode, type CapturePolicy } from './capture.ts';

/** Alert cooldown from AGENTIC_CODING_HARNESS_WARN_COOLDOWN_H; a bad value warns and keeps the 24h default (#20). */
function envCooldownMs(warn: (w: string) => void): number {
  try {
    return cooldownMsFromEnv(process.env);
  } catch (err) {
    warn(`alerts: ${err instanceof Error ? err.message : String(err)}; using the 24h default`);
    return DEFAULT_COOLDOWN_MS;
  }
}

/** Normalize EventTimestamp (ISO string | epoch ms | Date | undefined) to epoch ms. */
function toMs(ts: EventTimestamp): number {
  if (ts === undefined) return Date.now();
  if (ts instanceof Date) return ts.getTime();
  if (typeof ts === 'number') return ts;
  const parsed = Date.parse(ts);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

/** One-line registry preview: event type + first 80 chars of the most descriptive text/name field. */
function eventPreview(e: AgentEvent): string {
  for (const value of [e.text, e.content, e.name, e.toolName, e.functionName, e.message]) {
    if (typeof value === 'string' && value.trim()) {
      return `${e.type} ${value.slice(0, 80)}`;
    }
  }
  return e.type;
}

/**
 * Map a pre-normalized usage event record onto the canonical record. Canonical
 * fields win; legacy aliases (promptTokens/completionTokens/cachedTokens) are
 * read defensively when a producer set only those.
 */
function fromPreNormalized(agent: string, u: CanonicalTokenRecord, timestamp: number): CanonicalTokenRecord {
  return {
    agent,
    model: u.model ?? 'unknown',
    // Legacy prompt/completion aliases carry cached INSIDE prompt; canonical
    // inputTokens is uncached-only, so subtract the cache slice.
    inputTokens: u.inputTokens ?? Math.max(0, (u.promptTokens ?? 0) - (u.cachedTokens ?? 0)),
    outputTokens: u.outputTokens ?? u.completionTokens ?? 0,
    cacheReadTokens: u.cacheReadTokens ?? u.cachedTokens ?? 0,
    cacheWriteTokens: u.cacheWriteTokens ?? 0,
    ...(u.cacheWrite1hTokens !== undefined ? { cacheWrite1hTokens: u.cacheWrite1hTokens } : {}),
    ...(u.reasoningTokens !== undefined ? { reasoningTokens: u.reasoningTokens } : {}),
    ...(u.costUsd !== undefined ? { costUsd: u.costUsd } : {}),
    // Producer extras ride through untouched: the kiro MITM tap carries its
    // metering credits in extra.credits (not USD — never priced), and the
    // CLI run summary sums them from RunResult.tokens.
    ...(u.extra !== undefined ? { extra: u.extra } : {}),
    timestamp,
  };
}

/**
 * Turn accounting for `budget.maxTurns`.
 *
 * A `step` event is a PROGRESS marker, not necessarily a turn: kiro's
 * normalizer emits one per message chunk, per vendor notification and per
 * metadata frame, all tagged `payload.countsAsTurn === false`. Counting those
 * trips a maxTurns cap within the first reply.
 *
 * - kiro: a turn ends on the native terminator ONLY — the step carrying
 *   `payload.kind === 'runFinished'`, emitted by `handleTerminal` in
 *   src/adapters/kiro-events.ts (`vendorStep('runFinished', data, {...})`,
 *   valid at 6130fb7; re-derive by symbol). `runFinished` covers both
 *   transports: the ACP client hands its `session/prompt` result to the same
 *   function.
 * - every other agent: unchanged — every step counts unless the producer
 *   explicitly opted out with `countsAsTurn: false`.
 *
 * The payload rides `event.payload` when an adapter emits core events directly
 * and `event.data` after houseEventToCore (src/adapters/shared.ts) bridges it;
 * both are read.
 */
export function countsAsTurn(agent: string, event: AgentEvent): boolean {
  const raw = (event as { payload?: unknown }).payload ?? (event as { data?: unknown }).data;
  const payload = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : undefined;
  if (agent === 'kiro') return payload?.kind === 'runFinished';
  return payload?.countsAsTurn !== false;
}

/** A settled run's turn count: the driver's whole-run count when `events` is only a tail (#199). */
export function runTurns(result: Pick<RunResult, 'events' | 'eventSummary'>, agent: string): number {
  return result.eventSummary?.turns ?? result.events.filter((e) => e.type === 'step' && countsAsTurn(agent, e)).length;
}

// RunSpec validation lives in src/core/validate.ts (RunSpecSchema in
// src/core/types.ts) — see run() below for the parseRunSpec call.

export interface DriverOptions {
  adapters: Record<string, AgentAdapter>;
  /**
   * Codex sessions root the post-run native lookup reads (#140/#142); default
   * $CODEX_HOME/sessions, else ~/.codex/sessions. Tests point it at a fixture.
   */
  codexSessionsRoot?: string;
  /** Directory for raw NDJSON transcripts (written under <stateDir>/raw/). */
  stateDir: string;
  /** Optional pricer; defaults to the embedded per-1M cost map. */
  pricer?: Pricer;
  /** Optional streaming tap: called for every event as it is consumed. */
  onEvent?: (event: AgentEvent) => void;
  /**
   * Optional raw stdout tap: forwarded into every adapter launch so callers
   * receive each chunk of the agent CLI's raw stdout EXACTLY as received,
   * alongside the canonical parsed events (RunSpec.onOutput overrides this
   * per-run). Transports without a child process (kiro ACP, opencode
   * preferServer) have no stdout to tap. A throwing tap never breaks a run.
   */
  onOutput?: (chunk: string) => void;
  /**
   * Optional run registry (dash live view, src/dash/PLAN.md): when present,
   * run() writes a RunRecord under <registry.stateDir>/runs/ at spawn,
   * heartbeats totals/lastEvent per event (writes throttled to >= 500ms), and
   * finalizes status/exitStatus at exit. Registry failures never break a run —
   * they drain into run warnings.
   */
  registry?: { stateDir: string };
  /**
   * Run-lifecycle desktop notifications (#63). Opt-in via
   * AGENTIC_CODING_HARNESS_NOTIFY (src/core/notify.ts); these fields exist so
   * tests can inject env/platform/exec. Absent = real process.env + OS tools.
   */
  notify?: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; exec?: NotifyExec };
  /**
   * HTTP event tap (#64, src/core/event-webhook.ts): run start, exit, budget
   * alerts and a periodic usage summary are queued to it (never blocking the
   * event stream) and flushed, bounded by its flushMs, before run() settles.
   * Fail open: a webhook failure never changes RunResult, the exit status or
   * any artifact. Absent = nothing is posted.
   */
  webhook?: EventWebhook;
  /**
   * Workspace root for confinement (issue #9). Used only when
   * confineToWorkspace is true; defaults to process.cwd() at run time.
   */
  workspaceRoot?: string;
  /**
   * Confine caller-supplied paths on a run spec to workspaceRoot (issue #9):
   * NOTE (#106): a hermetic run (src/core/hermetic.ts runHermetic) hands the
   * driver a harness-minted temp copy OUTSIDE the original workspace, so a
   * driver confined to that workspace refuses it with WORKSPACE_ESCAPE —
   * loudly, before launch. Confine to the temp root instead, or leave
   * confinement off for hermetic runs (the ach CLI and MCP tools never set it).
   * RunSpec.cwd and RunSpec.stateDir are resolved to their REAL paths
   * (symlinks followed, `..` collapsed) and must land inside the root, or
   * the run fails with a WORKSPACE_ESCAPE HarnessError before anything is
   * launched.
   */
  confineToWorkspace?: boolean;
  /**
   * Content-capture policy (#72, src/core/capture.ts). `mode` is the global
   * tier the caller resolved (`ach run --capture-mode` or the config file's
   * `run.captureMode`; it beats ACH_CAPTURE_MODE, RunSpec.captureMode beats
   * it), `modeSource` labels it on the RunRecord, and `policy` is the config
   * file's `contentCapture` (its `default` sits below the env var, its
   * per-agent entries beat every global tier). Absent = env, else `full`.
   * `liveEvents: 'raw'` hands `onEvent` the unstripped events: for a caller
   * whose live tap IS the product (a desk conversation) and that applies the
   * tier to its own records (src/desks/host.ts). Default: the tap gets the
   * metadata form below `full`, since a CLI's stderr feed can land in a log.
   */
  capture?: { mode?: CaptureMode; modeSource?: string; policy?: CapturePolicy; liveEvents?: 'raw' | 'recorded' };
}

export interface Driver {
  run(agentName: string, spec: RunSpec): Promise<RunResult>;
  /**
   * Abort the active run launched with the given RunSpec.runId (no-op for
   * runs without one or already settled). Returns true when an active run
   * matched and abort was signalled.
   */
  abort(runId: string): boolean;
  /**
   * Opt-in signal abort (#11): install process handlers for SIGTERM/SIGINT
   * (or the given signals) that call abort(runId), so consumers don't each
   * install and clean up their own signal handlers. Returns a disposer that
   * removes exactly the listeners this call added. The handlers are
   * one-shot: the first signal uninstalls them and aborts the run, so
   * subsequent signals fall through to Node's default semantics instead of
   * being swallowed forever.
   */
  installSignalAbort(runId: string, signals?: readonly NodeJS.Signals[]): () => void;
}

const ADAPTER_MODULE_NAMES = ['claude', 'opencode', 'kiro', 'codex', 'gemini', 'agy', 'prime', 'kiro-ide', 'copilot', 'cursor', 'null'] as const;

/** Default signals wired by installSignalAbort (#11). */
const ABORT_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

/** Launch-capable subset every bundled adapter class implements natively. */
interface LaunchableAdapter {
  launch(spec: RunSpec): Promise<AgentHandle>;
  /** Adapter-owned profile/config validation (issue #9); optional. */
  validateProfile?(spec: RunSpec): AdapterProfileCheck;
}

/**
 * Registry helper: instantiates each bundled adapter CLASS. Every agent adapter
 * implement the driver contract's launch() natively (bridged via
 * launchDriverHandle in src/adapters/shared.ts); the wrapper here supplies the
 * canonical `name` field and, for claude, the enforcesBudget marker (claude
 * always passes --max-turns itself). A fresh instance is created per launch,
 * so single-run adapters are never reused. Missing or incompatible adapters
 * are skipped with a warning, never fatal.
 */
/**
 * Adapter-owned profile validation (issue #9), the one place its verdict
 * becomes an error: Driver.run() calls it before launch, and `ach config
 * --set profiles.*` (#77) calls it at save time, so both reject an illegal
 * flag combination with the same message. Returns the check (warnings
 * included) when it passed, undefined when the adapter has no hook.
 */
export function checkAdapterProfile(
  agentName: string,
  adapter: Pick<AgentAdapter, 'validateProfile'>,
  spec: RunSpec,
): AdapterProfileCheck | undefined {
  const profile = adapter.validateProfile?.(spec);
  if (profile && !profile.ok) {
    throw new HarnessError(
      `agent "${agentName}" profile validation failed: ${profile.errors.map((e) => `${e.field}: ${e.message}`).join('; ')}`,
      'INVALID_PROFILE',
    );
  }
  return profile;
}

export async function defaultAdapters(): Promise<Record<string, AgentAdapter>> {
  const adapters: Record<string, AgentAdapter> = {};
  const makers: Record<string, () => LaunchableAdapter> = {
    claude: () => new ClaudeCodeAdapter(),
    opencode: () => new OpenCodeAdapter(),
    kiro: () => new KiroAdapter(),
    codex: () => new CodexAdapter(),
    gemini: () => new GeminiAdapter(),
    agy: () => new AgyAdapter(),
    prime: () => new PrimeAdapter(),
    'kiro-ide': () => new KiroIdeAdapter(),
    copilot: () => new CopilotAdapter(),
    cursor: () => new CursorAdapter(),
    null: () => new NullAdapter(),
  };
  for (const name of ADAPTER_MODULE_NAMES) {
    const make = makers[name];
    if (!make) continue;
    try {
      const probe = make(); // fail fast (constructor errors) at registry time
      void probe;
      adapters[name] = {
        name,
        ...(name === 'claude' ? { enforcesBudget: true } : {}),
        // Profile validation reads only constructor options + the spec, so
        // the probe instance answers it; launch keeps a fresh instance per run.
        ...(typeof probe.validateProfile === 'function'
          ? { validateProfile: (spec: RunSpec): AdapterProfileCheck => probe.validateProfile!(spec) }
          : {}),
        launch: (spec: RunSpec): Promise<AgentHandle> => make().launch(spec),
      };
    } catch (err) {
      console.warn(
        `driver: adapter "${name}" unavailable, skipped (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
  return adapters;
}

export function createDriver(options: DriverOptions): Driver {
  const { adapters, stateDir, onEvent } = options;

  // Active-run abort handles keyed by resolved RunSpec.runId (see abort()).
  const activeRuns = new Map<string, () => void>();

  // Shared abort path for the public abort(runId) and installSignalAbort's
  // captured signal handlers (#11).
  const abortRun = (runId: string): boolean => {
    const abort = activeRuns.get(runId);
    if (!abort) return false;
    abort();
    return true;
  };

  return {
    abort: abortRun,

    installSignalAbort(runId: string, signals: readonly NodeJS.Signals[] = ABORT_SIGNALS): () => void {
      // One handler shared across the requested signals; the disposer removes
      // exactly the listeners THIS call added, never the host's own.
      const onSignal = (): void => {
        // Uninstall FIRST (one-shot): the handler cannot re-enter while the
        // abort is in flight, and later signals keep Node's default
        // termination semantics instead of being swallowed forever (#11).
        for (const sig of signals) process.removeListener(sig, onSignal);
        abortRun(runId);
      };
      for (const sig of signals) process.on(sig, onSignal);
      return () => {
        for (const sig of signals) process.removeListener(sig, onSignal);
      };
    },

    async run(agentName: string, spec: RunSpec): Promise<RunResult> {
      const adapter = adapters[agentName];
      if (!adapter) {
        throw new Error(`driver: unknown agent "${agentName}"; registered: ${Object.keys(adapters).join(', ') || 'none'}`);
      }
      // Fail fast on invalid specs (#10): field-path errors, finite positive
      // timeouts, closed budget shape, and model pinning where required
      // (adapter.requiresModel / kiro.requireModelAck).
      const validated = parseRunSpec(agentName, spec, { requiresModel: adapter.requiresModel === true });
      // --- portable effort (#54) ---
      // One table (src/core/effort.ts) maps RunSpec.effort onto the agent's
      // native mechanism; the launched spec carries the argv fragment / kiro
      // field, so profile validation, codex requestedEffort and outputDir's
      // invocation all see what the CLI gets. No effort: the spec is untouched.
      const effortResolution = validated.effort !== undefined ? resolveEffort(agentName, validated.effort, validated) : undefined;
      const parsed = effortResolution !== undefined ? applyEffortToSpec(validated, effortResolution) : validated;
      // --- workspace confinement (issue #9) ---
      // Resolve caller-supplied paths to real paths (symlinks followed, `..`
      // collapsed) and refuse any that escape the workspace root, BEFORE
      // anything is launched. Applied to every caller-supplied file path on
      // the spec the library acts on: the agent subprocess cwd and the
      // per-run stateDir override.
      if (options.confineToWorkspace === true) {
        const root = options.workspaceRoot ?? process.cwd();
        for (const field of ['cwd', 'stateDir'] as const) {
          const value = (parsed as Record<string, unknown>)[field];
          if (typeof value === 'string' && value !== '') {
            assertInsideWorkspace(root, value, { label: `spec.${field}` });
          }
        }
      }
      // --- adapter-owned profile validation (issue #9) ---
      // The adapter that owns the config validates it; the driver only
      // enforces the verdict. Warnings drain into the run's warnings.
      const profile = checkAdapterProfile(agentName, adapter, parsed);
      const profileWarnings = profile?.warnings ?? [];
      // Caller-chosen run id (async job tools pass a uuid so the registry
      // record is addressable before spawn); generated otherwise.
      const runId = typeof spec.runId === 'string' && spec.runId ? spec.runId : randomUUID();
      // --- HTTP event tap (#64) --- every call is fail-open (post never throws).
      const webhook = options.webhook;
      const postWebhook = (type: 'start' | 'exit' | 'budget' | 'usage', payload: () => Record<string, unknown>): void => {
        if (webhook === undefined || !webhook.wants(type)) return;
        try {
          webhook.post(runId, type, payload());
        } catch {
          // fail open
        }
      };
      const flushWebhook = async (): Promise<void> => {
        if (webhook === undefined) return;
        try {
          await webhook.flush(runId);
        } catch {
          // fail open
        }
      };
      // --- content-capture tier (#72) ---
      // Resolved once, before anything is written: every sink below (raw
      // transcript, RunRecord, outputDir, RunResult, onEvent) records only
      // what this tier allows. Metering always reads the ORIGINAL events.
      const capture = resolveCaptureMode({
        agent: agentName,
        explicit: parsed.captureMode ?? options.capture?.mode,
        explicitSource: parsed.captureMode !== undefined ? 'spec' : (options.capture?.modeSource ?? 'flag'),
        env: process.env,
        policy: options.capture?.policy,
      });
      const captureFull = capture.mode === 'full';
      /** The copy of an event a sink may record; null = not recorded at all (`off`). */
      const recordable = (event: AgentEvent): AgentEvent | null => captureEvent(capture.mode, event);
      /** Sinks that must see SOME event (onEvent, RunResult) get the metadata form under `off`. */
      const rawLive = options.capture?.liveEvents === 'raw';
      const shareable = (event: AgentEvent): AgentEvent =>
        captureFull || rawLive ? event : (captureEvent('metadata', event) as AgentEvent);
      const budgetUsd = parsed.budget?.usd;
      const maxTurns = parsed.budget?.maxTurns;
      // Explicit budget.* wins; timeoutMs / idleTimeoutMs are watchdog-style
      // top-level aliases (#5).
      const wallMs = parsed.budget?.wallMs ?? parsed.timeoutMs;
      const idleMs = parsed.budget?.idleMs ?? parsed.idleTimeoutMs;

      const start = Date.now();
      const warnings: string[] = [];
      // Profile-validation warnings (issue #9) precede everything else: they
      // describe the config the run launched with, not what it produced.
      for (const w of profileWarnings) warnings.push(`${agentName}: profile warning — ${w.field}: ${w.message}`);
      if (effortResolution !== undefined) warnings.push(...effortResolution.warnings);
      // --- W3C trace context (#73) ---
      // An incoming TRACEPARENT (the spec's env wins over the process env) makes
      // this run a child span of that trace; none starts a fresh trace; an
      // invalid one starts a fresh trace with one warning. Every adapter child
      // gets TRACEPARENT naming THIS run's span (injected into launchSpec.env
      // below), and the ids land on the RunRecord and RunResult.
      const traceResolved = resolveRunTraceContext({ ...process.env, ...(parsed.env ?? {}) });
      const runTrace = traceResolved.trace;
      if (traceResolved.warning !== undefined) warnings.push(traceResolved.warning);

      // --- run-to-directory mode (#6) ---
      // When the spec carries outputDir, mirror the whole run into it and
      // leave a terminal status.json on EVERY exit path below (settleArtifacts
      // runs on the settled path, in the outer catch on any throw). Artifact
      // write failures never break the run: they drain into warnings.
      const outputDir = typeof parsed.outputDir === 'string' && parsed.outputDir !== '' ? parsed.outputDir : undefined;
      let artifacts: RunArtifacts | null = null;
      let artifactsSettled = false;
      const settleArtifacts = async (status: Parameters<RunArtifacts['finish']>[0], result?: RunResult): Promise<void> => {
        if (artifacts === null || artifactsSettled) return;
        artifactsSettled = true;
        try {
          await artifacts.finish(status, result);
        } catch (err) {
          warnings.push(`outputDir: ${err instanceof Error ? err.message : String(err)}`);
        }
      };
      if (outputDir !== undefined) {
        const invocation: RunInvocation = {
          runId,
          command: agentName,
          args: Array.isArray(parsed.extraArgs) ? parsed.extraArgs : [],
          cwd: typeof parsed.cwd === 'string' && parsed.cwd !== '' ? parsed.cwd : process.cwd(),
          startedAt: start,
          // #72: below `full` the prompt never reaches invocation.json.
          prompt: captureFull ? parsed.prompt : STRIPPED,
          ...(parsed.model !== undefined ? { model: parsed.model } : {}),
        };
        artifacts = await RunArtifacts.open(outputDir, invocation);
      }

      // Prompt attachments (#12): compose file blocks into the prompt BEFORE
      // launch so every adapter receives the final prompt; the attachment keys
      // are stripped so adapters never see (or act on) them twice.
      let launchSpec = parsed;
      let attachmentManifest: AttachmentManifest | undefined;
      if (parsed.attachments !== undefined && parsed.attachments.length > 0) {
        const { prompt: composedPrompt, manifest } = await composePrompt(parsed.prompt, parsed.attachments, {
          maxTotalBytes: parsed.attachmentsMaxBytes,
        });
        attachmentManifest = manifest;
        const { attachments: _a, attachmentsMaxBytes: _m, ...rest } = parsed;
        void _a;
        void _m;
        launchSpec = { ...rest, prompt: composedPrompt };
      }
      // #73: per-spec (never process.env, so concurrent runs cannot race).
      // An incoming TRACESTATE is replaced by the resolved one, or blanked:
      // adapters merge process.env under spec.env, and spec.env cannot unset
      // a key, so an inherited TRACESTATE would otherwise ride along with a
      // fresh trace. W3C treats an empty tracestate as none.
      {
        const { TRACESTATE: _ts, ...envRest } = launchSpec.env ?? {};
        void _ts;
        launchSpec = { ...launchSpec, env: { ...envRest, TRACESTATE: '', ...childTraceEnv(runTrace) } };
      }

      // Raw stdout tap precedence: RunSpec.onOutput wins over the driver-wide
      // DriverOptions.onOutput; merged here so every adapter sees one field.
      // In outputDir mode the artifact mirror is chained ahead of the caller's
      // tap so stdout.txt still fills when neither caller provides one.
      const callerOutput = takeOnOutput(parsed) ?? options.onOutput;
      // #72: raw stdout is unstructured agent output that cannot be stripped,
      // so below `full` stdout.txt stays empty (the caller's own tap still
      // runs: it is the caller's sink, not ach's record).
      const onOutput =
        artifacts !== null
          ? (chunk: string): void => {
              if (captureFull) artifacts?.stdoutChunk(chunk);
              callerOutput?.(chunk);
            }
          : callerOutput;
      // One try/catch spans the whole run lifecycle so the run-to-directory mode
      // (#6) can settle status.json on EVERY exit path: the settled path above
      // plus any throw (launch failure, event-stream crash, post-loop hooks).
      // kiro resume: the session store holds EVERY run of the session, so record
      // how many turns it had before this run and keep only the new ones after.
      // Fresh runs (no resume id) skip this entirely.
      let kiroPriorTurns: { id: string; count: number } | undefined;
      if (agentName === 'kiro' && typeof parsed.resume === 'string' && parsed.resume !== '') {
        const resumeBare = parsed.resume.startsWith('kiro-') ? parsed.resume.slice(5) : parsed.resume;
        const prior = await readKiroSessionStore(resumeBare);
        kiroPriorTurns = { id: resumeBare, count: prior.ok ? prior.store.turns.length : 0 };
      }
      try {
        // #72: adapters that keep their own recordings (the interactive
        // .cast) read the effective tier; set only below `full`, so a full
        // run's launch spec is unchanged.
        const tierSpec: RunSpec = captureFull ? launchSpec : { ...launchSpec, captureMode: capture.mode };
        const handle = await adapter.launch(onOutput ? { ...tierSpec, onOutput } : tierSpec);
        const sessionId = handle.sessionId;
        // #64: metadata only (never the prompt): who runs, on what, in which trace.
        postWebhook('start', () => ({
          agent: agentName,
          ...(sessionId ? { sessionId } : {}),
          ...(parsed.model !== undefined ? { model: parsed.model } : {}),
          startedAt: new Date(start).toISOString(),
          captureMode: capture.mode,
          ...(budgetUsd !== undefined || maxTurns !== undefined || wallMs !== undefined
            ? { budget: { ...(budgetUsd !== undefined ? { usd: budgetUsd } : {}), ...(maxTurns !== undefined ? { maxTurns } : {}), ...(wallMs !== undefined ? { wallMs } : {}) } }
            : {}),
          ...(typeof parsed.parentRunId === 'string' && parsed.parentRunId !== '' ? { parentRunId: parsed.parentRunId } : {}),
          trace: { traceId: runTrace.traceId, spanId: runTrace.spanId },
        }));
        // Cancellation hook for driver.abort(runId) until the run settles.
        activeRuns.set(runId, () => {
          void Promise.resolve(handle.abort()).catch(() => {});
        });

        const rawDir = join(stateDir, 'raw');
        await mkdir(rawDir, { recursive: true });
        const transcriptPath = join(rawDir, `${agentName}-${sessionId}.jsonl`);
        const transcript = createWriteStream(transcriptPath, { flags: 'a' });
        // Tamper-evident metering (#59): every transcript line is chained to
        // this run (per run, so a resumed session's second run appends its
        // own chain to the same file) and the chain is sealed below.
        const chain = new ChainWriter(runId);
        // #72: the chain frames the RECORDED (tier-stripped) bytes, so a
        // metadata/off run seals and verifies exactly like a full one.
        const writeTranscript = (event: AgentEvent): void => {
          const stored = recordable(event);
          if (stored === null) return;
          transcript.write(`${chain.frame(JSON.stringify(stored))}\n`);
        };
        const writeArtifactEvent = (event: AgentEvent): void => {
          if (artifacts === null) return;
          const stored = recordable(event);
          if (stored !== null) artifacts.event(stored);
        };

        // #199: RunResult.events, capped to a tail when the adapter asks
        // (interactive runs). Latency and the unavailable verdict are folded
        // in as events arrive, so they cover the whole run either way.
        const events = new EventTail(adapter.resultEventTail);
        const latencyAcc = createLatencyAccumulator();
        const availability = createAvailabilityTracker();
        let providerLimitHit = false;
        const recordEvent = (event: AgentEvent): void => {
          // #72: RunResult.events holds the tier's recorded copy (callers such
          // as trial cell artifacts persist it); latency/availability below
          // read the original.
          const stored = recordable(event);
          if (stored !== null) events.push(stored);
          // #72: provider-limit detection reads error-lane TEXT, which the
          // stored copy no longer has below `full`; detect on the original and
          // carry only the verdict.
          if (!captureFull && !providerLimitHit && providerLimitReason([event]) !== null) providerLimitHit = true;
          latencyAcc.observe(event);
          availability.observe(event);
        };
        const tokens: CanonicalTokenRecord[] = [];
        const pricer = options.pricer ?? createPricer();
        warnings.push(...pricer.drainWarnings());

        let cumulativeCost = 0;
        let steps = 0;
        // One model warning per run, whichever cause fires first (a rejected ack
        // wins over the post-hoc session-store mismatch: same cause, one line).
        let modelAckWarned = false;
        let enforcedStatus: ExitStatus | null = null;

        const drainPricerWarnings = () => warnings.push(...pricer.drainWarnings());
        // Truthful budgets: kiro bills in CREDITS, and nothing maps credits to
        // USD, so a --budget-usd cap silently never fires there. Say so up front
        // rather than let the caller believe the run is capped.
        if (budgetUsd !== undefined && (agentName === 'kiro' || agentName === 'kiro-ide')) {
          warnings.push(
            `budget: usd cap is not enforceable for ${agentName} (credits only); wall/idle/maxTurns still apply`,
          );
        }
        // Copilot reports AIU only in its exit-time session summary, so a usd cap
        // is checked once, after the run: it warns, it cannot stop a run early.
        if (budgetUsd !== undefined && agentName === 'copilot') {
          warnings.push(
            'budget: usd cap cannot stop a copilot run mid-run (AIU telemetry arrives when the CLI exits); it is checked afterwards; wall/idle/maxTurns still apply',
          );
        }
        // --- threshold alerts / near-limit warnings (#20) ---
        // Warn WITHOUT aborting: each crossing becomes a `budget.alert` event on
        // the same stream as adapter events (RunResult.events, transcript,
        // outputDir, onEvent) plus a RunRecord.alerts row. Opt-in via
        // budget.alerts / budget.warnAt; the usd cap's abort is separate
        // (budget.onExceed). Kiro prices nothing, so usd alerts cannot fire there.
        // Context-window pressure for non-kiro agents (#21); null for kiro.
        const contextMeter = createContextMeter({ agent: agentName, requestedModel: parsed.model });
        const onExceed = parsed.budget?.onExceed ?? 'warn';
        let exceedWarned = false;
        const runAlerts = createRunAlerts({
          runId,
          stateDir,
          context: contextMeter !== null,
          usd: budgetUsd,
          maxTurns,
          wallMs,
          alerts: parsed.budget?.alerts,
          warnAt: parsed.budget?.warnAt,
          cooldownMs: parsed.budget?.alertCooldownMs ??
            (contextMeter !== null || (parsed.budget?.alerts?.length ?? 0) + (parsed.budget?.warnAt?.length ?? 0) > 0
              ? envCooldownMs((w) => warnings.push(w)) : undefined),
          onWarning: (w) => warnings.push(w),
        });
        // Filled in once the transcript/registry exist (below); alerts only
        // fire from inside the event loop, after that point.
        let emitAlert: (a: FiredAlert) => void = () => {};
        const checkAlert = (metric: AlertMetric, value: number): void => {
          if (runAlerts === null) return;
          for (const a of runAlerts.observe(metric, value)) emitAlert(a);
        };
        // Highest cumulative credit figure the live stream reported
        // (kiro-events puts it on every usage record's extra.creditsCumulative).
        let streamCreditsCumulative: number | null = null;
        // True once the pricer returned a real (non-NaN) price for some record.
        let pricerPriced = false;
        // Which cost paths fed cumulativeCost (issue #28): pricer.price is token
        // math for single-model records but sums CLI-reported slice costs for
        // multi-model ones. totals.costSource is set only when ONE path fed it.
        let costFromReported = false;
        let costFromComputed = false;
        // Per-model cost split (#67) across every priced usage record.
        const modelCosts = new Map<string, { costUsd: number | null; tokens: number }>();

        // --- wall-clock / idle budget timers ---
        // Armed right after launch (wallMs measures from launch) and the idle
        // timer is reset on every AgentEvent. Tripping aborts the handle and
        // forces the 'timeout' verdict with a distinguishing warning; both
        // timers are cleared in the loop's finally below so a dangling timeout
        // can never hold the process open after run() settles.
        let wallTimer: ReturnType<typeof setTimeout> | null = null;
        let idleTimer: ReturnType<typeof setTimeout> | null = null;
        let budgetTripped = false;
        // Which budget timer tripped ('wall' | 'idle') — the run-to-directory
        // status lifecycle (#6) distinguishes 'timeout' from 'idle-timeout' on it.
        let budgetTripKind: 'wall' | 'idle' | null = null;
        const tripBudget = (kind: 'wall' | 'idle', warning: string): void => {
          if (budgetTripped) return;
          budgetTripped = true;
          budgetTripKind = kind;
          enforcedStatus = 'timeout';
          warnings.push(warning);
          if (wallTimer !== null) clearTimeout(wallTimer);
          if (idleTimer !== null) clearTimeout(idleTimer);
          wallTimer = null;
          idleTimer = null;
          void Promise.resolve(handle.abort()).catch(() => {});
        };
        if (wallMs !== undefined) {
          wallTimer = setTimeout(() => tripBudget('wall', `budget: wall-clock ${wallMs}ms exceeded`), wallMs);
        }
        const armIdleTimer = (): void => {
          if (idleMs === undefined) return;
          if (idleTimer !== null) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => tripBudget('idle', `budget: idle ${idleMs}ms exceeded (no events)`), idleMs);
        };
        armIdleTimer();

        // --- run registry hook (dash live view; contract in src/dash/PLAN.md) ---
        // Every registry call is best-effort: failures drain into `warnings`
        // and never break the run. Heartbeat writes are throttled to one per
        // 500ms; the final write is always forced through.
        const registryStateDir = options.registry?.stateDir;
        let rec: RunRecord | null = null;
        let usageFinal = false;
        // totals became optional on RunRecord (external producers omit it); the
        // driver always keeps this local object and hands it to the record.
        const totals: RunRecord["totals"] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
        let lastRegistryWrite = 0;
        const registryWarn = (err: unknown): void => {
          warnings.push(`registry: ${err instanceof Error ? err.message : String(err)}`);
        };
        // A throttled heartbeat schedules one trailing write, so the last
        // event before a quiet spell (an interactive run waiting for input)
        // still reaches the record instead of sitting stale until the end.
        let trailingWrite: ReturnType<typeof setTimeout> | null = null;
        let registryKeepalive: ReturnType<typeof setInterval> | null = null;
        const writeRunRecordThrottled = (force: boolean): void => {
          if (!registryStateDir || !rec) return;
          const now = Date.now();
          if (!force && now - lastRegistryWrite < 500) {
            if (trailingWrite === null) {
              trailingWrite = setTimeout(() => {
                trailingWrite = null;
                if (rec && rec.status === 'running') writeRunRecordThrottled(true);
              }, 500 - (now - lastRegistryWrite));
              trailingWrite.unref?.();
            }
            return;
          }
          if (trailingWrite !== null) {
            clearTimeout(trailingWrite);
            trailingWrite = null;
          }
          lastRegistryWrite = now;
          rec.updatedAt = now;
          // Until the final verdict lands, the record's usage says only what
          // the stream has shown so far: no usage yet reads n/a, never 0 (#142).
          if (!usageFinal) rec.usage = liveUsageAvailability(tokens, pricerPriced, cumulativeCost);
          totals.costUsd = cumulativeCost;
          if (costFromReported !== costFromComputed) totals.costSource = costFromReported ? 'reported' : 'computed';
          else delete totals.costSource;
          totals.provenance = runTotalsProvenance(totals, rec.usage);
          if (modelCosts.size >= 2) totals.byModel = sortModelCosts(modelCosts);
          try {
            writeRunRecord(registryStateDir, rec);
          } catch (err) {
            registryWarn(err);
          }
        };
        // Custom-agent provenance (#37): resolved command + metering label,
        // read at creation and again after wait() (metering is only final then).
        const applyRunRecordExtras = (): void => {
          if (!rec || typeof handle.runRecordExtras !== 'function') return;
          try {
            const x = handle.runRecordExtras();
            if (x.metering !== undefined) rec.metering = x.metering;
            if (x.command !== undefined) rec.command = x.command;
          } catch (err) {
            registryWarn(err);
          }
        };
        const runCwd = typeof parsed.cwd === 'string' && parsed.cwd ? parsed.cwd : process.cwd();
        // #106: instruction files the agent would load from the cwd's
        // ANCESTOR directories (e.g. ~/CLAUDE.md for a workspace under
        // $HOME). Recorded only when non-empty, so every other record is
        // unchanged; `ach run` prints its own pre-launch warning.
        const ancestorInstructions = findAncestorInstructions(agentName, runCwd);
        if (registryStateDir) {
          const runGit = gitBranchInfo(runCwd);
          rec = {
            runId,
            agent: agentName,
            sessionId,
            pid: process.pid,
            cwd: runCwd,
            ...runGit,
            ...resolvePr({ flag: parsed.pr, env: process.env, ...prContextFor(runId, runCwd, runGit.branch) }),
            // #72: no prompt text below `full`.
            ...(captureFull ? { promptPreview: parsed.prompt.slice(0, 120) } : {}),
            captureMode: capture.mode,
            captureSource: capture.source,
            startedAt: start,
            updatedAt: Date.now(),
            status: 'running',
            totals,
            rawTranscript: transcriptPath,
            ...(ancestorInstructions.length > 0 ? { ancestorInstructions } : {}),
            ...(effortResolution !== undefined ? { effort: effortResolution.provenance } : {}),
            // #204 lineage: desk engine per-turn runs (and lanes) name their parent run + desk.
            ...(typeof parsed.parentRunId === 'string' && parsed.parentRunId !== '' ? { parentRunId: parsed.parentRunId } : {}),
            ...(parsed.desk !== undefined ? { desk: { stack: parsed.desk.stack, name: parsed.desk.name, kind: parsed.desk.kind } } : {}),
            // #77: the agent profile and full option set, on the first write so
            // a run that fails or is aborted still carries it.
            ...(parsed.profile !== undefined ? { profile: parsed.profile } : {}),
            trace: runTrace,
          };
          applyRunRecordExtras();
          writeRunRecordThrottled(true);
          const keepaliveMs = adapter.registryKeepaliveMs;
          if (keepaliveMs !== undefined && keepaliveMs > 0) {
            registryKeepalive = setInterval(() => {
              if (!rec || rec.status !== 'running') {
                if (registryKeepalive !== null) clearInterval(registryKeepalive);
                registryKeepalive = null;
                return;
              }
              if (Date.now() - lastRegistryWrite >= keepaliveMs) writeRunRecordThrottled(true);
            }, Math.max(250, Math.floor(keepaliveMs / 2)));
            registryKeepalive.unref?.();
          }
        }
        // Same summing rule as cmdRun (src/cli/ach.ts): canonical token
        // fields summed per usage record; extra.credits (kiro MITM metering
        // units, not USD) kept separate from costUsd.
        let nativeCredits: number | undefined;
        let tapCreditsSum: number | undefined;
        const bumpRegistryTotals = (c: CanonicalTokenRecord): void => {
          if (!rec) return;
          // A record that declares extra.tokensAvailable === false carries
          // PLACEHOLDER zeros (kiro reports no token counts on 2.21.x). It is
          // still kept in RunResult.tokens as evidence, but it must never touch
          // the four token counters — summing placeholders manufactures a
          // confident "0 in / 0 out" where the truth is "unknown". Credits below
          // are real and are still summed.
          if ((c.extra as Record<string, unknown> | undefined)?.tokensAvailable !== false) {
            totals.inputTokens += c.inputTokens;
            totals.outputTokens += c.outputTokens;
            totals.cacheReadTokens += c.cacheReadTokens;
            totals.cacheWriteTokens += c.cacheWriteTokens;
          }
          // Credits: one charge, possibly observed twice (kiro's own metadata
          // frames stamp extra.source:'native'; the MITM tap stamps 'tap').
          // Native wins the moment it appears; the tap is the fallback. Never
          // the sum of both — that doubles every tapped headless run.
          const credits = c.extra?.credits;
          if (typeof credits === 'number' && Number.isFinite(credits)) {
            if (c.extra?.source === 'native') {
              nativeCredits = (nativeCredits ?? 0) + credits;
            } else {
              tapCreditsSum = (tapCreditsSum ?? 0) + credits;
            }
            totals.credits = nativeCredits ?? tapCreditsSum;
          }
        };
        const finalizeRunRecord = (exit: ExitStatus): void => {
          if (!rec) return;
          // timeout (driver wall/idle budget enforcement, adapter timeouts)
          // counts as aborted, not errored: the run was cut short on purpose.
          rec.status =
            exit === 'success'
              ? 'success'
              : exit === 'aborted' || exit === 'cancelled' || exit === 'budget_exceeded' || exit === 'turn_limit' || exit === 'timeout'
                ? 'aborted'
                : exit === 'unavailable'
                  ? 'unavailable'
                  : 'error';
          rec.exitStatus = exit;
          // Bridged handles resolve the real session id late; prefer it when
          // the stream never carried a session event.
          if (handle.sessionId) rec.sessionId = handle.sessionId;
          if (registryKeepalive !== null) {
            clearInterval(registryKeepalive);
            registryKeepalive = null;
          }
          writeRunRecordThrottled(true);
        };

        // Terminal seal (#59): closes the transcript chain (and events.jsonl's,
        // with the identical line) over the final metering totals. Totals are
        // final once the event loop ends: costUsd is taken from cumulativeCost
        // directly (totals.costUsd is only synced on a registry write), and
        // contextTokens/provenance/costSource are deliberately NOT sealed —
        // they are derived later or rewritten on every record write.
        const sealRun = (): void => {
          const at = Date.now();
          const sealTotals = rec ? canonicalTotals({ ...totals, costUsd: cumulativeCost }) : null;
          const sealed = chain.seal(at, sealTotals);
          if (sealed === null) return;
          transcript.write(`${sealed.line}\n`);
          artifacts?.seal(at, sealTotals);
          if (rec) rec.seal = sealed.seal;
        };

        emitAlert = (a: FiredAlert): void => {
          const alertEvent: BudgetAlertEvent = {
            type: 'budget.alert',
            timestamp: a.at,
            sessionId: handle.sessionId,
            runId,
            family: a.family,
            metric: a.metric,
            threshold: a.threshold,
            value: a.value,
            limit: a.limit,
            data: describeAlert(a),
          };
          recordEvent(alertEvent);
          writeTranscript(alertEvent);
          writeArtifactEvent(alertEvent);
          onEvent?.(shareable(alertEvent));
          postWebhook('budget', () => ({
            agent: agentName,
            family: a.family,
            metric: a.metric,
            threshold: a.threshold,
            value: a.value,
            limit: a.limit,
            description: alertEvent.data,
          }));
          if (rec) {
            (rec.alerts ??= []).push({ ...a });
            rec.lastEvent = `budget.alert ${alertEvent.data}`;
            writeRunRecordThrottled(true);
          }
        };

        // #64: the periodic usage summary, time-clocked (never per usage
        // record, so a chatty stream posts no more often than the interval).
        const webhookUsage = (): Record<string, unknown> => ({
          agent: agentName,
          ...(handle.sessionId ? { sessionId: handle.sessionId } : {}),
          elapsedMs: Date.now() - start,
          turns: steps,
          costUsd: cumulativeCost,
          tokens: sumWebhookTokens(tokens),
        });
        let webhookUsageTimer: ReturnType<typeof setInterval> | null = null;
        if (webhook !== undefined && webhook.wants('usage') && webhook.usageIntervalMs > 0) {
          webhookUsageTimer = setInterval(() => postWebhook('usage', webhookUsage), webhook.usageIntervalMs);
          webhookUsageTimer.unref?.();
        }

        try {
          for await (const event of handle.attach()) {
            armIdleTimer(); // every AgentEvent defers the idle deadline
            recordEvent(event);
            writeTranscript(event);
            writeArtifactEvent(event);
            onEvent?.(shareable(event));
            contextMeter?.observe(event);
            const context = contextMeter?.snapshot();
            if (context?.available && context.basis === 'last-call' && context.percentage !== undefined) {
              checkAlert('context', context.percentage);
            }

            if (rec) {
              rec.lastEvent = captureEventPreview(capture.mode, event, () => eventPreview(event));
              if (typeof event.sessionId === 'string' && event.sessionId) rec.sessionId = event.sessionId;
            }
            // Wall near-limit warnings are event-clocked: checked per event.
            if (wallMs !== undefined) checkAlert('wall', Date.now() - start);

            if (event.type === 'usage_raw' || event.type === 'usage') {
              const ts = toMs(event.timestamp);
              let normalized: CanonicalTokenRecord | null = null;
              if (event.type === 'usage_raw') {
                normalized = normalizeAuto(agentName, event.data, ts);
              } else {
                const pre = event.usage;
                if (pre) {
                  normalized = fromPreNormalized(agentName, pre, ts);
                } else if (event.data !== undefined) {
                  // Legacy shape: {type:'usage', data:<raw provider payload>}.
                  normalized = normalizeAuto(agentName, event.data, ts);
                }
              }
              if (normalized) {
                tokens.push(normalized);
                bumpRegistryTotals(normalized);
                const nx = normalized.extra as Record<string, unknown> | undefined;
                const cum = nx?.creditsCumulative;
                if (typeof cum === 'number' && Number.isFinite(cum)) {
                  streamCreditsCumulative = Math.max(streamCreditsCumulative ?? 0, cum);
                }
                if (isVendorMetered(normalized)) {
                  // Vendor-metered (copilot AIU): the cost is the vendor's stated
                  // figure or nothing — never token math, whatever the pricer is.
                  const stated = normalized.costUsd;
                  if (typeof stated === 'number' && Number.isFinite(stated)) {
                    cumulativeCost += stated;
                    pricerPriced = true;
                    costFromReported = true;
                  }
                } else if (nx?.tokensAvailable === false || typeof nx?.unpricedReason === 'string') {
                  // Placeholder zeros with no token counts to price (kiro
                  // 2.21.x), or real tokens the adapter declares unpriceable
                  // (cursor `Auto`: no served model) and already warned about:
                  // pricing them would only add an "unknown model" warning.
                } else {
                  const cost = pricer.price(normalized);
                  for (const m of pricer.priceByModel?.(normalized) ?? []) {
                    const cur = modelCosts.get(m.model) ?? { costUsd: 0, tokens: 0 };
                    cur.costUsd = cur.costUsd === null || m.costUsd === null ? null : cur.costUsd + m.costUsd;
                    cur.tokens += m.tokens;
                    modelCosts.set(m.model, cur);
                  }
                  if (Number.isNaN(cost)) {
                    drainPricerWarnings(); // unpriced model: never silent
                    // ...but the CLI may have stated the cost itself (claude on a
                    // model missing from the price table): keep that figure.
                    const stated = normalized.costUsd;
                    if (typeof stated === 'number' && Number.isFinite(stated)) {
                      cumulativeCost += stated;
                      pricerPriced = true;
                      costFromReported = true;
                    }
                  } else {
                    cumulativeCost += cost;
                    pricerPriced = true;
                    const src = pricedSources(normalized);
                    if (src.reported) costFromReported = true;
                    if (src.computed) costFromComputed = true;
                  }
                }
              }
              // Alerts first, so the 100% crossing is on the stream even when
              // the cap below aborts the run.
              if (budgetUsd !== undefined) checkAlert('usd', cumulativeCost);
              if (budgetUsd !== undefined && cumulativeCost > budgetUsd) {
                if (onExceed === 'abort' && !(event.type === 'usage' && event.finalAccounting === true)) {
                  enforcedStatus = 'budget_exceeded';
                  await handle.abort();
                  break;
                }
                if (!exceedWarned) {
                  exceedWarned = true;
                  warnings.push(
                    event.type === 'usage' && event.finalAccounting === true
                      ? `budget: usd cap $${budgetUsd.toFixed(4)} exceeded ($${cumulativeCost.toFixed(4)}) by final accounting; awaiting process completion (no mid-run enforcement)`
                      : `budget: usd cap $${budgetUsd.toFixed(4)} exceeded ($${cumulativeCost.toFixed(4)}); continuing (onExceed: warn)`,
                  );
                }
              }
            }

            if (event.type === 'step') {
              // Same payload accessor as countsAsTurn(): an adapter may emit
              // `payload` directly, and houseEventToCore renames it to `data`.
              const raw = (event as { payload?: unknown }).payload ?? (event as { data?: unknown }).data;
              const p = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : undefined;
              // A rejected --model is otherwise silent: the run completes on the
              // CLI default and nothing in the result says the override was lost.
              if (p?.kind === 'modelAck' && p.modelAck === 'unsupported' && !modelAckWarned) {
                modelAckWarned = true;
                const asked = typeof p.model === 'string' && p.model !== '' ? p.model : (parsed.model ?? 'unknown');
                warnings.push(
                  `kiro: requested model '${asked}' was not applied (kiro-cli rejected --model: Method not found); the run used the CLI default`,
                );
              }
              // Classified stderr notices carry their own operator-facing text.
              if (p?.kind === 'stderrNotice' && typeof p.warning === 'string') {
                if (!warnings.includes(p.warning)) warnings.push(p.warning);
              }
            }

            if (event.type === 'step' && countsAsTurn(agentName, event)) {
              steps++;
              if (maxTurns !== undefined) checkAlert('turns', steps);
              // Enforce the turn ceiling only when the adapter doesn't do it itself.
              if (maxTurns !== undefined && !adapter.enforcesBudget && steps > maxTurns) {
                enforcedStatus = 'turn_limit';
                await handle.abort();
                break;
              }
            }

            writeRunRecordThrottled(false);
          }
        } catch (err) {
          sealRun();
          transcript.end();
          finalizeRunRecord('error');
          throw err;
        } finally {
          // Timer-leak safety: whatever way the stream ends (natural, abort,
          // break, or throw), no budget timer outlives run().
          if (wallTimer !== null) clearTimeout(wallTimer);
          if (idleTimer !== null) clearTimeout(idleTimer);
          wallTimer = null;
          idleTimer = null;
          // The registry keepalive (#195) only covers the live stream; the
          // final record write follows below.
          if (registryKeepalive !== null) clearInterval(registryKeepalive);
          registryKeepalive = null;
          if (webhookUsageTimer !== null) clearInterval(webhookUsageTimer);
          webhookUsageTimer = null;
          activeRuns.delete(runId);
        }

        sealRun();
        // Await full flush so the NDJSON transcript is on disk when run() resolves.
        await new Promise<void>((resolve) => transcript.end(() => resolve()));
        drainPricerWarnings();

        let adapterExit: AdapterExit = 'success';
        try {
          adapterExit = await handle.wait();
        } catch {
          adapterExit = 'error';
        }
        applyRunRecordExtras();

        // --- kiro effective config + truthful usage (PLAN § Usage availability,
        // amendment 2026-09-12). Both are read AFTER wait() so the child has
        // flushed its session store and the ACP client has settled its config.
        // Every step here is best-effort: a failure becomes a warning.
        let kiroEffective: KiroEffective | undefined;
        const kiroHook = (handle as { kiro?: () => unknown }).kiro;
        if (typeof kiroHook === 'function') {
          try {
            const value = kiroHook.call(handle);
            if (value && typeof value === 'object') kiroEffective = value as KiroEffective;
          } catch (err) {
            warnings.push(`kiro: effective-config hook failed (${err instanceof Error ? err.message : String(err)})`);
          }
        }

        let sessionStore: ParsedKiroSessionStore | null = null;
        if (agentName === 'kiro') {
          if (tokens.length === 0) {
            warnings.push('kiro: no usage records; tokens/credits/usd unavailable');
          }
          // Native session id, best source first: the registry record (the id the
          // stream reported), the adapter's own effective config, then any usage
          // record's extra.kiroSessionId.
          let nativeSessionId: string | undefined =
            (typeof rec?.sessionId === 'string' && rec.sessionId !== '' ? rec.sessionId : undefined) ??
            kiroEffective?.nativeSessionId;
          if (nativeSessionId === undefined) {
            for (const t of tokens) {
              const id = (t.extra as Record<string, unknown> | undefined)?.kiroSessionId;
              if (typeof id === 'string' && id !== '') {
                nativeSessionId = id;
                break;
              }
            }
          }
          // The harness namespaces the session id as `kiro-<uuid>`; the store is
          // keyed by the bare uuid.
          const bare = nativeSessionId?.startsWith('kiro-') === true ? nativeSessionId.slice(5) : nativeSessionId;
          const read = await readKiroSessionStore(bare);
          if (read.ok) {
            // Same session as the pre-run snapshot: drop the earlier runs' turns.
            sessionStore =
              kiroPriorTurns !== undefined && kiroPriorTurns.id === bare
                ? sliceKiroSessionStore(read.store, kiroPriorTurns.count)
                : read.store;
            // 2.21.x leaves kiro token records with model:'unknown' (the stream
            // never names a model). The session store does. Backfilling it here
            // is post-hoc: pricing already ran per event and is NOT redone, so
            // USD stays unavailable — kiro is a credits-only lane.
            if (sessionStore.model !== undefined) {
              for (const t of tokens) {
                if (!t.model || t.model === 'unknown') t.model = sessionStore.model;
              }
            }
            // The ACP transport (and any future CLI that accepts --model and then
            // ignores it) drops the override with no stderr notice at all. The
            // store is the only witness. Skipped when the ack already explained it.
            if (
              parsed.model !== undefined &&
              sessionStore.model !== undefined &&
              sessionStore.model !== parsed.model &&
              !modelAckWarned
            ) {
              modelAckWarned = true;
              warnings.push(
                `kiro: requested model '${parsed.model}' but the session store recorded '${sessionStore.model}'`,
              );
            }
          } else {
            warnings.push(`kiro: ${read.reason}`);
          }
        }

        const { usage, warnings: usageWarnings } = computeUsageAvailability({
          agent: agentName,
          tokens,
          sessionStore,
          streamCreditsCumulative,
          ...(kiroEffective?.tapAttached === true ? { tapAttached: true } : {}),
          totalCost: cumulativeCost,
          pricerPriced,
        });
        warnings.push(...usageWarnings);
        // Codex (#140/#142): the stream never names the model, never reports
        // child-session usage. The native rollout does: observed model/effort,
        // child sessions, and whether the stream's totals are proven complete.
        // Skipped when the stream never named a thread (a launch that died
        // before thread.started has no rollout to read).
        const codexThreadId = handle.sessionId || (typeof rec?.sessionId === 'string' && rec.sessionId !== '' ? rec.sessionId : undefined);
        if (agentName === 'codex' && codexThreadId) {
          try {
            const native = await readCodexNativeUsage({
              sessionId: codexThreadId,
              tokens,
              ...(parsed.model !== undefined ? { requestedModel: parsed.model } : {}),
              ...(requestedCodexEffort(parsed.extraArgs) !== undefined ? { requestedEffort: requestedCodexEffort(parsed.extraArgs) } : {}),
              // The root the CHILD wrote to: its env is process.env + the run's
              // env overrides, minus scrubEnv (src/adapters/shared.ts runJsonlCli).
              sessionsRoot:
                options.codexSessionsRoot ??
                codexSessionsRoot(scrubEnvVars({ ...process.env, ...(parsed.env ?? {}) }, parsed.sandbox?.scrubEnv)),
            });
            usage.model = native.model;
            if (usage.tokens.available) usage.tokens = { ...usage.tokens, ...native.tokens };
            warnings.push(...native.warnings);
            // The pricer saw the stream's model-less records as "unknown". Once the
            // rollout names the model, that warning misleads: say what ran instead.
            // Cost stays as sealed (pricing is not redone after the seal).
            const observed = native.model.observed ?? [];
            if (observed.length > 0) {
              const stale = warnings.findIndex((w) => w.startsWith('pricing: unknown model "unknown"'));
              if (stale !== -1) {
                warnings[stale] =
                  `pricing: run cost not computed: the codex stream names no model (the session file, read after the cost was sealed, shows ${observed.map((m) => `'${m}'`).join(', ')}); \`ach stats\` prices the session by that model`;
              }
            }
            // #141: the stream's turn.completed usage is cumulative, never
            // occupancy. The rollout's latest per-call reading is, so it is fed
            // to the meter as native latest-call usage BEFORE the final
            // snapshot below seals usage.context / totals.contextTokens. It is
            // NOT appended to `events`/the transcript: tokens, cost and the
            // hash chain stay exactly what the stream reported.
            const latest = native.latestCall;
            if (latest !== undefined && contextMeter) {
              const call = latest.lastCall;
              const observedModel = latest.model ?? native.model.observed?.at(-1) ?? parsed.model ?? 'unknown';
              const at = latest.timestamp ?? Date.now();
              const nativeUsage: UsageEvent = {
                type: 'usage',
                timestamp: at,
                usage: {
                  agent: 'codex',
                  model: observedModel,
                  timestamp: at,
                  inputTokens: call.input,
                  cacheReadTokens: call.cacheRead,
                  cacheWriteTokens: call.cacheWrite,
                  outputTokens: call.output,
                  extra: {
                    source: 'codex-rollout',
                    lastTokenUsage: { inputTokens: call.input, cacheReadTokens: call.cacheRead, cacheWriteTokens: call.cacheWrite },
                    ...(latest.contextWindow !== undefined ? { modelContextWindow: latest.contextWindow } : {}),
                    ...(latest.contextWindowSource !== undefined ? { contextWindowSource: latest.contextWindowSource } : {}),
                  },
                },
              };
              const overflow = contextMeter.observe(nativeUsage);
              if (overflow !== undefined) warnings.push(overflow);
            }
          } catch (err) {
            warnings.push(`codex: native rollout read failed (${err instanceof Error ? err.message : String(err)})`);
          }
        }
        // #170: any run whose agent did not already attach a model block (codex's
        // rollout block above is native and wins) records what its own usage
        // events named, plus the requested model. Without this `ach stats`
        // byModel reads `unknown` for nearly every run.
        if (usage.model === undefined) {
          const observed = [
            ...new Set(
              tokens
                .map((t) => t.model)
                .filter((m): m is string => typeof m === 'string' && m !== '' && m !== 'unknown' && m !== '<synthetic>'),
            ),
          ].sort();
          const requested = parsed.model !== undefined && parsed.model !== '' ? parsed.model : undefined;
          if (observed.length > 0) {
            usage.model = { source: 'native', observed, ...(requested !== undefined ? { requested } : {}) };
          } else if (requested !== undefined) {
            usage.model = { source: 'requested', requested };
          }
        }
        // #54: the portable effort is the run's requested effort on the #140
        // model block too (codex already read it from the injected -c flag).
        if (effortResolution !== undefined) {
          if (usage.model === undefined) usage.model = { source: 'unknown', requestedEffort: effortResolution.provenance.requested };
          else if (usage.model.requestedEffort === undefined) usage.model = { ...usage.model, requestedEffort: effortResolution.provenance.requested };
        }
        const meteredContext = contextMeter?.snapshot();
        if (meteredContext !== undefined && usage.context?.available !== true) usage.context = meteredContext;
        if (rec) {
          rec.usage = usage;
          usageFinal = true;
          // #141: totals.contextTokens is occupancy; aggregate (turn-total) usage is not.
          if (usage.context?.available === true && usage.context.basis !== 'turn-total' && usage.context.tokens !== undefined) {
            totals.contextTokens = usage.context.tokens;
          }
        }

        // Driver enforcement verdicts override whatever the adapter reported.
        // An adapter `error` with an outage signature is reclassified
        // `unavailable` (#60, src/core/availability.ts).
        const unavailableReason = enforcedStatus === null ? availability.classify(adapterExit) : null;
        if (unavailableReason !== null) warnings.push(`unavailable: ${unavailableReason}`);
        const exitStatus: ExitStatus = enforcedStatus ?? (unavailableReason !== null ? 'unavailable' : adapterExit);
        // Latency (#32) once, at finalize: deriving per throttled write would be
        // O(events) on every event, and the live trio view re-derives it from
        // the transcript on each /observability fetch anyway.
        if (rec) {
          const latency = latencyAcc.result();
          if (hasLatency(latency)) rec.latency = latency;
        }
        finalizeRunRecord(exitStatus);

        // Read the sessionId late: bridged handles expose a getter that reports
        // the agent's real session id once the stream has carried it.
        const result: RunResult = {
          runId,
          sessionId: handle.sessionId,
          events: events.toArray(),
          ...(events.cap !== undefined || !captureFull ? { eventSummary: { total: events.total, retained: events.retained, turns: steps, latency: latencyAcc.result() } } : {}),
          // #72: token records carry the adapter's native `extra` (free-form
          // strings); below `full` only their numbers and structural fields stay.
          tokens: captureFull ? tokens : stripContent(tokens),
          totalCost: cumulativeCost,
          durationMs: Date.now() - start,
          exitStatus,
          warnings,
          usage,
          ...(typeof parsed.variant === 'string' && parsed.variant !== '' ? { variant: parsed.variant } : {}),
          // #78: the caller's prompt (pre-attachment), for SFT export; not in the registry record.
          // #72: below `full` it is not carried (trial cell artifacts persist RunResult).
          ...(captureFull && typeof parsed.prompt === 'string' && parsed.prompt !== '' ? { prompt: parsed.prompt } : {}),
          ...(!captureFull ? { captureMode: capture.mode } : {}),
          ...(providerLimitHit ? { providerLimit: true } : {}),
          ...(kiroEffective !== undefined ? { kiro: kiroEffective } : {}),
          ...(effortResolution !== undefined ? { effort: effortResolution.provenance } : {}),
          ...(attachmentManifest !== undefined ? { attachments: attachmentManifest } : {}),
          ...(ancestorInstructions.length > 0 ? { ancestorInstructions } : {}),
          trace: runTrace,
        };
        // Run-to-directory settle (#6): the terminal status.json lands last,
        // after every other artifact (result.json included) is on disk.
        await settleArtifacts(exitStatusToRunStatus(exitStatus, budgetTripKind), result);
        // Run lifecycle notification (#63): fired only here, after the RunRecord
        // (finalizeRunRecord) and status.json are durable. Metadata only.
        notifyRunEnd({ runId, agent: agentName, ...(captureFull ? { prompt: parsed.prompt } : {}), exitStatus, costUsd: cumulativeCost }, options.notify);
        // #64: exit event with the full verdict and cost summary, built from the
        // settled RunResult; then a bounded flush. Nothing below touches `result`.
        postWebhook('exit', () => ({
          agent: agentName,
          ...(result.sessionId ? { sessionId: result.sessionId } : {}),
          exitStatus,
          ...(unavailableReason !== null ? { unavailableReason } : {}),
          ...(budgetTripKind !== null ? { timeoutKind: budgetTripKind } : {}),
          durationMs: result.durationMs,
          turns: steps,
          cost: {
            usd: cumulativeCost,
            usdAvailable: usage.usd.available,
            ...(costFromReported !== costFromComputed ? { source: costFromReported ? 'reported' : 'computed' } : {}),
            ...(modelCosts.size >= 2 ? { byModel: sortModelCosts(modelCosts) } : {}),
            ...(usage.credits.available && usage.credits.value !== undefined ? { credits: usage.credits.value } : {}),
          },
          tokens: sumWebhookTokens(tokens),
          warnings: result.warnings.length,
        }));
        await flushWebhook();
        return result;
      } catch (err) {
        // A launch that cannot even start the CLI (#60) is an outage, not a
        // task failure: settle as 'unavailable' and surface a typed error.
        const launchUnavailable = classifyLaunchError(err, typeof parsed.cwd === 'string' ? parsed.cwd : undefined);
        if (launchUnavailable !== null) {
          await settleArtifacts('unavailable');
          notifyRunEnd({ runId, agent: agentName, ...(captureFull ? { prompt: parsed.prompt } : {}), exitStatus: 'unavailable' }, options.notify);
          postWebhook('exit', () => ({ agent: agentName, exitStatus: 'unavailable', unavailableReason: launchUnavailable, durationMs: Date.now() - start }));
          await flushWebhook();
          throw new HarnessError(`agent "${agentName}" unavailable: ${launchUnavailable}`, 'UNAVAILABLE');
        }
        await settleArtifacts('error');
        notifyRunEnd({ runId, agent: agentName, ...(captureFull ? { prompt: parsed.prompt } : {}), exitStatus: 'error' }, options.notify);
        postWebhook('exit', () => ({ agent: agentName, exitStatus: 'error', error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - start }));
        await flushWebhook();
        throw err;
      }
    },
  };
}
