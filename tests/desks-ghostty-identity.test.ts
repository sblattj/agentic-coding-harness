import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { GhosttyDriver, needlesFor, pidfileFor, startMatchesPidfile } from "../src/desks/term/ghostty.ts";

const tmp = mkdtempSync(join(tmpdir(), "ghostty-identity-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

describe("GhosttyDriver close requires this open's identity, not only the command line", () => {
  const argv = ["/usr/local/bin/node", "/opt/ach/pane.js"];
  const mk = async (name: string, startOf: (pid: number) => number | undefined) => {
    const dir = join(tmp, name);
    const kills: number[] = [];
    const d = new GhosttyDriver({
      dir,
      settleMs: 0,
      isAlive: () => false,
      kill: (pid) => void kills.push(pid),
      commandOf: () => "/usr/local/bin/node /opt/ach/pane.js", // identical executable and script
      startOf,
      osascript: async () => "T-1",
    });
    const id = await d.open({ mode: "window", name: "n", cwd: "/c", argv });
    const pidfile = pidfileFor(id, dir) as string;
    writeFileSync(pidfile, "5150\n");
    return { d, id, kills, mtime: statSync(pidfile).mtimeMs };
  };

  it("a reused pid (same executable and script, started after the pidfile) is NOT signaled", async () => {
    const t = await mk("reused", () => Date.now() + 3_600_000);
    await t.d.close(t.id);
    assert.deepEqual(t.kills, []);
  });
  it("a pid whose start time is unknown is NOT signaled", async () => {
    const t = await mk("unknown", () => undefined);
    await t.d.close(t.id);
    assert.deepEqual(t.kills, []);
  });
  it("the real process (started just before the pidfile) IS signaled", async () => {
    const t = await mk("real", () => Date.now() - 5_000);
    await t.d.close(t.id);
    assert.deepEqual(t.kills, [5150]);
  });
  it("startMatchesPidfile windows", () => {
    assert.equal(startMatchesPidfile(1000, 1000), true);
    assert.equal(startMatchesPidfile(2000, 1000), true, "ps lstart is whole seconds");
    assert.equal(startMatchesPidfile(10_000, 1000), false);
    assert.equal(startMatchesPidfile(1000 - 200_000, 1000), false);
    assert.equal(startMatchesPidfile(undefined, 1000), false);
  });
});

describe("GhosttyDriver close sends Enter only after the process is gone", () => {
  const argv = ["/usr/local/bin/node", "/opt/ach/pane.js"];
  const run = async (name: string, deadAfterSignals: "SIGTERM" | "SIGKILL" | "never") => {
    const dir = join(tmp, name);
    const events: string[] = [];
    let dead = false;
    let polls = 0;
    const d = new GhosttyDriver({
      dir,
      settleMs: 0,
      exitWaitMs: 200,
      kill: (_pid, sig) => {
        events.push(sig);
        if (sig === deadAfterSignals && sig === "SIGKILL") dead = true;
      },
      isAlive: () => {
        polls++;
        if (deadAfterSignals === "SIGTERM" && polls > 3) dead = true; // exits a few polls after SIGTERM
        return !dead;
      },
      commandOf: () => "/usr/local/bin/node /opt/ach/pane.js",
      startOf: () => Date.now() - 5_000,
      osascript: async (script) => {
        if (script.includes("send key")) events.push(dead ? "enter-after-exit" : "enter-while-alive");
        return "T-1";
      },
    });
    const id = await d.open({ mode: "window", name: "n", cwd: "/c", argv });
    writeFileSync(pidfileFor(id, dir) as string, "5150\n");
    await d.close(id);
    return { events, polls };
  };

  it("waits for a slow-exiting process, then sends Enter (no SIGKILL)", async () => {
    const t = await run("slow", "SIGTERM");
    assert.deepEqual(t.events, ["SIGTERM", "enter-after-exit"]);
    assert.ok(t.polls > 3);
  });
  it("sends no SIGKILL when the pid's identity changed during the wait (reused pid)", async () => {
    const dir = join(tmp, "reused-during-wait");
    const kills: string[] = [];
    let reused = false;
    const d = new GhosttyDriver({
      dir,
      settleMs: 0,
      exitWaitMs: 100,
      kill: (_pid, sig) => void kills.push(sig),
      isAlive: () => {
        reused = true; // the original exits and an unrelated process takes the pid while we wait
        return true;
      },
      commandOf: () => (reused ? "/bin/sleep 1000" : "/usr/local/bin/node /opt/ach/pane.js"),
      startOf: () => (reused ? Date.now() + 3_600_000 : Date.now() - 5_000),
      osascript: async () => "T-1",
    });
    const id = await d.open({ mode: "window", name: "n", cwd: "/c", argv });
    writeFileSync(pidfileFor(id, dir) as string, "5150\n");
    await d.close(id);
    assert.deepEqual(kills, ["SIGTERM"]);
  });
  it("escalates to SIGKILL when SIGTERM is ignored, then sends Enter", async () => {
    const t = await run("stubborn", "SIGKILL");
    assert.deepEqual(t.events, ["SIGTERM", "SIGKILL", "enter-after-exit"]);
  });
});

describe("GhosttyDriver open cleans up when the sidecar cannot be written", () => {
  it("signals the launched process, sends Enter, and rejects (the caller never gets the id)", async () => {
    const dir = join(tmp, "sidecar-fail");
    mkdirSync(join(dir, "terminal-T-9.ref"), { recursive: true }); // a directory where the sidecar file goes: write fails
    const events: string[] = [];
    let dead = false;
    const d = new GhosttyDriver({
      dir,
      settleMs: 0,
      exitWaitMs: 200,
      isAlive: () => !dead,
      kill: (pid, sig) => {
        events.push(`${sig} ${pid}`);
        dead = true;
      },
      commandOf: () => (dead ? undefined : "/usr/local/bin/node /opt/ach/pane.js"),
      startOf: () => Date.now() - 1_000,
      osascript: async (script) => {
        const pidfile = /[^\s'"]+\.pid/.exec(script)?.[0];
        if (pidfile && !events.length) {
          writeFileSync(pidfile, "5150\n");
          return "T-9";
        }
        events.push("close");
        return "";
      },
    });
    await assert.rejects(d.open({ mode: "window", name: "n", cwd: "/c", argv: ["/usr/local/bin/node", "/opt/ach/pane.js"] }), /could not record terminal T-9/);
    assert.deepEqual(events, ["SIGTERM 5150", "close"]);
  });
});

describe("needlesFor matches the executable after wrapper commands", () => {
  it("skips env assignments, nohup, nice -n and timeout args", () => {
    assert.deepEqual(needlesFor(["/usr/local/bin/node", "/opt/ach/pane.js"]), ["node", "pane.js"]);
    assert.deepEqual(needlesFor(["/usr/bin/env", "ACH_DESK_NAME=X", "node", "/opt/ach/pane.js"]), ["node", "pane.js"]);
    assert.deepEqual(needlesFor(["nohup", "nice", "-n", "5", "/usr/local/bin/ach", "desk"]), ["ach"]);
    assert.deepEqual(needlesFor(["A=1", "timeout", "30s", "opencode", "/x/y"]), ["opencode", "y"]);
    assert.deepEqual(needlesFor(["env"]), []);
  });
});
