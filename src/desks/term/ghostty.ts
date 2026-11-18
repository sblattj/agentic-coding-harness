// Ghostty TerminalDriver via AppleScript (#204, guide 8). Everything is addressed by terminal id.
// Never `close window` / `close tab` (they closed the user's own windows in the prototype).
// close = kill the pane's process, then `send key "enter"` (Ghostty's own "press any key to close").
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/**
 * Commands that exec a later word: the launched process's command line shows that word, not the wrapper.
 *
 * The class this table handles: wrappers whose OPTIONS may take a SEPARATE operand word (`env -u NAME`, `nice -n 10`,
 * `timeout -s KILL`, `stdbuf -o L`, `env -C /dir`) and that may eat POSITIONAL words before the command (timeout's
 * DURATION). Skipping only the option word would leave its operand to be read as the executable. So each wrapper
 * lists the short option letters and long names that take an operand, the ones that do not, and how many positional
 * words it eats. Anything else that looks like an option is unknown: needlesFor returns no needles rather than guess.
 */
interface WrapperSpec {
  /** Short option letters that take an operand (attached, `-n5`, or the next word, `-n 5`). */
  operand?: string;
  /** Short option letters that take no operand. */
  flags?: string;
  /** Long options that take an operand (`--unset NAME` or `--unset=NAME`). */
  longOperand?: string[];
  /** Long options that take no operand. */
  longFlags?: string[];
  /** Positional words the wrapper eats after its options, before the command (timeout's DURATION). */
  positional?: number;
  /** NAME=value words are environment assignments, not the command (env). */
  assignments?: boolean;
  /** `-<digits>` is an option (nice's legacy `nice -10 cmd`). */
  numericOption?: boolean;
  /** This short letter / long name's operand is itself a list of words to splice in place (env -S). */
  split?: { short: string; long: string };
  /** A lone `-` is an option (env: same as -i). */
  dash?: boolean;
}

const WRAPPERS: Record<string, WrapperSpec> = {
  env: {
    operand: "uCSP",
    flags: "iv0",
    longOperand: ["unset", "chdir", "split-string"],
    longFlags: ["ignore-environment", "null", "debug", "block-signal", "default-signal", "ignore-signal", "list-signal-handling"],
    assignments: true,
    split: { short: "S", long: "split-string" },
    dash: true,
  },
  nohup: {},
  nice: { operand: "n", longOperand: ["adjustment"], numericOption: true },
  caffeinate: { operand: "tw", flags: "dimsu" },
  time: { operand: "fo", flags: "alphvq", longOperand: ["format", "output"], longFlags: ["append", "verbose", "portability", "quiet"] },
  command: { flags: "pvV" },
  // exec -a NAME renames argv[0], so the command line shows NAME, not the command: -a stays unknown (no needles).
  exec: { flags: "cl" },
  stdbuf: { operand: "ioe", longOperand: ["input", "output", "error"] },
  timeout: {
    operand: "sk",
    flags: "fpv",
    longOperand: ["signal", "kill-after"],
    longFlags: ["foreground", "preserve-status", "verbose"],
    positional: 1,
  },
};
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** env -S strings we can split without a shell parser: no quoting, escapes or expansion. */
const PLAIN_SPLIT = /^[^'"\\$`]*$/;

/**
 * Index of the first word after wrapper `spec`'s own options and positional words (words[i] is the wrapper), or
 * undefined when an option is unknown or malformed. Splices env -S operands into `words` in place.
 */
function skipWrapper(spec: WrapperSpec, words: string[], i: number): number | undefined {
  i++;
  let ended = false; // after `--`
  while (i < words.length) {
    const w = words[i]!;
    if (!ended && w === "--") {
      ended = true;
      i++;
      continue;
    }
    if (!ended && w === "-" && spec.dash) {
      i++;
      continue;
    }
    if (!ended && w.startsWith("--")) {
      const eq = w.indexOf("=");
      const name = w.slice(2, eq < 0 ? undefined : eq);
      const takes = spec.longOperand?.includes(name) ?? false;
      if (!takes && !(spec.longFlags?.includes(name) ?? false)) return undefined;
      if (!takes && eq >= 0) return undefined; // a flag given a value: not a form we know
      const operand = takes ? (eq >= 0 ? w.slice(eq + 1) : words[i + 1]) : undefined;
      if (takes && operand === undefined) return undefined;
      const next = i + (takes && eq < 0 ? 2 : 1);
      if (spec.split && name === spec.split.long) {
        if (!PLAIN_SPLIT.test(operand!)) return undefined;
        words.splice(i, next - i, ...operand!.split(/\s+/).filter(Boolean));
        continue;
      }
      i = next;
      continue;
    }
    if (!ended && w.startsWith("-") && w.length > 1) {
      if (spec.numericOption && /^-\d+$/.test(w)) {
        i++;
        continue;
      }
      // A cluster (`-iu NAME`): flags, then at most one operand letter whose operand is the rest of the word or the
      // next word.
      let next = i + 1;
      let splice: string | undefined;
      for (let k = 1; k < w.length; k++) {
        const c = w[k]!;
        if (spec.operand?.includes(c)) {
          const attached = w.slice(k + 1);
          const operand = attached !== "" ? attached : words[i + 1];
          if (operand === undefined) return undefined;
          if (attached === "") next = i + 2;
          if (spec.split && c === spec.split.short) splice = operand;
          break;
        }
        if (!spec.flags?.includes(c)) return undefined;
      }
      if (splice !== undefined) {
        if (!PLAIN_SPLIT.test(splice)) return undefined;
        words.splice(i, next - i, ...splice.split(/\s+/).filter(Boolean));
        continue;
      }
      i = next;
      continue;
    }
    if (spec.assignments && ASSIGNMENT.test(w)) {
      i++;
      continue;
    }
    break;
  }
  for (let n = spec.positional ?? 0; n > 0; n--) {
    if (i >= words.length) return undefined;
    i++;
  }
  return i;
}

/**
 * Strings the launched process's command line must contain: the executable's basename, plus the next word when it is
 * a path. Leading `VAR=value` words and wrappers (WRAPPERS: `env -u X A=1`, `nohup`, `nice -n 5`, `timeout -s KILL 5`,
 * ...) are skipped with their operands, since after they exec the process shows only what follows.
 *
 * Returns [] when the command cannot be told apart from a wrapper's arguments (an unknown wrapper option, a quoted
 * env -S string, nothing after the wrapper). That fails closed: close() then refuses to signal on needles (it needs
 * every needle in the pid's command line, and none means no match), while a guessed needle like an option's operand
 * could either never match (close skips our process) or match too much (only the start-time check would be left).
 */
export function needlesFor(argv: string[]): string[] {
  const words = [...argv];
  let i = 0;
  while (i < words.length) {
    const word = words[i]!;
    const spec = Object.hasOwn(WRAPPERS, basename(word)) ? WRAPPERS[basename(word)] : undefined;
    if (ASSIGNMENT.test(word)) {
      i++;
    } else if (spec) {
      const after = skipWrapper(spec, words, i);
      if (after === undefined) return [];
      i = after;
    } else {
      break;
    }
  }
  const out = [basename(words[i] ?? "")];
  const next = words[i + 1];
  if (next && next.includes("/") && !next.startsWith("-")) out.push(basename(next));
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
/** How long open() waits for the launched shell's pidfile before cleaning up after a failed sidecar write. */
const PIDFILE_WAIT_MS = 2_000;
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
  /** needlesFor(argv) per open, so close() can confirm identity even when the sidecar was never written. */
  private readonly needles = new Map<string, string[]>();

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
    const needles = needlesFor(req.argv);
    this.needles.set(out, needles);
    try {
      writeFileSync(sidecarFor(out, this.dir), `${pidfile}\n${JSON.stringify(needles)}\n`);
    } catch (err) {
      // The terminal and its process are already running, and the caller will never get this id: close them here.
      // Give the launched shell a moment to write its pidfile, since close() only signals a recorded, confirmed pid.
      const deadline = Date.now() + PIDFILE_WAIT_MS;
      while (!existsSync(pidfile) && Date.now() < deadline) await sleep(POLL_MS);
      await this.close(out).catch(() => {});
      throw new Error(`ghostty: could not record terminal ${out}: ${(err as Error).message}`);
    }
    return out;
  }

  async close(id: string): Promise<void> {
    const pidfile = this.pidfiles.get(id) ?? pidfileFor(id, this.dir);
    const needles = needlesOf(id, this.dir) ?? this.needles.get(id);
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
          // The wait can last seconds: the pid may have exited and been reused meanwhile, so recheck identity (same
          // command-line and start-time checks as above) right before the SIGKILL.
          const cmdNow = this.commandOf(pid);
          const stillOurs =
            cmdNow !== undefined &&
            (cmdNow.includes(pidfile) || (needles !== undefined && needles.length > 0 && needles.every((n) => cmdNow.includes(n)))) &&
            startMatchesPidfile(this.startOf(pid), pidfileMtime);
          if (stillOurs) {
            try {
              this.kill(pid, "SIGKILL");
            } catch {
              /* ESRCH: already dead */
            }
          } else {
            process.stderr.write(`desks: ghostty pid ${pid} changed identity while waiting; not sending SIGKILL\n`);
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
    this.needles.delete(id);
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
