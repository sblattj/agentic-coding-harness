// Terminal drivers (#204, guide 8/8b). Owner: term seat. tmux is the default.
import type { TerminalDriver, TerminalKind } from "../types.ts";

/** "tmux" when $TMUX is set or tmux is on PATH, else "ghostty" on macOS when installed, else "none". */
export function defaultTerminal(): TerminalKind {
  throw new Error("desks: defaultTerminal not implemented yet");
}

export async function terminalDriver(
  _kind: Exclude<TerminalKind, "none">,
  _opts?: { tmuxSession?: string; tmuxSocket?: string },
): Promise<TerminalDriver> {
  throw new Error("desks: terminalDriver not implemented yet");
}
