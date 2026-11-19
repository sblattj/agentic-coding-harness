// #204: desk MCP tools (src/mcp/tools-desks.ts) driven in-process through the real
// MCP server dispatch with a fake desks service recording every call.
import "./support/no-network.mjs";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMcpServer } from "../src/mcp/server.ts";
import { registerDeskTools, type DeskToolService } from "../src/mcp/tools-desks.ts";
import { registerHarnessTools } from "../src/mcp/register-tools.ts";

type Call = { fn: string; o: Record<string, unknown> };

function fakeService(calls: Call[], overrides: Partial<Record<string, () => unknown>> = {}): DeskToolService {
  const mk = (fn: string, ret: unknown) => async (o: Record<string, unknown> = {}) => {
    calls.push({ fn, o });
    const ov = overrides[fn];
    if (ov) return ov();
    return ret;
  };
  return {
    isApprover: ((o: { name: string }) => (overrides.isApprover ? (overrides.isApprover as any)(o) : o.name === "DECISIONS" || o.name === "human")) as unknown,
    deskRoster: mk("deskRoster", { version: "desks-api/1", stack: "default", rows: [] }),
    deskSend: mk("deskSend", { id: "m1", delivered: "now" }),
    deskInbox: mk("deskInbox", []),
    deskReload: mk("deskReload", [{ name: "X", ok: true, resumed: true }]),
    laneNew: mk("laneNew", { name: "x" }),
    laneStatus: mk("laneStatus", []),
    laneStop: mk("laneStop", { stopped: "x" }),
    laneApprove: mk("laneApprove", { name: "x" }),
    laneReject: mk("laneReject", { id: "L1", state: "rejected" }),
    decisionOpen: mk("decisionOpen", { id: "D1" }),
    decisionList: mk("decisionList", []),
    decisionClose: mk("decisionClose", { id: "D1", state: "closed" }),
  } as unknown as DeskToolService;
}

function setup(env: Record<string, string | undefined>, overrides: Partial<Record<string, () => unknown>> = {}) {
  const calls: Call[] = [];
  const server = createMcpServer({ name: "t", version: "0" });
  registerDeskTools(server, { stateDir: "/tmp/state-x" }, { service: fakeService(calls, overrides), env });
  let id = 0;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await server.dispatch({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } });
    return res!;
  };
  const list = async (): Promise<string[]> => {
    const res = await server.dispatch({ jsonrpc: "2.0", id: ++id, method: "tools/list" });
    return ((res!.result as { tools: { name: string }[] }).tools ?? []).map((t) => t.name);
  };
  const ok = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
    const res = await call(name, args);
    assert.equal(res.error, undefined, JSON.stringify(res.error));
    const text = (res.result as { content: { text: string }[] }).content[0]!.text;
    return JSON.parse(text);
  };
  return { calls, call, list, ok };
}

const DESK_ENV = { ACH_DESK_NAME: "ORCHESTRATOR", ACH_DESK_STACK: "s1" };
const ALL = [
  "desk_roster", "desk_send", "desk_inbox", "desk_reload", "lane_new", "lane_status", "lane_stop",
  "lane_approve", "lane_reject", "decision_open", "decision_list", "decision_close",
];

describe("desk MCP tools: registration gating", () => {
  it("registers nothing when ACH_DESK_NAME and ACH_DESK_TOOLS are unset", async () => {
    const t = setup({});
    assert.deepEqual(await t.list(), []);
  });
  it("registers nothing when ACH_DESK_TOOLS is not exactly 1", async () => {
    assert.deepEqual(await setup({ ACH_DESK_TOOLS: "0" }).list(), []);
  });
  it("registers every tool when ACH_DESK_NAME is set", async () => {
    assert.deepEqual((await setup(DESK_ENV).list()).sort(), [...ALL].sort());
  });
  it("registers every tool with ACH_DESK_TOOLS=1 alone, identity = human", async () => {
    const t = setup({ ACH_DESK_TOOLS: "1" });
    assert.deepEqual((await t.list()).sort(), [...ALL].sort());
    await t.ok("desk_send", { to: "ORCHESTRATOR", text: "hi" });
    assert.equal(t.calls[0]!.o.from, "human");
  });
  it("registerHarnessTools (production wiring) exposes desk tools only under the env gate", async () => {
    const saved = { n: process.env.ACH_DESK_NAME, t: process.env.ACH_DESK_TOOLS };
    try {
      delete process.env.ACH_DESK_NAME;
      delete process.env.ACH_DESK_TOOLS;
      const names = async () => {
        const s = createMcpServer({ name: "t", version: "0" });
        registerHarnessTools(s, { stateDir: "/tmp/state-x" });
        const r = await s.dispatch({ jsonrpc: "2.0", id: 1, method: "tools/list" });
        return (r!.result as { tools: { name: string }[] }).tools.map((x) => x.name);
      };
      assert.ok(!(await names()).includes("desk_roster"));
      process.env.ACH_DESK_NAME = "LISTENER";
      assert.ok((await names()).includes("desk_roster"));
    } finally {
      if (saved.n === undefined) delete process.env.ACH_DESK_NAME; else process.env.ACH_DESK_NAME = saved.n;
      if (saved.t === undefined) delete process.env.ACH_DESK_TOOLS; else process.env.ACH_DESK_TOOLS = saved.t;
    }
  });
});

describe("desk MCP tools: identity and argument mapping", () => {
  it("desk_roster passes me, stack and stateDir from env/opts", async () => {
    const t = setup(DESK_ENV);
    await t.ok("desk_roster");
    assert.deepEqual(t.calls[0], { fn: "deskRoster", o: { stateDir: "/tmp/state-x", stack: "s1", me: "ORCHESTRATOR" } });
  });

  it("desk_send sends from me; a `from` argument cannot spoof identity", async () => {
    const t = setup(DESK_ENV);
    await t.ok("desk_send", { to: "DECISIONS", text: "hello", from: "human" });
    assert.deepEqual(t.calls[0]!.o, { stateDir: "/tmp/state-x", stack: "s1", from: "ORCHESTRATOR", to: "DECISIONS", text: "hello" });
  });

  it("desk_send description says fire-and-forget, no polling, no ack-only messages", async () => {
    const server = createMcpServer({ name: "t", version: "0" });
    registerDeskTools(server, { stateDir: "/tmp/s" }, { service: fakeService([]), env: DESK_ENV });
    const r = await server.dispatch({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tool = (r!.result as { tools: { name: string; description: string }[] }).tools.find((x) => x.name === "desk_send")!;
    assert.match(tool.description, /do not wait/i);
    assert.match(tool.description, /poll/i);
    assert.match(tool.description, /ack-only/i);
  });

  it("desk_send to yourself is refused before the service is called", async () => {
    const t = setup(DESK_ENV);
    const res = await t.call("desk_send", { to: "ORCHESTRATOR", text: "x" });
    assert.match(res.error!.message, /yourself/);
    assert.equal(t.calls.length, 0);
  });

  it("desk_inbox maps limit and since_minutes to limit and an absolute sinceMs, for me", async () => {
    const t = setup(DESK_ENV);
    const before = Date.now();
    await t.ok("desk_inbox", { limit: 5, since_minutes: 10 });
    const o = t.calls[0]!.o as { name: string; limit: number; sinceMs: number };
    assert.equal(o.name, "ORCHESTRATOR");
    assert.equal(o.limit, 5);
    assert.ok(o.sinceMs >= before - 10 * 60_000 && o.sinceMs <= Date.now() - 10 * 60_000 + 5, `sinceMs ${o.sinceMs}`);
    await t.ok("desk_inbox", {});
    assert.deepEqual(Object.keys(t.calls[1]!.o).sort(), ["name", "stack", "stateDir"]);
  });

  it("lane_new maps every argument, launcher = me, budget_usd -> budgetUsd", async () => {
    const t = setup(DESK_ENV);
    const out = await t.ok("lane_new", {
      name: "fix-it", goal: "do it", mcps: ["a", "b"], cwd: "/w", agent: "claude", model: "m", budget_usd: 2.5, brief: "ctx",
    });
    assert.deepEqual(t.calls[0]!.o, {
      stateDir: "/tmp/state-x", stack: "s1", name: "fix-it", goal: "do it", launchedBy: "ORCHESTRATOR",
      mcps: ["a", "b"], cwd: "/w", agent: "claude", model: "m", budgetUsd: 2.5, brief: "ctx",
    });
    assert.equal(out.status, "started");
  });

  it("lane_new with only name+goal omits optional keys; a pending result says `pending L<n>`", async () => {
    const t = setup(DESK_ENV, {
      laneNew: () => ({ pending: { id: "L7", request: { name: "fix-it" }, state: "pending", requestedAt: 1 } }),
    });
    const out = await t.ok("lane_new", { name: "fix-it", goal: "g" });
    assert.deepEqual(Object.keys(t.calls[0]!.o).sort(), ["goal", "launchedBy", "name", "stack", "stateDir"]);
    assert.equal(out.status, "pending");
    assert.match(out.text, /^pending L7/);
  });

  it("lane_status and lane_stop pass name; lane_stop records me", async () => {
    const t = setup(DESK_ENV);
    await t.ok("lane_status", {});
    await t.ok("lane_status", { name: "x" });
    await t.ok("lane_stop", { name: "x" });
    assert.equal(t.calls[0]!.o.name, undefined);
    assert.equal(t.calls[1]!.o.name, "x");
    assert.deepEqual(t.calls[2], { fn: "laneStop", o: { stateDir: "/tmp/state-x", stack: "s1", name: "x", by: "ORCHESTRATOR" } });
    await t.ok("lane_stop", { name: "y", now: true });
    assert.deepEqual(t.calls[3], { fn: "laneStop", o: { stateDir: "/tmp/state-x", stack: "s1", name: "y", by: "ORCHESTRATOR", now: true } });
    assert.match((await t.call("lane_stop", { name: "y", now: "yes" })).error!.message, /now must be a boolean/);
  });

  it("decision_open: askedBy defaults to me, openedBy is me, options pass through", async () => {
    const t = setup({ ACH_DESK_NAME: "DECISIONS" });
    const options = [{ label: "A", recommended: true, reason: "cheap" }, { label: "B" }];
    await t.ok("decision_open", { question: "Q?", options });
    assert.deepEqual(t.calls[0]!.o, { stateDir: "/tmp/state-x", question: "Q?", options, askedBy: "DECISIONS", openedBy: "DECISIONS" });
    await t.ok("decision_open", { question: "Q2?", options, asked_by: "lane-1" });
    assert.equal(t.calls[1]!.o.askedBy, "lane-1");
    assert.equal(t.calls[1]!.o.openedBy, "DECISIONS");
  });

  it("decision_open rejects malformed options before the service is called", async () => {
    const t = setup(DESK_ENV);
    assert.match((await t.call("decision_open", { question: "Q", options: [] })).error!.message, /options/);
    assert.match((await t.call("decision_open", { question: "Q", options: [{ reason: "x" }] })).error!.message, /label/);
    assert.equal(t.calls.length, 0);
  });

  it("decision_list passes state; decision_close passes id, reason and me", async () => {
    const t = setup(DESK_ENV);
    await t.ok("decision_list", { state: "open" });
    await t.ok("decision_close", { id: "D3", reason: "moot" });
    assert.equal(t.calls[0]!.o.state, "open");
    assert.deepEqual(t.calls[1]!.o, { stateDir: "/tmp/state-x", stack: "s1", id: "D3", by: "ORCHESTRATOR", reason: "moot" });
    assert.match((await t.call("decision_list", { state: "bogus" })).error!.message, /state/);
  });
});

describe("desk MCP tools: approval gating", () => {
  it("a lane desk cannot approve or reject; the service is never called", async () => {
    const t = setup(DESK_ENV);
    const a = await t.call("lane_approve", { id: "L1" });
    const r = await t.call("lane_reject", { id: "L1", reason: "no" });
    assert.match(a.error!.message, /only the human or the decisions desk/);
    assert.match(r.error!.message, /only the human or the decisions desk/);
    assert.equal(t.calls.length, 0);
  });

  it("DECISIONS can approve and reject, with itself as decider", async () => {
    const t = setup({ ACH_DESK_NAME: "DECISIONS" });
    await t.ok("lane_approve", { id: "L1" });
    await t.ok("lane_reject", { id: "L2", reason: "dup" });
    assert.deepEqual(t.calls[0], { fn: "laneApprove", o: { stateDir: "/tmp/state-x", id: "L1", by: "DECISIONS" } });
    assert.deepEqual(t.calls[1], { fn: "laneReject", o: { stateDir: "/tmp/state-x", id: "L2", by: "DECISIONS", reason: "dup" } });
  });

  it("approval follows the service isApprover, not the literal name: a renamed decisions desk approves, a desk named DECISIONS without the role cannot", async () => {
    const yes = setup({ ACH_DESK_NAME: "JUDGE" }, { isApprover: () => true });
    await yes.ok("lane_approve", { id: "L1" });
    assert.equal(yes.calls[0]!.fn, "laneApprove");
    const no = setup({ ACH_DESK_NAME: "DECISIONS" }, { isApprover: () => false });
    const res = await no.call("lane_approve", { id: "L1" });
    assert.match(res.error!.message, /only the human or the decisions desk/);
    assert.equal(no.calls.length, 0);
  });

  it("the human (ACH_DESK_TOOLS=1) can approve", async () => {
    const t = setup({ ACH_DESK_TOOLS: "1" });
    await t.ok("lane_approve", { id: "L9" });
    assert.equal(t.calls[0]!.o.by, "human");
  });
});

describe("desk MCP tools: error mapping", () => {
  it("a service error becomes a JSON-RPC error carrying the message", async () => {
    const t = setup(DESK_ENV, {
      deskSend: () => { throw new Error("unknown desk 'NOPE'; known: DECISIONS, LISTENER"); },
    });
    const res = await t.call("desk_send", { to: "NOPE", text: "x" });
    assert.equal(res.result, undefined);
    assert.match(res.error!.message, /unknown desk 'NOPE'; known: DECISIONS, LISTENER/);
  });

  it("missing required arguments are errors, not service calls", async () => {
    const t = setup(DESK_ENV);
    assert.match((await t.call("desk_send", { to: "X" })).error!.message, /text is required/);
    assert.match((await t.call("lane_new", { name: "n" })).error!.message, /goal is required/);
    assert.match((await t.call("lane_stop", {})).error!.message, /name is required/);
    assert.equal(t.calls.length, 0);
  });
});

describe("desk_reload", () => {
  it("passes name, force and me as by; all: true reloads every desk via the service", async () => {
    const t = setup(DESK_ENV);
    const r = await t.ok("desk_reload", { name: "DECISIONS" });
    assert.deepEqual(r.results, [{ name: "X", ok: true, resumed: true }]);
    assert.deepEqual(t.calls.at(-1), { fn: "deskReload", o: { stateDir: "/tmp/state-x", stack: "s1", name: "DECISIONS", by: "ORCHESTRATOR" } });
    await t.ok("desk_reload", { name: "DECISIONS", force: true });
    assert.equal(t.calls.at(-1)!.o.force, true);
    await t.ok("desk_reload", { all: true });
    assert.deepEqual(t.calls.at(-1), { fn: "deskReload", o: { stateDir: "/tmp/state-x", stack: "s1", all: true, by: "ORCHESTRATOR" } });
  });
  it("refuses self, both or neither of name/all, and non-boolean flags, without calling the service", async () => {
    const t = setup(DESK_ENV);
    assert.match((await t.call("desk_reload", { name: "ORCHESTRATOR" })).error!.message, /cannot reload yourself/);
    assert.match((await t.call("desk_reload", {})).error!.message, /either name or all/);
    assert.match((await t.call("desk_reload", { name: "DECISIONS", all: true })).error!.message, /either name or all/);
    assert.match((await t.call("desk_reload", { name: "DECISIONS", force: "yes" })).error!.message, /force must be a boolean/);
    assert.match((await t.call("desk_reload", { all: "yes" })).error!.message, /all must be a boolean/);
    assert.equal(t.calls.filter((c) => c.fn === "deskReload").length, 0);
  });
});
