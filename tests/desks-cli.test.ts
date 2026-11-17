import "./support/no-network.mjs";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { cmdDesk, cmdLane, formatChatEvent, formatRoster, parseSince, type DeskDeps, type DeskService } from "../src/cli/desk.ts";
import type { Decision, DeskMessage, HostEvent, RosterEntry, RosterRow, RosterView } from "../src/desks/types.ts";

type Call = { fn: string; args: unknown };

const NOW = 1_800_000_000_000;

function row(over: Partial<RosterRow> = {}): RosterRow {
  return {
    name: "ORCHESTRATOR", kind: "desk", role: "orchestrator", agent: "opencode", engine: "opencode", model: "ferry/super-flash", mcps: [],
    port: 4801, url: "http://127.0.0.1:4801", pid: 1, runId: "r1", cwd: "/w", startedAt: NOW, state: "idle", queueDepth: 0,
    costUsd: 0.5, treeCostUsd: 1.25, ...over,
  };
}
const entry = (over: Partial<RosterEntry> = {}): RosterEntry => {
  const { state: _s, queueDepth: _q, costUsd: _c, treeCostUsd: _t, goalStatus: _g, ...e } = row({ name: "audit", kind: "lane", port: 4810 });
  return { ...e, ...over };
};
const view = (rows: RosterRow[] = [row()], over: Partial<RosterView> = {}): RosterView => ({
  version: "desks-api/1", stack: "default", portBase: 4800, rows, pendingLanes: [], openDecisions: [], ...over,
});
const msg = (over: Partial<DeskMessage> = {}): DeskMessage => ({ id: "m1", from: "human", to: "WORKER", text: "hi", at: NOW, delivered: "now", ...over });
const decision = (over: Partial<Decision> = {}): Decision => ({
  id: "D1", question: "Ship it?", options: [{ label: "yes", recommended: true, reason: "tests pass" }], askedBy: "WORKER", openedBy: "DECISIONS",
  openedAt: NOW, state: "open", ...over,
});

interface Rig {
  calls: Call[];
  out: string[];
  err: string[];
  stdin: PassThrough;
  deps: Partial<DeskDeps>;
  subscribed: { url: string; since: number; cb: (e: HostEvent) => void; stopped: boolean }[];
  stdout(): string;
  stderr(): string;
}

function rig(returns: Record<string, unknown> = {}, opts: { hostEvents?: HostEvent[]; throws?: string; abort?: AbortSignal; env?: NodeJS.ProcessEnv } = {}): Rig {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const subscribed: Rig["subscribed"] = [];
  const stdin = new PassThrough();
  const fn = (name: string, dflt: unknown) => async (args: unknown) => {
    calls.push({ fn: name, args });
    if (opts.throws !== undefined) throw new Error(opts.throws);
    return name in returns ? returns[name] : dflt;
  };
  const service = {
    deskUp: fn("deskUp", view()), deskDown: fn("deskDown", { stopped: ["A", "B"] }), deskAttach: fn("deskAttach", view()),
    deskSend: fn("deskSend", msg()), deskRoster: fn("deskRoster", view()), deskInbox: fn("deskInbox", [msg()]),
    deskEvents: fn("deskEvents", []), deskSwitchEngine: fn("deskSwitchEngine", entry()), laneNew: fn("laneNew", entry()),
    laneApprove: fn("laneApprove", entry()), laneReject: fn("laneReject", { id: "L1", request: {}, requestedAt: NOW, state: "rejected", reason: "no" }),
    laneStop: fn("laneStop", { stopped: "audit" }), laneStatus: fn("laneStatus", [row({ name: "audit", kind: "lane" })]),
    decisionAnswer: fn("decisionAnswer", decision({ state: "answered" })), decisionClose: fn("decisionClose", decision({ state: "closed" })),
    decisionList: fn("decisionList", [decision()]), deskCosts: fn("deskCosts", []),
  } as unknown as DeskService;
  const host = {
    hostEvents: async (_u: string, _s?: number) => opts.hostEvents ?? [],
    hostSubscribe: (url: string, since: number, cb: (e: HostEvent) => void) => {
      const s = { url, since, cb, stopped: false };
      subscribed.push(s);
      return () => void (s.stopped = true);
    },
  };
  return {
    calls, out, err, stdin, subscribed,
    deps: { service, host, stdout: (s) => void out.push(s), stderr: (s) => void err.push(s), stdin, env: opts.env ?? {}, now: () => NOW, abort: opts.abort },
    stdout: () => out.join(""), stderr: () => err.join(""),
  };
}

describe("desk argument parsing -> service call args", () => {
  it("up maps every flag", async () => {
    const r = rig();
    const code = await cmdDesk(["up", "--layout", "d.yaml", "--port-base", "4900", "--term", "none", "--tmux-session", "S", "--tmux-socket", "sock", "--stack", "x"], r.deps);
    assert.equal(code, 0);
    assert.deepEqual(r.calls, [{ fn: "deskUp", args: { stack: "x", layoutFile: "d.yaml", portBase: 4900, term: "none", tmuxSession: "S", tmuxSocket: "sock" } }]);
    assert.match(r.stdout(), /^NAME\s+KIND\s+STATE\s+AGENT\s+MODEL\s+PORT\s+QUEUE\s+GOAL\s+COST/);
  });
  it("up with no flags passes an empty object", async () => {
    const r = rig();
    await cmdDesk(["up"], r.deps);
    assert.deepEqual(r.calls, [{ fn: "deskUp", args: {} }]);
  });
  it("down prints the stopped names", async () => {
    const r = rig();
    assert.equal(await cmdDesk(["down", "--stack", "s"], r.deps), 0);
    assert.deepEqual(r.calls, [{ fn: "deskDown", args: { stack: "s" } }]);
    assert.equal(r.stdout(), "stopped: A, B\n");
  });
  it("attach passes term and tmux options", async () => {
    const r = rig();
    await cmdDesk(["attach", "--term", "tmux", "--tmux-session", "w"], r.deps);
    assert.deepEqual(r.calls, [{ fn: "deskAttach", args: { term: "tmux", tmuxSession: "w" } }]);
  });
  it("send joins the text and defaults from to human", async () => {
    const r = rig();
    assert.equal(await cmdDesk(["send", "WORKER", "summarize", "open", "PRs"], r.deps), 0);
    assert.deepEqual(r.calls, [{ fn: "deskSend", args: { from: "human", to: "WORKER", text: "summarize open PRs" } }]);
  });
  it("send takes --from, else $ACH_DESK_NAME", async () => {
    const a = rig();
    await cmdDesk(["send", "W", "x", "--from", "ME"], a.deps);
    assert.equal((a.calls[0]?.args as { from: string }).from, "ME");
    const b = rig({}, { env: { ACH_DESK_NAME: "ORCH" } });
    await cmdDesk(["send", "W", "x"], b.deps);
    assert.equal((b.calls[0]?.args as { from: string }).from, "ORCH");
  });
  it("send '-' reads the text from stdin", async () => {
    const r = rig();
    r.stdin.end("line one\nline two\n\n");
    assert.equal(await cmdDesk(["send", "WORKER", "-"], r.deps), 0);
    assert.deepEqual(r.calls, [{ fn: "deskSend", args: { from: "human", to: "WORKER", text: "line one\nline two" } }]);
  });
  it("send '-' with empty stdin is a usage error", async () => {
    const r = rig();
    r.stdin.end("");
    assert.equal(await cmdDesk(["send", "WORKER", "-"], r.deps), 2);
    assert.equal(r.calls.length, 0);
  });
  it("roster: --no-prune and $ACH_DESK_NAME (me)", async () => {
    const r = rig({}, { env: { ACH_DESK_NAME: "ORCH" } });
    await cmdDesk(["roster", "--no-prune"], r.deps);
    assert.deepEqual(r.calls, [{ fn: "deskRoster", args: { me: "ORCH", prune: false } }]);
  });
  it("inbox: name, limit, and a duration --since", async () => {
    const r = rig();
    await cmdDesk(["inbox", "WORKER", "--limit", "5", "--since", "10m"], r.deps);
    assert.deepEqual(r.calls, [{ fn: "deskInbox", args: { name: "WORKER", limit: 5, sinceMs: NOW - 600_000 } }]);
  });
  it("inbox: a bare number is an epoch-ms --since; no args = everything", async () => {
    const r = rig();
    await cmdDesk(["inbox", "--since", "1700000000000"], r.deps);
    await cmdDesk(["inbox"], r.deps);
    assert.deepEqual(r.calls.map((c) => c.args), [{ sinceMs: 1_700_000_000_000 }, {}]);
  });
  it("events: name and --since seq", async () => {
    const r = rig({ deskEvents: [{ seq: 3, at: NOW, runId: "r", name: "W", type: "text", data: { text: "hello" } }] });
    assert.equal(await cmdDesk(["events", "W", "--since", "2"], r.deps), 0);
    assert.deepEqual(r.calls, [{ fn: "deskEvents", args: { name: "W", since: 2 } }]);
    assert.match(r.stdout(), /text\s+hello/);
  });
  it("answer joins text and defaults by to human", async () => {
    const r = rig();
    assert.equal(await cmdDesk(["answer", "D1", "yes,", "option", "2"], r.deps), 0);
    assert.deepEqual(r.calls, [{ fn: "decisionAnswer", args: { id: "D1", text: "yes, option 2", by: "human" } }]);
  });
  it("decisions: --state", async () => {
    const r = rig();
    await cmdDesk(["decisions", "--state", "open"], r.deps);
    assert.deepEqual(r.calls, [{ fn: "decisionList", args: { state: "open" } }]);
    assert.match(r.stdout(), /D1\s+open\s+from WORKER\s+Ship it\?/);
  });
  it("close: reason", async () => {
    const r = rig();
    await cmdDesk(["close", "D1", "--reason", "moot"], r.deps);
    assert.deepEqual(r.calls, [{ fn: "decisionClose", args: { id: "D1", by: "human", reason: "moot" } }]);
  });
  it("engine: name, agent, model", async () => {
    const r = rig();
    await cmdDesk(["engine", "WORKER", "claude", "--model", "claude-sonnet-5-5"], r.deps);
    assert.deepEqual(r.calls, [{ fn: "deskSwitchEngine", args: { name: "WORKER", agent: "claude", model: "claude-sonnet-5-5" } }]);
  });
  it("costs renders the lane tree", async () => {
    const rows = [{ name: "ORCH", kind: "desk", runId: "r", costUsd: 1, inputTokens: 1200, outputTokens: 30, lanes: [{ name: "audit", kind: "lane", runId: "r2", costUsd: null, inputTokens: 5, outputTokens: 6, lanes: [] }] }];
    const r = rig({ deskCosts: rows });
    assert.equal(await cmdDesk(["costs"], r.deps), 0);
    assert.match(r.stdout(), /ORCH\s+desk\s+1,200\s+30\s+\$1\.0000/);
    assert.match(r.stdout(), /\n {2}audit\s+lane\s+5\s+6\s+-/);
  });
});

describe("lane argument parsing -> service call args", () => {
  it("new maps every flag", async () => {
    const r = rig();
    const code = await cmdLane(["new", "audit", "--goal", "do it", "--agent", "claude", "--model", "m", "--mcps", "a, b", "--cwd", "/w", "--budget-usd", "2.5", "--from", "ORCH", "--brief", "ctx"], r.deps);
    assert.equal(code, 0);
    assert.deepEqual(r.calls, [{ fn: "laneNew", args: { name: "audit", goal: "do it", mcps: ["a", "b"], cwd: "/w", agent: "claude", model: "m", budgetUsd: 2.5, launchedBy: "ORCH", brief: "ctx" } }]);
    assert.match(r.stdout(), /lane audit started on port 4810/);
  });
  it("new prints the pending line when approval is needed", async () => {
    const r = rig({ laneNew: { pending: { id: "L3", request: {}, requestedAt: NOW, state: "pending" } } });
    await cmdLane(["new", "x", "--goal", "g"], r.deps);
    assert.equal(r.stdout(), "pending L3: waiting for DECISIONS approval\n");
    assert.equal((r.calls[0]?.args as { launchedBy: string }).launchedBy, "human");
  });
  it("status [name], stop, approve, reject", async () => {
    const r = rig();
    await cmdLane(["status", "audit"], r.deps);
    await cmdLane(["stop", "audit"], r.deps);
    await cmdLane(["approve", "L1"], r.deps);
    await cmdLane(["reject", "L2", "--reason", "too big"], r.deps);
    assert.deepEqual(r.calls, [
      { fn: "laneStatus", args: { name: "audit" } },
      { fn: "laneStop", args: { name: "audit", by: "human" } },
      { fn: "laneApprove", args: { id: "L1", by: "human" } },
      { fn: "laneReject", args: { id: "L2", by: "human", reason: "too big" } },
    ]);
  });
  it("status prints a table", async () => {
    const r = rig({ laneStatus: [row({ name: "audit", kind: "lane", state: "busy", goalStatus: { objective: "o", state: "active", source: "ach-loop", plan: { verified: 1, total: 3 }, updatedAt: NOW }, launchedBy: "ORCHESTRATOR", costUsd: 0.1234 })] });
    await cmdLane(["status"], r.deps);
    assert.match(r.stdout(), /^NAME\s+STATE\s+AGENT\s+MODEL\s+PORT\s+QUEUE\s+GOAL\s+COST\s+BY\naudit\s+busy\s+opencode\s+ferry\/super-flash\s+4801\s+0\s+active 1\/3\s+\$0\.1234\s+ORCHESTRATOR\n$/);
  });
});

describe("lane status for an ended lane", () => {
  it("shows state stopped and the final goal state", async () => {
    const r = rig({ laneStatus: [row({ name: "LANE1", kind: "lane", state: "stopped", goalState: "achieved", launchedBy: "human", costUsd: null })] });
    await cmdLane(["status", "LANE1"], r.deps);
    assert.match(r.stdout(), /LANE1\s+stopped\s+opencode\s+ferry\/super-flash\s+4801\s+0\s+achieved\s+-\s+human\n$/);
  });
});

describe("desk costs: unknown stays a dash", () => {
  it("prints - for a null cost and never $0.0000", async () => {
    const rows = [{ name: "ORCH", kind: "desk", runId: "r", costUsd: null, inputTokens: 1200, outputTokens: 30, lanes: [{ name: "LANE1", kind: "lane", runId: "r2", costUsd: 0.5, inputTokens: 5, outputTokens: 6, lanes: [] }] }];
    const r = rig({ deskCosts: rows });
    assert.equal(await cmdDesk(["costs"], r.deps), 0);
    assert.match(r.stdout(), /ORCH\s+desk\s+1,200\s+30\s+-\n/);
    assert.doesNotMatch(r.stdout(), /\$0\.0000/);
  });
});

describe("--json prints exactly the service return value", () => {
  const cases: [string, string[], string[], unknown][] = [
    ["desk", ["up", "--json"], ["deskUp"], view()],
    ["desk", ["down", "--json"], ["deskDown"], { stopped: ["A"] }],
    ["desk", ["send", "W", "x", "--json"], ["deskSend"], msg()],
    ["desk", ["roster", "--json"], ["deskRoster"], view([row(), row({ name: "w", kind: "lane" })])],
    ["desk", ["inbox", "--json"], ["deskInbox"], [msg(), msg({ id: "m2" })]],
    ["desk", ["events", "W", "--json"], ["deskEvents"], [{ seq: 1, at: NOW, runId: "r", name: "W", type: "status", data: { state: "idle" } }]],
    ["desk", ["decisions", "--json"], ["decisionList"], [decision()]],
    ["desk", ["costs", "--json"], ["deskCosts"], [{ name: "A", kind: "desk", runId: "r", costUsd: null, inputTokens: 0, outputTokens: 0, lanes: [] }]],
    ["lane", ["status", "--json"], ["laneStatus"], [row({ name: "audit", kind: "lane" })]],
    ["lane", ["new", "x", "--goal", "g", "--json"], ["laneNew"], { pending: { id: "L1" } }],
  ];
  for (const [which, args, [fnName], ret] of cases) {
    it(`${which} ${args.join(" ")}`, async () => {
      const r = rig({ [fnName as string]: ret });
      const code = await (which === "desk" ? cmdDesk(args, r.deps) : cmdLane(args, r.deps));
      assert.equal(code, 0);
      assert.equal(r.stdout(), `${JSON.stringify(ret, null, 2)}\n`);
    });
  }
});

describe("usage and service errors", () => {
  const bad: [string, string[]][] = [
    ["desk", []],
    ["desk", ["bogus"]],
    ["desk", ["send"]],
    ["desk", ["send", "W"]],
    ["desk", ["up", "--term", "screen"]],
    ["desk", ["up", "--port-base", "abc"]],
    ["desk", ["up", "--nope"]],
    ["desk", ["up", "extra"]],
    ["desk", ["inbox", "--since", "soon"]],
    ["desk", ["inbox", "A", "B"]],
    ["desk", ["events"]],
    ["desk", ["answer", "D1"]],
    ["desk", ["decisions", "--state", "maybe"]],
    ["desk", ["close"]],
    ["desk", ["engine", "W"]],
    ["desk", ["chat"]],
    ["lane", []],
    ["lane", ["bogus"]],
    ["lane", ["new", "x"]],
    ["lane", ["new", "--goal", "g"]],
    ["lane", ["new", "x", "--goal", "g", "--budget-usd", "-1"]],
    ["lane", ["stop"]],
    ["lane", ["approve"]],
    ["lane", ["reject", "L1", "L2"]],
  ];
  for (const [which, args] of bad) {
    it(`${which} ${args.join(" ")} exits 2 without calling the service`, async () => {
      const r = rig();
      const code = await (which === "desk" ? cmdDesk(args, r.deps) : cmdLane(args, r.deps));
      assert.equal(code, 2);
      assert.equal(r.calls.length, 0);
      assert.ok(r.stderr().length > 0);
    });
  }
  it("--help prints usage on stdout", async () => {
    const r = rig();
    assert.equal(await cmdDesk(["--help"], r.deps), 0);
    assert.match(r.stdout(), /ach desk chat <name>/);
    const l = rig();
    assert.equal(await cmdLane(["new", "--help"], l.deps), 0);
    assert.match(l.stdout(), /ach lane new/);
  });
  it("a service throw prints `ach desk: <message>` and exits 1", async () => {
    const r = rig({}, { throws: "desks: no such desk 'W'" });
    assert.equal(await cmdDesk(["send", "W", "x"], r.deps), 1);
    assert.equal(r.stderr(), "ach desk: desks: no such desk 'W'\n");
    const l = rig({}, { throws: "boom" });
    assert.equal(await cmdLane(["stop", "x"], l.deps), 1);
    assert.equal(l.stderr(), "ach lane: boom\n");
  });
});

describe("parseSince", () => {
  it("durations, epoch ms, garbage", () => {
    assert.equal(parseSince("30s", NOW), NOW - 30_000);
    assert.equal(parseSince("2h", NOW), NOW - 7_200_000);
    assert.equal(parseSince("1d", NOW), NOW - 86_400_000);
    assert.equal(parseSince("1700000000000", NOW), 1_700_000_000_000);
    assert.throws(() => parseSince("yesterday", NOW));
  });
});

describe("roster rendering", () => {
  it("shows goal + plan, cost (tree for desks), pending lanes and open decisions", () => {
    const v = view(
      [
        row({ goalStatus: { objective: "o", state: "active", source: "ach-loop", plan: { verified: 2, total: 5 }, updatedAt: NOW }, queueDepth: 2, state: "busy" }),
        row({ name: "audit", kind: "lane", port: 4810, costUsd: null, treeCostUsd: null, state: "dead" }),
      ],
      {
        pendingLanes: [{ id: "L1", request: { name: "big", goal: "do a big thing", launchedBy: "WORKER" }, requestedAt: NOW, state: "pending" }],
        openDecisions: [decision()],
      },
    );
    const t = formatRoster(v);
    assert.match(t, /ORCHESTRATOR\s+desk\s+busy\s+opencode\s+ferry\/super-flash\s+4801\s+2\s+active 2\/5\s+\$1\.2500/);
    assert.match(t, /audit\s+lane\s+dead\s+opencode\s+ferry\/super-flash\s+4810\s+0\s+-\s+-/);
    assert.match(t, /pending lanes:\n {2}L1\s+big\s+by WORKER\s+do a big thing/);
    assert.match(t, /open decisions:\n {2}D1\s+from WORKER\s+Ship it\?/);
  });
});

const ev = (seq: number, type: HostEvent["type"], data: Record<string, unknown>): HostEvent => ({ seq, at: NOW, runId: "r", name: "W", type, data });

describe("chat event formatter", () => {
  it("assistant text, tool lines, status, errors", () => {
    assert.equal(formatChatEvent(ev(1, "text", { text: "  hello there \n" })), "hello there");
    assert.equal(formatChatEvent(ev(2, "text", { text: "   " })), null);
    assert.equal(formatChatEvent(ev(3, "tool", { tool: "bash", summary: "ls  -la" })), "  [tool] bash ls -la");
    assert.equal(formatChatEvent(ev(4, "status", { state: "busy" })), "  [status] busy");
    assert.equal(formatChatEvent(ev(5, "error", { error: "bad" })), "  [error] bad");
  });
  it("peer messages show; human messages only echo in the backlog", () => {
    const human = ev(6, "message_in", { message: { from: "human", text: "yo" } });
    assert.equal(formatChatEvent(human), null);
    assert.equal(formatChatEvent(human, { echoHuman: true }), "you> yo");
    assert.equal(formatChatEvent(ev(7, "message_in", { message: { from: "ORCH", text: "hi" } })), "  [from ORCH] hi");
    assert.equal(formatChatEvent(ev(8, "message_out", { message: { to: "ORCH", text: "ok" } })), "  [to ORCH] ok");
  });
  it("bookkeeping events produce nothing", () => {
    for (const t of ["turn_start", "turn_end", "usage", "goal", "feed"] as const) assert.equal(formatChatEvent(ev(9, t, {})), null);
  });
});

describe("desk chat REPL", () => {
  it("prints the backlog (last 50 lines), subscribes after the last seq, sends stdin lines as human, exits on EOF", async () => {
    const backlog: HostEvent[] = [];
    for (let i = 1; i <= 60; i++) backlog.push(ev(i, "text", { text: `line ${i}` }));
    const r = rig({ deskRoster: view([row({ name: "W", url: "http://127.0.0.1:4805" })]) }, { hostEvents: backlog });
    const done = cmdDesk(["chat", "W"], r.deps);
    await new Promise((res) => setTimeout(res, 50));
    assert.equal(r.subscribed.length, 1);
    assert.equal(r.subscribed[0]?.url, "http://127.0.0.1:4805");
    assert.equal(r.subscribed[0]?.since, 60);
    r.subscribed[0]?.cb(ev(61, "text", { text: "live reply" }));
    r.subscribed[0]?.cb(ev(62, "tool", { tool: "read", summary: "a.ts" }));
    r.stdin.write("hello agent\n\n  second  \n");
    r.stdin.end();
    assert.equal(await done, 0);
    const o = r.stdout();
    assert.ok(!o.includes("line 10\n"), "older than 50 is cut");
    assert.ok(o.includes("line 11\n") && o.includes("line 60\n"));
    assert.ok(o.indexOf("line 60") < o.indexOf("live reply"));
    assert.match(o, /\[tool\] read a\.ts/);
    assert.deepEqual(r.calls.filter((c) => c.fn === "deskSend").map((c) => c.args), [
      { from: "human", to: "W", text: "hello agent" },
      { from: "human", to: "W", text: "second" },
    ]);
    assert.equal(r.subscribed[0]?.stopped, true);
  });
  it("an unknown or dead target exits 1 with the known names", async () => {
    const r = rig({ deskRoster: view([row({ name: "A" })]) });
    assert.equal(await cmdDesk(["chat", "Z"], r.deps), 1);
    assert.match(r.stderr(), /^ach desk: unknown desk or lane 'Z' \(known: A\)/);
    const d = rig({ deskRoster: view([row({ name: "A", state: "dead" })]) });
    assert.equal(await cmdDesk(["chat", "A"], d.deps), 1);
    assert.match(d.stderr(), /dead/);
  });
});

describe("desk events --follow", () => {
  it("prints the backlog, subscribes after the last seq, stops on abort", async () => {
    const ac = new AbortController();
    const r = rig(
      { deskEvents: [ev(4, "text", { text: "old" })], deskRoster: view([row({ name: "W", url: "http://127.0.0.1:4805" })]) },
      { abort: ac.signal },
    );
    const done = cmdDesk(["events", "W", "--follow"], r.deps);
    await new Promise((res) => setTimeout(res, 50));
    assert.equal(r.subscribed[0]?.since, 4);
    r.subscribed[0]?.cb(ev(5, "status", { state: "busy" }));
    ac.abort();
    assert.equal(await done, 0);
    assert.match(r.stdout(), /text\s+old\n[^\n]*status\s+busy\n/);
    assert.equal(r.subscribed[0]?.stopped, true);
  });
});
