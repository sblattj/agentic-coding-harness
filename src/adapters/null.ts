// Negative-control "null" adapter (issue #55): a fake agent that needs no
// CLI binary and no auth. `launch()` builds and replays a small,
// deterministic, in-process event stream — session start, one
// message+usage pair per turn, then finish — so `ach run --agent null
// "<prompt>"` exercises the whole pipeline (driver, registry RunRecord,
// artifacts, stats, pricing) for $0 and zero network calls.
//
// Prior art cited in issue #55: openbench's obench/adapters/__init__.py null
// adapter, described there as "the benchmark's negative control" — if the
// pipeline can't produce a correct result for the null adapter, the
// pipeline is broken, not the agent.
import { randomUUID } from "node:crypto";
import {
  HarnessError,
  type AdapterCapabilities,
  type AdapterExit,
  type AgentAdapter,
  type AgentEvent,
  type AgentHandle,
  type RunSpec,
} from "../core/types.ts";

/** Force handle.wait() to resolve with something other than 'success'. */
export const NULL_EXIT_ENV = "AGENTIC_CODING_HARNESS_NULL_EXIT";
/** Number of scripted turns (message+usage pairs) to emit; default 1. */
export const NULL_TURNS_ENV = "AGENTIC_CODING_HARNESS_NULL_TURNS";

/**
 * Exit statuses the null adapter can be told to report. 'success', 'error'
 * and 'timeout' are real AdapterExit values any adapter may resolve from
 * wait(); 'budget_exceeded' is normally a DRIVER verdict only
 * (src/core/driver.ts sets `enforcedStatus` when spec.budget.usd is
 * actually exceeded — no real adapter reports it directly). The null
 * adapter reports it directly anyway (cast in #wait below) purely so the
 * negative control can exercise that branch of the
 * driver/registry/run-artifacts pipeline without requiring the caller to
 * also compute a tripping --budget-usd; the driver's
 * `enforcedStatus ?? adapterExit` passes it straight through because
 * ExitStatus (unlike AdapterExit) already includes it.
 */
const FORCEABLE_EXITS = ["success", "error", "timeout", "budget_exceeded"] as const;
type ForceableExit = (typeof FORCEABLE_EXITS)[number];

function isForceableExit(v: string): v is ForceableExit {
  return (FORCEABLE_EXITS as readonly string[]).includes(v);
}

export const NULL_CAPABILITIES: AdapterCapabilities = {
  headless: true,
  streaming: true,
  resume: true,
  acp: false,
  tmuxFallback: false,
};

/** Deterministic per-turn usage — identical every run unless NULL_TURNS changes the turn count. */
const NULL_INPUT_TOKENS_PER_TURN = 12;
const NULL_OUTPUT_TOKENS_PER_TURN = 8;

/**
 * Model label for null-adapter usage records. Priced at exactly $0 via the
 * dedicated 'null' entry in src/core/pricing.ts FALLBACK_PRICES — this
 * keeps every null run silent (no "unknown model" pricer warning) without
 * repurposing kiro's credits-only carve-out for an unrelated agent.
 */
export const NULL_MODEL = "null";

export interface NullAdapterOptions {
  /** Overrides AGENTIC_CODING_HARNESS_NULL_EXIT for this instance (tests). */
  forceExit?: string;
  /** Overrides AGENTIC_CODING_HARNESS_NULL_TURNS for this instance (tests). */
  turns?: number;
}

function readForceExit(options: NullAdapterOptions): ForceableExit {
  const raw = options.forceExit ?? process.env[NULL_EXIT_ENV] ?? "success";
  if (!isForceableExit(raw)) {
    throw new HarnessError(
      `${NULL_EXIT_ENV} must be one of ${FORCEABLE_EXITS.join(", ")} (got '${raw}')`,
      "INVALID_NULL_EXIT",
    );
  }
  return raw;
}

function readTurns(options: NullAdapterOptions): number {
  const raw = options.turns ?? process.env[NULL_TURNS_ENV];
  if (raw === undefined) return 1;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new HarnessError(
      `${NULL_TURNS_ENV} must be a positive integer (got '${String(raw)}')`,
      "INVALID_NULL_TURNS",
    );
  }
  return n;
}

/**
 * Build the whole scripted event list up front (deterministic given the
 * same turns/prompt/sessionId — only `timestamp` varies between calls,
 * mirroring every real adapter's event stream).
 */
function scriptedEvents(sessionId: string, prompt: string, turns: number): AgentEvent[] {
  const events: AgentEvent[] = [];
  const now = () => Date.now();
  events.push({ type: "session_start", agent: "null", timestamp: now(), sessionId });
  for (let i = 0; i < turns; i++) {
    events.push({
      type: "message",
      source: "agent",
      content: `null adapter: deterministic reply ${i + 1}/${turns} to: ${prompt.slice(0, 200)}`,
      timestamp: now(),
      sessionId,
    });
    events.push({
      type: "usage",
      usage: {
        model: NULL_MODEL,
        inputTokens: NULL_INPUT_TOKENS_PER_TURN,
        outputTokens: NULL_OUTPUT_TOKENS_PER_TURN,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
      },
      timestamp: now(),
      sessionId,
    });
    events.push({ type: "step", timestamp: now(), sessionId, payload: { countsAsTurn: true } });
  }
  events.push({ type: "session_end", timestamp: now(), sessionId });
  return events;
}

/**
 * Driver-contract adapter (src/core/driver.ts AgentAdapter): a deterministic
 * in-process fake with no child process, no network, and no credentials.
 */
export class NullAdapter implements AgentAdapter {
  readonly name = "null";
  readonly capabilities: AdapterCapabilities = NULL_CAPABILITIES;

  #options: NullAdapterOptions;

  constructor(options: NullAdapterOptions = {}) {
    this.#options = options;
  }

  async launch(spec: RunSpec): Promise<AgentHandle> {
    // Read env/options fresh at launch time (not construction time) so a
    // single long-lived instance still honours a per-run env override —
    // matches defaultAdapters(), which constructs a fresh instance per run
    // anyway.
    const forceExit = readForceExit(this.#options);
    const turns = readTurns(this.#options);
    const sessionId = spec.resume && spec.resume !== "" ? spec.resume : `null-${randomUUID()}`;
    const events = scriptedEvents(sessionId, spec.prompt, turns);
    let aborted = false;

    async function* attach(): AsyncIterable<AgentEvent> {
      for (const e of events) {
        if (aborted) return;
        yield e;
      }
    }

    return {
      sessionId,
      attach,
      abort(): void {
        aborted = true;
      },
      async wait(): Promise<AdapterExit> {
        if (aborted) return "aborted";
        // See FORCEABLE_EXITS comment above: 'budget_exceeded' is outside
        // the AdapterExit union on purpose (a real adapter never reports
        // it) — this cast is the null adapter's documented escape hatch for
        // simulating a driver-only verdict.
        return forceExit as unknown as AdapterExit;
      },
    };
  }
}
