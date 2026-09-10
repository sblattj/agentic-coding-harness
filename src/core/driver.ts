import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { normalizeAuto } from './normalize.js';
import { createPricer, type Pricer } from './pricing.js';
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

      const start = Date.now();
      const handle = await adapter.launch(parsed);
      const sessionId = handle.sessionId;

      const rawDir = join(stateDir, 'raw');
      await mkdir(rawDir, { recursive: true });
      const transcript = createWriteStream(join(rawDir, `${agentName}-${sessionId}.jsonl`), { flags: 'a' });

      const events: AgentEvent[] = [];
      const tokens: CanonicalTokenRecord[] = [];
      const warnings: string[] = [];
      const pricer = options.pricer ?? createPricer();
      warnings.push(...pricer.drainWarnings());

      let cumulativeCost = 0;
      let steps = 0;
      let enforcedStatus: ExitStatus | null = null;

      const drainPricerWarnings = () => warnings.push(...pricer.drainWarnings());

      for await (const event of handle.attach()) {
        events.push(event);
        transcript.write(`${JSON.stringify(event)}\n`);
        onEvent?.(event);

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
