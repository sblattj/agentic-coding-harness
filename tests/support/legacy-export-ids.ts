// #73 regression support: render the OTel and Langfuse exports of a fixed
// event stream with randomUUID and Date.now stubbed, so the ids an export
// generates are deterministic. tests/trace-context-legacy-ids.test.ts compares
// the result to a golden captured from the pre-#73 emitters: a record without
// a `trace` field must still export byte-for-byte what it did before.
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";

export const LEGACY_EVENTS = [
  { type: "message", role: "user", content: "fix the bug", timestamp: "2026-01-01T00:00:00.000Z" },
  {
    type: "usage",
    timestamp: "2026-01-01T00:00:01.000Z",
    usage: { agent: "claude", model: "model-a", inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 0, costUsd: 0.01 },
  },
  { type: "tool_call", toolCallId: "call-1", functionName: "Read", arguments: { path: "a.txt" }, timestamp: "2026-01-01T00:00:02.000Z" },
  { type: "tool_result", toolCallId: "call-1", content: "ok", timestamp: "2026-01-01T00:00:03.000Z" },
  {
    type: "usage",
    timestamp: "2026-01-01T00:00:04.000Z",
    usage: {
      agent: "claude",
      model: "model-a",
      inputTokens: 300,
      outputTokens: 40,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.03,
      extra: {
        raw: {
          models: [
            { model: "model-a", input: 200, output: 30, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0.02 },
            { model: "model-b", input: 100, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0.01 },
          ],
        },
      },
    },
  },
] as const;

export const LEGACY_OPTS = { sessionId: "session-1", agentName: "claude", model: "model-a" };

/** Install deterministic randomUUID / Date.now; returns the restore function. */
export function stubIdSources(): () => void {
  const origUuid = crypto.randomUUID;
  const origNow = Date.now;
  let n = 0;
  (crypto as { randomUUID: () => string }).randomUUID = () => {
    n += 1;
    const h = n.toString(16).padStart(8, "0");
    return `${h}-aaaa-4bbb-8ccc-${h}dddd`;
  };
  syncBuiltinESMExports();
  Date.now = () => 1_767_225_600_000;
  return () => {
    (crypto as { randomUUID: () => string }).randomUUID = origUuid;
    syncBuiltinESMExports();
    Date.now = origNow;
  };
}

type Doc = { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<Record<string, unknown>> }> }> };

/**
 * The id-bearing fields of every span in both exports, as JSON. Only ids,
 * names and times: #73 must not move any of them, while attributes and
 * resources are other features' business (a whole-document golden would break
 * on every unrelated attribute change).
 */
function idsOf(doc: unknown): unknown[] {
  return (doc as Doc).resourceSpans.flatMap((rs) =>
    rs.scopeSpans.flatMap((ss) =>
      ss.spans.map((sp) => ({
        name: sp.name,
        traceId: sp.traceId,
        spanId: sp.spanId,
        parentSpanId: sp.parentSpanId ?? null,
        startTimeUnixNano: sp.startTimeUnixNano,
        endTimeUnixNano: sp.endTimeUnixNano,
      })),
    ),
  );
}

export function renderLegacy(
  toOtlpJson: (events: never, opts: typeof LEGACY_OPTS) => unknown,
  toLangfuseOtlpJson: (events: never, opts: typeof LEGACY_OPTS) => unknown,
): string {
  const otel = toOtlpJson(JSON.parse(JSON.stringify(LEGACY_EVENTS)) as never, { ...LEGACY_OPTS });
  const langfuse = toLangfuseOtlpJson(JSON.parse(JSON.stringify(LEGACY_EVENTS)) as never, { ...LEGACY_OPTS });
  return JSON.stringify({ otel: idsOf(otel), langfuse: idsOf(langfuse) }, null, 2) + "\n";
}
