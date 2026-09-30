// Per-frame context-window annotation for the web feed.
//
// The feed (feed.js) draws a small context gauge on every row. It must not
// redo occupancy math or carry a window table, so the server runs ONE
// context meter (src/core/context-meter.ts, the single source of truth) per
// run socket over the transcript in order and stamps each outgoing event
// with a compact `ctx` field describing the reading at that frame.
//
// Semantics (see docs/TOKEN-COUNTING.md §5):
//  - The reading at a frame is the meter's latest usage record at or before
//    it; events that carry no usage (tool calls, tool results, claude's final
//    run-aggregate usage row) carry the reading forward with `fresh: false`.
//  - `fresh: true` marks the event that fed the current reading. Claude emits
//    one `message` per content block with byte-identical usage, so several
//    events of one model call are fresh and share one `seq`.
//  - `delta` is the change against the previous DISTINCT reading (the first
//    reading counts from 0); it rides every event of that reading (`seq`) so a
//    renderer can show it once, on the first of those rows it actually draws.
//  - No meter for the agent (kiro, custom) or no usage yet → no field at all.
//    An unknown window keeps `tokens` but omits `window`/`pct`.
import type { AgentEvent, CanonicalTokenRecord } from "../core/types.ts";
import { CONTEXT_WARN_FRACTION, createContextMeter } from "../core/context-meter.ts";

export interface ContextFrame {
  /** Occupancy: input + cache read + cache write of the reading's usage record. */
  tokens: number;
  /** 'turn-total' is an UPPER BOUND (a usage summed over a turn's calls). */
  basis: "last-call" | "turn-total";
  /** True when this event fed the reading; false when it is carried forward. */
  fresh: boolean;
  /** 1-based ordinal of the distinct reading this frame shows. */
  seq: number;
  /**
   * Change of reading `seq` against the previous distinct reading, on every
   * frame of that reading: a tool-only model call's content block is empty and
   * never drawn, so its tool card is the first row that can show the growth.
   */
  delta: number;
  /** Context window (max input tokens); absent when the model's window is unknown. */
  window?: number;
  /** tokens / window × 100; absent with `window`. */
  pct?: number;
  /** Warn threshold as a fraction of the window (CONTEXT_WARN_FRACTION). */
  warnAt?: number;
  model?: string;
  /** Breakdown of the reading's usage record; present on fresh frames. */
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface FrameAnnotator {
  /** Feed the next event in transcript order; returns its frame, if any. */
  annotate(event: AgentEvent): ContextFrame | undefined;
}

export interface FrameAnnotatorOptions {
  agent: string | undefined;
  /** Model fallback when no event names one (e.g. the run's resolved model). */
  requestedModel?: string;
}

/** An annotator for a run, or null when the agent has no context meter. */
export function createFrameAnnotator(opts: FrameAnnotatorOptions): FrameAnnotator | null {
  if (typeof opts.agent !== "string" || opts.agent === "") return null;
  const meter = createContextMeter({
    agent: opts.agent,
    ...(opts.requestedModel !== undefined ? { requestedModel: opts.requestedModel } : {}),
  });
  if (meter === null) return null;

  let lastRecord: CanonicalTokenRecord | undefined;
  let lastTokens = 0;
  let seq = 0;
  let delta = 0;

  return {
    annotate(event: AgentEvent): ContextFrame | undefined {
      meter.observe(event);
      const reading = meter.reading();
      if (reading === undefined) return undefined;
      const fresh = reading.record !== lastRecord;
      if (fresh) {
        lastRecord = reading.record;
        if (seq === 0 || reading.tokens !== lastTokens) {
          delta = reading.tokens - lastTokens;
          lastTokens = reading.tokens;
          seq += 1;
        }
      }
      const snap = meter.snapshot();
      const frame: ContextFrame = { tokens: reading.tokens, basis: reading.basis, fresh, seq, delta };
      if (fresh) {
        frame.input = reading.record.inputTokens ?? 0;
        frame.cacheRead = reading.record.cacheReadTokens ?? 0;
        frame.cacheWrite = reading.record.cacheWriteTokens ?? 0;
      }
      if (snap?.available === true && snap.windowTokens !== undefined) {
        frame.window = snap.windowTokens;
        frame.pct = (reading.tokens / snap.windowTokens) * 100;
        frame.warnAt = CONTEXT_WARN_FRACTION;
      }
      if (snap?.model !== undefined) frame.model = snap.model;
      return frame;
    },
  };
}
