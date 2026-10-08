import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdapterCapabilities, AgentAdapter, CanonicalEvent, RunHandle, RunOptions } from './types.ts';
import type {
  AdapterProfileCheck,
  AdapterProfileIssue,
  AgentAdapter as CoreAgentAdapter,
  AgentHandle as CoreAgentHandle,
  RunSpec as CoreRunSpec,
  SandboxPolicy,
} from '../core/types.js';
import {
  runJsonlCli,
  scrubEnvVars,
  launchDriverHandle,
  houseEventToCore,
  takeOnOutput,
  validateCliSessionProfile,
  type JsonlRunSpec,
  type SpawnFn,
} from './shared.ts';

/**
 * GitHub Copilot CLI (`copilot`, npm `@github/copilot`). Headless runs use
 * `copilot --prompt=<text> --output-format json --allow-all-tools`, which
 * writes one JSON event per line on stdout (observed with copilot 1.0.93,
 * fixtures tests/fixtures/copilot-*.jsonl).
 *
 * Billing: Copilot meters in AI credits ("AIU"), not tokens. Cost comes ONLY
 * from the CLI's own AIU telemetry (`totalNanoAiu` / `total_nano_aiu`, nano-AIU)
 * converted at 1 AIU = 1 AI credit = $0.01; when that telemetry is missing the
 * cost stays unavailable and is NEVER estimated from token math. See
 * docs/transcript-adapters.md (Copilot CLI row) for the telemetry locations.
 */
export const COPILOT_CAPABILITIES: AdapterCapabilities = {
  headless: true,
  streaming: true,
  resume: true,
  // `copilot --acp` exists, but this adapter drives the JSON output mode.
  acp: false,
  tmuxFallback: false,
};

// ---------------------------------------------------------------------------
// AIU arithmetic (pinned by tests/copilot.test.ts)
// ---------------------------------------------------------------------------

/** 1 AIU = 1 AI credit = US$0.01 (issue #23; GitHub Copilot billing unit). */
export const COPILOT_USD_PER_AIU = 0.01;
/** The CLI reports AIU in nano-units: 1e9 nano-AIU = 1 AIU. */
export const COPILOT_NANO_PER_AIU = 1_000_000_000;

/** nano-AIU -> AIU. */
export function nanoAiuToAiu(nanoAiu: number): number {
  return nanoAiu / COPILOT_NANO_PER_AIU;
}

/**
 * nano-AIU -> USD. Divides by 1e11 (= 1e9 nano per AIU / $0.01 per AIU, exact
 * in binary floating point) instead of multiplying AIU by 0.01, which would
 * round twice and drift in the last digit.
 */
export function nanoAiuToUsd(nanoAiu: number): number {
  return nanoAiu / (COPILOT_NANO_PER_AIU / COPILOT_USD_PER_AIU);
}

// ---------------------------------------------------------------------------
// Telemetry parsing
// ---------------------------------------------------------------------------

/** Copilot's state dir: `$COPILOT_HOME`, else `~/.copilot`. */
export function copilotHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.COPILOT_HOME;
  return home !== undefined && home !== '' ? home : join(homedir(), '.copilot');
}

/** `<copilot home>/session-state/<session id>/events.jsonl` (verified, copilot 1.0.93). */
export function copilotEventsPath(sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(copilotHome(env), 'session-state', sessionId, 'events.jsonl');
}

/** One model's usage inside a Copilot summary. Token counts: inputTokens INCLUDES cache reads/writes. */
export interface CopilotModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  requests: number | null;
  /** null when the CLI did not report AIU for this model. */
  nanoAiu: number | null;
}

/**
 * Cumulative per-session usage as the CLI summarizes it: the `--usage-output-file`
 * JSON and the `session.shutdown` event's `data` share this shape.
 */
export interface CopilotUsageSummary {
  /** null when the CLI did not report an AIU total. */
  totalNanoAiu: number | null;
  models: CopilotModelUsage[];
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `totalNanoAiu` (camelCase, summaries) or `total_nano_aiu` (snake_case, API payloads). */
function nanoAiuOf(o: unknown): number | null {
  if (!isRec(o)) return null;
  return num(o.totalNanoAiu) ?? num(o.total_nano_aiu);
}

/**
 * Parse a Copilot usage summary (usage-output-file JSON or `session.shutdown`
 * data). Null when the object has neither an AIU total nor per-model metrics.
 */
export function parseCopilotUsageSummary(raw: unknown): CopilotUsageSummary | null {
  if (!isRec(raw)) return null;
  const totalNanoAiu = nanoAiuOf(raw);
  const models: CopilotModelUsage[] = [];
  const metrics = raw.modelMetrics;
  if (isRec(metrics)) {
    for (const [model, m] of Object.entries(metrics)) {
      if (!isRec(m)) continue;
      const usage = isRec(m.usage) ? m.usage : {};
      const requests = isRec(m.requests) ? num(m.requests.count) : null;
      models.push({
        model,
        inputTokens: num(usage.inputTokens) ?? 0,
        outputTokens: num(usage.outputTokens) ?? 0,
        cacheReadTokens: num(usage.cacheReadTokens) ?? 0,
        cacheWriteTokens: num(usage.cacheWriteTokens) ?? 0,
        requests,
        nanoAiu: nanoAiuOf(m),
      });
    }
  }
  if (totalNanoAiu === null && models.length === 0) return null;
  return { totalNanoAiu, models };
}

/** Two summaries describe the same cumulative snapshot. */
export function sameCopilotSummary(a: CopilotUsageSummary, b: CopilotUsageSummary): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * This run's share of a CUMULATIVE summary: `final - baseline`. A resumed
 * session's usage file and `session.shutdown` carry the whole session so far
 * (observed copilot 1.0.93: a resume went 500 -> 1000 input tokens), so the
 * previous snapshot is subtracted. Negative differences clamp to 0.
 */
export function subtractCopilotSummary(final: CopilotUsageSummary, baseline: CopilotUsageSummary | null): CopilotUsageSummary {
  if (baseline === null) return final;
  const sub = (a: number | null, b: number | null): number | null => (a === null ? null : Math.max(0, a - (b ?? 0)));
  const prior = new Map(baseline.models.map((m) => [m.model, m]));
  return {
    totalNanoAiu: sub(final.totalNanoAiu, baseline.totalNanoAiu),
    models: final.models.map((m) => {
      const p = prior.get(m.model);
      return {
        model: m.model,
        inputTokens: Math.max(0, m.inputTokens - (p?.inputTokens ?? 0)),
        outputTokens: Math.max(0, m.outputTokens - (p?.outputTokens ?? 0)),
        cacheReadTokens: Math.max(0, m.cacheReadTokens - (p?.cacheReadTokens ?? 0)),
        cacheWriteTokens: Math.max(0, m.cacheWriteTokens - (p?.cacheWriteTokens ?? 0)),
        requests: m.requests === null ? null : Math.max(0, m.requests - (p?.requests ?? 0)),
        nanoAiu: sub(m.nanoAiu, p?.nanoAiu ?? null),
      };
    }),
  };
}

/** One `session.shutdown` event: its cumulative summary plus the event's ISO timestamp (null when absent). */
export interface CopilotShutdown {
  summary: CopilotUsageSummary;
  timestamp: string | null;
}

/** Every `session.shutdown` event in an events.jsonl text, oldest first. Bad lines are skipped. */
export function parseCopilotShutdownEvents(eventsJsonl: string, onBadLine?: (lineNo: number) => void): CopilotShutdown[] {
  const out: CopilotShutdown[] = [];
  eventsJsonl.split('\n').forEach((line, i) => {
    if (!line.includes('session.shutdown')) return;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      onBadLine?.(i + 1);
      return;
    }
    if (!isRec(rec) || rec.type !== 'session.shutdown') return;
    const s = parseCopilotUsageSummary(rec.data);
    if (s !== null) out.push({ summary: s, timestamp: typeof rec.timestamp === 'string' && rec.timestamp !== '' ? rec.timestamp : null });
  });
  return out;
}

/** Every `session.shutdown` summary in an events.jsonl text, oldest first. Bad lines are skipped. */
export function parseCopilotShutdowns(eventsJsonl: string): CopilotUsageSummary[] {
  return parseCopilotShutdownEvents(eventsJsonl).map((s) => s.summary);
}

/**
 * Per-call AIU carried inline on a stdout event. UNVERIFIED against a billed
 * run (copilot 1.0.93 under BYOK emits none): the shapes come from the
 * aws-samples/sample-agent-cost-bench reader, which sums `total_nano_aiu` from
 * `model.model_call_success` events at `data.copilotUsage` or
 * `data.responseChunk.copilot_usage`. Used only as a last-resort fallback when
 * no summary exists (e.g. the CLI was killed before writing one).
 */
export function inlineNanoAiu(evt: unknown): number | null {
  if (!isRec(evt) || evt.type !== 'model.model_call_success' || !isRec(evt.data)) return null;
  const d = evt.data;
  const direct = nanoAiuOf(d.copilotUsage) ?? nanoAiuOf(d.copilot_usage);
  if (direct !== null) return direct;
  if (isRec(d.responseChunk)) return nanoAiuOf(d.responseChunk.copilotUsage) ?? nanoAiuOf(d.responseChunk.copilot_usage);
  return nanoAiuOf(d);
}

/** How a run's AIU figure was obtained. */
export type CopilotUsageSource = 'events.jsonl' | 'usage-output-file' | 'stdout-inline';

/** House usage event plus the model that produced it (patched onto the core record). */
type CopilotUsageEvent = Extract<CanonicalEvent, { type: 'usage' }> & { model?: string };

export interface CopilotUsageResult {
  events: CanonicalEvent[];
  /** Operator-facing notes about missing / partial telemetry. */
  warnings: string[];
}

/**
 * Turn a run's usage summary into house usage events (one per model) plus
 * warnings.
 *
 * Honesty rule: a record's USD is the CLI-reported AIU converted at
 * $0.01/AIU, or absent. Every record is flagged `extra.vendorMetered` so the
 * pricer never falls back to token math for it (src/core/pricing.ts). A
 * reported AIU of exactly 0 is NOT forwarded as `$0`: under BYOK or an
 * unmetered model it means "not billed by Copilot", which is unknown cost,
 * never a free run.
 *
 * Tokens: Copilot's `inputTokens` includes cache reads and writes, while the
 * house `inputTokens` is the UNCACHED slice, so the cache slices are
 * subtracted. Reasoning tokens are already inside `outputTokens`.
 */
export function copilotUsageEvents(
  summary: CopilotUsageSummary | null,
  source: CopilotUsageSource | null,
  opts: { partial?: boolean } = {},
): CopilotUsageResult {
  const warnings: string[] = [];
  if (summary === null || source === null) {
    warnings.push(
      'copilot: no usage telemetry found (no --usage-output-file JSON, no session.shutdown in events.jsonl); tokens and cost unavailable (cost is never estimated from tokens)',
    );
    return { events: [], warnings };
  }
  const total = summary.totalNanoAiu;
  const metered = total !== null && total > 0;
  if (!metered) {
    warnings.push(
      total === null
        ? 'copilot: AIU telemetry (totalNanoAiu) missing; cost unavailable (never estimated from tokens)'
        : 'copilot: AIU telemetry reported 0 nano-AIU (BYOK or unmetered model); cost unavailable (never estimated from tokens)',
    );
  }
  if (opts.partial === true) {
    warnings.push('copilot: AIU taken from per-call stdout events only (no session summary); cost may be incomplete');
  }

  // Attribute the AIU to models. A model with its own figure keeps it; a lone
  // model with no figure of its own owns the total; whatever the model rows do
  // not cover becomes a model-less cost-only record, so the run total always
  // equals the CLI's total.
  const perModel = summary.models.map((m) => ({ ...m }));
  if (metered && perModel.length === 1 && perModel[0]!.nanoAiu === null) perModel[0]!.nanoAiu = total;
  const attributed = perModel.reduce((a, m) => a + (m.nanoAiu ?? 0), 0);
  const remainder = metered ? total - attributed : 0;

  const events: CanonicalEvent[] = [];
  let cumulativeAiu = 0;
  const push = (m: CopilotModelUsage | null, nano: number | null, tokensKnown: boolean): void => {
    const hasCost = metered && nano !== null && nano > 0;
    const aiu = hasCost ? nanoAiuToAiu(nano!) : undefined;
    if (aiu !== undefined) cumulativeAiu += aiu;
    const cacheSlice = (m?.cacheReadTokens ?? 0) + (m?.cacheWriteTokens ?? 0);
    const extra: Record<string, unknown> = {
      vendorMetered: true,
      costBasis: 'copilot-aiu',
      aiuSource: source,
      ...(tokensKnown ? {} : { tokensAvailable: false }),
      ...(hasCost
        ? { nanoAiu: nano, credits: aiu, creditUnit: 'copilot', creditsCumulative: cumulativeAiu, source: 'native' }
        : {}),
    };
    events.push({
      type: 'usage',
      tokens: {
        inputTokens: Math.max(0, (m?.inputTokens ?? 0) - cacheSlice),
        cacheReadTokens: m?.cacheReadTokens ?? 0,
        cacheWriteTokens: m?.cacheWriteTokens ?? 0,
        outputTokens: m?.outputTokens ?? 0,
        reasoningTokens: null,
        totalTokens: m ? m.inputTokens + m.outputTokens : null,
        durationMs: null,
        raw: m ?? { totalNanoAiu: total },
        extra,
      },
      ...(hasCost ? { cost: nanoAiuToUsd(nano!) } : {}),
      ...(m ? { model: m.model } : {}),
    } as CopilotUsageEvent);
  };

  for (const m of perModel) push(m, m.nanoAiu, true);
  // > 1 nano-AIU: float noise from summing per-model figures is not a charge.
  if (remainder > 1) push(null, remainder, false);
  return { events, warnings };
}

// ---------------------------------------------------------------------------
// Line parser (stdout JSONL)
// ---------------------------------------------------------------------------

export interface CopilotParserOptions {
  /** Session id known up front (we pass --session-id / --resume): announced on the first line. */
  sessionId?: string;
}

export interface CopilotLineParser {
  parseLine(line: string): CanonicalEvent[];
  /** Called once after the last stdout line: emits the usage events (file I/O via `readTelemetry`). */
  finish(): CanonicalEvent[];
  /** Session id as last announced (`result.sessionId` wins over the one we passed). */
  sessionId(): string | undefined;
}

export interface CopilotTelemetry {
  summary: CopilotUsageSummary | null;
  source: CopilotUsageSource | null;
}

/**
 * Stateful stdout parser. Mapping (copilot 1.0.93 `--output-format json`):
 * - `assistant.message` {content} -> assistant message; `toolRequests` are
 *   NOT emitted (the tool.* events below carry the same calls once);
 * - `tool.execution_start` / `tool.execution_complete` -> tool start / result;
 * - `model.call_start` .. `model.call_finished` -> model_call boundaries, the
 *   first `assistant.message_delta` / `assistant.tool_call_delta` in between
 *   is the first-output chunk step;
 * - `session.warning` -> progress; `result` {sessionId} -> session.
 * Usage is NOT read from the stream (it has none): `finish()` asks
 * `readTelemetry` for the run's summary and appends the usage events and any
 * missing-telemetry warning. Unrecognized event types are ignored.
 */
export function createCopilotLineParser(
  readTelemetry: (sessionId: string | undefined, inlineNanoAiu: number | null) => CopilotTelemetry,
  options: CopilotParserOptions = {},
): CopilotLineParser {
  let sessionId = options.sessionId;
  let announced = false;
  let calls = 0;
  let open: { id: string; model?: string; chunked: boolean } | null = null;
  let inlineSum: number | null = null;
  let worked = false;

  const announce = (): CanonicalEvent[] => {
    if (announced || sessionId === undefined) return [];
    announced = true;
    return [{ type: 'session', sessionId }];
  };

  const parseLine = (line: string): CanonicalEvent[] => {
    const evt = JSON.parse(line) as { type?: unknown; data?: Record<string, unknown>; sessionId?: unknown };
    const data = (evt.data ?? {}) as Record<string, unknown>;
    const out: CanonicalEvent[] = announce();
    switch (evt.type) {
      case 'model.call_start': {
        calls += 1;
        open = { id: `call-${calls}`, chunked: false, ...(typeof data.model === 'string' ? { model: data.model } : {}) };
        out.push({ type: 'model_call', phase: 'start', callId: open.id });
        break;
      }
      case 'assistant.message_delta':
      case 'assistant.tool_call_delta': {
        if (open !== null && !open.chunked) {
          open.chunked = true;
          out.push({ type: 'step', payload: { kind: 'chunk', source: evt.type } });
        }
        break;
      }
      case 'model.call_finished': {
        if (open !== null) {
          out.push({
            type: 'model_call',
            phase: 'end',
            callId: open.id,
            ...(open.model !== undefined ? { model: open.model } : {}),
          });
          open = null;
        }
        break;
      }
      case 'assistant.message': {
        worked = true;
        if (typeof data.content === 'string' && data.content.trim() !== '') {
          out.push({ type: 'message', role: 'assistant', text: data.content });
        }
        break;
      }
      case 'tool.execution_start': {
        worked = true;
        out.push({
          type: 'tool',
          toolName: typeof data.toolName === 'string' ? data.toolName : 'unknown_tool',
          phase: 'start',
          ...(typeof data.toolCallId === 'string' ? { toolCallId: data.toolCallId } : {}),
          input: data.arguments,
        });
        break;
      }
      case 'tool.execution_complete': {
        const result = isRec(data.result) ? data.result : undefined;
        const error = isRec(data.error) ? data.error : undefined;
        out.push({
          type: 'tool',
          toolName: typeof data.toolName === 'string' ? data.toolName : 'unknown_tool',
          phase: 'result',
          ...(typeof data.toolCallId === 'string' ? { toolCallId: data.toolCallId } : {}),
          output: result?.content ?? error?.message,
          status: data.success === false ? 'error' : 'success',
        });
        break;
      }
      case 'model.model_call_success': {
        const nano = inlineNanoAiu(evt);
        if (nano !== null) inlineSum = (inlineSum ?? 0) + nano;
        break;
      }
      case 'session.warning': {
        if (typeof data.message === 'string' && data.message !== '') {
          out.push({ type: 'progress', text: `copilot: ${data.message}` });
        }
        break;
      }
      case 'result': {
        if (typeof evt.sessionId === 'string' && evt.sessionId !== '') {
          if (evt.sessionId !== sessionId) {
            sessionId = evt.sessionId;
            announced = false;
          }
          out.push(...announce());
        }
        break;
      }
      default:
        break;
    }
    return out;
  };

  const finish = (): CanonicalEvent[] => {
    const { summary, source } = readTelemetry(sessionId, inlineSum);
    // An outage / auth failure never reaches the model: report nothing about
    // telemetry for a run that did no work (the specific error is the story).
    if (!worked && summary === null) return [];
    const { events, warnings } = copilotUsageEvents(summary, source, { partial: source === 'stdout-inline' });
    const notices: CanonicalEvent[] = warnings.map((warning) => ({
      type: 'step',
      payload: { kind: 'stderrNotice', warning, countsAsTurn: false },
    }));
    return [...events, ...notices];
  };

  return { parseLine, finish, sessionId: () => sessionId };
}

// ---------------------------------------------------------------------------
// Telemetry reader (file I/O)
// ---------------------------------------------------------------------------

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Find this run's usage: the `--usage-output-file` JSON (written by the CLI at
 * exit) first, else the session's own events.jsonl `session.shutdown`, else
 * the sum of inline per-call AIU. Both file sources are CUMULATIVE for the
 * session, so for a resume the previous snapshot in events.jsonl is
 * subtracted. Never throws.
 */
export function readCopilotTelemetry(opts: {
  usageFile?: string;
  sessionId: string | undefined;
  inlineNanoAiu: number | null;
  resumed: boolean;
  env?: NodeJS.ProcessEnv;
}): CopilotTelemetry {
  const eventsText = opts.sessionId !== undefined ? readText(copilotEventsPath(opts.sessionId, opts.env)) : null;
  const shutdowns = eventsText !== null ? parseCopilotShutdowns(eventsText) : [];
  let fileSummary: CopilotUsageSummary | null = null;
  if (opts.usageFile !== undefined) {
    const text = readText(opts.usageFile);
    if (text !== null) {
      try {
        fileSummary = parseCopilotUsageSummary(JSON.parse(text));
      } catch {
        fileSummary = null;
      }
    }
  }
  const final = fileSummary ?? shutdowns[shutdowns.length - 1] ?? null;
  const source: CopilotUsageSource = fileSummary !== null ? 'usage-output-file' : 'events.jsonl';
  if (final !== null) {
    let baseline: CopilotUsageSummary | null = null;
    if (opts.resumed && shutdowns.length > 0) {
      const last = shutdowns[shutdowns.length - 1]!;
      baseline = sameCopilotSummary(last, final) ? (shutdowns[shutdowns.length - 2] ?? null) : last;
    }
    return { summary: subtractCopilotSummary(final, baseline), source };
  }
  if (opts.inlineNanoAiu !== null) {
    return { summary: { totalNanoAiu: opts.inlineNanoAiu, models: [] }, source: 'stdout-inline' };
  }
  return { summary: null, source: null };
}

// ---------------------------------------------------------------------------
// Error classification (stderr)
// ---------------------------------------------------------------------------

/**
 * Specific, actionable messages for the two authentication failures observed
 * on copilot 1.0.93 (both exit 1 with an empty stdout):
 *  - "Error: No authentication information found."  (no token, no /login, no gh)
 *  - "Error: Access denied by policy settings"      (signed in, but the account
 *    has no Copilot entitlement or an org policy blocks it)
 * Null for any other stderr line.
 */
export function classifyCopilotStderr(line: string): string | null {
  if (/No authentication information found/i.test(line)) {
    return 'copilot: not authenticated. Run `copilot login`, set COPILOT_GITHUB_TOKEN (or GH_TOKEN / GITHUB_TOKEN), or run `gh auth login`.';
  }
  if (/Access denied by policy settings/i.test(line)) {
    return 'copilot: access denied by policy. The signed-in GitHub account has no Copilot access (no subscription, or an organization policy blocks it); see https://github.com/settings/copilot.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface CopilotAdapterOptions {
  /** Binary to invoke; defaults to $COPILOT_CLI_BIN, else `copilot` on PATH. */
  command?: string;
  /** Injectable spawn factory for tests. */
  spawnFn?: SpawnFn;
  /** Extra args inserted before the run flags are finalized. */
  extraArgs?: string[];
  /** Extra environment for every run's child (overlaid by the run's own env); also locates COPILOT_HOME for telemetry. */
  env?: Record<string, string>;
}

/** Copilot's `--mode` values (copilot --help). */
const COPILOT_MODES = new Set(['interactive', 'plan', 'autopilot']);

/**
 * SandboxPolicy -> copilot flags. allowedTools -> `--available-tools=<t>` and
 * disallowedTools -> `--excluded-tools=<t>` (both verified to change the tool
 * list sent to the model, copilot 1.0.93; `--allow-tool` only pre-approves and
 * did NOT restrict a headless run, so it is not used). permissionMode:
 * "dontAsk" (and unset) -> `--allow-all-tools`, which headless mode requires;
 * plan/autopilot/interactive -> `--mode`; mcpConfig -> `--additional-mcp-config`.
 * Pure; exported for tests.
 */
export function copilotSandboxArgs(sandbox: SandboxPolicy | undefined): string[] {
  const args: string[] = [];
  const mode = sandbox?.permissionMode;
  if (mode !== undefined && COPILOT_MODES.has(mode)) args.push(`--mode=${mode}`);
  // Headless runs cannot answer a permission prompt, so every mode except an
  // explicit plan/interactive mode runs with all tools pre-approved.
  if (mode === undefined || mode === 'dontAsk' || mode === 'ask' || mode === 'autopilot') args.push('--allow-all-tools');
  for (const t of sandbox?.allowedTools ?? []) args.push(`--available-tools=${t}`);
  for (const t of sandbox?.disallowedTools ?? []) args.push(`--excluded-tools=${t}`);
  if (sandbox?.mcpConfig !== undefined) {
    const v = typeof sandbox.mcpConfig === 'string' ? `@${sandbox.mcpConfig}` : JSON.stringify(sandbox.mcpConfig);
    args.push(`--additional-mcp-config=${v}`);
  }
  return args;
}

/** SandboxPolicy fields copilot cannot honour (see copilotSandboxArgs). */
export function copilotUnsupportedSandbox(sandbox: SandboxPolicy | undefined): AdapterProfileIssue[] {
  const mode = sandbox?.permissionMode;
  if (mode === undefined) return [];
  if (mode === 'ask') {
    return [{ field: 'sandbox.permissionMode', message: "copilot headless mode cannot prompt; 'ask' is treated as 'dontAsk' (--allow-all-tools)" }];
  }
  if (mode === 'dontAsk' || COPILOT_MODES.has(mode)) return [];
  return [{ field: 'sandbox.permissionMode', message: `copilot has no permission mode '${mode}' (expected dontAsk, interactive, plan or autopilot); not applied` }];
}

/**
 * argv for one headless run. The prompt rides `--prompt=<text>` so a leading
 * '-' is never parsed as a flag (verified). A new run pins its own session id
 * with `--session-id=<uuid>` (honoured by 1.0.93: the `result` event and the
 * session-state dir carry it), which is also how events.jsonl is located;
 * a resume uses `--resume=<id>`. Pure; exported for tests.
 */
export function copilotArgs(
  prompt: string,
  opts: { model?: string; resume?: string; sessionId?: string; usageFile?: string; sandbox?: SandboxPolicy; extraArgs?: string[] } = {},
): string[] {
  return [
    `--prompt=${prompt}`,
    '--output-format',
    'json',
    '--no-auto-update',
    ...(opts.model !== undefined ? ['--model', opts.model] : []),
    ...(opts.resume !== undefined ? [`--resume=${opts.resume}`] : opts.sessionId !== undefined ? [`--session-id=${opts.sessionId}`] : []),
    ...(opts.usageFile !== undefined ? ['--usage-output-file', opts.usageFile] : []),
    ...copilotSandboxArgs(opts.sandbox),
    ...(opts.extraArgs ?? []),
  ];
}

export class CopilotAdapter implements AgentAdapter, CoreAgentAdapter {
  readonly id = 'copilot';
  readonly name = 'copilot';
  readonly capabilities: AdapterCapabilities = COPILOT_CAPABILITIES;

  #command: string;
  #spawnFn: SpawnFn | undefined;
  #extraArgs: string[];
  #env: Record<string, string> | undefined;
  #current: RunHandle | null = null;

  constructor(options: CopilotAdapterOptions = {}) {
    this.#command = options.command ?? process.env.COPILOT_CLI_BIN ?? 'copilot';
    this.#spawnFn = options.spawnFn;
    this.#extraArgs = options.extraArgs ?? [];
    this.#env = options.env;
  }

  spawn(prompt: string, opts: RunOptions = {}): RunHandle {
    return this.#start(prompt, opts, opts.onOutput).handle;
  }

  resume(sessionId: string, prompt: string, opts: RunOptions = {}): RunHandle {
    return this.#start(prompt, { ...opts, resume: sessionId }, opts.onOutput).handle;
  }

  /**
   * Adapter-owned profile validation: the shared model/resume token checks plus
   * a warning per SandboxPolicy field copilot cannot honour.
   */
  validateProfile(spec: CoreRunSpec): AdapterProfileCheck {
    const common = validateCliSessionProfile(spec);
    return { ...common, warnings: [...common.warnings, ...copilotUnsupportedSandbox(spec.sandbox)] };
  }

  /** Driver contract (src/core/driver.ts): launch one run for a RunSpec. */
  async launch(spec: CoreRunSpec): Promise<CoreAgentHandle> {
    const { handle } = this.#start(
      spec.prompt,
      {
        ...(spec.model !== undefined ? { model: spec.model } : {}),
        ...(spec.resume !== undefined ? { resume: spec.resume } : {}),
        ...(spec.sandbox !== undefined ? { sandbox: spec.sandbox } : {}),
        ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
        ...(spec.env !== undefined ? { env: spec.env } : {}),
        extraArgs: spec.extraArgs ?? [],
      },
      takeOnOutput(spec),
    );
    return launchDriverHandle({
      agent: 'copilot',
      events: handle.events,
      mapEvent: (event) => {
        const core = houseEventToCore('copilot', event);
        // The bridge stamps model 'unknown'; copilot reports the model per
        // usage row, so the record carries it for stats attribution.
        const model = (event as { model?: unknown }).model;
        if (core?.type === 'usage' && core.usage && typeof model === 'string') {
          core.usage = { ...core.usage, model };
        }
        // Usage is read from the session summary after the CLI exits, so it
        // is final accounting: a usd cap can warn but has nothing left to abort.
        if (core?.type === 'usage') core.finalAccounting = true;
        return core;
      },
      exit: handle.wait(),
      abort: () => handle.abort(),
      fallbackSessionId: spec.resume,
    });
  }

  /** Kill the in-flight child (SIGTERM, SIGKILL after grace). */
  abort(): void {
    this.#current?.abort();
  }

  #start(
    prompt: string,
    opts: RunOptions & { resume?: string; extraArgs?: string[] },
    onOutput?: (chunk: string) => void,
  ): { handle: RunHandle } {
    const sessionId = opts.resume === undefined ? randomUUID() : undefined;
    // Per-run scratch dir for --usage-output-file; removed once read.
    let scratch: string | undefined;
    let usageFile: string | undefined;
    try {
      scratch = mkdtempSync(join(tmpdir(), 'ach-copilot-'));
      usageFile = join(scratch, 'usage.json');
    } catch {
      /* no tmpdir: events.jsonl is still read */
    }
    // The env the child will actually see (after scrubEnv), so telemetry is
    // read from the same COPILOT_HOME the CLI writes to.
    const childEnv = this.#env !== undefined || opts.env !== undefined ? { ...this.#env, ...opts.env } : undefined;
    const env = scrubEnvVars({ ...process.env, ...childEnv }, opts.sandbox?.scrubEnv);
    const spec: JsonlRunSpec = {
      command: this.#command,
      args: copilotArgs(prompt, {
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(opts.resume !== undefined ? { resume: opts.resume } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(usageFile !== undefined ? { usageFile } : {}),
        ...(opts.sandbox !== undefined ? { sandbox: opts.sandbox } : {}),
        extraArgs: [...this.#extraArgs, ...(opts.extraArgs ?? [])],
      }),
      cwd: opts.cwd,
      env: childEnv,
      scrubEnv: opts.sandbox?.scrubEnv,
    };
    const parser = createCopilotLineParser(
      (sid, inline) =>
        readCopilotTelemetry({
          ...(usageFile !== undefined ? { usageFile } : {}),
          sessionId: sid,
          inlineNanoAiu: inline,
          resumed: opts.resume !== undefined,
          env,
        }),
      { sessionId: sessionId ?? opts.resume },
    );
    const reported = new Set<string>();
    const handle = runJsonlCli({
      spec,
      parseLine: parser.parseLine,
      spawnFn: this.#spawnFn,
      onOutput,
      onStderrLine: (line) => {
        const message = classifyCopilotStderr(line);
        if (message === null || reported.has(message)) return;
        reported.add(message);
        return [{ type: 'error', message }];
      },
      onStdoutEnd: () => {
        try {
          return parser.finish();
        } finally {
          if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
        }
      },
    });
    this.#current = handle;
    void handle.wait().finally(() => {
      if (this.#current === handle) this.#current = null;
      // A run that never reached stdout end (spawn failure) still cleans up.
      if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    });
    return { handle };
  }
}
