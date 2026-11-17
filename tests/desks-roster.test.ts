import "./support/no-network.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  appendDecisionEvent,
  appendMessage,
  appendPendingLane,
  deskPaths,
  nextDecisionId,
  nextPendingLaneId,
  putEntry,
  readDecisions,
  readMessages,
  readPendingLanes,
  readRoster,
  removeEntry,
  updateRoster,
  validName,
} from "../src/desks/roster.ts";
import { DESKS_API_VERSION, type DeskMessage, type PendingLane, type RosterEntry } from "../src/desks/types.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "desks-roster-"));
const STACK = "default";

export function entry(name: string): RosterEntry {
  return {
    name, kind: "desk", role: "r", agent: "opencode", engine: "opencode", mcps: [],
    port: 4801, url: "http://127.0.0.1:4801", pid: process.pid, runId: `run-${name}`, cwd: "/", startedAt: 1,
  };
}
const msg = (id: string, from: string, to: string, at: number): DeskMessage => ({ id, from, to, text: id, at, delivered: "now" });

describe("roster file", () => {
  it("missing file is an empty roster", () => {
    const s = tmp();
    assert.deepEqual(readRoster(s, STACK), { version: DESKS_API_VERSION, stack: STACK, portBase: 4800, entries: {} });
  });

  it("corrupt JSON throws with the path", () => {
    const s = tmp();
    const p = deskPaths(s, STACK);
    mkdirSync(p.root, { recursive: true });
    writeFileSync(p.roster, "{not json");
    assert.throws(() => readRoster(s, STACK), (e: Error) => e.message.includes(p.roster));
  });

  it("putEntry / removeEntry round-trip and release the lock", async () => {
    const s = tmp();
    const r = await putEntry(s, STACK, entry("A"));
    assert.equal(r.entries.A!.runId, "run-A");
    await putEntry(s, STACK, entry("B"));
    assert.deepEqual(Object.keys(readRoster(s, STACK).entries).sort(), ["A", "B"]);
    await removeEntry(s, STACK, "A");
    assert.deepEqual(Object.keys(readRoster(s, STACK).entries), ["B"]);
    assert.equal(existsSync(deskPaths(s, STACK).lock), false);
  });

  it("updateRoster accepts a returned replacement and releases the lock when fn throws", async () => {
    const s = tmp();
    const r = await updateRoster(s, STACK, (cur) => ({ ...cur, portBase: 5000 }));
    assert.equal(r.portBase, 5000);
    assert.equal(readRoster(s, STACK).portBase, 5000);
    await assert.rejects(updateRoster(s, STACK, () => { throw new Error("boom"); }), /boom/);
    assert.equal(existsSync(deskPaths(s, STACK).lock), false);
    assert.equal(readRoster(s, STACK).portBase, 5000);
  });

  it("breaks a stale lock dir (> 10 s old)", async () => {
    const s = tmp();
    const p = deskPaths(s, STACK);
    mkdirSync(p.lock, { recursive: true });
    const old = new Date(Date.now() - 20_000);
    utimesSync(p.lock, old, old);
    await putEntry(s, STACK, entry("A"));
    assert.ok(readRoster(s, STACK).entries.A);
    assert.equal(existsSync(p.lock), false);
  });

  it("waits for a fresh lock that is released shortly", async () => {
    const s = tmp();
    const p = deskPaths(s, STACK);
    mkdirSync(p.lock, { recursive: true });
    setTimeout(() => rmSync(p.lock, { recursive: true }), 200);
    const t0 = Date.now();
    await putEntry(s, STACK, entry("A"));
    assert.ok(Date.now() - t0 >= 150);
    assert.ok(readRoster(s, STACK).entries.A);
  });

  it("is safe under concurrent child processes (4 x 10 putEntry)", () => {
    const s = tmp();
    const script = join(tmp(), "child.mts");
    const mod = join(process.cwd(), "src/desks/roster.ts");
    writeFileSync(
      script,
      `import { putEntry } from ${JSON.stringify(mod)};
const [, , stateDir, who] = process.argv;
for (let i = 0; i < 10; i++) {
  await putEntry(stateDir!, "default", { name: who + "-" + i, kind: "desk", role: "r", agent: "a", engine: "opencode", mcps: [],
    port: 1, url: "http://127.0.0.1:1", pid: process.pid, runId: "r", cwd: "/", startedAt: 1 });
}
`,
    );
    const tsx = join(process.cwd(), "node_modules/.bin/tsx");
    // Launch all four at once via a parent that spawns async children.
    const parent = join(tmp(), "parent.mjs");
    writeFileSync(
      parent,
      `import { spawn } from "node:child_process";
const [, , tsx, script, stateDir] = process.argv;
const codes = await Promise.all(["w0", "w1", "w2", "w3"].map((w) => new Promise((res) => {
  const c = spawn(tsx, [script, stateDir, w], { stdio: "inherit" });
  c.on("exit", (code) => res(code));
})));
process.exit(codes.every((c) => c === 0) ? 0 : 1);
`,
    );
    const r = spawnSync(process.execPath, [parent, tsx, script, s], { encoding: "utf8", timeout: 120_000 });
    assert.equal(r.status, 0, r.stderr);
    const names = Object.keys(readRoster(s, STACK).entries);
    assert.equal(names.length, 40);
    for (const w of ["w0", "w1", "w2", "w3"]) for (let i = 0; i < 10; i++) assert.ok(names.includes(`${w}-${i}`), `${w}-${i}`);
  });
});

describe("messages", () => {
  it("filters by name (from OR to), sinceMs (>=), limit keeps newest, skips malformed lines", () => {
    const s = tmp();
    assert.deepEqual(readMessages(s, STACK), []);
    appendMessage(s, STACK, msg("1", "A", "B", 100));
    appendMessage(s, STACK, msg("2", "B", "A", 200));
    appendMessage(s, STACK, msg("3", "C", "D", 300));
    appendMessage(s, STACK, msg("4", "human", "A", 400));
    writeFileSync(deskPaths(s, STACK).messages, "garbage\n", { flag: "a" });
    appendMessage(s, STACK, msg("5", "A", "C", 500));
    assert.deepEqual(readMessages(s, STACK).map((m) => m.id), ["1", "2", "3", "4", "5"]);
    assert.deepEqual(readMessages(s, STACK, { name: "A" }).map((m) => m.id), ["1", "2", "4", "5"]);
    assert.deepEqual(readMessages(s, STACK, { sinceMs: 300 }).map((m) => m.id), ["3", "4", "5"]);
    assert.deepEqual(readMessages(s, STACK, { name: "A", limit: 2 }).map((m) => m.id), ["4", "5"]);
    assert.deepEqual(readMessages(s, STACK, { name: "A", sinceMs: 200, limit: 2 }).map((m) => m.id), ["4", "5"]);
  });
});

describe("decisions", () => {
  const open = (id: string, at = 1) => ({
    type: "open" as const,
    decision: { id, question: `q${id}`, options: [{ label: "yes" }], askedBy: "ORCH", openedBy: "DECISIONS", openedAt: at },
  });

  it("starts at D1 and counts up", () => {
    const s = tmp();
    assert.equal(nextDecisionId(s, STACK), "D1");
    appendDecisionEvent(s, STACK, open("D1"));
    appendDecisionEvent(s, STACK, open("D10"));
    appendDecisionEvent(s, STACK, open("D2"));
    assert.equal(nextDecisionId(s, STACK), "D11");
  });

  it("folds open/answer/close, ignores unknown ids, orders numerically", () => {
    const s = tmp();
    appendDecisionEvent(s, STACK, open("D10"));
    appendDecisionEvent(s, STACK, open("D2"));
    appendDecisionEvent(s, STACK, open("D3"));
    appendDecisionEvent(s, STACK, { type: "answer", id: "D2", text: "go", by: "human", at: 5 });
    appendDecisionEvent(s, STACK, { type: "close", id: "D3", by: "DECISIONS", at: 6 });
    appendDecisionEvent(s, STACK, { type: "answer", id: "D99", text: "x", by: "human", at: 7 });
    appendDecisionEvent(s, STACK, { type: "close", id: "D98", by: "human", at: 8 });
    const ds = readDecisions(s, STACK);
    assert.deepEqual(ds.map((d) => [d.id, d.state]), [["D2", "answered"], ["D3", "closed"], ["D10", "open"]]);
    assert.deepEqual(ds[0]!.answer, { text: "go", by: "human", at: 5 });
    assert.equal(ds[2]!.answer, undefined);
  });

  it("skips malformed lines", () => {
    const s = tmp();
    appendDecisionEvent(s, STACK, open("D1"));
    writeFileSync(deskPaths(s, STACK).decisions, "{oops\n", { flag: "a" });
    assert.equal(readDecisions(s, STACK).length, 1);
  });
});

describe("pending lanes", () => {
  const pl = (id: string, state: PendingLane["state"]): PendingLane => ({
    id, request: { name: "lane", goal: "g", launchedBy: "ORCH" }, requestedAt: 1, state,
  });

  it("latest snapshot per id wins; ids count up from L1", () => {
    const s = tmp();
    assert.equal(nextPendingLaneId(s, STACK), "L1");
    assert.deepEqual(readPendingLanes(s, STACK), []);
    appendPendingLane(s, STACK, pl("L1", "pending"));
    appendPendingLane(s, STACK, pl("L2", "pending"));
    appendPendingLane(s, STACK, { ...pl("L1", "approved"), decidedBy: "human", decidedAt: 9 });
    const all = readPendingLanes(s, STACK);
    assert.deepEqual(all.map((p) => [p.id, p.state]), [["L1", "approved"], ["L2", "pending"]]);
    assert.equal(all[0]!.decidedBy, "human");
    assert.equal(nextPendingLaneId(s, STACK), "L3");
  });
});

describe("validName", () => {
  it("desk names are upper-case", () => {
    for (const n of ["ORCHESTRATOR", "A", "A_B-1", "A".repeat(32)]) assert.equal(validName(n, "desk"), true, n);
    for (const n of ["", "orch", "1A", "_A", "A".repeat(33), "A B", "A.B"]) assert.equal(validName(n, "desk"), false, n);
  });
  it("lane names allow lower-case and leading digits", () => {
    for (const n of ["lane-1", "L1", "9x", "a".repeat(48)]) assert.equal(validName(n, "lane"), true, n);
    for (const n of ["", "-a", "a b", "a".repeat(49), "a/b"]) assert.equal(validName(n, "lane"), false, n);
  });
});
