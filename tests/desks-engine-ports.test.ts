// a lane on port P also runs `opencode serve` on P + ENGINE_PORT_OFFSET, so freeLanePort must skip a candidate
// whose own port is some entry's engine port, or whose engine port is taken (by the roster or by anything bound now).
import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { after, describe, it } from "node:test";
import { parseLayout } from "../src/desks/config.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deskUp, freeLanePort, portFree } from "../src/desks/service.ts";
import { ENGINE_PORT_OFFSET, type RosterEntry } from "../src/desks/types.ts";

const servers: Server[] = [];
after(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
});

function listen(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(port, "127.0.0.1", () => {
      servers.push(s);
      resolve();
    });
  });
}

function entry(over: Partial<RosterEntry>): RosterEntry {
  return {
    name: "X", kind: "desk", role: "r", agent: "opencode", engine: "opencode", mcps: [], port: 1, url: "http://127.0.0.1:1",
    pid: 1, runId: "r", cwd: "/", startedAt: 0, ...over,
  } as RosterEntry;
}

describe("freeLanePort skips engine-port collisions", () => {
  it("skips a lane port that is an entry's engine port, and one whose engine port is bound", async () => {
    // A base far from the usual 4800 stacks; find one whose candidate ports are all free so the control is meaningful.
    let base = 0;
    for (const b of [47100, 47300, 47500, 47700, 49100]) {
      const ports = [10, 11, 12].flatMap((o) => [b + o, b + o + ENGINE_PORT_OFFSET]);
      if ((await Promise.all(ports.map((p) => portFree(p)))).every(Boolean)) {
        base = b;
        break;
      }
    }
    assert.ok(base > 0, "found a free port block");
    const layout = parseLayout(`portBase: ${base}\nlanes: {ports: [10, 12]}\ndesks:\n  - {name: A, role: r}\n`, "t");

    // Control: nothing in the way, the first slot wins.
    assert.equal(await freeLanePort(layout, [], new Set()), base + 10);

    // base+10 is an existing lane's opencode engine port (its engineUrl); base+11's engine port is bound by something else.
    const roster = [entry({ name: "L0", kind: "lane", port: base + 10 - ENGINE_PORT_OFFSET, engineUrl: `http://127.0.0.1:${base + 10}` })];
    await listen(base + 11 + ENGINE_PORT_OFFSET);
    assert.equal(await freeLanePort(layout, roster, new Set()), base + 12);
  });

  it("skips a lane port whose engine port is a roster entry's host port, and one that is a default engine port", async (t) => {
    const base = 47900;
    const layout = parseLayout(`portBase: ${base}\nlanes: {ports: [10, 12]}\ndesks:\n  - {name: A, role: r}\n`, "t");
    const roster = [
      entry({ name: "H", kind: "desk", engine: "driver", port: base + 10 + ENGINE_PORT_OFFSET }), // host on 10's engine port
      entry({ name: "E", kind: "desk", engine: "opencode", port: base + 11 - ENGINE_PORT_OFFSET }), // engine (no URL) on 11
    ];
    const free = await Promise.all([base + 12, base + 12 + ENGINE_PORT_OFFSET].map((p) => portFree(p)));
    if (!free.every(Boolean)) {
      t.skip(`ports ${base + 12}/${base + 12 + ENGINE_PORT_OFFSET} busy on this machine`);
      return;
    }
    assert.equal(await freeLanePort(layout, roster, new Set()), base + 12);
  });
});

describe("deskUp portBase override", () => {
  it("rejects an override that pushes the last lane's engine port past 65535, before starting anything", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ach-desks-up-"));
    try {
      const layoutFile = join(dir, "desks.yaml");
      writeFileSync(layoutFile, "desks:\n  - {name: A, role: orchestrator}\nlanes: {ports: [10, 99]}\n");
      // 65000 + 99 = 65099 is a valid host port, but its engine port 65599 is not.
      await assert.rejects(deskUp({ stateDir: dir, layoutFile, portBase: 65000, term: "none" }), /portBase 65000 does not fit .* 65599, must be <= 65535/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
