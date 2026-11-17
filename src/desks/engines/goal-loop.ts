// ach's own goal loop for engines without a goal plugin (#204/#205). Owner: goal-loop seat.
import type { GoalStatus } from "../types.ts";

export interface GoalLoopOptions {
  objective: string;
  /** Runs one agent turn with `text`, resolves with the turn's final assistant text. */
  runTurn: (text: string) => Promise<string>;
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

/** Starts the loop (first turn = objective + protocol), returns at once. */
export function startGoalLoop(_o: GoalLoopOptions): GoalLoopHandle {
  throw new Error("desks: startGoalLoop not implemented yet");
}
