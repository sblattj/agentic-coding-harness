// Read-only GitHub Copilot CLI session monitor (#23).
//
// Where: ${COPILOT_HOME:-~/.copilot}/session-state/<session-id>/events.jsonl
//   (copilot 1.0.93). The usage record is `type: "session.shutdown"`, and its
//   `data` is CUMULATIVE for the whole session: a resumed session appends a
//   second shutdown whose totals already include the first. So a session is
//   exactly ONE usage snapshot: the LAST shutdown, never the sum.
//
// This module does not parse Copilot's schema itself. It reuses the launch
// adapter's parser (parseCopilotShutdownEvents) and its AIU conversion
// (copilotUsageEvents, src/adapters/copilot.ts), so `ach run --agent copilot`
// and `ach stats` over past sessions agree on tokens and cost.
//
// Accounting (all in copilotUsageEvents):
//  - cost = reported AIU converted at $0.01/AIU, never token math. AIU missing
//    or 0 (BYOK / unmetered): tokens still recorded, cost unavailable, plus a
//    warning. Records carry extra.vendorMetered so no consumer token-prices them.
//  - Copilot's inputTokens includes cache reads/writes; the record's `input`
//    is the uncached slice.
//  - AIU rides in extra.credits (unit "copilot", never summed with kiro credits).
//  - A session with no shutdown (still running, or the CLI was killed) yields
//    nothing and a warning: its partial usage was never summarised.
//
// Double counting with `ach run`: a session `ach run --agent copilot` launched
// is already in the harness state; the stats/dash consumers drop the transcript
// copy by (agent, sessionId) (src/cli/ach.ts runOwned, src/cli/transcript-view.ts claimed).

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { copilotUsageEvents, parseCopilotShutdownEvents } from "../adapters/copilot.ts";
import type { CanonicalTokenRecord } from "./transcripts.ts";
import { warnTranscript, type WarnFn } from "./transcript-warnings.ts";

/**
 * Default session-state root for a home-shaped dir. `$COPILOT_HOME` relocates
 * it, but only for the REAL home: a `--transcript-dir` root always means
 * `<root>/.copilot/session-state`.
 */
export function copilotSessionStateRoot(home: string): string {
  const override = process.env.COPILOT_HOME;
  const base = home === homedir() && override !== undefined && override !== "" ? override : join(home, ".copilot");
  return join(base, "session-state");
}

/** A Copilot session log: `<...>/session-state/<session-id>/events.jsonl`. */
export function isCopilotEventsFile(filePath: string): boolean {
  return basename(filePath) === "events.jsonl" && basename(dirname(dirname(filePath))) === "session-state";
}

export async function parseCopilotSession(
  path: string,
  warn: WarnFn = warnTranscript,
): Promise<CanonicalTokenRecord[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    warn(`copilot: skipped unreadable session file ${path}: ${(err as Error).message}`);
    return [];
  }
  const sessionId = basename(dirname(path));
  const shutdowns = parseCopilotShutdownEvents(text.replace(/^﻿/, ""), (lineNo) =>
    warn(`copilot: ${path}: skipped line ${lineNo} (invalid JSON)`),
  );
  const last = shutdowns[shutdowns.length - 1];
  if (last === undefined) {
    warn(`copilot: ${path}: no session.shutdown event (session still running or killed); usage unavailable, not estimated`);
    return [];
  }
  const { events, warnings } = copilotUsageEvents(last.summary, "events.jsonl");
  for (const w of warnings) warn(`${w} [${path}]`);
  const out: CanonicalTokenRecord[] = [];
  for (const ev of events) {
    if (ev.type !== "usage") continue;
    const t = ev.tokens;
    const ex = ((t as { extra?: Record<string, unknown> }).extra ?? {});
    const model = (ev as { model?: string }).model ?? null;
    out.push({
      agent: "copilot",
      sessionId,
      timestamp: last.timestamp,
      model,
      input: t.inputTokens ?? 0,
      output: t.outputTokens ?? 0,
      cacheRead: t.cacheReadTokens ?? 0,
      cacheWrite: t.cacheWriteTokens ?? 0,
      // Reasoning tokens are already inside outputTokens and not reported separately.
      reasoning: 0,
      ...(typeof ev.cost === "number" ? { costUsd: ev.cost } : {}),
      extra: {
        vendorMetered: true,
        costBasis: "copilot-aiu",
        ...(typeof ex.credits === "number" ? { credits: ex.credits, creditUnit: "copilot" } : {}),
        ...(ex.tokensAvailable === false ? { tokensAvailable: false } : {}),
      },
    });
  }
  return out;
}
