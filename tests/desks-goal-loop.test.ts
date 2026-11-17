import "./support/no-network.mjs";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GOAL_PROTOCOL, parseGoalFlags, parseTurnStatus, startGoalLoop } from "../src/desks/engines/goal-loop.ts";
import type { GoalStatus } from "../src/desks/types.ts";

function scripted(replies: string[]) {
  const prompts: string[] = [];
  const runTurn = async (text: string) => {
    prompts.push(text);
    const r = replies[prompts.length - 1];
    if (r === undefined) throw new Error("script exhausted");
    return r;
  };
  return { prompts, runTurn };
}

describe("parseGoalFlags", () => {
  it("strips leading flags in either order", () => {
    assert.deepEqual(parseGoalFlags("--max-minutes 10 --max-turns 5 fix the bug"), {
      objective: "fix the bug",
      maxMinutes: 10,
      maxTurns: 5,
    });
    assert.deepEqual(parseGoalFlags("--max-turns=7 --max-minutes=2 x"), { objective: "x", maxMinutes: 2, maxTurns: 7 });
    assert.deepEqual(parseGoalFlags("plain --max-minutes 3 later"), { objective: "plain --max-minutes 3 later" });
  });
});

describe("parseTurnStatus", () => {
  it("tolerates separators and case, takes the last line", () => {
    assert.equal(parseTurnStatus("goal: continue\nmore\nGOAL: blocked - nope").kind, "blocked");
    assert.equal(parseTurnStatus("GOAL: ACHIEVED: all green").text, "all green");
    assert.equal(parseTurnStatus("**GOAL: CONTINUE**").kind, "continue");
    assert.equal(parseTurnStatus("nothing here").kind, "missing");
  });
});

describe("startGoalLoop", () => {
  it("achieved on turn 3 with evidence; protocol only in turn 1", async () => {
    const s = scripted(["plan\nGOAL: CONTINUE", "work\nGOAL: CONTINUE", "done\nGOAL: ACHIEVED — tests pass"]);
    const seen: GoalStatus[] = [];
    const h = startGoalLoop({ objective: "ship it", runTurn: s.runTurn, onStatus: (x) => seen.push(x), now: () => 1000 });
    const f = await h.done;
    assert.equal(f.state, "achieved");
    assert.equal(f.evidence, "tests pass");
    assert.equal(f.source, "ach-loop");
    assert.equal(f.updatedAt, 1000);
    assert.equal(s.prompts.length, 3);
    assert.ok(s.prompts[0].includes(GOAL_PROTOCOL) && s.prompts[0].includes("ship it"));
    assert.ok(!s.prompts[1].includes(GOAL_PROTOCOL) && !s.prompts[2].includes(GOAL_PROTOCOL));
    assert.match(s.prompts[1], /Continue the goal\. Last status: CONTINUE/);
    assert.equal(seen[0].state, "active");
    assert.equal(seen.at(-1)?.state, "achieved");
    assert.equal(h.status().state, "achieved");
  });

  it("blocked with reason", async () => {
    const s = scripted(["GOAL: BLOCKED — need credentials"]);
    const f = await startGoalLoop({ objective: "o", runTurn: s.runTurn }).done;
    assert.equal(f.state, "blocked");
    assert.equal(f.reason, "need credentials");
  });

  it("parses plan progress", async () => {
    const s = scripted(["1. a\n2. b\nPLAN: 1/2\nGOAL: CONTINUE", "PLAN: 2/2\nGOAL: ACHIEVED — ok"]);
    const seen: GoalStatus[] = [];
    const f = await startGoalLoop({ objective: "o", runTurn: s.runTurn, onStatus: (x) => seen.push(x) }).done;
    assert.deepEqual(f.plan, { verified: 2, total: 2 });
    assert.ok(seen.some((x) => x.plan?.verified === 1 && x.state === "active"));
  });

  it("stops at max turns", async () => {
    const s = scripted(Array(10).fill("GOAL: CONTINUE"));
    const f = await startGoalLoop({ objective: "o", runTurn: s.runTurn, maxTurns: 4 }).done;
    assert.equal(f.state, "stopped");
    assert.match(f.reason ?? "", /max turns/);
    assert.equal(s.prompts.length, 4);
  });

  it("stops at max minutes with a fake clock, flag from objective", async () => {
    let t = 0;
    const prompts: string[] = [];
    const runTurn = async (p: string) => {
      prompts.push(p);
      t += 60_000;
      return "GOAL: CONTINUE";
    };
    const f = await startGoalLoop({ objective: "--max-minutes 3 work", runTurn, now: () => t }).done;
    assert.equal(f.state, "stopped");
    assert.match(f.reason ?? "", /max minutes/);
    assert.equal(prompts.length, 3);
    assert.ok(!prompts[0].includes("--max-minutes"));
    assert.equal(f.objective, "work");
  });

  it("stop() mid-loop stops after the current turn", async () => {
    let h!: ReturnType<typeof startGoalLoop>;
    let n = 0;
    const runTurn = async () => {
      n++;
      if (n === 2) h.stop("user asked");
      return "GOAL: CONTINUE";
    };
    h = startGoalLoop({ objective: "o", runTurn });
    const f = await h.done;
    assert.equal(n, 2);
    assert.equal(f.state, "stopped");
    assert.equal(f.reason, "user asked");
  });

  it("runTurn throwing blocks with the message", async () => {
    const f = await startGoalLoop({
      objective: "o",
      runTurn: async () => {
        throw new Error("boom");
      },
    }).done;
    assert.equal(f.state, "blocked");
    assert.equal(f.reason, "boom");
  });

  it("three missing status lines block; reminder added; a status resets the count", async () => {
    const s = scripted(["hm", "hm", "hm"]);
    const f = await startGoalLoop({ objective: "o", runTurn: s.runTurn }).done;
    assert.equal(f.state, "blocked");
    assert.equal(f.reason, "no status line");
    assert.match(s.prompts[1], /no status line/);
    const s2 = scripted(["hm", "hm", "GOAL: CONTINUE", "hm", "hm", "GOAL: ACHIEVED — fine"]);
    const f2 = await startGoalLoop({ objective: "o", runTurn: s2.runTurn }).done;
    assert.equal(f2.state, "achieved");
  });
});
