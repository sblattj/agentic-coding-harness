import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { isPrimeSessionFile } from '../monitors/prime.ts';
import type { AdapterCapabilities, AgentAdapter, CanonicalEvent, RunHandle, RunOptions } from './types.ts';
import type {
  AdapterProfileCheck,
  AdapterProfileIssue,
  AgentAdapter as CoreAgentAdapter,
  AgentHandle as CoreAgentHandle,
  RunSpec as CoreRunSpec,
  SandboxPolicy,
} from '../core/types.js';
import { runJsonlCli, launchDriverHandle, houseEventToCore, takeOnOutput, validateCliSessionProfile, type JsonlRunSpec, type SpawnFn } from './shared.ts';

/**
 * Prime Intellect's Prime Agent (`prime-agent`, a pi-mono–style agent).
 * Headless runs use `prime-agent -p --mode json`, which writes one JSON event
 * per line on stdout (observed with prime-agent 0.9.8; fixture
 * tests/fixtures/prime-session.ndjson). Sessions resume with `-r <id>`.
 */
export const PRIME_CAPABILITIES: AdapterCapabilities = {
  headless: true,
  streaming: true,
  resume: true,
  // prime-agent has an `--mode acp`, but this adapter drives the JSON mode.
  acp: false,
  tmuxFallback: true,
};

// ---------------------------------------------------------------------------
// Native event schemas (prime-agent -p --mode json)
// ---------------------------------------------------------------------------

/**
 * pi-style usage block on an assistant message:
 * {input, output, cacheRead, cacheWrite, totalTokens, cost:{…, total}}.
 *
 * Taxonomy (pi-ai convention): `input` is the UNCACHED prompt slice and
 * cacheRead/cacheWrite are reported separately (totalTokens = input + output
 * + cacheRead + cacheWrite), so `input` maps straight to canonical
 * inputTokens with no subtraction. The 0.9.8 fixture only shows cacheRead 0,
 * so this is the pi convention, not something the fixture can prove.
 */
export const primeUsageSchema = z
  .object({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cacheRead: z.number().nonnegative(),
    cacheWrite: z.number().nonnegative(),
    totalTokens: z.number().nonnegative().nullish(),
    cost: z.object({ total: z.number().nullish() }).passthrough().nullish(),
  })
  .passthrough();

export type PrimeUsage = z.infer<typeof primeUsageSchema>;

const contentItemSchema = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    thinking: z.string().optional(),
  })
  .passthrough();

const messageSchema = z
  .object({
    role: z.string(),
    content: z.union([z.string(), z.array(contentItemSchema)]).optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    responseModel: z.string().optional(),
    usage: z.unknown().optional(),
    stopReason: z.string().optional(),
    errorMessage: z.string().optional(),
  })
  .passthrough();

export const primeEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session'), id: z.string() }).passthrough(),
  z.object({ type: z.literal('turn_start') }).passthrough(),
  z.object({ type: z.literal('message_start'), message: messageSchema }).passthrough(),
  z.object({ type: z.literal('message_update'), message: messageSchema }).passthrough(),
  z.object({ type: z.literal('message_end'), message: messageSchema }).passthrough(),
  z
    .object({
      type: z.literal('tool_execution_start'),
      toolCallId: z.string().optional(),
      toolName: z.string().optional(),
      args: z.unknown().optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('tool_execution_end'),
      toolCallId: z.string().optional(),
      toolName: z.string().optional(),
      result: z.unknown().optional(),
      isError: z.boolean().optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('auto_retry_start'),
      attempt: z.number().optional(),
      maxAttempts: z.number().optional(),
      errorMessage: z.string().optional(),
    })
    .passthrough(),
]);

export type PrimeEvent = z.infer<typeof primeEventSchema>;

/** House usage event plus the model that produced it (patched onto the core record). */
type PrimeUsageEvent = Extract<CanonicalEvent, { type: 'usage' }> & { model?: string };

/**
 * One assistant message usage block → a house usage event. Null for an
 * all-zero block (message_start placeholders, a stream aborted before the
 * provider reported usage): zeros are never fabricated into a record.
 *
 * Cost: `usage.cost.total` is computed by prime-agent from the model's
 * configured per-token prices; a custom provider whose models.json entry has
 * no `cost` (the common case for local gateways) reports 0. A 0 is therefore
 * indistinguishable from "unpriced", so only a POSITIVE total is forwarded as
 * a provider-reported cost; otherwise cost stays unavailable and the pricer
 * decides (unknown model → n/a, never a fabricated $0).
 */
export function primeUsageEvent(
  usage: unknown,
  meta: { model?: string; provider?: string; responseModel?: string } = {},
): PrimeUsageEvent | null {
  const parsed = primeUsageSchema.safeParse(usage);
  if (!parsed.success) return null;
  const u = parsed.data;
  if (u.input === 0 && u.output === 0 && u.cacheRead === 0 && u.cacheWrite === 0) return null;
  const total = u.cost?.total;
  const extra: Record<string, unknown> = {};
  if (meta.provider !== undefined) extra.provider = meta.provider;
  if (meta.responseModel !== undefined) extra.responseModel = meta.responseModel;
  return {
    type: 'usage',
    tokens: {
      inputTokens: u.input,
      cacheReadTokens: u.cacheRead,
      cacheWriteTokens: u.cacheWrite,
      outputTokens: u.output,
      reasoningTokens: null,
      totalTokens: u.totalTokens ?? null,
      durationMs: null,
      raw: u,
      ...(Object.keys(extra).length > 0 ? { extra } : {}),
    },
    ...(typeof total === 'number' && Number.isFinite(total) && total > 0 ? { cost: total } : {}),
    ...(meta.model !== undefined ? { model: meta.model } : {}),
  } as PrimeUsageEvent;
}

function contentText(content: unknown, kind: 'text' | 'thinking'): string {
  if (typeof content === 'string') return kind === 'text' ? content : '';
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => {
      if (!c || typeof c !== 'object') return '';
      const item = c as { type?: unknown; text?: unknown; thinking?: unknown };
      if (kind === 'text' && item.type === 'text' && typeof item.text === 'string') return item.text;
      if (kind === 'thinking' && item.type === 'thinking' && typeof item.thinking === 'string') return item.thinking;
      return '';
    })
    .join('');
}

/**
 * Map one prime-agent JSON line to zero or more canonical events. Stateless.
 *
 * Accounting (no double counting): ONLY `message_end` of an `assistant`
 * message yields usage. `message_start` carries an all-zero placeholder,
 * `message_update` repeats the partial message, `turn_end.message` repeats the
 * finished assistant message, and `agent_end.messages` repeats the whole
 * conversation — all of those are ignored. `custom` (harness_digest) and
 * `toolResult` messages carry no usage; tool calls come only from
 * tool_execution_start / tool_execution_end.
 *
 * Subagents (rlm.spawn): a child's usage is written to the PARENT's session
 * file as `child_usage_attributed`, but the `--mode json` stream does not
 * carry that event (prime-agent 0.9.8: a spawn run streamed 34
 * `rlm_child_update` lines and zero `child_usage_attributed`). The stream's
 * `rlm_child_update.child.tokenCount` is a progressive snapshot without an
 * input/output split, so it is NOT summed. Child tokens are instead read from
 * the children's own session files once the run ends (withPrimeChildUsage).
 *
 * Malformed JSON propagates (the run loop surfaces it); unrecognized lines
 * are ignored for forward compatibility.
 */
export function parsePrimeLine(line: string): CanonicalEvent[] {
  const parsed = primeEventSchema.safeParse(JSON.parse(line));
  if (!parsed.success) return [];
  const evt: PrimeEvent = parsed.data;
  switch (evt.type) {
    case 'session':
      return [{ type: 'session', sessionId: evt.id }];
    case 'message_end': {
      const m = evt.message;
      if (m.role !== 'assistant') return [];
      const events: CanonicalEvent[] = [];
      const thinking = contentText(m.content, 'thinking');
      if (thinking.trim() !== '') events.push({ type: 'message', role: 'assistant', text: thinking, reasoning: true });
      const text = contentText(m.content, 'text');
      if (text.trim() !== '') events.push({ type: 'message', role: 'assistant', text });
      const usage = primeUsageEvent(m.usage, {
        ...(m.model !== undefined ? { model: m.model } : {}),
        ...(m.provider !== undefined ? { provider: m.provider } : {}),
        ...(m.responseModel !== undefined ? { responseModel: m.responseModel } : {}),
      });
      if (usage) events.push(usage);
      if (m.stopReason === 'error') {
        events.push({ type: 'error', message: m.errorMessage ?? 'prime-agent model call failed' });
      }
      return events;
    }
    case 'tool_execution_start':
      return [
        {
          type: 'tool',
          toolName: evt.toolName ?? 'unknown_tool',
          phase: 'start',
          ...(evt.toolCallId !== undefined ? { toolCallId: evt.toolCallId } : {}),
          input: evt.args,
        },
      ];
    case 'tool_execution_end':
      return [
        {
          type: 'tool',
          toolName: evt.toolName ?? 'unknown_tool',
          phase: 'result',
          ...(evt.toolCallId !== undefined ? { toolCallId: evt.toolCallId } : {}),
          output: evt.result,
          status: evt.isError === true ? 'error' : 'success',
        },
      ];
    case 'auto_retry_start':
      return [
        {
          type: 'progress',
          text: `prime-agent: retrying model call (attempt ${evt.attempt ?? '?'}/${evt.maxAttempts ?? '?'})${evt.errorMessage ? `: ${evt.errorMessage}` : ''}`,
        },
      ];
    case 'turn_start':
    case 'message_start':
    case 'message_update':
      return [];
  }
}

/**
 * Stateful line parser for driver runs: parsePrimeLine plus model-call
 * boundaries (#32). A prime turn is exactly one model request followed by its
 * tool executions, so:
 * - start = turn_start (the request is about to be sent);
 * - first output = a `step` {kind:'chunk'} at the first assistant
 *   message_start / message_update of the call (the first streamed delta;
 *   the full text is only emitted once, at message_end);
 * - end = the assistant message_end, carrying that call's own output tokens
 *   (per-call usage is exact here, so throughput is measurable).
 * An assistant message with no open call (defensive) opens one at its own
 * message_start. A message_end is accounted once even if the CLI repeats it
 * (keyed by responseId, else timestamp).
 */
export function createPrimeLineParser(): (line: string) => CanonicalEvent[] {
  let calls = 0;
  let open: { id: string; chunked: boolean } | null = null;
  const seen = new Set<string>();
  const openCall = (): CanonicalEvent => {
    calls += 1;
    open = { id: `call-${calls}`, chunked: false };
    return { type: 'model_call', phase: 'start', callId: open.id };
  };
  return (line: string): CanonicalEvent[] => {
    const raw = JSON.parse(line) as {
      type?: unknown;
      message?: { role?: unknown; model?: unknown; responseId?: unknown; timestamp?: unknown; usage?: { output?: unknown } };
    };
    const events = parsePrimeLine(line);
    const role = raw.message?.role;
    const model = typeof raw.message?.model === 'string' ? raw.message.model : undefined;
    if (raw.type === 'turn_start') {
      return [openCall(), ...events];
    }
    if ((raw.type === 'message_start' || raw.type === 'message_update') && role === 'assistant') {
      const out: CanonicalEvent[] = [];
      if (open === null) out.push(openCall());
      const call = open!;
      if (!call.chunked) {
        call.chunked = true;
        out.push({ type: 'step', payload: { kind: 'chunk', source: raw.type } });
      }
      return [...out, ...events];
    }
    if (raw.type === 'message_end' && role === 'assistant') {
      const key =
        typeof raw.message?.responseId === 'string'
          ? `r:${raw.message.responseId}`
          : typeof raw.message?.timestamp === 'number'
            ? `t:${raw.message.timestamp}`
            : undefined;
      if (key !== undefined) {
        if (seen.has(key)) return [];
        seen.add(key);
      }
      if (open === null) return events;
      const call = open as { id: string; chunked: boolean };
      open = null;
      const output = raw.message?.usage?.output;
      const end: CanonicalEvent = {
        type: 'model_call',
        phase: 'end',
        callId: call.id,
        ...(model !== undefined ? { model } : {}),
        ...(typeof output === 'number' && output > 0 ? { outputTokens: output } : {}),
      };
      return [...events, end];
    }
    return events;
  };
}

/** prime-agent's state dir (sessions/, session-artifacts/). */
export const PRIME_AGENT_DIR = join(homedir(), '.prime', 'agent');

/**
 * Usage events for every subagent session spawned under one root session:
 * child transcripts live at `<agentDir>/session-artifacts/<sid>/…/sub-<hex>/<uuid>.jsonl`
 * (grandchildren nest one `session-artifacts/<child>/` deeper, so the walk is
 * recursive). Counted from the child files, never from the parent's
 * `child_usage_attributed` summary, matching src/monitors/prime.ts. Unreadable
 * files and bad lines are skipped: metering must never fail a run.
 */
export function primeChildUsageEvents(agentDir: string, sessionId: string): CanonicalEvent[] {
  const root = join(agentDir, 'session-artifacts', sessionId);
  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && isPrimeSessionFile(p)) files.push(p);
    }
  };
  walk(root);
  const events: CanonicalEvent[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let rec: { type?: unknown; message?: { role?: unknown; usage?: unknown; model?: unknown; provider?: unknown; responseModel?: unknown } };
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const m = rec.message;
      if (rec.type !== 'message' || !m || m.role !== 'assistant') continue;
      const usage = primeUsageEvent(m.usage, {
        ...(typeof m.model === 'string' ? { model: m.model } : {}),
        ...(typeof m.provider === 'string' ? { provider: m.provider } : {}),
        ...(typeof m.responseModel === 'string' ? { responseModel: m.responseModel } : {}),
      });
      if (usage) events.push(usage);
    }
  }
  return events;
}

/**
 * Wrap a line parser so the run's subagent usage is appended at `agent_end`
 * (the stream's last line; the parent has collected its children by then).
 * A child still running when the parent ends is not counted.
 */
export function withPrimeChildUsage(
  parse: (line: string) => CanonicalEvent[],
  agentDir: string = PRIME_AGENT_DIR,
): (line: string) => CanonicalEvent[] {
  let sessionId: string | null = null;
  let done = false;
  return (line: string): CanonicalEvent[] => {
    const events = parse(line);
    for (const e of events) if (e.type === 'session' && sessionId === null) sessionId = e.sessionId;
    if (done || sessionId === null || (JSON.parse(line) as { type?: unknown }).type !== 'agent_end') return events;
    done = true;
    return [...events, ...primeChildUsageEvents(agentDir, sessionId)];
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface PrimeAdapterOptions {
  /** Binary to invoke; defaults to `prime-agent` on PATH. */
  command?: string;
  /** Injectable spawn factory for tests. */
  spawnFn?: SpawnFn;
  /** Extra args inserted before the `--` prompt separator. */
  extraArgs?: string[];
  /** prime-agent state dir, read for subagent usage; defaults to ~/.prime/agent. */
  agentDir?: string;
}

/**
 * SandboxPolicy → prime-agent flags (issue #8): allowedTools →
 * `-t <csv>` (prime's tool allowlist). prime-agent has no tool denylist,
 * permission-mode or MCP-config flag, so disallowedTools / permissionMode /
 * mcpConfig are not mapped — validateProfile reports each one as a warning
 * the driver surfaces on the run, never a silent drop. Pure; exported for
 * tests.
 */
export function primeSandboxArgs(sandbox: SandboxPolicy): string[] {
  return sandbox.allowedTools?.length ? ['-t', sandbox.allowedTools.join(',')] : [];
}

/** SandboxPolicy fields prime-agent cannot honour (see primeSandboxArgs). */
export function primeUnsupportedSandbox(sandbox: SandboxPolicy | undefined): AdapterProfileIssue[] {
  if (!sandbox) return [];
  const issues: AdapterProfileIssue[] = [];
  if (sandbox.disallowedTools?.length) {
    issues.push({ field: 'sandbox.disallowedTools', message: 'prime-agent has no tool denylist flag; not applied (use allowedTools → -t)' });
  }
  if (sandbox.permissionMode !== undefined) {
    issues.push({ field: 'sandbox.permissionMode', message: 'prime-agent has no permission-mode flag; not applied' });
  }
  if (sandbox.mcpConfig !== undefined) {
    issues.push({ field: 'sandbox.mcpConfig', message: 'prime-agent has no MCP-config flag (servers live in ~/.prime/agent/settings.json); not applied' });
  }
  return issues;
}

/**
 * argv for one headless run. `--model` passes through verbatim: prime-agent
 * resolves a `provider/model` id itself (`--model ferry/flash` with no
 * `--provider` ran against that provider, prime-agent 0.9.8), so the harness
 * never splits it. The prompt follows `--` so a leading '-' is never parsed
 * as a flag. Pure; exported for tests.
 */
export function primeArgs(
  prompt: string,
  opts: { model?: string; resume?: string; sandbox?: SandboxPolicy; extraArgs?: string[] } = {},
): string[] {
  return [
    '-p',
    '--mode',
    'json',
    ...(opts.model !== undefined ? ['--model', opts.model] : []),
    ...(opts.resume !== undefined ? ['-r', opts.resume] : []),
    ...(opts.sandbox ? primeSandboxArgs(opts.sandbox) : []),
    ...(opts.extraArgs ?? []),
    '--',
    prompt,
  ];
}

export class PrimeAdapter implements AgentAdapter, CoreAgentAdapter {
  readonly id = 'prime';
  readonly name = 'prime';
  readonly capabilities: AdapterCapabilities = PRIME_CAPABILITIES;

  #command: string;
  #spawnFn: SpawnFn | undefined;
  #extraArgs: string[];
  #agentDir: string;
  #current: RunHandle | null = null;

  constructor(options: PrimeAdapterOptions = {}) {
    this.#command = options.command ?? 'prime-agent';
    this.#spawnFn = options.spawnFn;
    this.#extraArgs = options.extraArgs ?? [];
    this.#agentDir = options.agentDir ?? PRIME_AGENT_DIR;
  }

  spawn(prompt: string, opts: RunOptions = {}): RunHandle {
    return this.#run(this.#spec(prompt, opts), opts.onOutput);
  }

  resume(sessionId: string, prompt: string, opts: RunOptions = {}): RunHandle {
    return this.#run(this.#spec(prompt, { ...opts, resume: sessionId }), opts.onOutput);
  }

  /**
   * Adapter-owned profile validation (issue #9): the shared model/resume
   * token checks, plus a warning per SandboxPolicy field prime-agent has no
   * flag for.
   */
  validateProfile(spec: CoreRunSpec): AdapterProfileCheck {
    const common = validateCliSessionProfile(spec);
    return { ...common, warnings: [...common.warnings, ...primeUnsupportedSandbox(spec.sandbox)] };
  }

  /** Driver contract (src/core/driver.ts): launch one run for a RunSpec. */
  async launch(spec: CoreRunSpec): Promise<CoreAgentHandle> {
    const jsonlSpec = this.#spec(spec.prompt, {
      ...(spec.model !== undefined ? { model: spec.model } : {}),
      ...(spec.resume !== undefined ? { resume: spec.resume } : {}),
      ...(spec.sandbox !== undefined ? { sandbox: spec.sandbox } : {}),
      ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
      ...(spec.env !== undefined ? { env: spec.env } : {}),
      extraArgs: spec.extraArgs ?? [],
    });
    const handle = this.#run(jsonlSpec, takeOnOutput(spec), createPrimeLineParser());
    return launchDriverHandle({
      agent: 'prime',
      events: handle.events,
      mapEvent: (event) => {
        const core = houseEventToCore('prime', event);
        // The bridge stamps model 'unknown'; prime reports the model per
        // message, so the usage record carries it for pricing.
        const model = (event as { model?: unknown }).model;
        if (core?.type === 'usage' && core.usage && typeof model === 'string') {
          core.usage = { ...core.usage, model };
        }
        return core;
      },
      exit: handle.wait(),
      abort: () => handle.abort(),
      fallbackSessionId: spec.resume,
    });
  }

  /**
   * Kill the in-flight child (SIGTERM, SIGKILL after grace). `prime-agent -p`
   * spawns no children of its own: its python kernel belongs to a long-lived
   * `prime-agent --mode daemon` worker in a separate process group, and a
   * SIGTERM'd run left no extra kernel behind (prime-agent 0.9.8), so a
   * plain child kill is enough.
   */
  abort(): void {
    this.#current?.abort();
  }

  #spec(
    prompt: string,
    opts: RunOptions & { resume?: string; extraArgs?: string[] },
  ): JsonlRunSpec {
    return {
      command: this.#command,
      args: primeArgs(prompt, {
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(opts.resume !== undefined ? { resume: opts.resume } : {}),
        ...(opts.sandbox !== undefined ? { sandbox: opts.sandbox } : {}),
        extraArgs: [...this.#extraArgs, ...(opts.extraArgs ?? [])],
      }),
      cwd: opts.cwd,
      env: opts.env,
      scrubEnv: opts.sandbox?.scrubEnv,
    };
  }

  #run(
    spec: JsonlRunSpec,
    onOutput?: (chunk: string) => void,
    parseLine: (line: string) => CanonicalEvent[] = parsePrimeLine,
  ): RunHandle {
    const handle = runJsonlCli({ spec, parseLine: withPrimeChildUsage(parseLine, this.#agentDir), spawnFn: this.#spawnFn, onOutput });
    this.#current = handle;
    void handle.wait().finally(() => {
      if (this.#current === handle) this.#current = null;
    });
    return handle;
  }
}
