// Availability classification (agentic-coding-harness#60): tell "the agent
// CLI / vendor service was not there" apart from "the agent tried the task
// and failed". A run classified `unavailable` carries no verdict about the
// task, so success-rate rollups (ach stats, report, /api/compare) leave it
// out of the denominator by default.
//
// The rules are deliberately NARROW. Every signal below is harness- or
// adapter-originated; nothing here scans tool output or the agent's own
// messages, so a task that curls a dead endpoint (and reports the 503 in a
// tool_result) still records `error`, never `unavailable`.
//
//   1. spawn failure — the adapter's own "failed to spawn <cmd>: … ENOENT /
//      EACCES" error event (runJsonlCli in src/adapters/shared.ts), or a
//      launch() that throws the same errno before any handle exists (kiro
//      ACP / opencode server transports). The binary is missing or not
//      executable.
//   2. crash before the first event — the adapter exited `error` without a
//      single agent-activity event (message / tool_call / tool_result /
//      usage / usage_raw / step). A `session` announcement and stderr
//      `progress` lines are NOT activity: an unauthenticated CLI or a vendor
//      outage typically prints a banner to stderr and exits non-zero before
//      the model produced anything.
//
//   3. auth failure — an adapter-originated `error` event tagged
//      `data.kind === 'auth_failed'` (claude's "Not logged in" stream). The
//      adapter saw the CLI itself refuse for lack of credentials, so the run
//      is `unavailable` even though an assistant turn preceded it; the event's
//      message (the fix) becomes the reason.
//
// Caveat (documented in docs/EXIT-CODES.md): rule 2 also catches a CLI that
// rejects its own arguments before starting (e.g. an unknown --model). Such
// a run produced no task verdict either, so "no data" is the honest bucket.

import { existsSync } from 'node:fs';
import type { AdapterExit, AgentEvent } from './types.ts';

/** Event types that prove the agent actually started working on the task. */
const ACTIVITY_TYPES: ReadonlySet<string> = new Set([
  'message',
  'tool_call',
  'tool_result',
  'usage',
  'usage_raw',
  'step',
]);

/** errno tokens that mean "the executable could not be started". */
const SPAWN_ERRNO = /\b(ENOENT|EACCES|ENOEXEC)\b/;

function eventText(e: AgentEvent): string {
  for (const v of [e.message, e.content, e.data, e.text]) {
    if (typeof v === 'string' && v !== '') return v;
  }
  return '';
}

/** True for the adapter-originated spawn-failure error event (rule 1). */
export function isSpawnFailureEvent(e: AgentEvent): boolean {
  if (e.type !== 'error') return false;
  const text = eventText(e);
  return /failed to spawn\b/i.test(text) && SPAWN_ERRNO.test(text);
}

/** True for an adapter-originated "not logged in" error event (rule 3). */
export function isAuthFailureEvent(e: AgentEvent): boolean {
  if (e.type !== 'error') return false;
  const data = e.data as { kind?: unknown } | null | undefined;
  return typeof data === 'object' && data !== null && data.kind === 'auth_failed';
}

export interface AvailabilityInput {
  /** What the adapter's handle.wait() reported. */
  adapterExit: AdapterExit;
  /** Every event the run observed, in order. */
  events: readonly AgentEvent[];
}

/**
 * Classify a settled run. Returns a short human reason when the run must be
 * recorded `unavailable`, or null when the adapter's own verdict stands.
 * Only an `error` exit is ever reclassified: success, abort, cancellation
 * and timeouts keep their meaning.
 */
export function classifyUnavailable(input: AvailabilityInput): string | null {
  if (input.adapterExit !== 'error') return null;
  const spawnFailure = input.events.find(isSpawnFailureEvent);
  if (spawnFailure !== undefined) {
    return `agent CLI could not be started (${eventText(spawnFailure)})`;
  }
  const authFailure = input.events.find(isAuthFailureEvent);
  if (authFailure !== undefined) return eventText(authFailure) || 'agent CLI is not logged in';
  const active = input.events.some((e) => ACTIVITY_TYPES.has(e.type));
  if (!active) {
    return 'agent CLI exited with an error before its first event (missing auth, service outage, or a startup failure)';
  }
  return null;
}

/**
 * Classify an error THROWN by adapter.launch() (rule 1, launch-time form).
 * Node reports a nonexistent spawn cwd with the same `spawn <cmd> ENOENT`
 * text as a missing binary, so a caller-supplied cwd that does not exist is
 * a caller error, never `unavailable`.
 */
export function classifyLaunchError(err: unknown, cwd?: string): string | null {
  if (typeof cwd === 'string' && cwd !== '' && !existsSync(cwd)) return null;
  const code = (err as { code?: unknown } | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  const spawnish = /\bspawn\b/i.test(message) || /failed to spawn\b/i.test(message);
  if ((typeof code === 'string' && SPAWN_ERRNO.test(code) && spawnish) || (spawnish && SPAWN_ERRNO.test(message))) {
    return `agent CLI could not be started (${message})`;
  }
  return null;
}
