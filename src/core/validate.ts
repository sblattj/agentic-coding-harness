// RunSpec entry-point validation (agentic-coding-harness#10).
//
// Driver.run() fails fast HERE, before any adapter launches: schema shape
// (RunSpecSchema in src/core/types.ts) plus the model-pinning requirements.
// Every rejection is a HarnessError('INVALID_SPEC') whose message names the
// field path and the violated constraint (with the offending value), so a bad
// call surfaces at the entry point instead of as a mid-run abort.
import type { z } from 'zod';
import { HarnessError, RunSpecSchema, type RunSpec } from './types.js';

/** Walk `path` into `root`; undefined when it does not resolve. */
function lookup(root: unknown, path: PropertyKey[]): unknown {
  let cur: unknown = root;
  for (const key of path) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[String(key)];
  }
  return cur;
}

/** Human-readable rendering of an offending value: quoted strings, NaN/Infinity verbatim. */
function showValue(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'object' && v !== null) {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s;
  }
  return String(v);
}

/**
 * Render one zod issue as `spec.<path>: <message> (got <value>)`. The value
 * comes from the offending spec itself (zod issues do not carry it); for
 * missing fields it falls back to the type-level `received` ("undefined").
 */
function renderIssue(issue: z.core.$ZodIssue, spec: unknown): string {
  const path = issue.path.length > 0 ? `spec.${issue.path.join('.')}` : 'spec';
  const value = lookup(spec, issue.path);
  const received = (issue as { received?: unknown }).received;
  const got =
    value !== undefined && typeof value !== 'function'
      ? ` (got ${showValue(value)})`
      : typeof received === 'string'
        ? ` (got ${received})`
        : '';
  return `${path}: ${issue.message}${got}`;
}

export interface RunSpecValidationOptions {
  /**
   * AgentAdapter.requiresModel: the target adapter cannot run without an
   * explicit model. Kiro's spec-conditional requirement — an ACP run with
   * spec.kiro.requireModelAck needs a model to acknowledge — is enforced
   * regardless of this flag. (Headless kiro has no model-ack mechanism, so
   * requireModelAck there is tolerated exactly as before.)
   */
  requiresModel?: boolean;
}

/** True when the spec pins an explicit, non-empty model. */
function modelPinned(spec: RunSpec): boolean {
  return typeof spec.model === 'string' && spec.model.length > 0;
}

/**
 * Validate a run spec exactly as Driver.run() does and return the parsed
 * spec. Throws HarnessError('INVALID_SPEC') on the first violated rule, with
 * clear field-path messages. Exported so callers (MCP tools, CLI, tests) can
 * pre-validate a spec with the same verdict the driver will reach.
 */
export function parseRunSpec(
  agent: string,
  spec: RunSpec,
  opts: RunSpecValidationOptions = {},
): RunSpec {
  const parsed = RunSpecSchema.safeParse(spec);
  if (!parsed.success) {
    throw new HarnessError(
      `invalid run spec: ${parsed.error.issues.map((i) => renderIssue(i, spec)).join('; ')}`,
      'INVALID_SPEC',
    );
  }
  const data = parsed.data;
  // Kiro ACP acknowledges a model via session/set_model; requiring an ack
  // without pinning a model is contradictory and would otherwise surface as
  // a mid-run handshake failure — fail it here with the reason instead.
  const kiroAcpNeedsModel = data.kiro?.requireModelAck === true && data.kiro?.transport === 'acp';
  if (!modelPinned(data) && (opts.requiresModel === true || kiroAcpNeedsModel)) {
    const why =
      kiroAcpNeedsModel
        ? 'spec.kiro.requireModelAck asked for a model acknowledgement, but no model is set to acknowledge'
        : `agent "${agent}" requires a pinned model`;
    throw new HarnessError(
      `invalid run spec: spec.model must be a non-empty string — ${why}`,
      'INVALID_SPEC',
    );
  }
  return data;
}
