// Codex native-session evidence for `ach run --agent codex` (issues #140, #142).
//
// `codex exec --json` streams usage per turn (turn.completed) but never names
// the model or reasoning effort that served it, and never reports usage of
// the sub-agent threads a turn spawned. The CLI's own rollout file
// (~/.codex/sessions/**/rollout-*-<threadId>.jsonl, $CODEX_HOME relocates it)
// records both: turn_context carries the observed model/effort, and
// SubAgentActivity events name the child threads, whose own rollouts carry
// their usage. This module reads that evidence after the run and states:
//   - requested vs observed model/effort, each labelled by where it came from;
//   - whether the stream's token totals are proven complete, and whether they
//     include child sessions (they never do: children are reconciled here).
//
// Never fabricates: no rollout -> observed stays absent and the requested model
// stays labelled "requested"; a child without a rollout is listed as missing,
// never counted as zero.
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  parseCodexRolloutSession,
  walkFiles,
  type CodexRolloutSession,
  type CodexTokenTotals,
} from "../monitors/transcripts.ts";
import type { CanonicalTokenRecord, UsageAvailability } from "./types.ts";

/**
 * Codex sessions root as the codex CHILD resolves it: $CODEX_HOME/sessions,
 * else $HOME/.codex/sessions. Pass the env the child actually ran with (the
 * run's env overrides, after scrubEnv) so a run under a different HOME or
 * CODEX_HOME is looked up where its rollout was written.
 */
export function codexSessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const codexHome = env.CODEX_HOME;
  if (codexHome !== undefined && codexHome !== "") return join(codexHome, "sessions");
  const home = env.HOME !== undefined && env.HOME !== "" ? env.HOME : homedir();
  return join(home, ".codex", "sessions");
}

const ROLLOUT_ID_RE = /-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/;

/** Map thread id -> rollout path for every rollout under `root` (file names only; nothing is read). */
export async function indexCodexRollouts(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const f of await walkFiles(root, (p) => basename(p).startsWith("rollout-") && p.endsWith(".jsonl"))) {
    const m = ROLLOUT_ID_RE.exec(basename(f));
    if (m?.[1] && !out.has(m[1])) out.set(m[1], f);
  }
  return out;
}

/** `-c model_reasoning_effort=<x>` (or `--config`) in codex extra args: the requested effort. */
export function requestedCodexEffort(args: readonly string[] | undefined): string | undefined {
  if (!args) return undefined;
  let found: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const value = a === "-c" || a === "--config" ? args[i + 1] : a?.startsWith("--config=") ? a.slice("--config=".length) : undefined;
    const m = value !== undefined ? /^model_reasoning_effort=["']?([^"']+)["']?$/.exec(value) : null;
    if (m?.[1]) found = m[1];
  }
  return found;
}

export interface CodexNativeInput {
  /** The codex thread id the stream reported (thread.started). */
  sessionId: string | null | undefined;
  /** The run's usage records (mutated: observed model/effort backfilled). */
  tokens: CanonicalTokenRecord[];
  /** `-m` value passed to codex, when the run requested one. */
  requestedModel?: string;
  /** `-c model_reasoning_effort=` value, when the run requested one. */
  requestedEffort?: string;
  /** Sessions root override (tests); default codexSessionsRoot(). */
  sessionsRoot?: string;
}

export interface CodexNativeResult {
  model: NonNullable<UsageAvailability["model"]>;
  /** Fields merged into usage.tokens (coverage/completeness, #142). */
  tokens: Pick<UsageAvailability["tokens"], "coverage" | "complete" | "childSessionIds" | "missingChildSessionIds" | "incompleteReasons" | "childInclusive">;
  warnings: string[];
}

function totalsOf(records: Iterable<{ input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number }>): CodexTokenTotals {
  const t: CodexTokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  for (const r of records) {
    t.input += r.input;
    t.output += r.output;
    t.cacheRead += r.cacheRead;
    t.cacheWrite += r.cacheWrite;
    t.reasoning += r.reasoning;
  }
  return t;
}

/** Own turns of a session, in order, with the model/effort each observed. */
function ownTurns(session: CodexRolloutSession): Array<{ turnId: string; model?: string; effort?: string }> {
  return session.turns;
}

/**
 * Read the run's native rollout (and its children's) and decide what the run
 * observed. Mutates `tokens`: a record whose model is missing/'unknown' gets
 * the observed model of its turn (extra.modelSource = 'observed'). Pricing is
 * NOT redone (it already ran per event and the totals are sealed), so an
 * "unknown model" pricing warning raised during the run stays true.
 */
export async function readCodexNativeUsage(input: CodexNativeInput): Promise<CodexNativeResult> {
  const warnings: string[] = [];
  const requested = input.requestedModel;
  const model: CodexNativeResult["model"] = {
    source: requested !== undefined ? "requested" : "unknown",
    ...(requested !== undefined ? { requested } : {}),
    ...(input.requestedEffort !== undefined ? { requestedEffort: input.requestedEffort } : {}),
  };
  const id = input.sessionId ?? undefined;
  const index = id ? await indexCodexRollouts(input.sessionsRoot ?? codexSessionsRoot()) : new Map<string, string>();
  const path = id ? index.get(id) : undefined;
  if (path === undefined) {
    warnings.push(
      `codex: observed model unavailable (no native rollout found for session ${id ?? "(none)"})` +
        (requested !== undefined ? `; '${requested}' is the REQUESTED model, not verified` : "; model unknown"),
    );
    return {
      model,
      tokens: { complete: false, incompleteReasons: ["native rollout not found: child sessions and completeness cannot be checked"] },
      warnings,
    };
  }

  const session = await parseCodexRolloutSession(path);
  const turns = ownTurns(session);
  model.observedSource = "rollout";
  if (session.models.length > 0) {
    model.observed = session.models;
    model.source = "native";
  }
  if (session.efforts.length > 0) model.observedEffort = session.efforts;
  if (session.models.length === 0) {
    warnings.push(
      `codex: native rollout for session ${id} records no model` +
        (requested !== undefined ? `; '${requested}' is the REQUESTED model, not verified` : ""),
    );
  }
  if (requested !== undefined && session.models.length > 0 && session.models.some((m) => m !== requested)) {
    model.mismatch = true;
    warnings.push(`codex: requested model '${requested}' but the native rollout recorded '${session.models.join("', '")}'`);
  }
  if (input.requestedEffort !== undefined && session.efforts.length > 0 && session.efforts.some((e) => e !== input.requestedEffort)) {
    model.effortMismatch = true;
    warnings.push(`codex: requested reasoning effort '${input.requestedEffort}' but the native rollout recorded '${session.efforts.join("', '")}'`);
  }

  // Backfill: the run's usage records are its LAST N turns (a resumed
  // session's rollout also holds earlier runs' turns). One observed model
  // fills every record; several are matched turn by turn from the end.
  const n = input.tokens.length;
  const runTurns = turns.slice(Math.max(0, turns.length - n));
  input.tokens.forEach((rec, i) => {
    if (rec.model !== undefined && rec.model !== "unknown") return;
    const turn = session.models.length === 1 ? { model: session.models[0], effort: runTurns[i - (n - runTurns.length)]?.effort } : runTurns[i - (n - runTurns.length)];
    if (!turn?.model) return;
    rec.model = turn.model;
    rec.extra = { ...rec.extra, modelSource: "observed", ...(turn.effort ? { observedEffort: turn.effort } : {}) };
  });

  // Completeness (#142): the stream's turn totals are proven complete only
  // when they equal the rollout's own counted totals for the same turns.
  const reasons: string[] = [];
  const runTurnIds = new Set(runTurns.map((t) => t.turnId));
  const nativeOwn = totalsOf(
    session.records.filter((r) => {
      const t = (r.extra?.codex as { turnId?: string } | undefined)?.turnId;
      return t !== undefined && runTurnIds.has(t);
    }),
  );
  const stream = totalsOf(
    input.tokens.map((r) => ({ input: r.inputTokens, output: r.outputTokens, cacheRead: r.cacheReadTokens, cacheWrite: r.cacheWriteTokens, reasoning: r.reasoningTokens ?? 0 })),
  );
  const agree = nativeOwn.input === stream.input && nativeOwn.output === stream.output && nativeOwn.cacheRead === stream.cacheRead;
  if (!agree) reasons.push("stream turn totals differ from the native rollout's");

  // Children: discovered from the parent's own events; their usage comes from
  // their own rollouts and is NEVER in the stream's totals.
  const children = session.childSessionIds;
  const counted: string[] = [];
  const missing: string[] = [];
  const childTotals: CodexTokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  const queue = [...children];
  const seen = new Set<string>([id!]);
  while (queue.length > 0) {
    const cid = queue.shift()!;
    if (seen.has(cid)) continue;
    seen.add(cid);
    const cpath = index.get(cid);
    if (cpath === undefined) {
      missing.push(cid);
      continue;
    }
    const child = await parseCodexRolloutSession(cpath);
    counted.push(cid);
    const t = totalsOf(child.records);
    childTotals.input += t.input;
    childTotals.output += t.output;
    childTotals.cacheRead += t.cacheRead;
    childTotals.cacheWrite += t.cacheWrite;
    childTotals.reasoning += t.reasoning;
    queue.push(...child.childSessionIds);
  }
  const all = [...counted, ...missing];
  if (all.length > 0) reasons.push(`run totals are parent-only: ${all.length} child session(s) are not in the stream's counters`);
  if (missing.length > 0) reasons.push(`${missing.length} child session(s) have no native rollout: their usage is unknown`);
  const tokens: CodexNativeResult["tokens"] = {
    coverage: all.length === 0 ? "session" : "parent-only",
    complete: agree && all.length === 0,
    ...(all.length > 0 ? { childSessionIds: all } : {}),
    ...(missing.length > 0 ? { missingChildSessionIds: missing } : {}),
    ...(reasons.length > 0 ? { incompleteReasons: reasons } : {}),
    ...(all.length > 0
      ? {
          childInclusive: {
            inputTokens: stream.input + childTotals.input,
            outputTokens: stream.output + childTotals.output,
            cacheReadTokens: stream.cacheRead + childTotals.cacheRead,
            cacheWriteTokens: stream.cacheWrite + childTotals.cacheWrite,
            reasoningTokens: stream.reasoning + childTotals.reasoning,
            complete: agree && missing.length === 0,
            countedChildSessions: counted.length,
          },
        }
      : {}),
  };
  return { model, tokens, warnings };
}
