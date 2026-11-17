// opencode goal plugin bridge (#204, guide section 5). Owner: opencode-goals seat.
import type { GoalStatus } from "../types.ts";

/**
 * POST <baseUrl>/session/<sid>/command {command:"goal", arguments, model} in the background
 * (it blocks until the goal's first turn ends), then poll GET /session/<sid>/message for the
 * plugin's "New active goal" text for up to timeoutMs (default 40 s). Resolves when seen; throws otherwise.
 */
export async function setOpencodeGoal(_o: { baseUrl: string; sessionId: string; objective: string; model?: string; timeoutMs?: number }): Promise<void> {
  throw new Error("desks: setOpencodeGoal not implemented yet");
}

/**
 * Read <dir>/.opencode/goals/state.json.sessions/* /state.json (and the legacy <dir>/.opencode/goals/state.json),
 * keep ONLY entries whose sessionID matches, compare `stopped` via String(x)==="true", treat blockedReason "" as none.
 * Live goal -> active|blocked|stopped; else newest matching result (results[] then archives[].results[]) -> achieved|blocked|stopped.
 */
export function readOpencodeGoal(_o: { dir: string; sessionId: string; objective?: string }): GoalStatus {
  throw new Error("desks: readOpencodeGoal not implemented yet");
}
