import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { normalizeAuto } from './normalize.js';
import { createPricer, type Pricer } from './pricing.js';
import { writeRunRecord, type RunRecord } from './registry.ts';
import { computeUsageAvailability } from './usage-availability.js';
import { readKiroSessionStore, type ParsedKiroSessionStore } from '../adapters/kiro-session-store.js';
import type { AdapterExit, AgentAdapter, AgentEvent, AgentHandle, CanonicalTokenRecord, EventTimestamp, ExitStatus, KiroEffective, RunResult, RunSpec } from './types.js';
import { ClaudeCodeAdapter } from '../adapters/claude.js';
import { OpenCodeAdapter } from '../adapters/opencode.js';
import { KiroAdapter } from '../adapters/kiro.js';
import { CodexAdapter } from '../adapters/codex.js';
import { GeminiAdapter } from '../adapters/gemini.js';
import { takeOnOutput } from '../adapters/shared.js';

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

const RunSpecSchema = z.object({
  prompt: z.string(),
  model: z.string().optional(),
  budget: z
    .object({
      usd: z.number().positive().optional(),
      maxTurns: z.number().int().positive().optional(),
      wallMs: z.number().positive().optional(),
      idleMs: z.number().positive().optional(),
    })
    .optional(),
  // Watchdog-style top-level aliases (#5): resolve to budget.wallMs / idleMs;
  // an explicit budget.* value always wins.
  timeoutMs: z.number().positive().optional(),
  idleTimeoutMs: z.number().positive().optional(),
  // Adapter-specific keys pass through untouched.
  // Note: key regex covers provider-specific options; validated loosely.
}).passthrough();

export interface DriverOptions {
  adapters: Record<string, AgentAdapter>;
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

const ADAPTER_MODULE_NAMES = ['claude', 'opencode', 'kiro', 'codex', 'gemini'] as const;

/** Default signals wired by installSignalAbort (#11). */
const ABORT_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

/** Launch-capable subset every bundled adapter class implements natively. */
interface LaunchableAdapter {
  launch(spec: RunSpec): Promise<AgentHandle>;
}

/**
 * Registry helper: instantiates each bundled adapter CLASS. All five adapters
 * implement the driver contract's launch() natively (bridged via
 * launchDriverHandle in src/adapters/shared.ts); the wrapper here supplies the
 * canonical `name` field and, for claude, the enforcesBudget marker (claude
 * always passes --max-turns itself). A fresh instance is created per launch,
 * so single-run adapters are never reused. Missing or incompatible adapters
 * are skipped with a warning, never fatal.
 */
export async function defaultAdapters(): Promise<Record<string, AgentAdapter>> {
  const adapters: Record<string, AgentAdapter> = {};
  const makers: Record<string, () => LaunchableAdapter> = {
    claude: () => new ClaudeCodeAdapter(),
    opencode: () => new OpenCodeAdapter(),
    kiro: () => new KiroAdapter(),
    codex: () => new CodexAdapter(),
    gemini: () => new GeminiAdapter(),
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
      const parsed = RunSpecSchema.parse(spec);
      // Caller-chosen run id (async job tools pass a uuid so the registry
      // record is addressable before spawn); generated otherwise.
      const runId = typeof spec.runId === 'string' && spec.runId ? spec.runId : randomUUID();
      const budgetUsd = parsed.budget?.usd;
      const maxTurns = parsed.budget?.maxTurns;
      // Explicit budget.* wins; timeoutMs / idleTimeoutMs are watchdog-style
      // top-level aliases (#5).
      const wallMs = parsed.budget?.wallMs ?? parsed.timeoutMs;
      const idleMs = parsed.budget?.idleMs ?? parsed.idleTimeoutMs;

      const start = Date.now();
      // Raw stdout tap precedence: RunSpec.onOutput wins over the driver-wide
      // DriverOptions.onOutput; merged here so every adapter sees one field.
      const onOutput = takeOnOutput(parsed) ?? options.onOutput;
      const handle = await adapter.launch(onOutput ? { ...parsed, onOutput } : parsed);
      const sessionId = handle.sessionId;
      // Cancellation hook for driver.abort(runId) until the run settles.
      activeRuns.set(runId, () => {
        void Promise.resolve(handle.abort()).catch(() => {});
      });

      const rawDir = join(stateDir, 'raw');
      await mkdir(rawDir, { recursive: true });
      const transcriptPath = join(rawDir, `${agentName}-${sessionId}.jsonl`);
      const transcript = createWriteStream(transcriptPath, { flags: 'a' });

      const events: AgentEvent[] = [];
      const tokens: CanonicalTokenRecord[] = [];
      const warnings: string[] = [];
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
      if (budgetUsd !== undefined && agentName === 'kiro') {
        warnings.push(
          'budget: usd cap is not enforceable for kiro (credits only); wall/idle/maxTurns still apply',
        );
      }
      // Highest cumulative credit figure the live stream reported
      // (kiro-events puts it on every usage record's extra.creditsCumulative).
      let streamCreditsCumulative: number | null = null;
      // True once the pricer returned a real (non-NaN) price for some record.
      let pricerPriced = false;

      // --- wall-clock / idle budget timers ---
      // Armed right after launch (wallMs measures from launch) and the idle
      // timer is reset on every AgentEvent. Tripping aborts the handle and
      // forces the 'timeout' verdict with a distinguishing warning; both
      // timers are cleared in the loop's finally below so a dangling timeout
      // can never hold the process open after run() settles.
      let wallTimer: ReturnType<typeof setTimeout> | null = null;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      let budgetTripped = false;
      const tripBudget = (warning: string): void => {
        if (budgetTripped) return;
        budgetTripped = true;
        enforcedStatus = 'timeout';
        warnings.push(warning);
        if (wallTimer !== null) clearTimeout(wallTimer);
        if (idleTimer !== null) clearTimeout(idleTimer);
        wallTimer = null;
        idleTimer = null;
        void Promise.resolve(handle.abort()).catch(() => {});
      };
      if (wallMs !== undefined) {
        wallTimer = setTimeout(() => tripBudget(`budget: wall-clock ${wallMs}ms exceeded`), wallMs);
      }
      const armIdleTimer = (): void => {
        if (idleMs === undefined) return;
        if (idleTimer !== null) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => tripBudget(`budget: idle ${idleMs}ms exceeded (no events)`), idleMs);
      };
      armIdleTimer();

      // --- run registry hook (dash live view; contract in src/dash/PLAN.md) ---
      // Every registry call is best-effort: failures drain into `warnings`
      // and never break the run. Heartbeat writes are throttled to one per
      // 500ms; the final write is always forced through.
      const registryStateDir = options.registry?.stateDir;
      let rec: RunRecord | null = null;
      let lastRegistryWrite = 0;
      const registryWarn = (err: unknown): void => {
        warnings.push(`registry: ${err instanceof Error ? err.message : String(err)}`);
      };
      const writeRunRecordThrottled = (force: boolean): void => {
        if (!registryStateDir || !rec) return;
        const now = Date.now();
        if (!force && now - lastRegistryWrite < 500) return;
        lastRegistryWrite = now;
        rec.updatedAt = now;
        rec.totals.costUsd = cumulativeCost;
        try {
          writeRunRecord(registryStateDir, rec);
        } catch (err) {
          registryWarn(err);
        }
      };
      if (registryStateDir) {
        rec = {
          runId,
          agent: agentName,
          sessionId,
          pid: process.pid,
          cwd: typeof parsed.cwd === 'string' && parsed.cwd ? parsed.cwd : process.cwd(),
          promptPreview: parsed.prompt.slice(0, 120),
          startedAt: start,
          updatedAt: Date.now(),
          status: 'running',
          totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
          rawTranscript: transcriptPath,
        };
        writeRunRecordThrottled(true);
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
          rec.totals.inputTokens += c.inputTokens;
          rec.totals.outputTokens += c.outputTokens;
          rec.totals.cacheReadTokens += c.cacheReadTokens;
          rec.totals.cacheWriteTokens += c.cacheWriteTokens;
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
          rec.totals.credits = nativeCredits ?? tapCreditsSum;
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
              : 'error';
        rec.exitStatus = exit;
        // Bridged handles resolve the real session id late; prefer it when
        // the stream never carried a session event.
        if (handle.sessionId) rec.sessionId = handle.sessionId;
        writeRunRecordThrottled(true);
      };

      try {
        for await (const event of handle.attach()) {
          armIdleTimer(); // every AgentEvent defers the idle deadline
          events.push(event);
          transcript.write(`${JSON.stringify(event)}\n`);
          onEvent?.(event);

          if (rec) {
            rec.lastEvent = eventPreview(event);
            if (typeof event.sessionId === 'string' && event.sessionId) rec.sessionId = event.sessionId;
          }

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
              if (nx?.tokensAvailable === false) {
                // Placeholder zeros with no token counts to price (kiro
                // 2.21.x): pricing them would only emit an "unknown model"
                // warning about a record that carries nothing priceable.
              } else {
                const cost = pricer.price(normalized);
                if (Number.isNaN(cost)) {
                  drainPricerWarnings(); // unpriced model: contributes 0 to total but is never silent
                } else {
                  cumulativeCost += cost;
                  pricerPriced = true;
                }
              }
            }
            if (budgetUsd !== undefined && cumulativeCost > budgetUsd) {
              enforcedStatus = 'budget_exceeded';
              await handle.abort();
              break;
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
        finalizeRunRecord('error');
        throw err;
      } finally {
        // Timer-leak safety: whatever way the stream ends (natural, abort,
        // break, or throw), no budget timer outlives run().
        if (wallTimer !== null) clearTimeout(wallTimer);
        if (idleTimer !== null) clearTimeout(idleTimer);
        wallTimer = null;
        idleTimer = null;
        activeRuns.delete(runId);
      }

      // Await full flush so the NDJSON transcript is on disk when run() resolves.
      await new Promise<void>((resolve) => transcript.end(() => resolve()));
      drainPricerWarnings();

      let adapterExit: AdapterExit = 'success';
      try {
        adapterExit = await handle.wait();
      } catch {
        adapterExit = 'error';
      }

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
          sessionStore = read.store;
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
        totalCost: cumulativeCost,
        pricerPriced,
      });
      warnings.push(...usageWarnings);
      if (rec) {
        rec.usage = usage;
        if (usage.context?.available === true && usage.context.tokens !== undefined) {
          rec.totals.contextTokens = usage.context.tokens;
        }
      }

      // Driver enforcement verdicts override whatever the adapter reported.
      const exitStatus: ExitStatus = enforcedStatus ?? adapterExit;
      finalizeRunRecord(exitStatus);

      // Read the sessionId late: bridged handles expose a getter that reports
      // the agent's real session id once the stream has carried it.
      return {
        runId,
        sessionId: handle.sessionId,
        events,
        tokens,
        totalCost: cumulativeCost,
        durationMs: Date.now() - start,
        exitStatus,
        warnings,
        usage,
        ...(kiroEffective !== undefined ? { kiro: kiroEffective } : {}),
      };
    },
  };
}
