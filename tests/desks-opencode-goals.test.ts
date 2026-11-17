import "./support/no-network.mjs";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { readOpencodeGoal } from "../src/desks/engines/opencode-goals.ts";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "desks", "opencode-goals");
const SID = "ses_e14d6642dffefhU48dHiuz74pI";
const roots: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "ocgoals-"));
  roots.push(d);
  return d;
}
function put(dir: string, hash: string, doc: unknown): void {
  const p = join(dir, ".opencode", "goals", "state.json.sessions", hash);
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, "state.json"), typeof doc === "string" ? doc : JSON.stringify(doc));
}
const live = (over: Record<string, unknown>) => ({ condition: "obj", sessionID: SID, stopped: false, stopReason: "", blockedReason: "", lastStatus: "working", startedAt: 100, ...over });
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

describe("readOpencodeGoal", () => {
  it("reads the real plugin fixture: achieved from results[]", () => {
    const dir = tmp();
    cpSync(FIX, join(dir, ".opencode", "goals"), { recursive: true });
    const g = readOpencodeGoal({ dir, sessionId: SID });
    assert.equal(g.state, "achieved");
    assert.equal(g.source, "opencode-plugin");
    assert.match(g.objective, /write the word DONE/);
    assert.match(g.evidence ?? "", /printed `DONE`/);
    assert.equal(g.reason, undefined);
    assert.equal(g.updatedAt, 1794946791045);
  });

  it("no state dir -> none with the fallback objective", () => {
    const g = readOpencodeGoal({ dir: tmp(), sessionId: SID, objective: "fallback" });
    assert.equal(g.state, "none");
    assert.equal(g.objective, "fallback");
    assert.equal(readOpencodeGoal({ dir: tmp(), sessionId: SID }).objective, "");
  });

  it("only the entry with the matching sessionID counts across hash dirs", () => {
    const dir = tmp();
    put(dir, "a".repeat(64), { goals: [], results: [{ sessionID: "ses_other", condition: "x", state: "achieved", finishedAt: 5 }], archives: [] });
    assert.equal(readOpencodeGoal({ dir, sessionId: SID }).state, "none");
    put(dir, "b".repeat(64), { goals: [live({})], results: [], archives: [] });
    const g = readOpencodeGoal({ dir, sessionId: SID });
    assert.equal(g.state, "active");
    assert.equal(g.objective, "obj");
    assert.equal(readOpencodeGoal({ dir, sessionId: "ses_other" }).state, "achieved");
  });

  it("stopped as string \"false\" is active, string \"true\" and boolean true are stopped", () => {
    const dir = tmp();
    put(dir, "c".repeat(64), { goals: [live({ stopped: "false" })] });
    assert.equal(readOpencodeGoal({ dir, sessionId: SID }).state, "active");
    put(dir, "c".repeat(64), { goals: [live({ stopped: "true", stopReason: "paused" })] });
    const s = readOpencodeGoal({ dir, sessionId: SID });
    assert.equal(s.state, "stopped");
    assert.equal(s.reason, "paused");
    put(dir, "c".repeat(64), { goals: [live({ stopped: true, stopReason: "paused" })] });
    assert.equal(readOpencodeGoal({ dir, sessionId: SID }).state, "stopped");
  });

  it("blockedReason \"\" means none; non-empty means blocked", () => {
    const dir = tmp();
    put(dir, "d".repeat(64), { goals: [live({ blockedReason: "" })] });
    assert.equal(readOpencodeGoal({ dir, sessionId: SID }).state, "active");
    put(dir, "d".repeat(64), { goals: [live({ stopped: true, stopReason: "blocked", blockedReason: "need token" })] });
    const g = readOpencodeGoal({ dir, sessionId: SID });
    assert.equal(g.state, "blocked");
    assert.equal(g.reason, "need token");
  });

  it("plan progress counts done+pass actions", () => {
    const dir = tmp();
    const actions = [
      { status: "done", verdict: "pass", claim: "c", evidence: "e" },
      { status: "done", verdict: "fail", claim: "c", evidence: "e" },
      { status: "pending", verdict: null },
    ];
    put(dir, "e".repeat(64), { goals: [live({ plan: { actions } })] });
    assert.deepEqual(readOpencodeGoal({ dir, sessionId: SID }).plan, { verified: 1, total: 3 });
  });

  it("plan progress needs claim and evidence as well as done+pass", () => {
    const dir = tmp();
    const actions = [
      { status: "done", verdict: "pass", claim: "c", evidence: "e" },
      { status: "done", verdict: "pass", claim: "c" },
      { status: "done", verdict: "pass", evidence: "e" },
      { status: "done", verdict: "pass", claim: "  ", evidence: "e" },
      { status: "done", verdict: "pass" },
    ];
    put(dir, "f".repeat(64), { goals: [live({ plan: { actions } })] });
    assert.deepEqual(readOpencodeGoal({ dir, sessionId: SID }).plan, { verified: 1, total: 5 });
  });

  it("achieved result only in archives[].results[]; newest wins; live goal beats results", () => {
    const dir = tmp();
    put(dir, "f".repeat(64), {
      goals: [],
      results: [],
      archives: [{ sessionID: SID, results: [
        { sessionID: SID, condition: "old", state: "blocked", blockedReason: "b", finishedAt: 10 },
        { sessionID: SID, condition: "new", state: "achieved", evidence: "ok", finishedAt: 20 },
      ] }],
    });
    const g = readOpencodeGoal({ dir, sessionId: SID });
    assert.equal(g.state, "achieved");
    assert.equal(g.objective, "new");
    put(dir, "9".repeat(64), { goals: [live({ condition: "rerun" })] });
    assert.equal(readOpencodeGoal({ dir, sessionId: SID }).state, "active");
  });

  it("blocked and stopped results", () => {
    const dir = tmp();
    put(dir, "1".repeat(64), { results: [{ sessionID: SID, condition: "o", state: "blocked", blockedReason: "why", finishedAt: 1 }] });
    assert.equal(readOpencodeGoal({ dir, sessionId: SID }).state, "blocked");
    put(dir, "1".repeat(64), { results: [{ sessionID: SID, condition: "o", state: "cleared", finishedAt: 1 }] });
    assert.equal(readOpencodeGoal({ dir, sessionId: SID }).state, "stopped");
  });

  it("a malformed file does not hide a good one; legacy state.json is read too", () => {
    const dir = tmp();
    put(dir, "2".repeat(64), "{not json");
    put(dir, "3".repeat(64), { goals: [live({})] });
    assert.equal(readOpencodeGoal({ dir, sessionId: SID }).state, "active");
    const dir2 = tmp();
    mkdirSync(join(dir2, ".opencode", "goals"), { recursive: true });
    writeFileSync(join(dir2, ".opencode", "goals", "state.json"), JSON.stringify({ goals: [live({})] }));
    assert.equal(readOpencodeGoal({ dir: dir2, sessionId: SID }).state, "active");
  });
});
