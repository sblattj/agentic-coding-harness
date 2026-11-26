// `ach context <runId>` (issue #87): what filled a run's context window.
//
// Reads the run's persisted events (the same reader the web /trio page uses,
// RunEventHub.readTranscript) and its RunRecord's context reading, then
// prints the composition from src/core/context-composition.ts. Offline: no
// agent re-run, no network, no cost.
import fs from "node:fs";
import { parseArgs } from "node:util";
import { HarnessError } from "../core/types.ts";
import { stateDir as defaultStateDir } from "../core/store.ts";
import { listRunRecords, registryDir, resolveRawTranscript } from "../core/registry.ts";
import {
  CONTEXT_TOP_TOOLS,
  compositionInput,
  deriveContextComposition,
  type ContextComposition,
} from "../core/context-composition.ts";
import { createRunEventHub } from "../web/hub.ts";
import { fmtInt, resolveDirFlag } from "./lib.ts";
import { lookupRunRecord } from "./verify-run.ts";

export const CONTEXT_USAGE = `ach context <runId> [--json] [--state-dir <stateDir>]
  (--dir is an alias of --state-dir.)
  Splits the run's context window (the latest model call's prompt tokens) into
  prompt/user, assistant text, reasoning, tool calls, tool results (top ${CONTEXT_TOP_TOOLS}
  tools by context share) and the unattributed remainder (system prompt, tool
  schemas, text the adapter does not record), from the run's stored events.
  Components are estimates (characters / 4); n/a means the adapter or the
  capture tier gave no data for it. --json emits the full component map and
  every tool. See docs/CONTEXT.md.`;

const pct = (share: number | null): string => (share === null ? "n/a" : `${(share * 100).toFixed(1)}%`);
const tok = (n: number | null): string => (n === null ? "n/a" : fmtInt(n));

/** Human table for one run's composition. */
export function formatContextComposition(runId: string, agent: string, c: ContextComposition): string {
  const out: string[] = [];
  const totalLine =
    c.total.tokens === null
      ? `context    n/a (${c.total.reason ?? "unknown"})`
      : `context    ${fmtInt(c.total.tokens)} tok (latest model call, ${c.total.source === "record" ? "recorded" : "re-derived from events"})`;
  out.push(`run ${runId}  (${agent})`);
  out.push(totalLine);
  const of = c.denominator === "attributed" ? "% of attributed" : "% of context";
  const labelW = Math.max(...c.components.map((x) => x.label.length), 14);
  out.push(`${"component".padEnd(labelW)}  ${"tokens".padStart(10)}  ${of.padStart(16)}`);
  for (const comp of c.components) {
    const line = `${comp.label.padEnd(labelW)}  ${tok(comp.tokens).padStart(10)}  ${pct(comp.share).padStart(16)}`;
    out.push(comp.tokens === null && comp.reason !== undefined ? `${line}  (${comp.reason})` : line);
  }
  if (c.sumTokens !== null && c.total.tokens !== null) {
    const verdict =
      c.withinTolerance === null
        ? ""
        : c.overshoot === 0
          ? "parts sum to the total"
          : c.withinTolerance
            ? `within the ${Math.round(c.tolerance * 100)}% tolerance`
            : `OUTSIDE the ${Math.round(c.tolerance * 100)}% tolerance`;
    out.push(`sum        ${fmtInt(c.sumTokens)} of ${fmtInt(c.total.tokens)} tok${verdict !== "" ? ` (${verdict})` : ""}`);
  }
  if (c.tools.length > 0) {
    out.push("");
    out.push(`tools (top ${Math.min(CONTEXT_TOP_TOOLS, c.tools.length)} of ${c.tools.length} by context share)`);
    const nameW = Math.max(...c.tools.slice(0, CONTEXT_TOP_TOOLS).map((t) => t.name.length), 4);
    out.push(`${"tool".padEnd(nameW)}  ${"calls".padStart(5)}  ${"tokens".padStart(10)}  ${"results".padStart(10)}  ${of.padStart(16)}`);
    for (const t of c.tools.slice(0, CONTEXT_TOP_TOOLS)) {
      out.push(
        `${t.name.padEnd(nameW)}  ${String(t.calls).padStart(5)}  ${tok(t.tokens).padStart(10)}  ${tok(t.resultTokens).padStart(10)}  ${pct(t.share).padStart(16)}`,
      );
    }
    const rest = c.tools.slice(CONTEXT_TOP_TOOLS);
    if (rest.length > 0) {
      const restTok = rest.every((t) => t.tokens !== null) ? rest.reduce((a, t) => a + (t.tokens as number), 0) : null;
      out.push(`+${rest.length} more tool${rest.length === 1 ? "" : "s"} (${tok(restTok)} tok; --json lists all)`);
    }
  }
  out.push("");
  out.push(`compactions ${c.compactions.count === null ? `n/a (${c.compactions.reason ?? "not recorded"})` : String(c.compactions.count)}`);
  if (c.reported !== undefined) {
    out.push(
      `reported   ${Object.entries(c.reported)
        .map(([k, v]) => `${k}=${fmtInt(v)}`)
        .join(" ")} (agent's own category split)`,
    );
  }
  out.push(`events     ${c.eventsCounted} of ${c.eventsTotal} counted (before the latest model call)`);
  out.push(`method     ${c.method}`);
  return out.join("\n") + "\n";
}

export async function cmdContext(rest: string[], write: (chunk: string) => void = (s) => void process.stdout.write(s)): Promise<number> {
  const args = parseArgs({
    args: rest,
    options: {
      json: { type: "boolean", default: false },
      dir: { type: "string" },
      "state-dir": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });
  if (args.values.help) {
    write(CONTEXT_USAGE + "\n");
    return 0;
  }
  const [runId, ...extra] = args.positionals;
  if (runId === undefined || extra.length > 0) throw new HarnessError("context expects exactly one <runId>", "USAGE");
  const stateDir = resolveDirFlag(args.values, "state-dir") ?? defaultStateDir();
  const found = lookupRunRecord(stateDir, runId);
  if (!found.ok) {
    if ("missing" in found) throw new HarnessError(`context: no run '${runId}' under ${registryDir(stateDir)}`, "NOT_FOUND");
    throw new HarnessError(`context: RunRecord ${runId}.json is unreadable (${found.reason})`, "NOT_FOUND");
  }
  const rec = found.record;
  const transcript = resolveRawTranscript(stateDir, rec);
  if (!transcript || !fs.existsSync(transcript)) {
    throw new HarnessError(`context: run '${runId}' has no stored event log${transcript ? ` (${transcript} is missing)` : ""}`, "NOT_FOUND");
  }
  const events = await createRunEventHub(stateDir).readTranscript(rec.runId);
  const composition = deriveContextComposition(events, compositionInput(rec, listRunRecords(stateDir)));
  if (args.values.json) {
    write(JSON.stringify({ runId: rec.runId, agent: rec.agent, ...composition }, null, 2) + "\n");
  } else {
    write(formatContextComposition(rec.runId, rec.agent, composition));
  }
  return 0;
}
