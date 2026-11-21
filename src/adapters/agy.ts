// Antigravity CLI (`agy`) adapter (issue #231).
//
// `agy -p <prompt> --output-format stream-json` emits NDJSON (agy 1.5.6, re-checked live on 1.5.13;
// recorded in tests/fixtures/agy/):
//   {"event":"init","conversation_id":ID,"init":{cwd,permission_mode,model?,tools}}
//   {"event":"step_update","step_update":{conversation_id,step_index,state,step_type,...}}
//   {"event":"result","result":{conversation_id,status,response,error?,usage?,...}}
// step_type is user_input | agent_response | tool; state is ACTIVE | DONE |
// ERROR. An agent_response step streams `text_delta` while ACTIVE and carries
// THAT model call's usage on DONE; result.usage is the run sum. Tool steps
// carry tool_info.{name,parameters} on ACTIVE and output (DONE) or error
// (ERROR) at the end. A failure before the run starts (bad --model) prints
// only a result line with conversation_id "" and exits 1; --print-timeout
// expiry is a result with status ERROR and exit 3.
//
// Token taxonomy (verified on a cached second call: input 2798 + output 442
// = total 3240, cache_read 13712 separate): input_tokens is the UNCACHED
// prompt slice, cache_read_tokens is separate, output_tokens INCLUDES
// thinking_tokens. agy reports no cache writes.
import type { AdapterCapabilities, AgentAdapter, CanonicalEvent, RunHandle, RunOptions } from './types.ts';
import type {
  AdapterProfileCheck,
  AgentAdapter as CoreAgentAdapter,
  AgentEvent as CoreAgentEvent,
  AgentHandle as CoreAgentHandle,
  RunSpec as CoreRunSpec,
  SandboxPolicy,
} from '../core/types.js';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runJsonlCli, launchDriverHandle, houseEventToCore, takeOnOutput, validateCliSessionProfile, type JsonlRunSpec, type SpawnFn } from './shared.ts';

export const AGY_CAPABILITIES: AdapterCapabilities = {
  headless: true,
  streaming: true,
  resume: true,
  // `agy acp` is an ACP stdio server; this adapter drives the print mode.
  acp: true,
  tmuxFallback: true,
};

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

interface AgyUsage {
  input: number;
  cacheRead: number;
  output: number;
  thinking: number;
  total: number | null;
}

function readUsage(u: unknown): AgyUsage | null {
  if (!isObj(u)) return null;
  return {
    input: num(u.input_tokens),
    cacheRead: num(u.cache_read_tokens),
    output: num(u.output_tokens),
    thinking: num(u.thinking_tokens),
    total: typeof u.total_tokens === 'number' ? u.total_tokens : null,
  };
}

function usageEvent(u: AgyUsage, durationSeconds: unknown, raw: unknown): CanonicalEvent {
  return {
    type: 'usage',
    tokens: {
      inputTokens: u.input,
      cacheReadTokens: u.cacheRead,
      cacheWriteTokens: 0,
      outputTokens: u.output,
      reasoningTokens: u.thinking,
      totalTokens: u.total,
      durationMs: typeof durationSeconds === 'number' ? Math.round(durationSeconds * 1000) : null,
      raw,
    },
  };
}

function errorText(err: unknown, fallback: string): string {
  if (typeof err === 'string' && err.length > 0) return err.split('\n')[0]!;
  if (isObj(err) && typeof err.message === 'string') return err.message;
  return fallback;
}

/** (conversationId, stepIndex) → model id that served that step, or undefined. */
export type AgyModelLookup = (conversationId: string, stepIndex: number) => string | undefined;

/**
 * The model of one agent_response step from agy's own conversation log
 * (<home>/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl):
 * its PLANNER_RESPONSE row has the same step_index as the stream's step and
 * names the model id. Undefined when the log or row is not there (yet).
 */
export function agyTranscriptModel(home: string, conversationId: string, stepIndex: number): string | undefined {
  return agyTranscriptModelReader(home)(conversationId, stepIndex);
}

/**
 * A lookup that reads each conversation log incrementally: it keeps the byte
 * offset and the step → model rows it has seen, so a long tool loop reads
 * every byte once instead of re-reading the whole growing file per call.
 * A partly written last line is held back until its newline arrives.
 */
export function agyTranscriptModelReader(home: string): AgyModelLookup {
  const logs = new Map<string, { offset: number; tail: string; models: Map<number, string> }>();
  return (conversationId, stepIndex) => {
    if (!/^[A-Za-z0-9-]+$/.test(conversationId)) return undefined;
    let log = logs.get(conversationId);
    if (log === undefined) {
      log = { offset: 0, tail: '', models: new Map() };
      logs.set(conversationId, log);
    }
    const known = log.models.get(stepIndex);
    if (known !== undefined) return known;
    const file = join(home, '.gemini', 'antigravity-cli', 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl');
    let fd: number | undefined;
    try {
      fd = openSync(file, 'r');
      const size = fstatSync(fd).size;
      if (size < log.offset) {
        log.offset = 0;
        log.tail = '';
      }
      if (size > log.offset) {
        const buf = Buffer.alloc(size - log.offset);
        const n = readSync(fd, buf, 0, buf.length, log.offset);
        log.offset += n;
        const lines = (log.tail + buf.subarray(0, n).toString('utf8')).split('\n');
        log.tail = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.includes('"PLANNER_RESPONSE"')) continue;
          try {
            const row: unknown = JSON.parse(line);
            if (isObj(row) && typeof row.step_index === 'number' && typeof row.model === 'string' && row.model !== '') {
              log.models.set(row.step_index, row.model);
            }
          } catch {
            // not a JSON row: skip
          }
        }
      }
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    return log.models.get(stepIndex);
  };
}

/**
 * Stateful parser for one agy stream-json run: one instance per run.
 *
 * Model-call boundaries (#32): agy has no request ids, but each
 * agent_response step IS one model call. The request is sent when the user
 * input step finishes, or after the last tool result before the next
 * response, so a call's start is stamped at that moment (`startTime(ev)`),
 * not at the first response line. A streamed text delta is the first output
 * (a `chunk` step); the step's DONE closes the call with its own
 * output_tokens. A response that ends without streaming text (a tool-calling
 * turn) has no observable first output, so its TTFT stays unmeasured.
 *
 * Usage: one usage event per agent_response DONE (per-call, so the context
 * meter reads the latest call). result.usage repeats the sum, so only a
 * positive residual over what the steps reported is emitted from it.
 */
export class AgyStreamParser {
  #model: string | undefined;
  #pendingAt: number | null = null;
  #open: { step: number; id: string; text: string; chunked: boolean } | null = null;
  #calls = 0;
  #sum = { input: 0, cacheRead: 0, output: 0, thinking: 0 };
  #emittedText = false;
  #starts = new WeakMap<CanonicalEvent, number>();
  #models = new WeakMap<CanonicalEvent, string>();
  #conversationId: string | undefined;
  #lookupModel: AgyModelLookup | undefined;

  /**
   * @param lookupModel resolves the model that served one agent_response step
   * when the stream does not name it (no --model: init carries no model). The
   * adapter reads agy's own conversation log for it (`agyTranscriptModel`).
   */
  constructor(lookupModel?: AgyModelLookup) {
    this.#lookupModel = lookupModel;
  }

  /** Model from `init.model` (present only when --model was passed). */
  get model(): string | undefined {
    return this.#model;
  }

  /** Request time for a model_call start event, when it predates the line that emitted it. */
  startTime(ev: CanonicalEvent): number | undefined {
    return this.#starts.get(ev);
  }

  /** Model for a usage / model_call event: init.model, else the step's model from the lookup. */
  modelOf(ev: CanonicalEvent): string | undefined {
    return this.#models.get(ev) ?? this.#model;
  }

  parse(line: string, now: number = Date.now()): CanonicalEvent[] {
    const evt: unknown = JSON.parse(line);
    if (!isObj(evt)) return [];
    switch (evt.event) {
      case 'init': {
        const init = isObj(evt.init) ? evt.init : {};
        this.#model = str(init.model) ?? this.#model;
        this.#pendingAt = now;
        const id = str(evt.conversation_id);
        if (id) this.#conversationId = id;
        return id ? [{ type: 'session', sessionId: id }] : [];
      }
      case 'step_update':
        return isObj(evt.step_update) ? this.#step(evt.step_update, now) : [];
      case 'result':
        return isObj(evt.result) ? this.#result(evt.result) : [];
      default:
        return [];
    }
  }

  #step(s: Json, now: number): CanonicalEvent[] {
    const index = typeof s.step_index === 'number' ? s.step_index : -1;
    const state = str(s.state) ?? '';
    const ended = state !== 'ACTIVE';
    switch (s.step_type) {
      case 'user_input':
        if (ended) this.#pendingAt = now;
        return [];
      case 'agent_response': {
        const out: CanonicalEvent[] = [];
        if (this.#open === null || this.#open.step !== index) {
          out.push(...this.#close());
          this.#calls += 1;
          this.#open = { step: index, id: `call-${this.#calls}`, text: '', chunked: false };
          const start: CanonicalEvent = { type: 'model_call', phase: 'start', callId: this.#open.id };
          this.#starts.set(start, this.#pendingAt ?? now);
          this.#pendingAt = null;
          out.push(start);
        }
        const open = this.#open;
        const delta = str(s.text_delta) ?? '';
        if (delta !== '') {
          open.text += delta;
          if (!open.chunked && !ended) {
            open.chunked = true;
            out.push({ type: 'step', payload: { kind: 'chunk', source: 'agent_response' } });
          }
        }
        if (!ended) return out;
        if (open.text !== '') {
          this.#emittedText = true;
          out.push({ type: 'message', role: 'assistant', text: open.text });
        }
        if (state === 'ERROR') out.push({ type: 'error', message: errorText(s.error, 'agy model call failed') });
        const u = readUsage(s.usage);
        const stepModel =
          this.#model ?? (this.#conversationId !== undefined ? this.#lookupModel?.(this.#conversationId, index) : undefined);
        if (u !== null) {
          this.#sum.input += u.input;
          this.#sum.cacheRead += u.cacheRead;
          this.#sum.output += u.output;
          this.#sum.thinking += u.thinking;
          const usage = usageEvent(u, s.duration_seconds, s.usage);
          if (stepModel !== undefined) this.#models.set(usage, stepModel);
          out.push(usage);
        }
        out.push({
          type: 'model_call',
          phase: 'end',
          callId: open.id,
          ...(stepModel !== undefined ? { model: stepModel } : {}),
          ...(u !== null ? { outputTokens: u.output } : {}),
        });
        this.#open = null;
        return out;
      }
      case 'tool': {
        const info = isObj(s.tool_info) ? s.tool_info : {};
        const toolName = str(s.tool_name) ?? str(info.name) ?? 'unknown_tool';
        const toolCallId = `step-${index}`;
        const out: CanonicalEvent[] = [...this.#close()];
        if (!ended) {
          out.push({ type: 'tool', toolName, phase: 'start', toolCallId, input: info.parameters });
          return out;
        }
        const failed = state !== 'DONE' || info.error !== undefined;
        out.push({
          type: 'tool',
          toolName,
          phase: 'result',
          toolCallId,
          output: failed ? (info.error ?? info.output) : info.output,
          status: failed ? 'error' : 'success',
        });
        this.#pendingAt = now;
        return out;
      }
      default:
        return [];
    }
  }

  #close(): CanonicalEvent[] {
    if (this.#open === null) return [];
    const open = this.#open;
    this.#open = null;
    const out: CanonicalEvent[] = [];
    if (open.text !== '') {
      this.#emittedText = true;
      out.push({ type: 'message', role: 'assistant', text: open.text });
    }
    out.push({ type: 'model_call', phase: 'end', callId: open.id, ...(this.#model !== undefined ? { model: this.#model } : {}) });
    return out;
  }

  #result(r: Json): CanonicalEvent[] {
    const out: CanonicalEvent[] = [...this.#close()];
    const response = str(r.response) ?? '';
    if (!this.#emittedText && response !== '') {
      this.#emittedText = true;
      out.push({ type: 'message', role: 'assistant', text: response });
    }
    const status = str(r.status) ?? '';
    if (status !== '' && status !== 'SUCCESS') {
      out.push({ type: 'error', message: errorText(r.error, `agy run finished with status ${status}`) });
    }
    const u = readUsage(r.usage);
    if (u !== null) {
      const residual: AgyUsage = {
        input: Math.max(0, u.input - this.#sum.input),
        cacheRead: Math.max(0, u.cacheRead - this.#sum.cacheRead),
        output: Math.max(0, u.output - this.#sum.output),
        thinking: Math.max(0, u.thinking - this.#sum.thinking),
        total: null,
      };
      if (residual.input + residual.cacheRead + residual.output > 0) {
        residual.total = residual.input + residual.output;
        out.push(
          usageEvent(residual, null, {
            input_tokens: residual.input,
            cache_read_tokens: residual.cacheRead,
            output_tokens: residual.output,
            thinking_tokens: residual.thinking,
            total_tokens: residual.total,
          }),
        );
      }
    }
    return out;
  }
}

/**
 * SandboxPolicy → agy flags (#231). Only permissionMode has a flag that
 * observably changes behavior: "dontAsk" → `--dangerously-skip-permissions`
 * (init.permission_mode becomes "always-proceed"); "ask" → no flag (agy's
 * default "request-review" preset); any other value is a native
 * `--mode accept-edits|auto|plan`. agy has no allow/deny tool flag and no
 * MCP-config flag (its MCP servers live in its own config), so
 * allowedTools, disallowedTools and mcpConfig emit nothing; the policy layer
 * (src/core/sandbox-policy.ts) drops and reports them. Pure; exported for tests.
 */
export function agySandboxArgs(sandbox: SandboxPolicy): string[] {
  const mode = sandbox.permissionMode;
  if (mode === undefined || mode === 'ask') return [];
  if (mode === 'dontAsk') return ['--dangerously-skip-permissions'];
  return ['--mode', mode];
}

/** Default permission flags: skip prompts (headless), unless the sandbox sets a mode. */
function permissionArgs(sandbox: SandboxPolicy | undefined): string[] {
  if (sandbox?.permissionMode === undefined) return ['--dangerously-skip-permissions'];
  return agySandboxArgs(sandbox);
}

export interface AgyAdapterOptions {
  /** Binary to invoke; defaults to `agy` on PATH. */
  command?: string;
  /** Injectable spawn factory for tests. */
  spawnFn?: SpawnFn;
  extraArgs?: string[];
}

export class AgyAdapter implements AgentAdapter, CoreAgentAdapter {
  readonly id = 'agy';
  readonly name = 'agy';
  readonly capabilities: AdapterCapabilities = AGY_CAPABILITIES;

  #command: string;
  #spawnFn: SpawnFn | undefined;
  #extraArgs: string[];
  #current: RunHandle | null = null;

  constructor(options: AgyAdapterOptions = {}) {
    this.#command = options.command ?? 'agy';
    this.#spawnFn = options.spawnFn;
    this.#extraArgs = options.extraArgs ?? [];
  }

  #args(prompt: string, opts: { resume?: string; model?: string; sandbox?: SandboxPolicy; extra?: string[] }): string[] {
    return [
      ...(opts.resume ? ['--conversation', opts.resume] : []),
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      ...permissionArgs(opts.sandbox),
      ...(opts.model !== undefined ? ['--model', opts.model] : []),
      ...this.#extraArgs,
      ...(opts.extra ?? []),
    ];
  }

  spawn(prompt: string, opts: RunOptions = {}): RunHandle {
    const spec: JsonlRunSpec = {
      command: this.#command,
      args: this.#args(prompt, { sandbox: opts.sandbox }),
      cwd: opts.cwd,
      env: opts.env,
      scrubEnv: opts.sandbox?.scrubEnv,
    };
    return this.#run(spec, opts.onOutput);
  }

  resume(sessionId: string, prompt: string, opts: RunOptions = {}): RunHandle {
    const spec: JsonlRunSpec = {
      command: this.#command,
      args: this.#args(prompt, { resume: sessionId, sandbox: opts.sandbox }),
      cwd: opts.cwd,
      env: opts.env,
      scrubEnv: opts.sandbox?.scrubEnv,
    };
    return this.#run(spec, opts.onOutput);
  }

  /** Model and resume ids must be sane CLI tokens (`--model`, `--conversation`). */
  validateProfile(spec: CoreRunSpec): AdapterProfileCheck {
    return validateCliSessionProfile(spec);
  }

  async launch(spec: CoreRunSpec): Promise<CoreAgentHandle> {
    const jsonlSpec: JsonlRunSpec = {
      command: this.#command,
      args: this.#args(spec.prompt, { resume: spec.resume, model: spec.model, sandbox: spec.sandbox, extra: spec.extraArgs }),
      cwd: spec.cwd,
      env: spec.env,
      scrubEnv: spec.sandbox?.scrubEnv,
    };
    const home = spec.env?.HOME !== undefined && spec.env.HOME !== '' ? spec.env.HOME : homedir();
    const parser = new AgyStreamParser(spec.model === undefined ? agyTranscriptModelReader(home) : undefined);
    const handle = this.#run(jsonlSpec, takeOnOutput(spec), (line) => parser.parse(line));
    return launchDriverHandle({
      agent: 'agy',
      events: handle.events,
      mapEvent: (event): CoreAgentEvent | null => {
        const core = houseEventToCore('agy', event);
        if (core === null) return null;
        const startedAt = parser.startTime(event);
        if (startedAt !== undefined) core.timestamp = startedAt;
        // The stream's usage has no model: stamp init.model, else the step's
        // model from agy's conversation log, else the requested --model, so
        // pricing, stats dedupe and the context meter can use it.
        const model = parser.modelOf(event) ?? spec.model;
        if (core.type === 'usage' && model !== undefined && core.usage !== undefined) {
          core.usage = { ...core.usage, model };
        }
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

  #run(
    spec: JsonlRunSpec,
    onOutput?: (chunk: string) => void,
    parseLine: (line: string) => CanonicalEvent[] = (() => {
      const parser = new AgyStreamParser();
      return (line: string) => parser.parse(line);
    })(),
  ): RunHandle {
    const handle = runJsonlCli({ spec, parseLine, spawnFn: this.#spawnFn, onOutput });
    this.#current = handle;
    void handle.wait().finally(() => {
      if (this.#current === handle) this.#current = null;
    });
    return handle;
  }
}
