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
  // The fake exits on its 4th liveness poll, while the driver's budget is wall-clock time. A case that expects
  // the process to exit inside the budget gets a budget far above the fake's exit (which does not wait it out),
  // so a loaded runner stretching the 50 ms poll sleeps cannot turn the slow exit into a SIGKILL.
  const run = async (
    name: string,
    deadAfterSignals: "SIGTERM" | "SIGKILL" | "never",
    { exitWaitMs = 200, pollStallMs = 0 }: { exitWaitMs?: number; pollStallMs?: number } = {},
  ) => {
    const dir = join(tmp, name);
    const events: string[] = [];
    let dead = false;
    let polls = 0;
    const d = new GhosttyDriver({
      dir,
      settleMs: 0,
      exitWaitMs,
      kill: (_pid, sig) => {
        events.push(sig);
        if (sig === deadAfterSignals && sig === "SIGKILL") dead = true;
      },
      isAlive: () => {
        polls++;
        const until = Date.now() + pollStallMs; // a loaded runner: each poll costs pollStallMs of wall time
        while (Date.now() < until) { /* busy */ }
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
    const t = await run("slow", "SIGTERM", { exitWaitMs: 10_000 });
    assert.deepEqual(t.events, ["SIGTERM", "enter-after-exit"]);
    assert.ok(t.polls > 3);
  });
  it("a slow exit on a loaded runner (each poll costs 80 ms) still gets no SIGKILL", async () => {
    const t = await run("slow-loaded", "SIGTERM", { exitWaitMs: 10_000, pollStallMs: 80 });
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

  // The class: wrapper options that take a SEPARATE operand word, and positional words a wrapper eats. The operand
  // must never become the needle (then close() could never match our process, or would match on a generic word).
  it("skips the operands of wrapper options, not only the option word", () => {
    assert.deepEqual(needlesFor(["env", "-u", "NAME", "claude"]), ["claude"]);
    assert.deepEqual(needlesFor(["env", "-uNAME", "claude"]), ["claude"]);
    assert.deepEqual(needlesFor(["env", "--unset", "NAME", "claude"]), ["claude"]);
    assert.deepEqual(needlesFor(["env", "--unset=NAME", "claude"]), ["claude"]);
    assert.deepEqual(needlesFor(["env", "-iu", "NAME", "claude"]), ["claude"]);
    assert.deepEqual(needlesFor(["env", "-C", "/some/dir", "node", "/opt/ach/pane.js"]), ["node", "pane.js"]);
    assert.deepEqual(needlesFor(["nice", "-n", "10", "opencode"]), ["opencode"]);
    assert.deepEqual(needlesFor(["nice", "-10", "opencode"]), ["opencode"]);
    assert.deepEqual(needlesFor(["timeout", "-s", "KILL", "5", "opencode"]), ["opencode"]);
    assert.deepEqual(needlesFor(["timeout", "--signal=KILL", "-k", "3", "5", "opencode"]), ["opencode"]);
    assert.deepEqual(needlesFor(["timeout", "5s", "opencode"]), ["opencode"]);
    assert.deepEqual(needlesFor(["timeout", "--", "5", "opencode"]), ["opencode"]);
    assert.deepEqual(needlesFor(["stdbuf", "-o", "L", "opencode"]), ["opencode"]);
    assert.deepEqual(needlesFor(["stdbuf", "-oL", "-e", "0", "opencode"]), ["opencode"]);
    assert.deepEqual(needlesFor(["caffeinate", "-i", "-t", "600", "opencode"]), ["opencode"]);
    assert.deepEqual(needlesFor(["exec", "-l", "opencode"]), ["opencode"]);
    assert.deepEqual(needlesFor(["env", "--", "claude"]), ["claude"]);
    assert.deepEqual(needlesFor(["env", "FOO=1", "nice", "-n", "5", "claude"]), ["claude"]);
    assert.deepEqual(needlesFor(["env", "-u", "X", "A=1", "timeout", "-s", "TERM", "30", "node", "/opt/ach/pane.js"]), ["node", "pane.js"]);
  });

  it("env -S splits a plain operand into the command; a quoted one yields no needles", () => {
    assert.deepEqual(needlesFor(["env", "-S", "node /opt/ach/pane.js"]), ["node", "pane.js"]);
    assert.deepEqual(needlesFor(["env", "--split-string=-u X claude --flag"]), ["claude"]);
    assert.deepEqual(needlesFor(["env", "-S", "node '/opt/a b/pane.js'"]), []);
  });

  // An option the table does not know may or may not take an operand, so the word after it could be either. Guessing
  // risks a needle that is an operand; no needles makes close() refuse to signal (fail closed).
  it("an unknown wrapper option, or a wrapper with nothing after it, yields no needles", () => {
    assert.deepEqual(needlesFor(["env", "--frobnicate", "X", "claude"]), []);
    assert.deepEqual(needlesFor(["nice", "-Q", "7", "claude"]), []);
    assert.deepEqual(needlesFor(["timeout", "-s"]), []);
    assert.deepEqual(needlesFor(["timeout", "-s", "KILL"]), []);
    assert.deepEqual(needlesFor(["env", "-u", "NAME"]), []);
    // exec -a renames argv[0]: the process shows "fakename", so "opencode" would be a wrong needle.
    assert.deepEqual(needlesFor(["exec", "-a", "fakename", "opencode"]), []);
  });

  it("an operand needle never lets close() signal; with the right needle it does", async () => {
    const run = async (argv: string[], cmd: string) => {
      const dir = mkdtempSync(join(tmp, "needle-"));
      const kills: number[] = [];
      const d = new GhosttyDriver({
        dir, settleMs: 0, isAlive: () => false, kill: (pid) => void kills.push(pid),
        commandOf: () => cmd, startOf: () => Date.now() - 1000, osascript: async () => "T-N",
      });
      const id = await d.open({ mode: "window", name: "n", cwd: "/c", argv });
      writeFileSync(pidfileFor(id, dir) as string, "6161\n");
      await d.close(id);
      return kills;
    };
    // The launched `claude` (after env -u NAME execs it) is recognised and closed.
    assert.deepEqual(await run(["env", "-u", "NAME", "claude"], "claude --resume"), [6161]);
    // An unknown option form: no needles, so even a matching-looking process is not signaled.
    assert.deepEqual(await run(["env", "--frobnicate", "X", "claude"], "claude --resume"), []);
  });
});
