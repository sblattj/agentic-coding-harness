// Kiro IDE adapter (issue #110): drives the Kiro IDE (Electron desktop app)
// over Chrome DevTools Protocol. There is no agent CLI here: the adapter finds
// (or launches) the IDE, makes sure the chat is in Autopilot, starts a fresh
// chat session, types the prompt with CDP Input events, polls the chat text
// until a new "Elapsed time:" line appears, and parses the final text into
// the harness event vocabulary. Unlike kiro-cli, the IDE loads
// `.kiro/hooks/*.json`, so hook runs are visible and reported.
//
// Every DOM/selector fact below was observed live on Kiro IDE 1.2.4
// (2026-10-01); anything not observed is marked UNVERIFIED.
import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  type AdapterCapabilities,
  type AdapterExit,
  type AgentAdapter,
  type AgentEvent,
  type AgentHandle,
  type RunSpec,
} from "../core/types.ts";
import {
  CdpSession,
  DEEP_TEXT_JS,
  KIRO_IDE_SELECTORS,
  browserVersion,
  clickByTextJs,
  endpointFrom,
  listTargets,
  type CdpTarget,
} from "./kiro-ide-cdp.ts";

export const KIRO_IDE_CAPABILITIES: AdapterCapabilities = {
  // A GUI app: needs a display session and a signed-in profile.
  headless: false,
  // One final snapshot per prompt, not an incremental stream.
  streaming: false,
  resume: false,
  acp: false,
  tmuxFallback: false,
};

export const KIRO_IDE_MODEL_LABEL = "kiro-ide";
const DEFAULT_PORT = 9222;

// ---------------------------------------------------------------- parser

export interface KiroIdeToolCall {
  name: string;
  args: string[];
}

export interface KiroIdeTurn {
  /** The assistant's reply text (heuristic slice, see parseKiroIdeTurn). */
  reply: string;
  credits: number | null;
  elapsedSeconds: number | null;
  /** Names listed under "Run Command Hook" blocks. */
  hooks: string[];
  toolCalls: KiroIdeToolCall[];
  /** The N in "N tool call(s)" (0 when absent). */
  toolCallCount: number;
  /** True when the prompt echo was located in the text. */
  promptFound: boolean;
  /** True when both the credits line and the elapsed line were present. */
  complete: boolean;
}

const CREDITS_RE = /Est\. Credits Used:\s*([0-9]+(?:\.[0-9]+)?)/;
// Format for >= 60 s is UNVERIFIED ("1m 5s" assumed); only "3s" was observed.
const ELAPSED_RE = /Elapsed time:\s*(?:(\d+)h\s*)?(?:(\d+)m\s*)?(\d+(?:\.\d+)?)s/;
const TOOL_COUNT_RE = /^(\d+) tool calls?$/;
// Heuristic: a tool NAME line is Title Case words only ("Read File"); args
// carry dots/slashes/digits/quotes. Used only to split a multi-tool block.
const TOOL_NAME_RE = /^[A-Z][a-z]+(?: [A-Z][a-z]+)*$/;

/**
 * Parse the chat webview's `document.body.innerText` after one turn.
 *
 * Observed layout (Kiro IDE 1.2.4, see tests fixture):
 *   <title> / Loading / Artifacts / 0 / Starting cloud session / Checkpoint /
 *   Restore / <prompt echo> / [Run Command Hook / <name>...] / Kiro /
 *   [N tool call(s) / <Tool Name> / <arg lines>] / <reply> /
 *   Est. Credits Used: X / Elapsed time: Ns / ... / Auto / Default / Autopilot
 *
 * Reliable: credits and elapsed (regex on labelled lines). Heuristic: the
 * prompt-echo boundary (lastIndexOf of the prompt, else the "Restore" line),
 * hook names (non-empty lines after "Run Command Hook" until "Kiro"), the
 * tool block (non-empty lines after "N tool call(s)" until the first blank
 * line; names of multiple tools are split by a Title-Case heuristic), and the
 * reply (everything after the tool block up to the credits line, so a
 * multi-step turn with interleaved tool blocks leaks later blocks into it).
 */
export function parseKiroIdeTurn(fullText: string, prompt: string): KiroIdeTurn {
  const text = fullText.replace(/\r\n/g, "\n");
  const creditsMatch = CREDITS_RE.exec(text);
  const elapsedMatch = ELAPSED_RE.exec(text);
  const credits = creditsMatch ? Number(creditsMatch[1]) : null;
  const elapsedSeconds = elapsedMatch
    ? Number(elapsedMatch[1] ?? 0) * 3600 + Number(elapsedMatch[2] ?? 0) * 60 + Number(elapsedMatch[3])
    : null;

  // 1. Start boundary: after the prompt echo.
  let start = 0;
  let promptFound = false;
  const p = prompt.trim();
  const at = p === "" ? -1 : text.lastIndexOf(p);
  if (at >= 0) {
    start = at + p.length;
    promptFound = true;
  } else {
    // Fallback: the echo is the first paragraph after the last "Restore" line.
    const restore = text.lastIndexOf("\nRestore\n");
    if (restore >= 0) {
      const after = text.slice(restore + "\nRestore\n".length);
      const m = /^\s*\n[^\n]+(?:\n[^\n]+)*/.exec(after) ?? /^[^\n]+(?:\n[^\n]+)*/.exec(after);
      start = restore + "\nRestore\n".length + (m ? m[0].length : 0);
    }
  }
  // 2. End boundary: the credits line (else the elapsed line, else the end).
  let end = creditsMatch ? creditsMatch.index : elapsedMatch ? elapsedMatch.index : text.length;
  if (end < start) end = text.length;
  const lines = text.slice(start, end).split("\n").map((l) => l.trimEnd());

  const hooks: string[] = [];
  const toolCalls: KiroIdeToolCall[] = [];
  let toolCallCount = 0;
  let i = 0;
  const stop = (l: string) => l.trim() === "Kiro" || l.trim() === "Run Command Hook" || TOOL_COUNT_RE.test(l.trim());
  // Pre-reply preamble: hooks, then the "Kiro" marker, then the tool block.
  let replyFrom = -1;
  while (i < lines.length) {
    const l = lines[i]!.trim();
    if (l === "Run Command Hook") {
      i++;
      while (i < lines.length && lines[i]!.trim() !== "" && !stop(lines[i]!)) hooks.push(lines[i++]!.trim());
      continue;
    }
    if (l === "Kiro") {
      i++;
      continue;
    }
    const tc = TOOL_COUNT_RE.exec(l);
    if (tc) {
      toolCallCount = Number(tc[1]);
      i++;
      const block: string[] = [];
      while (i < lines.length && lines[i]!.trim() !== "") block.push(lines[i++]!.trim());
      if (toolCallCount <= 1) {
        if (block.length) toolCalls.push({ name: block[0]!, args: block.slice(1) });
      } else {
        let cur: KiroIdeToolCall | null = null;
        for (const b of block) {
          if (TOOL_NAME_RE.test(b)) {
            cur = { name: b, args: [] };
            toolCalls.push(cur);
          } else if (cur) cur.args.push(b);
          else {
            cur = { name: b, args: [] };
            toolCalls.push(cur);
          }
        }
      }
      replyFrom = i;
      break;
    }
    if (l === "") {
      i++;
      continue;
    }
    // First real content line outside any marker: the reply begins here.
    replyFrom = i;
    break;
  }
  const replyLines = replyFrom >= 0 ? lines.slice(replyFrom) : [];
  // Hooks that fire after the reply are not tracked separately (UNVERIFIED layout).
  const reply = replyLines.join("\n").trim();

  return {
    reply,
    credits,
    elapsedSeconds,
    hooks,
    toolCalls,
    toolCallCount,
    promptFound,
    complete: credits !== null && elapsedSeconds !== null,
  };
}

// ---------------------------------------------------------------- helpers

/** Does a workbench page title identify the workspace folder `cwd`? Heuristic:
 * VS Code titles are "<folder>" or "<file> — <folder>" (observed: "ws-a",
 * "hello.txt — ws-a"), so any " — "-separated segment equal to the basename. */
export function workspaceTitleMatches(title: string, cwd: string | undefined): boolean {
  if (!cwd) return true;
  const base = path.basename(path.resolve(cwd)).toLowerCase();
  return title
    .split(/\s[—–-]\s/)
    .map((s) => s.replace(/^[●•]\s*/, "").trim().toLowerCase())
    .includes(base);
}

const AUTOPILOT_STATE_JS =
  "(() => { const i = document.getElementById('autopilot-toggle'); return i ? (i.checked ? 'on' : 'off') : 'unknown'; })()";
const HAS_INPUT_JS = `!!document.querySelector(${JSON.stringify(KIRO_IDE_SELECTORS.chatInput)})`;
const FOCUS_INPUT_JS = `(() => { const e = document.querySelector(${JSON.stringify(KIRO_IDE_SELECTORS.chatInput)}); if (!e) return false; e.focus(); return document.activeElement === e || e.contains(document.activeElement); })()`;
// Observed: a button with aria-label "New session" in the chat webview.
const NEW_SESSION_JS =
  "(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || x.title || '') === 'New session'); if (!b) return 'none'; b.click(); return 'clicked'; })()";
const BODY_TEXT_JS = "document.body.innerText";

const countElapsed = (s: string): number => (s.match(/Elapsed time:/g) ?? []).length;

export interface SpawnedChild {
  pid?: number;
  exitCode?: number | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  unref?(): void;
  on?(event: string, cb: (...args: any[]) => void): unknown;
}
export type SpawnFn = (cmd: string, args: string[], opts: { detached: boolean; stdio: "ignore" }) => SpawnedChild;

export interface KiroIdeAdapterOptions {
  /** Process launcher seam (tests record calls; default node:child_process.spawn). */
  spawn?: SpawnFn;
  now?: () => number;
  /** Chat poll interval, default 1000 ms. */
  pollMs?: number;
  /** Bound on launch + ready, default 60 000 ms. */
  readyTimeoutMs?: number;
  platform?: NodeJS.Platform;
  homeDir?: string;
  /** Wait before the one --reuse-window recovery re-invocation, default 5000 ms. */
  recoverMs?: number;
}

export function defaultKiroBin(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === "darwin") return "/Applications/Kiro.app/Contents/MacOS/Kiro";
  // UNVERIFIED (never observed on Windows): installer default per-user location.
  if (platform === "win32") return path.win32.join(env.LOCALAPPDATA ?? "", "Programs", "Kiro", "Kiro.exe");
  // UNVERIFIED (never observed on Linux): assume `kiro` on PATH.
  return "kiro";
}

class EventQueue {
  private items: AgentEvent[] = [];
  private waiters: Array<() => void> = [];
  private closed = false;
  push(e: AgentEvent): void {
    this.items.push(e);
    this.wake();
  }
  close(): void {
    this.closed = true;
    this.wake();
  }
  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }
  async *iterate(): AsyncIterable<AgentEvent> {
    for (;;) {
      while (this.items.length) yield this.items.shift()!;
      if (this.closed) return;
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }
}

class RunFailure extends Error {}
class Aborted extends Error {}

// ---------------------------------------------------------------- adapter

export class KiroIdeAdapter implements AgentAdapter {
  readonly name = "kiro-ide";
  readonly capabilities: AdapterCapabilities = KIRO_IDE_CAPABILITIES;

  readonly #spawn: SpawnFn;
  readonly #now: () => number;
  readonly #pollMs: number;
  readonly #readyTimeoutMs: number;
  readonly #platform: NodeJS.Platform;
  readonly #homeDir: string;
  readonly #recoverMs: number;

  constructor(options: KiroIdeAdapterOptions = {}) {
    this.#spawn = options.spawn ?? ((cmd, args, opts) => nodeSpawn(cmd, args, opts) as unknown as SpawnedChild);
    this.#now = options.now ?? Date.now;
    this.#pollMs = options.pollMs ?? 1000;
    this.#readyTimeoutMs = options.readyTimeoutMs ?? 60_000;
    this.#platform = options.platform ?? process.platform;
    this.#homeDir = options.homeDir ?? os.homedir();
    this.#recoverMs = options.recoverMs ?? 5000;
  }

  async launch(spec: RunSpec): Promise<AgentHandle> {
    const cfg = spec.kiroIde ?? {};
    const sessionId = spec.resume && spec.resume !== "" ? spec.resume : `kiro-ide-${randomUUID()}`;
    const queue = new EventQueue();
    const ts = () => this.#now();
    const emit = (e: { type: string; [k: string]: unknown }) =>
      queue.push({ ...e, timestamp: ts(), sessionId } as AgentEvent);

    let aborted = false;
    let wake: (() => void) | null = null;
    let freshChild: SpawnedChild | null = null;
    let freshExited = false;
    const sessions: CdpSession[] = [];

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          wake = null;
          resolve();
        }, ms);
        wake = () => {
          clearTimeout(t);
          wake = null;
          resolve();
        };
      });
    const checkAbort = () => {
      if (aborted) throw new Aborted();
    };

    const attachMode = typeof cfg.cdp === "string" && cfg.cdp.trim() !== "";
    const endpoint = attachMode ? endpointFrom(cfg.cdp, DEFAULT_PORT) : `127.0.0.1:${cfg.port ?? DEFAULT_PORT}`;
    const bin = cfg.bin ?? defaultKiroBin(this.#platform);
    const userDataDir = cfg.userDataDir ?? path.join(this.#homeDir, ".local", "state", "ach-kiro-ide", "profile");
    const cwd = spec.cwd;

    let launchError: Error | null = null;
    const spawnChild = (args: string[]): SpawnedChild => {
      const child = this.#spawn(bin, args, { detached: true, stdio: "ignore" });
      child.on?.("error", (e: Error) => {
        launchError = e;
      });
      child.unref?.();
      return child;
    };

    const answers = async (): Promise<boolean> => {
      try {
        await browserVersion(endpoint, { timeoutMs: 1500 });
        return true;
      } catch {
        return false;
      }
    };

    const deadline = this.#now() + this.#readyTimeoutMs;
    const timeLeft = () => deadline - this.#now();

    const run = async (): Promise<void> => {
      emit({ type: "session_start", agent: "kiro-ide" });
      if (spec.model) {
        emit({
          type: "progress",
          text: `kiro-ide: model '${spec.model}' ignored (the IDE chat's model cannot be pinned over CDP)`,
        });
      }

      // ---- 1/2. endpoint + launch
      let preexisting = false;
      if (!attachMode) {
        preexisting = await answers();
        checkAbort();
        const wsArgs = cwd ? [cwd] : [];
        if (preexisting) {
          // An IDE already owns the profile: point its window at the workspace.
          spawnChild([`--user-data-dir=${userDataDir}`, "--reuse-window", ...wsArgs]);
        } else {
          freshChild = spawnChild([`--remote-debugging-port=${cfg.port ?? DEFAULT_PORT}`, `--user-data-dir=${userDataDir}`, ...wsArgs]);
          freshChild.on?.("exit", () => {
            freshExited = true;
          });
        }
      }

      // ---- 3. ready: chat target + matching workspace, first-run screens, sign-in
      let recovered = false;
      const readyStart = this.#now();
      let workbench: CdpSession | null = null;
      let workbenchId = "";
      let chatTarget: CdpTarget | null = null;
      let skipAttempts = 0;
      for (;;) {
        checkAbort();
        if (launchError) throw new RunFailure(`could not start Kiro IDE '${bin}': ${(launchError as Error).message}`);
        if (timeLeft() <= 0) {
          throw new RunFailure(
            `Kiro IDE not ready after ${this.#readyTimeoutMs}ms on ${endpoint} (${chatTarget ? "chat ready" : "no chat webview target"}; workspace ${cwd ?? "(any)"}). ` +
              (attachMode ? "Is the IDE running with --remote-debugging-port?" : `Profile ${userDataDir}.`),
          );
        }
        let targets: CdpTarget[] = [];
        try {
          targets = await listTargets(endpoint, { timeoutMs: 2000 });
        } catch {
          targets = [];
        }
        const page = targets.find((t) => t.type === "page" && t.url.includes(KIRO_IDE_SELECTORS.workbenchUrl));
        const chat = targets.find((t) => t.url.includes(KIRO_IDE_SELECTORS.chatTargetUrl));
        if (page) {
          if (!workbench || workbenchId !== page.id) {
            workbench?.close();
            try {
              workbench = await CdpSession.connect(page, { timeoutMs: 3000 });
              sessions.push(workbench);
              await workbench.enableRuntime();
              workbenchId = page.id;
            } catch {
              workbench = null;
            }
          }
          if (workbench) {
            try {
              const texts = await workbench.evaluateEach<string>(DEEP_TEXT_JS);
              const deep = texts.map((t) => t.value ?? "").join(" | ");
              if (deep.includes("Sign in") && deep.includes("By signing in")) {
                throw new RunFailure(`Kiro IDE is not signed in for profile ${userDataDir}; launch it once and sign in`);
              }
              if (deep.includes("Skip All") && skipAttempts < 5) {
                skipAttempts++;
                // Only the Electron Isolated Context finds the button; evaluateEach tries every context.
                await workbench.evaluateEach<string>(clickByTextJs("Skip All"));
                emit({ type: "progress", text: "kiro-ide: dismissed first-run onboarding (Skip All)" });
              }
            } catch (e) {
              if (e instanceof RunFailure) throw e;
              workbench = null; // reconnect next round
            }
          }
        }
        const wsOk = attachMode || !page || workspaceTitleMatches(page.title ?? "", cwd);
        if (page && chat && wsOk) {
          chatTarget = chat;
          break;
        }
        chatTarget = null;
        // Window-closed / wrong-folder recovery: one re-invocation of the reuse form.
        if (!attachMode && !recovered && this.#now() - readyStart >= this.#recoverMs && (page || preexisting)) {
          recovered = true;
          spawnChild([`--user-data-dir=${userDataDir}`, "--reuse-window", ...(cwd ? [cwd] : [])]);
        }
        await sleep(Math.min(500, Math.max(50, this.#pollMs)));
      }

      // ---- chat session
      const chat = await CdpSession.connect(chatTarget!, { timeoutMs: 5000 });
      sessions.push(chat);
      await chat.enableRuntime();
      const findCtx = async (): Promise<number | undefined> => {
        for (const r of await chat.evaluateEach<boolean>(HAS_INPUT_JS)) if (r.value === true) return r.contextId;
        return undefined;
      };
      let ctx: number | undefined;
      while ((ctx = await findCtx()) === undefined) {
        checkAbort();
        if (timeLeft() <= 0) throw new RunFailure(`Kiro IDE chat input (${KIRO_IDE_SELECTORS.chatInput}) never appeared within ${this.#readyTimeoutMs}ms`);
        await sleep(300);
      }

      // ---- 4. Autopilot (a supervised tool call would block until the wall timeout)
      const mode = await chat.evaluate<string>(AUTOPILOT_STATE_JS, ctx);
      if (mode === "off") {
        throw new RunFailure(
          "Kiro IDE chat is not in Autopilot mode (supervised tool calls would block waiting for approval); turn Autopilot on in the chat and retry",
        );
      }
      if (mode !== "on") {
        emit({ type: "progress", text: "kiro-ide: could not read the Autopilot switch (#autopilot-toggle missing); proceeding" });
      }

      // ---- 5. new session
      if (cfg.newSession !== false) {
        const r = await chat.evaluate<string>(NEW_SESSION_JS, ctx);
        if (r !== "clicked") {
          emit({ type: "progress", text: "kiro-ide: 'New session' button not found; continuing in the current chat" });
        } else {
          const t0 = this.#now();
          for (;;) {
            checkAbort();
            ctx = (await findCtx()) ?? ctx;
            const txt = (await chat.evaluate<string>(BODY_TEXT_JS, ctx)) ?? "";
            if (countElapsed(txt) === 0 || this.#now() - t0 > 4000) break;
            await sleep(200);
          }
        }
      }

      // ---- 6. send
      checkAbort();
      const before = countElapsed((await chat.evaluate<string>(BODY_TEXT_JS, ctx)) ?? "");
      const focused = await chat.evaluate<boolean>(FOCUS_INPUT_JS, ctx);
      if (!focused) throw new RunFailure("could not focus the Kiro IDE chat input");
      await chat.insertText(spec.prompt);
      await chat.pressEnter();

      // ---- 7. wait for a new "Elapsed time:"
      let fails = 0;
      let finalText = "";
      for (;;) {
        await sleep(this.#pollMs);
        checkAbort();
        try {
          const txt = (await chat.evaluate<string>(BODY_TEXT_JS, ctx)) ?? "";
          fails = 0;
          if (countElapsed(txt) > before) {
            finalText = txt;
            break;
          }
        } catch (e) {
          if (++fails >= 5) throw new RunFailure(`lost the Kiro IDE chat while waiting: ${e instanceof Error ? e.message : String(e)}`);
          ctx = (await findCtx().catch(() => undefined)) ?? ctx;
        }
      }

      // ---- 8/9. parse + events
      const turn = parseKiroIdeTurn(finalText, spec.prompt);
      if (!turn.complete) emit({ type: "progress", text: "kiro-ide: final chat text lacked credits/elapsed lines" });
      emit({ type: "message", source: "assistant", content: turn.reply });
      for (const h of turn.hooks) emit({ type: "tool_call", functionName: `hook:${h}`, title: `Run Command Hook ${h}` });
      for (const t of turn.toolCalls) {
        emit({ type: "tool_call", functionName: t.name, arguments: t.args.join("\n"), title: [t.name, ...t.args].join(" ") });
      }
      const credits = turn.credits ?? 0;
      emit({
        type: "usage",
        usage: {
          model: KIRO_IDE_MODEL_LABEL,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          extra: {
            credits,
            creditsCumulative: credits,
            source: "native",
            tokensAvailable: false,
            ...(turn.elapsedSeconds !== null ? { turnDurationMs: turn.elapsedSeconds * 1000 } : {}),
          },
        },
      });
      emit({ type: "step", payload: { countsAsTurn: true } });
    };

    const done: Promise<AdapterExit> = run()
      .then<AdapterExit>(() => "success")
      .catch<AdapterExit>((e) => {
        if (e instanceof Aborted || aborted) return "aborted";
        emit({ type: "error", message: e instanceof Error ? e.message : String(e) });
        return "error";
      })
      .then((exit) => {
        emit({ type: "session_end" });
        for (const s of sessions) s.close();
        queue.close();
        return exit;
      });

    return {
      sessionId,
      attach: () => queue.iterate(),
      abort(): void {
        if (aborted) return;
        aborted = true;
        wake?.();
        // Only a child THIS run started fresh may be killed; a hand-off child
        // already exited and the pre-existing IDE is never touched. A normal
        // (non-aborted) run leaves the IDE running.
        if (freshChild && !freshExited) {
          try {
            freshChild.kill();
          } catch {
            /* already gone */
          }
        }
      },
      wait: () => done,
    };
  }
}
