// OpenCodeEngine (#204): unit tests against a fake opencode HTTP server, plus a live test
// against a real `opencode serve` (ACH_DESKS_LIVE=1).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import {
  OpenCodeEngine,
  buildOpencodeConfig,
  configuredMcpNames,
  parseJsonc,
  portIsOpen,
  rolePrompt,
  splitModel,
  type ServeProcess,
  type SpawnServe,
} from "../src/desks/engines/opencode.ts";
import type { EngineEvent, GoalStatus, HostSpec } from "../src/desks/types.ts";

const tmpRoots: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}
after(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 3000, what = "condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

// ------------------------------------------------------------------ fake opencode

interface Rec {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

const allFakes: FakeOpencode[] = [];
after(async () => {
  // a failed test must not leave a listener that keeps the runner alive
  for (const f of allFakes) if (f.server.listening) await f.close();
});

class FakeOpencode {
  server: Server;
  port = 0;
  reqs: Rec[] = [];
  mcp: Record<string, { status: string }> = { desks: { status: "connected" } };
  status: Record<string, { type: string }> = {};
  messages: unknown[] = [];
  sse: ServerResponse[] = [];
  sessionId = "ses_fake1";

  messageDelayMs = 0;
  failPrompt = false;

  constructor() {
    this.server = createServer((req, res) => void this.handle(req, res));
    allFakes.push(this);
  }
  /** Reserve a free port (listen on :0, then close): the engine refuses a port that is already listening, so the fake spawn opens it. */
  async listen(): Promise<number> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as AddressInfo).port;
    await new Promise<void>((r) => this.server.close(() => r()));
    return this.port;
  }
  open(port = this.port): void {
    this.port = port;
    this.server.listen(port, "127.0.0.1");
  }
  async close(): Promise<void> {
    for (const s of this.sse) s.end();
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
  /** Push one opencode bus event to every SSE subscriber. */
  push(type: string, properties: Record<string, unknown>): void {
    for (const s of this.sse) s.write(`data: ${JSON.stringify({ id: `evt_${Math.random()}`, type, properties })}\n\n`);
  }
  of(method: string, pathname: string): Rec[] {
    return this.reqs.filter((r) => r.method === method && r.path === pathname);
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    let raw = "";
    for await (const c of req) raw += c;
    const body = raw === "" ? undefined : (JSON.parse(raw) as unknown);
    this.reqs.push({ method: req.method ?? "", path: url.pathname, query: url.searchParams, body });
    const json = (code: number, v: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(v));
    };
    const sid = this.sessionId;
    if (req.method === "GET" && url.pathname === "/session") return json(200, []);
    if (req.method === "GET" && url.pathname === "/mcp") return json(200, this.mcp);
    if (req.method === "POST" && url.pathname === "/session") return json(200, { id: sid, title: (body as { title?: string }).title });
    if (req.method === "GET" && url.pathname === "/session/status") return json(200, this.status);
    if (req.method === "POST" && url.pathname === `/session/${sid}/message`) return json(200, { info: { id: "msg_note", role: "user" }, parts: [] });
    if (req.method === "GET" && url.pathname === `/session/${sid}/message`) {
      if (this.messageDelayMs > 0) await sleep(this.messageDelayMs);
      return json(200, this.messages);
    }
    if (req.method === "POST" && url.pathname === `/session/${sid}/prompt_async`) {
      if (this.failPrompt) return json(500, { error: "prompt refused" });
      res.writeHead(204);
      return void res.end();
    }
    if (req.method === "POST" && url.pathname === `/session/${sid}/abort`) return json(200, true);
    if (req.method === "GET" && url.pathname === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
      this.sse.push(res);
      return;
    }
    json(404, { error: "not found" });
  }
}

interface SpawnCall {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logFile: string;
  signals: string[];
}

/** A spawn seam whose "process" is the fake server: TERM closes it. `onSpawn` can adjust the fake per boot. */
function fakeSpawn(fake: FakeOpencode, calls: SpawnCall[], onSpawn?: (n: number) => void): SpawnServe {
  return (o) => {
    const call: SpawnCall = { ...o, signals: [] };
    calls.push(call);
    onSpawn?.(calls.length);
    fake.open();
    let resolveExit!: (c: number | string | null) => void;
    const exited = new Promise<number | string | null>((r) => (resolveExit = r));
    const p: ServeProcess = {
      pid: 4242 + calls.length,
      kill(sig) {
        call.signals.push(sig);
        if (sig === "SIGTERM" || sig === "SIGKILL") {
          // Leak-restart path: reopen on the same port for the next boot.
          void fake.close().then(() => resolveExit(sig));
        }
      },
      exited,
    };
    return p;
  };
}

/** Wrap a spawn seam to count serves that were spawned and have not exited. */
function liveCounter(inner: SpawnServe): { spawn: SpawnServe; live: () => number } {
  let live = 0;
  return {
    live: () => live,
    spawn: (o) => {
      const p = inner(o);
      live++;
      void p.exited.then(() => live--);
      return p;
    },
  };
}

function setup(o:{ mcps?: string[]; model?: string; leakFirstBoot?: string } = {}) {
  const home = tmp("ach-oce-home-");
  const cwd = tmp("ach-oce-cwd-");
  const stateDir = tmp("ach-oce-state-");
  mkdirSync(join(home, ".config", "opencode"), { recursive: true });
  writeFileSync(
    join(home, ".config", "opencode", "opencode.jsonc"),
    `{
  // user's global config (JSONC)
  "model": "ferry/heavy", /* block comment */
  "mcp": {
    "timeout": { "startup": 5000 },
    "toolbox": { "type": "remote", "url": "http://x//y", "enabled": true },
    "whosaid": { "type": "local", "command": ["whosaid", "mcp"] },
  },
}`,
  );
  writeFileSync(join(cwd, "opencode.json"), JSON.stringify({ mcp: { projectmcp: { type: "local", command: ["p"] } } }));
  const roleA = join(cwd, "common.md");
  const roleB = join(cwd, "role.md");
  writeFileSync(roleA, "You are $DESK_NAME.\n");
  writeFileSync(roleB, "Role body for $DESK_NAME.\n");
  const env: NodeJS.ProcessEnv = { HOME: home, PATH: process.env.PATH, ACH_SELF_ARGV: JSON.stringify(["/opt/ach/bin/node", "/opt/ach/ach.js"]) };
  const spec: HostSpec = {
    stack: "t1",
    stateDir,
    name: "ORCH",
    kind: "desk",
    role: "orchestrator",
    roleFiles: [roleA, roleB],
    agent: "opencode",
    engine: "opencode",
    model: o.model,
    mcps: o.mcps ?? ["whosaid", "extra"],
    mcpServers: { extra: { command: "extra-mcp", args: ["--stdio"], env: { TOKEN_ENV: "x" } } },
    port: 4801,
    cwd,
    runId: "run_test",
  };
  return { home, cwd, stateDir, env, spec };
}

// ------------------------------------------------------------------ unit

describe("opencode engine helpers", () => {
  it("parseJsonc strips comments and trailing commas but keeps // inside strings", () => {
    assert.deepEqual(parseJsonc('{ "a": "http://x", // c\n "b": [1,2,], /* d */ }'), { a: "http://x", b: [1, 2] });
  });

  it("splitModel splits at the first slash", () => {
    assert.deepEqual(splitModel("ferry/super-flash"), { providerID: "ferry", modelID: "super-flash" });
    assert.deepEqual(splitModel("openrouter/google/gemini"), { providerID: "openrouter", modelID: "google/gemini" });
    assert.equal(splitModel(undefined), undefined);
    assert.throws(() => splitModel("nomodel"), /provider\/model/);
  });

  it("configuredMcpNames unions global JSONC + project config, skipping reserved keys", () => {
    const { cwd, env } = setup();
    assert.deepEqual(configuredMcpNames(cwd, env), ["projectmcp", "toolbox", "whosaid"]);
  });

  it("buildOpencodeConfig disables every other configured MCP, enables wanted, adds local defs and desks", () => {
    const { cwd, env, spec } = setup();
    const cfg = buildOpencodeConfig(spec, { configured: configuredMcpNames(cwd, env), env }) as { mcp: Record<string, unknown> };
    assert.deepEqual(cfg.mcp.toolbox, { enabled: false });
    assert.deepEqual(cfg.mcp.projectmcp, { enabled: false });
    assert.deepEqual(cfg.mcp.whosaid, { enabled: true });
    assert.deepEqual(cfg.mcp.extra, { type: "local", command: ["extra-mcp", "--stdio"], enabled: true, environment: { TOKEN_ENV: "x" } });
    assert.deepEqual(cfg.mcp.desks, {
      type: "local",
      command: ["/opt/ach/bin/node", "/opt/ach/ach.js", "mcp"],
      enabled: true,
      environment: { ACH_DESK_NAME: "ORCH", ACH_DESK_STACK: "t1", AGENTIC_CODING_HARNESS_STATE_DIR: spec.stateDir },
    });
    assert.equal("timeout" in cfg.mcp, false);
  });

  it("rolePrompt joins role files and replaces every $DESK_NAME", () => {
    const { spec } = setup();
    assert.equal(rolePrompt(spec), "You are ORCH.\n\nRole body for ORCH.");
  });
});

describe("OpenCodeEngine against a fake opencode serve", () => {
  it("start: spawns serve with per-desk config, creates the session, sends the role prompt as a noReply note", async () => {
    const fake = new FakeOpencode();
    const port = await fake.listen();
    const { env, spec, cwd } = setup({ model: "ferry/super-flash" });
    spec.enginePort = port;
    const calls: SpawnCall[] = [];
    const eng = new OpenCodeEngine({ env, spawn: fakeSpawn(fake, calls), stopGraceMs: 500 });
    try {
      const r = await eng.start(spec);
      assert.deepEqual(r, { sessionId: "ses_fake1", engineUrl: `http://127.0.0.1:${port}`, childPid: 4243 });
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.bin, "opencode");
      assert.deepEqual(calls[0]!.args, ["serve", "--hostname", "127.0.0.1", "--port", String(port)]);
      assert.equal(calls[0]!.cwd, cwd);
      assert.equal(calls[0]!.env.DESK_NAME, "ORCH");
      assert.match(calls[0]!.logFile, /desks\/t1\/logs\/ORCH\.opencode\.log$/);
      const cfg = JSON.parse(calls[0]!.env.OPENCODE_CONFIG_CONTENT!) as { mcp: Record<string, { enabled: boolean; environment?: Record<string, string> }> };
      assert.equal(cfg.mcp.toolbox!.enabled, false);
      assert.equal(cfg.mcp.projectmcp!.enabled, false);
      assert.equal(cfg.mcp.whosaid!.enabled, true);
      assert.equal(cfg.mcp.desks!.environment!.ACH_DESK_NAME, "ORCH");

      const created = fake.of("POST", "/session");
      assert.equal(created.length, 1);
      assert.equal(created[0]!.query.get("directory"), cwd);
      assert.deepEqual(created[0]!.body, { title: "ORCH" });

      const notes = fake.of("POST", "/session/ses_fake1/message");
      assert.equal(notes.length, 1);
      assert.deepEqual(notes[0]!.body, {
        noReply: true,
        model: { providerID: "ferry", modelID: "super-flash" },
        parts: [{ type: "text", text: "You are ORCH.\n\nRole body for ORCH." }],
      });
      assert.deepEqual(eng.attachCommand(), ["opencode", "attach", `http://127.0.0.1:${port}`, "--session", "ses_fake1"]);
      assert.deepEqual(await eng.mcpStatus(), { desks: "connected" });
    } finally {
      await eng.stop();
    }
  });

  it("start: a serve that dies on \"database is locked\" is re-booted, and no engine error event is emitted", async () => {
    const fake = new FakeOpencode();
    const port = await fake.listen();
    const { env, spec } = setup({ model: "ferry/super-flash" });
    spec.enginePort = port;
    const calls: SpawnCall[] = [];
    const normal = fakeSpawn(fake, calls);
    let spawns = 0;
    // First boot: the real failure seen live when two desks start at once (opencode's shared SQLite).
    const lockedOnce: SpawnServe = (o) => {
      spawns++;
      if (spawns > 1) return normal(o);
      mkdirSync(dirname(o.logFile), { recursive: true });
      writeFileSync(o.logFile, "Error: Unexpected error\n\ndatabase is locked\n");
      return { pid: 999, kill() {}, exited: Promise.resolve(1) };
    };
    const eng = new OpenCodeEngine({ env, spawn: lockedOnce, stopGraceMs: 500, lockRetryDelayMs: 10 });
    const events: EngineEvent[] = [];
    eng.onEvent((e) => events.push(e));
    try {
      const r = await eng.start(spec);
      assert.equal(r.sessionId, "ses_fake1");
      assert.equal(spawns, 2, "one failed boot, one good boot");
      assert.deepEqual(events.filter((e) => e.type === "error"), []);
    } finally {
      await eng.stop();
    }
  });

  it("start: a serve that dies for another reason is not retried", async () => {
    const { env, spec } = setup();
    spec.enginePort = 1; // never probed: the process exits first
    let spawns = 0;
    const dies: SpawnServe = (o) => {
      spawns++;
      mkdirSync(dirname(o.logFile), { recursive: true });
      writeFileSync(o.logFile, "Error: bad config\n");
      return { pid: 999, kill() {}, exited: Promise.resolve(1) };
    };
    const eng = new OpenCodeEngine({ env, spawn: dies, stopGraceMs: 500, lockRetryDelayMs: 10 });
    await assert.rejects(eng.start(spec), /exited \(1\) before ready[\s\S]*bad config/);
    assert.equal(spawns, 1);
  });

  it("note and send: noReply message vs prompt_async with the split model; state() follows /session/status", async () => {
    const fake = new FakeOpencode();
    const port = await fake.listen();
    const { env, spec } = setup({ model: "ferry/super-flash" });
    spec.enginePort = port;
    const eng = new OpenCodeEngine({ env, spawn: fakeSpawn(fake, []), stopGraceMs: 500 });
    try {
      await eng.start(spec);
      await eng.note("silent context");
      const notes = fake.of("POST", "/session/ses_fake1/message");
      assert.deepEqual((notes[1]!.body as { noReply: boolean; parts: unknown }).noReply, true);
      assert.deepEqual((notes[1]!.body as { parts: unknown }).parts, [{ type: "text", text: "silent context" }]);
      assert.equal(fake.of("POST", "/session/ses_fake1/prompt_async").length, 0, "note must not start a turn");

      await eng.send("[desk-msg from TEST] hi");
      const p = fake.of("POST", "/session/ses_fake1/prompt_async");
      assert.equal(p.length, 1);
      assert.deepEqual(p[0]!.body, { model: { providerID: "ferry", modelID: "super-flash" }, parts: [{ type: "text", text: "[desk-msg from TEST] hi" }] });
      // prompt_async returned but status has not flipped yet: the send latch reports busy.
      assert.equal(await eng.state(), "busy");
      fake.status = { ses_other: { type: "idle" }, ses_fake1: { type: "busy" } };
      assert.equal(await eng.state(), "busy");
      fake.status = { ses_other: { type: "busy" } };
      assert.equal(await eng.state(), "idle", "only OUR session's entry counts, and engine busy clears the latch");
    } finally {
      await eng.stop();
    }
  });

  it("send omits model when spec.model is unset", async () => {
    const fake = new FakeOpencode();
    const port = await fake.listen();
    const { env, spec } = setup();
    spec.enginePort = port;
    const eng = new OpenCodeEngine({ env, spawn: fakeSpawn(fake, []), stopGraceMs: 500 });
    try {
      await eng.start(spec);
      await eng.send("x");
      assert.deepEqual(fake.of("POST", "/session/ses_fake1/prompt_async")[0]!.body, { parts: [{ type: "text", text: "x" }] });
      assert.equal("model" in (fake.of("POST", "/session/ses_fake1/message")[0]!.body as object), false);
    } finally {
      await eng.stop();
    }
  });

  it("events: SSE -> turn_start/text/tool/usage/turn_end for our session only, user parts and duplicates dropped", async () => {
    const fake = new FakeOpencode();
    const port = await fake.listen();
    const { env, spec } = setup({ model: "ferry/super-flash" });
    spec.enginePort = port;
    const eng = new OpenCodeEngine({ env, spawn: fakeSpawn(fake, []), stopGraceMs: 500 });
    const events: EngineEvent[] = [];
    eng.onEvent((e) => events.push(e));
    try {
      await eng.start(spec);
      await until(() => fake.sse.length > 0, 3000, "SSE subscriber");
      assert.equal(fake.of("GET", "/event")[0]!.query.get("directory"), spec.cwd);
      const S = "ses_fake1";
      const stepFinish = { id: "prt_sf", messageID: "msg_a", sessionID: S, type: "step-finish", cost: 0, tokens: { input: 100, output: 6, reasoning: 3, cache: { read: 7, write: 1 } } };
      const textPart = { id: "prt_t", messageID: "msg_a", sessionID: S, type: "text", text: "PONG", time: { start: 1, end: 2 } };
      const toolDone = { id: "prt_tool", messageID: "msg_a", sessionID: S, type: "tool", tool: "bash", callID: "c1", state: { status: "completed", input: { command: "ls" } } };
      fake.push("message.updated", { sessionID: S, info: { id: "msg_u", role: "user", sessionID: S } });
      fake.push("message.part.updated", { sessionID: S, part: { id: "prt_u", messageID: "msg_u", sessionID: S, type: "text", text: "[desk-msg from TEST] hi" } });
      fake.push("session.status", { sessionID: S, status: { type: "busy" } });
      fake.push("session.status", { sessionID: S, status: { type: "busy" } });
      fake.push("session.status", { sessionID: "ses_other", status: { type: "idle" } });
      fake.push("message.updated", { sessionID: S, info: { id: "msg_a", role: "assistant", sessionID: S, providerID: "ferry", modelID: "super-flash" } });
      fake.push("message.part.updated", { sessionID: S, part: { ...toolDone, state: { status: "running", input: { command: "ls" } } } });
      fake.push("message.part.updated", { sessionID: S, part: toolDone });
      fake.push("message.part.updated", { sessionID: S, part: { ...textPart, text: "PO", time: { start: 1 } } });
      fake.push("message.part.updated", { sessionID: S, part: textPart });
      fake.push("message.part.updated", { sessionID: S, part: stepFinish });
      fake.push("message.part.updated", { sessionID: "ses_other", part: { ...textPart, id: "prt_x", sessionID: "ses_other" } });
      // the reconcile list repeats every part: nothing may be emitted twice; a part the stream missed is caught here
      fake.messages = [
        { info: { id: "msg_u", role: "user" }, parts: [{ id: "prt_u", type: "text", text: "[desk-msg from TEST] hi" }] },
        {
          info: { id: "msg_a", role: "assistant", providerID: "ferry", modelID: "super-flash", time: { created: 1, completed: 9 } },
          parts: [toolDone, textPart, { id: "prt_t2", messageID: "msg_a", type: "text", text: "missed by stream" }, stepFinish],
        },
      ];
      fake.push("session.status", { sessionID: S, status: { type: "idle" } });
      fake.push("session.idle", { sessionID: S });
      fake.push("session.error", { sessionID: S, error: { name: "MessageAbortedError", data: { message: "Aborted" } } });
      await until(() => events.some((e) => e.type === "turn_end") && events.some((e) => e.type === "error"), 3000, "turn_end + error");
      const types = events.map((e) => e.type);
      assert.deepEqual(types.filter((t) => t !== "error"), ["turn_start", "tool", "text", "usage", "text", "turn_end"]);
      assert.deepEqual(events.find((e) => e.type === "tool")!.data, { tool: "bash", summary: '{"command":"ls"}', status: "completed", callId: "c1" });
      assert.deepEqual(events.filter((e) => e.type === "text").map((e) => e.data.text), ["PONG", "missed by stream"]);
      assert.deepEqual(events.find((e) => e.type === "usage")!.data, {
        inputTokens: 100,
        outputTokens: 6,
        reasoningTokens: 3,
        cacheReadTokens: 7,
        cacheWriteTokens: 1,
        costUsd: null,
        providerID: "ferry",
        modelID: "super-flash",
        messageId: "prt_sf",
        model: "ferry/super-flash",
      });
      assert.equal(events.find((e) => e.type === "error")!.data.error, "Aborted");
    } finally {
      await eng.stop();
    }
  });

  it("usage carries a positive opencode cost as costUsd", async () => {
    const fake = new FakeOpencode();
    const port = await fake.listen();
    const { env, spec } = setup();
    spec.enginePort = port;
    const eng = new OpenCodeEngine({ env, spawn: fakeSpawn(fake, []), stopGraceMs: 500 });
    const events: EngineEvent[] = [];
    eng.onEvent((e) => events.push(e));
    try {
      await eng.start(spec);
      eng.handleEvent({ type: "message.updated", properties: { sessionID: "ses_fake1", info: { id: "m1", role: "assistant", sessionID: "ses_fake1" } } });
      eng.handleEvent({ type: "message.part.updated", properties: { sessionID: "ses_fake1", part: { id: "s1", messageID: "m1", sessionID: "ses_fake1", type: "step-finish", cost: 0.0123, tokens: { input: 1, output: 2 } } } });
      assert.equal(events.find((e) => e.type === "usage")!.data.costUsd, 0.0123);
      // A second step of the SAME message is a separate delta: its usage event needs its own id,
      // or the host meter would replace the first step's tokens instead of adding to them.
      eng.handleEvent({ type: "message.part.updated", properties: { sessionID: "ses_fake1", part: { id: "s2", messageID: "m1", sessionID: "ses_fake1", type: "step-finish", cost: 0, tokens: { input: 5, output: 7 } } } });
      const usage = events.filter((e) => e.type === "usage");
      assert.equal(usage.length, 2);
      assert.deepEqual(usage.map((e) => e.data.messageId), ["s1", "s2"]);
    } finally {
      await eng.stop();
    }
  });

  it("a stale idle right after send() does not end the turn early", async () => {
    const fake = new FakeOpencode();
    const port = await fake.listen();
    const { env, spec } = setup();
    spec.enginePort = port;
    const eng = new OpenCodeEngine({ env, spawn: fakeSpawn(fake, []), stopGraceMs: 500 });
    const events: EngineEvent[] = [];
    eng.onEvent((e) => events.push(e));
    try {
      await eng.start(spec);
      await eng.send("go");
      eng.handleEvent({ type: "session.idle", properties: { sessionID: "ses_fake1" } });
      await sleep(50);
      assert.deepEqual(events.map((e) => e.type), ["turn_start"]);
      eng.handleEvent({ type: "session.status", properties: { sessionID: "ses_fake1", status: { type: "busy" } } });
      eng.handleEvent({ type: "session.status", properties: { sessionID: "ses_fake1", status: { type: "idle" } } });
      await until(() => events.some((e) => e.type === "turn_end"), 2000, "turn_end");
      assert.deepEqual(events.map((e) => e.type), ["turn_start", "turn_end"]);
    } finally {
      await eng.stop();
    }
  });

  it("several idle signals per turn yield ONE turn_end; a turn started during the transition is not ended by leftovers", async () => {
    const fake = new FakeOpencode();
    const port = await fake.listen();
    const { env, spec } = setup();
    spec.enginePort = port;
    fake.messageDelayMs = 80;
    const eng = new OpenCodeEngine({ env, spawn: fakeSpawn(fake, []), stopGraceMs: 500 });
    const events: EngineEvent[] = [];
    eng.onEvent((e) => events.push(e));
    const S = "ses_fake1";
    try {
      await eng.start(spec);
      eng.handleEvent({ type: "session.status", properties: { sessionID: S, status: { type: "busy" } } });
      eng.handleEvent({ type: "session.status", properties: { sessionID: S, status: { type: "idle" } } });
      eng.handleEvent({ type: "session.idle", properties: { sessionID: S } });
      eng.handleEvent({ type: "session.status", properties: { sessionID: S, status: { type: "idle" } } });
      // the host sends the next queued message while the first transition is still reconciling
      await eng.send("next");
      eng.handleEvent({ type: "session.status", properties: { sessionID: S, status: { type: "busy" } } });
      await sleep(400);
      assert.deepEqual(events.map((e) => e.type), ["turn_start", "turn_end", "turn_start"]);
      eng.handleEvent({ type: "session.status", properties: { sessionID: S, status: { type: "idle" } } });
      eng.handleEvent({ type: "session.idle", properties: { sessionID: S } });
      await until(() => events.length === 4, 2000, "second turn_end");
      await sleep(200);
      assert.deepEqual(events.map((e) => e.type), ["turn_start", "turn_end", "turn_start", "turn_end"]);
    } finally {
      await eng.stop();
    }
  });

  it("reconcile does not emit a text part of an unfinished message", async () => {
    const fake = new FakeOpencode();
    const port = await fake.listen();
    const { env, spec } = setup();
    spec.enginePort = port;
    const eng = new OpenCodeEngine({ env, spawn: fakeSpawn(fake, []), stopGraceMs: 500 });
    const events: EngineEvent[] = [];
    eng.onEvent((e) => events.push(e));
    const S = "ses_fake1";
    try {
      await eng.start(spec);
      fake.messages = [{ info: { id: "m1", role: "assistant" }, parts: [{ id: "p1", type: "text", text: "PAR" }] }];
      eng.handleEvent({ type: "session.status", properties: { sessionID: S, status: { type: "busy" } } });
      eng.handleEvent({ type: "session.idle", properties: { sessionID: S } });
      await until(() => events.some((e) => e.type === "turn_end"), 2000, "turn_end");
      assert.equal(events.filter((e) => e.type === "text").length, 0);
      fake.messages = [{ info: { id: "m1", role: "assistant", time: { completed: 5 } }, parts: [{ id: "p1", type: "text", text: "PARTIAL DONE" }] }];
      eng.handleEvent({ type: "session.status", properties: { sessionID: S, status: { type: "busy" } } });
      eng.handleEvent({ type: "session.idle", properties: { sessionID: S } });
      await until(() => events.filter((e) => e.type === "turn_end").length === 2, 2000, "turn_end 2");
      assert.deepEqual(events.filter((e) => e.type === "text").map((e) => e.data.text), ["PARTIAL DONE"]);
    } finally {
      await eng.stop();
    }
  });

  it("start restarts once with leaked MCPs force-disabled, then fails if they still leak", async () => {
    const fake = new FakeOpencode();
    const port = await fake.listen();
    const { env, spec } = setup();
    spec.enginePort = port;
    let fake2: FakeOpencode | undefined;
    const calls: SpawnCall[] = [];
    // boot 1 reports a leaked "hidden" MCP; boot 2 (after TERM closed fake 1) is served by a fresh fake on the same port.
    fake.mcp = { desks: { status: "connected" }, whosaid: { status: "connected" }, hidden: { status: "connected" }, toolbox: { status: "disabled" } };
    const spawn: SpawnServe = (o) => {
      if (calls.length === 0) return fakeSpawn(fake, calls)(o);
      fake2 = new FakeOpencode();
      fake2.port = port;
      return fakeSpawn(fake2, calls)(o);
    };
    const eng = new OpenCodeEngine({ env, spawn, stopGraceMs: 500 });
    try {
      await eng.start(spec);
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[0]!.signals, ["SIGTERM"]);
      const cfg2 = JSON.parse(calls[1]!.env.OPENCODE_CONFIG_CONTENT!) as { mcp: Record<string, { enabled: boolean }> };
      assert.deepEqual(cfg2.mcp.hidden, { enabled: false });
      assert.equal(fake.of("POST", "/session").length, 0, "no session on the leaking boot");
      assert.equal(fake2!.of("POST", "/session").length, 1);
    } finally {
      await eng.stop();
    }

    const fake3 = new FakeOpencode();
    const port3 = await fake3.listen();
    fake3.mcp = { desks: { status: "connected" }, hidden: { status: "connected" } };
    const s3 = setup();
    s3.spec.enginePort = port3;
    let n = 0;
    const always: SpawnServe = (o) => {
      n++;
      if (n === 1) return fakeSpawn(fake3, [])(o);
      const f = new FakeOpencode();
      f.mcp = fake3.mcp;
      f.port = port3;
      return fakeSpawn(f, [])(o);
    };
    const eng3 = new OpenCodeEngine({ env: s3.env, spawn: always, stopGraceMs: 500 });
    await assert.rejects(eng3.start(s3.spec), /still enables MCPs .*hidden/);
    assert.equal(await portIsOpen(port3), false, "failed start leaves no serve behind");
    await eng3.stop();
  });

  it("start fails fast with the log tail when serve exits before ready", async () => {
    const { env, spec, stateDir } = setup();
    spec.enginePort = await new FakeOpencode().listen();
    const logDir = join(stateDir, "desks", "t1", "logs");
    const spawn: SpawnServe = (o) => {
      mkdirSync(logDir, { recursive: true });
      writeFileSync(o.logFile, "boom: bad config\n");
      return { pid: 1, kill() {}, exited: Promise.resolve(1) };
    };
    const eng = new OpenCodeEngine({ env, spawn });
    await assert.rejects(eng.start(spec), /exited \(1\) before ready[\s\S]*boom: bad config/);
    await eng.stop();
  });

  it("start refuses a port that is already listening", async () => {
    const fake = new FakeOpencode();
    const port = await fake.listen();
    fake.open();
    await until(() => fake.server.listening, 2000, "listening");
    const { env, spec } = setup();
    spec.enginePort = port;
    let spawned = 0;
    const eng = new OpenCodeEngine({
      env,
      spawn: () => {
        spawned++;
        throw new Error("must not spawn");
      },
    });
    await assert.rejects(eng.start(spec), /already in use/);
    assert.equal(spawned, 0);
    await fake.close();
  });

  it("setGoal/goalStatus delegate to the goals bridge with this session", async () => {
    const fake = new FakeOpencode();
    const port = await fake.listen();
    const { env, spec } = setup({ model: "ferry/super-flash" });
    spec.enginePort = port;
    const seen: unknown[] = [];
    const status: GoalStatus = { objective: "do x", state: "active", source: "opencode-plugin", updatedAt: 1 };
    const eng = new OpenCodeEngine({
      env,
      spawn: fakeSpawn(fake, []),
      stopGraceMs: 500,
      goalTimeoutMs: 1234,
      goals: {
        setOpencodeGoal: async (o) => void seen.push(["set", o]),
        readOpencodeGoal: (o) => (seen.push(["read", o]), status),
      },
    });
    try {
      await eng.start(spec);
      await eng.setGoal("do x");
      assert.deepEqual(await eng.goalStatus(), status);
      assert.deepEqual(seen, [
        ["set", { baseUrl: `http://127.0.0.1:${port}`, sessionId: "ses_fake1", objective: "do x", model: "ferry/super-flash", timeoutMs: 1234 }],
        ["read", { dir: spec.cwd, sessionId: "ses_fake1", objective: "do x" }],
      ]);
    } finally {
      await eng.stop();
    }
  });

  it("stop: aborts a running turn, TERMs serve, waits for the port to free; idempotent", async () => {
    const fake = new FakeOpencode();
    const port = await fake.listen();
    const { env, spec } = setup();
    spec.enginePort = port;
    const calls: SpawnCall[] = [];
    const eng = new OpenCodeEngine({ env, spawn: fakeSpawn(fake, calls), stopGraceMs: 500 });
    await eng.start(spec);
    fake.status = { ses_fake1: { type: "busy" } };
    await eng.stop();
    await eng.stop();
    assert.equal(fake.of("POST", "/session/ses_fake1/abort").length, 1);
    assert.deepEqual(calls[0]!.signals, ["SIGTERM"]);
    assert.equal(await portIsOpen(port), false);
  });

  it("stop: KILLs after the grace when TERM is ignored", async () => {
    const fake = new FakeOpencode();
    const port = await fake.listen();
    const { env, spec } = setup();
    spec.enginePort = port;
    const signals: string[] = [];
    let resolveExit!: (c: string) => void;
    const spawn: SpawnServe = () => (fake.open(), {
      pid: 7,
      kill(sig) {
        signals.push(sig);
        if (sig === "SIGKILL") void fake.close().then(() => resolveExit(sig));
      },
      exited: new Promise((r) => (resolveExit = r)),
    });
    const eng = new OpenCodeEngine({ env, spawn, stopGraceMs: 200 });
    await eng.start(spec);
    await eng.stop();
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(await portIsOpen(port), false);
  });

  it("stop() during the lock-retry sleep: start rejects, no serve is respawned", async () => {
    const fake = new FakeOpencode();
    const port = await fake.listen();
    const { env, spec } = setup();
    spec.enginePort = port;
    const normal = fakeSpawn(fake, []);
    let spawns = 0;
    const lockedFirst: SpawnServe = (o) => {
      spawns++;
      if (spawns > 1) return normal(o);
      mkdirSync(dirname(o.logFile), { recursive: true });
      appendFileSync(o.logFile, "database is locked\n");
      return { pid: 999, kill() {}, exited: Promise.resolve(1) };
    };
    const live = liveCounter(lockedFirst);
    const eng = new OpenCodeEngine({ env, spawn: live.spawn, stopGraceMs: 500, lockRetryDelayMs: 300 });
    const started = eng.start(spec).then(() => "started", (e: Error) => e.message);
    await until(() => spawns === 1, 2000, "first boot");
    await sleep(30);
    await eng.stop();
    const r = await started;
    await eng.stop();
    assert.match(r, /stopped during start/);
    assert.equal(spawns, 1, "no re-boot after stop");
    assert.equal(live.live(), 0, "no live serve");
    assert.equal(await portIsOpen(port), false);
  });

  it("stop() while the first port probe is pending: nothing is spawned", async () => {
    const fake = new FakeOpencode();
    const port = await fake.listen();
    const { env, spec } = setup();
    spec.enginePort = port;
    const calls: SpawnCall[] = [];
    const live = liveCounter(fakeSpawn(fake, calls));
    const eng = new OpenCodeEngine({ env, spawn: live.spawn, stopGraceMs: 500 });
    const started = eng.start(spec).then(() => "started", (e: Error) => e.message);
    await eng.stop();
    const r = await started;
    await eng.stop();
    assert.match(r, /stopped during start/);
    assert.equal(calls.length, 0);
    assert.equal(live.live(), 0);
    assert.equal(await portIsOpen(port), false);
  });

  it("stop() between leak-restart boots: no second boot", async () => {
    const fake = new FakeOpencode();
    const port = await fake.listen();
    const { env, spec } = setup();
    spec.enginePort = port;
    fake.mcp = { desks: { status: "connected" }, hidden: { status: "connected" } };
    const calls: SpawnCall[] = [];
    let eng!: OpenCodeEngine;
    let stopCall: Promise<void> | undefined;
    const spawn: SpawnServe = (o) => {
      if (calls.length > 0) {
        const f = new FakeOpencode();
        f.port = port;
        return fakeSpawn(f, calls)(o);
      }
      const p = fakeSpawn(fake, calls)(o);
      return {
        ...p,
        kill(sig) {
          stopCall ??= eng.stop();
          p.kill(sig);
        },
      };
    };
    const live = liveCounter(spawn);
    eng = new OpenCodeEngine({ env, spawn: live.spawn, stopGraceMs: 500 });
    const r = await eng.start(spec).then(() => "started", (e: Error) => e.message);
    await stopCall;
    await eng.stop();
    assert.match(r, /stopped during start/);
    assert.equal(calls.length, 1, "no second boot after stop");
    assert.equal(live.live(), 0);
    assert.equal(await portIsOpen(port), false);
  });

  it("the lock retry reads only this boot's log lines, not an older boot's", async () => {
    const { env, spec } = setup();
    spec.enginePort = await new FakeOpencode().listen();
    let spawns = 0;
    const spawn: SpawnServe = (o) => {
      spawns++;
      mkdirSync(dirname(o.logFile), { recursive: true });
      appendFileSync(o.logFile, spawns === 1 ? "Error: Unexpected error\n\ndatabase is locked\n" : "Error: bad config\n");
      return { pid: 999, kill() {}, exited: Promise.resolve(1) };
    };
    const eng = new OpenCodeEngine({ env, spawn, stopGraceMs: 500, lockRetryDelayMs: 10 });
    const r = await eng.start(spec).then(() => "started", (e: Error) => e.message);
    assert.equal(spawns, 2, "one lock retry, then the bad config is final");
    assert.match(r, /exited \(1\) before ready[\s\S]*bad config/);
    assert.doesNotMatch(r, /database is locked/, "the error shows only this boot's log");
  });

  it("serve dying mid-turn after ready: fatal error, then turn_end with an error marker", async () => {
    const fake = new FakeOpencode();
    const port = await fake.listen();
    const { env, spec } = setup();
    spec.enginePort = port;
    let crash!: () => void;
    const spawn: SpawnServe = () => {
      fake.open();
      let res!: (c: number | string | null) => void;
      const exited = new Promise<number | string | null>((r) => (res = r));
      crash = () => void fake.close().then(() => res(1));
      return {
        pid: 77,
        kill(sig) {
          if (sig === "SIGTERM" || sig === "SIGKILL") void fake.close().then(() => res(sig));
        },
        exited,
      };
    };
    const eng = new OpenCodeEngine({ env, spawn, stopGraceMs: 500 });
    const events: EngineEvent[] = [];
    eng.onEvent((e) => events.push(e));
    try {
      await eng.start(spec);
      await eng.send("go");
      eng.handleEvent({ type: "session.status", properties: { sessionID: "ses_fake1", status: { type: "busy" } } });
      crash();
      await until(() => events.some((e) => e.type === "turn_end"), 2000, "turn_end after the crash");
      assert.deepEqual(events.map((e) => e.type), ["turn_start", "error", "turn_end"]);
      assert.equal(events[1]!.data.fatal, true);
      assert.match(String(events[1]!.data.error), /opencode serve exited \(1\)/);
      assert.match(String(events[2]!.data.error), /opencode serve exited/);
    } finally {
      await eng.stop();
    }
  });

  it("a turn that ends within the send grace without opencode ever showing busy still ends", async () => {
    const fake = new FakeOpencode();
    const port = await fake.listen();
    const { env, spec } = setup();
    spec.enginePort = port;
    const eng = new OpenCodeEngine({ env, spawn: fakeSpawn(fake, []), stopGraceMs: 500, sendGraceMs: 150 });
    const events: EngineEvent[] = [];
    eng.onEvent((e) => events.push(e));
    try {
      await eng.start(spec);
      await eng.send("fails at once");
      // The only idle signal arrives inside the grace, so it is (rightly) ignored as stale.
      eng.handleEvent({ type: "session.idle", properties: { sessionID: "ses_fake1" } });
      await until(() => events.some((e) => e.type === "turn_end"), 2000, "turn_end after the grace");
      assert.deepEqual(events.map((e) => e.type), ["turn_start", "turn_end"]);
      // A turn opencode reports busy at grace expiry is not ended by the timer.
      fake.status = { ses_fake1: { type: "busy" } };
      await eng.send("long turn");
      await sleep(400);
      assert.deepEqual(events.map((e) => e.type), ["turn_start", "turn_end", "turn_start"]);
    } finally {
      await eng.stop();
    }
  });

  it("send() failing while an idle transition is in flight leaves no phantom turn_start", async () => {
    const fake = new FakeOpencode();
    const port = await fake.listen();
    const { env, spec } = setup();
    spec.enginePort = port;
    fake.messageDelayMs = 200;
    const eng = new OpenCodeEngine({ env, spawn: fakeSpawn(fake, []), stopGraceMs: 500 });
    const events: EngineEvent[] = [];
    eng.onEvent((e) => events.push(e));
    const S = "ses_fake1";
    try {
      await eng.start(spec);
      eng.handleEvent({ type: "session.status", properties: { sessionID: S, status: { type: "busy" } } });
      eng.handleEvent({ type: "session.idle", properties: { sessionID: S } });
      fake.failPrompt = true;
      await assert.rejects(eng.send("next"), /HTTP 500/);
      await sleep(400);
      assert.deepEqual(events.map((e) => e.type), ["turn_start", "turn_end"]);
    } finally {
      await eng.stop();
    }
  });

  it("methods before start() throw a clear error; stop() before start() is a no-op", async () => {
    const eng = new OpenCodeEngine({ env: {} });
    await assert.rejects(eng.send("x"), /before start/);
    assert.throws(() => eng.attachCommand(), /before start/);
    await eng.stop();
  });
});

// ------------------------------------------------------------------ live

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;
const LIVE_PORT = 5601;

describe("OpenCodeEngine live (real opencode serve, ferry/super-flash)", { skip: process.env.ACH_DESKS_LIVE === "1" ? false : "set ACH_DESKS_LIVE=1" }, () => {
  it("start -> MCPs isolated -> PONG turn with usage -> stop frees the port", { timeout: 240_000 }, async () => {
    const cwd = tmp("ach-oce-live-cwd-");
    const stateDir = tmp("ach-oce-live-state-");
    const role = join(cwd, "role.md");
    writeFileSync(role, "You are $DESK_NAME, a test desk. Answer exactly as asked, with no tools.\n");
    const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // Pin the desks MCP to the real ach CLI (process.argv[1] is the test runner here).
      ACH_SELF_ARGV: JSON.stringify(isBun ? [process.execPath, CLI] : [process.execPath, "--import", import.meta.resolve("tsx"), CLI]),
    };
    delete env.ACH_DESKS_LIVE;
    const spec: HostSpec = {
      stack: "livetest",
      stateDir,
      name: "TESTDESK",
      kind: "desk",
      role: "test",
      roleFiles: [role],
      agent: "opencode",
      engine: "opencode",
      model: "ferry/super-flash",
      mcps: [],
      port: 5101,
      enginePort: LIVE_PORT,
      cwd,
      runId: "run_live",
    };
    const eng = new OpenCodeEngine({ env });
    const events: EngineEvent[] = [];
    eng.onEvent((e) => events.push(e));
    try {
      const r = await eng.start(spec);
      console.log(`live: start -> ${JSON.stringify(r)}`);
      assert.ok(r.sessionId?.startsWith("ses_"));
      assert.equal(r.engineUrl, `http://127.0.0.1:${LIVE_PORT}`);

      const mcp = await eng.mcpStatus();
      console.log(`live: mcpStatus -> ${JSON.stringify(mcp)}`);
      assert.ok("desks" in mcp, "desks MCP present");
      const globals = configuredMcpNames(cwd, env);
      console.log(`live: user's configured MCPs -> ${JSON.stringify(globals)}`);
      for (const n of globals) assert.equal(mcp[n] ?? "disabled", "disabled", `global MCP ${n} must be disabled`);
      for (const [n, s] of Object.entries(mcp)) if (n !== "desks") assert.equal(s, "disabled", `${n} must be disabled`);

      await eng.send("[desk-msg from TEST] reply with the single word PONG");
      assert.equal(await eng.state(), "busy", "busy right after send");
      // Wait on the EVENT STREAM only (no state() polling, which would reconcile by itself).
      await until(() => events.some((e) => e.type === "turn_end"), 90_000, "turn_end from the event stream");
      console.log(`live: stream events received -> ${eng.streamEventCount}`);
      assert.ok(eng.streamEventCount > 0, "GET /event delivered bus events");
      assert.equal(await eng.state(), "idle");
      const texts = events.filter((e) => e.type === "text").map((e) => String(e.data.text));
      const usage = events.filter((e) => e.type === "usage");
      console.log(`live: event types -> ${JSON.stringify(events.map((e) => e.type))}`);
      console.log(`live: texts -> ${JSON.stringify(texts)}; usage -> ${JSON.stringify(usage.map((u) => u.data))}`);
      assert.ok(texts.join(" ").includes("PONG"), "assistant text contains PONG");
      assert.ok(usage.length >= 1, "a usage event was emitted");
      assert.ok(Number(usage[0]!.data.inputTokens) > 0);
      assert.deepEqual(eng.attachCommand(), ["opencode", "attach", `http://127.0.0.1:${LIVE_PORT}`, "--session", r.sessionId]);
    } finally {
      await eng.stop();
    }
    assert.equal(await portIsOpen(LIVE_PORT), false, "port free after stop");
    const lsof = spawnSync("lsof", ["-nP", `-iTCP:${LIVE_PORT}`, "-sTCP:LISTEN"], { encoding: "utf8", timeout: 10_000 });
    console.log(`live: lsof -iTCP:${LIVE_PORT} LISTEN -> ${JSON.stringify(lsof.stdout)}`);
    assert.equal(lsof.stdout.trim(), "");
  });
});
