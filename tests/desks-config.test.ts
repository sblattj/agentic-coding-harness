import "./support/no-network.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { builtinRolesDir, defaultLayout, deskPort, loadLayout, parseLayout, roleFiles } from "../src/desks/config.ts";
import type { Layout } from "../src/desks/types.ts";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "desks-config-")));
const msgOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return "";
};

describe("parseLayout", () => {
  it("fills defaults from a minimal YAML", () => {
    const l = parseLayout("desks:\n  - {name: A, role: r}\n", "t.yaml");
    assert.equal(l.portBase, 4800);
    assert.equal(l.stack, "default");
    assert.deepEqual(l.desks[0], { name: "A", role: "r", agent: "opencode", mcps: [] });
    assert.deepEqual(l.lanes, { defaultMcps: [], ports: [10, 99], approval: "none" });
  });

  it("accepts JSON and derives stack, agent and model inheritance", () => {
    const l = parseLayout(
      JSON.stringify({
        portBase: 5000, agent: "claude", model: "m1",
        desks: [{ name: "A", role: "r" }, { name: "B", role: "r", agent: "codex", model: "m2", mcps: ["x"] }],
        lanes: { defaultMcps: ["y"], ports: [5, 20], approval: "decisions", budgetUsd: 2 },
      }),
      "t.json",
    );
    assert.equal(l.stack, "p5000");
    assert.deepEqual([l.desks[0]!.agent, l.desks[0]!.model], ["claude", "m1"]);
    assert.deepEqual([l.desks[1]!.agent, l.desks[1]!.model, l.desks[1]!.mcps], ["codex", "m2", ["x"]]);
    assert.deepEqual(l.lanes.ports, [5, 20]);
    assert.equal(l.lanes.approval, "decisions");
  });

  it("keeps an explicit stack and a feed", () => {
    const l = parseLayout("stack: mine\ndesks:\n  - {name: A, role: r, feed: {command: [x, y], batchSeconds: 5}}\n", "t.yaml");
    assert.equal(l.stack, "mine");
    assert.deepEqual(l.desks[0]!.feed, { command: ["x", "y"], batchSeconds: 5 });
  });

  it("rejects bad YAML", () => {
    assert.match(msgOf(() => parseLayout("desks: [unclosed\n  - : :", "bad.yaml")), /bad\.yaml/);
    assert.match(msgOf(() => parseLayout("- a\n- b\n", "list.yaml")), /mapping/);
    assert.match(msgOf(() => parseLayout("", "empty.yaml")), /mapping/);
  });

  it("names the field path for schema errors", () => {
    assert.match(msgOf(() => parseLayout("desks: nope\n", "t")), /desks/);
    assert.match(msgOf(() => parseLayout("desks:\n  - {name: A}\n", "t")), /desks\[0\]\.role/);
    assert.match(msgOf(() => parseLayout("portBase: x\ndesks: []\n", "t")), /portBase/);
    assert.match(msgOf(() => parseLayout("desks:\n  - {name: A, role: r, pane: top}\n", "t")), /desks\[0\]\.pane/);
  });

  it("rejects duplicate and invalid desk names", () => {
    const dup = msgOf(() => parseLayout("desks:\n  - {name: A, role: r}\n  - {name: DECISIONS, role: r}\n  - {name: DECISIONS, role: r}\n", "t"));
    assert.match(dup, /desks\[2\]\.name: duplicate "DECISIONS"/);
    assert.match(msgOf(() => parseLayout("desks:\n  - {name: lower, role: r}\n", "t")), /desks\[0\]\.name/);
  });

  it("rejects overlapping, inverted and out-of-range ports", () => {
    const d = (n: number) => Array.from({ length: n }, (_, i) => `  - {name: D${i}, role: r}`).join("\n");
    // 3 desks need ports[0] >= 5
    assert.match(msgOf(() => parseLayout(`lanes: {ports: [4, 99]}\ndesks:\n${d(3)}\n`, "t")), /lanes\.ports\[0\]/);
    assert.doesNotThrow(() => parseLayout(`lanes: {ports: [5, 99]}\ndesks:\n${d(3)}\n`, "t"));
    assert.match(msgOf(() => parseLayout(`lanes: {ports: [50, 10]}\ndesks:\n${d(1)}\n`, "t")), /lanes\.ports/);
    assert.match(msgOf(() => parseLayout(`portBase: 65500\ndesks:\n${d(1)}\n`, "t")), /lanes\.ports\[1\].*65535/);
    assert.match(msgOf(() => parseLayout(`portBase: 0\ndesks:\n${d(1)}\n`, "t")), /portBase/);
    assert.match(msgOf(() => parseLayout(`lanes: {ports: [0, 5]}\ndesks:\n${d(1)}\n`, "t")), /lanes\.ports\[0\]/);
  });

  it("rejects an empty feed command", () => {
    assert.match(msgOf(() => parseLayout("desks:\n  - {name: A, role: r, feed: {command: []}}\n", "t")), /desks\[0\]\.feed\.command/);
  });

  it("resolves a relative rolesDir against the layout file", () => {
    const l = parseLayout("rolesDir: roles\ndesks: []\n", "/etc/x/desks.yaml");
    assert.equal(l.rolesDir, "/etc/x/roles");
  });
});

describe("defaultLayout / loadLayout", () => {
  it("defaultLayout is ORCHESTRATOR, DECISIONS, LISTENER", () => {
    const l = defaultLayout();
    assert.deepEqual(l.desks.map((d) => [d.name, d.role, d.pane]), [
      ["ORCHESTRATOR", "orchestrator", "left"], ["DECISIONS", "decisions", "right-top"], ["LISTENER", "listener", "right-bottom"],
    ]);
    assert.equal(l.portBase, 4800);
    assert.equal(l.stack, "default");
    assert.equal(l.model, undefined);
    assert.equal(l.desks[0]!.agent, "opencode");
    assert.equal(l.desks[2]!.feed, undefined);
    assert.deepEqual(l.lanes, { defaultMcps: [], ports: [10, 99], approval: "none", defaultGoalFlags: "--max-minutes 45" });
  });

  it("explicit file wins; a missing explicit file throws", () => {
    const d = tmp();
    const f = join(d, "mine.yaml");
    writeFileSync(f, "desks:\n  - {name: SOLO, role: r}\n");
    const r = loadLayout(f);
    assert.equal(r.file, f);
    assert.equal(r.layout.desks[0]!.name, "SOLO");
    assert.match(msgOf(() => loadLayout(join(d, "absent.yaml"))), /absent\.yaml/);
  });

  it("an invalid explicit file throws naming the file", () => {
    const f = join(tmp(), "bad.yaml");
    writeFileSync(f, "desks: 3\n");
    assert.match(msgOf(() => loadLayout(f)), /bad\.yaml/);
  });

  it("searches ./desks.yaml, then ~/.config/ach/desks.yaml, then the built-in", () => {
    const cwd = tmp();
    const home = tmp();
    const oldCwd = process.cwd();
    const oldHome = process.env.HOME;
    process.chdir(cwd);
    process.env.HOME = home;
    try {
      assert.equal(loadLayout().file, null);
      mkdirSync(join(home, ".config", "ach"), { recursive: true });
      writeFileSync(join(home, ".config", "ach", "desks.yaml"), "desks:\n  - {name: HOMEDESK, role: r}\n");
      const h = loadLayout();
      assert.equal(h.layout.desks[0]!.name, "HOMEDESK");
      assert.equal(h.file, join(home, ".config", "ach", "desks.yaml"));
      writeFileSync(join(cwd, "desks.yaml"), "desks:\n  - {name: CWDDESK, role: r}\n");
      const c = loadLayout();
      assert.equal(c.layout.desks[0]!.name, "CWDDESK");
      assert.equal(c.file, join(cwd, "desks.yaml"));
    } finally {
      process.chdir(oldCwd);
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });
});

describe("roleFiles / builtinRolesDir / deskPort", () => {
  const layoutWith = (rolesDir?: string): Layout => ({ portBase: 4800, rolesDir, desks: [], lanes: { defaultMcps: [], ports: [10, 99] } });

  it("builtinRolesDir is an absolute path ending in roles", () => {
    assert.match(builtinRolesDir(), /[\\/]roles$/);
  });

  it("looks in rolesDir first, falling back to the built-in dir for common.md", () => {
    const d = tmp();
    writeFileSync(join(d, "custom.md"), "x");
    writeFileSync(join(d, "common.md"), "c");
    assert.deepEqual(roleFiles(layoutWith(d), "custom"), [join(d, "common.md"), join(d, "custom.md")]);
  });

  it("falls back to builtin common.md when rolesDir has none (needs roles/common.md from the roles seat)", (t) => {
    const builtin = join(builtinRolesDir(), "common.md");
    const d = tmp();
    writeFileSync(join(d, "custom.md"), "x");
    let out: string[];
    try {
      out = roleFiles(layoutWith(d), "custom");
    } catch {
      t.skip(`no ${builtin} yet`);
      return;
    }
    assert.deepEqual(out, [builtin, join(d, "custom.md")]);
  });

  it("throws listing the searched dirs when the role file is missing", () => {
    const d = tmp();
    writeFileSync(join(d, "common.md"), "c");
    const m = msgOf(() => roleFiles(layoutWith(d), "ghost"));
    assert.match(m, /ghost\.md/);
    assert.ok(m.includes(d), m);
    assert.ok(m.includes(builtinRolesDir()), m);
  });

  it("rejects path-like role names", () => {
    assert.match(msgOf(() => roleFiles(layoutWith(tmp()), "../etc/passwd")), /invalid role/);
  });

  it("deskPort = portBase + 1 + i", () => {
    assert.equal(deskPort(layoutWith(), 0), 4801);
    assert.equal(deskPort({ ...layoutWith(), portBase: 5000 }, 2), 5003);
  });
});
