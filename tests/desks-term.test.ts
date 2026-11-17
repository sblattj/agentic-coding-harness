import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { defaultTerminal, pidfileFor, terminalDriver } from "../src/desks/term/index.ts";
import {
  GhosttyDriver,
  aliveScript,
  closeScript,
  openScript,
  surfaceCommand,
} from "../src/desks/term/ghostty.ts";
import { TmuxDriver, paneCommand, shellQuote } from "../src/desks/term/tmux.ts";

const HAVE_TMUX = spawnSync("tmux", ["-V"]).status === 0;
const SOCK = `ach-desks-test-${process.pid}`;
const tm = (...a: string[]): string => execFileSync("tmux", ["-L", SOCK, ...a], { encoding: "utf8" });
const tmp = mkdtempSync(join(tmpdir(), "ach-desks-term-"));

async function waitFor(fn: () => boolean, ms = 30_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return fn();
}

describe("shell quoting", () => {
  it("round-trips awkward strings through sh", () => {
    for (const s of ["plain", "has space", "it's", `say "hi"`, "$HOME `id` $(id)", "a;b && c | d", "", "multi\nline", "*?[x]"]) {
      const out = execFileSync("/bin/sh", ["-c", `printf %s ${shellQuote(s)}`], { encoding: "utf8" });
      assert.equal(out, s);
    }
  });
  it("paneCommand is /bin/zsh -lic with the argv quoted twice", () => {
    const c = paneCommand(["echo", "a b", "it's"]);
    assert.ok(c.startsWith("/bin/zsh -lic '"));
    const out = execFileSync("/bin/sh", ["-c", `/bin/zsh -fc ${c.slice("/bin/zsh -lic ".length)}`], { encoding: "utf8" });
    assert.equal(out, "a b it's\n");
  });
});

describe("TmuxDriver (private socket)", { skip: !HAVE_TMUX && "tmux not installed" }, () => {
  after(() => {
    try {
      tm("kill-server");
    } catch {
      /* already gone */
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  const win = (pane: string): string => tm("display-message", "-p", "-t", pane, "#{window_id}").trim();
  const panesOf = (w: string): string[] => tm("list-panes", "-t", w, "-F", "#{pane_id}").trim().split("\n");
  const sleeper = (marker: string, extra = "") => [
    "/bin/sh",
    "-c",
    `printf '%s' "$1" > "$0"; sleep 120`,
    marker,
    extra || "ok",
  ];

  it("creates ach-desks on an empty server, then uses the first session", async () => {
    const d = new TmuxDriver({ socket: SOCK });
    const marker = join(tmp, "m0");
    const id = await d.open({ mode: "window", name: "w0", cwd: tmp, argv: sleeper(marker) });
    assert.match(id, /^%\d+$/);
    assert.equal(tm("list-sessions", "-F", "#{session_name}").trim(), "ach-desks");
    assert.ok(await waitFor(() => existsSync(marker)), "pane ran the command");
    await d.close(id);
  });

  it("explicit new session: created, with exactly the one real window (no stray window 0)", async () => {
    const d = new TmuxDriver({ socket: SOCK, session: "fresh" });
    const id = await d.open({ mode: "window", name: "desks", cwd: tmp, argv: ["sleep", "60"] });
    assert.match(id, /^%\d+$/);
    assert.equal(tm("list-windows", "-t", "fresh", "-F", "#{window_name}").trim(), "desks");
    await d.close(id);
  });

  it("window / right / down / tab / quoting / close", async () => {
    tm("new-session", "-d", "-s", "base");
    const d = new TmuxDriver({ socket: SOCK, session: "base" });
    const weird = `a b 'q' "d" $HOME \`x\`; echo pwned`;
    const m1 = join(tmp, "m1");
    const before = tm("display-message", "-p", "-t", "base", "#{window_id}").trim();

    const p1 = await d.open({ mode: "window", name: "desk", cwd: tmp, argv: sleeper(m1, weird) });
    assert.match(p1, /^%\d+$/);
    assert.equal(tm("display-message", "-p", "-t", "base", "#{window_id}").trim(), before, "current window unchanged");
    assert.equal(await d.alive(p1), true);
    assert.ok(await waitFor(() => existsSync(m1)), "marker written");
    assert.equal(readFileSync(m1, "utf8"), weird, "quoting survived");

    const p2 = await d.open({ mode: "right", name: "r", cwd: tmp, argv: sleeper(join(tmp, "m2")), of: p1 });
    const p3 = await d.open({ mode: "down", name: "d", cwd: tmp, argv: sleeper(join(tmp, "m3")), of: p2 });
    const w = win(p1);
    assert.equal(win(p2), w);
    assert.equal(win(p3), w);
    assert.deepEqual(new Set(panesOf(w)), new Set([p1, p2, p3]));

    const p4 = await d.open({ mode: "tab", name: "lane", cwd: tmp, argv: sleeper(join(tmp, "m4")), of: p1 });
    assert.notEqual(win(p4), w, "tab is a new window");
    assert.equal(tm("display-message", "-p", "-t", p4, "#{session_name}").trim(), "base");
    assert.equal(tm("display-message", "-p", "-t", p4, "#{window_name}").trim(), "lane");

    for (const p of [p1, p2, p3, p4]) {
      await d.close(p);
      assert.equal(await d.alive(p), false, `${p} dead after close`);
    }
    await d.close(p1); // already dead: must not throw
    await d.close("%99999");
    assert.equal(await d.alive("%99999"), false);
  });

  it("split/tab without `of` is an error", async () => {
    const d = new TmuxDriver({ socket: SOCK, session: "base" });
    await assert.rejects(d.open({ mode: "right", name: "x", cwd: tmp, argv: ["true"] }), /of/);
    await assert.rejects(d.open({ mode: "tab", name: "x", cwd: tmp, argv: ["true"] }), /of/);
  });

  it("terminalDriver('tmux') honors socket and session", async () => {
    const d = await terminalDriver("tmux", { tmuxSocket: SOCK, tmuxSession: "base" });
    assert.equal(d.kind, "tmux");
    const id = await d.open({ mode: "window", name: "td", cwd: tmp, argv: ["sleep", "60"] });
    assert.equal(await d.alive(id), true);
    await d.close(id);
  });
});

describe("TmuxDriver command shape (fake runner)", () => {
  it("emits the guide 8b argv, with -d everywhere and the socket handled by the runner", async () => {
    const calls: string[][] = [];
    const d = new TmuxDriver({
      session: "S",
      run: async (a) => {
        calls.push(a);
        return a[0] === "display-message" ? "S2\n" : "%7\n";
      },
    });
    await d.open({ mode: "window", name: "n", cwd: "/c", argv: ["a b"] });
    await d.open({ mode: "right", name: "n", cwd: "/c", argv: ["x"], of: "%1" });
    await d.open({ mode: "down", name: "n", cwd: "/c", argv: ["x"], of: "%1" });
    await d.open({ mode: "tab", name: "n", cwd: "/c", argv: ["x"], of: "%1" });
    const cmd = paneCommand(["a b"]);
    assert.deepEqual(calls[1], ["new-window", "-d", "-t", "S:", "-n", "n", "-c", "/c", "-P", "-F", "#{pane_id}", cmd]);
    assert.deepEqual(calls[2].slice(0, 5), ["split-window", "-d", "-h", "-t", "%1"]);
    assert.deepEqual(calls[3].slice(0, 5), ["split-window", "-d", "-v", "-t", "%1"]);
    assert.deepEqual(calls[4], ["display-message", "-p", "-t", "%1", "#{session_name}"]);
    assert.deepEqual(calls[5].slice(0, 4), ["new-window", "-d", "-t", "S2:"]);
  });
});

describe("TmuxDriver explicit session on a fresh socket (fake runner)", () => {
  it("has-session fails -> new-session -d -s before new-window, and the default window is reaped", async () => {
    const calls: string[][] = [];
    const d = new TmuxDriver({
      session: "e2e",
      run: async (a) => {
        calls.push(a);
        if (a[0] === "has-session") throw new Error("tmux has-session failed: error connecting to /tmp/x (No such file or directory)");
        if (a[0] === "new-session") return "@0\n";
        return "%3\n";
      },
    });
    await d.open({ mode: "window", name: "desks", cwd: "/c", argv: ["x"] });
    await d.open({ mode: "window", name: "lane", cwd: "/c", argv: ["x"] });
    assert.deepEqual(calls[0], ["has-session", "-t", "e2e"]);
    assert.deepEqual(calls[1].slice(0, 4), ["new-session", "-d", "-s", "e2e"]);
    assert.equal(calls[2][0], "new-window");
    assert.deepEqual(calls[3], ["kill-window", "-t", "@0"]);
    assert.equal(calls.filter((c) => c[0] === "has-session").length, 1, "checked once");
    assert.equal(calls.filter((c) => c[0] === "new-session").length, 1);
    assert.equal(calls[4][0], "new-window");
  });

  it("existing session: has-session ok, nothing created or killed", async () => {
    const calls: string[][] = [];
    const d = new TmuxDriver({ session: "e2e", run: async (a) => (calls.push(a), "%3\n") });
    await d.open({ mode: "window", name: "w", cwd: "/c", argv: ["x"] });
    assert.deepEqual(calls.map((c) => c[0]), ["has-session", "new-window"]);
  });
});

describe("GhosttyDriver (generated AppleScript only)", () => {
  const base = { name: "n", cwd: '/tmp/a "b"', argv: ["echo", "it's $x; y"] };

  it("window", () => {
    const s = openScript({ ...base, mode: "window" }, "CMD");
    assert.match(s, /new surface configuration/);
    assert.match(s, /set command of cfg to "CMD"/);
    assert.match(s, /set initial working directory of cfg to "\/tmp\/a \\"b\\""/);
    assert.match(s, /set w to new window with configuration cfg/);
    assert.match(s, /return id of focused terminal of selected tab of w/);
    assert.doesNotMatch(s, /close window|close tab/);
  });
  it("right and down", () => {
    for (const dir of ["right", "down"] as const) {
      const s = openScript({ ...base, mode: dir, of: "T-1" }, "CMD");
      assert.match(s, new RegExp(`split \\(first terminal whose id is "T-1"\\) direction ${dir} with configuration cfg`));
      assert.match(s, /return id of t/);
    }
  });
  it("tab finds the window by terminal id and opens a tab there", () => {
    const s = openScript({ ...base, mode: "tab", of: "T-1" }, "CMD");
    assert.match(s, /repeat with wi from 1 to count of windows/);
    assert.match(s, /id of every terminal of tab ti of w\) contains "T-1"/);
    assert.match(s, /new tab in target with configuration cfg/);
    assert.match(s, /return id of focused terminal of tb/);
    assert.doesNotMatch(s, /close window|close tab/);
  });
  it("split and tab need `of`", () => {
    assert.throws(() => openScript({ ...base, mode: "right" }, "C"), /of/);
    assert.throws(() => openScript({ ...base, mode: "tab" }, "C"), /of/);
  });
  it("surface command records pid then execs the quoted argv", () => {
    const c = surfaceCommand(["echo", "it's $x; y"], "/tmp/p.pid");
    assert.ok(c.startsWith("/bin/zsh -lic '"));
    const out = execFileSync("/bin/sh", ["-c", `/bin/zsh -fc ${c.slice("/bin/zsh -lic ".length)}`], { encoding: "utf8" });
    assert.equal(out, "it's $x; y\n");
    assert.ok(existsSync("/tmp/p.pid"));
    assert.match(readFileSync("/tmp/p.pid", "utf8"), /^\d+$/m);
    rmSync("/tmp/p.pid", { force: true });
  });
  it("close script sends enter, never closes windows; alive uses exists", () => {
    const s = closeScript("T-9");
    assert.match(s, /send key "enter" to \(first terminal whose id is "T-9"\)/);
    assert.doesNotMatch(s, /close window|close tab|close \(/);
    assert.match(aliveScript("T-9"), /exists \(first terminal whose id is "T-9"\)/);
  });

  it("open/close/alive drive the injected runner; close kills the recorded pid first", async () => {
    const scripts: string[] = [];
    const kills: Array<[number, string]> = [];
    const dir = join(tmp, "gh");
    const d = new GhosttyDriver({
      dir,
      settleMs: 0,
      kill: (pid, sig) => void kills.push([pid, sig]),
      osascript: async (s) => {
        scripts.push(s);
        if (s.includes("exists")) return "true\n";
        return "TERM-42\n";
      },
    });
    const id = await d.open({ ...base, mode: "window" });
    assert.equal(id, "TERM-42");
    const pidfile = pidfileFor("TERM-42", dir);
    assert.ok(pidfile, "sidecar maps terminal id to pidfile");
    assert.ok(scripts[0].includes(pidfile.replace(/\\/g, "\\\\")));
    writeFileSync(pidfile, "424242\n");

    assert.equal(await d.alive(id), true);
    // A different driver instance (other process) can close it through the sidecar.
    const other = new GhosttyDriver({
      dir,
      settleMs: 0,
      kill: (pid, sig) => void kills.push([pid, sig]),
      osascript: async (s) => {
        scripts.push(s);
        return "";
      },
    });
    await other.close(id);
    assert.deepEqual(kills, [[424242, "SIGTERM"]]);
    assert.match(scripts.at(-1) as string, /send key "enter"/);
    assert.ok(scripts.every((s) => !/close window|close tab/.test(s)));
    assert.equal(pidfileFor("TERM-42", dir), undefined, "sidecar cleaned");
    assert.equal(existsSync(pidfile), false);
  });

  it("close tolerates a vanished terminal and a dead pid", async () => {
    const d = new GhosttyDriver({
      dir: join(tmp, "gh2"),
      settleMs: 0,
      osascript: async (s) => {
        if (s.includes("send key")) throw new Error("no such terminal");
        return "T-1";
      },
    });
    const id = await d.open({ ...base, mode: "window" });
    await d.close(id);
    assert.equal(await d.alive(id), false, "alive false when osascript errors");
  });

  it("terminalDriver('ghostty') returns a ghostty driver", async () => {
    const d = await terminalDriver("ghostty", { osascript: async () => "" });
    assert.equal(d.kind, "ghostty");
  });

  // Manual live test: the orchestrator runs this with the user watching.
  it("LIVE (ACH_DESKS_GHOSTTY_LIVE=1): window, split, tab, close", { skip: process.env.ACH_DESKS_GHOSTTY_LIVE !== "1" }, async () => {
    const d = new GhosttyDriver();
    const argv = ["/bin/sh", "-c", "sleep 300"];
    const w = await d.open({ mode: "window", name: "live", cwd: tmpdir(), argv });
    const r = await d.open({ mode: "right", name: "live", cwd: tmpdir(), argv, of: w });
    const t = await d.open({ mode: "tab", name: "live", cwd: tmpdir(), argv, of: w });
    for (const id of [w, r, t]) assert.equal(await d.alive(id), true);
    for (const id of [t, r, w]) {
      await d.close(id);
    }
    await waitFor(() => false, 500);
    assert.equal(await d.alive(w), false);
  });
});

describe("defaultTerminal", () => {
  const no = () => false;
  it("tmux when $TMUX is set", () => {
    assert.equal(defaultTerminal({ env: { TMUX: "/tmp/x,1,0" }, which: no, exists: no, platform: "darwin" }), "tmux");
  });
  it("tmux when on PATH", () => {
    assert.equal(defaultTerminal({ env: {}, which: (b) => b === "tmux", exists: no, platform: "linux" }), "tmux");
  });
  it("ghostty on darwin with the app installed", () => {
    assert.equal(defaultTerminal({ env: {}, which: no, exists: (p) => p === "/Applications/Ghostty.app", platform: "darwin" }), "ghostty");
  });
  it("none on linux, or darwin without the app", () => {
    assert.equal(defaultTerminal({ env: {}, which: no, exists: () => true, platform: "linux" }), "none");
    assert.equal(defaultTerminal({ env: {}, which: no, exists: no, platform: "darwin" }), "none");
  });
  it("default which scans PATH", () => {
    assert.equal(defaultTerminal({ env: { PATH: "/a:/b" }, exists: (p) => p === "/b/tmux", platform: "linux" }), "tmux");
  });
});
