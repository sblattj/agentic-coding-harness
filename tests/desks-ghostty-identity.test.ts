import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { GhosttyDriver, pidfileFor, startMatchesPidfile } from "../src/desks/term/ghostty.ts";

const tmp = mkdtempSync(join(tmpdir(), "ghostty-identity-"));

describe("GhosttyDriver close requires this open's identity, not only the command line", () => {
  const argv = ["/usr/local/bin/node", "/opt/ach/pane.js"];
  const mk = async (name: string, startOf: (pid: number) => number | undefined) => {
    const dir = join(tmp, name);
    const kills: number[] = [];
    const d = new GhosttyDriver({
      dir,
      settleMs: 0,
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
