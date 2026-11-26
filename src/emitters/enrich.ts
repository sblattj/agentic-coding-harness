// Custom export enrichers (#95): user-chosen attributes stamped onto every
// exported OTel span (and the OTLP resource), every Langfuse span, and the
// ATIF trajectory's top-level `extra.attributes`.
//
// Two sources, both data only (no user code runs):
//   - static `key=value` pairs (`ach emit --attr team=platform`)
//   - env mappings `key=ENVVAR` (`ach emit --attr-env ci.build_id=BUILD_NUMBER`),
//     read from the environment at export time.
//
//   - an opt-in user module (`ach emit --enricher ./enrich.mjs`, or
//     `emit.enricher` in the config file; never over MCP) whose default
//     export maps span-like info to extra attributes, sync or async.
//
// Fail open: a malformed entry, an unset env var, or a module that fails to
// load, throws, times out or returns a non-object is skipped with one
// warning; nothing here throws, so enrichment can never abort an export.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** The attribute map the emitters stamp on their output. */
export type EnrichAttributes = Record<string, string>;

export interface EnrichSpec {
  /** Static `key=value` entries. */
  attrs?: readonly string[];
  /** `key=ENVVAR` entries: the attribute takes the env var's value when set. */
  attrEnv?: readonly string[];
}

export interface ResolvedEnrich {
  attributes: EnrichAttributes;
  warnings: string[];
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function splitPair(entry: string): [string, string] | undefined {
  const i = entry.indexOf('=');
  if (i <= 0) return undefined;
  const key = entry.slice(0, i).trim();
  if (key === '') return undefined;
  return [key, entry.slice(i + 1)];
}

/**
 * Resolve static and env-sourced attributes. Static entries apply first; an
 * env mapping for the same key overrides it when the variable is set. Never
 * throws: every bad entry becomes a warning and is skipped.
 */
export function resolveEnrichAttributes(
  spec: EnrichSpec,
  env: Record<string, string | undefined> = process.env,
): ResolvedEnrich {
  const attributes: EnrichAttributes = {};
  const warnings: string[] = [];
  for (const entry of spec.attrs ?? []) {
    const pair = splitPair(String(entry));
    if (pair === undefined) {
      warnings.push(`--attr '${entry}' is not key=value; skipped`);
      continue;
    }
    attributes[pair[0]] = pair[1];
  }
  for (const entry of spec.attrEnv ?? []) {
    const pair = splitPair(String(entry));
    if (pair === undefined) {
      warnings.push(`--attr-env '${entry}' is not key=ENVVAR; skipped`);
      continue;
    }
    const [key, name] = [pair[0], pair[1].trim()];
    if (!ENV_NAME_RE.test(name)) {
      warnings.push(`--attr-env '${entry}': '${name}' is not an env var name; skipped`);
      continue;
    }
    const value = env[name];
    if (value === undefined || value === '') {
      warnings.push(`--attr-env ${key}: env ${name} is not set; skipped`);
      continue;
    }
    attributes[key] = value;
  }
  return { attributes, warnings };
}

/**
 * Validate an attribute map handed over as an object (the MCP tool input).
 * Non-string values and empty keys are skipped with a warning.
 */
export function sanitizeEnrichAttributes(input: unknown): ResolvedEnrich {
  const attributes: EnrichAttributes = {};
  const warnings: string[] = [];
  if (input === undefined || input === null) return { attributes, warnings };
  if (typeof input !== 'object' || Array.isArray(input)) {
    warnings.push('attributes must be an object of string values; ignored');
    return { attributes, warnings };
  }
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (k.trim() === '') {
      warnings.push('attributes: empty key skipped');
    } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      attributes[k] = String(v);
    } else {
      warnings.push(`attributes.${k}: not a string; skipped`);
    }
  }
  return { attributes, warnings };
}

/** True when there is anything to stamp. */
export function hasEnrichAttributes(attrs: EnrichAttributes | undefined): attrs is EnrichAttributes {
  return attrs !== undefined && Object.keys(attrs).length > 0;
}

// ---------------------------------------------------------------- user module

/** What a user enricher module is called with: one call per OTel/Langfuse
 *  span (kind `span`), or once per ATIF trajectory (kind `trajectory`). */
export interface EnricherInput {
  kind: 'span' | 'trajectory';
  /** Span name (`invoke_agent X`, `chat M`, `execute_tool T`); the agent name for a trajectory. */
  name: string;
  /** `invoke_agent` | `chat` | `execute_tool` for spans; `trajectory` for ATIF. */
  operation: string;
  /** A copy of the span's built-in attributes (empty for a trajectory). */
  attributes: Record<string, string | number>;
  startTimeMs?: number;
  endTimeMs?: number;
  run: { format: string; sessionId: string; agent: string; model: string };
}

export type EnricherFn = (input: EnricherInput) => unknown;

/** Per-call limit for an async enricher (ms). */
export const ENRICHER_TIMEOUT_MS = 5_000;

/** Resolve an `--enricher` path: absolute stays, relative joins `base`
 *  (the cwd for the flag; config-file values arrive already resolved
 *  against the file's directory via PATH_FLAGS). */
export function resolveEnricherPath(p: string, base: string = process.cwd()): string {
  return path.isAbsolute(p) ? p : path.resolve(base, p);
}

/** Dynamic-import a user enricher. Never throws: a load failure or a
 *  module without a function default export returns a warning instead. */
export async function loadEnricher(absPath: string): Promise<{ fn?: EnricherFn; warning?: string }> {
  let mod: unknown;
  try {
    mod = await import(pathToFileURL(absPath).href);
  } catch (e) {
    return { warning: `--enricher '${absPath}' failed to load (${e instanceof Error ? e.message : String(e)}); exporting without it` };
  }
  const fn = (mod as { default?: unknown } | null)?.default;
  if (typeof fn !== 'function') {
    return { warning: `--enricher '${absPath}' has no default export function; exporting without it` };
  }
  return { fn: fn as EnricherFn };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Call a user enricher once per input, in order. The first failure (throw,
 * rejection, timeout, or a return that is not a plain object) prints one
 * warning and disables the enricher for the rest of the export; results so
 * far are kept. Non-scalar values inside a returned object are dropped.
 * Never throws.
 */
export async function runEnricher(
  fn: EnricherFn,
  inputs: readonly EnricherInput[],
  timeoutMs: number = ENRICHER_TIMEOUT_MS,
): Promise<{ results: (EnrichAttributes | undefined)[]; warnings: string[] }> {
  const results: (EnrichAttributes | undefined)[] = [];
  const warnings: string[] = [];
  for (const input of inputs) {
    let out: unknown;
    try {
      out = await withTimeout(Promise.resolve().then(() => fn(structuredClone(input))), timeoutMs);
    } catch (e) {
      warnings.push(`--enricher failed on ${input.kind} '${input.name}' (${e instanceof Error ? e.message : String(e)}); exporting without it from here on`);
      break;
    }
    if (out === undefined || out === null) {
      results.push(undefined);
      continue;
    }
    if (typeof out !== 'object' || Array.isArray(out)) {
      warnings.push(`--enricher returned ${Array.isArray(out) ? 'an array' : typeof out} for ${input.kind} '${input.name}', expected an attributes object; exporting without it from here on`);
      break;
    }
    const attrs: EnrichAttributes = {};
    for (const [k, v] of Object.entries(out as Record<string, unknown>)) {
      if (k.trim() !== '' && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) attrs[k] = String(v);
    }
    results.push(Object.keys(attrs).length > 0 ? attrs : undefined);
  }
  return { results, warnings };
}
