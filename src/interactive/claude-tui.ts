// Interactive Claude runs (#195): `ach run --agent claude --interactive`.
//
// Instead of `claude -p ... --output-format stream-json`, the adapter starts
// the Claude Code TUI in an ach-owned PTY with the run's model, permission
// mode, tool policy, a fixed --session-id and the first prompt. Everything
// the driver needs comes from the session transcript (TranscriptTail), so
// the RunRecord, budget/wall/idle limits, the event .cast and --verify work
// the same as for a headless run. The PTY is published on a Unix socket
// (live-socket.ts) so `ach web` tiles and `ach attach` can watch and type.
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AdapterExit, AdapterProfileCheck, AgentAdapter, AgentEvent, AgentHandle, RunSpec } from "../core/types.ts";
import { claudeSandboxArgs, disableClaudeBackgroundTasks } from "../adapters/claude.ts";
import { scrubEnvVars, validateCliSessionProfile } from "../adapters/shared.ts";
import { LivePty, loadBunPty, type PtyFactory } from "./live-pty.ts";
import { startLiveServer, type LiveServerHandle } from "./live-socket.ts";
import { liveSocketPath, removeLiveInfo, writeLiveInfo, type LiveRunInfo } from "./live-registry.ts";
import { StepController } from "./steps.ts";
import { TranscriptTail, claudeProjectsRoot } from "./transcript-tail.ts";
import { EventQueue } from "../core/event-retention.ts";
import { CHORD_HELP, bridgeTerminal, type TerminalBridge } from "./terminal-bridge.ts";

export { EventQueue };

/**
 * RunResult.events keeps only this many trailing events for an interactive
 * run (#199); whole-run facts ride RunResult.eventSummary.
 */
export const INTERACTIVE_RESULT_EVENT_TAIL = 2000;

/** Env vars that make a nested Claude Code think it is a child session (no transcript saved). */
const NESTED_SESSION_VARS = ["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT"];

export interface ClaudeInteractiveOptions {
  stateDir: string;
  /** The claude executable (default `claude`). */
  command?: string;
  /** PTY factory; default bun-pty (throws the "needs the npm/bun install" error elsewhere). */
  ptyFactory?: PtyFactory;
  /** Claude projects root to find the session transcript in (default ~/.claude/projects). */
  projectsRoot?: string;
  /** Transcript poll interval, ms (default 1000). */
  pollMs?: number;
  /** --then prompts, typed in order as the agent finishes each turn. */
  then?: string[];
  /** --pause-between: wait for a keypress or the web button before each --then step. */
  pauseBetween?: boolean;
  /** --trust-workspace: answer Claude's "trust this folder?" dialog with yes. */
  trustWorkspace?: boolean;
  /** Mirror the TUI in this process's terminal (stdin/stdout are a TTY). */
  mirror?: boolean;
  cols?: number;
  rows?: number;
  /** Owner progress lines (stderr by default). */
  log?: (line: string) => void;
  /** Called once the PTY is published (tests, CLI hints). */
  onLive?: (info: LiveRunInfo) => void;
  /** Escalation delays for abort (defaults 2000 / 3000 ms). */
  sigtermAfterMs?: number;
  sigkillAfterMs?: number;
}

const ANSI = /\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78]/g;

/** Strip ANSI so screen text can be matched. Exported for tests. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

/**
 * Claude Code asks "Is this a project you created or one you trust?" in a
 * folder it has not seen. Returns the keys that pick "Yes", or null when the
 * screen text is not that dialog.
 */
export function trustDialogKeys(screen: string): string[] | null {
  // The TUI moves the cursor (ESC[nC) instead of printing spaces, so match
  // on the text with all whitespace removed.
  const text = stripAnsi(screen).replace(/\s+/g, "");
  if (!/trustthisfolder|oneyoutrust/i.test(text) || !/Yes,?Itrust/i.test(text)) return null;
  // The selection marker sits in front of the highlighted option.
  if (/❯(?:\d\.)?Yes,?Itrust/i.test(text)) return ["\r"];
  return ["\x1b[B", "\r"];
}

/** argv for the TUI. The prompt goes first: --allowedTools and friends are variadic. */
export function claudeTuiArgs(spec: RunSpec, sessionId: string): string[] {
  const args: string[] = [];
  if (!spec.prompt.startsWith("-")) args.push(spec.prompt);
  args.push("--session-id", sessionId);
  if (spec.model) args.push("--model", spec.model);
  if (spec.sandbox) args.push(...claudeSandboxArgs(spec.sandbox));
  if (spec.extraArgs?.length) args.push(...spec.extraArgs);
  if (spec.prompt.startsWith("-")) args.push("--", spec.prompt);
  return args;
}

export class ClaudeInteractiveAdapter implements AgentAdapter {
  readonly name = "claude";
  /** No --max-turns in the TUI: the driver counts model turns from the transcript. */
  readonly enforcesBudget = false;
  readonly registryKeepaliveMs = 5_000;
  readonly resultEventTail = INTERACTIVE_RESULT_EVENT_TAIL;
  readonly #opts: ClaudeInteractiveOptions;

  constructor(opts: ClaudeInteractiveOptions) {
    this.#opts = opts;
  }

  validateProfile(spec: RunSpec): AdapterProfileCheck {
    return validateCliSessionProfile(spec);
  }

  async launch(spec: RunSpec): Promise<AgentHandle> {
    const o = this.#opts;
    const log = o.log ?? ((l: string) => process.stderr.write(l + "\n"));
    const factory = o.ptyFactory ?? (await loadBunPty());
    const sessionId = randomUUID();
    const runId = typeof spec.runId === "string" && spec.runId !== "" ? spec.runId : randomUUID();
    const cwd = spec.cwd ?? process.cwd();
    const command = o.command ?? "claude";

    const env = scrubEnvVars({ ...process.env, ...spec.env } as Record<string, string | undefined>, spec.sandbox?.scrubEnv);
    for (const k of NESTED_SESSION_VARS) delete env[k];
    // Metering reads the session transcript, so it must be written even when
    // ach itself runs under another Claude Code session.
    env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE = "1";
    env.TERM = "xterm-256color";
    env.COLORTERM ??= "truecolor";
    if (disableClaudeBackgroundTasks({})) env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
    const cleanEnv = Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === "string"));

    const cols = o.cols ?? 120;
    const rows = o.rows ?? 34;
    const args = claudeTuiArgs(spec, sessionId);
    const term = await factory({ command, args, cwd, env: cleanEnv, cols, rows });
    const live = new LivePty(term, {
      cols,
      rows,
      // #72: the .cast is a full terminal recording (prompt, replies, tool
      // output); below `full` content capture it is never written.
      ...(spec.captureMode === undefined || spec.captureMode === "full"
        ? { castPath: path.join(o.stateDir, "casts", `${runId}.cast`), castTitle: `ach run --interactive ${runId}` }
        : {}),
      ...(o.sigtermAfterMs !== undefined ? { sigtermAfterMs: o.sigtermAfterMs } : {}),
      ...(o.sigkillAfterMs !== undefined ? { sigkillAfterMs: o.sigkillAfterMs } : {}),
    });

    // ---- event queue the driver attaches to
    const queue = new EventQueue();
    const push = (e: AgentEvent) => queue.push(e);
    const notice = (warning: string) => push({ type: "step", agent: "claude", sessionId, data: { kind: "stderrNotice", warning, countsAsTurn: false }, timestamp: Date.now() });

    push({ type: "session_start", agent: "claude", sessionId, ...(spec.model ? { model: spec.model } : {}), timestamp: Date.now() });

    const steps = o.then !== undefined && o.then.length > 0 ? new StepController({ prompts: o.then, pauseBetween: o.pauseBetween === true, write: (d) => void live.write(d), log }) : null;
    let meterErrorWarned = false;
    const tail = new TranscriptTail({
      sessionId,
      root: o.projectsRoot ?? claudeProjectsRoot(cleanEnv),
      ...(o.pollMs !== undefined ? { pollMs: o.pollMs } : {}),
      onEvent: push,
      onTurnEnd: () => steps?.turnEnded(),
      onError: (err) => {
        if (meterErrorWarned) return;
        meterErrorWarned = true;
        notice(`interactive: reading the session transcript failed (${err instanceof Error ? err.message : String(err)}); token totals may be incomplete until it recovers`);
      },
    });
    tail.start();

    // ---- publish the PTY for ach web / ach attach
    let server: LiveServerHandle | null = null;
    const info: LiveRunInfo = { runId, sessionId, agent: "claude", pid: process.pid, socket: liveSocketPath(runId), cwd, startedAt: Date.now(), ...(spec.model ? { model: spec.model } : {}) };
    try {
      server = await startLiveServer({ socketPath: info.socket, runId, sessionId, agent: "claude", target: live, ...(steps ? { controls: steps } : {}) });
      writeLiveInfo(o.stateDir, info);
      o.onLive?.(info);
      log(`[interactive] run ${runId} · session ${sessionId}`);
      log(`[interactive] watch and type: ach web (the TUI button on the run's tile) or ach attach ${runId.slice(0, 8)} (${CHORD_HELP})`);
    } catch (err) {
      notice(`interactive: could not publish the PTY for ach web / ach attach: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ---- trust dialog
    let screen = "";
    let trustHandled = false;
    const offTrust = live.onData((d) => {
      if (trustHandled) return;
      screen = (screen + d).slice(-8000);
      const keys = trustDialogKeys(screen);
      if (keys === null) return;
      trustHandled = true;
      if (o.trustWorkspace) {
        log(`[interactive] --trust-workspace: answering Claude's trust prompt for ${cwd}`);
        keys.forEach((k, i) => setTimeout(() => live.write(k), 150 * (i + 1)));
      } else {
        log(`[interactive] Claude asks whether to trust ${cwd}: answer it in the TUI (ach attach / ach web), or pass --trust-workspace`);
      }
    });

    // ---- local mirror
    let bridge: TerminalBridge | null = null;
    if (o.mirror) {
      bridge = bridgeTerminal({
        target: { input: (d) => void live.write(d), resize: (c, r) => void live.resize(c, r), continueStep: () => void steps?.continue() },
        onDetach: () => {
          bridge = null;
          process.stderr.write(`\r\n[interactive] detached; the run keeps going. Reattach: ach attach ${runId.slice(0, 8)}\r\n`);
        },
      });
      const off = live.onData((d) => bridge?.write(d));
      void live.exited.then(() => off());
    }

    let aborted = false;
    const exit: Promise<AdapterExit> = live.exited.then(async (code) => {
      offTrust();
      steps?.stop();
      bridge?.stop();
      await tail.flush();
      if (tail.file === null) {
        notice(`interactive: no transcript for session ${sessionId} under ${o.projectsRoot ?? claudeProjectsRoot(cleanEnv)}; tokens and cost are unmetered`);
      }
      removeLiveInfo(o.stateDir, runId);
      await server?.close();
      if (aborted || live.interrupted) {
        push({ type: "aborted", agent: "claude", data: { exitCode: code }, timestamp: Date.now() });
      } else if (code !== 0) {
        push({ type: "error", agent: "claude", message: `claude TUI exited ${code}`, data: { exitCode: code }, timestamp: Date.now() });
      }
      queue.close();
      if (aborted || live.interrupted) return "aborted";
      return code === 0 ? "success" : "error";
    });

    return {
      sessionId,
      attach: () => queue.attach(),
      abort() {
        aborted = true;
        live.interrupt();
      },
      wait: () => exit,
      runRecordExtras: () => ({ command: [command, ...args.map((a) => (a === spec.prompt ? `<prompt:${a.length} chars>` : a))] }),
    };
  }
}
