// `ach smoke` end to end through the real entry (#139): spawn
// `node --import tsx src/cli/ach.ts smoke ...` (one process, so SIGINT lands
// on the process that owns the sandbox) against fakes only: fake CLIs on
// --allow-path, a local Jira stub, and a FAKE CDP browser
// (tests/support/fake-login-pages.ts). No network, no real browser, no host
// keychain writes (the host search list is compared byte for byte).
//
// The CLI runs with async spawn: the fake browser lives in this process's
// event loop, so a spawnSync would deadlock it.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { hostLevelReason } from "../src/core/smoke/index.ts";
import { PAGES, startFakeBrowser, type FakeBrowser } from "./support/fake-login-pages.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO, "src/cli/ach.ts");
const darwin = process.platform === "darwin";
const hasZsh = fs.existsSync("/bin/zsh");

interface CliRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function startCli(args: string[], opts: { cwd: string; timeoutMs?: number }): { child: ReturnType<typeof spawn>; done: Promise<CliRun> } {
  const env = { ...process.env };
  delete env.CDP_BASE; // never fall back to the user's real browser
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), CLI, "smoke", ...args], {
    cwd: opts.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (b: Buffer) => (stdout += b.toString()));
  child.stderr!.on("data", (b: Buffer) => (stderr += b.toString()));
  const done = new Promise<CliRun>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 150_000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
  return { child, done };
}

function hostKeychainList(): string | null {
  if (!darwin) return null;
  return spawnSync("/usr/bin/security", ["list-keychains", "-d", "user"], { encoding: "utf8", timeout: 15_000 }).stdout;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function script(dir: string, name: string, body: string): void {
  fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

/** Rows of the text friction table, keyed by the `#` cell. */
function tableRows(stdout: string): Map<string, string> {
  const rows = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    if (line === "") break;
    const m = /^(\d+(?: rerun| fix)?)\s{2,}/.exec(line);
    if (m && !rows.has(m[1]!)) rows.set(m[1]!, line);
  }
  return rows;
}

describe("hostLevelReason: what never runs in the sandbox", () => {
  for (const c of [
    "sudo npm i -g x",
    "brew install gh",
    'NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
    "xcode-select --install",
    "mkdir -p /Library/Foo",
    "cp x /etc/y",
    "echo x > /usr/local/etc/a",
    "./configure --prefix=/opt/tool",
  ]) {
    it(`host-level: ${c}`, () => assert.notEqual(hostLevelReason(c), null));
  }
  for (const c of [
    "npm i -g pnpm",
    "curl -LsSf https://astral.sh/uv/install.sh | sh",
    "mkdir -p ~/Library/Application\\ Support/Foo",
    'cp cfg "$HOME/Library/Preferences/x.plist"',
    "mkdir -p ~/.local/opt/tool",
    "cat /etc/hosts",
    "brewery --help",
  ]) {
    it(`stays in the sandbox: ${c}`, () => assert.equal(hostLevelReason(c), null));
  }
});

describe("ach smoke end to end", { skip: !hasZsh && "the smoke runner needs /bin/zsh" }, () => {
  let root: string;
  let bin: string;
  let browser: FakeBrowser;

  before(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "smoke-cli-")));
    bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    // A health check that lies: aws is not on the sandbox PATH (its install hint is host-level brew, so nothing is installed).
    script(bin, "doctor", 'echo "checking tools"\necho "✓ aws found"\nexit 0');
    // Device-code login whose tenant blocks device code; without the flag it uses the browser flow.
    script(
      bin,
      "fakelogin",
      [
        'case " $* " in',
        '  *" --use-device-code "*) echo "To sign in, use a web browser to open the page https://login.example.com/policy?user_code=ABCD-EFGH and enter the code ABCD-EFGH to authenticate."; sleep 30; exit 1;;',
        '  *) echo "Opening https://login.example.com/oauth/authorize?client_id=demo&state=1 in your browser"; sleep 2; echo "Logged in."; exit 0;;',
        "esac",
      ].join("\n"),
    );
    script(bin, "fakedevice", 'echo "Open https://login.example.com/device and enter the code WXYZ-1234"\nsleep 2\necho "Device authorized."\nexit 0');
    browser = await startFakeBrowser({ pages: { ...PAGES, "/oauth/authorize": PAGES["/chooser"]! } });
  });

  after(async () => {
    await browser?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("runs every step, records the friction, fixes, reaps, and leaves the host keychain alone", async () => {
    const pidFile = path.join(root, "bg.pid");
    const msg = path.join(root, "howto.md");
    fs.writeFileSync(
      msg,
      [
        "# Setup",
        "",
        "```sh",
        "echo hello",
        "mkdir -p proj && cd proj",
        "export GREETING=hi",
        "```",
        "",
        "```sh",
        'test "$(basename "$PWD")" = proj && test "$GREETING" = hi',
        "faketool --version",
        "doctor",
        "ls /nonexistent-smoke-dir",
        `curl -s -X POST -H 'content-type: application/json' -d '{"fields":{"summary":"smoke"}}' "$JIRA_BASE_URL/rest/api/2/issue"`,
        `sh -c 'echo $$ > ${pidFile}; exec sleep 1000' &`,
        "fakelogin --use-device-code",
        "```",
        "",
        "```sh account=a@example.com",
        "fakedevice",
        "```",
        "",
        "```sh account=c@example.com",
        "fakedevice",
        "```",
        "",
      ].join("\n"),
    );
    const kcBefore = hostKeychainList();
    const outDir = path.join(root, "out");
    const { done } = startCli(
      [msg, "--stub", "jira=JIRA_BASE_URL", "--allow-path", bin, "--cdp", `http://${browser.endpoint}`, "--account", "a@example.com", "--out", outDir, "--timeout", "60"],
      { cwd: root },
    );
    const r = await done;
    if (process.env.SMOKE_CLI_DEBUG) process.stderr.write(r.stdout + r.stderr);
    assert.equal(r.code, 1, `exit 1 expected\n${r.stdout}\n${r.stderr}`);
    const rows = tableRows(r.stdout);
    const row = (k: string) => {
      const v = rows.get(k);
      assert.ok(v, `table row ${k} missing:\n${r.stdout}`);
      return v!;
    };
    // 1-3 set up, 4 proves cd + export persisted across steps.
    for (const k of ["1", "2", "3", "4"]) assert.match(row(k), /\spass\s/);
    assert.match(row("5"), /\sfail\s.*missing-prereq/);
    assert.match(row("6"), /\spass\s.*tool-lied.*\[host-level, not run\]/);
    assert.match(row("7"), /\sfail\s.*\bfailed\b/);
    assert.match(row("8"), /\spass\s.*side-effect-stubbed/);
    assert.match(row("9"), /\spass\s/);
    assert.match(row("10"), /\sfixed\s.*auth-policy-blocked/);
    assert.match(row("10 rerun"), /fakelogin\s+pass\s/);
    assert.match(row("11"), /\spass\s/);
    assert.match(row("12"), /\sfail\s.*auth-wrong-account/);
    // The login script is handed over for the wrong-account step.
    assert.match(r.stdout, /login scripts \(run these yourself\):\n\s+step 12: printf '%s\\n' 'Sign in to c@example\.com in your browser, then run:' 'fakedevice'/);
    // Nothing was clicked for c@example.com: after the last device-code fill (step 12's tab) only snapshots.
    const lastFill = browser.ops.map((o) => o.op).lastIndexOf("fill-code");
    assert.ok(lastFill >= 0);
    assert.deepEqual(
      browser.ops.slice(lastFill + 1).filter((o) => o.op !== "snapshot"),
      [],
      "a click happened on the wrong-account tab",
    );
    assert.ok(browser.ops.some((o) => o.op === "click-account" && o.args === "a@example.com"), "a@example.com tile clicked");
    assert.ok(browser.closeCalls().length >= 4, "every auth tab closed");
    assert.equal(browser.createCalls(), browser.closeCalls().length);

    // Revised message.
    const revised = fs.readFileSync(path.join(outDir, "howto.smoked.md"), "utf8");
    assert.match(revised, /First install aws/);
    assert.match(revised, /\nfakelogin\n/);
    assert.doesNotMatch(revised, /--use-device-code/);
    assert.equal(fs.readFileSync(msg, "utf8").includes("--use-device-code"), true, "input untouched");

    // Background process reaped.
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    assert.ok(pid > 0);
    assert.equal(alive(pid), false, `background pid ${pid} still alive`);
    assert.match(r.stdout, /reaped pids: [1-9]/);

    // Host keychain search list byte-identical.
    if (darwin) {
      assert.equal(hostKeychainList(), kcBefore);
      assert.match(r.stdout, /host keychain unchanged: yes/);
    }
    // Sandbox removed.
    const sbRoot = /sandbox removed: (\S+)/.exec(r.stdout)?.[1];
    assert.ok(sbRoot && !fs.existsSync(sbRoot), `sandbox root left behind: ${sbRoot}`);
  });

  it("--json prints the SmokeReport; the stub saw exactly the one Jira POST", async () => {
    const msg = path.join(root, "json.md");
    fs.writeFileSync(
      msg,
      ["```sh", "echo ok", `curl -s -X POST -d '{"a":1}' "$JIRA_BASE_URL/rest/api/2/issue"`, "nosuchcmd-smoke", "```", ""].join("\n"),
    );
    const { done } = startCli([msg, "--stub", "jira=JIRA_BASE_URL", "--json", "--no-browser", "--out", path.join(root, "out-json")], { cwd: root });
    const r = await done;
    assert.equal(r.code, 1, r.stderr);
    const j = JSON.parse(r.stdout) as Record<string, any>;
    for (const k of ["messageFile", "sandboxRoot", "startedAt", "durationMs", "steps", "fixes", "revisedMessage", "hostKeychainUnchanged", "reapedPids", "stubbedRequests", "exitCode", "revisedMessagePath"]) {
      assert.ok(k in j, `--json lacks ${k}`);
    }
    assert.equal(j.exitCode, 1);
    assert.equal(j.steps.length, 3);
    assert.deepEqual(j.stubbedRequests.map((q: any) => `${q.stub} ${q.method} ${q.path}`), ["jira POST /rest/api/2/issue"]);
    assert.equal(j.steps[1].friction[0].kind, "side-effect-stubbed");
    assert.equal(j.steps[2].friction[0].kind, "missing-prereq");
    if (darwin) assert.equal(j.hostKeychainUnchanged, true);
    assert.ok(fs.existsSync(j.revisedMessagePath));
  });

  it("a fully passing message exits 0", async () => {
    const msg = path.join(root, "ok.md");
    fs.writeFileSync(msg, ["## Try it", "", "```sh", "echo hi", "cd /tmp", "export X=1", 'test "$X" = 1', "```", ""].join("\n"));
    const { done } = startCli([msg, "--out", path.join(root, "out-ok")], { cwd: root });
    const r = await done;
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /steps: 4 \(pass 4, fail 0, fixed 0, skipped 0\)/);
    assert.equal(fs.readFileSync(path.join(root, "out-ok", "ok.smoked.md"), "utf8"), fs.readFileSync(msg, "utf8"));
  });

  it("usage errors exit 2: missing file, unknown flag, bad --format", async () => {
    for (const args of [[path.join(root, "missing.md")], ["--bogus"], [path.join(root, "ok.md"), "--format", "html"], []]) {
      const r = await startCli(args, { cwd: root }).done;
      assert.equal(r.code, 2, `${args.join(" ")}: ${r.stderr}`);
      assert.match(r.stderr, /harness: smoke: /);
    }
  });

  it("Ctrl-C mid-step: exits, kills the step, removes the sandbox, host keychain unchanged", async () => {
    const pidFile = path.join(root, "int.pid");
    const homeFile = path.join(root, "int.home");
    const msg = path.join(root, "int.md");
    fs.writeFileSync(msg, ["```sh", `echo "$HOME" > ${homeFile}`, `sh -c 'echo $$ > ${pidFile}; exec sleep 1000'`, "```", ""].join("\n"));
    const kcBefore = hostKeychainList();
    const { child, done } = startCli([msg, "--out", path.join(root, "out-int")], { cwd: root, timeoutMs: 60_000 });
    const t0 = Date.now();
    while (!fs.existsSync(pidFile) || fs.readFileSync(pidFile, "utf8").trim() === "") {
      assert.ok(Date.now() - t0 < 45_000, "step never started");
      await new Promise((r) => setTimeout(r, 100));
    }
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    assert.equal(alive(pid), true);
    child.kill("SIGINT");
    const r = await done;
    assert.ok(r.signal === "SIGINT" || r.code !== 0, `exited: code ${r.code} signal ${r.signal}`);
    const deadline = Date.now() + 5000;
    while (alive(pid) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
    assert.equal(alive(pid), false, "the step's sleep survived SIGINT");
    const sbRoot = path.dirname(fs.readFileSync(homeFile, "utf8").trim());
    assert.equal(fs.existsSync(sbRoot), false, `sandbox root left behind: ${sbRoot}`);
    if (darwin) assert.equal(hostKeychainList(), kcBefore);
  });
});
