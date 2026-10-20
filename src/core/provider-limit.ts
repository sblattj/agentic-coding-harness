// Provider-limit detection: tell "the model provider refused more work"
// (subscription usage cap, rate limit, HTTP 429, overloaded) apart from "the
// agent tried the task and failed". Such a run carries no verdict about the
// task, so `ach trial --matrix` records it `skipped-provider-limit` and runs
// it again next time, the way it treats an unavailable CLI.
//
// Like src/core/availability.ts the scan is deliberately narrow: only
// harness- or adapter-originated text (error events, their stderr tail, and
// stderr `progress` lines). Agent messages and tool output are never read,
// so a task ABOUT rate limiting cannot trip it.

import type { AgentEvent } from './types.ts';

/** Provider usage/rate-limit wording seen in agent CLI streams and stderr. */
export const PROVIDER_LIMIT_RE =
  /hit your (?:session|usage|weekly|daily|monthly) limit|usage limit (?:has been |was )?reached|temporarily limiting requests|rate[ _-]?limit(?:ed|_error)?\b|overloaded(?:_error)?\b|too many requests|\b(?:HTTP|status(?: code)?|error)[ :/]*429\b/i;

/** True when `text` reads like a provider usage/rate limit. */
export function isProviderLimitText(text: string | undefined | null): boolean {
  return typeof text === 'string' && text !== '' && PROVIDER_LIMIT_RE.test(text);
}

/** Error-lane text of one event: error message + data.stderrTail, or a stderr progress line. */
function errorLaneTexts(e: AgentEvent): string[] {
  if (e.type === 'error') {
    const data = e.data as { stderrTail?: unknown; message?: unknown } | null | undefined;
    const out: string[] = [];
    if (typeof e.message === 'string') out.push(e.message);
    if (typeof data === 'object' && data !== null) {
      if (typeof data.stderrTail === 'string') out.push(data.stderrTail);
      if (typeof data.message === 'string') out.push(data.message);
    }
    return out;
  }
  if (e.type === 'progress' && typeof e.text === 'string') return [e.text];
  return [];
}

/** True for an adapter-originated error event tagged `data.kind === 'provider_limit'`. */
export function isProviderLimitEvent(e: AgentEvent): boolean {
  if (e.type !== 'error') return false;
  const data = e.data as { kind?: unknown } | null | undefined;
  return typeof data === 'object' && data !== null && data.kind === 'provider_limit';
}

/**
 * The first error-lane text (never agent messages or tool output) that shows
 * a provider limit, trimmed to one short line; null when there is none.
 */
export function providerLimitReason(events: readonly AgentEvent[]): string | null {
  for (const e of events) {
    const texts = errorLaneTexts(e);
    const hit = isProviderLimitEvent(e) ? texts[0] ?? 'provider limit' : texts.find(isProviderLimitText);
    if (hit === undefined) continue;
    const line = hit.split('\n').find(isProviderLimitText) ?? hit.split('\n')[0] ?? hit;
    return line.trim().slice(0, 300);
  }
  return null;
}

/** True when the run's error lane shows a provider limit. */
export function hitProviderLimit(events: readonly AgentEvent[]): boolean {
  return providerLimitReason(events) !== null;
}
