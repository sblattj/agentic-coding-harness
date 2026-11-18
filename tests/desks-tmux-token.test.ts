// A stale roster entry must never own a pane opened later under the same reused %N (threads-210, tmux.ts:196).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { TmuxDriver } from "../src/desks/term/tmux.ts";

const HAVE_TMUX = spawnSync("tmux", ["-V"]).status === 0;
const tmp = mkdtempSync(join(tmpdir(), "ach-desks-token-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** How a fake evaluates close()'s if-shell format: true when it names pane `id` and the pane's tag `tag`. */
function fakeIfShellOwned(a: string[], id: string, tag: string | undefined): boolean {
  const fmt = a[a.indexOf("-F") + 3] ?? "";
  const m = /^#\{&&:#\{==:#\{s\/\^%\/\/:pane_id\},(\d+)\},#\{==:#\{@ach_run\},([^}]*)\}\}$/.exec(fmt);
  return m !== null && `%${m[1]}` === id && tag !== undefined && tag === m[2] && a.at(-2) === `kill-pane -t ${id}`;
}

/** In-memory tmux server whose pane ids restart from %0 on restart(), like a real tmux server. */
function fakeServer() {
  let n = 0;
  const live = new Map<string, string>(); // pane id -> @ach_run tag
  const calls: string[][] = [];
  const killed: string[] = [];
  const run = async (a: string[]): Promise<string> => {
    calls.push(a);
    const t = a[a.indexOf("-t") + 1] as string;
    switch (a[0]) {
      case "new-window":
      case "split-window": {
        const id = `%${n++}`;
        live.set(id, "");
        return `${id}\n`;
      }
      case "set-option":
        if (!live.has(t)) throw new Error(`tmux set-option failed: can't find pane: ${t}`);
        live.set(t, a[a.length - 1] as string);
        return "";
      case "display-message": {
        if (!live.has(t)) throw new Error(`tmux display-message failed: can't find pane: ${t}`);
        const f = a[a.length - 1] as string;
        if (f.includes("@ach_run")) return `${live.get(t)}\n`;
        if (f.includes("pane_id")) return `${t}\n`;
        return "S\n";
      }
      case "kill-pane":
        killed.push(t);
        if (!live.delete(t)) throw new Error(`tmux kill-pane failed: can't find pane: ${t}`);
        return "";
      case "if-shell": {
        // close()'s atomic check-and-kill, evaluated in one step like the real server.
        if (!live.has(t)) throw new Error(`tmux if-shell failed: can't find pane: ${t}`);
        if (!fakeIfShellOwned(a, t, live.get(t))) return "ach-not-owned\n"; // NOT_OWNED in tmux.ts
        killed.push(t);
        live.delete(t);
        return "";
      }
      default:
        return "";
    }
  };
  const restart = (): void => {
    n = 0;
    live.clear();
  };
  return { run, calls, killed, live, restart };
}

describe("TmuxDriver ownership token survives pane id reuse (fake server)", () => {
  it("a stale roster id never closes the pane a later open got under the same %N", async () => {
    const srv = fakeServer();
    const dir = join(tmp, "fake1");
    const d1 = new TmuxDriver({ session: "S", run: srv.run, dir });
    const stale = await d1.open({ mode: "window", name: "old", cwd: "/c", argv: ["x"] });
    assert.equal(stale, "%0");

    srv.restart(); // tmux restarted; the roster still names %0, its sidecar is still on disk
    const d2 = new TmuxDriver({ session: "S", run: srv.run, dir });
    const fresh = await d2.open({ mode: "window", name: "new", cwd: "/c", argv: ["x"] });

    // The stale entry's view: its pane is gone, and closing it must not touch the new pane.
    assert.equal(await d2.alive(stale), false, "stale id is not alive");
    await d2.close(stale);
    assert.equal(await d2.alive(fresh), true, "the newly opened pane is still ours and alive");
    assert.ok(srv.live.has(fresh), "the newly opened pane was not killed");
    assert.notEqual(fresh, stale, "the new pane does not carry the stale id");
  });

  it("the replacement pane is opened before the collided pane is killed", async () => {
    const srv = fakeServer();
    const dir = join(tmp, "fake2");
    await new TmuxDriver({ session: "S", run: srv.run, dir }).open({ mode: "window", name: "a", cwd: "/c", argv: ["x"] });
    srv.restart();
    srv.calls.length = 0;
    const id = await new TmuxDriver({ session: "S", run: srv.run, dir }).open({ mode: "window", name: "b", cwd: "/c", argv: ["x"] });
    assert.equal(id, "%1");
    const ops = srv.calls.map((c) => `${c[0]} ${c[0] === "new-window" ? "" : c[c.indexOf("-t") + 1]}`.trim());
    assert.ok(ops.indexOf("kill-pane %0") > ops.lastIndexOf("new-window"), `kill after replacement: ${ops.join(", ")}`);
    assert.deepEqual(srv.killed, ["%0"]);
    assert.equal(readFileSync(join(dir, "default-_1.tok"), "utf8").trim().length > 0, true, "new pane recorded");
  });

  it("close checks ownership and kills in one tmux command: a pane reused between a check and a kill is never killed", async () => {
    const srv = fakeServer();
    const dir = join(tmp, "atomic");
    const d = new TmuxDriver({ session: "S", run: srv.run, dir });
    const id = await d.open({ mode: "window", name: "n", cwd: "/c", argv: ["x"] });
    const token = d.tokenOf(id)!;
    // Right after close()'s first tmux command returns, our pane dies and its %N goes to another client's pane
    // (tagged differently). A two-step check-then-kill then kills that pane; an atomic one acted on our pane or not at all.
    let first = true;
    const killedTags: string[] = [];
    const run = async (a: string[]): Promise<string> => {
      const t = a[a.indexOf("-t") + 1] as string;
      if (a[0] === "kill-pane" || a[0] === "if-shell") killedTags.push(srv.live.get(t) ?? "");
      const out = await srv.run(a);
      if (first) {
        first = false;
        if (srv.live.has(id)) srv.live.set(id, "another-clients-pane");
      }
      return out;
    };
    srv.calls.length = 0;
    await new TmuxDriver({ session: "S", run, dir }).close(id, token);
    const victims = srv.killed.length > 0 && killedTags.includes("another-clients-pane");
    assert.equal(victims, false, `no kill reached the reused pane (calls: ${srv.calls.map((c) => c[0]).join(", ")}; killed: ${srv.killed.join(" ")})`);
    assert.equal(srv.calls.length, 1, "one tmux command does the check and the kill");
    assert.deepEqual(srv.killed, [id], "our pane, still tagged with our token at that moment, was the one killed");
    // Control: with no swap, the same atomic close kills our pane.
    const id2 = await d.open({ mode: "window", name: "m", cwd: "/c", argv: ["x"] });
    await d.close(id2, d.tokenOf(id2));
    assert.equal(srv.live.has(id2), false, "control: our own pane is closed");
  });

  it("close never splices an unsafe token or id into tmux text, and treats it as not ours", async () => {
    const srv = fakeServer();
    const d = new TmuxDriver({ session: "S", run: srv.run, dir: join(tmp, "unsafe") });
    const id = await d.open({ mode: "window", name: "n", cwd: "/c", argv: ["x"] });
    srv.calls.length = 0;
    await d.close(id, "x},#{==:1,1}");
    await d.close(id, "");
    await d.close("%0;kill-server", d.tokenOf(id));
    assert.deepEqual(srv.calls, [], "no tmux command was issued");
    assert.ok(srv.live.has(id), "the pane survived");
  });

  it("bounded: gives up with a clear error when every new id is still claimed", async () => {
    const dir = join(tmp, "fake3");
    let calls = 0;
    const d0 = new TmuxDriver({ session: "S", dir, run: async (a) => (a[0] === "new-window" ? "%9\n" : "") });
    await d0.open({ mode: "window", name: "a", cwd: "/c", argv: ["x"] });
    const d = new TmuxDriver({ session: "S", dir, run: async (a) => (a[0] === "new-window" && calls++, a[0] === "new-window" ? "%9\n" : "") });
    await assert.rejects(d.open({ mode: "window", name: "b", cwd: "/c", argv: ["x"] }), /stale ownership records/);
    assert.ok(calls > 1 && calls <= 32, `bounded attempts (${calls})`);
  });
});

describe("TmuxDriver ownership token survives pane id reuse (real tmux)", { skip: !HAVE_TMUX && "tmux not installed" }, () => {
  it("after a server restart, a stale id's close leaves the pane a new open got alone", async () => {
    const sock = `ach-desks-${process.pid}`;
    const t = (...a: string[]): string => execFileSync("tmux", ["-L", sock, ...a], { encoding: "utf8" });
    const dir = join(tmp, "real");
    const marker = join(tmp, "real-marker");
    try {
      const stale = await new TmuxDriver({ socket: sock, session: "s1", dir }).open({ mode: "window", name: "old", cwd: tmp, argv: ["sleep", "60"] });
      t("kill-server");
      const d2 = new TmuxDriver({ socket: sock, session: "s1", dir });
      const fresh = await d2.open({ mode: "window", name: "new", cwd: tmp, argv: ["/bin/sh", "-c", `touch "$0"; sleep 60`, marker] });
      const panes = (): string[] => t("list-panes", "-a", "-F", "#{pane_id}").trim().split("\n");
      assert.equal(await d2.alive(stale), false, "stale id not alive");
      await d2.close(stale);
      assert.ok(panes().includes(fresh), `new pane ${fresh} survived the stale close of ${stale} (panes: ${panes().join(" ")})`);
      assert.equal(await d2.alive(fresh), true);
      for (let i = 0; i < 100 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 100));
      assert.ok(existsSync(marker), "the surviving pane runs the requested command");
      await d2.close(fresh);
      assert.equal(await d2.alive(fresh), false);
    } finally {
      try {
        t("kill-server");
      } catch {
        /* gone */
      }
    }
  });
});

describe("TmuxDriver.open when the ownership claim throws", () => {
  it("kills the freshly tagged pane and rethrows (fake server)", async () => {
    const srv = fakeServer();
    const blocker = join(tmp, "claim-blocker");
    writeFileSync(blocker, "a file, not a directory\n");
    const d = new TmuxDriver({ session: "S", run: srv.run, dir: join(blocker, "sub") });
    await assert.rejects(() => d.open({ mode: "window", name: "w", cwd: tmp, argv: ["sh"] } as never));
    assert.equal(srv.live.size, 0, `panes left behind: ${[...srv.live.keys()].join(",")}`);
    assert.deepEqual(srv.killed, ["%0"]);
  });
});
