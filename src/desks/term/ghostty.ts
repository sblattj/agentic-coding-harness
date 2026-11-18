// Ghostty TerminalDriver via AppleScript (#204, guide 8). Everything is addressed by terminal id.
// Never `close window` / `close tab` (they closed the user's own windows in the prototype).
// close = kill the pane's process, then `send key "enter"` (Ghostty's own "press any key to close").
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { OpenRequest, TerminalDriver } from "../types.ts";
import { pickPaneShell, shellQuote, type PaneShell } from "./tmux.ts";

export type OsascriptRunner = (script: string) => Promise<string>;

export interface GhosttyDriverOptions {
  osascript?: OsascriptRunner;
  /** Test seam for process kill (default process.kill). */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Test seam: is the pid still running (default process.kill(pid, 0); ESRCH means gone). */
  isAlive?: (pid: number) => boolean;
  /** Longest wait for the process to exit after SIGTERM before SIGKILL, ms (default 3000). */
  exitWaitMs?: number;
  /** Test seam: the command line of a pid (default `ps -o command= -p <pid>`), undefined when it is gone. */
  commandOf?: (pid: number) => string | undefined;
  /** Test seam: the start time of a pid in epoch ms (default `ps -o lstart= -p <pid>`), undefined when it is gone. */
  startOf?: (pid: number) => number | undefined;
  /** Minimum delay between killing the process and sending Enter, ms (default 200); Enter also waits for the process to exit. */
  settleMs?: number;
  /** Directory for pidfiles (default <tmpdir>/ach-desks-ghostty). */
  dir?: string;
}

const defaultDir = (): string => join(tmpdir(), "ach-desks-ghostty");

/** Escape a value for embedding in an AppleScript double-quoted string. */
export function asString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

const safeId = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, "_");

/** Sidecar file recording which pidfile belongs to a terminal id (readable from any process). */
export function sidecarFor(id: string, dir: string = defaultDir()): string {
  return join(dir, `terminal-${safeId(id)}.ref`);
}

/** Strings the launched process's command line must contain: argv[0]'s basename, plus argv[1] when it is a path. */
export function needlesFor(argv: string[]): string[] {
  const out = [basename(argv[0] ?? "")];
  if (argv[1] && argv[1].includes("/") && !argv[1].startsWith("-")) out.push(basename(argv[1]));
  return out.filter((n) => n !== "");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

const POLL_MS = 50;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function psCommand(pid: number): string | undefined {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 5_000 }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function psStart(pid: number): number | undefined {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 5_000, env: { ...process.env, LC_ALL: "C" } }).trim();
    const t = out ? Date.parse(out) : NaN;
    return Number.isFinite(t) ? t : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Identity check for a recorded pid. The launched pane shell writes the pidfile after it started and then execs, so the
 * pid keeps its start time: the process we launched started shortly BEFORE the pidfile was written. A reused pid
 * started after the original died, so after the pidfile (ps lstart has whole-second resolution, hence the slack).
 * The pidfile mtime is the per-open marker; two opens never share one.
 */
const START_BEFORE_PIDFILE_MS = 120_000;
// The launched process started at or before the pidfile write, so in theory lstart <= mtime. Slack covers only clock
// granularity: ps lstart is truncated to whole seconds (which only lowers it) and the file mtime comes from a coarser
// kernel clock than the process start stamp, so 1 s is the smallest round slack that keeps the real launch accepted.
// Anything later (a reused pid started after the original died) is rejected.
const START_AFTER_PIDFILE_MS = 1_000;
export function startMatchesPidfile(startMs: number | undefined, pidfileMtimeMs: number): boolean {
  if (startMs === undefined) return false;
  return startMs <= pidfileMtimeMs + START_AFTER_PIDFILE_MS && startMs >= pidfileMtimeMs - START_BEFORE_PIDFILE_MS;
}

/** The needles recorded in a terminal's sidecar (line 2, JSON), or undefined for an older sidecar. */
function needlesOf(id: string, dir: string): string[] | undefined {
  try {
    const line = readFileSync(sidecarFor(id, dir), "utf8").split("\n")[1];
    const v: unknown = line ? JSON.parse(line) : undefined;
    return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
  } catch {
    return undefined;
  }
}

/** The pidfile of the process running in terminal `id`, or undefined if unknown. */
export function pidfileFor(id: string, dir: string = defaultDir()): string | undefined {
  try {
    const p = (readFileSync(sidecarFor(id, dir), "utf8").split("\n")[0] ?? "").trim();
    return p || undefined;
  } catch {
    return undefined;
  }
}

/** Surface command: the pane shell records its pid, then execs the real command so the pid IS the command. */
export function surfaceCommand(argv: string[], pidfile: string, shell: PaneShell = pickPaneShell()): string {
  const inner = `echo $$ > ${shellQuote(pidfile)}; exec ${argv.map(shellQuote).join(" ")}`;
  return [shellQuote(shell.path), ...shell.flags, shellQuote(inner)].join(" ");
}

const PREAMBLE = (cmd: string, cwd: string): string[] => [
  `  set cfg to new surface configuration`,
  `  set command of cfg to ${asString(cmd)}`,
  `  set initial working directory of cfg to ${asString(cwd)}`,
];

/** AppleScript to open a terminal. Returns the new terminal id on stdout. */
export function openScript(req: OpenRequest, cmd: string): string {
  const head = [`tell application "Ghostty"`, ...PREAMBLE(cmd, req.cwd)];
  switch (req.mode) {
    case "window":
      return [...head, `  set w to new window with configuration cfg`, `  return id of focused terminal of selected tab of w`, `end tell`].join("\n");
    case "right":
    case "down":
      if (!req.of) throw new Error(`ghostty: mode ${req.mode} needs "of" (the terminal to split)`);
      return [
        ...head,
        `  set t to split (first terminal whose id is ${asString(req.of)}) direction ${req.mode} with configuration cfg`,
        `  return id of t`,
        `end tell`,
      ].join("\n");
    case "tab": {
      if (!req.of) throw new Error(`ghostty: mode tab needs "of" (a terminal in the target window)`);
      const of = asString(req.of);
      return [
        ...head,
        `  set target to missing value`,
        `  repeat with wi from 1 to count of windows`,
        `    set w to window wi`,
        `    repeat with ti from 1 to count of tabs of w`,
        `      if (id of every terminal of tab ti of w) contains ${of} then set target to w`,
        `    end repeat`,
        `  end repeat`,
        `  if target is missing value then error "no window contains terminal " & ${of}`,
        `  set tb to new tab in target with configuration cfg`,
        `  return id of focused terminal of tb`,
        `end tell`,
      ].join("\n");
    }
    default:
      throw new Error(`ghostty: unknown open mode ${String(req.mode)}`);
  }
}

/** AppleScript for the "press any key to close" half of close(). */
export function closeScript(id: string): string {
  return [`tell application "Ghostty"`, `  send key "enter" to (first terminal whose id is ${asString(id)})`, `end tell`].join("\n");
}

export function aliveScript(id: string): string {
  return [`tell application "Ghostty"`, `  return exists (first terminal whose id is ${asString(id)})`, `end tell`].join("\n");
}

const runOsascript: OsascriptRunner = (script) =>
  new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], { encoding: "utf8", timeout: 20_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`osascript failed: ${(stderr || err.message).trim()}`));
      else resolve(stdout);
    });
  });

export class GhosttyDriver implements TerminalDriver {
  readonly kind = "ghostty" as const;
  private readonly osa: OsascriptRunner;
  private readonly kill: (pid: number, signal: NodeJS.Signals) => void;
  private readonly commandOf: (pid: number) => string | undefined;
  private readonly startOf: (pid: number) => number | undefined;
  private readonly settleMs: number;
  private readonly isAlive: (pid: number) => boolean;
  private readonly exitWaitMs: number;
  private readonly dir: string;
  private readonly pidfiles = new Map<string, string>();

  constructor(opts: GhosttyDriverOptions = {}) {
    this.osa = opts.osascript ?? runOsascript;
    this.kill = opts.kill ?? ((pid, sig) => process.kill(pid, sig));
    this.commandOf = opts.commandOf ?? psCommand;
    this.startOf = opts.startOf ?? psStart;
    this.settleMs = opts.settleMs ?? 200;
    this.isAlive = opts.isAlive ?? pidAlive;
    this.exitWaitMs = opts.exitWaitMs ?? 3_000;
    this.dir = opts.dir ?? defaultDir();
  }

  async open(req: OpenRequest): Promise<string> {
    mkdirSync(this.dir, { recursive: true });
    const pidfile = join(this.dir, `${randomUUID()}.pid`);
    const out = (await this.osa(openScript(req, surfaceCommand(req.argv, pidfile)))).trim();
    if (!out) throw new Error("ghostty: open returned no terminal id");
    this.pidfiles.set(out, pidfile);
    writeFileSync(sidecarFor(out, this.dir), `${pidfile}\n${JSON.stringify(needlesFor(req.argv))}\n`);
    return out;
  }

  async close(id: string): Promise<void> {
    const pidfile = this.pidfiles.get(id) ?? pidfileFor(id, this.dir);
    const needles = needlesOf(id, this.dir);
    // Enter only goes to a process we confirmed is ours (signaled, or already gone): otherwise the keystroke could land
    // in a process ach did not launch.
    let ours = false;
    let confirmed = false;
    if (pidfile) {
      let pid = NaN;
      let pidfileMtime = NaN;
      try {
        pidfileMtime = statSync(pidfile).mtimeMs;
        pid = Number.parseInt(readFileSync(pidfile, "utf8").trim(), 10);
      } catch {
        /* never written, or already cleaned */
      }
      // The pidfile can be days old: only signal a pid whose command line is still what we launched
      // (a reused pid would be an unrelated process). Otherwise skip the kill; the pidfile is removed below.
      const cmd = Number.isInteger(pid) && pid > 1 ? this.commandOf(pid) : undefined;
      const cmdOk = cmd !== undefined && (cmd.includes(pidfile) || (needles !== undefined && needles.length > 0 && needles.every((n) => cmd.includes(n))));
      // Same executable and script is not enough (a reused pid can run the same thing): the start time must also
      // fit this open's pidfile.
      ours = cmdOk && startMatchesPidfile(this.startOf(pid), pidfileMtime);
      // A recorded pid with no command line has exited: the terminal sits at "press any key", so Enter is safe.
      confirmed = ours || (Number.isInteger(pid) && pid > 1 && cmd === undefined && !this.isAlive(pid));
      if (Number.isInteger(pid) && pid > 1 && !ours && cmd !== undefined) {
        process.stderr.write(`desks: ghostty pid ${pid} is not the process we launched; not signaling it\n`);
      }
      if (ours) {
        try {
          this.kill(pid, "SIGTERM");
        } catch {
          /* ESRCH: already dead */
        }
        if (this.settleMs > 0) await sleep(this.settleMs);
        // Enter goes to the program if it is still running: wait for it to exit, escalating to SIGKILL.
        if (!(await this.waitGone(pid, this.exitWaitMs))) {
          try {
            this.kill(pid, "SIGKILL");
          } catch {
            /* ESRCH: already dead */
          }
          await this.waitGone(pid, 1_000);
        }
      }
    }
    if (confirmed) {
      try {
        await this.osa(closeScript(id));
      } catch {
        /* terminal already gone */
      }
    }
    this.pidfiles.delete(id);
    if (pidfile) rmSync(pidfile, { force: true });
    rmSync(sidecarFor(id, this.dir), { force: true });
  }

  private async waitGone(pid: number, maxMs: number): Promise<boolean> {
    const deadline = Date.now() + maxMs;
    while (this.isAlive(pid)) {
      if (Date.now() >= deadline) return false;
      await sleep(POLL_MS);
    }
    return true;
  }

  async alive(id: string): Promise<boolean> {
    try {
      return (await this.osa(aliveScript(id))).trim() === "true";
    } catch {
      return false;
    }
  }
}
