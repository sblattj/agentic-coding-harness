// Content-capture policy (#72): how much of a run's prompt, message and tool
// text ach writes to disk. Applied at RECORD time, in the driver, so a tier
// below `full` never lets the text reach the state dir in the first place
// (it is not an export mask over files that already hold it).
//
//   full      everything, exactly as before (the default; zero change)
//   metadata  event types, ids, model and tool names, timings, token and
//             cost numbers; every other string becomes "[STRIPPED]"
//   off       run lifecycle events (session start/end, done, abort, error
//             type) and the stripped token lines, nothing else: no message,
//             tool, step or progress events. The token lines stay because
//             `ach stats`, `ach audit` and the archive derive spend from them.
//
// The resolution order for one run:
//   per-agent entry (config `contentCapture.agents.<agent>`)
//   > global tier: `--capture-mode` > ACH_CAPTURE_MODE > `run.captureMode`
//     in the config file > `contentCapture.default` in the config file
//   > `full`
// A per-agent entry beats the global tier in both directions (stricter or
// looser): it is the administrator's statement about that one agent.
import { HarnessError, type AgentEvent } from './types.ts';

export const CAPTURE_MODES = ['off', 'metadata', 'full'] as const;
export type CaptureMode = (typeof CAPTURE_MODES)[number];
/** The env var that sets the global tier (the issue's name, short prefix on purpose). */
export const CAPTURE_MODE_ENV = 'ACH_CAPTURE_MODE';
/** The marker a stripped string is replaced with. */
export const STRIPPED = '[STRIPPED]';
/** Top-level config file key holding the policy (`{ default?, agents? }` or a bare tier). */
export const CONTENT_CAPTURE_KEY = 'contentCapture';

/** File-level policy: an optional default tier and per-agent overrides. */
export interface CapturePolicy {
  /** Global tier from the config file (below the flag and the env var). */
  default?: CaptureMode;
  /** Per-agent tiers; each beats the global tier for that agent. */
  agents?: Record<string, CaptureMode>;
}

export function isCaptureMode(v: unknown): v is CaptureMode {
  return typeof v === 'string' && (CAPTURE_MODES as readonly string[]).includes(v);
}

/** Parse a user-supplied tier, or throw a USAGE error naming where it came from. */
export function parseCaptureMode(raw: string, from: string): CaptureMode {
  const v = raw.trim();
  if (isCaptureMode(v)) return v;
  throw new HarnessError(`${from} must be one of ${CAPTURE_MODES.join(', ')} (got '${raw}')`, 'USAGE');
}

export interface CaptureResolution {
  mode: CaptureMode;
  /** `agent:<name>` | `spec` | `flag` | `env:ACH_CAPTURE_MODE` | `config` | `default`. */
  source: string;
}

/**
 * The effective tier for one run of `agent`. `explicit` is the global tier a
 * caller already resolved (flag or config `run.captureMode`); it beats the
 * env var. `policy.default` sits below the env var; `policy.agents[agent]`
 * beats all of them.
 */
export function resolveCaptureMode(opts: {
  agent: string;
  explicit?: CaptureMode | undefined;
  explicitSource?: string;
  env?: Record<string, string | undefined>;
  policy?: CapturePolicy | undefined;
}): CaptureResolution {
  const perAgent = opts.policy?.agents?.[opts.agent];
  if (perAgent !== undefined) return { mode: perAgent, source: `agent:${opts.agent}` };
  if (opts.explicit !== undefined) return { mode: opts.explicit, source: opts.explicitSource ?? 'spec' };
  const env = opts.env ?? process.env;
  const raw = env[CAPTURE_MODE_ENV];
  if (raw !== undefined && raw !== '') return { mode: parseCaptureMode(raw, CAPTURE_MODE_ENV), source: `env:${CAPTURE_MODE_ENV}` };
  if (opts.policy?.default !== undefined) return { mode: opts.policy.default, source: 'config' };
  return { mode: 'full', source: 'default' };
}

/**
 * Validate a `contentCapture` config value; returns problems (empty = ok).
 * Accepts a bare tier (the global default) or `{ default?, agents? }`.
 */
export function capturePolicyProblems(value: unknown, at: string): string[] {
  if (typeof value === 'string') {
    return isCaptureMode(value) ? [] : [`${at} expects one of ${CAPTURE_MODES.join(', ')}, got '${value}'`];
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return [`${at} must be a tier (${CAPTURE_MODES.join(' | ')}) or an object { default, agents }`];
  }
  const problems: string[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === 'default') {
      if (!isCaptureMode(v)) problems.push(`${at}.default expects one of ${CAPTURE_MODES.join(', ')}, got ${JSON.stringify(v)}`);
    } else if (k === 'agents') {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) {
        problems.push(`${at}.agents must be an object of agent name to tier`);
        continue;
      }
      for (const [agent, tier] of Object.entries(v as Record<string, unknown>)) {
        if (!isCaptureMode(tier)) problems.push(`${at}.agents.${agent} expects one of ${CAPTURE_MODES.join(', ')}, got ${JSON.stringify(tier)}`);
      }
    } else {
      problems.push(`${at} has unknown key '${k}' (expected 'default' or 'agents')`);
    }
  }
  return problems;
}

/** Normalize a validated `contentCapture` value into a CapturePolicy. */
export function toCapturePolicy(value: unknown): CapturePolicy {
  if (isCaptureMode(value)) return { default: value };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const v = value as { default?: unknown; agents?: unknown };
  const out: CapturePolicy = {};
  if (isCaptureMode(v.default)) out.default = v.default;
  if (v.agents !== null && typeof v.agents === 'object' && !Array.isArray(v.agents)) {
    const agents: Record<string, CaptureMode> = {};
    for (const [a, t] of Object.entries(v.agents as Record<string, unknown>)) if (isCaptureMode(t)) agents[a] = t;
    if (Object.keys(agents).length > 0) out.agents = agents;
  }
  return out;
}

/** Later policies win per key (default, and each agent entry). */
export function mergeCapturePolicies(policies: CapturePolicy[]): CapturePolicy {
  const out: CapturePolicy = {};
  for (const p of policies) {
    if (p.default !== undefined) out.default = p.default;
    if (p.agents !== undefined) out.agents = { ...(out.agents ?? {}), ...p.agents };
  }
  return out;
}

// ------------------------------------------------------------ stripping

/**
 * String-valued keys whose value is structure, not content: event and phase
 * types, ids, timestamps, model/tool/agent names, verdicts. Every other
 * string, at any depth, is replaced (default deny). Numbers and booleans are
 * kept outside content containers, so token counts, costs, durations and turn
 * markers survive. Object KEYS outside content are kept as-is (native usage
 * maps are keyed by model name).
 */
const STRUCTURAL_STRING_KEYS: ReadonlySet<string> = new Set([
  'type',
  'subtype',
  'kind',
  'phase',
  'role',
  'source',
  'status',
  'timestamp',
  'ts',
  'at',
  'agent',
  'model',
  'modelId',
  'provider',
  'sessionId',
  'session_id',
  'runId',
  'parentRunId',
  'id',
  'uuid',
  'parentUuid',
  'callId',
  'toolCallId',
  'toolUseId',
  'tool_use_id',
  'messageId',
  'requestId',
  'name',
  'toolName',
  'functionName',
  'tool',
  'stopReason',
  'stop_reason',
  'finishReason',
  'finish_reason',
  'exitStatus',
  'family',
  'metric',
  'provenance',
  'basis',
  'transport',
  'modelAck',
  'service_tier',
  'version',
]);

/** The run lifecycle event types. */
export const LIFECYCLE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'session_start',
  'session',
  'session_end',
  'done',
  'aborted',
  'error',
]);

/**
 * Event types the `off` tier writes: the lifecycle plus the token lines
 * (`usage`, `usage_raw`), stripped. Spend readers (`ach stats`, `ach audit`,
 * the archive) derive totals from those lines, so dropping them would make an
 * `off` run's spend invisible rather than just its text.
 */
export const OFF_TIER_EVENT_TYPES: ReadonlySet<string> = new Set([...LIFECYCLE_EVENT_TYPES, 'usage', 'usage_raw']);

/**
 * Keys whose object or array value is CONTENT: tool arguments and results,
 * message content blocks, raw ACP tool input/output. Inside one, the
 * structural-key allowlist no longer applies (an argument called `name` or a
 * result field called `status` is tool data, not run structure): every string,
 * number and boolean is stripped, and only identifier-like keys are kept.
 */
const CONTENT_CONTAINER_KEYS: ReadonlySet<string> = new Set([
  'args',
  'arguments',
  'input',
  'output',
  'result',
  'content',
  'parameters',
  'params',
  'prompt',
  'messages',
  'response',
  'toolInput',
  'toolOutput',
  'tool_input',
  'tool_output',
  'rawInput',
  'rawOutput',
  'stdout',
  'stderr',
  'text',
]);

/**
 * Content-block discriminators kept inside content (a closed set of VALUES,
 * so nothing an agent or tool wrote can pass): what a block is, never what it says.
 */
const CONTENT_BLOCK_TYPES: ReadonlySet<string> = new Set([
  'text',
  'thinking',
  'redacted_thinking',
  'reasoning',
  'tool_use',
  'tool_result',
  'server_tool_use',
  'function_call',
  'function_call_output',
  'image',
  'document',
  'input_text',
  'output_text',
  'resource',
  'resource_link',
  'diff',
  'terminal',
]);

/** A key kept inside content: a plain identifier (an argument or field NAME, the tool's schema). */
const IDENTIFIER_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function stripValue(value: unknown, key: string | undefined, inContent = false): unknown {
  if (inContent) return stripInContent(value, key);
  if (typeof value === 'string') return key !== undefined && STRUCTURAL_STRING_KEYS.has(key) ? value : STRIPPED;
  if (Array.isArray(value)) return value.map((v) => stripValue(v, key));
  if (value !== null && typeof value === 'object') {
    if (value instanceof Date) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // A bare number under `input`/`output` is a token count (native usage
      // shapes), not content: only objects and arrays open a content container.
      const opens = CONTENT_CONTAINER_KEYS.has(k) && v !== null && typeof v === 'object';
      out[k] = stripValue(v, k, opens);
    }
    return out;
  }
  return value;
}

function stripInContent(value: unknown, key: string | undefined): unknown {
  if (typeof value === 'string') return key === 'type' && CONTENT_BLOCK_TYPES.has(value) ? value : STRIPPED;
  if (Array.isArray(value)) return value.map((v) => stripInContent(v, key));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    let i = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[IDENTIFIER_KEY.test(k) ? k : `${STRIPPED}#${i}`] = stripInContent(v, k);
      i++;
    }
    return out;
  }
  if (value === null || value === undefined) return value;
  return STRIPPED;
}

/** `value` with every non-structural string replaced by STRIPPED (the metadata tier's rule). */
export function stripContent<T>(value: T): T {
  return stripValue(value, undefined) as T;
}

/**
 * The copy of `event` that may be recorded under `mode`: the event itself
 * under `full`, a stripped copy under `metadata`, a stripped lifecycle or
 * token event, or null (not recorded), under `off`. The input is never mutated: the driver
 * keeps metering from the original.
 */
export function captureEvent(mode: CaptureMode, event: AgentEvent): AgentEvent | null {
  if (mode === 'full') return event;
  if (mode === 'off' && !OFF_TIER_EVENT_TYPES.has(event.type)) return null;
  return stripValue(event, undefined) as AgentEvent;
}

/** A RunRecord `lastEvent` line under `mode` (full keeps the caller's preview). */
export function captureEventPreview(mode: CaptureMode, event: AgentEvent, full: () => string): string {
  if (mode === 'full') return full();
  if (mode === 'off') return event.type;
  for (const v of [event.toolName, event.functionName, event.name]) {
    if (typeof v === 'string' && v.trim()) return `${event.type} ${v.slice(0, 80)}`;
  }
  return event.type;
}
