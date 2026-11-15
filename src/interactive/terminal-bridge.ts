// Local terminal mirror for interactive runs (#195): used by `ach attach`
// and by `ach run --interactive` itself when it runs in a terminal.
//
// Keystrokes go to the PTY except the prefix chord, tmux-style:
//   Ctrl-] d       detach (the run keeps going)
//   Ctrl-] n       send the next --then step (with --pause-between)
//   Ctrl-] Ctrl-]  a literal Ctrl-]

export const CHORD_PREFIX = "\x1d"; // Ctrl-]
export const CHORD_HELP = "Ctrl-] d detaches, Ctrl-] n sends the next --then step";

export type ChordAction = "detach" | "next";

/** Stateful chord filter: feed raw stdin chunks, get passthrough bytes and actions. */
export class ChordFilter {
  #armed = false;

  feed(chunk: string): { passthrough: string; actions: ChordAction[] } {
    let out = "";
    const actions: ChordAction[] = [];
    for (const ch of chunk) {
      if (this.#armed) {
        this.#armed = false;
        if (ch === "d" || ch === "D" || ch === "\x04") actions.push("detach");
        else if (ch === "n" || ch === "N") actions.push("next");
        else if (ch === CHORD_PREFIX) out += CHORD_PREFIX;
        else out += CHORD_PREFIX + ch;
        continue;
      }
      if (ch === CHORD_PREFIX) {
        this.#armed = true;
        continue;
      }
      out += ch;
    }
    return { passthrough: out, actions };
  }
}

export interface BridgeTarget {
  input(d: string): void;
  resize(cols: number, rows: number): void;
  continueStep(): void;
}

export interface TerminalBridge {
  /** Render PTY output. */
  write(d: string): void;
  /** Restore the terminal and stop forwarding keys. */
  stop(): void;
}

export interface BridgeOptions {
  target: BridgeTarget;
  onDetach: () => void;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  /** Send the terminal size to the PTY on start and on SIGWINCH (default true). */
  driveSize?: boolean;
}

export function bridgeTerminal(opts: BridgeOptions): TerminalBridge {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const filter = new ChordFilter();
  const wasRaw = stdin.isTTY ? stdin.isRaw : false;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  let stopped = false;

  const onKeys = (chunk: string | Buffer) => {
    const { passthrough, actions } = filter.feed(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    if (passthrough !== "") opts.target.input(passthrough);
    for (const a of actions) {
      if (a === "next") opts.target.continueStep();
      if (a === "detach") {
        bridge.stop();
        opts.onDetach();
        return;
      }
    }
  };
  const sendSize = () => {
    if (stdout.isTTY && stdout.columns > 0 && stdout.rows > 0) opts.target.resize(stdout.columns, stdout.rows);
  };
  stdin.on("data", onKeys);
  if (opts.driveSize !== false) {
    stdout.on("resize", sendSize);
    sendSize();
  }

  const bridge: TerminalBridge = {
    write: (d) => {
      if (!stopped) stdout.write(d);
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      stdin.off("data", onKeys);
      stdout.off("resize", sendSize);
      if (stdin.isTTY) stdin.setRawMode(wasRaw);
      stdin.pause();
    },
  };
  return bridge;
}
