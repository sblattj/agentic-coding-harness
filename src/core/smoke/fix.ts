// `ach smoke` fix-in-place planner (agentic-coding-harness#139).
//
// "Fix in place: patch the tool when it lied (for example, a doctor that
// reported an install as found when only project files existed), patch the
// instructions when they were wrong or missing a step, then rerun the failing
// step." This module PLANS those fixes; the integration (index.ts) applies the
// MessageEdits with report.ts applyEdits and reruns the step.
//
// Decisions (each is tested in tests/smoke-fix.test.ts):
//   * Two lanes. planInstructionFixes() is deterministic: a small rule per
//     friction kind, one MessageEdit per root cause, and a note for anything it
//     cannot fix by rule ("needs agent fix"). agentFix() is the slow lane: it
//     runs a coding agent on the HOST through the harness itself
//     (`ach run --agent <a> --json <prompt>`) to rewrite one step or to patch
//     the lying tool's repo.
//   * Tool lies (detectToolLie): a line in the step's output that CLAIMS a
//     binary is present ("✓ claude found", "claude │ ok", "[ok] claude CLI")
//     while which(bin) says it is not on the sandbox PATH. Only KNOWN binaries
//     (INSTALL_HINTS keys + the adapter binaries of src/cli/doctor.ts:107
//     AGENT_BINARY) are looked for, so ordinary words never become "bins";
//     lines that say "not found"/"missing"/"✗"/... are never claims.
//   * Install hints reuse the repo's own strings where they overlap:
//     src/cli/doctor.ts:94 (claude, `npm i -g @anthropic-ai/claude-code`),
//     :95 (codex, `@openai/codex`), :96 (gemini, `@google/gemini-cli`),
//     :97 (opencode, `opencode-ai`). The Homebrew installer is prefixed
//     NONINTERACTIVE=1 because the sandbox rerun has no TTY; without it the
//     installer's "Press RETURN" confirm would cost one more fix round.
//   * Inserted installs go BEFORE the fence that holds the first step needing
//     the binary (needs the optional `message` input; without it the edit
//     targets step.line, which is only right for a `$ ` line outside a
//     fence). The block copies the message's own fence style (``` vs ~~~, and
//     the shell info string it already uses).
//   * Chains: an install whose hint `needs` another missing binary inserts
//     that one first (depth <= 3), as separate edits at the same line in
//     dependency order; applyEdits keeps input order at one position
//     (src/core/smoke/report.ts:184 applyEdits sort).
//   * Never duplicate: an install already planned in this call, or already
//     present in an earlier step's text (matched on the package / installer
//     token, so `npm i -g` and `npm install -g` both count), is not inserted
//     again. When an earlier step installs X and X is STILL missing, that is a
//     failed install, reported as a "needs agent fix" note.
//   * agentFix argv uses only flags that exist in `ach run`:
//     --agent (src/cli/ach.ts:564, required at :633), --json (:605); the
//     prompt is the positionals joined (:640). `--json` prints the full
//     RunResult on stdout (:759); tokens are RunResult.tokens
//     (src/core/types.ts:1212 CanonicalTokenRecord[]), summed as
//     input+output+cacheRead+cacheWrite (idiom: src/cli/dash.ts:255). The
//     agent's final message is the last `message` event with source
//     agent|assistant (src/core/types.ts:238 MessageEvent).
//   * Permissions: a headless agent under ach's default policy will not edit
//     files or run tests, so target "tool" needs e.g. `--permission-mode
//     dontAsk` (src/cli/ach.ts:577). That is never defaulted here; the caller
//     passes it through `achArgs` (spliced before the prompt).
//   * agentFix never commits or pushes; the tool patch is reported as
//     `git -C <repo> diff --stat`, read with git itself (not the injected run).

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FixRecord, Friction, MessageEdit, SmokeStep, StepRecord } from "./types.ts";

// ---------------------------------------------------------------- install hints

export const INSTALL_HINTS: Record<string, { install: string; needs?: string[] }> = {
  // src/cli/doctor.ts:94-97 INSTALL_HINT: same package strings.
  claude: { install: "npm i -g @anthropic-ai/claude-code", needs: ["node"] },
  codex: { install: "npm i -g @openai/codex", needs: ["node"] },
  gemini: { install: "npm i -g @google/gemini-cli", needs: ["node"] },
  opencode: { install: "npm i -g opencode-ai", needs: ["node"] },
  // macOS: Node.js (and npm with it) from Homebrew.
  node: { install: "brew install node", needs: ["brew"] },
  npm: { install: "brew install node", needs: ["brew"] },
  brew: {
    install: 'NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
  },
  gh: { install: "brew install gh", needs: ["brew"] },
  az: { install: "brew install azure-cli", needs: ["brew"] },
  gcloud: { install: "brew install --cask google-cloud-sdk", needs: ["brew"] },
  aws: { install: "brew install awscli", needs: ["brew"] },
  git: { install: "xcode-select --install" },
  jq: { install: "brew install jq", needs: ["brew"] },
  python3: { install: "brew install python", needs: ["brew"] },
  uv: { install: "curl -LsSf https://astral.sh/uv/install.sh | sh" },
  bun: { install: "curl -fsSL https://bun.sh/install | bash" },
  pnpm: { install: "npm i -g pnpm", needs: ["node"] },
};

/** Adapter binaries whose names differ from the agent (src/cli/doctor.ts:107 AGENT_BINARY) plus other agent CLIs. */
const EXTRA_KNOWN_BINS = ["prime-agent", "cursor-agent", "kiro-cli", "copilot"];

function knownBins(): string[] {
  // Longest first so "cursor-agent" wins over a shorter overlapping name.
  return [...new Set([...Object.keys(INSTALL_HINTS), ...EXTRA_KNOWN_BINS])].sort((a, b) => b.length - a.length);
}

function escRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `bin` as a whole word: not part of `.claude`, `claude-code`, `node_modules`, `/usr/bin/node`. */
function binWordRe(bin: string): RegExp {
  return new RegExp(`(?<![\\w@/.~-])${escRe(bin)}(?![\\w/-])`, "i");
}

function clip(s: string, n = 400): string {
  const t = s.trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

// ---------------------------------------------------------------- tool lies

const NEGATIVE_LINE = /not found|not installed|not on path|missing|unavailable|not available|absent|\bfail(ed|s|ure)?\b|\berror\b|✗|✘|❌|\[\s*(x|fail|err|error|no)\s*\]|\bno\b/i;
const POSITIVE_LINE =
  /✓|✔|✅|\[\s*(ok|✓|pass|found|yes)\s*\]|\b(found|installed|available|detected|ok|present|ready)\b/i;

interface Lie {
  bin: string;
  friction: Friction;
}

function findToolLies(record: StepRecord, which: (bin: string) => boolean): Lie[] {
  const out: Lie[] = [];
  const seen = new Set<string>();
  const bins = knownBins();
  for (const raw of record.outputTail.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || NEGATIVE_LINE.test(line) || !POSITIVE_LINE.test(line)) continue;
    for (const bin of bins) {
      if (seen.has(bin) || !binWordRe(bin).test(line)) continue;
      // A longer known name on this line (e.g. cursor-agent) already covers its prefix.
      if (which(bin)) continue;
      seen.add(bin);
      out.push({
        bin,
        friction: {
          kind: "tool-lied",
          detail: `${record.step.text} reported ${bin} as installed but it is not on PATH`,
          evidence: clip(line),
        },
      });
    }
  }
  return out;
}

/**
 * The first output line that claims a known binary is present while it is not
 * on the sandbox PATH, as a "tool-lied" Friction; null when the step's output
 * makes no such false claim.
 */
export function detectToolLie(record: StepRecord, which: (bin: string) => boolean): Friction | null {
  return findToolLies(record, which)[0]?.friction ?? null;
}

// ---------------------------------------------------------------- planning helpers

/** The binary a missing-prereq friction is about, recovered from its evidence/detail. */
function missingBin(record: StepRecord, f: Friction, which: (bin: string) => boolean): string | null {
  const text = `${f.evidence ?? ""}\n${f.detail}`;
  // The runner names the binary in backticks ("agent CLI not installed — … (`claude` is not on PATH)"):
  // prefer that over the prose patterns below, which would read "CLI not installed" as a binary named CLI.
  for (const m of text.matchAll(/`([\w@.+-]+)`/g)) {
    if (!which(m[1]!)) return m[1]!;
  }
  const pats = [
    /command not found:\s*([\w@.+-]+)/i,
    /([\w@.+-]+):\s*command not found/i,
    /([\w@.+-]+):\s*not found/i,
    /spawn\s+([\w@.+-]+)\s+ENOENT/i,
    /([\w@.+-]+)\s+(?:is )?not (?:installed|on PATH)/i,
  ];
  for (const re of pats) {
    const m = re.exec(text);
    const cand = m?.[1];
    if (cand && !/^(sh|bash|zsh|line|\d+)$/.test(cand) && !which(cand)) return cand;
  }
  // Fallback: a known bin named in the friction, then the step's command word.
  for (const bin of knownBins()) {
    if (binWordRe(bin).test(text) && !which(bin)) return bin;
  }
  const first = commandWord(record.step.text);
  return first && !which(first) ? first : null;
}

/** The command word of a shell line: skips `sudo`, `VAR=val` prefixes. */
function commandWord(text: string): string | null {
  const toks = text.trim().replace(/^\$\s+/, "").split(/\s+/);
  for (const t of toks) {
    if (t === "sudo" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue;
    return t.replace(/^.*\//, "") || null;
  }
  return null;
}

/** Tokens that identify an install line, so `npm i -g X` and `npm install -g X` match. */
function installTokens(install: string): string[] {
  const urls = install.match(/https?:\/\/[^\s"')]+/g);
  if (urls) return urls;
  const toks = install.split(/\s+/).filter((t) => t && !t.startsWith("-"));
  const last = toks[toks.length - 1];
  return last ? [last] : [];
}

function stepInstalls(text: string, bin: string): boolean {
  const hint = INSTALL_HINTS[bin];
  if (!hint) return false;
  const toks = installTokens(hint.install);
  if (toks.length === 0) return false;
  if (/https?:\/\//.test(toks[0]!)) return toks.some((u) => text.includes(u));
  if (!/\b(install|add|i)\b/.test(text) && !/xcode-select/.test(text)) return false;
  return toks.some((t) => new RegExp(`(?<![\\w@/.-])${escRe(t)}(?![\\w/-])`).test(text));
}

const SHELL_INFO = /^(sh|bash|zsh|console|shell|shellsession)$/i;

/** Where to insert before `step`, and the fence style to copy. */
function insertionPoint(step: SmokeStep, message: string | undefined): { line: number; fence: string; info: string } {
  const dflt = { line: step.line, fence: "```", info: "sh" };
  if (message === undefined) return dflt;
  const lines = message.split("\n");
  let open: { line: number; fence: string; info: string } | null = null;
  let style: { fence: string; info: string } | null = null;
  for (let i = 0; i < Math.min(step.line - 1, lines.length); i++) {
    const m = /^\s*(`{3,}|~{3,})\s*([\w-]*)/.exec(lines[i]!);
    if (!m) continue;
    if (open === null) {
      open = { line: i + 1, fence: m[1]!, info: m[2] ?? "" };
      if (SHELL_INFO.test(open.info)) style = { fence: open.fence, info: open.info };
    } else if (m[1]!.startsWith(open.fence[0]!) && m[1]!.length >= open.fence.length && !m[2]) {
      open = null;
    }
  }
  if (open) {
    const info = SHELL_INFO.test(open.info) ? open.info : (style?.info ?? "sh");
    return { line: open.line, fence: open.fence, info };
  }
  return { line: step.line, fence: style?.fence ?? "```", info: style?.info ?? "sh" };
}

/** The first step (document order) whose text uses `bin` as a word; else the failing step. */
function firstStepNeeding(steps: SmokeStep[], bin: string, fallback: SmokeStep): SmokeStep {
  const re = binWordRe(bin);
  const hit = [...steps].sort((a, b) => a.index - b.index).find((s) => re.test(s.text));
  return hit && hit.index <= fallback.index ? hit : fallback;
}

// ---------------------------------------------------------------- interactive prompts

const YES_NO = /\(y\/n\)|\[y\/n\]|\by\/n\b|\(yes\/no\)|\[yes\/no\]|ok to proceed\?|press return/i;

/** Non-interactive rewrite of a confirm-prompting command, or null when the table has none. */
function nonInteractive(text: string): string | null {
  const t = text;
  if (/^\s*npx\s/.test(t) && !/^\s*npx\s+(--yes|-y)\b/.test(t)) return t.replace(/^(\s*)npx\s+/, "$1npx --yes ");
  if (/^\s*npm\s+init\b/.test(t) && !/\s(-y|--yes)\b/.test(t)) return t.replace(/^(\s*npm\s+init)\b/, "$1 -y");
  const apt = /^(\s*(?:sudo\s+)?apt(?:-get)?\s+(?:install|upgrade|remove|purge|full-upgrade|dist-upgrade|autoremove))\b/.exec(t);
  if (apt && !/\s(-y|--yes|--assume-yes)\b/.test(t)) return t.replace(apt[1]!, `${apt[1]} -y`);
  if (/Homebrew\/install/.test(t) && !/NONINTERACTIVE=1/.test(t)) return `NONINTERACTIVE=1 ${t.trimStart()}`;
  return null;
}

// ---------------------------------------------------------------- planner

/** Marker in a missing-prereq detail: an earlier host-level step would have installed the bin. */
export const HOST_LEVEL_SKIPPED_RE = /host-level and was not run in the sandbox/;

/**
 * An earlier step smoke skipped as host-level that installs `bin`: `brew install [tap/]X` with
 * X (last path segment) equal to `bin`. `npm i -g pkg` has an unknown bin, so it never matches.
 */
export function skippedInstaller(bin: string, steps: SmokeStep[], skippedIdx: ReadonlySet<number>, before: number): SmokeStep | undefined {
  return steps.find((s) => {
    if (s.index >= before || !skippedIdx.has(s.index)) return false;
    return s.text.split(/[;&|\n]+/).some((cmd) => {
      const toks = cmd.trim().split(/\s+/);
      const i = toks.findIndex((t, k) => t === "brew" && /^(?:install|reinstall)$/.test(toks[k + 1] ?? ""));
      if (i < 0) return false;
      return toks.slice(i + 2).some((t) => !t.startsWith("-") && t.replace(/^.*\//, "").replace(/@[\d.]+$/, "") === bin);
    });
  });
}

export function planInstructionFixes(input: {
  steps: SmokeStep[];
  records: StepRecord[];
  which: (bin: string) => boolean;
  deviceCodeFallback?: (cmd: string) => string | null;
  /** The message text: lets an insertion land before the enclosing fence, in the message's fence style. */
  message?: string;
}): { edits: MessageEdit[]; notes: string[] } {
  const { steps, which } = input;
  const edits: MessageEdit[] = [];
  const notes: string[] = [];
  const planned = new Set<string>(); // bins whose install is already planned
  const replaced = new Set<number>(); // step indexes already replaced
  const records = [...input.records].sort((a, b) => a.step.index - b.step.index || a.attempt - b.attempt);

  const alreadyInstalledBefore = (bin: string, before: SmokeStep): SmokeStep | undefined =>
    steps.find((s) => s.index < before.index && stepInstalls(s.text, bin));

  /** Plan the install chain for `bin` before the first step needing it. Returns false when nothing could be planned. */
  const planInstall = (bin: string, failing: SmokeStep, why: string): void => {
    if (planned.has(bin)) return;
    const hint = INSTALL_HINTS[bin];
    if (!hint) {
      notes.push(`step ${failing.index}: ${bin} is missing and has no known install hint; needs agent fix`);
      return;
    }
    const target = firstStepNeeding(steps, bin, failing);
    const earlier = alreadyInstalledBefore(bin, target) ?? alreadyInstalledBefore(bin, failing);
    if (earlier) {
      notes.push(
        `step ${failing.index}: ${bin} is still missing although step ${earlier.index} installs it (${earlier.text}); the install failed; needs agent fix`,
      );
      planned.add(bin);
      return;
    }
    // Dependency chain, deepest first (depth <= 3).
    const chain: string[] = [];
    const walk = (b: string, depth: number) => {
      if (depth > 3 || chain.includes(b)) return;
      for (const dep of INSTALL_HINTS[b]?.needs ?? []) {
        if (which(dep) || planned.has(dep) || !INSTALL_HINTS[dep]) continue;
        if (alreadyInstalledBefore(dep, target)) continue;
        walk(dep, depth + 1);
      }
      chain.push(b);
    };
    walk(bin, 1);
    const at = insertionPoint(target, input.message);
    for (const b of chain) {
      if (planned.has(b)) continue;
      planned.add(b);
      const lead = `First install ${b} (the steps below assume it):`;
      edits.push({
        line: at.line,
        op: "insert-before",
        text: [lead, "", `${at.fence}${at.info}`, INSTALL_HINTS[b]!.install, at.fence, ""].join("\n"),
        reason: b === bin ? why : `${b} is needed to install ${bin} and is not installed either`,
      });
    }
  };

  for (const r of records) {
    const step = r.step;
    // Tool lies first: a passing doctor can still lie.
    for (const lie of findToolLies(r, which)) {
      planInstall(lie.bin, step, `${lie.friction.detail}; the instructions trusted it (${lie.friction.evidence ?? ""})`);
      notes.push(`step ${step.index}: tool fix: ${lie.friction.detail}; evidence: ${lie.friction.evidence ?? ""} (agentFix target "tool")`);
    }
    for (const f of r.friction) {
      switch (f.kind) {
        case "missing-prereq": {
          if (HOST_LEVEL_SKIPPED_RE.test(f.detail)) {
            notes.push(`step ${step.index}: ${f.detail}; the message is fine, nothing to fix`);
            break;
          }
          const bin = missingBin(r, f, which);
          if (!bin) {
            notes.push(`step ${step.index}: missing-prereq (${f.detail}) names no missing binary; needs agent fix`);
            break;
          }
          planInstall(bin, step, `${bin} is not installed and the instructions never install it${f.evidence ? ` (${clip(f.evidence, 160)})` : ""}`);
          break;
        }
        case "tool-lied":
          // Recorded by the runner; installs are planned from the output above.
          break;
        case "auth-policy-blocked": {
          if (replaced.has(step.index)) break;
          // The injected fallback (browser-auth.ts) decides what counts as device-code; null = nothing to swap.
          const fb = input.deviceCodeFallback ? input.deviceCodeFallback(step.text) : null;
          if (fb && fb !== step.text) {
            replaced.add(step.index);
            edits.push({
              line: step.line,
              op: "replace",
              original: step.text,
              text: fb,
              reason: `device-code login was blocked by policy (${clip(f.evidence ?? f.detail, 200)}); the browser login works`,
            });
          } else {
            notes.push(`step ${step.index}: auth blocked by policy (${f.detail}); no deterministic fallback; needs agent fix`);
          }
          break;
        }
        case "interactive-prompt": {
          if (replaced.has(step.index)) break;
          const confirm = [...r.prompts, f.evidence ?? ""].some((p) => YES_NO.test(p));
          const fixed = confirm ? nonInteractive(step.text) : null;
          if (fixed && fixed !== step.text) {
            replaced.add(step.index);
            edits.push({
              line: step.line,
              op: "replace",
              original: step.text,
              text: fixed,
              reason: `the step stopped at a confirm prompt (${clip(r.prompts.find((p) => YES_NO.test(p)) ?? f.evidence ?? "", 160)}) the message never mentioned`,
            });
          } else {
            notes.push(`step ${step.index}: interactive prompt (${f.detail}); no known non-interactive flag; needs agent fix`);
          }
          break;
        }
        case "unstated-assumption":
        case "wrong-flag":
        case "failed":
          notes.push(`step ${step.index}: ${f.kind}: ${f.detail}; needs agent fix`);
          break;
        default:
          break;
      }
    }
  }
  return { edits, notes };
}

// ---------------------------------------------------------------- fix records

export function fixRecordFor(edit: MessageEdit, stepIndex: number): FixRecord {
  return { stepIndex, target: "instructions", summary: edit.reason, where: `message:L${edit.line}`, rerunPassed: null };
}

// ---------------------------------------------------------------- agent fix

export type RunFn = (
  argv: string[],
  opts: { cwd: string; timeoutMs: number },
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const DEFAULT_TIMEOUT_MS = 600_000;

/** Spawn argv[0] with a wall-clock deadline; the whole process group is killed on timeout (code null). */
export const defaultRun: RunFn = (argv, opts) =>
  new Promise((resolve) => {
    const [cmd, ...args] = argv;
    const child = spawn(cmd!, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + String(e.message) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? null : code, stdout, stderr: timedOut ? `${stderr}\n[smoke] agent fix timed out after ${opts.timeoutMs} ms` : stderr });
    });
  });

interface ParsedRun {
  tokens: number | null;
  messages: string[];
  ok: boolean;
}

/** Parse `ach run --json` stdout (a pretty-printed RunResult, src/cli/ach.ts:759). */
function parseRunJson(stdout: string): ParsedRun {
  let obj: unknown;
  try {
    obj = JSON.parse(stdout);
  } catch {
    const i = stdout.search(/^\{/m);
    if (i >= 0) {
      try {
        obj = JSON.parse(stdout.slice(i));
      } catch {
        obj = undefined;
      }
    }
  }
  if (!obj || typeof obj !== "object") return { tokens: null, messages: [], ok: false };
  const o = obj as { tokens?: unknown; events?: unknown };
  let tokens: number | null = null;
  if (Array.isArray(o.tokens)) {
    tokens = 0;
    for (const t of o.tokens as Array<Record<string, unknown>>) {
      const n = (k: string) => (typeof t[k] === "number" ? (t[k] as number) : 0);
      tokens += n("inputTokens") + n("outputTokens") + n("cacheReadTokens") + n("cacheWriteTokens");
    }
  }
  const messages: string[] = [];
  if (Array.isArray(o.events)) {
    for (const e of o.events as Array<Record<string, unknown>>) {
      if (e.type !== "message") continue;
      const src = e.source ?? e.role;
      if (src !== "agent" && src !== "assistant") continue;
      const c = typeof e.content === "string" ? e.content : typeof e.text === "string" ? e.text : "";
      if (c) messages.push(c);
    }
  }
  return { tokens, messages, ok: true };
}

const STEP_MARKERS = /<<<STEP[ \t]*\r?\n?([\s\S]*?)\r?\n?[ \t]*STEP>>>/g;

function lastMarked(texts: string[]): string | null {
  for (let i = texts.length - 1; i >= 0; i--) {
    const all = [...texts[i]!.matchAll(STEP_MARKERS)];
    const m = all[all.length - 1];
    if (m) return unfence(m[1]!.trim());
  }
  return null;
}

/**
 * Drop a markdown fence the agent wrapped around the whole replacement. The
 * edit lands INSIDE the message's existing fence, so a kept fence nests, and the
 * rerun hands its backticks to zsh as a command substitution (seen live:
 * ```sh / ls -ltr / ``` reran as `total: command not found`).
 */
function unfence(text: string): string {
  const lines = text.split(/\r?\n/);
  const open = /^[ \t]*(`{3,}|~{3,})[^`]*$/.exec(lines[0] ?? "");
  if (!open || lines.length < 2) return text;
  const close = lines[lines.length - 1]!.trim();
  if (!close.startsWith(open[1]!) || close.replace(/[`~]/g, "") !== "") return text;
  return lines.slice(1, -1).join("\n").trim();
}

function frictionLines(record: StepRecord): string {
  return record.friction.length
    ? record.friction.map((f) => `- ${f.kind}: ${f.detail}${f.evidence ? `\n  evidence: ${f.evidence}` : ""}`).join("\n")
    : "- (none recorded)";
}

export async function agentFix(input: {
  target: "instructions" | "tool";
  agent: string;
  achCli: string;
  message: string;
  step: SmokeStep;
  record: StepRecord;
  repo?: string;
  run?: RunFn;
  /** Extra `ach run` flags spliced before the prompt, e.g. ["--permission-mode", "dontAsk"] for target "tool". */
  achArgs?: string[];
  timeoutMs?: number;
}): Promise<{
  edit?: MessageEdit;
  toolPatch?: { repo: string; summary: string; diffStat: string };
  tokens: number | null;
  error?: string;
}> {
  const run = input.run ?? defaultRun;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const tail = input.record.outputTail.slice(-2000);
  const argvFor = (prompt: string) => [
    process.execPath,
    input.achCli,
    "run",
    "--agent",
    input.agent,
    "--json",
    // The fix agent works on the HOST for the user, so claude uses the user's
    // own login: a per-run CLAUDE_CONFIG_DIR cannot see the keychain session
    // and fails "Not logged in" (src/cli/ach.ts --claude-default-config).
    ...(input.agent === "claude" ? ["--claude-default-config"] : []),
    ...(input.achArgs ?? []),
    prompt,
  ];

  if (input.target === "instructions") {
    const prompt = [
      "You are fixing a how-to message that a brand-new user followed literally in a clean sandbox. One step failed.",
      "",
      "The message:",
      "-----",
      input.message,
      "-----",
      "",
      `Failing step ${input.step.index} (message line ${input.step.line}, ${input.step.kind}):`,
      input.step.text,
      "",
      "Output tail:",
      tail || "(empty)",
      "",
      "Friction:",
      frictionLines(input.record),
      "",
      "Reply with ONLY the replacement text for that step (it may be several lines if a step was missing),",
      "on its own lines between a line containing <<<STEP and a line containing STEP>>>, as plain command text with no markdown fence. Do not edit any files.",
    ].join("\n");
    const cwd = mkdtempSync(join(tmpdir(), "ach-smoke-fix-"));
    try {
      const res = await run(argvFor(prompt), { cwd, timeoutMs });
      const parsed = parseRunJson(res.stdout);
      const text = lastMarked(parsed.ok ? parsed.messages : [res.stdout]);
      if (text === null || text === "") {
        return {
          tokens: parsed.tokens,
          error: `the fixing agent's reply has no <<<STEP ... STEP>>> block (exit ${res.code ?? "null"}${res.stderr.trim() ? `: ${clip(res.stderr, 200)}` : ""})`,
        };
      }
      return {
        edit: {
          line: input.step.line,
          op: "replace",
          original: input.step.text,
          text,
          reason: `agent fix: ${input.record.friction[0]?.detail ?? `step ${input.step.index} failed`}`,
        },
        tokens: parsed.tokens,
      };
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  // target === "tool"
  const repo = input.repo;
  if (!repo) return { tokens: null, error: 'agentFix target "tool" needs input.repo (a git checkout of the tool)' };
  try {
    execFileSync("git", ["-C", repo, "rev-parse", "--is-inside-work-tree"], { stdio: "pipe", timeout: 30_000 });
  } catch {
    return { tokens: null, error: `${repo} is not a git checkout` };
  }
  const lie = input.record.friction.find((f) => f.kind === "tool-lied");
  const evidence = lie?.evidence ?? input.record.outputTail.split("\n").slice(-5).join("\n");
  const truth = lie?.detail ?? frictionLines(input.record);
  const prompt = [
    `The command \`${input.step.text}\` (this repository's tool) reported:`,
    evidence,
    "",
    `but the sandbox state shows: ${truth}.`,
    "",
    "Make the tool report the truth (for example, a doctor must check that the binary is on PATH and runs, not that project files exist).",
    "Add or adjust a test that would have caught this, run the repository's tests, and do NOT commit or push.",
    "End with a one-line summary of the change as the first line of your final message.",
  ].join("\n");
  const res = await run(argvFor(prompt), { cwd: repo, timeoutMs });
  const parsed = parseRunJson(res.stdout);
  let diffStat = "";
  try {
    diffStat = execFileSync("git", ["-C", repo, "diff", "--stat"], { encoding: "utf8", timeout: 30_000 }).trim();
  } catch (e) {
    return { tokens: parsed.tokens, error: `git diff --stat failed in ${repo}: ${(e as Error).message}` };
  }
  const final = parsed.messages[parsed.messages.length - 1] ?? "";
  const summary = final.trim().split("\n")[0]?.trim() ?? "";
  if (!diffStat) {
    return {
      tokens: parsed.tokens,
      error: `the fixing agent left no changes in ${repo} (exit ${res.code ?? "null"})${summary ? `: ${summary}` : ""}`,
    };
  }
  return { toolPatch: { repo, summary: summary || "tool patched (no summary)", diffStat }, tokens: parsed.tokens };
}
