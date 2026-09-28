// Drop-in agent definitions (#38): one JSON descriptor per CLI, no code change.
//
// Search order (first definition of a name wins, later ones warn):
//   1. <cwd>/.ach/agents.d/*.json      (project)
//   2. <stateDir>/agents.d/*.json      (user; stateDir = AGENTIC_CODING_HARNESS_STATE_DIR
//                                       or ~/.agentic-coding-harness)
//
// Loading is strict and never fatal: an unknown field, a malformed file or a
// bad usageTap path becomes a named error {file, field, message} and every
// OTHER descriptor keeps working. A descriptor whose name collides with a
// built-in adapter (or the reserved `custom`) is skipped with a warning — the
// built-in always wins. Schema reference: docs/CUSTOM-AGENTS.md.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { expandHome } from './platform.ts';
import { AGENTS } from './types.js';
import { CUSTOM_AGENT, getPath, type CustomAgentConfig } from '../adapters/custom.ts';

const fieldPath = z.string().min(1);

const UsageFieldPathsSchema = z
  .object({
    input: fieldPath.optional(),
    output: fieldPath.optional(),
    cacheRead: fieldPath.optional(),
    cacheWrite: fieldPath.optional(),
    reasoning: fieldPath.optional(),
    model: fieldPath.optional(),
    costUsd: fieldPath.optional(),
  })
  .strict();

const OutputSchema = z.discriminatedUnion('format', [
  z.object({ format: z.literal('text') }).strict(),
  z
    .object({
      format: z.literal('jsonl'),
      usage: UsageFieldPathsSchema.optional(),
      inputIncludesCache: z.boolean().optional(),
      text: fieldPath.optional(),
      sessionId: fieldPath.optional(),
    })
    .strict(),
]);

const LaunchSchema = z
  .object({
    /** Command template: {prompt} {model} {workspace}; split argv-style, never via a shell. */
    template: z.string().min(1),
    promptVia: z.enum(['argv', 'stdin']).optional(),
    /** Opt into `/bin/sh -c` for the template (values still ride env vars). */
    shell: z.boolean().optional(),
    output: OutputSchema.optional(),
  })
  .strict();

const TapFieldsSchema = UsageFieldPathsSchema.extend({
  timestamp: fieldPath.optional(),
  sessionId: fieldPath.optional(),
}).strict();

const UsageTapSchema = z
  .object({
    type: z.literal('transcript'),
    /** Absolute (or ~/) path to a .jsonl file or a directory scanned recursively for *.jsonl. */
    path: z.string().min(1),
    format: z.literal('jsonl'),
    fields: TapFieldsSchema,
    inputIncludesCache: z.boolean().optional(),
  })
  .strict();

const nonNeg = z.number().nonnegative();
const PricingHintSchema = z
  .object({ input: nonNeg, output: nonNeg, cacheRead: nonNeg.optional(), cacheWrite: nonNeg.optional() })
  .strict();

export const AgentDescriptorSchema = z
  .object({
    $schema: z.string().optional(),
    name: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'must be lowercase [a-z0-9._-], 1-64 chars, starting alphanumeric'),
    description: z.string().optional(),
    launch: LaunchSchema.nullable().optional(),
    usageTap: UsageTapSchema.nullable().optional(),
    pricingHints: z.record(z.string(), PricingHintSchema).optional(),
  })
  .strict()
  .refine((d) => (d.launch ?? null) !== null || (d.usageTap ?? null) !== null, {
    message: 'launch and usageTap cannot both be null (nothing to run and nothing to meter)',
    path: ['launch'],
  });

export type AgentDescriptor = z.infer<typeof AgentDescriptorSchema>;

/**
 * JSON Schema of the descriptor file format (published as
 * docs/agent-descriptor.schema.json; a test keeps the two identical). The
 * "launch or usageTap must be non-null" rule is a refinement the JSON Schema
 * cannot express; the loader enforces it.
 */
export function agentDescriptorJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(AgentDescriptorSchema, { io: 'input' }) as Record<string, unknown>;
}

export interface LoadedDescriptor {
  descriptor: AgentDescriptor;
  /** Absolute path of the descriptor file. */
  file: string;
}

export interface DescriptorIssue {
  file: string;
  /** Dotted field path, or "(file)" for unreadable / non-JSON files. */
  field: string;
  message: string;
}

export interface DescriptorLoad {
  descriptors: LoadedDescriptor[];
  errors: DescriptorIssue[];
  warnings: string[];
}

/** Names a descriptor may never take (the built-in adapters + reserved `custom`). */
export function builtinAgentNames(): string[] {
  return [...AGENTS, CUSTOM_AGENT];
}

export function descriptorDirs(opts: { cwd?: string; stateDir: string }): string[] {
  return [path.join(opts.cwd ?? process.cwd(), '.ach', 'agents.d'), path.join(opts.stateDir, 'agents.d')];
}

export function formatDescriptorIssue(i: DescriptorIssue): string {
  return `agents.d: ${i.file}: ${i.field}: ${i.message}`;
}

function zodIssues(file: string, error: z.ZodError): DescriptorIssue[] {
  const out: DescriptorIssue[] = [];
  for (const issue of error.issues) {
    const base = issue.path.map(String).join('.');
    if (issue.code === 'unrecognized_keys') {
      for (const key of (issue as { keys: string[] }).keys) {
        out.push({ file, field: base ? `${base}.${key}` : key, message: 'unknown field' });
      }
      continue;
    }
    out.push({ file, field: base || '(root)', message: issue.message });
  }
  return out;
}

function checkTapPath(file: string, d: AgentDescriptor): DescriptorIssue | null {
  const tap = d.usageTap;
  if (!tap) return null;
  const expanded = expandHome(tap.path);
  if (!path.isAbsolute(expanded)) {
    return { file, field: 'usageTap.path', message: `'${tap.path}' must be absolute or start with ~/` };
  }
  if (!fs.existsSync(expanded)) {
    return { file, field: 'usageTap.path', message: `'${tap.path}' does not exist` };
  }
  return null;
}

/** Load every *.json descriptor from `dirs` (missing dirs are simply empty). Sync, never throws. */
export function loadAgentDescriptors(opts: { dirs: string[]; builtins?: readonly string[] }): DescriptorLoad {
  const builtins = new Set(opts.builtins ?? builtinAgentNames());
  const result: DescriptorLoad = { descriptors: [], errors: [], warnings: [] };
  const seen = new Map<string, string>();
  for (const dir of opts.dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
    } catch {
      continue;
    }
    for (const n of names) {
      const file = path.join(dir, n);
      let json: unknown;
      try {
        json = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        result.errors.push({ file, field: '(file)', message: `not valid JSON (${err instanceof Error ? err.message : String(err)})` });
        continue;
      }
      const parsed = AgentDescriptorSchema.safeParse(json);
      if (!parsed.success) {
        result.errors.push(...zodIssues(file, parsed.error));
        continue;
      }
      const d = parsed.data;
      const tapIssue = checkTapPath(file, d);
      if (tapIssue) {
        result.errors.push(tapIssue);
        continue;
      }
      if (builtins.has(d.name)) {
        result.warnings.push(`agents.d: ${file}: name '${d.name}' collides with a built-in adapter; the built-in wins (descriptor ignored)`);
        continue;
      }
      const prior = seen.get(d.name);
      if (prior !== undefined) {
        result.warnings.push(`agents.d: ${file}: name '${d.name}' already defined by ${prior}; ignored`);
        continue;
      }
      seen.set(d.name, file);
      result.descriptors.push({ descriptor: d, file });
    }
  }
  return result;
}

/** CustomAgentConfig for a descriptor with a launch block (null for meter-only descriptors). */
export function descriptorToCustomConfig(loaded: LoadedDescriptor): CustomAgentConfig | null {
  const launch = loaded.descriptor.launch;
  if (!launch) return null;
  return {
    name: loaded.descriptor.name,
    template: launch.template,
    ...(launch.promptVia !== undefined ? { promptVia: launch.promptVia } : {}),
    ...(launch.shell !== undefined ? { shell: launch.shell } : {}),
    ...(launch.output !== undefined ? { output: launch.output } : {}),
  };
}

// ------------------------------------------------------- transcript usage tap

/** One usage row read from a descriptor's transcript tap (stats input shape). */
export interface TapUsageRow {
  ts: string | null;
  agent: string;
  sessionId: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** Provider-reported USD when the tap maps costUsd. */
  costUsd?: number;
}

async function listJsonl(p: string): Promise<string[]> {
  let st;
  try {
    st = await fsp.stat(p);
  } catch {
    return [];
  }
  if (st.isFile()) return [p];
  if (!st.isDirectory()) return [];
  const out: string[] = [];
  for (const e of await fsp.readdir(p, { withFileTypes: true })) {
    const child = path.join(p, e.name);
    if (e.isDirectory()) out.push(...(await listJsonl(child)));
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(child);
  }
  return out.sort();
}

function toIso(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  return null;
}

function count(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/**
 * Read a descriptor's transcript tap: every JSON line where at least one token
 * field resolves becomes a row; lines without usage are skipped (never zero
 * rows). A missing timestamp yields ts:null (stats day bucket "unknown").
 */
export async function readDescriptorTap(loaded: LoadedDescriptor): Promise<TapUsageRow[]> {
  const tap = loaded.descriptor.usageTap;
  if (!tap) return [];
  const f = tap.fields;
  const rows: TapUsageRow[] = [];
  for (const file of await listJsonl(expandHome(tap.path))) {
    let text: string;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const fallbackSession = path.basename(file, '.jsonl');
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      let rec: unknown;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const pick = (p: string | undefined): number | undefined => (p === undefined ? undefined : count(getPath(rec, p)));
      const input = pick(f.input);
      const output = pick(f.output);
      const cacheRead = pick(f.cacheRead);
      const cacheWrite = pick(f.cacheWrite);
      if ([input, output, cacheRead, cacheWrite].every((v) => v === undefined)) continue;
      const model = f.model !== undefined ? getPath(rec, f.model) : undefined;
      const sid = f.sessionId !== undefined ? getPath(rec, f.sessionId) : undefined;
      const cost = pick(f.costUsd);
      rows.push({
        ts: f.timestamp !== undefined ? toIso(getPath(rec, f.timestamp)) : null,
        agent: loaded.descriptor.name,
        sessionId: typeof sid === 'string' && sid !== '' ? sid : fallbackSession,
        ...(typeof model === 'string' && model !== '' ? { model } : {}),
        inputTokens: tap.inputIncludesCache === true ? Math.max(0, (input ?? 0) - (cacheRead ?? 0)) : (input ?? 0),
        outputTokens: output ?? 0,
        cacheReadTokens: cacheRead ?? 0,
        cacheWriteTokens: cacheWrite ?? 0,
        reasoningTokens: pick(f.reasoning) ?? 0,
        ...(cost !== undefined ? { costUsd: cost } : {}),
      });
    }
  }
  return rows;
}
