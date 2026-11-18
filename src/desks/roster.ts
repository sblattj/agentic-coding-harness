// Roster + stack files (#204). Owner: roster seat. Signatures frozen in wave 0.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DESKS_API_VERSION } from "./types.ts";
import type { Decision, DecisionEvent, DeskMessage, PendingLane, Roster, RosterEntry } from "./types.ts";

export interface DeskPaths {
  root: string; // <stateDir>/desks/<stack>
  roster: string;
  lock: string;
  messages: string;
  decisions: string;
  pendingLanes: string;
  lanesLog: string;
  specs: string; // dir
  events: string; // dir
  logs: string; // dir
  layout: string;
}

/** A stack name is one path segment: starts with a letter or digit, then letters, digits, `_`, `.`, `-`. */
export const STACK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function validStackName(stack: string): boolean {
  return STACK_NAME_RE.test(stack);
}

/** Throws `desks: invalid stack name` unless validStackName. */
export function assertStackName(stack: string): string {
  if (typeof stack !== "string" || !validStackName(stack)) {
    throw new Error(`desks: invalid stack name ${JSON.stringify(stack)} (want ${STACK_NAME_RE})`);
  }
  return stack;
}

/** Frozen in wave 0 (the orchestrator wrote it): every seat derives stack file paths from here. */
export function deskPaths(stateDir: string, stack: string): DeskPaths {
  assertStackName(stack); // defense in depth: a stack never climbs out of <stateDir>/desks
  const root = join(stateDir, "desks", stack);
  return {
    root,
    roster: join(root, "roster.json"),
    lock: join(root, "roster.lock"),
    messages: join(root, "messages.jsonl"),
    decisions: join(root, "decisions.jsonl"),
    pendingLanes: join(root, "pending-lanes.jsonl"),
    lanesLog: join(root, "lanes.log"),
    specs: join(root, "specs"),
    events: join(root, "events"),
    logs: join(root, "logs"),
    layout: join(root, "layout.json"),
  };
}

function emptyRoster(stack: string): Roster {
  return { version: DESKS_API_VERSION, stack, portBase: 4800, entries: {} };
}

/** Missing file = empty roster for the stack. Corrupt JSON throws with the path. */
export function readRoster(stateDir: string, stack: string): Roster {
  const file = deskPaths(stateDir, stack).roster;
  if (!existsSync(file)) return emptyRoster(stack);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`desks: corrupt roster ${file}: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`desks: corrupt roster ${file}: not a JSON object`);
  const r = parsed as Partial<Roster>;
  const entries = r.entries && typeof r.entries === "object" && !Array.isArray(r.entries) ? r.entries : {};
  return { ...(r as Roster), version: DESKS_API_VERSION, stack: r.stack ?? stack, portBase: r.portBase ?? 4800, entries };
}

const LOCK_RETRY_MS = 50;
const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 10_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function acquireLock(lock: string): Promise<void> {
  mkdirSync(dirname(lock), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    try {
      const st = statSync(lock);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        // Move the lock aside atomically, then confirm it is the stale one before deleting: a plain
        // check-then-rmSync could delete a fresh lock another process created in between.
        const aside = `${lock}.stale-${process.pid}-${Math.random().toString(36).slice(2)}`;
        try {
          renameSync(lock, aside);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw e;
        }
        let same = false;
        try { same = statSync(aside).ino === st.ino; } catch { /* gone */ }
        if (same) rmSync(aside, { recursive: true, force: true });
        else {
          try { renameSync(aside, lock); } catch { rmSync(aside, { recursive: true, force: true }); }
        }
        continue;
      }
    } catch {
      continue; // released between mkdir and stat: retry at once
    }
    if (Date.now() >= deadline) throw new Error(`desks: timed out after ${LOCK_WAIT_MS} ms waiting for roster lock ${lock}`);
    await sleep(LOCK_RETRY_MS);
  }
}

/** Atomic read-modify-write under the mkdir lock (stale lock > 10 s is broken). Returns the written roster. */
export async function updateRoster(stateDir: string, stack: string, fn: (r: Roster) => Roster | void): Promise<Roster> {
  const p = deskPaths(stateDir, stack);
  await acquireLock(p.lock);
  try {
    const cur = readRoster(stateDir, stack);
    const next = fn(cur) ?? cur;
    const tmp = `${p.roster}.tmp.${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(tmp, p.roster);
    return next;
  } finally {
    rmSync(p.lock, { recursive: true, force: true });
  }
}

export async function putEntry(stateDir: string, stack: string, e: RosterEntry): Promise<Roster> {
  return updateRoster(stateDir, stack, (r) => {
    r.entries[e.name] = e;
  });
}

export async function removeEntry(stateDir: string, stack: string, name: string): Promise<Roster> {
  return updateRoster(stateDir, stack, (r) => {
    delete r.entries[name];
  });
}

/** pid alive (kill 0) AND GET <url>/health answers within timeoutMs. */
export async function isEntryAlive(e: RosterEntry, timeoutMs = 1500): Promise<boolean> {
  try {
    process.kill(e.pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  try {
    const res = await fetch(`${e.url.replace(/\/+$/, "")}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

function appendJsonl(file: string, v: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(v)}\n`);
}

function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object") out.push(v as T);
    } catch {
      // skip malformed (e.g. torn) line
    }
  }
  return out;
}

export function appendMessage(stateDir: string, stack: string, m: DeskMessage): void {
  appendJsonl(deskPaths(stateDir, stack).messages, m);
}

export function readMessages(stateDir: string, stack: string, o?: { name?: string; limit?: number; sinceMs?: number }): DeskMessage[] {
  let ms = readJsonl<DeskMessage>(deskPaths(stateDir, stack).messages);
  if (o?.name !== undefined) ms = ms.filter((m) => m.from === o.name || m.to === o.name);
  if (o?.sinceMs !== undefined) ms = ms.filter((m) => m.at >= o.sinceMs!);
  if (o?.limit !== undefined) ms = o.limit <= 0 ? [] : ms.slice(-o.limit);
  return ms;
}

export function appendDecisionEvent(stateDir: string, stack: string, e: DecisionEvent): void {
  appendJsonl(deskPaths(stateDir, stack).decisions, e);
}

const idNum = (id: string): number => {
  const n = Number(id.slice(1));
  return Number.isFinite(n) ? n : 0;
};

/** Folds decisions.jsonl into current Decision objects, in id order. */
export function readDecisions(stateDir: string, stack: string): Decision[] {
  const byId = new Map<string, Decision>();
  for (const ev of readJsonl<DecisionEvent>(deskPaths(stateDir, stack).decisions)) {
    if (ev.type === "open" && ev.decision && typeof ev.decision.id === "string") {
      byId.set(ev.decision.id, { ...ev.decision, state: "open" });
    } else if (ev.type === "answer") {
      const d = byId.get(ev.id);
      if (d) {
        d.state = "answered";
        d.answer = { text: ev.text, by: ev.by, at: ev.at };
      }
    } else if (ev.type === "close") {
      const d = byId.get(ev.id);
      if (d) d.state = "closed";
    }
  }
  return [...byId.values()].sort((a, b) => idNum(a.id) - idNum(b.id));
}

/** Next "D<n>" for the stack. */
export function nextDecisionId(stateDir: string, stack: string): string {
  let max = 0;
  for (const ev of readJsonl<DecisionEvent>(deskPaths(stateDir, stack).decisions)) {
    if (ev.type === "open" && typeof ev.decision?.id === "string") max = Math.max(max, idNum(ev.decision.id));
  }
  return `D${max + 1}`;
}

/** pending-lanes.jsonl holds full PendingLane snapshots; the latest line per id wins. */
export function appendPendingLane(stateDir: string, stack: string, p: PendingLane): void {
  appendJsonl(deskPaths(stateDir, stack).pendingLanes, p);
}

export function readPendingLanes(stateDir: string, stack: string): PendingLane[] {
  const byId = new Map<string, PendingLane>();
  for (const p of readJsonl<PendingLane>(deskPaths(stateDir, stack).pendingLanes)) {
    if (typeof p.id === "string") byId.set(p.id, p);
  }
  return [...byId.values()].sort((a, b) => idNum(a.id) - idNum(b.id));
}

export function nextPendingLaneId(stateDir: string, stack: string): string {
  let max = 0;
  for (const p of readJsonl<PendingLane>(deskPaths(stateDir, stack).pendingLanes)) {
    if (typeof p.id === "string") max = Math.max(max, idNum(p.id));
  }
  return `L${max + 1}`;
}

/** "human" (any case) is the user's sender and approver identity, never a desk or lane. */
export function reservedName(name: string): boolean {
  return typeof name === "string" && name.toLowerCase() === "human";
}

/** Validates a desk/lane name: /^[A-Z][A-Z0-9_-]{0,31}$/ for desks; lanes also allow lower-case: /^[a-z0-9][a-z0-9_-]{0,47}$/i. Reserved names fail. */
export function validName(name: string, kind: "desk" | "lane"): boolean {
  if (reservedName(name)) return false;
  return kind === "desk" ? /^[A-Z][A-Z0-9_-]{0,31}$/.test(name) : /^[a-z0-9][a-z0-9_-]{0,47}$/i.test(name);
}

/**
 * The bearer token of the host for desk/lane `name`, read from specs/<name>.json (mode 0600;
 * the only place it lives). With `runId`, only a spec for that run counts, so a stale entry
 * never pairs with a newer host's token. undefined when there is no spec, no token, or the
 * spec is for another run (the host then answers 401, fail closed).
 */
export function readHostToken(stateDir: string, stack: string, name: string, runId?: string): string | undefined {
  if (!validName(name, "desk") && !validName(name, "lane")) return undefined; // never join an unvalidated name into a path
  try {
    const spec = JSON.parse(readFileSync(join(deskPaths(stateDir, stack).specs, `${name}.json`), "utf8")) as { token?: unknown; runId?: unknown };
    if (runId !== undefined && spec.runId !== runId) return undefined;
    return typeof spec.token === "string" && spec.token !== "" ? spec.token : undefined;
  } catch {
    return undefined;
  }
}
