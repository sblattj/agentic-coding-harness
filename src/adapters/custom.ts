// Generic custom-agent adapter (#37): run ANY CLI through a command template.
//
//   ach run --agent custom --template 'mycli --model {model} --cwd {workspace} {prompt}' "<prompt>"
//
// Placeholders: {prompt}, {model} (RunSpec.model / --model), {workspace}
// (RunSpec.cwd, default process.cwd(); also the child's cwd).
//
// SAFETY CONTRACT — the prompt is never shell-interpolated:
//  - default (argv) mode: the template is split argv-style HERE (quotes and
//    backslashes honoured, no expansion of any kind), THEN placeholders are
//    substituted per argv element, and the child is spawned with shell:false.
//    A prompt full of quotes, spaces and `$(...)` arrives as one literal arg.
//  - stdin mode (`--prompt-stdin`): the prompt is written to the child's stdin;
//    the template needs no {prompt}.
//  - shell mode (`--template-shell`): the TEMPLATE is run by `/bin/sh -c`, so
//    the template author's pipes/globs/$vars expand. Placeholder VALUES are
//    still never pasted into the shell text: `{prompt}` becomes "$ACH_PROMPT"
//    and the value rides the environment (ACH_PROMPT/ACH_MODEL/ACH_WORKSPACE).
//
// METERING: output format "text" (default) reports no usage at all — the run
// is labelled `metering: "none"` and every token/cost figure renders n/a. The
// "jsonl" format extracts usage from configured jq-like field paths; a run in
// which at least one line matched is labelled `metering: "tap"`.
import type { SpawnFn } from './shared.ts';
import { houseEventToCore, launchDriverHandle, runJsonlCli, takeOnOutput, validateCliSessionProfile } from './shared.ts';
import type { CanonicalEvent } from './types.ts';
import type {
  AdapterProfileCheck,
  AgentAdapter as CoreAgentAdapter,
  AgentEvent as CoreAgentEvent,
  AgentHandle as CoreAgentHandle,
  RunRecordExtras,
  RunSpec as CoreRunSpec,
} from '../core/types.js';
import { HarnessError } from '../core/types.js';

/** Reserved `--agent` handle for per-invocation templates. */
export const CUSTOM_AGENT = 'custom';

export type PromptVia = 'argv' | 'stdin';

/** jq-like field paths (`.usage.input_tokens`, `a.b[0].c`) into one JSONL record. */
export interface UsageFieldPaths {
  input?: string;
  output?: string;
  cacheRead?: string;
  cacheWrite?: string;
  reasoning?: string;
  model?: string;
  /** Provider-REPORTED USD for the record (never an estimate). */
  costUsd?: string;
}

export type CustomOutputSpec =
  | { format: 'text' }
  | {
      format: 'jsonl';
      usage?: UsageFieldPaths;
      /**
       * Set when the CLI's `input` figure INCLUDES cache reads (OpenAI-style
       * accounting): cacheRead is subtracted so canonical inputTokens stays
       * uncached-only (docs/TOKEN-COUNTING.md).
       */
      inputIncludesCache?: boolean;
      /** Path to assistant text on a record (emitted as a message event). */
      text?: string;
      /** Path to the CLI's session id on a record. */
      sessionId?: string;
    };

export interface CustomAgentConfig {
  /** Agent name recorded on runs (`custom`, or an agents.d descriptor name). */
  name: string;
  template: string;
  promptVia?: PromptVia;
  /** Run the template through `/bin/sh -c` (see SAFETY CONTRACT above). */
  shell?: boolean;
  output?: CustomOutputSpec;
  /** Injectable spawn factory for tests. */
  spawnFn?: SpawnFn;
}

// ---------------------------------------------------------------- template

/**
 * Split a template into argv the way a POSIX shell would split WORDS, and
 * nothing more: whitespace separates, '…' is literal, "…" honours \" and \\,
 * a bare backslash escapes the next char. No globbing, no $ expansion, no
 * command substitution — ever.
 */
export function splitTemplate(template: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inWord = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < template.length; i += 1) {
    const ch = template[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && (template[i + 1] === '"' || template[i + 1] === '\\')) {
        cur += template[i + 1];
        i += 1;
      } else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
      continue;
    }
    if (ch === '\\' && i + 1 < template.length) {
      cur += template[i + 1];
      i += 1;
      inWord = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inWord) out.push(cur);
      cur = '';
      inWord = false;
      continue;
    }
    cur += ch;
    inWord = true;
  }
  if (quote !== null) throw new HarnessError(`template has an unterminated ${quote} quote: ${template}`, 'USAGE');
  if (inWord) out.push(cur);
  if (out.length === 0) throw new HarnessError('template is empty (expected a command, e.g. "mycli -p {prompt}")', 'USAGE');
  return out;
}

export interface TemplateValues {
  prompt: string;
  model?: string;
  workspace: string;
}

export interface ResolvedCommand {
  command: string;
  args: string[];
  /** Prompt to write to stdin (stdin mode only). */
  stdin?: string;
  /** Extra env for the child (shell mode: ACH_PROMPT/ACH_MODEL/ACH_WORKSPACE). */
  env: Record<string, string>;
  /** Full argv for the run record, prompt redacted as `<prompt:N chars>`. */
  redacted: string[];
}

const PLACEHOLDER = /\{(prompt|model|workspace)\}/g;

function usesPlaceholder(template: string, name: 'prompt' | 'model' | 'workspace'): boolean {
  return template.includes(`{${name}}`);
}

function checkTemplate(config: Pick<CustomAgentConfig, 'template' | 'promptVia'>): void {
  if ((config.promptVia ?? 'argv') === 'argv' && !usesPlaceholder(config.template, 'prompt')) {
    throw new HarnessError(
      'template has no {prompt} placeholder: add one, or deliver the prompt on stdin with --prompt-stdin',
      'USAGE',
    );
  }
}

/** Resolve the template for one run (pure). */
export function resolveCommand(
  config: Pick<CustomAgentConfig, 'template' | 'promptVia' | 'shell'> & { name?: string },
  values: TemplateValues,
): ResolvedCommand {
  checkTemplate(config);
  if (usesPlaceholder(config.template, 'model') && (values.model === undefined || values.model === '')) {
    throw new HarnessError('template uses {model} but no model was given (pass --model)', 'USAGE');
  }
  const viaStdin = (config.promptVia ?? 'argv') === 'stdin';
  const stdin = viaStdin ? { stdin: values.prompt } : {};

  if (config.shell === true) {
    // POSIX-only: the values ride "$VAR" references, which cmd.exe cannot
    // expand safely (a %VAR% expansion is re-parsed, so a prompt containing
    // " or & would break out). Documented limitation (#39).
    if (process.platform === 'win32') {
      throw new HarnessError(
        '--template-shell needs a POSIX /bin/sh and is not supported on Windows: drop --template-shell (argv mode needs no shell)',
        'USAGE',
      );
    }
    // The template is shell code by the author's explicit choice; the VALUES
    // are not: each placeholder becomes a quoted env-var reference.
    const script = config.template.replace(PLACEHOLDER, (_m, name: string) =>
      name === 'prompt' ? '"$ACH_PROMPT"' : name === 'model' ? '"$ACH_MODEL"' : '"$ACH_WORKSPACE"',
    );
    const env: Record<string, string> = { ACH_PROMPT: values.prompt, ACH_WORKSPACE: values.workspace };
    if (values.model !== undefined) env.ACH_MODEL = values.model;
    return { command: '/bin/sh', args: ['-c', script], env, redacted: ['/bin/sh', '-c', script], ...stdin };
  }

  const words = splitTemplate(config.template);
  const sub = (word: string, redact: boolean): string =>
    word.replace(PLACEHOLDER, (_m, name: string) =>
      name === 'prompt'
        ? redact
          ? `<prompt:${values.prompt.length} chars>`
          : values.prompt
        : name === 'model'
          ? (values.model ?? '')
          : values.workspace,
    );
  const argv = words.map((w) => sub(w, false));
  const redacted = words.map((w) => sub(w, true));
  return { command: argv[0]!, args: argv.slice(1), env: {}, redacted, ...stdin };
}

// ------------------------------------------------------------------ output

/** Read a jq-like path (`.a.b[0].c` or `a.b.0.c`) out of a parsed record. */
export function getPath(root: unknown, path: string): unknown {
  const keys = path.replace(/^\./, '').match(/[^.[\]]+/g) ?? [];
  let cur: unknown = root;
  for (const key of keys) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/**
 * Map one stdout line to house events. text: one assistant message per line.
 * jsonl: JSON records feed text/session/usage via the configured paths; a line
 * that is not JSON is kept as text (banners, progress chatter).
 */
export function parseCustomLine(output: CustomOutputSpec, line: string): CanonicalEvent[] {
  if (output.format === 'text') return [{ type: 'message', role: 'assistant', text: line }];
  let rec: unknown;
  try {
    rec = JSON.parse(line);
  } catch {
    return [{ type: 'message', role: 'assistant', text: line }];
  }
  const events: CanonicalEvent[] = [];
  if (output.sessionId !== undefined) {
    const sid = getPath(rec, output.sessionId);
    if (typeof sid === 'string' && sid !== '') events.push({ type: 'session', sessionId: sid });
  }
  const textValue = output.text !== undefined ? getPath(rec, output.text) : undefined;
  // Without a text path the raw record is the message: nothing is dropped.
  events.push({ type: 'message', role: 'assistant', text: typeof textValue === 'string' ? textValue : line });

  const u = output.usage;
  if (u !== undefined) {
    const pick = (p: string | undefined): number | undefined => (p === undefined ? undefined : num(getPath(rec, p)));
    const input = pick(u.input);
    const out = pick(u.output);
    const cacheRead = pick(u.cacheRead);
    const cacheWrite = pick(u.cacheWrite);
    const reasoning = pick(u.reasoning);
    if ([input, out, cacheRead, cacheWrite].some((v) => v !== undefined)) {
      const model = u.model !== undefined ? getPath(rec, u.model) : undefined;
      const cost = pick(u.costUsd);
      const inputTokens =
        output.inputIncludesCache === true ? Math.max(0, (input ?? 0) - (cacheRead ?? 0)) : (input ?? 0);
      events.push({
        type: 'usage',
        tokens: {
          inputTokens,
          outputTokens: out ?? 0,
          cacheReadTokens: cacheRead ?? 0,
          cacheWriteTokens: cacheWrite ?? 0,
          reasoningTokens: reasoning ?? null,
          totalTokens: null,
          durationMs: null,
          raw: rec,
          extra: {
            source: 'tap',
            ...(typeof model === 'string' && model !== '' ? { model } : {}),
            ...(cost !== undefined ? { reportedCostUsd: cost } : {}),
          },
        },
      } as CanonicalEvent);
    }
  }
  return events;
}

// ----------------------------------------------------------------- adapter

/** Driver-contract adapter for one template (fresh child per launch). */
export interface CustomDriverAdapter extends CoreAgentAdapter {
  requiresModel: boolean;
}

/**
 * Build a driver adapter from a template config. Template errors (empty,
 * unterminated quote, argv mode without {prompt}) throw HarnessError('USAGE')
 * HERE, before anything is launched.
 */
export function createCustomAdapter(config: CustomAgentConfig): CustomDriverAdapter {
  checkTemplate(config);
  if (config.shell !== true) splitTemplate(config.template);
  const output: CustomOutputSpec = config.output ?? { format: 'text' };
  const name = config.name;

  const launch = async (spec: CoreRunSpec): Promise<CoreAgentHandle> => {
    const workspace = typeof spec.cwd === 'string' && spec.cwd !== '' ? spec.cwd : process.cwd();
    const resolved = resolveCommand(config, { prompt: spec.prompt, model: spec.model, workspace });
    const extra = spec.extraArgs ?? [];
    // Under `sh -c '<script>' a b`, a/b become $0/$1 and never reach the
    // command — refuse rather than drop them silently.
    if (config.shell === true && extra.length > 0) {
      throw new HarnessError('extraArgs are not supported with --template-shell; put them in the template', 'USAGE');
    }
    let metered = false;
    const handle = runJsonlCli({
      spec: {
        command: resolved.command,
        args: [...resolved.args, ...extra],
        cwd: workspace,
        env: { ...(spec.env ?? {}), ...resolved.env },
        scrubEnv: spec.sandbox?.scrubEnv,
        ...(resolved.stdin !== undefined ? { stdin: resolved.stdin } : {}),
      },
      parseLine: (line) => parseCustomLine(output, line),
      spawnFn: config.spawnFn,
      onOutput: takeOnOutput(spec),
    });
    const mapEvent = (event: CanonicalEvent): CoreAgentEvent | null => {
      const core = houseEventToCore(name, event);
      if (core?.type === 'usage' && core.usage) {
        metered = true;
        const x = (core.usage.extra ?? {}) as Record<string, unknown>;
        if (typeof x.model === 'string') core.usage.model = x.model;
        else if (spec.model !== undefined && spec.model !== '') core.usage.model = spec.model;
        // A tapped cost is provider-REPORTED: it rides costUsd (issue #7 rule).
        if (typeof x.reportedCostUsd === 'number') core.usage.costUsd = x.reportedCostUsd;
      }
      return core;
    };
    const driverHandle = await launchDriverHandle({
      agent: name,
      events: handle.events,
      mapEvent,
      exit: handle.wait(),
      abort: () => handle.abort(),
      fallbackSessionId: spec.resume,
    });
    const extras = (): RunRecordExtras => ({
      metering: metered ? 'tap' : 'none',
      command: [...resolved.redacted, ...extra],
    });
    return Object.assign(driverHandle, { runRecordExtras: extras });
  };

  return {
    name,
    requiresModel: config.template.includes('{model}'),
    validateProfile: (spec: CoreRunSpec): AdapterProfileCheck => validateCliSessionProfile({ model: spec.model }),
    launch,
  };
}
