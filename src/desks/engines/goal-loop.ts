// ach's own goal loop for engines without a goal plugin (#204/#205). Owner: goal-loop seat.
import type { GoalStatus } from "../types.ts";

export interface GoalLoopOptions {
  objective: string;
  /** Runs one agent turn with `text` (ctx.timeoutMs = what is left of the max-minutes budget), resolves with the turn's final assistant text. */
  runTurn: (text: string, ctx?: { timeoutMs: number }) => Promise<string>;
  /** Caps: default maxTurns 30, maxMinutes from a leading "--max-minutes N" in the objective, else 45. */
  maxTurns?: number;
  maxMinutes?: number;
  onStatus?: (s: GoalStatus) => void;
  /** Injected clock for tests. */
  now?: () => number;
}

export interface GoalLoopHandle {
  status(): GoalStatus;
  /** Stop after the current turn; status becomes "stopped". */
  stop(reason?: string): void;
  /** Resolves with the final status. */
  done: Promise<GoalStatus>;
}

export const DEFAULT_MAX_TURNS = 30;
export const DEFAULT_MAX_MINUTES = 45;
const MAX_MISSING_STATUS = 3;

export interface ParsedGoalFlags {
  objective: string;
  maxMinutes?: number;
  maxTurns?: number;
}

/** Strips leading `--max-minutes N` / `--max-turns N` (either order, `=` allowed) from the objective. */
export function parseGoalFlags(objective: string): ParsedGoalFlags {
  let rest = objective.trimStart();
  const out: ParsedGoalFlags = { objective };
  const re = /^--(max-minutes|max-turns)(?:=|\s+)(\d+(?:\.\d+)?)\s*/i;
  for (;;) {
    const m = re.exec(rest);
    if (!m) break;
    const n = Number(m[2]);
    if ((m[1] ?? "").toLowerCase() === "max-minutes") out.maxMinutes = n;
    else out.maxTurns = Math.floor(n);
    rest = rest.slice(m[0].length);
  }
  out.objective = rest.trim();
  return out;
}

export const GOAL_PROTOCOL = [
  "GOAL PROTOCOL (follow it every turn):",
  "1. First, write a short numbered plan for the objective.",
  "2. Work the plan. Verify each step with real evidence (commands run, files read, tests passed) before counting it done.",
  "3. End EVERY turn with exactly one status line, on its own line, as the last status in your reply:",
  "   GOAL: CONTINUE",
  "   GOAL: ACHIEVED — <evidence that the objective is met>",
  "   GOAL: BLOCKED — <reason you cannot proceed>",
  "   Optionally add a line `PLAN: <verified>/<total>` with the count of verified plan steps.",
].join("\n");

export type ParsedTurn = {
  kind: "continue" | "achieved" | "blocked" | "missing";
  text?: string;
  plan?: { verified: number; total: number };
};

const STATUS_RE = /^[\s>*_`#-]*GOAL\s*:\s*\**\s*(CONTINUE|ACHIEVED|BLOCKED)\b\**\s*(?:[-—–:]+\s*(.*?))?[\s*_`]*$/i;
const PLAN_RE = /^[\s>*_`#-]*PLAN\s*:\s*(\d+)\s*\/\s*(\d+)\b/i;

/** Parses the LAST status line (and last plan line) of a turn's text. */
export function parseTurnStatus(text: string): ParsedTurn {
  let kind: ParsedTurn["kind"] = "missing";
  let detail: string | undefined;
  let plan: ParsedTurn["plan"];
  for (const line of text.split(/\r?\n/)) {
    const s = STATUS_RE.exec(line);
    if (s) {
      kind = (s[1] ?? "").toLowerCase() as ParsedTurn["kind"];
      detail = s[2]?.trim() || undefined;
      continue;
    }
    const p = PLAN_RE.exec(line);
    if (p) plan = { verified: Number(p[1]), total: Number(p[2]) };
  }
  return { kind, text: detail, plan };
}

function firstPrompt(objective: string): string {
  return `${GOAL_PROTOCOL}\n\nOBJECTIVE:\n${objective}`;
}

function laterPrompt(last: string, missing: boolean): string {
  const base = `Continue the goal. Last status: ${last}. Remember the status line.`;
  return missing
    ? `${base}\nYour last reply had no status line. End this turn with exactly one of: GOAL: CONTINUE, GOAL: ACHIEVED — <evidence>, GOAL: BLOCKED — <reason>.`
    : base;
}

/** Starts the loop (first turn = objective + protocol), returns at once. */
export function startGoalLoop(o: GoalLoopOptions): GoalLoopHandle {
  const now = o.now ?? Date.now;
  const flags = parseGoalFlags(o.objective);
  const objective = flags.objective;
  const maxTurns = o.maxTurns ?? flags.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxMinutes = o.maxMinutes ?? flags.maxMinutes ?? DEFAULT_MAX_MINUTES;
  const startedAt = now();

  let current: GoalStatus = { objective, state: "active", source: "ach-loop", updatedAt: startedAt };
  let stopRequested = false;
  let stopReason: string | undefined;

  const emit = (patch: Partial<GoalStatus>): void => {
    current = { ...current, ...patch, updatedAt: now() };
    try {
      o.onStatus?.(current);
    } catch {
      // a listener must not break the loop
    }
  };

  const run = async (): Promise<GoalStatus> => {
    emit({});
    let prompt = firstPrompt(objective);
    let turns = 0;
    let missing = 0;
    // A limit of 0 (or less) means no turn at all, not "unlimited": end exactly as when the cap is hit.
    if (maxTurns <= 0) {
      emit({ state: "stopped", reason: `max turns reached (${maxTurns})` });
      return current;
    }
    for (;;) {
      let reply: string;
      try {
        const left = Math.max(1000, maxMinutes * 60_000 - (now() - startedAt));
        reply = await o.runTurn(prompt, { timeoutMs: left });
      } catch (e) {
        // A stop aborts the in-flight turn, which then throws: that is a stop, not a block.
        if (stopRequested) {
          emit({ state: "stopped", reason: stopReason ?? "stopped" });
          return current;
        }
        emit({ state: "blocked", reason: e instanceof Error ? e.message : String(e) });
        return current;
      }
      turns++;
      const t = parseTurnStatus(typeof reply === "string" ? reply : "");
      if (t.plan) emit({ plan: t.plan });
      if (t.kind === "achieved") {
        emit({ state: "achieved", evidence: t.text ?? "" });
        return current;
      }
      if (t.kind === "blocked") {
        emit({ state: "blocked", reason: t.text ?? "blocked" });
        return current;
      }
      missing = t.kind === "missing" ? missing + 1 : 0;
      if (missing >= MAX_MISSING_STATUS) {
        emit({ state: "blocked", reason: "no status line" });
        return current;
      }
      if (stopRequested) {
        emit({ state: "stopped", reason: stopReason ?? "stopped" });
        return current;
      }
      if (turns >= maxTurns) {
        emit({ state: "stopped", reason: `max turns reached (${maxTurns})` });
        return current;
      }
      if (now() - startedAt >= maxMinutes * 60_000) {
        emit({ state: "stopped", reason: `max minutes reached (${maxMinutes})` });
        return current;
      }
      prompt = laterPrompt(t.kind === "missing" ? "none (missing)" : "CONTINUE", t.kind === "missing");
    }
  };

  const done = run().catch((e): GoalStatus => {
    emit({ state: "blocked", reason: e instanceof Error ? e.message : String(e) });
    return current;
  });

  return {
    status: () => current,
    stop(reason?: string) {
      if (current.state !== "active") return;
      stopRequested = true;
      stopReason = reason ?? "stopped";
    },
    done,
  };
}
