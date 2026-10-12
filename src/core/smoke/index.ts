// `ach smoke` end to end (agentic-coding-harness#139): parse the message, run
// every step literally in a fresh sandbox, fix the friction in place, rerun,
// and assemble the SmokeReport the CLI prints (src/cli/smoke.ts).
//
// Decisions:
//   * Fix inline: a step with friction is planned, fixed and rerun (attempt 2)
//     right after it ran, before the next step. Later steps then see the fixed
//     environment, which is what a reader following the REVISED message gets.
//     Rerun rows sit in report.steps next to the original (step.attrs
//     "smoke-role" = install | rerun, see report.ts SMOKE_ROLE_ATTR); the
//     original row turns "fixed" when its rerun passes.
//   * planInstructionFixes is called once per record (so each edit is
//     attributed to the step whose friction caused it); its own dedupe is per
//     call, so edits are deduped here on (line, op, text).
//   * Host-level commands never run: sudo, brew / the Homebrew installer
//     (shared /opt/homebrew), xcode-select, softwareupdate, installer, system
//     package managers, launchctl, and writes under /usr/local, /opt, /etc,
//     /Library, /Applications, /System. A fix install like that becomes a
//     FixRecord with rerunPassed null; installs after it in the same chain are
//     skipped too (they depend on it). An ORIGINAL step like that is recorded
//     "skipped" with a `denied` friction row, so the run is not green: the
//     sandbox never exercised it.
//   * Tool lies are checked on EVERY record (a lying doctor exits 0), with
//     which() = `command -v` in a zsh that sources the sandbox HOME's
//     .zprofile/.zshrc and the session state, i.e. the reader's next terminal.
//   * Stub requests are attributed to the step whose time window holds them;
//     one arriving after every window (a background process) goes to the last
//     step that ended before it, and the row says so.
//   * Under `tsx src/cli/ach.ts` the entry is a .ts file plain node cannot
//     run, so prompt steps and agentFix get a small launcher (.mjs in the
//     sandbox state dir) that registers tsx and restores argv[1] (ach.ts's
//     invokedAsCli() compares argv[1] with its own path).
//   * Exit code: 0 when every step's final outcome is pass / fixed / skipped
//     with no friction left besides side-effect-stubbed, no tool lie is left
//     unpatched, and the host keychain list is unchanged; else 1. Usage
//     errors are HarnessError exitCode 2.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { HarnessError } from "../types.ts";
import { createBrowserAuthHandler, defaultLoginScript, detectAuthPrompt, deviceCodeFallback } from "./browser-auth.ts";
import { agentFix, detectToolLie, fixRecordFor, planInstructionFixes, type RunFn } from "./fix.ts";
import { parseMessage } from "./parse.ts";
import { applyEdits, finalStatuses, SMOKE_ROLE_ATTR } from "./report.ts";
import { DEFAULT_STEP_TIMEOUT_MS, runStep, type RunnerStepRecord } from "./runner.ts";
import { createSandbox, type Sandbox, type TeardownResult } from "./sandbox.ts";
import { startStubs, summarizeStubbed, type StubSet, type StubSpec } from "./stubs.ts";
import type { AuthHandler, FixRecord, Friction, MessageEdit, SmokeReport, SmokeStep, StubRequest } from "./types.ts";

export interface SmokeOptions {
  messageFile: string;
  /** Default account for auth steps (--account); a step's `account=` attr overrides. */
  account?: string;
  /** Agent for prompt steps (default claude). */
  agent?: string;
  /** CDP endpoint of the user's browser (default $CDP_BASE or http://127.0.0.1:9333). */
  cdp?: string;
  /** false = --no-browser: auth steps are handed to the user with a login script. */
  browser?: boolean;
  stubs?: StubSpec[];
  blockHosts?: string[];
  allowPath?: string[];
  /** Per-step timeout (default 300 s); a step's `timeout=` attr overrides. */
  timeoutMs?: number;
  /** false = --no-fix. */
  fix?: boolean;
  /** Agent that rewrites steps the deterministic rules cannot fix. */
  fixAgent?: string;
  /** Git checkout of a tool that lied; patched by `fixAgent` (default `agent`). */
  fixTool?: string;
  keep?: boolean;
  keychain?: boolean;
  /** Path of the running ach entry (default process.argv[1]). */
  achCli?: string;
  /** Parent dir for the sandbox root (default os.tmpdir()). */
  sandboxParent?: string;
  /** Injected auth handler (tests); default the CDP browser handler. */
  authHandler?: AuthHandler;
  authTimeoutMs?: number;
  /** Injected runner for agentFix (tests). */
  agentRun?: RunFn;
  log?: (line: string) => void;
}

export interface SmokeResult extends SmokeReport {
  exitCode: number;
  /** Planner / agent-fix notes (what could not be fixed by rule, and why). */
  notes: string[];
  /** One-line login scripts handed to the user (wrong account, needs-human). */
  loginScripts: Array<{ stepIndex: number; script: string }>;
  /** Number of message edits applied to build revisedMessage. */
  editsApplied: number;
}

// ---------------------------------------------------------------- host-level guard

const CMD = String.raw`(?:^|[\s;&|(\x60])`;
const HOST_LEVEL: Array<[RegExp, string]> = [
  [new RegExp(`${CMD}sudo\\b`), "sudo"],
  [/Homebrew\/install/, "the Homebrew installer (writes the shared Homebrew prefix)"],
  [new RegExp(`${CMD}brew\\s`), "brew (writes the shared Homebrew prefix)"],
  [new RegExp(`${CMD}xcode-select\\b`), "xcode-select"],
  [new RegExp(`${CMD}softwareupdate\\b`), "softwareupdate"],
  [new RegExp(`${CMD}installer\\s`), "installer"],
  [new RegExp(`${CMD}(?:apt|apt-get|dnf|yum|pacman|port|mas|snap)\\s+(?:install|upgrade|remove)`), "a system package manager"],
  [new RegExp(`${CMD}(?:launchctl|pkgutil)\\b|${CMD}defaults\\s+write\\b`), "a system service or preference change"],
  [
    /(?:>>?|\btee(?:\s+-a)?|\b(?:cp|mv|ln|mkdir|install|rsync|ditto|tar|chown|chmod)\b[^;&|\n]*?)\s*["']?(?<![\w~$}.\/-])\/(?:usr\/local|opt|etc|Library|Applications|System)\b/,
    "a write outside the sandbox (/usr/local, /opt, /etc, /Library, /Applications, /System)",
  ],
  [/--prefix[= ]["']?\/(?:usr\/local|opt)\b/, "an install prefix outside the sandbox"],
];

/** Why a command would write outside the sandbox, or null when it stays inside. */
export function hostLevelReason(text: string): string | null {
  for (const [re, why] of HOST_LEVEL) if (re.test(text)) return why;
  return null;
}

export const HOST_LEVEL_NOTE = "host-level install: not executed in sandbox; run it yourself or pass --allow-path <dir>";

// ---------------------------------------------------------------- helpers

function clip(s: string, n = 400): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 3)}...` : t;
}

function editKey(e: MessageEdit): string {
  return `${e.line}\u0000${e.op}\u0000${e.text}`;
}

/** which(bin) as the reader's next terminal sees it. Cached until invalidate(). */
function makeWhich(sb: Sandbox): { which: (bin: string) => boolean; invalidate: () => void } {
  const cache = new Map<string, boolean>();
  const script = [
    `[[ -r "$HOME/.zprofile" ]] && source "$HOME/.zprofile" >/dev/null 2>&1`,
    `[[ -r "$HOME/.zshrc" ]] && source "$HOME/.zshrc" >/dev/null 2>&1`,
    `[[ -r "$1" ]] && source "$1" >/dev/null 2>&1`,
    `command -v -- "$2" >/dev/null 2>&1`,
  ].join("\n");
  const which = (bin: string): boolean => {
    if (!/^[A-Za-z0-9_.@+-]+$/.test(bin)) return false;
    const hit = cache.get(bin);
    if (hit !== undefined) return hit;
    const r = spawnSync("/bin/zsh", ["-c", script, "zsh", sb.statePath("session.sh"), bin], {
      env: sb.env,
      cwd: sb.home,
      stdio: "ignore",
      timeout: 10_000,
    });
    const found = r.status === 0;
    cache.set(bin, found);
    return found;
  };
  return { which, invalidate: () => cache.clear() };
}

/** An ach entry plain node can run: .ts entries get a tsx launcher. */
function runnableAchCli(entry: string | undefined, sb: Sandbox): string | undefined {
  if (entry === undefined || !entry.endsWith(".ts")) return entry;
  let api: string;
  try {
    api = import.meta.resolve("tsx/esm/api");
  } catch {
    return entry;
  }
  const abs = path.resolve(entry);
  const launcher = sb.statePath("ach-cli.mjs");
  fs.writeFileSync(
    launcher,
    [
      "// ach smoke (#139): run the .ts ach entry under tsx for prompt steps / agent fixes.",
      `import { register } from ${JSON.stringify(api)};`,
      "register();",
      `process.argv[1] = ${JSON.stringify(abs)};`,
      `await import(${JSON.stringify(pathToFileURL(abs).href)});`,
      "",
    ].join("\n"),
  );
  return launcher;
}

function withRole(step: SmokeStep, role: "install" | "rerun", text: string, line = step.line): SmokeStep {
  return { ...step, text, line, attrs: { ...step.attrs, [SMOKE_ROLE_ATTR]: role } };
}

// ---------------------------------------------------------------- runSmoke

export async function runSmoke(opts: SmokeOptions): Promise<SmokeResult> {
  const started = Date.now();
  const log = opts.log ?? (() => {});
  let message: string;
  try {
    message = fs.readFileSync(opts.messageFile, "utf8");
  } catch (e) {
    throw new HarnessError(`cannot read message file ${opts.messageFile}: ${(e as Error).message}`, "USAGE", 2);
  }
  const steps = parseMessage(message);
  if (steps.length === 0) {
    throw new HarnessError(
      `no runnable steps in ${opts.messageFile} (steps come from sh/bash/zsh/console fences, \`$ \` lines, prompt and open fences)`,
      "USAGE",
      2,
    );
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const fixOn = opts.fix !== false;

  const records: RunnerStepRecord[] = [];
  const windows: Array<{ rec: RunnerStepRecord; start: number; end: number }> = [];
  const fixes: FixRecord[] = [];
  const edits: MessageEdit[] = [];
  const editKeys = new Set<string>();
  const notes: string[] = [];
  const loginScripts: SmokeResult["loginScripts"] = [];

  let stubs: StubSet | null = null;
  let sb: Sandbox | null = null;
  let teardown: TeardownResult | null = null;
  let stubbed: StubRequest[] = [];

  try {
    if ((opts.stubs?.length ?? 0) > 0 || (opts.blockHosts?.length ?? 0) > 0) {
      stubs = await startStubs(opts.stubs ?? [], { blockHosts: opts.blockHosts ?? [] });
      for (const [k, v] of Object.entries(stubs.env)) log(`stub: ${k}=${v}`);
    }
    sb = await createSandbox({
      env: stubs?.env ?? {},
      extraPath: opts.allowPath ?? [],
      keep: opts.keep === true,
      keychain: opts.keychain !== false,
      ...(opts.sandboxParent !== undefined ? { root: opts.sandboxParent } : {}),
    });
    const box = sb;
    log(`sandbox: ${box.root}${box.keychainPath ? " (own keychain)" : ""}`);
    const achCli = runnableAchCli(opts.achCli ?? process.argv[1], box);
    const { which, invalidate } = makeWhich(box);

    const authTimeoutMs = opts.authTimeoutMs ?? Math.min(180_000, timeoutMs);
    const onAuth: AuthHandler =
      opts.authHandler ??
      (opts.browser === false
        ? async (req) => ({
            status: "needs-human",
            detail: "--no-browser: the harness does not drive the browser; sign in yourself.",
            seenAccounts: [],
            loginScript: defaultLoginScript(req),
          })
        : createBrowserAuthHandler({
            timeoutMs: authTimeoutMs,
            log: (l) => log(l),
            ...(opts.cdp !== undefined ? { endpoint: opts.cdp } : {}),
          }));

    const post = (rec: RunnerStepRecord): void => {
      const lie = detectToolLie(rec, which);
      if (lie && !rec.friction.some((f) => f.kind === "tool-lied")) rec.friction.push(lie);
      const script = rec.auth?.loginScript;
      if (script) {
        loginScripts.push({ stepIndex: rec.step.index, script });
        for (const f of rec.friction) {
          if (f.kind.startsWith("auth-") && f.evidence === undefined) f.evidence = `login script: ${script}`;
        }
      }
    };

    const run = async (step: SmokeStep, attempt: number): Promise<RunnerStepRecord> => {
      const start = Date.now();
      const rec = await runStep(box, step, {
        timeoutMs,
        detectAuth: detectAuthPrompt,
        onAuth,
        agent: opts.agent ?? "claude",
        attempt,
        ...(opts.account !== undefined ? { account: opts.account } : {}),
        ...(achCli !== undefined ? { achCli } : {}),
      });
      windows.push({ rec, start, end: Date.now() });
      records.push(rec);
      invalidate();
      post(rec);
      return rec;
    };

    const fixStep = async (step: SmokeStep, rec: RunnerStepRecord): Promise<void> => {
      const plan = planInstructionFixes({ steps, records: [rec], which, deviceCodeFallback, message });
      notes.push(...plan.notes);
      const fresh: MessageEdit[] = [];
      const take = (e: MessageEdit) => {
        if (editKeys.has(editKey(e))) return;
        // One replacement per original line: the first planned wins.
        if (e.op === "replace" && edits.some((x) => x.op === "replace" && x.line === e.line)) return;
        editKeys.add(editKey(e));
        fresh.push(e);
      };
      plan.edits.forEach(take);

      const needsAgent = plan.notes.some((n) => n.startsWith(`step ${step.index}:`) && /needs agent fix/.test(n));
      if (opts.fixAgent && needsAgent && achCli !== undefined && !fresh.some((e) => e.op === "replace" && e.line === step.line)) {
        log(`step ${step.index}: agent fix (${opts.fixAgent})`);
        const r = await agentFix({
          target: "instructions",
          agent: opts.fixAgent,
          achCli,
          message,
          step,
          record: rec,
          ...(opts.agentRun ? { run: opts.agentRun } : {}),
        });
        if (r.edit) take(r.edit);
        else notes.push(`step ${step.index}: agent fix failed: ${r.error ?? "no edit"}`);
      }

      const toolFixes: FixRecord[] = [];
      if (opts.fixTool && achCli !== undefined && rec.friction.some((f) => f.kind === "tool-lied")) {
        const agent = opts.fixAgent ?? opts.agent ?? "claude";
        log(`step ${step.index}: tool fix in ${opts.fixTool} (${agent})`);
        const r = await agentFix({
          target: "tool",
          agent,
          achCli,
          message,
          step,
          record: rec,
          repo: opts.fixTool,
          // The user opted in with --fix-tool: a headless agent needs this to edit files (src/cli/ach.ts --permission-mode).
          achArgs: ["--permission-mode", "dontAsk"],
          ...(opts.agentRun ? { run: opts.agentRun } : {}),
        });
        if (r.toolPatch) {
          const stat = r.toolPatch.diffStat.split("\n").pop()?.trim() ?? "";
          const fx: FixRecord = { stepIndex: step.index, target: "tool", summary: `${r.toolPatch.summary}${stat ? ` (${stat})` : ""}`, where: r.toolPatch.repo, rerunPassed: null };
          fixes.push(fx);
          toolFixes.push(fx);
        } else notes.push(`step ${step.index}: tool fix failed: ${r.error ?? "no patch"}`);
      }

      if (fresh.length === 0 && toolFixes.length === 0) return;
      const mine = fresh.map((e) => {
        edits.push(e);
        const fx = fixRecordFor(e, step.index);
        fixes.push(fx);
        return { edit: e, fx };
      });

      // Execute inserted installs (in dependency order), never host-level ones.
      let blocked: string | null = null;
      let installFailed = false;
      for (const { edit, fx } of mine) {
        if (edit.op === "replace") continue;
        for (const c of parseMessage(edit.text).filter((s) => s.kind === "shell")) {
          if (blocked !== null || installFailed) {
            fx.summary = `[not run: needs ${blocked !== null ? "a host-level install" : "an install that failed"}] ${fx.summary}`;
            fx.rerunPassed = null;
            continue;
          }
          const why = hostLevelReason(c.text);
          if (why !== null) {
            blocked = why;
            fx.summary = `[host-level, not run] ${fx.summary}`;
            fx.rerunPassed = null;
            notes.push(`step ${step.index}: \`${c.text}\` is ${why}; ${HOST_LEVEL_NOTE}`);
            continue;
          }
          log(`step ${step.index}: fix install: ${c.text}`);
          const ir = await run(withRole(step, "install", c.text, edit.line), 2);
          if (ir.status !== "pass") {
            installFailed = true;
            fx.rerunPassed = false;
          }
        }
      }
      if (blocked !== null || installFailed) return;

      const replace = mine.find((m) => m.edit.op === "replace" && m.edit.line === step.line);
      const text = replace ? replace.edit.text : step.text;
      log(`step ${step.index}: rerun${replace ? `: ${text.split("\n")[0]}` : ""}`);
      const rr = await run(withRole(step, "rerun", text), 2);
      const passed = rr.status === "pass" && rr.friction.length === 0;
      for (const { fx } of mine) if (fx.rerunPassed === null) fx.rerunPassed = passed;
      for (const fx of toolFixes) fx.rerunPassed = passed;
      if (passed) rec.status = "fixed";
    };

    for (const step of steps) {
      log(`step ${step.index}/${steps.length}: ${step.text.split("\n")[0]}`);
      const why = step.kind === "shell" ? hostLevelReason(step.text) : null;
      if (why !== null) {
        const rec: RunnerStepRecord = {
          step,
          status: "skipped",
          exitCode: null,
          durationMs: 0,
          tokens: null,
          prompts: [],
          denials: [],
          friction: [{ kind: "denied", detail: `Not run: ${why} would change the host outside the sandbox; the reader runs it on their own machine.`, evidence: clip(step.text) }],
          outputTail: `[smoke] host-level command not executed (${why})`,
          attempt: 1,
        };
        records.push(rec);
        continue;
      }
      const rec = await run(step, 1);
      if (fixOn && (rec.status === "fail" || rec.friction.length > 0)) await fixStep(step, rec);
    }
  } finally {
    if (sb !== null) {
      teardown = await sb.teardown();
      log(`teardown: reaped ${teardown.reapedPids.length} process(es); host keychain unchanged: ${teardown.hostKeychainUnchanged ?? "n/a"}${teardown.kept ? `; kept ${teardown.kept}` : ""}`);
    }
    if (stubs !== null) {
      stubbed = stubs.requests();
      await stubs.close();
    }
  }

  // Attribute stub requests to the step that made them.
  const perRec = new Map<RunnerStepRecord, { reqs: StubRequest[]; late: boolean }>();
  for (const req of stubbed) {
    const t = Date.parse(req.at);
    let w = [...windows].reverse().find((x) => t >= x.start && t <= x.end + 250);
    let late = false;
    if (!w) {
      w = [...windows].filter((x) => x.end <= t).sort((a, b) => b.end - a.end)[0] ?? windows[windows.length - 1];
      late = true;
    }
    if (!w) continue;
    const e = perRec.get(w.rec) ?? { reqs: [], late: false };
    e.reqs.push(req);
    e.late ||= late;
    perRec.set(w.rec, e);
  }
  for (const [rec, { reqs, late }] of perRec) {
    const f: Friction = {
      kind: "side-effect-stubbed",
      detail: `${reqs.length} outward request${reqs.length === 1 ? "" : "s"} hit a local stub, nothing real was created${late ? " (arrived after the step finished: a background process)" : ""}: ${clip(summarizeStubbed(reqs).join("; "), 300)}`,
    };
    const body = reqs.find((r) => r.body !== "")?.body;
    if (body !== undefined) f.evidence = clip(body);
    rec.friction.push(f);
  }

  // Revised message: every edit that applies to the original text.
  const valid: MessageEdit[] = [];
  for (const e of edits) {
    try {
      applyEdits(message, [e]);
      valid.push(e);
    } catch (err) {
      notes.push(`edit at message:L${e.line} dropped: ${(err as Error).message}`);
    }
  }
  const revisedMessage = applyEdits(message, valid);

  // Exit code.
  const finals = finalStatuses(records);
  let clean = steps.every((s) => finals.has(s.index));
  for (const { status, record } of finals.values()) {
    if (status !== "pass" && status !== "fixed" && status !== "skipped") clean = false;
    if (status !== "fixed" && record.friction.some((f) => f.kind !== "side-effect-stubbed")) clean = false;
  }
  for (const r of records) {
    if (r.friction.some((f) => f.kind === "tool-lied") && !fixes.some((f) => f.target === "tool" && f.stepIndex === r.step.index)) clean = false;
  }
  if (teardown?.hostKeychainUnchanged === false) clean = false;

  return {
    messageFile: opts.messageFile,
    sandboxRoot: sb?.root ?? "",
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    steps: records,
    fixes,
    revisedMessage,
    hostKeychainUnchanged: teardown?.hostKeychainUnchanged ?? null,
    reapedPids: teardown?.reapedPids ?? [],
    stubbedRequests: stubbed,
    exitCode: clean ? 0 : 1,
    notes,
    loginScripts,
    editsApplied: valid.length,
  };
}
