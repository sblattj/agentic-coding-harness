import { z } from 'zod';
import type { AdapterCapabilities, AgentAdapter, CanonicalEvent, RunHandle, RunOptions } from './types.ts';
import type {
  AdapterProfileCheck,
  AgentAdapter as CoreAgentAdapter,
  AgentHandle as CoreAgentHandle,
  RunSpec as CoreRunSpec,
} from '../core/types.js';
import { runJsonlCli, launchDriverHandle, houseEventToCore, takeOnOutput, validateCliSessionProfile, type JsonlRunSpec, type SpawnFn } from './shared.ts';

export const GEMINI_CAPABILITIES: AdapterCapabilities = {
  headless: true,
  streaming: true,
  resume: true,
  acp: true,
  tmuxFallback: true,
};

// ---------------------------------------------------------------------------
// Native event schemas (gemini --output-format stream-json emits JSONL)
// ---------------------------------------------------------------------------

export const geminiStatsSchema = z
  .object({
    total_tokens: z.number().int().nonnegative().nullish(),
    input_tokens: z.number().int().nonnegative().nullish(),
    output_tokens: z.number().int().nonnegative().nullish(),
    /** Prompt tokens served from cache. */
    cached: z.number().int().nonnegative().nullish(),
    /** Uncached prompt tokens: gemini taxonomy input = prompt − cached. */
    input: z.number().int().nonnegative().nullish(),
    /** Reasoning/thinking tokens, when the CLI reports them. */
    thoughts: z.number().int().nonnegative().nullish(),
    duration_ms: z.number().int().nonnegative().nullish(),
  })
  .passthrough();

export const geminiEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('init'),
      session_id: z.string().nullish(),
      model: z.string().nullish(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('message'),
      role: z.string().nullish(),
      content: z.union([z.string(), z.array(z.unknown()), z.record(z.string(), z.unknown())]).nullish(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('tool_use'),
      tool_name: z.string().nullish(),
      name: z.string().nullish(),
      tool_id: z.string().nullish(),
      parameters: z.unknown().optional(),
      input: z.unknown().optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('tool_result'),
      tool_name: z.string().nullish(),
      name: z.string().nullish(),
      tool_id: z.string().nullish(),
      output: z.unknown().optional(),
      result: z.unknown().optional(),
      status: z.string().nullish(),
      error: z.unknown().optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('result'),
      status: z.string().nullish(),
      error: z.unknown().optional(),
      stats: geminiStatsSchema.nullish(),
      response: z.string().nullish(),
    })
    .passthrough(),
  z.object({ type: z.literal('error'), message: z.string().nullish() }).passthrough(),
]);

export type GeminiEvent = z.infer<typeof geminiEventSchema>;

/** Flatten gemini message content: string, content blocks, or {text} record. */
function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object' && 'text' in block) {
          return String((block as { text: unknown }).text);
        }
        return '';
      })
      .filter((s) => s.length > 0)
      .join('');
  }
  if (content && typeof content === 'object' && 'text' in content) {
    return String((content as { text: unknown }).text);
  }
  return '';
}

/**
 * Map one native gemini stream-json line to zero or more canonical events.
 * Malformed JSON propagates (the run loop surfaces it); lines whose shape the
 * schema does not recognize are ignored for forward compatibility.
 * Per gemini token taxonomy: stats.input is the UNCACHED prompt slice
 * (prompt − cached), so it maps to canonical inputTokens; stats.cached maps
 * to cacheRead. cacheWrite stays 0 (gemini reports no explicit cache-write
 * count). Reasoning comes from stats.thoughts when present.
 */
export function parseGeminiLine(line: string): CanonicalEvent[] {
  const parsed = geminiEventSchema.safeParse(JSON.parse(line));
  if (!parsed.success) return [];
  const evt: GeminiEvent = parsed.data;
  switch (evt.type) {
    case 'init':
      return evt.session_id ? [{ type: 'session', sessionId: evt.session_id }] : [];
    case 'message': {
      const text = flattenContent(evt.content);
      if (text === '') return [];
      const role = evt.role === 'user' ? 'user' : evt.role === 'system' ? 'system' : 'assistant';
      return [{ type: 'message', role, text }];
    }
    case 'tool_use':
      return [
        {
          type: 'tool',
          toolName: evt.tool_name ?? evt.name ?? 'unknown_tool',
          phase: 'start',
          toolCallId: evt.tool_id ?? undefined,
          input: evt.parameters ?? evt.input,
        },
      ];
    case 'tool_result': {
      const failed = evt.status === 'error' || evt.error !== undefined;
      return [
        {
          type: 'tool',
          toolName: evt.tool_name ?? evt.name ?? 'unknown_tool',
          phase: 'result',
          toolCallId: evt.tool_id ?? undefined,
          output: evt.output ?? evt.result ?? evt.error,
          status: failed ? 'error' : 'success',
        },
      ];
    }
    case 'result': {
      const events: CanonicalEvent[] = [];
      if (evt.response && evt.response.length > 0) {
        events.push({ type: 'message', role: 'assistant', text: evt.response });
      }
      if (evt.status && evt.status !== 'success' && evt.status !== 'ok') {
        const err = evt.error;
        const message =
          typeof err === 'string'
            ? err
            : err && typeof err === 'object' && 'message' in err
              ? String((err as { message: unknown }).message)
              : `gemini run finished with status ${evt.status}`;
        events.push({ type: 'error', message });
      }
      if (evt.stats) {
        const s = evt.stats;
        // Prefer the explicit uncached slice; fall back to deriving it from
        // total input minus cached when the CLI omits `input`.
        const uncachedInput = s.input ?? Math.max(0, (s.input_tokens ?? 0) - (s.cached ?? 0));
        events.push({
          type: 'usage',
          tokens: {
            inputTokens: uncachedInput,
            cacheReadTokens: s.cached ?? 0,
            cacheWriteTokens: 0,
            outputTokens: s.output_tokens ?? 0,
            reasoningTokens: s.thoughts ?? null,
            totalTokens: s.total_tokens ?? null,
            durationMs: s.duration_ms ?? null,
            raw: s,
          },
        });
      }
      return events;
    }
    case 'error':
      return [{ type: 'error', message: evt.message ?? 'gemini reported an error' }];
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface GeminiAdapterOptions {
  /** Binary to invoke; defaults to `gemini` on PATH. */
  command?: string;
  /** Injectable spawn factory for tests. */
  spawnFn?: SpawnFn;
  extraArgs?: string[];
}

export class GeminiAdapter implements AgentAdapter, CoreAgentAdapter {
  readonly id = 'gemini';
  readonly name = 'gemini';
  readonly capabilities: AdapterCapabilities = GEMINI_CAPABILITIES;

  #command: string;
  #spawnFn: SpawnFn | undefined;
  #extraArgs: string[];
  #current: RunHandle | null = null;

  constructor(options: GeminiAdapterOptions = {}) {
    this.#command = options.command ?? 'gemini';
    this.#spawnFn = options.spawnFn;
    this.#extraArgs = options.extraArgs ?? [];
  }

  spawn(prompt: string, opts: RunOptions = {}): RunHandle {
    const spec: JsonlRunSpec = {
      command: this.#command,
      args: ['-p', prompt, '--output-format', 'stream-json', '--approval-mode', 'yolo', ...this.#extraArgs],
      cwd: opts.cwd,
      env: opts.env,
    };
    return this.#run(spec, opts.onOutput);
  }

  resume(sessionId: string, prompt: string, opts: RunOptions = {}): RunHandle {
    const spec: JsonlRunSpec = {
      command: this.#command,
      args: ['-r', sessionId, '-p', prompt, '--output-format', 'stream-json', '--approval-mode', 'yolo', ...this.#extraArgs],
      cwd: opts.cwd,
      env: opts.env,
    };
    return this.#run(spec, opts.onOutput);
  }

  /** Driver contract (src/core/driver.ts): launch one run for a RunSpec. */
  /**
   * Adapter-owned profile validation (issue #9): the shared model/resume
   * surface (`-m <model>`, `-r <sessionId>`) must be sane CLI tokens.
   */
  validateProfile(spec: CoreRunSpec): AdapterProfileCheck {
    return validateCliSessionProfile(spec);
  }

  async launch(spec: CoreRunSpec): Promise<CoreAgentHandle> {
    const modelArgs = spec.model !== undefined ? ['-m', spec.model] : [];
    const jsonlSpec: JsonlRunSpec = {
      command: this.#command,
      args: [
        ...(spec.resume ? ['-r', spec.resume] : []),
        '-p',
        spec.prompt,
        '--output-format',
        'stream-json',
        '--approval-mode',
        'yolo',
        ...modelArgs,
        ...this.#extraArgs,
        ...(spec.extraArgs ?? []),
      ],
      cwd: spec.cwd,
      env: spec.env,
    };
    const handle = this.#run(jsonlSpec, takeOnOutput(spec));
    return launchDriverHandle({
      agent: 'gemini',
      events: handle.events,
      mapEvent: (event) => houseEventToCore('gemini', event),
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
    const handle = runJsonlCli({ spec, parseLine: parseGeminiLine, spawnFn: this.#spawnFn, onOutput });
    this.#current = handle;
    void handle.wait().finally(() => {
      if (this.#current === handle) this.#current = null;
    });
    return handle;
  }
}
