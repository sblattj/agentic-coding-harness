// opencode goal plugin bridge (#204, guide section 5). Owner: opencode-goals seat.
//
// Plugin facts (opencode-goal-pro-max-complete-plugin, dist/goal-plugin.js):
//   :24093 (addGoal)       returns `New active goal: <condition>`, the marker setOpencodeGoal polls for
//   :21916 (rememberGoalResult) result {condition,state,reason,evidence,finishedAt,...}; state "achieved" is the only
//                          writer seen (:24197, :27108); the reader also accepts "blocked"/anything else
//   :22251-22261 (hydrateGoal) live goal {condition,stopped,stopReason,blockedReason,lastStatus,plan,startedAt,pausedAt}
//   :23825-23841 (planActionVerified/planProgress) verified = status "done" + claim + evidence + verdict "pass"
// The per-session directory under state.json.sessions/ is a hash, never the session id: scan them all.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GoalStatus } from "../types.ts";

export const OPENCODE_GOAL_MARKER = "New active goal";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Identity of each message in a GET /session/<sid>/message list: info.id, else its position. */
function messageKeys(list: unknown[]): string[] {
  return list.map((m, i) => {
    const id = isObj(m) && isObj(m.info) ? m.info.id : undefined;
    return typeof id === "string" && id !== "" ? id : `#${i}`;
  });
}

/**
 * Read the session's messages once BEFORE posting (the baseline), then POST
 * <baseUrl>/session/<sid>/command {command:"goal", arguments, model} in the background (it blocks
 * until the goal's first turn ends), then poll GET /session/<sid>/message for the plugin's
 * "New active goal" text for up to timeoutMs (default 40 s). Only messages that are not in the
 * baseline count: an earlier goal's marker in the history never confirms a new goal. The marker
 * is not matched against the objective (the plugin may rewrite flags out of the arguments).
 * Resolves when seen; throws otherwise. `pollMs` (default 1000) is exposed for tests.
 */
export async function setOpencodeGoal(o: {
  baseUrl: string;
  sessionId: string;
  objective: string;
  model?: string;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<void> {
  const base = o.baseUrl.replace(/\/+$/, "");
  const sid = encodeURIComponent(o.sessionId);
  const timeoutMs = o.timeoutMs ?? 40_000;
  const pollMs = o.pollMs ?? 1000;
  const body: Record<string, string> = { command: "goal", arguments: o.objective };
  if (o.model) body.model = o.model;

  const listUrl = `${base}/session/${sid}/message`;
  const baseline = await fetch(listUrl)
    .then(async (r) => {
      const text = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 300)}`);
      const list = JSON.parse(text) as unknown;
      if (!Array.isArray(list)) throw new Error(`not a message list: ${text.slice(0, 300)}`);
      return new Set(messageKeys(list));
    })
    .catch((e: unknown) => {
      throw new Error(`opencode goal: cannot read the session messages before posting: ${e instanceof Error ? e.message : String(e)}`);
    });

  let postError: Error | undefined;
  const post = fetch(`${base}/session/${sid}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
    .then(async (r) => {
      // the response body arrives only when the first turn ends; drain it so the socket is released
      const text = await r.text().catch(() => "");
      if (!r.ok) throw new Error(`opencode goal command HTTP ${r.status}: ${text.slice(0, 300)}`);
    })
    .catch((e: unknown) => {
      postError = e instanceof Error ? e : new Error(String(e));
    });
  void post;

  const deadline = Date.now() + timeoutMs;
  let last = "";
  for (;;) {
    if (postError) throw postError;
    try {
      const r = await fetch(listUrl);
      if (r.ok) {
        last = await r.text();
        let list: unknown;
        try {
          list = JSON.parse(last);
        } catch {
          list = undefined;
        }
        if (Array.isArray(list)) {
          const keys = messageKeys(list);
          if (list.some((m, i) => !baseline.has(keys[i]!) && JSON.stringify(m).includes(OPENCODE_GOAL_MARKER))) return;
        }
      } else {
        last = `GET /message HTTP ${r.status}`;
      }
    } catch (e) {
      last = `GET /message failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (postError) throw postError;
    if (Date.now() + pollMs > deadline) break;
    await sleep(pollMs);
  }
  if (postError) throw postError;
  throw new Error(`opencode goal not active after ${timeoutMs} ms; last messages: ${last.slice(-400)}`);
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function stateFiles(dir: string): string[] {
  const root = join(dir, ".opencode", "goals");
  const files: string[] = [];
  const legacy = join(root, "state.json");
  if (existsSync(legacy)) files.push(legacy);
  const sessions = join(root, "state.json.sessions");
  let names: string[] = [];
  try {
    names = readdirSync(sessions);
  } catch {
    /* no sessions dir */
  }
  for (const n of names.sort()) {
    const f = join(sessions, n, "state.json");
    if (existsSync(f)) files.push(f);
  }
  return files;
}

function readJson(file: string): Json | null {
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

function planOf(goal: Json): { verified: number; total: number } | undefined {
  const plan = goal.plan;
  const actions = isObj(plan) && Array.isArray(plan.actions) ? plan.actions.filter(isObj) : [];
  if (!actions.length) return undefined;
  // Same rule as the plugin's planActionVerified: done + claim + evidence + verdict "pass".
  const verified = actions.filter((a) => a.status === "done" && a.verdict === "pass" && str(a.claim).trim() !== "" && str(a.evidence).trim() !== "").length;
  return { verified, total: actions.length };
}

function liveStatus(g: Json): GoalStatus {
  const stopped = String(g.stopped) === "true";
  const blockedReason = str(g.blockedReason);
  const stopReason = str(g.stopReason);
  let state: GoalStatus["state"] = "active";
  if (blockedReason !== "" || (stopped && stopReason === "blocked")) state = "blocked";
  else if (stopped) state = "stopped";
  const lastCp = isObj(g.lastCheckpoint) ? num(g.lastCheckpoint.timestamp) : 0;
  const status: GoalStatus = {
    objective: str(g.condition),
    state,
    source: "opencode-plugin",
    updatedAt: num(g.pausedAt) || lastCp || num(g.startedAt) || Date.now(),
  };
  const reason = state === "blocked" ? blockedReason || stopReason : state === "stopped" ? stopReason : "";
  if (reason) status.reason = reason;
  if (str(g.lastStatus)) status.evidence = str(g.lastStatus);
  const plan = planOf(g);
  if (plan) status.plan = plan;
  return status;
}

function resultStatus(r: Json): GoalStatus {
  const s = str(r.state);
  const state: GoalStatus["state"] = s === "achieved" ? "achieved" : s === "blocked" || str(r.blockedReason) !== "" ? "blocked" : "stopped";
  const status: GoalStatus = {
    objective: str(r.condition),
    state,
    source: "opencode-plugin",
    updatedAt: num(r.finishedAt) || num(r.startedAt) || Date.now(),
  };
  if (str(r.evidence)) status.evidence = str(r.evidence);
  const reason = str(r.reason) || str(r.blockedReason);
  if (reason) status.reason = reason;
  const plan = planOf(r);
  if (plan) status.plan = plan;
  return status;
}

/**
 * Read <dir>/.opencode/goals/state.json.sessions/* /state.json (and the legacy <dir>/.opencode/goals/state.json),
 * keep ONLY entries whose sessionID matches, compare `stopped` via String(x)==="true", treat blockedReason "" as none.
 * Live goal -> active|blocked|stopped; else newest matching result (results[] then archives[].results[]) -> achieved|blocked|stopped.
 */
export function readOpencodeGoal(o: { dir: string; sessionId: string; objective?: string }): GoalStatus {
  const live: Json[] = [];
  const results: Json[] = [];
  for (const f of stateFiles(o.dir)) {
    const doc = readJson(f);
    if (!doc) continue;
    const mine = (x: unknown): x is Json => isObj(x) && x.sessionID === o.sessionId;
    if (Array.isArray(doc.goals)) live.push(...doc.goals.filter(mine));
    if (Array.isArray(doc.results)) results.push(...doc.results.filter(mine));
    if (Array.isArray(doc.archives)) {
      for (const a of doc.archives) {
        if (isObj(a) && a.sessionID === o.sessionId && Array.isArray(a.results)) results.push(...a.results.filter(mine));
      }
    }
  }
  if (live.length) return liveStatus(live[live.length - 1]!);
  if (results.length) {
    const newest = results.reduce((a, b) => (num(b.finishedAt) >= num(a.finishedAt) ? b : a));
    return resultStatus(newest);
  }
  return { state: "none", objective: o.objective ?? "", source: "opencode-plugin", updatedAt: Date.now() };
}
