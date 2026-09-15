// Canonical type contracts for agentic-coding-harness — the single source of truth.
//
// This module merges the three parallel dialects that grew up side by side:
//   - driver lane (src/core/driver.ts, tests/driver.test.ts):
//     AgentAdapter/AgentHandle/RunSpec/RunResult/ExitStatus/AdapterExit
//   - transcript lane (src/emitters/{atif,otel}.ts, src/monitors/*):
//     the BaseEvent family and the legacy usage aliases
//     (promptTokens/completionTokens/cachedTokens)
//   - CLI adapter lane (formerly src/adapters/types.ts, now re-exported from
//     here): AdapterCapabilities/CanonicalEvent/RunOptions plus the
//     adapter-lane handle/adapter/token-record shapes, exported under
//     CliAgentAdapter/AdapterRunHandle/AdapterTokenRecord.
//
// AgentEvent is a union of named interfaces, each structurally open
// ([key: string]: unknown via BaseEvent) so both event vocabularies flow
// through the same pipes; AgentEventSchema is the zod view of the canonical
// discriminants. CanonicalTokenRecord is the normalize.ts shape plus the
// legacy optional aliases the emitters read.
import { z } from "zod";

// ---------------------------------------------------------------- agents

export const AGENTS = ["claude", "opencode", "kiro", "codex", "gemini"] as const;
export type AgentName = (typeof AGENTS)[number];

export function isKnownAgent(a: string): a is AgentName {
  return (AGENTS as readonly string[]).includes(a);
}

// ------------------------------------------------------- CLI capabilities
// (moved from src/adapters/types.ts; re-exported there)

/** Feature flags an adapter declares about its backing CLI. */
export interface AdapterCapabilities {
  /** CLI can run fully non-interactive (no TUI / no prompts). */
  headless: boolean;
  /** CLI can emit events incrementally (JSONL on stdout) rather than one blob. */
  streaming: boolean;
  /** CLI supports resuming a prior session by id. */
  resume: boolean;
  /** CLI speaks ACP (Agent Client Protocol) natively. */
  acp: boolean;
  /** Adapter can degrade to driving the CLI inside tmux when headless breaks. */
  tmuxFallback: boolean;
}

// ---------------------------------------------------------------- tokens

/**
 * Cache-aware canonical usage record.
 *
 * SEMANTICS (docs/TOKEN-COUNTING.md): inputTokens is UNCACHED input only;
 * there is no stored total — derive input + cacheRead + cacheWrite + output
 * at render time. costUsd is provider-reported when available, else computed.
 * reasoningTokens is informational (already inside outputTokens for OpenAI/
 * Gemini billing).
 *
 * The four token-count fields are required numbers. agent/model/timestamp/
 * reasoningTokens stay producer-optional because six construction sites
 * (driver.ts, normalize.ts, store.ts, transcripts.ts, kiro-mitm.ts,
 * tests/driver.test.ts) legitimately build records without them; strict
 * canonical records are produced via CanonicalTokenRecordSchema.parse() or
 * fromLegacy().
 *
 * Legacy promptTokens/completionTokens/cachedTokens aliases are read
 * defensively by driver.ts, store.ts and the ATIF/OTel emitters and carried
 * through when present — prefer fromLegacy() when starting from a legacy
 * producer.
 */
export interface CanonicalTokenRecord {
  agent?: string;
  model?: string;
  timestamp?: number;
  /** Turn/step index, when the source reports it. */
  turn?: number;
  /** Source session id, when the tap exposes one (transcript lane). */
  sessionId?: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens?: number;
  costUsd?: number;
  /** @deprecated Legacy alias: prompt = uncached input + cache slices. */
  promptTokens?: number;
  /** @deprecated Legacy alias for outputTokens. */
  completionTokens?: number;
  /** @deprecated Legacy alias for cacheReadTokens. */
  cachedTokens?: number;
  extra?: Record<string, unknown>;
}

/** Zod mirror of CanonicalTokenRecord (passthrough for forward-compat keys). */
export const CanonicalTokenRecordSchema = z
  .object({
    agent: z.string().optional(),
    model: z.string().optional(),
    timestamp: z.number().optional(),
    turn: z.number().int().optional(),
    sessionId: z.string().nullish(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadTokens: z.number().default(0),
    cacheWriteTokens: z.number().default(0),
    reasoningTokens: z.number().optional(),
    costUsd: z.number().optional(),
    promptTokens: z.number().optional(),
    completionTokens: z.number().optional(),
    cachedTokens: z.number().optional(),
    extra: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

/**
 * Legacy usage vocabulary (promptTokens/completionTokens/cachedTokens and the
 * canonical spellings) accepted by fromLegacy().
 */
export interface LegacyTokenUsage {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  /** @deprecated Legacy: total prompt tokens, cache slices included. */
  promptTokens?: number;
  /** @deprecated Legacy: completion tokens. */
  completionTokens?: number;
  /** @deprecated Legacy: cached prompt tokens. */
  cachedTokens?: number;
}

/**
 * Convert a legacy usage record to the canonical shape. Canonical fields win;
 * legacy aliases are read defensively when canonicals are absent — the legacy
 * prompt/completion aliases carry cached tokens INSIDE prompt, so the cache
 * slice is subtracted to keep canonical inputTokens uncached-only (same rule
 * as driver.ts fromPreNormalized and src/core/normalize.ts).
 */
export function fromLegacy(
  agent: string,
  legacy: LegacyTokenUsage,
  timestamp: number = Date.now(),
): CanonicalTokenRecord {
  return {
    agent,
    model: legacy.model ?? "unknown",
    inputTokens:
      legacy.inputTokens ?? Math.max(0, (legacy.promptTokens ?? 0) - (legacy.cachedTokens ?? 0)),
    outputTokens: legacy.outputTokens ?? legacy.completionTokens ?? 0,
    cacheReadTokens: legacy.cacheReadTokens ?? legacy.cachedTokens ?? 0,
    cacheWriteTokens: legacy.cacheWriteTokens ?? 0,
    ...(legacy.reasoningTokens !== undefined ? { reasoningTokens: legacy.reasoningTokens } : {}),
    ...(legacy.costUsd !== undefined ? { costUsd: legacy.costUsd } : {}),
    timestamp,
  };
}

/**
 * Normalized token accounting for one turn/run as produced by the CLI
 * adapters (moved from src/adapters/types.ts). Every adapter maps its native
 * usage blob into exactly these fields; re-exported there as
 * CanonicalTokenRecord for historical import compatibility.
 */
export interface AdapterTokenRecord {
  /** Uncached, prompt-billed input tokens. */
  inputTokens: number;
  /** Prompt tokens served from the provider cache. */
  cacheReadTokens: number;
  /** Tokens written to the provider cache (0 when the CLI does not report it). */
  cacheWriteTokens: number;
  /** Completion/output tokens. */
  outputTokens: number;
  /** Tokens spent on hidden reasoning, when the CLI reports it. */
  reasoningTokens: number | null;
  /** CLI-reported grand total, when present. */
  totalTokens: number | null;
  /** Wall-clock duration of the turn in ms, when the CLI reports it. */
  durationMs: number | null;
  /** The native usage/stats object, kept verbatim for audit and re-mapping. */
  raw: unknown;
}

// ---------------------------------------------------------------- events

export type EventTimestamp = string | number | Date | undefined;

export interface BaseEvent {
  type: string;
  timestamp: EventTimestamp;
  sessionId?: string;
  // Structural openness so named events satisfy AgentHandle's
  // AsyncIterable<AgentEvent> contract (which carries an index signature).
  [key: string]: unknown;
}

export interface SessionStartEvent extends BaseEvent {
  type: "session_start";
  agent?: string;
  version?: string;
  model?: string;
}

export interface MessageEvent extends BaseEvent {
  type: "message";
  /** 'assistant' is the adapter-lane (CanonicalEvent role) spelling of 'agent'. */
  source: "system" | "user" | "agent" | "assistant";
  content: string;
  reasoningContent?: string;
}

export interface ModelCallStartEvent extends BaseEvent {
  type: "model_call_start";
  callId?: string;
  model?: string;
}

export interface ModelCallEndEvent extends BaseEvent {
  type: "model_call_end";
  callId?: string;
  model?: string;
  usage?: CanonicalTokenRecord;
}

export interface ToolCallEvent extends BaseEvent {
  type: "tool_call";
  toolCallId?: string;
  functionName?: string;
  arguments?: Record<string, unknown> | string;
}

export interface ToolResultEvent extends BaseEvent {
  type: "tool_result";
  toolCallId?: string;
  content?: string | Record<string, unknown>;
  isError?: boolean;
}

export interface UsageEvent extends BaseEvent {
  type: "usage";
  usage: CanonicalTokenRecord;
  callId?: string;
}

/** Driver-lane progress/turn marker. */
export interface StepEvent extends BaseEvent {
  type: "step";
}

/** Driver-lane raw provider usage payload; the driver normalizes by shape. */
export interface UsageRawEvent extends BaseEvent {
  type: "usage_raw";
  agent: string;
  data: unknown;
}

/**
 * Base for the driver/adapter-lane variants: same structural openness as
 * BaseEvent but with an OPTIONAL timestamp — producers may omit it (the
 * driver normalizes via toMs); AgentEventSchema enforces the numeric
 * timestamp on the canonical wire form.
 */
export interface OpenEvent {
  type: string;
  timestamp?: EventTimestamp;
  sessionId?: string;
  [key: string]: unknown;
}

/** Adapter-lane tool activity (CanonicalEvent vocabulary). */
export interface ToolEvent extends OpenEvent {
  type: "tool";
  toolName: string;
  phase: "start" | "result";
  toolCallId?: string;
  input?: unknown;
  output?: unknown;
  status?: "success" | "error";
}

/** Run went quiet with no terminal event (watchdog heartbeat). */
export interface IdleEvent extends OpenEvent {
  type: "idle";
}

export interface ErrorEvent extends OpenEvent {
  type: "error";
  message?: string;
}

/** Adapter-lane session-id capture (CanonicalEvent vocabulary). */
export interface SessionEvent extends OpenEvent {
  type: "session";
  sessionId?: string;
}

/** Human-readable CLI progress (stderr lines, status text). */
export interface ProgressEvent extends OpenEvent {
  type: "progress";
  text?: string;
}

/** Terminal event: the run finished (success or otherwise). */
export interface DoneEvent extends OpenEvent {
  type: "done";
  exitStatus?: AdapterExit;
}

/** Run was aborted (claude-lane vocabulary: exitCode/signal ride on `data`). */
export interface AbortedEvent extends OpenEvent {
  type: "aborted";
}

export interface SessionEndEvent extends BaseEvent {
  type: "session_end";
  finalMetrics?: Record<string, unknown>;
}

/**
 * Union of both event vocabularies:
 *  - driver lane: step/usage/usage_raw (adapters attach raw provider payloads
 *    on `data`; the driver normalizes usage via normalizeAuto)
 *  - transcript lane: message/tool_call/tool_result/model_call_* /
 *    session_start/session_end events with explicit fields (consumed by
 *    AtifWriter.fromEvents, deriveSpans)
 *  - adapter lane (CanonicalEvent vocabulary): tool/session/progress
 * Every member extends BaseEvent, so unknown keys remain readable and any
 * lane's extras pass through untouched.
 */
export type AgentEvent =
  | StepEvent
  | MessageEvent
  | ToolEvent
  | ToolCallEvent
  | ToolResultEvent
  | UsageEvent
  | UsageRawEvent
  | IdleEvent
  | ErrorEvent
  | SessionEvent
  | ProgressEvent
  | DoneEvent
  | AbortedEvent
  | SessionStartEvent
  | SessionEndEvent
  | ModelCallStartEvent
  | ModelCallEndEvent;

/**
 * Zod view of the canonical AgentEvent discriminants (each variant
 * passthrough-tolerant of the other lanes' fields). Validating an event
 * against this schema asserts its `type` is one of the canonical ten and that
 * it carries a numeric epoch-ms timestamp.
 */
export const AgentEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("step"), timestamp: z.number() }).passthrough(),
  z
    .object({
      type: z.literal("message"),
      timestamp: z.number(),
      content: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
      role: z.string().optional(),
      text: z.string().optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("tool"),
      timestamp: z.number(),
      toolName: z.string(),
      phase: z.enum(["start", "result"]),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("usage"),
      timestamp: z.number(),
      usage: CanonicalTokenRecordSchema.optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("usage_raw"),
      timestamp: z.number(),
      agent: z.string(),
      data: z.unknown(),
    })
    .passthrough(),
  z.object({ type: z.literal("idle"), timestamp: z.number() }).passthrough(),
  z
    .object({ type: z.literal("error"), timestamp: z.number(), message: z.string().optional() })
    .passthrough(),
  z
    .object({
      type: z.literal("session"),
      timestamp: z.number(),
      sessionId: z.string().optional(),
    })
    .passthrough(),
  z
    .object({ type: z.literal("progress"), timestamp: z.number(), text: z.string().optional() })
    .passthrough(),
  z.object({ type: z.literal("done"), timestamp: z.number() }).passthrough(),
]);

// ------------------------------------------------- canonical events (CLI lane)
// (moved from src/adapters/types.ts; re-exported there)
//
// `step` (opencode/kiro turn marker, opaque kiro payloads) and `usage.cost`
// (opencode per-turn cost) lived as per-adapter local extensions; they are
// part of the canonical vocabulary now.

export type CanonicalEvent =
  | { type: "session"; sessionId: string }
  | { type: "message"; role: "user" | "assistant" | "system"; text: string; reasoning?: boolean }
  | {
      type: "tool";
      toolName: string;
      phase: "start" | "result";
      toolCallId?: string;
      input?: unknown;
      output?: unknown;
      status?: "success" | "error";
    }
  | { type: "step"; payload?: unknown }
  | { type: "usage"; tokens: AdapterTokenRecord; cost?: number }
  /** Human-readable stderr progress emitted by the CLI while running. */
  | { type: "progress"; text: string }
  | { type: "error"; message: string };

// ---------------------------------------------------------------- driver

export type ExitStatus =
  | "success"
  | "error"
  | "timeout"
  | "aborted"
  | "cancelled"
  | "budget_exceeded"
  | "turn_limit";

/** What an adapter's handle.wait() may report. Driver verdicts override. */
export type AdapterExit = "success" | "error" | "timeout" | "aborted" | "cancelled";

// ---------------------------------------------------------------- kiro config

/**
 * One MCP server forwarded to the Kiro ACP `session/new` request.
 * Shape derived from src/adapters/PLAN-kiro-acp.md (`mcpServers`); not
 * re-derived from the ACP specification here — UNVERIFIED against acp docs.
 */
export interface AcpMcpServer {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export const AcpMcpServerSchema = z
  .object({
    name: z.string(),
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();

/** Kiro-specific run configuration (RunSpec.kiro). See PLAN-kiro-acp.md. */
export interface KiroConfig {
  /** Transport: 'headless' (kiro-cli chat) or 'acp' (JSON-RPC). Default 'headless'. */
  transport?: "headless" | "acp";
  /** Native agent / ACP mode id. */
  agent?: string;
  /** Agent engine version. Default 'v2'. */
  engine?: "v1" | "v2" | "v3";
  /** Reasoning effort passed to the CLI. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Trust policy. Undefined → no trust flag at all (never implicit trust-all). */
  tools?: "all" | "none" | string[];
  /** Require MCP servers to start before the prompt is sent. */
  requireMcpStartup?: boolean;
  /** ACP only: MCP servers forwarded to session/new. */
  mcpServers?: AcpMcpServer[];
  /** Startup/handshake budget in ms. Default 60_000. */
  startupMs?: number;
  /** ACP: fail before prompting if set_model is not acknowledged. */
  requireModelAck?: boolean;
}

export const KiroConfigSchema = z
  .object({
    transport: z.enum(["headless", "acp"]).optional(),
    agent: z.string().optional(),
    engine: z.enum(["v1", "v2", "v3"]).optional(),
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
    tools: z.union([z.literal("all"), z.literal("none"), z.array(z.string())]).optional(),
    requireMcpStartup: z.boolean().optional(),
    mcpServers: z.array(AcpMcpServerSchema).optional(),
    startupMs: z.number().positive().optional(),
    requireModelAck: z.boolean().optional(),
  })
  .strict();

/** Whether the model request was acknowledged by the agent process. */
export type KiroModelAck = "acknowledged" | "rejected" | "unsupported" | "not-requested" | "unverified";

/** What the run actually did with the requested Kiro config (RunResult.kiro). */
export interface KiroEffective {
  cliVersion: string;
  transport: "headless" | "acp";
  requested: KiroConfig;
  /** Sanitized effective config (no env); the source of configHash. */
  effective: Record<string, unknown>;
  nativeSessionId?: string;
  modelAck: KiroModelAck;
  configHash: string;
}

export const KiroEffectiveSchema = z.object({
  cliVersion: z.string(),
  transport: z.enum(["headless", "acp"]),
  requested: KiroConfigSchema,
  effective: z.record(z.string(), z.unknown()),
  nativeSessionId: z.string().optional(),
  modelAck: z.enum(["acknowledged", "rejected", "unsupported", "not-requested", "unverified"]),
  configHash: z.string(),
});

/** Truthful usage reporting: what is known, from where — never fabricated zeros. */
export interface UsageAvailability {
  tokens: {
    available: boolean;
    source?: "native" | "tap" | "session-store";
    scope?: "run" | "turn" | "call";
    cumulative?: boolean;
    complete?: boolean;
  };
  credits: {
    available: boolean;
    source?: "native" | "tap" | "reconciled";
    scope?: "run" | "turn" | "call";
    cumulative?: boolean;
    complete?: boolean;
    value?: number;
    /** Every source that reported a credit total, verbatim (audit trail). */
    sources?: Partial<Record<"stream" | "session-store" | "tap", number>>;
  };
  usd: { available: boolean; source?: "pricer"; value?: number };
  /**
   * Context-window occupancy — DERIVED, never billed tokens. `tokens` here is
   * round(percentage/100 * windowTokens); `windowSource:'assumed'` marks a
   * window taken from the fallback table rather than kiro's session store.
   */
  context?: {
    available: boolean;
    source: "derived";
    percentage?: number;
    windowTokens?: number;
    windowSource?: "session-store" | "assumed";
    tokens?: number;
    model?: string;
  };
}

export const UsageAvailabilitySchema = z.object({
  tokens: z.object({
    available: z.boolean(),
    source: z.enum(["native", "tap", "session-store"]).optional(),
    scope: z.enum(["run", "turn", "call"]).optional(),
    cumulative: z.boolean().optional(),
    complete: z.boolean().optional(),
  }),
  credits: z.object({
    available: z.boolean(),
    source: z.enum(["native", "tap", "reconciled"]).optional(),
    scope: z.enum(["run", "turn", "call"]).optional(),
    cumulative: z.boolean().optional(),
    complete: z.boolean().optional(),
    value: z.number().optional(),
    sources: z
      .object({
        stream: z.number().optional(),
        "session-store": z.number().optional(),
        tap: z.number().optional(),
      })
      .optional(),
  }),
  usd: z.object({
    available: z.boolean(),
    source: z.literal("pricer").optional(),
    value: z.number().optional(),
  }),
  context: z
    .object({
      available: z.boolean(),
      source: z.literal("derived"),
      percentage: z.number().optional(),
      windowTokens: z.number().optional(),
      windowSource: z.enum(["session-store", "assumed"]).optional(),
      tokens: z.number().optional(),
      model: z.string().optional(),
    })
    .optional(),
});

/** Run request as accepted by Driver.run(). Extra keys pass through. */
export interface RunSpec {
  prompt: string;
  /**
   * Caller-chosen run id: used as the registry record id when present
   * (async job tools pass a caller-generated uuid); driver generates one
   * otherwise. Echoed back on RunResult.
   */
  runId?: string;
  /** Working directory for the agent subprocess. */
  cwd?: string;
  model?: string;
  resume?: string;
  budget?: { usd?: number; maxTurns?: number; wallMs?: number; idleMs?: number };
  /**
   * Top-level alias for budget.wallMs (whole-run wall-clock cap, ms). Explicit
   * budget.wallMs wins when both are given. Watchdog-style consumers
   * (agentic-coding-harness#5) call the driver with this shape.
   */
  timeoutMs?: number;
  /**
   * Top-level alias for budget.idleMs (no-event idle cap, ms). Explicit
   * budget.idleMs wins when both are given.
   */
  idleTimeoutMs?: number;
  /** Extra env vars layered over process.env. */
  env?: Record<string, string>;
  /** Extra CLI args appended verbatim (escape hatch for provider flags). */
  extraArgs?: string[];
  /** Per-run state directory override (transcripts land under <stateDir>/raw). */
  stateDir?: string;
  /**
   * Run-to-directory mode (agentic-coding-harness#6): write the run's whole
   * artifact set here — invocation.json, events.jsonl, stdout.txt,
   * stderr.txt, result.json, and a durable atomic status.json that is left
   * in a terminal state on every exit path (timeout / idle-timeout / abort /
   * crash included). See src/core/run-artifacts.ts.
   */
  outputDir?: string;
  /** Kiro-specific configuration (ignored by other adapters). */
  kiro?: KiroConfig;
  /**
   * Raw stdout tap for this run (overrides DriverOptions.onOutput): forwarded
   * through the adapter into the CLI child's raw stdout stream. Ignored by
   * transports without a child process (kiro ACP, opencode preferServer).
   */
  onOutput?: (chunk: string) => void;
  [key: string]: unknown;
}

/** Zod mirror of RunSpec (passthrough: adapter-specific keys ride along). */
export const RunSpecSchema = z
  .object({
    prompt: z.string(),
    runId: z.string().optional(),
    cwd: z.string().optional(),
    model: z.string().optional(),
    resume: z.string().optional(),
    budget: z
      .object({
        usd: z.number().positive().optional(),
        maxTurns: z.number().int().positive().optional(),
        wallMs: z.number().positive().optional(),
        idleMs: z.number().positive().optional(),
      })
      .optional(),
    env: z.record(z.string(), z.string()).optional(),
    extraArgs: z.array(z.string()).optional(),
    stateDir: z.string().optional(),
    outputDir: z.string().optional(),
    kiro: KiroConfigSchema.optional(),
  })
  .passthrough();

/** Live handle on one in-flight agent run (the driver's exact contract). */
export interface AgentHandle {
  sessionId: string;
  /** Event stream; completes when the run ends. */
  attach(): AsyncIterable<AgentEvent>;
  abort(): void;
  wait(): Promise<AdapterExit>;
  /**
   * Handle -> driver hand-off for requested-vs-effective Kiro config
   * (see src/adapters/PLAN-kiro-acp.md, "Handle -> driver hand-off").
   * Kiro runs only; every other adapter leaves it undefined. Read it AFTER
   * wait() settles — before that the ack/session evidence is incomplete.
   */
  kiro?: () => KiroEffective | undefined;
}

/** Result of RunHandle.wait(): adapter-reported exit plus raw exit code. */
export interface RunExit {
  exitStatus: AdapterExit;
  exitCode?: number | null;
}

/**
 * Canonical run handle for adapters moving to the driver contract. Identical
 * to AgentHandle except abort() is awaitable and wait() resolves the fuller
 * RunExit; structurally compatible with AgentHandle consumers.
 */
export interface RunHandle {
  sessionId: string;
  /** Event stream; completes when the run ends. */
  attach(): AsyncIterable<AgentEvent>;
  abort(): Promise<void>;
  wait(): Promise<RunExit>;
}

/** Driver-contract adapter: launches a run for a spec (src/core/driver.ts). */
export interface AgentAdapter {
  name: string;
  /** Feature flags of the backing CLI (informational for the driver). */
  capabilities?: AdapterCapabilities;
  launch(spec: RunSpec): Promise<AgentHandle>;
  /** When true, the adapter enforces budget.maxTurns itself. */
  enforcesBudget?: boolean;
}

/** Working-directory/env options shared by the CLI-lane adapters. */
export interface RunOptions {
  /** Working directory for the CLI subprocess. */
  cwd?: string;
  /** Extra env vars layered over process.env. */
  env?: Record<string, string>;
  /** Model override; adapters pass it as their native flag (e.g. -m). */
  model?: string;
  /**
   * Raw stdout tap: called with each chunk of raw CLI stdout EXACTLY as
   * received (chunk boundaries preserved, no line assembly), alongside the
   * canonical parsed events. A throwing tap never breaks the run. Childless
   * transports (e.g. opencode preferServer, kiro ACP) have no stdout to tap.
   */
  onOutput?: (chunk: string) => void;
}

/**
 * CLI-lane run handle (moved from src/adapters/types.ts; re-exported there as
 * RunHandle). One in-flight `opencode`/`codex`/`gemini`/`kiro` child run.
 */
export interface AdapterRunHandle {
  /** Canonical event stream; completes when the child exits. */
  events: AsyncIterable<CanonicalEvent>;
  /** Resolves with the child's exit code. */
  wait(): Promise<number>;
  /** Kill the child (SIGTERM, then SIGKILL after a grace period). */
  abort(): void;
}

/**
 * CLI-lane adapter contract (moved from src/adapters/types.ts; re-exported
 * there as AgentAdapter). One in-flight run per adapter instance.
 */
export interface CliAgentAdapter {
  readonly id: string;
  readonly capabilities: AdapterCapabilities;
  spawn(prompt: string, opts?: RunOptions): AdapterRunHandle;
  resume(sessionId: string, prompt: string, opts?: RunOptions): AdapterRunHandle;
}

export interface RunResult {
  /** Run id (caller-chosen via RunSpec.runId, or driver-generated uuid). */
  runId: string;
  sessionId: string;
  /** Agent name, when the caller echoes it into the result. */
  agent?: string;
  events: AgentEvent[];
  tokens: CanonicalTokenRecord[];
  totalCost: number;
  durationMs: number;
  exitStatus: ExitStatus;
  warnings: string[];
  /** Requested vs effective Kiro config (kiro runs only). */
  kiro?: KiroEffective;
  /** What token/credit/usd numbers are actually known for this run. */
  usage?: UsageAvailability;
}

/** Zod mirror of RunResult (events/tokens kept structurally tolerant). */
export const RunResultSchema = z.object({
  runId: z.string(),
  sessionId: z.string(),
  agent: z.string().optional(),
  events: z.array(z.record(z.string(), z.unknown())),
  tokens: z.array(CanonicalTokenRecordSchema),
  totalCost: z.number(),
  durationMs: z.number(),
  exitStatus: z.enum([
    "success",
    "error",
    "timeout",
    "aborted",
    "cancelled",
    "budget_exceeded",
    "turn_limit",
  ]),
  warnings: z.array(z.string()),
  kiro: KiroEffectiveSchema.optional(),
  usage: UsageAvailabilitySchema.optional(),
});

// ---------------------------------------------------------------- errors

/** Error with a user-presentable message; the CLI prints it without a stack. */
export class HarnessError extends Error {
  constructor(
    message: string,
    readonly code: string = "ERROR",
    readonly exitCode: number = 1,
  ) {
    super(message);
    this.name = "HarnessError";
  }
}
