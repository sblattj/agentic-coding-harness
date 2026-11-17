// Roster + stack files (#204). Owner: roster seat. Signatures frozen in wave 0.
import type { Decision, DecisionEvent, DeskMessage, PendingLane, Roster, RosterEntry } from "./types.ts";

const NI = (fn: string): never => {
  throw new Error(`desks: ${fn} not implemented yet`);
};

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

export function deskPaths(_stateDir: string, _stack: string): DeskPaths {
  return NI("deskPaths");
}

/** Missing file = empty roster for the stack. */
export function readRoster(_stateDir: string, _stack: string): Roster {
  return NI("readRoster");
}

/** Atomic read-modify-write under the mkdir lock (stale lock > 10 s is broken). Returns the written roster. */
export async function updateRoster(_stateDir: string, _stack: string, _fn: (r: Roster) => Roster | void): Promise<Roster> {
  return NI("updateRoster");
}

export async function putEntry(_stateDir: string, _stack: string, _e: RosterEntry): Promise<Roster> {
  return NI("putEntry");
}

export async function removeEntry(_stateDir: string, _stack: string, _name: string): Promise<Roster> {
  return NI("removeEntry");
}

/** pid alive (kill 0) AND GET <url>/health answers within timeoutMs. */
export async function isEntryAlive(_e: RosterEntry, _timeoutMs?: number): Promise<boolean> {
  return NI("isEntryAlive");
}

export function appendMessage(_stateDir: string, _stack: string, _m: DeskMessage): void {
  NI("appendMessage");
}

export function readMessages(_stateDir: string, _stack: string, _o?: { name?: string; limit?: number; sinceMs?: number }): DeskMessage[] {
  return NI("readMessages");
}

export function appendDecisionEvent(_stateDir: string, _stack: string, _e: DecisionEvent): void {
  NI("appendDecisionEvent");
}

/** Folds decisions.jsonl into current Decision objects, in id order. */
export function readDecisions(_stateDir: string, _stack: string): Decision[] {
  return NI("readDecisions");
}

/** Next "D<n>" for the stack. */
export function nextDecisionId(_stateDir: string, _stack: string): string {
  return NI("nextDecisionId");
}

export function appendPendingLane(_stateDir: string, _stack: string, _p: PendingLane): void {
  NI("appendPendingLane");
}

export function readPendingLanes(_stateDir: string, _stack: string): PendingLane[] {
  return NI("readPendingLanes");
}

export function nextPendingLaneId(_stateDir: string, _stack: string): string {
  return NI("nextPendingLaneId");
}

/** Validates a desk/lane name: /^[A-Z][A-Z0-9_-]{0,31}$/ for desks; lanes also allow lower-case: /^[a-z0-9][a-z0-9_-]{0,47}$/i. */
export function validName(_name: string, _kind: "desk" | "lane"): boolean {
  return NI("validName");
}
