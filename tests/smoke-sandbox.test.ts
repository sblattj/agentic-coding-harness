// #139: `ach smoke` sandbox (src/core/smoke/sandbox.ts): env from scratch,
// browser shims, per-sandbox keychain with the host search list untouched,
// and teardown reaping of background processes and escapees.
//
// Host keychain safety: these tests only ever READ the host keychain
// (`security list-keychains -d user`, `default-keychain -d user`); every
// keychain write goes to the sandbox's own keychain under the sandbox HOME,
// with a 15 s deadline (a hang = a host GUI popup).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { createSandbox, SANDBOX_CONFIG_VARS, signalHandlersInstalled, type Sandbox } from "../src/core/smoke/sandbox.ts";

const darwin = process.platform === "darwin";
const open: Sandbox[] = [];
after(async () => {
  for (const sb of open) await sb.teardown();
});

async function make(opts: Parameters<typeof createSandbox>[0] = {}): Promise<Sandbox> {
  const sb = await createSandbox(opts);
  open.push(sb);
  return sb;
}

function hostList(): string {
  const l = spawnSync("/usr/bin/security", ["list-keychains", "-d", "user"], { encoding: "utf8", timeout: 15_000 });
  const d = spawnSync("/usr/bin/security", ["default-keychain", "-d", "user"], { encoding: "utf8", timeout: 15_000 });
  assert.equal(l.error, undefined, "security list-keychains timed out (host popup?)");
  return `${l.stdout}--default--\n${d.stdout}`;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(pred: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

describe("smoke sandbox env", () => {
  it("is built from scratch: no host home, layout under the root, config vars under HOME", async () => {
    const sb = await make({ keychain: false, env: { STUB_URL: "http://127.0.0.1:1" } });
    const realHome = os.homedir();
    for (const [k, v] of Object.entries(sb.env)) {
      assert.ok(!v.includes(realHome), `${k}=${v} leaks the real home ${realHome}`);
    }
    // Not a filtered process.env: an arbitrary host variable is absent.
    assert.equal(sb.env.SSH_AUTH_SOCK, undefined);
    assert.equal(sb.env.HOME, sb.home);
    assert.equal(sb.env.HOME, path.join(sb.root, "home"));
    assert.equal(sb.env.TMPDIR, path.join(sb.root, "tmp"));
    assert.equal(sb.env.USER, os.userInfo().username);
    assert.equal(sb.env.SHELL, "/bin/zsh");
    assert.equal(sb.env.STUB_URL, "http://127.0.0.1:1");
    assert.equal(sb.env.BROWSER, path.join(sb.shims, "open"));
    assert.ok(sb.env.PATH!.startsWith(`${sb.shims}:${sb.home}/.local/bin:${sb.home}/.npm-global/bin:/usr/bin:/bin`));
    for (const [k, v] of Object.entries(SANDBOX_CONFIG_VARS)) {
      if (v.startsWith("~")) assert.ok(sb.env[k] === sb.home || sb.env[k]!.startsWith(sb.home + "/"), `${k} not under HOME: ${sb.env[k]}`);
      else assert.equal(sb.env[k], v);
    }
    assert.equal(sb.root, fs.realpathSync(sb.root));
  });

  it("appends extraPath to PATH (the only way a host path gets in)", async () => {
    const sb = await make({ keychain: false, extraPath: ["/opt/extra/bin"] });
    assert.ok(sb.env.PATH!.endsWith(":/usr/sbin:/sbin:/opt/extra/bin"));
  });

  it("open / xdg-open shims record argv and exit 0", async () => {
    const sb = await make({ keychain: false });
    const url = 'https://login.example.test/device?code="AB\\CD"&x=1';
    const r1 = spawnSync("open", [url], { env: sb.env, encoding: "utf8" });
    const r2 = spawnSync("xdg-open", ["."], { env: sb.env, encoding: "utf8" });
    const r3 = spawnSync("/bin/sh", ["-c", '"$BROWSER" https://b.example.test/'], { env: sb.env, encoding: "utf8" });
    assert.deepEqual([r1.status, r2.status, r3.status], [0, 0, 0]);
    const lines = fs.readFileSync(sb.statePath("opened-urls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.argv), [[url], ["."], ["https://b.example.test/"]]);
    assert.match(lines[0].at, /^\d{4}-\d\d-\d\dT/);
  });
});

describe("smoke sandbox keychain", { skip: !darwin && "darwin only" }, () => {
  it("creates a usable per-sandbox keychain; host list byte-equal before/after", async () => {
    const before = hostList();
    const sb = await createSandbox();
    try {
      assert.ok(sb.keychainPath && fs.existsSync(sb.keychainPath));
      const sec = (args: string[]) => spawnSync("/usr/bin/security", args, { env: sb.env, encoding: "utf8", timeout: 15_000 });
      const list = sec(["list-keychains", "-d", "user"]);
      assert.match(list.stdout, new RegExp(sb.keychainPath!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      const add = sec(["add-generic-password", "-a", "smoke", "-s", "ach-smoke-test", "-w", "s3cret"]);
      assert.equal(add.error, undefined, "add-generic-password hung (host popup)");
      assert.equal(add.status, 0, add.stderr);
      const find = sec(["find-generic-password", "-a", "smoke", "-s", "ach-smoke-test", "-w"]);
      assert.equal(find.status, 0, find.stderr);
      assert.equal(find.stdout.trim(), "s3cret");
    } finally {
      const res = await sb.teardown();
      assert.equal(res.hostKeychainUnchanged, true);
      assert.equal(res.keychainRestored, false);
    }
    const afterList = hostList();
    console.log(`host keychain before:\n${before}host keychain after:\n${afterList}`);
    assert.equal(afterList, before);
    assert.equal(fs.existsSync(sb.root), false);
    // The host keychain never got the item.
    const host = spawnSync("/usr/bin/security", ["find-generic-password", "-s", "ach-smoke-test"], { encoding: "utf8", timeout: 15_000 });
    assert.notEqual(host.status, 0);
  });

  it("host list byte-equal even when a step throws mid-run", async () => {
    const before = hostList();
    let sb: Sandbox | undefined;
    let pid = 0;
    await assert.rejects(async () => {
      sb = await createSandbox();
      try {
        const c = sb.spawnTracked("/bin/sleep", ["1000"], { stdio: "ignore" });
        pid = c.pid!;
        throw new Error("step blew up");
      } finally {
        await sb.teardown();
      }
    }, /step blew up/);
    assert.equal(hostList(), before);
    assert.ok(await waitFor(() => !alive(pid)), "tracked sleep survived teardown");
    assert.ok(!fs.existsSync(sb!.root));
  });
});

describe("smoke sandbox teardown reaping", () => {
  it("reaps `sleep 1000 &` and a `nohup sleep 1000 &` escapee", async () => {
    const sb = await createSandbox({ keychain: false });
    try {
      const pidFile = path.join(sb.tmp, "pids");
      const c = sb.spawnTracked("/bin/zsh", ["-c", `sleep 1000 & echo $! >> ${pidFile}; nohup sleep 1000 >/dev/null 2>&1 & echo $! >> ${pidFile}`], { stdio: "ignore" });
      await new Promise((r) => c.on("exit", r));
      const pids = fs.readFileSync(pidFile, "utf8").trim().split("\n").map(Number);
      assert.equal(pids.length, 2);
      for (const p of pids) assert.ok(alive(p), `pid ${p} should be alive before teardown`);
      const res = await sb.teardown();
      for (const p of pids) {
        assert.ok(await waitFor(() => !alive(p)), `pid ${p} survived teardown`);
        assert.ok(res.reapedPids.includes(p), `pid ${p} not reported reaped`);
      }
    } finally {
      await sb.teardown();
    }
  });

  it("sweeps escapees outside the tracked groups: env HOME (ps -E) and cwd under the root (lsof)", { skip: !darwin && "ps -E / lsof sweep is darwin-tested" }, async () => {
    const sb = await createSandbox({ keychain: false });
    const pids: number[] = [];
    try {
      // (b) a node daemon in its own session, cwd '/', HOME=<sandbox home>:
      // only `ps -E` can tie it to the sandbox.
      const n = spawn(process.execPath, ["-e", "setTimeout(()=>{},1000000)"], { cwd: "/", env: { HOME: sb.home, PATH: "/usr/bin:/bin" }, detached: true, stdio: "ignore" });
      n.unref();
      pids.push(n.pid!);
      // (c) a platform binary (no env in ps -E) setsid'd away, cwd in the sandbox.
      const work = path.join(sb.home, "work");
      fs.mkdirSync(work);
      const pidFile = path.join(sb.tmp, "esc.pid");
      spawnSync("/usr/bin/perl", ["-MPOSIX", "-e", `if (my $p = fork) { open my $f, ">", "${pidFile}"; print $f $p; exit 0 } POSIX::setsid(); exec "/bin/sleep", "1000"`], { cwd: work, env: { PATH: "/usr/bin:/bin" }, stdio: "ignore" });
      pids.push(Number(fs.readFileSync(pidFile, "utf8")));
      assert.ok(await waitFor(() => pids.every(alive)));
      const res = await sb.teardown();
      for (const p of pids) {
        assert.ok(await waitFor(() => !alive(p)), `escapee ${p} survived teardown`);
        assert.ok(res.reapedPids.includes(p), `escapee ${p} not reported`);
      }
    } finally {
      await sb.teardown();
      for (const p of pids) {
        try {
          process.kill(p, "SIGKILL");
        } catch {
          /* gone */
        }
      }
    }
  });

  it("teardown is idempotent, honours keep, and unregisters the signal handlers", async () => {
    const sb = await createSandbox({ keychain: false, keep: true });
    assert.equal(signalHandlersInstalled(), true);
    const a = await sb.teardown();
    const b = await sb.teardown();
    assert.equal(a, b);
    assert.equal(a.kept, sb.root);
    assert.ok(fs.existsSync(sb.root));
    fs.rmSync(sb.root, { recursive: true, force: true });
    if (open.length === 0) assert.equal(signalHandlersInstalled(), false);
  });
});
