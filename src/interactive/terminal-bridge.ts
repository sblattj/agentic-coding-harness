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

/** One step of a fed chunk, in typing order. */
export type ChordOp = { input: string } | { action: ChordAction };

/** Stateful chord filter: feed raw stdin chunks, get passthrough bytes and actions. */
export class ChordFilter {
  #armed = false;

  /**
   * `ops` keeps typing order: keys typed after `Ctrl-] n` reach the PTY after
   * the step is sent. A detach ends the chunk, so nothing typed after
   * `Ctrl-] d` is forwarded. `passthrough` / `actions` are the flattened view.
   */
  feed(chunk: string): { passthrough: string; actions: ChordAction[]; ops: ChordOp[] } {
    const ops: ChordOp[] = [];
    let pending = "";
    const flush = () => {
      if (pending !== "") ops.push({ input: pending });
      pending = "";
    };
    for (const ch of chunk) {
      if (this.#armed) {
        this.#armed = false;
        if (ch === "d" || ch === "D" || ch === "\x04") {
          flush();
          ops.push({ action: "detach" });
          break;
        } else if (ch === "n" || ch === "N") {
          flush();
          ops.push({ action: "next" });
        } else if (ch === CHORD_PREFIX) pending += CHORD_PREFIX;
        else pending += CHORD_PREFIX + ch;
        continue;
      }
      if (ch === CHORD_PREFIX) {
        this.#armed = true;
        continue;
      }
      pending += ch;
    }
    flush();
    let passthrough = "";
    const actions: ChordAction[] = [];
    for (const op of ops) {
      if ("input" in op) passthrough += op.input;
      else actions.push(op.action);
    }
    return { passthrough, actions, ops };
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
    if (stopped) return;
    const { ops } = filter.feed(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    for (const op of ops) {
      if ("input" in op) opts.target.input(op.input);
      else if (op.action === "next") opts.target.continueStep();
      else {
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
