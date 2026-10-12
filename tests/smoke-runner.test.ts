// #139: `ach smoke` step runner (src/core/smoke/runner.ts): literal shell
// steps in one persistent terminal session, friction classification, timeout
// and group reaping, auth detection from stdout and the `open` shim, and
// prompt steps through a fake `ach run --json` entry point.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { classifyFriction, runStep, scanOutput } from "../src/core/smoke/runner.ts";
import { createSandbox, type Sandbox } from "../src/core/smoke/sandbox.ts";
import type { AuthRequest, SmokeStep } from "../src/core/smoke/types.ts";

// #139: CI also runs ubuntu-latest; the sandbox/runner are only built and measured on macOS.
const macOS = process.platform === "darwin";

let sb: Sandbox;
before(async () => {
  sb = await createSandbox({ keychain: false });
});
after(async () => {
  await sb.teardown();
});

let n = 0;
function step(text: string, kind: SmokeStep["kind"] = "shell", attrs: Record<string, string> = {}): SmokeStep {
  n += 1;
  return { index: n, kind, text, line: n, attrs };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const detectAuth = (t: string) => {
  const m = /https:\/\/login\.example\.test\/\S+/.exec(t);
  return m ? { kind: "device-code" as const, url: m[0], userCode: "ABCD-1234" } : null;
};

describe("smoke runner: one terminal session, literal text", { skip: !macOS && "the smoke sandbox is macOS-only (/bin/zsh, ps -E, lsof sweeps)" }, () => {
  it("persists cwd and exports across steps", async () => {
    const a = await runStep(sb, step(`mkdir -p proj && cd proj && export SMOKE_FOO="a b'c"`));
    assert.equal(a.status, "pass", a.outputTail);
    const b = await runStep(sb, step('pwd; echo "foo=$SMOKE_FOO"'));
    assert.equal(b.status, "pass", b.outputTail);
    assert.match(b.outputTail, new RegExp(`^${path.join(sb.home, "proj")}$`, "m"));
    assert.match(b.outputTail, /^foo=a b'c$/m);
  });

  it("picks up PATH/exports an installer wrote to ~/.zshrc", async () => {
    await runStep(sb, step("echo 'export FROM_RC=yes' >> ~/.zshrc"));
    const r = await runStep(sb, step('echo "rc=$FROM_RC"'));
    assert.match(r.outputTail, /^rc=yes$/m);
  });

  it("runs the step text literally (quotes, pipes, comments)", async () => {
    const r = await runStep(sb, step(`echo "it's | literal" | tr a-z A-Z # trailing comment`));
    assert.equal(r.status, "pass");
    assert.match(r.outputTail, /^IT'S \| LITERAL$/m);
  });

  it("keeps the step's own exit code", async () => {
    const r = await runStep(sb, step("exit 7"));
    assert.equal(r.exitCode, 7);
    assert.equal(r.status, "fail");
    assert.deepEqual(r.friction.map((f) => f.kind), ["failed"]);
    // ...and the epilogue still ran: the session survives a failing step.
    const after = await runStep(sb, step('echo "still=$SMOKE_FOO"'));
    assert.match(after.outputTail, /^still=a b'c$/m);
  });
});

describe("smoke runner: friction classification", () => {
  const s = step("x");
  const cases: Array<[string, number | null, string]> = [
    ["zsh:7: command not found: gcloudx", 127, "missing-prereq"],
    ["bash: fooctl: command not found", 127, "missing-prereq"],
    ["zsh:1: no such file or directory: ./install.sh", 127, "missing-prereq"],
    ["error: unknown option '--frobnicate'", 2, "wrong-flag"],
    ["Usage: tool [options]", 1, "wrong-flag"],
    ["mkdir: /usr/local/x: Permission denied", 1, "denied"],
    ["Error: EACCES: permission denied, open '/x'", 1, "denied"],
    ["Continue? (y/N)", 1, "interactive-prompt"],
    ["Password:", 1, "interactive-prompt"],
    ["? Which account do you want to use?", 1, "interactive-prompt"],
    ["the input device is not a tty", 1, "interactive-prompt"],
    ["security: SecKeychainItemCreateFromContent: The specified keychain could not be found. errSecNoSuchKeychain", 1, "keychain"],
    ["Error: ENOENT: no such file, open '/h/.config/app/config.json'", 1, "unstated-assumption"],
    ["OPENAI_API_KEY is not set", 1, "unstated-assumption"],
    ["something else went wrong", 3, "failed"],
  ];
  for (const [out, code, kind] of cases) {
    it(`${JSON.stringify(out)} exit ${code} -> ${kind}`, () => {
      const f = classifyFriction(out, code, s);
      assert.equal(f[0]?.kind, kind, JSON.stringify(f));
      assert.equal(f[0]?.evidence, out.trim());
    });
  }
  it("exit 0 with plain output is friction-free; a prompt on exit 0 still counts", () => {
    assert.deepEqual(classifyFriction("all good\nUsage: shown in help", 0, s), []);
    assert.deepEqual(classifyFriction("Overwrite? [Y/n]", 0, s).map((f) => f.kind), ["interactive-prompt"]);
  });
  it("names the missing binary and collects denials", () => {
    const r = scanOutput("zsh:3: command not found: gh\nopen: Operation not permitted", 127, s);
    assert.match(r.friction[0]!.detail, /`gh`/);
    assert.deepEqual(r.denials, ["open: Operation not permitted"]);
  });
  it("a real missing command in the sandbox", async () => {
    const r = await runStep(sb, step("nosuchcmd-smoke139 --version"));
    assert.equal(r.exitCode, 127);
    assert.equal(r.friction[0]?.kind, "missing-prereq");
    assert.match(r.friction[0]!.detail, /nosuchcmd-smoke139/);
  });
});

describe("smoke runner: stdin, timeout, reaping", { skip: !macOS && "the smoke sandbox is macOS-only (/bin/zsh, ps -E, lsof sweeps)" }, () => {
  it("stdin is /dev/null: a read prompt is interactive-prompt friction", async () => {
    // zsh's `read -p` means "from coprocess", so the bash-style
    // `read -p "Continue? (y/N) " x` is written as printf + read here.
    const r = await runStep(sb, step(`printf 'Continue? (y/N) '; read x`));
    assert.equal(r.status, "fail");
    assert.deepEqual(r.prompts, ["Continue? (y/N)"]);
    assert.ok(r.friction.some((f) => f.kind === "interactive-prompt"));
  });

  it("opts.input feeds stdin", async () => {
    const r = await runStep(sb, step(`read x; echo "got=$x"`), { input: "yes\n" });
    assert.equal(r.status, "pass");
    assert.match(r.outputTail, /^got=yes$/m);
  });

  it("timeout kills the whole group", async () => {
    const pidFile = path.join(sb.tmp, "timeout.pid");
    const t0 = Date.now();
    const r = await runStep(sb, step(`sleep 1000 & echo $! > ${pidFile}; wait`), { timeoutMs: 800 });
    assert.ok(Date.now() - t0 < 6000);
    assert.equal(r.status, "fail");
    assert.equal(r.friction[0]?.kind, "timeout");
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.equal(alive(pid), false, "the step's background sleep survived the timeout");
  });

  it("step attr timeout= (seconds) overrides opts.timeoutMs", async () => {
    const r = await runStep(sb, step("sleep 5", "shell", { timeout: "1" }), { timeoutMs: 60_000 });
    assert.equal(r.friction[0]?.kind, "timeout");
    assert.ok(r.durationMs < 4000);
  });

  it("kills leftovers of a finished step, but leaves deliberate `&` / nohup for teardown", async () => {
    const f1 = path.join(sb.tmp, "left.pid");
    const r1 = await runStep(sb, step(`(sleep 1000 >/dev/null 2>&1 &; echo $! > ${f1}) ; true`));
    assert.equal(r1.backgroundLeft, undefined);
    const p1 = Number(fs.readFileSync(f1, "utf8"));
    assert.equal(alive(p1), false, "leftover of an abandoned step not reaped");

    const f2 = path.join(sb.tmp, "bg.pid");
    const r2 = await runStep(sb, step(`echo started > /dev/null; sleep 1000 >/dev/null 2>&1 & echo $! > ${f2} &`));
    assert.equal(r2.backgroundLeft, true);
    const p2 = Number(fs.readFileSync(f2, "utf8"));
    assert.equal(alive(p2), true, "a deliberately backgrounded process was killed early");
    assert.ok(sb.trackedPgids.size > 0);
  });
});

describe("smoke runner: auth hook", { skip: !macOS && "the smoke sandbox is macOS-only (/bin/zsh, ps -E, lsof sweeps)" }, () => {
  it("detects a URL on stdout and calls onAuth with the step account", async () => {
    const seen: AuthRequest[] = [];
    const r = await runStep(sb, step("echo 'Open https://login.example.test/device to sign in'; sleep 0.5", "shell", { account: "me@example.com" }), {
      detectAuth,
      onAuth: async (req) => {
        seen.push(req);
        return { status: "completed", detail: "signed in", seenAccounts: ["me@example.com"] };
      },
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.url, "https://login.example.test/device");
    assert.equal(seen[0]!.account, "me@example.com");
    assert.equal(seen[0]!.stepIndex, r.step.index);
    assert.equal(seen[0]!.command, r.step.text);
    assert.equal(r.status, "pass");
    assert.equal(r.auth?.status, "completed");
    assert.deepEqual(r.friction, []);
  });

  it("treats an http(s) URL handed to the open shim as a browser auth request", async () => {
    const seen: AuthRequest[] = [];
    const r = await runStep(sb, step("open 'https://accounts.example.test/o/oauth2?x=1'; sleep 0.5"), {
      detectAuth,
      account: "default@example.com",
      onAuth: async (req) => {
        seen.push(req);
        return { status: "completed", detail: "ok", seenAccounts: [] };
      },
    });
    assert.deepEqual(seen.map((s) => [s.kind, s.url, s.account]), [["browser", "https://accounts.example.test/o/oauth2?x=1", "default@example.com"]]);
    assert.equal(r.status, "pass");
  });

  it("wrong-account kills the step at once, not at the timeout", async () => {
    const t0 = Date.now();
    const r = await runStep(sb, step("echo https://login.example.test/x; sleep 60"), {
      timeoutMs: 120_000,
      detectAuth,
      onAuth: async () => ({ status: "wrong-account", detail: "browser is signed in as other@example.com", seenAccounts: ["other@example.com"], loginScript: "tool login" }),
    });
    assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
    assert.equal(r.status, "fail");
    assert.deepEqual(r.friction.map((f) => f.kind), ["auth-wrong-account"]);
    assert.equal(r.auth?.status, "wrong-account");
  });

  it("policy-blocked and needs-human map to their friction kinds", async () => {
    for (const [status, kind] of [["policy-blocked", "auth-policy-blocked"], ["needs-human", "auth-needs-human"], ["failed", "auth-needs-human"]] as const) {
      const r = await runStep(sb, step("echo https://login.example.test/y; sleep 30"), {
        detectAuth,
        onAuth: async () => ({ status, detail: `${status} happened`, seenAccounts: [], fallback: "browser" }),
      });
      assert.deepEqual(r.friction.map((f) => f.kind), [kind]);
      assert.ok(r.durationMs < 5000);
    }
  });

  it("open steps: driven through onAuth when detected, else skipped", async () => {
    const r1 = await runStep(sb, step("https://login.example.test/z", "open"), {
      detectAuth,
      onAuth: async () => ({ status: "completed", detail: "ok", seenAccounts: [] }),
    });
    assert.equal(r1.status, "pass");
    assert.equal(r1.auth?.status, "completed");
    const r2 = await runStep(sb, step("https://docs.example.test/", "open"), { detectAuth });
    assert.equal(r2.status, "skipped");
    assert.equal(r2.outputTail, "opened https://docs.example.test/ (not driven)");
    assert.deepEqual(r2.friction, []);
  });
});

describe("smoke runner: prompt steps", { skip: !macOS && "the smoke sandbox is macOS-only (/bin/zsh, ps -E, lsof sweeps)" }, () => {
  let achCli: string;
  before(() => {
    // Fake `ach` entry: prints the `ach run --json` shape (RunResult with
    // CanonicalTokenRecord[] tokens) and echoes its argv + HOME.
    achCli = path.join(sb.tmp, "fake-ach.mjs");
    fs.writeFileSync(
      achCli,
      `process.stderr.write("[warn] something\\n");
const out = { runId: "r1", sessionId: "s1", events: [], argv: process.argv.slice(2), home: process.env.HOME,
  tokens: [
    { inputTokens: 100, outputTokens: 20, cacheReadTokens: 3, cacheWriteTokens: 4 },
    { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
  ], totalCost: 0, durationMs: 1, exitStatus: { kind: "success" }, warnings: [] };
process.stdout.write(JSON.stringify(out, null, 2) + "\\n");
`,
    );
    const fakeClaude = path.join(sb.home, ".local", "bin", "claude");
    fs.writeFileSync(fakeClaude, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  });

  it("runs `ach run --agent <agent> --json <prompt>` in the sandbox and sums tokens", async () => {
    const r = await runStep(sb, step("Summarize README.md", "prompt"), { achCli });
    assert.equal(r.status, "pass", r.outputTail);
    assert.equal(r.tokens, 130);
    const j = JSON.parse(r.outputTail.slice(r.outputTail.indexOf("{")));
    assert.deepEqual(j.argv, ["run", "--agent", "claude", "--json", "Summarize README.md"]);
    assert.equal(j.home, sb.home);
  });

  it("agent CLI not on the sandbox PATH -> missing-prereq, nothing spawned", async () => {
    const r = await runStep(sb, step("hello", "prompt", { agent: "codex" }), { achCli });
    assert.equal(r.status, "fail");
    assert.equal(r.friction[0]?.kind, "missing-prereq");
    assert.match(r.friction[0]!.detail, /agent CLI not installed/);
    assert.equal(r.tokens, null);
  });
});
