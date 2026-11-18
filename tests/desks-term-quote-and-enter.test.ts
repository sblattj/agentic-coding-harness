import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { GhosttyDriver, pidfileFor, startMatchesPidfile, surfaceCommand } from "../src/desks/term/ghostty.ts";
import { paneCommand } from "../src/desks/term/tmux.ts";

const tmp = mkdtempSync(join(tmpdir(), "term-quote-enter-"));

describe("shell path is quoted in launch commands", () => {
  const shell = { path: "/opt/my shells/z$sh", flags: ["-lic"], bareFlags: ["-fc"] };
  it("paneCommand passes a path with a space and $ as one quoted word", () => {
    assert.ok(paneCommand(["echo", "hi"], shell).startsWith("'/opt/my shells/z$sh' -lic "));
  });
  it("surfaceCommand passes a path with a space and $ as one quoted word", () => {
    assert.ok(surfaceCommand(["echo", "hi"], "/tmp/x.pid", shell).startsWith("'/opt/my shells/z$sh' -lic "));
  });
});

describe("startMatchesPidfile rejects a start after the pidfile write", () => {
  it("1.2 s after is rejected; before and same-second are accepted", () => {
    assert.equal(startMatchesPidfile(10_000 + 1_200, 10_000), false);
    assert.equal(startMatchesPidfile(10_000 - 500, 10_000), true);
    assert.equal(startMatchesPidfile(10_000 + 1_000, 10_000), true);
  });
});

describe("close sends Enter only when ownership is confirmed", () => {
  const argv = ["/usr/local/bin/node", "/opt/ach/pane.js"];
  const mk = async (name: string, opts: { pidfile: boolean; cmd: string | undefined }) => {
    const dir = join(tmp, name);
    const scripts: string[] = [];
    const d = new GhosttyDriver({
      dir,
      settleMs: 0,
      isAlive: () => false,
      kill: () => {},
      commandOf: () => opts.cmd,
      startOf: () => Date.now() - 5_000,
      osascript: async (s) => {
        scripts.push(s);
        return "T-1";
      },
    });
    const id = await d.open({ mode: "window", name: "n", cwd: "/c", argv });
    if (opts.pidfile) writeFileSync(pidfileFor(id, dir) as string, "5150\n");
    scripts.length = 0;
    await d.close(id);
    return scripts.filter((s) => s.includes("send key")).length;
  };
  it("missing pidfile: no Enter", async () => {
    assert.equal(await mk("missing", { pidfile: false, cmd: undefined }), 0);
  });
  it("pid fails identity check: no Enter", async () => {
    assert.equal(await mk("foreign", { pidfile: true, cmd: "/usr/bin/vim notes.txt" }), 0);
  });
  it("confirmed process: Enter sent", async () => {
    assert.equal(await mk("ours", { pidfile: true, cmd: "/usr/local/bin/node /opt/ach/pane.js" }), 1);
  });
  it("recorded pid already exited: Enter sent", async () => {
    assert.equal(await mk("gone", { pidfile: true, cmd: undefined }), 1);
  });
});
