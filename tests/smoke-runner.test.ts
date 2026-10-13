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
  it("spawn ENOENT of the agent CLI -> missing-prereq naming it, evidence not npm notice", () => {
    const out = [
      "[17:25:20] error   claude failed to spawn: spawn claude ENOENT",
      "[warn] unavailable: agent CLI could not be started (claude failed to spawn: spawn claude ENOENT)",
      "exit       unavailable",
      "npm notice",
      "npm notice New major version of npm available! 11.12.1 -> 12.2.0",
    ].join("\n");
    const f = classifyFriction(out, 1, s);
    assert.deepEqual(f.map((x) => x.kind), ["missing-prereq"]);
    assert.equal(f[0]!.detail, "`claude` (the agent CLI this step runs) is not installed; the message never installs it.");
    assert.match(f[0]!.evidence!, /spawn claude ENOENT/);
    assert.doesNotMatch(f[0]!.evidence!, /npm notice/);
  });
  it("spawn ENOENT, codex form", () => {
    const f = classifyFriction("[17:25:50] error   failed to spawn codex: spawn codex ENOENT\nnpm notice", 1, s);
    assert.equal(f[0]?.kind, "missing-prereq");
    assert.match(f[0]!.detail, /^`codex` \(the agent CLI this step runs\)/);
  });
  it("spawn ENOENT of a non-agent program names it plainly", () => {
    const f = classifyFriction("Error: spawn jq ENOENT", 1, s);
    assert.equal(f[0]?.detail, "`jq` is not installed; the message never installs it.");
  });
  it("control: ENOENT on a file path stays unstated-assumption", () => {
    const f = classifyFriction("Error: ENOENT: no such file, open '/x/config.json'", 1, s);
    assert.deepEqual(f.map((x) => x.kind), ["unstated-assumption"]);
  });
  it("evidence never picks npm notice/warn: the generic failed row uses the last useful line", () => {
    const f = classifyFriction("boom happened\nnpm warn deprecated x\nnpm notice\nnpm notice New major", 1, s);
    assert.equal(f[0]?.kind, "failed");
    assert.equal(f[0]?.evidence, "boom happened");
  });
  it("an agent that refuses to run outside a git repository is an unstated assumption", () => {
    const f = classifyFriction(
      "[17:33:43] error   codex exited with code 1: Not inside a trusted directory and --skip-git-repo-check was not specified.\nexit       unavailable",
      1,
      step("ach run --agent codex \"fix the failing test\""),
    );
    assert.deepEqual(f.map((x) => x.kind), ["unstated-assumption"]);
    assert.match(f[0]!.detail, /git repository/);
  });

  it("an installed but signed-out CLI is auth-needs-human, not a bare failure", () => {
    const out = [
      "[17:29:49] error   claude: not logged in. Run `claude /login`, or set CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) or ANTHROPIC_API_KEY.",
      "[17:29:49] text    Not logged in · Please run /login",
      "ttft       avg 15ms · p50 15ms · p95 15ms (1 call)",
    ].join("\n");
    const f = classifyFriction(out, 1, s);
    assert.deepEqual(f.map((x) => x.kind), ["auth-needs-human"]);
    assert.match(f[0]!.evidence!, /not logged in/);
    // Control: the codex startup warning's "(missing auth, service outage, ...)" list is not a sign-in claim.
    const c = classifyFriction("[warn] unavailable: agent CLI exited with an error before its first event (missing auth, service outage, or a startup failure)", 1, s);
    assert.equal(c[0]?.kind, "failed");
  });
  it("the sandbox HOME has ~/.codex, so CODEX_HOME points at a real dir", { skip: !macOS && "macOS sandbox" }, () => {
    assert.equal(sb.env.CODEX_HOME, `${sb.home}/.codex`);
    assert.ok(fs.statSync(sb.env.CODEX_HOME!).isDirectory());
  });
  it("names the missing binary and collects denials", () => {
    const r = scanOutput("zsh:3: command not found: gh\nopen: Operation not permitted", 127, s);
    assert.match(r.friction[0]!.detail, /`gh`/);
    assert.deepEqual(r.denials, ["open: Operation not permitted"]);
  });
  it("a real missing command in the sandbox", { skip: !macOS && "spawns the macOS sandbox shell" }, async () => {
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

describe("smoke runner: absolute-path browser opens (#139)", { skip: !macOS && "the smoke sandbox is macOS-only (/bin/zsh, sandbox-exec)" }, () => {
  const opened = (sbx: Sandbox): string => {
    try {
      return fs.readFileSync(sbx.statePath("opened-urls.jsonl"), "utf8");
    } catch {
      return "";
    }
  };
  it("a literal /usr/bin/open URL is recorded by the shim function", async () => {
    const r = await runStep(sb, step("/usr/bin/open https://example.test/x-literal"));
    assert.equal(r.exitCode, 0);
    assert.match(opened(sb), /https:\/\/example\.test\/x-literal/);
  });
  it("a child process calling /usr/bin/open is blocked with specific denied friction", async (t) => {
    if (!sb.execGuard) return t.skip("sandbox-exec unavailable here");
    const r = await runStep(sb, step("bash -c '/usr/bin/open https://example.test/y-child'"));
    assert.notEqual(r.exitCode, 0);
    const f = r.friction.find((x) => x.kind === "denied");
    assert.ok(f, JSON.stringify(r.friction));
    assert.match(f.detail, /host browser by absolute path/);
    assert.doesNotMatch(opened(sb), /y-child/);
  });
  it("control: a normal step passes under the guard", async () => {
    const r = await runStep(sb, step("echo hi"));
    assert.equal(r.status, "pass");
    assert.match(r.outputTail, /hi/);
  });
  it("fallback: with the guard forced off, shell steps still run", async () => {
    const sb2 = await createSandbox({ keychain: false, execGuard: false });
    try {
      assert.equal(sb2.execGuard, false);
      const r = await runStep(sb2, step("echo plain; /usr/bin/open https://example.test/z-fallback"));
      assert.equal(r.exitCode, 0);
      assert.match(r.outputTail, /plain/);
      assert.match(opened(sb2), /z-fallback/);
    } finally {
      await sb2.teardown();
    }
  });
});

describe("smoke runner: loopback opens and long-running services", { skip: !macOS && "the smoke sandbox is macOS-only (/bin/zsh, lsof)" }, () => {
  it("a loopback URL handed to the open shim is not an auth request; a remote one still is", async () => {
    const seen: AuthRequest[] = [];
    const onAuth = async (req: AuthRequest) => {
      seen.push(req);
      return { status: "completed" as const, detail: "ok", seenAccounts: [] };
    };
    for (const u of ["http://127.0.0.1:8399", "http://localhost:8399/", "http://[::1]:8399", "http://0.0.0.0:8399"]) {
      const r = await runStep(sb, step(`open '${u}'; sleep 0.5`), { detectAuth, onAuth });
      assert.equal(r.status, "pass");
      assert.deepEqual((r as { localUrls?: string[] }).localUrls, [u]);
    }
    assert.equal(seen.length, 0, "a loopback URL reached the auth handler");
    await runStep(sb, step("open 'https://login.example.test/oauth/authorize?client_id=x'; sleep 0.5"), { detectAuth, onAuth });
    assert.equal(seen.length, 1, "control: a remote authorize URL must reach the auth handler");
  });

  it("a step that starts a listening server passes after the grace period, the next step runs, teardown kills it", async () => {
    const own = await createSandbox({ keychain: false });
    let pid = 0;
    try {
      const pidFile = path.join(own.tmp, "srv.pid");
      const js = `const s=require('http').createServer((q,r)=>r.end('ok')).listen(0,'127.0.0.1',()=>{require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));console.log('http://127.0.0.1:'+s.address().port)})`;
      const t0 = Date.now();
      const r = await runStep(own, step(`${JSON.stringify(process.execPath)} -e ${JSON.stringify(js)}`), { timeoutMs: 60_000, serviceGraceMs: 1000 });
      assert.ok(Date.now() - t0 < 10_000, `took ${Date.now() - t0} ms`);
      assert.equal(r.status, "pass");
      assert.deepEqual(r.friction, []);
      assert.match(r.outputTail, /left running as a service \(listening on 127\.0\.0\.1:\d+\) until teardown/);
      assert.equal((r as { service?: unknown }).service !== undefined, true);
      pid = Number(fs.readFileSync(pidFile, "utf8"));
      assert.equal(alive(pid), true, "the service was killed when its step ended");
      const r2 = await runStep(own, step("echo next"));
      assert.equal(r2.status, "pass");
      assert.equal(alive(pid), true, "the service died during a later step");
    } finally {
      await own.teardown();
    }
    assert.ok(pid > 0);
    assert.equal(alive(pid), false, "the service survived teardown");
  });

  it("control: a long-running step that listens on nothing still times out", async () => {
    const r = await runStep(sb, step("sleep 30", "shell", { timeout: "3" }), { serviceGraceMs: 500 });
    assert.equal(r.status, "fail");
    assert.equal(r.friction[0]?.kind, "timeout");
    assert.equal((r as { service?: unknown }).service, undefined);
  });
});
