import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { normalizeAuto } from './normalize.js';
import { createPricer, type Pricer } from './pricing.js';
import { writeRunRecord, type RunRecord } from './registry.ts';
import type { AdapterExit, AgentAdapter, AgentEvent, AgentHandle, CanonicalTokenRecord, EventTimestamp, ExitStatus, RunResult, RunSpec } from './types.js';
import { ClaudeCodeAdapter } from '../adapters/claude.js';
import { OpenCodeAdapter } from '../adapters/opencode.js';
import { KiroAdapter } from '../adapters/kiro.js';
import { CodexAdapter } from '../adapters/codex.js';
import { GeminiAdapter } from '../adapters/gemini.js';

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
}

const ADAPTER_MODULE_NAMES = ['claude', 'opencode', 'kiro', 'codex', 'gemini'] as const;

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

  return {
    async run(agentName: string, spec: RunSpec): Promise<RunResult> {
      const adapter = adapters[agentName];
      if (!adapter) {
        throw new Error(`driver: unknown agent "${agentName}"; registered: ${Object.keys(adapters).join(', ') || 'none'}`);
      }
      const parsed = RunSpecSchema.parse(spec);
      const budgetUsd = parsed.budget?.usd;
      const maxTurns = parsed.budget?.maxTurns;
      const wallMs = parsed.budget?.wallMs;
      const idleMs = parsed.budget?.idleMs;

      const start = Date.now();
      const handle = await adapter.launch(parsed);
      const sessionId = handle.sessionId;

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
      let enforcedStatus: ExitStatus | null = null;

      const drainPricerWarnings = () => warnings.push(...pricer.drainWarnings());

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
          runId: randomUUID(),
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
      // Same summing rule as cmdRun (src/cli/harness.ts): canonical token
      // fields summed per usage record; extra.credits (kiro MITM metering
      // units, not USD) kept separate from costUsd.
      const bumpRegistryTotals = (c: CanonicalTokenRecord): void => {
        if (!rec) return;
        rec.totals.inputTokens += c.inputTokens;
        rec.totals.outputTokens += c.outputTokens;
        rec.totals.cacheReadTokens += c.cacheReadTokens;
        rec.totals.cacheWriteTokens += c.cacheWriteTokens;
        const credits = c.extra?.credits;
        if (typeof credits === 'number' && Number.isFinite(credits)) {
          rec.totals.credits = (rec.totals.credits ?? 0) + credits;
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
              const cost = pricer.price(normalized);
              if (Number.isNaN(cost)) {
                drainPricerWarnings(); // unpriced model: contributes 0 to total but is never silent
              } else {
                cumulativeCost += cost;
              }
            }
            if (budgetUsd !== undefined && cumulativeCost > budgetUsd) {
              enforcedStatus = 'budget_exceeded';
              await handle.abort();
              break;
            }
          }

          if (event.type === 'step') {
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

      // Driver enforcement verdicts override whatever the adapter reported.
      const exitStatus: ExitStatus = enforcedStatus ?? adapterExit;
      finalizeRunRecord(exitStatus);

      // Read the sessionId late: bridged handles expose a getter that reports
      // the agent's real session id once the stream has carried it.
      return {
        sessionId: handle.sessionId,
        events,
        tokens,
        totalCost: cumulativeCost,
        durationMs: Date.now() - start,
        exitStatus,
        warnings,
      };
    },
  };
}
