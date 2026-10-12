// `ach smoke` fix planner (agentic-coding-harness#139): src/core/smoke/fix.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentFix, detectToolLie, fixRecordFor, INSTALL_HINTS, planInstructionFixes, type RunFn } from "../src/core/smoke/fix.ts";
import { applyEdits } from "../src/core/smoke/report.ts";
import type { Friction, SmokeStep, StepRecord } from "../src/core/smoke/types.ts";

function step(index: number, line: number, text: string, kind: SmokeStep["kind"] = "shell"): SmokeStep {
  return { index, kind, text, line, attrs: {} };
}

function rec(s: SmokeStep, over: Partial<StepRecord> = {}): StepRecord {
  return {
    step: s,
    status: "fail",
    exitCode: 1,
    durationMs: 5,
    tokens: null,
    prompts: [],
    denials: [],
    friction: [],
    outputTail: "",
    attempt: 1,
    ...over,
  };
}

const onPath = (bins: string[]) => (b: string) => bins.includes(b);

// ---------------------------------------------------------------- detectToolLie

test("detectToolLie: doctor claims claude found, which() says absent -> tool-lied", () => {
  const s = step(1, 3, "mytool doctor");
  const r = rec(s, { status: "pass", exitCode: 0, outputTail: "mytool doctor\n✓ claude found (.claude/ present)\n✓ git ok\n" });
  const f = detectToolLie(r, onPath(["git"]));
  assert.ok(f);
  assert.equal(f.kind, "tool-lied");
  assert.equal(f.detail, "mytool doctor reported claude as installed but it is not on PATH");
  assert.equal(f.evidence, "✓ claude found (.claude/ present)");
});

test("detectToolLie: doctor table row 'claude │ ok' and '[ok] claude CLI' count as claims", () => {
  const s = step(1, 3, "x doctor");
  assert.equal(detectToolLie(rec(s, { outputTail: "agent  │ status\nclaude │ ok\n" }), onPath([]))?.evidence, "claude │ ok");
  assert.equal(detectToolLie(rec(s, { outputTail: "[ok] claude CLI\n" }), onPath([]))?.evidence, "[ok] claude CLI");
  assert.equal(detectToolLie(rec(s, { outputTail: "Claude: installed\n" }), onPath([]))?.kind, "tool-lied");
});

test("detectToolLie: honest missing report and 'not found' lines are not lies", () => {
  const s = step(1, 3, "x doctor");
  for (const line of ["✗ claude not found", "claude: missing", "claude: not installed", "[x] claude", "claude │ ✗ not on PATH"]) {
    assert.equal(detectToolLie(rec(s, { outputTail: line }), onPath([])), null, line);
  }
});

test("detectToolLie: honest found (binary really on PATH) is not a lie; project files are not bins", () => {
  const s = step(1, 3, "x doctor");
  assert.equal(detectToolLie(rec(s, { outputTail: "✓ claude found" }), onPath(["claude"])), null);
  assert.equal(detectToolLie(rec(s, { outputTail: "✓ .claude/settings.json found\n✓ node_modules present" }), onPath([])), null);
});

// ---------------------------------------------------------------- planInstructionFixes

const MSG = [
  "# Try the agent", //  1
  "", //                  2
  "Clone and run:", //    3
  "", //                  4
  "```bash", //           5
  "git clone https://example.com/repo.git", // 6
  "claude --version", //  7
  "```", //               8
].join("\n");

test("planInstructionFixes: missing claude with node also missing -> node then claude, before the fence", () => {
  const steps = [step(1, 6, "git clone https://example.com/repo.git"), step(2, 7, "claude --version")];
  const missing: Friction = { kind: "missing-prereq", detail: "claude is not installed", evidence: "zsh: command not found: claude" };
  const records = [rec(steps[0]!, { status: "pass", exitCode: 0 }), rec(steps[1]!, { exitCode: 127, friction: [missing] })];
  const { edits, notes } = planInstructionFixes({ steps, records, which: onPath(["git", "brew"]), message: MSG });
  assert.deepEqual(notes, []);
  assert.equal(edits.length, 2);
  assert.ok(edits.every((e) => e.op === "insert-before" && e.line === 5), "inserted before the ```bash fence opener");
  assert.match(edits[0]!.text, /^First install node \(the steps below assume it\):\n\n```bash\nbrew install node\n```\n$/);
  assert.match(edits[1]!.text, /^First install claude .*\n\n```bash\nnpm i -g @anthropic-ai\/claude-code\n```/);
  const out = applyEdits(MSG, edits);
  const iNode = out.indexOf("brew install node");
  const iClaude = out.indexOf("npm i -g @anthropic-ai/claude-code");
  const iFence = out.indexOf("```bash\ngit clone");
  assert.ok(iNode >= 0 && iNode < iClaude && iClaude < iFence, out);
});

test("planInstructionFixes: chain reaches brew when brew is missing too (brew, node, claude)", () => {
  const steps = [step(1, 7, "claude --version")];
  const records = [rec(steps[0]!, { friction: [{ kind: "missing-prereq", detail: "x", evidence: "claude: command not found" }] })];
  const { edits } = planInstructionFixes({ steps, records, which: onPath([]) });
  assert.deepEqual(
    edits.map((e) => e.text.split("\n")[3]),
    [INSTALL_HINTS.brew!.install, "brew install node", "npm i -g @anthropic-ai/claude-code"],
  );
  assert.equal(edits[0]!.line, 7, "without the message, the edit targets step.line");
});

test("planInstructionFixes: install already present in an earlier step -> no edit, a note", () => {
  const steps = [step(1, 6, "npm install -g @anthropic-ai/claude-code"), step(2, 7, "claude --version")];
  const records = [rec(steps[1]!, { friction: [{ kind: "missing-prereq", detail: "x", evidence: "command not found: claude" }] })];
  const { edits, notes } = planInstructionFixes({ steps, records, which: onPath(["node", "brew"]) });
  assert.deepEqual(edits, []);
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /step 1 installs it.*needs agent fix/);
});

test("planInstructionFixes: one node install for two agents that both need it", () => {
  const steps = [step(1, 6, "claude -p hi"), step(2, 7, "codex exec hi")];
  const nf = (b: string): Friction => ({ kind: "missing-prereq", detail: "x", evidence: `command not found: ${b}` });
  const records = [rec(steps[0]!, { friction: [nf("claude")] }), rec(steps[1]!, { friction: [nf("codex")] })];
  const { edits } = planInstructionFixes({ steps, records, which: onPath(["brew"]) });
  assert.equal(edits.filter((e) => e.text.includes("brew install node")).length, 1);
  assert.equal(edits.length, 3);
});

test("planInstructionFixes: tool-lied -> install inserted plus a tool-fix note", () => {
  const steps = [step(1, 6, "mytool doctor"), step(2, 7, "claude -p hello", "shell")];
  const records = [rec(steps[0]!, { status: "pass", exitCode: 0, outputTail: "✓ claude found\n" })];
  const { edits, notes } = planInstructionFixes({ steps, records, which: onPath(["node"]) });
  assert.equal(edits.length, 1);
  assert.equal(edits[0]!.op, "insert-before");
  assert.equal(edits[0]!.line, 6, "before the first step needing claude: the lying doctor step itself");
  assert.match(edits[0]!.text, /npm i -g @anthropic-ai\/claude-code/);
  assert.match(edits[0]!.reason, /reported claude as installed/);
  assert.ok(notes.some((n) => /tool fix: .*agentFix target "tool"/.test(n)), notes.join("\n"));
});

test("planInstructionFixes: device-code blocked by policy -> replace via injected fallback", () => {
  const s = step(1, 9, "az login --use-device-code");
  const f: Friction = { kind: "auth-policy-blocked", detail: "device code blocked", evidence: "AADSTS50199: blocked by Conditional Access" };
  const seen: string[] = [];
  const { edits } = planInstructionFixes({
    steps: [s],
    records: [rec(s, { friction: [f] })],
    which: onPath(["az"]),
    deviceCodeFallback: (cmd) => (seen.push(cmd), cmd.replace(/\s*--use-device-code/, "")),
  });
  assert.deepEqual(seen, ["az login --use-device-code"]);
  assert.deepEqual(edits, [
    {
      line: 9,
      op: "replace",
      original: "az login --use-device-code",
      text: "az login",
      reason: "device-code login was blocked by policy (AADSTS50199: blocked by Conditional Access); the browser login works",
    },
  ]);
});

test("planInstructionFixes: npx confirm prompt -> npx --yes; unknown prompt -> note only", () => {
  const s = step(1, 4, "npx create-thing my-app");
  const f: Friction = { kind: "interactive-prompt", detail: "waited for input" };
  const { edits } = planInstructionFixes({
    steps: [s],
    records: [rec(s, { prompts: ["Need to install the following packages: create-thing Ok to proceed? (y)"], friction: [f] })],
    which: onPath(["npx"]),
  });
  assert.equal(edits.length, 1);
  assert.equal(edits[0]!.text, "npx --yes create-thing my-app");
  assert.equal(edits[0]!.original, "npx create-thing my-app");

  const s2 = step(1, 4, "mytool setup");
  const r2 = planInstructionFixes({ steps: [s2], records: [rec(s2, { prompts: ["Password:"], friction: [f] })], which: onPath([]) });
  assert.deepEqual(r2.edits, []);
  assert.match(r2.notes[0]!, /needs agent fix/);
});

test("planInstructionFixes: unknown failure -> note only", () => {
  const s = step(1, 4, "mytool build");
  const { edits, notes } = planInstructionFixes({
    steps: [s],
    records: [rec(s, { friction: [{ kind: "failed", detail: "exited 2" }, { kind: "unstated-assumption", detail: "needs .env" }] })],
    which: onPath(["mytool"]),
  });
  assert.deepEqual(edits, []);
  assert.deepEqual(notes, ["step 1: failed: exited 2; needs agent fix", "step 1: unstated-assumption: needs .env; needs agent fix"]);
});

test("fixRecordFor: instructions record at message:L<line>", () => {
  assert.deepEqual(fixRecordFor({ line: 12, op: "replace", text: "b", original: "a", reason: "why" }, 3), {
    stepIndex: 3,
    target: "instructions",
    summary: "why",
    where: "message:L12",
    rerunPassed: null,
  });
});

// ---------------------------------------------------------------- agentFix

function runJson(reply: string, tokens = [{ inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 1 }]): string {
  return JSON.stringify(
    { runId: "r", sessionId: "s", events: [{ type: "message", source: "user", content: "<<<STEP\nnope\nSTEP>>>" }, { type: "message", source: "agent", content: reply }], tokens, totalCost: 0, durationMs: 1, exitStatus: "ok", warnings: [] },
    null,
    2,
  );
}

test("agentFix instructions: argv uses real ach run flags; markers parsed into a replace edit; tokens summed", async () => {
  const s = step(2, 7, "claude --version");
  let seenArgv: string[] = [];
  let seenCwd = "";
  const run: RunFn = async (argv, opts) => {
    seenArgv = argv;
    seenCwd = opts.cwd;
    return { code: 0, stdout: runJson("Here you go:\n<<<STEP\nnpm i -g @anthropic-ai/claude-code\nclaude --version\nSTEP>>>\n"), stderr: "" };
  };
  const out = await agentFix({ target: "instructions", agent: "null", achCli: "/x/ach.ts", message: MSG, step: s, record: rec(s), run, achArgs: ["--model", "m"] });
  assert.equal(out.error, undefined);
  assert.deepEqual(seenArgv.slice(0, 6), [process.execPath, "/x/ach.ts", "run", "--agent", "null", "--json"]);
  assert.deepEqual(seenArgv.slice(6, 8), ["--model", "m"], "achArgs land before the prompt");
  assert.match(seenArgv[8]!, /<<<STEP/);
  assert.equal(seenArgv.length, 9);
  assert.ok(seenCwd.includes("ach-smoke-fix-"));
  assert.deepEqual(out.edit, {
    line: 7,
    op: "replace",
    original: "claude --version",
    text: "npm i -g @anthropic-ai/claude-code\nclaude --version",
    reason: "agent fix: step 2 failed",
  });
  assert.equal(out.tokens, 116);
});

test("agentFix instructions: reply without markers -> error (the prompt's own markers do not count)", async () => {
  const s = step(1, 7, "claude --version");
  const run: RunFn = async () => ({ code: 0, stdout: runJson("I would install it first."), stderr: "" });
  const out = await agentFix({ target: "instructions", agent: "null", achCli: "/x/ach.ts", message: MSG, step: s, record: rec(s), run });
  assert.equal(out.edit, undefined);
  assert.match(out.error ?? "", /no <<<STEP \.\.\. STEP>>> block/);
  assert.equal(out.tokens, 116);
});

test("agentFix tool: needs a repo; collects git diff --stat after the agent edits a file", async () => {
  const s = step(1, 3, "mytool doctor");
  const r = rec(s, { status: "pass", friction: [{ kind: "tool-lied", detail: "mytool doctor reported claude as installed but it is not on PATH", evidence: "✓ claude found" }] });
  const none = await agentFix({ target: "tool", agent: "null", achCli: "/x/ach.ts", message: MSG, step: s, record: r, run: async () => ({ code: 0, stdout: "", stderr: "" }) });
  assert.match(none.error ?? "", /needs input\.repo/);

  const repo = mkdtempSync(join(tmpdir(), "smoke-fix-repo-"));
  try {
    const git = (...a: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { stdio: "pipe", timeout: 30_000 });
    git("init", "-q");
    writeFileSync(join(repo, "doctor.js"), "export const found = () => existsSync('.claude');\n");
    git("add", "doctor.js");
    git("commit", "-q", "-m", "init");
    let prompt = "";
    let cwd = "";
    const run: RunFn = async (argv, opts) => {
      prompt = argv[argv.length - 1]!;
      cwd = opts.cwd;
      writeFileSync(join(repo, "doctor.js"), "export const found = (which) => which('claude');\n// checks PATH\n");
      return { code: 0, stdout: runJson("Doctor now checks PATH for the binary.\nDetails..."), stderr: "" };
    };
    const out = await agentFix({ target: "tool", agent: "null", achCli: "/x/ach.ts", message: MSG, step: s, record: r, repo, run, achArgs: ["--permission-mode", "dontAsk"] });
    assert.equal(out.error, undefined);
    assert.equal(cwd, repo);
    assert.match(prompt, /✓ claude found/);
    assert.match(prompt, /do NOT commit/);
    assert.equal(out.toolPatch?.repo, repo);
    assert.equal(out.toolPatch?.summary, "Doctor now checks PATH for the binary.");
    assert.match(out.toolPatch?.diffStat ?? "", /doctor\.js \| \d+ [+-]+/);
    // Nothing committed by agentFix.
    assert.equal(execFileSync("git", ["-C", repo, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim(), "1");
    assert.match(readFileSync(join(repo, "doctor.js"), "utf8"), /checks PATH/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("agentFix default run: kills on timeout (code null)", async () => {
  // Drive defaultRun through agentFix with a tiny deadline: argv[0] is node, the "cli" sleeps.
  const dir = mkdtempSync(join(tmpdir(), "smoke-fix-sleep-"));
  try {
    const cli = join(dir, "sleep.mjs");
    writeFileSync(cli, "setTimeout(() => {}, 60_000);\n");
    const s = step(1, 7, "claude --version");
    const t0 = Date.now();
    const out = await agentFix({ target: "instructions", agent: "null", achCli: cli, message: MSG, step: s, record: rec(s), timeoutMs: 300 });
    assert.ok(Date.now() - t0 < 10_000);
    assert.match(out.error ?? "", /exit null.*timed out/s);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
