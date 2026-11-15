// `ach run --interactive` flag parsing (#195).
import { HarnessError } from "../core/types.ts";

/** #195: the agents `--interactive` can drive so far. */
export const INTERACTIVE_AGENTS = ["claude"] as const;

/** `--interactive` / `--tui` and the flags that only make sense with it; null on a headless run. */
export function parseInteractiveFlags(
  v: { interactive?: boolean; tui?: boolean; then?: string[]; "pause-between"?: boolean; "trust-workspace"?: boolean },
  trial: { repeat?: number; parallel?: number },
): { then: string[]; pauseBetween: boolean; trustWorkspace: boolean } | null {
  const on = v.interactive === true || v.tui === true;
  const then = (v.then ?? []).map((t) => t.trim());
  if (!on) {
    const stray = [then.length > 0 ? "--then" : "", v["pause-between"] ? "--pause-between" : "", v["trust-workspace"] ? "--trust-workspace" : ""].filter(Boolean);
    if (stray.length > 0) throw new HarnessError(`${stray.join(", ")} only work${stray.length === 1 ? "s" : ""} with --interactive`, "USAGE");
    return null;
  }
  if (then.some((t) => t === "")) throw new HarnessError("--then expects a non-empty prompt", "USAGE");
  if (v["pause-between"] && then.length === 0) throw new HarnessError("--pause-between needs at least one --then step", "USAGE");
  if (trial.repeat !== undefined || trial.parallel !== undefined) {
    throw new HarnessError("--interactive runs one watched session; it cannot be combined with --repeat or --parallel", "USAGE");
  }
  return { then, pauseBetween: v["pause-between"] === true, trustWorkspace: v["trust-workspace"] === true };
}

/** Throws a clear usage error for agents (or flags) interactive runs do not cover yet. */
export function assertInteractiveSupported(agent: string, resume: string | undefined): void {
  if (!(INTERACTIVE_AGENTS as readonly string[]).includes(agent)) {
    throw new HarnessError(
      `--interactive is not yet supported for agent '${agent}'; it works with: ${INTERACTIVE_AGENTS.join(", ")}. Run '${agent}' headless (drop --interactive) for now.`,
      "USAGE",
    );
  }
  if (resume !== undefined) throw new HarnessError("--interactive with --resume is not yet supported; start a new interactive session", "USAGE");
}
