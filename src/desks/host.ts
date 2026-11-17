// The desk host process (#204): `ach desk host --spec <file>`. Owner: host seat.
import type { HostSpec } from "./types.ts";

/** Runs until POST /stop or SIGTERM. Resolves with the exit code. */
export async function runHost(_spec: HostSpec): Promise<number> {
  throw new Error("desks: runHost not implemented yet");
}

/** Spawn `ach desk host --spec <specFile>` fully detached (own session), stdout/stderr to logFile. Returns its pid. */
export function spawnHost(_specFile: string, _logFile: string): number {
  throw new Error("desks: spawnHost not implemented yet");
}
