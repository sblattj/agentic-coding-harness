// Terminal drivers (#204, guide 8/8b). Owner: term seat. tmux is the default.
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { TerminalDriver, TerminalKind } from "../types.ts";
import { GhosttyDriver, type OsascriptRunner } from "./ghostty.ts";
import { TmuxDriver } from "./tmux.ts";

export { GhosttyDriver, pidfileFor } from "./ghostty.ts";
export { TmuxDriver, shellQuote } from "./tmux.ts";

export interface DefaultTerminalEnv {
  env?: Record<string, string | undefined>;
  platform?: string;
  /** True when `bin` is on PATH. */
  which?: (bin: string) => boolean;
  exists?: (path: string) => boolean;
}

/** "tmux" when $TMUX is set or tmux is on PATH, else "ghostty" on macOS when installed, else "none". */
export function defaultTerminal(opts: DefaultTerminalEnv = {}): TerminalKind {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  const which =
    opts.which ??
    ((bin: string) => (env.PATH ?? "").split(delimiter).some((d) => d !== "" && exists(join(d, bin))));
  if (env.TMUX) return "tmux";
  if (which("tmux")) return "tmux";
  if ((opts.platform ?? process.platform) === "darwin" && exists("/Applications/Ghostty.app")) return "ghostty";
  return "none";
}

export async function terminalDriver(
  kind: Exclude<TerminalKind, "none">,
  opts?: { tmuxSession?: string; tmuxSocket?: string; osascript?: OsascriptRunner },
): Promise<TerminalDriver> {
  if (kind === "tmux") return new TmuxDriver({ session: opts?.tmuxSession, socket: opts?.tmuxSocket });
  if (kind === "ghostty") return new GhosttyDriver({ osascript: opts?.osascript });
  throw new Error(`desks: unknown terminal kind ${String(kind)}`);
}
