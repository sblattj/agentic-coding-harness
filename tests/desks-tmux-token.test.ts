// A stale roster entry must never own a pane opened later under the same reused %N (threads-210, tmux.ts:196).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { TmuxDriver } from "../src/desks/term/tmux.ts";

const HAVE_TMUX = spawnSync("tmux", ["-V"]).status === 0;
const tmp = mkdtempSync(join(tmpdir(), "ach-desks-token-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

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
