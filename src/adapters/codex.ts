import { z } from 'zod';
import type { AdapterCapabilities, AgentAdapter, CanonicalEvent, RunHandle, RunOptions } from './types.ts';
import type {
  AdapterProfileCheck,
  AgentAdapter as CoreAgentAdapter,
  AgentHandle as CoreAgentHandle,
  RunSpec as CoreRunSpec,
} from '../core/types.js';
import { runJsonlCli, launchDriverHandle, houseEventToCore, takeOnOutput, validateCliSessionProfile, type JsonlRunSpec, type SpawnFn } from './shared.ts';

export const CODEX_CAPABILITIES: AdapterCapabilities = {
  headless: true,
  streaming: true,
  resume: true,
  acp: false,
  tmuxFallback: true,
};

// ---------------------------------------------------------------------------
// Native event schemas (codex exec --json emits one JSON object per line)
// ---------------------------------------------------------------------------

const codexUsageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative(),
    cached_input_tokens: z.number().int().nonnegative().nullish(),
    cache_write_input_tokens: z.number().int().nonnegative().nullish(),
    output_tokens: z.number().int().nonnegative(),
    reasoning_output_tokens: z.number().int().nonnegative().nullish(),
    total_tokens: z.number().int().nonnegative().nullish(),
  })
  .passthrough();

const codexItemSchema = z.object({
  id: z.string().optional(),
  // codex has used both spellings for the item kind across versions; accept
  // either and resolve with itemTypeKind() below.
  item_type: z.string().optional(),
  type: z.string().optional(),
  text: z.string().optional(),
  command: z.string().optional(),
  aggregated_output: z.string().nullish(),
  exit_code: z.number().nullish(),
  status: z.string().optional(),
  server: z.string().optional(),
  tool: z.string().optional(),
  arguments: z.unknown().optional(),
  result: z.unknown().optional(),
  query: z.string().optional(),
}).passthrough();

function itemTypeKind(item: z.infer<typeof codexItemSchema>): string {
  return item.item_type ?? item.type ?? '';
}

export const codexEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('thread.started'), thread_id: z.string() }).passthrough(),
  z.object({ type: z.literal('turn.started') }).passthrough(),
  z.object({ type: z.literal('turn.completed'), usage: codexUsageSchema }).passthrough(),
  z.object({ type: z.literal('turn.failed'), error: z.unknown().optional() }).passthrough(),
  z.object({ type: z.literal('item.started'), item: codexItemSchema }).passthrough(),
  z.object({ type: z.literal('item.updated'), item: codexItemSchema }).passthrough(),
  z.object({ type: z.literal('item.completed'), item: codexItemSchema }).passthrough(),
  z.object({ type: z.literal('error'), message: z.string().optional() }).passthrough(),
]);

export type CodexEvent = z.infer<typeof codexEventSchema>;

const TOOL_ITEM_TYPES = new Set([
  'command_execution',
  'mcp_tool_call',
  'web_search',
  'tool_call',
  'todo_list',
  'file_change',
]);

function codexToolStatus(status: string | undefined, exitCode: number | null | undefined): 'success' | 'error' | undefined {
  if (exitCode !== null && exitCode !== undefined) return exitCode === 0 ? 'success' : 'error';
  if (status === 'completed' || status === 'success') return 'success';
  if (status === 'failed' || status === 'error') return 'error';
  return undefined;
}

/**
 * Map one native codex JSONL line to zero or more canonical events.
 * Malformed JSON propagates (the run loop surfaces it); lines whose shape the
 * schema does not recognize are ignored for forward compatibility.
 */
export function parseCodexLine(line: string): CanonicalEvent[] {
  const parsed = codexEventSchema.safeParse(JSON.parse(line));
  if (!parsed.success) return [];
  const evt: CodexEvent = parsed.data;
  switch (evt.type) {
    case 'thread.started':
      return [{ type: 'session', sessionId: evt.thread_id }];
    case 'item.started':
    case 'item.updated':
    case 'item.completed': {
      const item = evt.item;
      const kind = itemTypeKind(item);
      const phase = evt.type === 'item.started' ? 'start' : 'result';
      if (kind === 'agent_message' || kind === 'user_message') {
        if (phase === 'start' || item.text === undefined) return [];
        return [{ type: 'message', role: kind === 'agent_message' ? 'assistant' : 'user', text: item.text }];
      }
      if (kind === 'reasoning') {
        if (phase === 'start' || item.text === undefined) return [];
        return [{ type: 'message', role: 'assistant', text: item.text, reasoning: true }];
      }
      if (TOOL_ITEM_TYPES.has(kind)) {
        const toolName =
          item.tool ?? (kind === 'web_search' ? 'web_search' : kind === 'command_execution' ? 'shell' : kind);
        const events: CanonicalEvent[] = [];
        if (evt.type === 'item.started') {
          events.push({
            type: 'tool',
            toolName,
            phase: 'start',
            toolCallId: item.id,
            input: item.arguments ?? item.query ?? item.command,
          });
        } else {
          events.push({
            type: 'tool',
            toolName,
            phase: 'result',
            toolCallId: item.id,
            input: item.arguments ?? item.query ?? item.command,
            output: item.result ?? item.aggregated_output ?? item.text,
            status: codexToolStatus(item.status, item.exit_code),
          });
        }
        return events;
      }
      return [];
    }
    case 'turn.completed': {
      const u = evt.usage;
      // Codex taxonomy: input_tokens is the TOTAL prompt and includes the
      // cached_input_tokens slice (OpenAI accounting — see normalizeCodex).
      // Canonical inputTokens is uncached-only, so subtract the cache read.
      return [
        {
          type: 'usage',
          tokens: {
            inputTokens: Math.max(0, u.input_tokens - (u.cached_input_tokens ?? 0)),
            cacheReadTokens: u.cached_input_tokens ?? 0,
            cacheWriteTokens: u.cache_write_input_tokens ?? 0,
            outputTokens: u.output_tokens,
            reasoningTokens: u.reasoning_output_tokens ?? null,
            totalTokens: u.total_tokens ?? null,
            durationMs: null,
            raw: u,
          },
        },
      ];
    }
    case 'turn.failed': {
      const err = evt.error;
      const message =
        typeof err === 'string'
          ? err
          : err && typeof err === 'object' && 'message' in err
            ? String((err as { message: unknown }).message)
            : 'codex turn failed';
      return [{ type: 'error', message }];
    }
    case 'error':
      return [{ type: 'error', message: evt.message ?? 'codex reported an error' }];
    case 'turn.started':
      return [];
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface CodexAdapterOptions {
  /** Binary to invoke; defaults to `codex` on PATH. */
  command?: string;
  /** Injectable spawn factory for tests. */
  spawnFn?: SpawnFn;
  /** Escape hatch if a future codex renames the json subcommand flags. */
  extraArgs?: string[];
}

export class CodexAdapter implements AgentAdapter, CoreAgentAdapter {
  readonly id = 'codex';
  readonly name = 'codex';
  readonly capabilities: AdapterCapabilities = CODEX_CAPABILITIES;

  #command: string;
  #spawnFn: SpawnFn | undefined;
  #extraArgs: string[];
  #current: RunHandle | null = null;

  constructor(options: CodexAdapterOptions = {}) {
    this.#command = options.command ?? 'codex';
    this.#spawnFn = options.spawnFn;
    this.#extraArgs = options.extraArgs ?? [];
  }

  spawn(prompt: string, opts: RunOptions = {}): RunHandle {
    const modelArgs = opts.model !== undefined ? ['-m', opts.model] : [];
    const spec: JsonlRunSpec = {
      command: this.#command,
      args: ['exec', '--json', ...modelArgs, ...this.#extraArgs, prompt],
      cwd: opts.cwd,
      env: opts.env,
    };
    return this.#run(spec, opts.onOutput);
  }

  resume(sessionId: string, prompt: string, opts: RunOptions = {}): RunHandle {
    const spec: JsonlRunSpec = {
      command: this.#command,
      args: ['exec', 'resume', sessionId, '--json', ...this.#extraArgs, prompt],
      cwd: opts.cwd,
      env: opts.env,
    };
    return this.#run(spec, opts.onOutput);
  }

  /**
   * Adapter-owned profile validation (issue #9): the shared model/resume
   * surface (`-m <model>`, `exec resume <sessionId>` positional) must be sane
   * CLI tokens.
   */
  validateProfile(spec: CoreRunSpec): AdapterProfileCheck {
    return validateCliSessionProfile(spec);
  }

  /** Driver contract (src/core/driver.ts): launch one run for a RunSpec. */
  async launch(spec: CoreRunSpec): Promise<CoreAgentHandle> {
    const modelArgs = spec.model !== undefined ? ['-m', spec.model] : [];
    const extra = [...this.#extraArgs, ...(spec.extraArgs ?? [])];
    const jsonlSpec: JsonlRunSpec = {
      command: this.#command,
      args: spec.resume
        ? ['exec', 'resume', spec.resume, '--json', ...modelArgs, ...extra, spec.prompt]
        : ['exec', '--json', ...modelArgs, ...extra, spec.prompt],
      cwd: spec.cwd,
      env: spec.env,
    };
    const handle = this.#run(jsonlSpec, takeOnOutput(spec));
    return launchDriverHandle({
      agent: 'codex',
      events: handle.events,
      mapEvent: (event) => houseEventToCore('codex', event),
      exit: handle.wait(),
      abort: () => handle.abort(),
      fallbackSessionId: spec.resume,
    });
  }

  /** Kill the in-flight child (SIGTERM, SIGKILL after grace). */
  abort(): void {
    this.#current?.abort();
  }

  #run(spec: JsonlRunSpec, onOutput?: (chunk: string) => void): RunHandle {
    const handle = runJsonlCli({ spec, parseLine: parseCodexLine, spawnFn: this.#spawnFn, onOutput });
    this.#current = handle;
    void handle.wait().finally(() => {
      if (this.#current === handle) this.#current = null;
    });
    return handle;
  }
}
