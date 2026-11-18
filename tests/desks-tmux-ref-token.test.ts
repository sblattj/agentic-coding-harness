// the ownership token rides in the roster's TerminalRef, so a stale ref can never close or report alive a newer
// pane that reused its %N, even when the old sidecar file is gone (the case the sidecar-only check let through).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { closePane } from "../src/desks/service.ts";
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
  const run = async (a: string[]): Promise<string> => {
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
        if (!live.delete(t)) throw new Error(`tmux kill-pane failed: can't find pane: ${t}`);
        return "";
      case "if-shell": {
        // close()'s atomic check-and-kill, evaluated in one step like the real server.
        if (!live.has(t)) throw new Error(`tmux if-shell failed: can't find pane: ${t}`);
        if (!fakeIfShellOwned(a, t, live.get(t))) return "ach-not-owned\n"; // NOT_OWNED in tmux.ts
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
  return { run, live, restart };
}

const wipe = (dir: string): void => {
  for (const f of readdirSync(dir)) rmSync(join(dir, f), { force: true });
};

describe("TerminalRef token: stale ref vs a new pane on the same %N with the old sidecar gone (fake server)", () => {
  it("the stale token neither reports alive nor closes; the new token does both", async () => {
    const srv = fakeServer();
    const dir = join(tmp, "fake");
    const d1 = new TmuxDriver({ session: "S", run: srv.run, dir });
    const staleId = await d1.open({ mode: "window", name: "old", cwd: "/c", argv: ["x"] });
    const staleToken = d1.tokenOf(staleId);
    assert.ok(staleToken, "the driver hands back the token it set");

    srv.restart();
    wipe(dir); // tmpdir cleaned (reboot, tmp reaper): the old sidecar is gone
    const d2 = new TmuxDriver({ session: "S", run: srv.run, dir });
    const freshId = await d2.open({ mode: "window", name: "new", cwd: "/c", argv: ["x"] });
    const freshToken = d2.tokenOf(freshId);
    assert.equal(freshId, staleId, "precondition: the new pane reused the stale %N");
    assert.notEqual(freshToken, staleToken);

    assert.equal(await d2.alive(staleId, staleToken), false, "stale ref is not alive");
    await d2.close(staleId, staleToken);
    assert.ok(srv.live.has(freshId), "stale close left the new pane alone");
    assert.ok(existsSync(join(dir, "default-_0.tok")), "stale close kept the new pane's sidecar");
    assert.equal(await d2.alive(freshId, freshToken), true, "control: the new ref is alive");
    await d2.close(freshId, freshToken);
    assert.equal(srv.live.has(freshId), false, "control: the new ref closes its pane");
  });
});

describe("TerminalRef token: stale ref vs a reused %N (real tmux)", { skip: !HAVE_TMUX && "tmux not installed" }, () => {
  it("after a server restart and a lost sidecar, the stale ref cannot close or see the new pane", async () => {
    const sock = `ach-desks-${process.pid}`;
    const t = (...a: string[]): string => execFileSync("tmux", ["-L", sock, ...a], { encoding: "utf8" });
    const dir = join(tmp, "real");
    try {
      const d1 = new TmuxDriver({ socket: sock, session: "s1", dir });
      const staleId = await d1.open({ mode: "window", name: "old", cwd: tmp, argv: ["sleep", "60"] });
      const staleToken = d1.tokenOf(staleId);
      t("kill-server");
      wipe(dir);
      const d2 = new TmuxDriver({ socket: sock, session: "s1", dir });
      const freshId = await d2.open({ mode: "window", name: "new", cwd: tmp, argv: ["sleep", "60"] });
      const freshToken = d2.tokenOf(freshId);
      const panes = (): string[] => {
        try {
          return t("list-panes", "-a", "-F", "#{pane_id}").trim().split("\n");
        } catch {
          return []; // the last pane closed and the server exited
        }
      };
      assert.equal(freshId, staleId, `precondition: tmux reused ${staleId}`);
      assert.equal(await d2.alive(staleId, staleToken), false, "stale ref not alive");
      await d2.close(staleId, staleToken);
      assert.ok(panes().includes(freshId), `new pane ${freshId} survived the stale close (panes: ${panes().join(" ")})`);
      assert.equal(await d2.alive(freshId, freshToken), true, "control: new ref alive");
      // A fresh driver instance (another process: the CLI, the web server) acts from the stored token alone.
      const d3 = new TmuxDriver({ socket: sock, session: "s1", dir });
      await d3.close(freshId, freshToken);
      assert.equal(panes().includes(freshId), false, "control: the new ref closes its pane from another driver instance");
    } finally {
      try {
        t("kill-server");
      } catch {
        /* gone */
      }
    }
  });
});

describe("service closePane trusts only the token stored in the ref (real tmux)", { skip: !HAVE_TMUX && "tmux not installed" }, () => {
  it("a tokenless (legacy) ref and a wrong-token ref leave the pane; the real ref closes it", async () => {
    const sock = `ach-desks-svc-${process.pid}`;
    const t = (...a: string[]): string => execFileSync("tmux", ["-L", sock, ...a], { encoding: "utf8" });
    const panes = (): string[] => {
      try {
        return t("list-panes", "-a", "-F", "#{pane_id}").trim().split("\n");
      } catch {
        return [];
      }
    };
    const term = { kind: "tmux" as const, tmuxSession: "s1", tmuxSocket: sock };
    try {
      // Default sidecar dir, like the service's own driver: the sidecar of this pane is valid throughout.
      const d = new TmuxDriver({ socket: sock, session: "s1" });
      const id = await d.open({ mode: "window", name: "p", cwd: tmp, argv: ["sleep", "60"] });
      const token = d.tokenOf(id)!;
      await closePane(term, { kind: "tmux", id });
      assert.ok(panes().includes(id), "a tokenless ref is never treated as ours");
      await closePane(term, { kind: "tmux", id, token: "not-the-token" });
      assert.ok(panes().includes(id), "a wrong-token ref leaves the pane");
      await closePane(term, { kind: "tmux", id, token });
      assert.equal(panes().includes(id), false, "control: the stored token closes it");
    } finally {
      try {
        t("kill-server");
      } catch {
        /* gone */
      }
    }
  });
});
