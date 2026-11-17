import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("real tmux: pane id reused after a server restart is not killed; # in cwd/name stays literal", async () => {
    const sock = `${SOCK}-reuse`;
    const t2 = (...a: string[]): string => execFileSync("tmux", ["-L", sock, ...a], { encoding: "utf8" });
    const dir = join(tmp, "tt-real");
    const weirdDir = join(tmp, "w#S#{pane_id}");
    mkdirSync(weirdDir, { recursive: true });
    try {
      const d1 = new TmuxDriver({ socket: sock, session: "s1", dir });
      const id = await d1.open({ mode: "window", name: "x#S", cwd: weirdDir, argv: ["sleep", "60"] });
      assert.equal(t2("display-message", "-p", "-t", id, "#{window_name}").trim(), "x#S");
      assert.ok(t2("display-message", "-p", "-t", id, "#{pane_current_path}").trim().endsWith("/w#S#{pane_id}"), "cwd literal");
      t2("kill-server");
      // New server on the same socket: the user's own first pane reuses the id.
      t2("new-session", "-d", "-s", "user", "sleep", "60");
      for (let i = 0; i < 6 && !t2("list-panes", "-a", "-F", "#{pane_id}").split("\n").includes(id); i++) {
        t2("split-window", "-d", "-t", "user:", "sleep", "60");
      }
      assert.ok(t2("list-panes", "-a", "-F", "#{pane_id}").split("\n").includes(id), "id was reused");
      const d2 = new TmuxDriver({ socket: sock, session: "s1", dir });
      assert.equal(await d2.alive(id), false);
      await d2.close(id);
      assert.equal(t2("display-message", "-p", "-t", id, "#{pane_id}").trim(), id, "user pane survived close");
      assert.equal(await new TmuxDriver({ socket: sock, dir }).alive(id), false);
    } finally {
      try {
        t2("kill-server");
      } catch {
        /* gone */
      }
    }
  });

  it("terminalDriver('tmux') honors socket and session", async () => {
    const d = await terminalDriver("tmux", { tmuxSocket: SOCK, tmuxSession: "base" });
    assert.equal(d.kind, "tmux");
    const id = await d.open({ mode: "window", name: "td", cwd: tmp, argv: ["sleep", "60"] });
    assert.equal(await d.alive(id), true);
    await d.close(id);
  });
});

/** In-memory tmux: pane tags live in `tags`; `killed` records kill-pane targets. */
function fakeTmux(tags: Map<string, string>, extra: Partial<Record<string, string>> = {}) {
  const calls: string[][] = [];
  const killed: string[] = [];
  let n = 0;
  const run = async (a: string[]): Promise<string> => {
    calls.push(a);
    switch (a[0]) {
      case "new-window":
      case "split-window":
        return `%${++n}\n`;
      case "set-option":
        tags.set(a[a.indexOf("-t") + 1], a[a.length - 1]);
        return "";
      case "display-message": {
        const f = a[a.length - 1];
        const id = a[a.indexOf("-t") + 1];
        if (f.includes("@ach_run")) return `${tags.get(id) ?? ""}\n`;
        if (f.includes("pane_id")) return `${id}\n`;
        return extra.session ?? "S\n";
      }
      case "kill-pane":
        killed.push(a[a.indexOf("-t") + 1]);
        return "";
      default:
        return "";
    }
  };
  return { run, calls, killed };
}

describe("TmuxDriver pane ownership tag (fake runner)", () => {
  it("open tags the pane with @ach_run; close kills only a pane whose tag matches", async () => {
    const tags = new Map<string, string>();
    const f = fakeTmux(tags);
    const dir = join(tmp, "tt1");
    const d = new TmuxDriver({ session: "S", run: f.run, dir });
    const id = await d.open({ mode: "window", name: "n", cwd: "/c", argv: ["x"] });
    assert.match(id, /^%\d+$/, "stored handle shape is unchanged");
    assert.ok(f.calls.some((c) => c[0] === "set-option" && c.includes("-p") && c.includes("@ach_run")), "pane tagged");
    assert.equal(await d.alive(id), true);
    await d.close(id);
    assert.deepEqual(f.killed, [id]);
  });

  it("pane id reused by an unrelated pane after a tmux restart: close and alive leave it alone", async () => {
    const tags = new Map<string, string>();
    const f = fakeTmux(tags);
    const dir = join(tmp, "tt2");
    const d = new TmuxDriver({ session: "S", run: f.run, dir });
    const id = await d.open({ mode: "window", name: "n", cwd: "/c", argv: ["x"] });
    tags.clear(); // tmux restarted: the same %N now belongs to a user pane with no tag
    const other = new TmuxDriver({ session: "S", run: f.run, dir });
    assert.equal(await other.alive(id), false);
    await other.close(id);
    assert.deepEqual(f.killed, [], "an unrelated pane is never killed");
    tags.set(id, "someone-elses-token");
    await other.close(id);
    assert.deepEqual(f.killed, [], "a foreign tag is never killed");
  });

  it("an old roster id with no recorded tag is not ours: no kill", async () => {
    const tags = new Map<string, string>([["%5", ""]]);
    const f = fakeTmux(tags);
    const d = new TmuxDriver({ session: "S", run: f.run, dir: join(tmp, "tt3") });
    await d.close("%5");
    assert.deepEqual(f.killed, []);
    assert.equal(await d.alive("%5"), false);
  });

  it("escapes # as ## in -c and -n so tmux formats in a path or name stay literal", async () => {
    const f = fakeTmux(new Map());
    const d = new TmuxDriver({ session: "S", run: f.run, dir: join(tmp, "tt4") });
    const cwd = "/work/#S/#{pane_id}/#P";
    await d.open({ mode: "window", name: "w#S#{x}", cwd, argv: ["x"] });
    await d.open({ mode: "right", name: "r", cwd, argv: ["x"], of: "%1" });
    await d.open({ mode: "tab", name: "t#P", cwd, argv: ["x"], of: "%1" });
    const opens = f.calls.filter((c) => c[0] === "new-window" || c[0] === "split-window");
    assert.equal(opens.length, 3);
    for (const c of opens) assert.equal(c[c.indexOf("-c") + 1], "/work/##S/##{pane_id}/##P");
    assert.equal(opens[0][opens[0].indexOf("-n") + 1], "w##S##{x}");
    assert.equal(opens[2][opens[2].indexOf("-n") + 1], "t##P");
  });
});

describe("TmuxDriver command shape (fake runner)", () => {
  it("emits the guide 8b argv, with -d everywhere and the socket handled by the runner", async () => {
    const calls: string[][] = [];
    const d = new TmuxDriver({
      session: "S",
      dir: join(tmp, "shape"),
      run: async (a) => {
        calls.push(a);
        return a[0] === "display-message" ? "S2\n" : "%7\n";
      },
    });
    await d.open({ mode: "window", name: "n", cwd: "/c", argv: ["a b"] });
    await d.open({ mode: "right", name: "n", cwd: "/c", argv: ["x"], of: "%1" });
    await d.open({ mode: "down", name: "n", cwd: "/c", argv: ["x"], of: "%1" });
    await d.open({ mode: "tab", name: "n", cwd: "/c", argv: ["x"], of: "%1" });
    const cmds = calls.filter((c) => c[0] !== "set-option");
    const cmd = paneCommand(["a b"]);
    assert.deepEqual(cmds[1], ["new-window", "-d", "-t", "S:", "-n", "n", "-c", "/c", "-P", "-F", "#{pane_id}", cmd]);
    assert.deepEqual(cmds[2].slice(0, 5), ["split-window", "-d", "-h", "-t", "%1"]);
    assert.deepEqual(cmds[3].slice(0, 5), ["split-window", "-d", "-v", "-t", "%1"]);
    assert.deepEqual(cmds[4], ["display-message", "-p", "-t", "%1", "#{session_name}"]);
    assert.deepEqual(cmds[5].slice(0, 4), ["new-window", "-d", "-t", "S2:"]);
    assert.equal(calls.filter((c) => c[0] === "set-option").length, 4, "every pane tagged");
  });
});

describe("TmuxDriver explicit session on a fresh socket (fake runner)", () => {
  it("has-session fails -> new-session -d -s before new-window, and the default window is reaped", async () => {
    const calls: string[][] = [];
    const d = new TmuxDriver({
      session: "e2e",
      dir: join(tmp, "e2e"),
      run: async (a) => {
        calls.push(a);
        if (a[0] === "has-session") throw new Error("tmux has-session failed: error connecting to /tmp/x (No such file or directory)");
        if (a[0] === "new-session") return "@0\n";
        return "%3\n";
      },
    });
    await d.open({ mode: "window", name: "desks", cwd: "/c", argv: ["x"] });
    await d.open({ mode: "window", name: "lane", cwd: "/c", argv: ["x"] });
    calls.splice(0, calls.length, ...calls.filter((c) => c[0] !== "set-option"));
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
    const d = new TmuxDriver({ session: "e2e", dir: join(tmp, "ex"), run: async (a) => (calls.push(a), "%3\n") });
    await d.open({ mode: "window", name: "w", cwd: "/c", argv: ["x"] });
    assert.deepEqual(calls.map((c) => c[0]), ["has-session", "new-window", "set-option"]);
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
      commandOf: () => "/bin/echo hi",
      startOf: () => Date.now() - 1000,
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
      commandOf: () => "/bin/echo hi",
      startOf: () => Date.now() - 1000,
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

  it("close never signals a stale pidfile whose pid now runs something else; it removes the pidfile", async () => {
    const dir = join(tmp, "gh3");
    const kills: number[] = [];
    const d = new GhosttyDriver({
      dir,
      settleMs: 0,
      kill: (pid) => void kills.push(pid),
      commandOf: () => "/usr/bin/vim notes.txt",
      osascript: async () => "T-9",
    });
    const id = await d.open({ ...base, mode: "window" });
    const pidfile = pidfileFor(id, dir) as string;
    writeFileSync(pidfile, "31337\n");
    await d.close(id);
    assert.deepEqual(kills, [], "unrelated process not signaled");
    assert.equal(existsSync(pidfile), false, "stale pidfile removed");
  });

  it("close signals the pid when its command matches what we launched", async () => {
    const dir = join(tmp, "gh4");
    const kills: number[] = [];
    const d = new GhosttyDriver({
      dir,
      settleMs: 0,
      kill: (pid) => void kills.push(pid),
      commandOf: () => "/usr/local/bin/echo hi there",
      startOf: () => Date.now() - 1000,
      osascript: async () => "T-10",
    });
    const id = await d.open({ ...base, mode: "window" });
    writeFileSync(pidfileFor(id, dir) as string, "31338\n");
    await d.close(id);
    assert.deepEqual(kills, [31338]);
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
