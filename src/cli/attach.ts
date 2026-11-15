// `ach attach <runId>` (#195): mirror a live interactive run's PTY in this
// terminal, tmux-style. Ctrl-] d detaches and leaves the run going.
import { parseArgs } from "./config.ts";
import { HarnessError } from "../core/types.ts";
import { stateDir } from "../core/store.ts";
import { listLiveRuns, resolveLiveRun } from "../interactive/live-registry.ts";
import { connectLive } from "../interactive/live-socket.ts";
import { CHORD_HELP, bridgeTerminal, type TerminalBridge } from "../interactive/terminal-bridge.ts";

export async function cmdAttach(rest: string[]): Promise<number> {
  const args = parseArgs({
    args: rest,
    options: {
      list: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      "read-only": { type: "boolean", default: false },
      "state-dir": { type: "string" },
    },
    allowPositionals: true,
  });
  const dir = args.values["state-dir"] ?? stateDir();
  const id = args.positionals[0];
  if (args.values.list || id === undefined) {
    const live = listLiveRuns(dir);
    if (args.values.json) {
      process.stdout.write(JSON.stringify({ live }, null, 2) + "\n");
      return 0;
    }
    if (live.length === 0) {
      process.stdout.write("no interactive run is live (start one with: ach run --agent claude --interactive \"<prompt>\")\n");
      return id === undefined && !args.values.list ? 1 : 0;
    }
    for (const r of live) {
      process.stdout.write(`${r.runId}  ${r.agent}  session ${r.sessionId}  ${r.model ?? ""}  ${r.cwd}\n`);
    }
    return 0;
  }
  let info;
  try {
    info = resolveLiveRun(dir, id);
  } catch (err) {
    throw new HarnessError(err instanceof Error ? err.message : String(err), "USAGE");
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new HarnessError("ach attach needs a terminal (stdin and stdout must be a TTY)", "USAGE");
  }
  const readOnly = args.values["read-only"] === true;
  process.stderr.write(`[attach] run ${info.runId} · session ${info.sessionId} · ${readOnly ? "read-only · " : ""}${CHORD_HELP}\r\n`);

  let bridge: TerminalBridge | null = null;
  let detached = false;
  let exitCode: number | null = null;
  const closed = new Promise<void>((resolve) => {
    void connectLive(info.socket, {
      onScrollback: (d) => {
        // Clear, then replay: the screen catches up to where the TUI is now.
        process.stdout.write("\x1b[2J\x1b[H" + d);
      },
      onOut: (d) => bridge?.write(d),
      onExit: (code) => {
        exitCode = code;
      },
      onClose: () => resolve(),
    }).then(
      (client) => {
        bridge = bridgeTerminal({
          target: {
            input: (d) => {
              if (!readOnly) client.input(d);
            },
            resize: (c, r) => {
              if (!readOnly) client.resize(c, r);
            },
            continueStep: () => client.continueStep(),
          },
          driveSize: !readOnly,
          onDetach: () => {
            detached = true;
            client.close();
          },
        });
      },
      (err: Error) => {
        process.stderr.write(`[attach] could not connect to ${info.socket}: ${err.message}\n`);
        resolve();
      },
    );
  });
  await closed;
  (bridge as TerminalBridge | null)?.stop();
  if (detached) {
    process.stderr.write(`\r\n[attach] detached from ${info.runId}; the run keeps going\r\n`);
    return 0;
  }
  process.stderr.write(`\r\n[attach] run ${info.runId} ended${exitCode !== null ? ` (TUI exit ${exitCode})` : ""}\r\n`);
  return 0;
}
