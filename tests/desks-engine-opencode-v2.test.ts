// OpenCodeEngine against opencode 2's API (#217): version selection, the v2 routes and Basic auth, the
// MCP leak check on the v2 config form, and the fail-closed paths (an HTML body is never data).
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  OpenCodeEngine,
  buildOpencodeConfig,
  configuredGoalCommands,
  configuredMcpNames,
  opencodeApiFor,
  opencodeConfigFiles,
  rolePrompt,
  type ServeProcess,
  type SpawnServe,
} from "../src/desks/engines/opencode.ts";
import { writeRoleSent } from "../src/desks/role-sent.ts";
import type { EngineEvent, HostSpec } from "../src/desks/types.ts";

const tmpRoots: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}
const servers: Server[] = [];
after(async () => {
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise<void>((r) => (s.listening ? s.close(() => r()) : r()));
  }
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

const WEB_UI = "<!doctype html><html><head><title>opencode</title></head><body><div id=root></div></body></html>";

interface Rec {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  auth: string | undefined;
  dir: string | undefined;
}

type Handler = (req: IncomingMessage, url: URL, body: unknown, res: ServerResponse) => boolean | Promise<boolean>;

/** A fake serve: `routes` answers what it knows, everything else gets the web UI (text/html 200) like opencode 2. */
class FakeServe {
  server: Server;
  port = 0;
  reqs: Rec[] = [];
  sse: ServerResponse[] = [];
  constructor(private routes: Handler) {
    this.server = createServer((req, res) => void this.handle(req, res));
    servers.push(this.server);
  }
  async listen(): Promise<number> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as AddressInfo).port;
    await new Promise<void>((r) => this.server.close(() => r()));
    return this.port;
  }
  open(): void {
    this.server.listen(this.port, "127.0.0.1");
  }
  async close(): Promise<void> {
    for (const s of this.sse) s.end();
    this.sse = [];
    this.server.closeAllConnections();
    await new Promise<void>((r) => (this.server.listening ? this.server.close(() => r()) : r()));
  }
  push(ev: Record<string, unknown>): void {
    for (const s of this.sse) s.write(`data: ${JSON.stringify({ id: `evt_${Math.random()}`, created: Date.now(), ...ev })}\n\n`);
  }
  of(method: string, path: string): Rec[] {
    return this.reqs.filter((r) => r.method === method && r.path === path);
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    let raw = "";
    for await (const c of req) raw += c;
    const body = raw === "" ? undefined : (JSON.parse(raw) as unknown);
    this.reqs.push({
      method: req.method ?? "",
      path: url.pathname,
      query: url.searchParams,
      body,
      auth: req.headers.authorization,
      dir: req.headers["x-opencode-directory"] as string | undefined,
    });
    if (await this.routes(req, url, body, res)) return;
    res.writeHead(200, { "content-type": "text/html;charset=UTF-8" });
    res.end(WEB_UI);
  }
}

const json = (res: ServerResponse, code: number, v: unknown) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(v));
  return true;
};

interface SpawnCall {
  env: NodeJS.ProcessEnv;
  args: string[];
}

function fakeSpawn(fake: FakeServe, calls: SpawnCall[], onSpawn?: (call: SpawnCall) => void): SpawnServe {
  return (o) => {
    const call = { env: o.env, args: o.args };
    calls.push(call);
    onSpawn?.(call);
    fake.open();
    let resolveExit!: (c: number | string | null) => void;
    const exited = new Promise<number | string | null>((r) => (resolveExit = r));
    const p: ServeProcess = {
      pid: 5000 + calls.length,
      kill(sig) {
        if (sig === "SIGTERM" || sig === "SIGKILL") void fake.close().then(() => resolveExit(sig));
      },
      exited,
    };
    return p;
  };
}

function setup(o: { mcps?: string[]; model?: string } = {}) {
  const home = tmp("ach-oc2-home-");
  const cwd = tmp("ach-oc2-cwd-");
  const stateDir = tmp("ach-oc2-state-");
  mkdirSync(join(home, ".config", "opencode"), { recursive: true });
  writeFileSync(
    join(home, ".config", "opencode", "opencode.json"),
    JSON.stringify({ mcp: { toolbox: { type: "remote", url: "http://127.0.0.1:1/mcp" }, whosaid: { type: "local", command: ["whosaid", "mcp"] } } }),
  );
  const role = join(cwd, "role.md");
  writeFileSync(role, "You are $DESK_NAME.\n");
  const env: NodeJS.ProcessEnv = { HOME: home, PATH: process.env.PATH, ACH_SELF_ARGV: JSON.stringify(["/opt/ach/bin/node", "/opt/ach/ach.js"]) };
  const spec: HostSpec = {
    stack: "t2",
    stateDir,
    name: "ORCH",
    kind: "desk",
    role: "orchestrator",
    roleFiles: [role],
    agent: "opencode",
    engine: "opencode",
    model: o.model,
    mcps: o.mcps ?? ["whosaid", "extra"],
    mcpServers: { extra: { command: "extra-mcp", args: ["--stdio"] } },
    port: 4801,
    cwd,
    runId: "run_v2",
  };
  return { home, cwd, stateDir, env, spec };
}

/** A fake opencode 2 serve: every /api route needs Basic opencode:<OPENCODE_PASSWORD from the spawn env>. */
class FakeV2 {
  password = "";
  sid = "ses_v2fake";
  /** Answers of GET /api/mcp, consumed in order; the last one repeats. */
  mcpAnswers: Array<Array<{ name: string; status: { status: string } }>> = [[], [{ name: "desks", status: { status: "connected" } }]];
  mcpCalls = 0;
  active: Record<string, { type: string }> = {};
  messages: unknown[] = [];
  eventContentType = "text/event-stream";
  infoVersion = "2.2.5";
  unauthorized = 0;
  goal: Record<string, unknown> | null = null;
  /** A `command.goal` from the user's config: /goal runs as a template and the opencode.goal RPC stays null. */
  goalShadowed = false;
  serve: FakeServe;
  constructor() {
    this.serve = new FakeServe((req, url, body, res) => this.route(req, url, body, res));
  }
  private route(req: IncomingMessage, url: URL, body: unknown, res: ServerResponse): boolean {
    if (!url.pathname.startsWith("/api/")) return false;
    const want = `Basic ${Buffer.from(`opencode:${this.password}`).toString("base64")}`;
    if (this.password === "" || req.headers.authorization !== want) {
      this.unauthorized++;
      return json(res, 401, { _tag: "UnauthorizedError", message: "Unauthorized" });
    }
    const p = url.pathname;
    const m = req.method;
    if (m === "GET" && p === "/api/info") return json(res, 200, { version: this.infoVersion, pid: 1, hostname: "127.0.0.1" });
    if (m === "GET" && p === "/api/mcp") {
      const a = this.mcpAnswers[Math.min(this.mcpCalls++, this.mcpAnswers.length - 1)];
      return json(res, 200, { location: { directory: url.searchParams.get("location[directory]") }, data: a });
    }
    if (m === "POST" && p === "/api/session") return json(res, 200, { data: { id: this.sid, title: (body as { title?: string }).title } });
    if (m === "GET" && p === "/api/session/active") return json(res, 200, { data: this.active });
    if (m === "POST" && p === `/api/session/${this.sid}/synthetic`) return json(res, 200, { data: { id: "msg_syn", type: "synthetic" } });
    if (m === "POST" && p === `/api/session/${this.sid}/prompt`) return json(res, 200, { data: { id: "msg_user", type: "user" } });
    if (m === "POST" && p === `/api/session/${this.sid}/interrupt`) return json(res, 200, { interrupted: true });
    if (m === "POST" && p === `/api/session/${this.sid}/command`) {
      const b = body as { name?: string; text?: string };
      if (b.name !== "goal") return json(res, 404, { _tag: "CommandNotFoundError" });
      if (this.goalShadowed) {
        res.writeHead(204);
        res.end();
        return true;
      }
      this.goal = { id: "g1", objective: b.text ?? "", status: "active", rounds: 0, maxRounds: 50, boot: "b", updatedAt: Date.now() };
      res.writeHead(204);
      res.end();
      return true;
    }
    if (m === "GET" && p === "/api/command") {
      const description = this.goalShadowed ? "my own goal template" : "keep working until an objective is met [pause|resume|clear]";
      return json(res, 200, { data: [{ name: "init", description: "guided AGENTS.md setup" }, { name: "goal", description }] });
    }
    if (m === "POST" && p === "/api/rpc/opencode.goal/get") {
      assert.deepEqual(body, { input: { sessionID: this.sid } });
      return json(res, 200, { output: this.goal });
    }
    if (m === "GET" && p === `/api/session/${this.sid}/message`) return json(res, 200, { data: this.messages, cursor: {} });
    if (m === "GET" && p === "/api/event") {
      res.writeHead(200, { "content-type": this.eventContentType, "cache-control": "no-cache" });
      res.write(`data: ${JSON.stringify({ id: "evt_0", type: "server.connected", data: {} })}\n\n`);
      this.serve.sse.push(res);
      return true;
    }
    return json(res, 404, { _tag: "NotFound" });
  }
  spawn(calls: SpawnCall[]): SpawnServe {
    return fakeSpawn(this.serve, calls, (c) => (this.password = c.env.OPENCODE_PASSWORD ?? ""));
  }
}

// ------------------------------------------------------------------ unit

describe("opencode API selection", () => {
  it("opencodeApiFor picks v1 for 1.x, v2 for 2.x, and refuses anything else", () => {
    assert.deepEqual(opencodeApiFor("1.19.0\n"), { version: "1.19.0", api: "v1" });
    assert.deepEqual(opencodeApiFor("opencode v2.2.5\n"), { version: "2.2.5", api: "v2" });
    assert.deepEqual(opencodeApiFor("opencode v2.3.2"), { version: "2.3.2", api: "v2" });
    assert.throws(() => opencodeApiFor("opencode v3.0.0"), /opencode 3\.0\.0 is not supported/);
    assert.throws(() => opencodeApiFor("0.15.31"), /not supported/);
    assert.throws(() => opencodeApiFor("command not found"), /cannot read the opencode version/);
  });

  it("start() fails before spawning when the version probe returns an unsupported version", async () => {
    const { env, spec } = setup();
    let spawned = 0;
    const eng = new OpenCodeEngine({ env, probeVersion: async () => "opencode v9.0.0", spawn: () => (spawned++, { pid: 1, kill() {}, exited: new Promise(() => {}) }) });
    await assert.rejects(eng.start(spec), /opencode 9\.0\.0 is not supported/);
    assert.equal(spawned, 0);
  });

  it("v2 config: disallowed MCPs get complete disabled stand-ins, never enabled-only entries", () => {
    const { cwd, env, spec } = setup();
    const configured = configuredMcpNames(cwd, env, "v2");
    assert.deepEqual(configured, ["toolbox", "whosaid"]);
    const cfg = buildOpencodeConfig(spec, { configured, env, api: "v2", extraDisabled: ["sneaky"] }) as { mcp: { servers: Record<string, Record<string, unknown>> } & Record<string, unknown> };
    assert.deepEqual(Object.keys(cfg.mcp), ["servers"]);
    const s = cfg.mcp.servers;
    assert.deepEqual(s.toolbox, { type: "local", command: ["false"], disabled: true });
    assert.deepEqual(s.sneaky, { type: "local", command: ["false"], disabled: true });
    assert.equal("whosaid" in s, false, "an allowed MCP the user defines keeps the user's definition");
    assert.deepEqual(s.extra, { type: "local", command: ["extra-mcp", "--stdio"] });
    assert.equal(s.desks!.type, "local");
    assert.deepEqual(s.desks!.command, ["/opt/ach/bin/node", "/opt/ach/ach.js", "mcp"]);
    for (const [n, v] of Object.entries(s)) assert.equal("enabled" in v, false, `${n} has no legacy enabled key`);
  });

  it("v2 config discovery adds OPENCODE_CONFIG_DIR and the managed system directory", () => {
    const { cwd, env } = setup();
    const dir = tmp("ach-oc2-cfgdir-");
    const v1 = opencodeConfigFiles(cwd, { ...env, OPENCODE_CONFIG_DIR: dir }, "v1");
    const v2 = opencodeConfigFiles(cwd, { ...env, OPENCODE_CONFIG_DIR: dir }, "v2");
    assert.equal(v1.includes(join(dir, "opencode.json")), false);
    assert.equal(v2.includes(join(dir, "opencode.json")), true);
    assert.equal(v2.some((f) => f.includes(process.platform === "darwin" ? "/Library/Application Support/opencode/" : "opencode")), true);
  });
});

// ------------------------------------------------------------------ fail closed

describe("OpenCodeEngine fails closed on an HTML body (#217)", () => {
  it("v1 engine against an opencode 2 serve: GET /session answers HTML, start() throws instead of waiting or reading it", async () => {
    const fake = new FakeServe(() => false);
    const port = await fake.listen();
    const { env, spec } = setup();
    spec.enginePort = port;
    const eng = new OpenCodeEngine({ version: "1.19.0", env, spawn: fakeSpawn(fake, []), stopGraceMs: 300 });
    await assert.rejects(eng.start(spec), /opencode 1\.19\.0 returned HTML for GET \/session; unsupported opencode API/);
    assert.equal(fake.server.listening, false, "the serve was killed");
  });

  it("the issue's repro: GET /mcp answering the web UI is an error, not 9571 leaked MCPs", async () => {
    const fake = new FakeServe((req, url, _b, res) => (req.method === "GET" && url.pathname === "/session" ? json(res, 200, []) : false));
    const port = await fake.listen();
    const { env, spec } = setup();
    spec.enginePort = port;
    const calls: SpawnCall[] = [];
    const eng = new OpenCodeEngine({ version: "1.19.0", env, spawn: fakeSpawn(fake, calls), stopGraceMs: 300 });
    const err = await eng.start(spec).then(
      () => assert.fail("start must fail"),
      (e: Error) => e,
    );
    assert.match(err.message, /returned HTML for GET \/mcp; unsupported opencode API/);
    assert.doesNotMatch(err.message, /still enables MCPs/);
    assert.equal(calls.length, 1, "no leak-restart on garbage");
  });

  it("v2 engine: GET /api/info answering HTML fails start()", async () => {
    const fake = new FakeServe(() => false);
    const port = await fake.listen();
    const { env, spec } = setup();
    spec.enginePort = port;
    const eng = new OpenCodeEngine({ version: "2.2.5", env, spawn: fakeSpawn(fake, []), stopGraceMs: 300 });
    await assert.rejects(eng.start(spec), /opencode 2\.2\.5 returned HTML for GET \/api\/info; unsupported opencode API/);
  });

  it("v2 engine: an event stream that is not text/event-stream fails start()", async () => {
    const v2 = new FakeV2();
    v2.eventContentType = "text/html";
    const port = await v2.serve.listen();
    const { env, spec } = setup();
    spec.enginePort = port;
    const eng = new OpenCodeEngine({ version: "2.2.5", env, spawn: v2.spawn([]), stopGraceMs: 300, mcpSettleMs: 3000 });
    await assert.rejects(eng.start(spec), /returned text\/html for GET \/api\/event, not text\/event-stream/);
    assert.equal(v2.serve.server.listening, false);
  });
});

// ------------------------------------------------------------------ v2 driver

describe("OpenCodeEngine against a fake opencode 2 serve", () => {
  it("drives the v2 routes with Basic auth: info, settled MCP list, session, synthetic role note, prompt, active, messages", async () => {
    const v2 = new FakeV2();
    const port = await v2.serve.listen();
    const { env, spec, cwd, stateDir } = setup({ model: "prov/model-x" });
    // The probed opencode is first on the engine's PATH; a pane's login shell may find another one.
    const binDir = tmp("ach-oc2-bin-");
    writeFileSync(join(binDir, "opencode"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(binDir, "opencode"), 0o755);
    env.PATH = `${binDir}:${env.PATH ?? ""}`;
    spec.enginePort = port;
    const calls: SpawnCall[] = [];
    const eng = new OpenCodeEngine({ version: "2.2.5", env, spawn: v2.spawn(calls), stopGraceMs: 300, sendGraceMs: 100, mcpSettleMs: 3000 });
    const events: EngineEvent[] = [];
    eng.onEvent((e) => events.push(e));
    try {
      const r = await eng.start(spec);
      assert.equal(r.sessionId, v2.sid);
      assert.equal(calls.length, 1);
      // A fresh random password per serve, only on the v2 path.
      assert.match(calls[0]!.env.OPENCODE_PASSWORD ?? "", /^[A-Za-z0-9_-]{32}$/);
      const cfg = JSON.parse(calls[0]!.env.OPENCODE_CONFIG_CONTENT!) as { mcp: { servers: Record<string, unknown> } };
      assert.deepEqual(cfg.mcp.servers.toolbox, { type: "local", command: ["false"], disabled: true });
      assert.equal(v2.unauthorized, 0, "every /api call carried the password");
      assert.ok(v2.mcpCalls >= 2, "the empty first MCP list was not accepted");
      assert.equal(v2.serve.reqs.filter((q) => !q.path.startsWith("/api/")).length, 0, "no v1 path was touched");
      const create = v2.serve.of("POST", "/api/session")[0]!;
      assert.deepEqual(create.body, { title: "ORCH", location: { directory: cwd }, model: { providerID: "prov", id: "model-x" } });
      assert.equal(decodeURIComponent(create.dir ?? ""), cwd);
      assert.deepEqual(v2.serve.of("POST", `/api/session/${v2.sid}/synthetic`)[0]!.body, { text: "You are ORCH.", resume: false });
      assert.equal(v2.serve.of("GET", "/api/mcp")[0]!.query.get("location[directory]"), cwd);
      await until(() => v2.serve.sse.length === 1, 2000, "event stream");

      // attach: the TUI form with the password in a 0600 file, never in argv.
      const argv = eng.attachCommand();
      assert.deepEqual(argv.slice(0, 2), ["/bin/sh", "-c"]);
      assert.equal(argv[3], join(binDir, "opencode"), "attach names the probed opencode by absolute path");
      assert.equal(argv.slice(3).includes(calls[0]!.env.OPENCODE_PASSWORD!), false);
      assert.deepEqual(argv.slice(5), [`http://127.0.0.1:${port}`, v2.sid]);
      const pwFile = argv[4]!;
      assert.ok(pwFile.startsWith(stateDir));
      assert.equal(readFileSync(pwFile, "utf8"), calls[0]!.env.OPENCODE_PASSWORD);
      assert.equal(statSync(pwFile).mode & 0o777, 0o600);

      // A turn: prompt, execution.started -> busy, text.ended streams, execution.succeeded -> reconcile + idle.
      v2.messages = [
        { id: "msg_u", type: "user", text: "hi" },
        {
          id: "msg_a1",
          type: "assistant",
          model: { id: "model-x", providerID: "prov" },
          content: [
            { type: "tool", id: "call_1", name: "read", state: { status: "completed", input: { path: "a" } } },
            { type: "text", text: "pong" },
          ],
          tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
          cost: 0,
          time: { created: 1, completed: 2 },
        },
      ];
      await eng.send("ping");
      assert.deepEqual(v2.serve.of("POST", `/api/session/${v2.sid}/prompt`)[0]!.body, { text: "ping" });
      v2.serve.push({ type: "session.execution.started", data: { sessionID: v2.sid } });
      v2.serve.push({ type: "session.text.ended", data: { sessionID: v2.sid, assistantMessageID: "msg_a1", ordinal: 0, text: "pong" } });
      v2.serve.push({ type: "session.execution.started", data: { sessionID: "ses_other" } });
      await sleep(150);
      v2.serve.push({ type: "session.execution.succeeded", data: { sessionID: v2.sid } });
      await until(() => events.some((e) => e.type === "turn_end"), 3000, "turn_end");
      const types = events.map((e) => e.type);
      assert.deepEqual(types, ["turn_start", "text", "tool", "usage", "turn_end"], "text once (stream and reconcile dedupe), tool + usage from the reconcile");
      assert.equal((events[3]!.data as { model?: string }).model, "prov/model-x");
      assert.equal(await eng.state(), "idle");
      v2.active = { [v2.sid]: { type: "running" } };
      assert.equal(await eng.state(), "busy");

      // Goals: the built-in opencode.goal plugin, armed by /goal and read over its RPC.
      assert.equal((await eng.goalStatus()).state, "none");
      await eng.setGoal("  ship it  ");
      assert.deepEqual(v2.serve.of("POST", `/api/session/${v2.sid}/command`)[0]!.body, { name: "goal", text: "ship it" });
      assert.equal(v2.serve.of("POST", "/api/rpc/opencode.goal/get")[0]!.query.get("location[directory]"), cwd);
      const g1 = await eng.goalStatus();
      assert.equal(g1.state, "active");
      assert.equal(g1.objective, "ship it");
      v2.goal = { ...v2.goal!, status: "complete", reason: "all checks green" };
      const g2 = await eng.goalStatus();
      assert.deepEqual([g2.state, g2.evidence, g2.source], ["achieved", "all checks green", "opencode-plugin"]);
      v2.goal = { ...v2.goal!, status: "paused", reason: "Paused by the user" };
      assert.deepEqual([(await eng.goalStatus()).state, (await eng.goalStatus()).reason], ["stopped", "Paused by the user"]);

      await eng.stop();
      assert.equal(v2.serve.of("POST", `/api/session/${v2.sid}/interrupt`).length, 1, "a running session is interrupted on stop");
      assert.equal(existsSync(pwFile), false, "the password file is removed on stop");
      assert.equal(v2.unauthorized, 0);
    } finally {
      await eng.stop();
    }
  });

  it("v2 desk reload: resumeSessionId adopts the existing session (no new session, no role note) and never re-emits or re-meters its old messages; an unknown session falls back to a new one", async () => {
    const v2 = new FakeV2();
    const port = await v2.serve.listen();
    const { env, spec } = setup();
    spec.enginePort = port;
    spec.resumeSessionId = v2.sid;
    writeRoleSent(spec, v2.sid, rolePrompt(spec)); // the session already got this exact role prompt
    const old = {
      id: "msg_old",
      type: "assistant",
      content: [
        { type: "tool", id: "call_old", name: "read", state: { status: "completed", input: { path: "a" } } },
        { type: "text", text: "old answer" },
      ],
      tokens: { input: 5, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0,
      time: { created: 1, completed: 2 },
    };
    v2.messages = [{ id: "msg_u0", type: "user", text: "earlier" }, old];
    const calls: SpawnCall[] = [];
    const eng = new OpenCodeEngine({ version: "2.2.5", env, spawn: v2.spawn(calls), stopGraceMs: 300, sendGraceMs: 100, mcpSettleMs: 3000 });
    const events: EngineEvent[] = [];
    eng.onEvent((e) => events.push(e));
    try {
      const r = await eng.start(spec);
      assert.equal(r.sessionId, v2.sid, "the resumed session id is reported");
      assert.equal(v2.serve.of("POST", "/api/session").length, 0, "no new session is created");
      assert.equal(v2.serve.of("POST", `/api/session/${v2.sid}/synthetic`).length, 0, "no second role note");
      await until(() => v2.serve.sse.length === 1, 2000, "event stream");

      v2.messages = [
        ...v2.messages,
        { id: "msg_u1", type: "user", text: "again" },
        { id: "msg_new", type: "assistant", content: [{ type: "text", text: "new answer" }], tokens: { input: 7, output: 3, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0, time: { created: 3, completed: 4 } },
      ];
      await eng.send("again");
      v2.serve.push({ type: "session.execution.started", data: { sessionID: v2.sid } });
      await sleep(150);
      v2.serve.push({ type: "session.execution.succeeded", data: { sessionID: v2.sid } });
      await until(() => events.some((e) => e.type === "turn_end"), 3000, "turn_end");
      assert.deepEqual(events.map((e) => e.type), ["turn_start", "text", "usage", "turn_end"], "only the new message is emitted and metered");
      assert.equal((events[1]!.data as { text?: string }).text, "new answer");
      assert.equal((events[2]!.data as { inputTokens?: number }).inputTokens, 7);
    } finally {
      await eng.stop();
    }

    // Unknown session: the message GET 404s, so start() creates a new session with the role note.
    const v2b = new FakeV2();
    const portB = await v2b.serve.listen();
    const b = setup();
    b.spec.enginePort = portB;
    b.spec.resumeSessionId = "ses_gone";
    const engB = new OpenCodeEngine({ version: "2.2.5", env: b.env, spawn: v2b.spawn([]), stopGraceMs: 300, sendGraceMs: 100, mcpSettleMs: 3000 });
    try {
      const rb = await engB.start(b.spec);
      assert.equal(rb.sessionId, v2b.sid, "a new session replaces the unknown one");
      assert.equal(v2b.serve.of("POST", "/api/session").length, 1);
      assert.equal(v2b.serve.of("POST", `/api/session/${v2b.sid}/synthetic`).length, 1, "the new session gets the role note");
    } finally {
      await engB.stop();
    }
  });

  it("v2 desk reload: a role file changed since the session got its prompt -> one synthetic refresh note with the current text; unchanged -> none", async () => {
    const { env, spec } = setup();
    const S = new FakeV2().sid;
    writeRoleSent(spec, S, rolePrompt(spec)); // delivered at desk up
    writeFileSync(spec.roleFiles[0]!, "You are $DESK_NAME, v2 rules: NEWRULE-214.\n"); // edited before the reload
    spec.resumeSessionId = S;
    for (const round of [1, 2]) {
      const v2 = new FakeV2();
      spec.enginePort = await v2.serve.listen();
      v2.messages = [{ id: "msg_u0", type: "user", text: "earlier" }];
      const eng = new OpenCodeEngine({ version: "2.2.5", env, spawn: v2.spawn([]), stopGraceMs: 300, sendGraceMs: 100, mcpSettleMs: 3000 });
      try {
        assert.equal((await eng.start(spec)).sessionId, S);
        assert.equal(v2.serve.of("POST", "/api/session").length, 0, "no new session");
        const notes = v2.serve.of("POST", `/api/session/${S}/synthetic`);
        if (round === 1) {
          assert.equal(notes.length, 1, "round 1: one refresh note");
          const b = notes[0]!.body as { text: string; resume: boolean };
          assert.equal(b.resume, false, "context only, starts no turn");
          assert.match(b.text, /role prompt changed/);
          assert.match(b.text, /You are ORCH, v2 rules: NEWRULE-214\./, "the CURRENT role text");
        } else {
          assert.equal(notes.length, 0, "round 2 (unchanged since round 1): no note");
        }
      } finally {
        await eng.stop();
      }
    }
  });

  it("v2 leak check: an MCP outside the allowed set that is not disabled forces a re-boot with a stand-in", async () => {
    const v2 = new FakeV2();
    const port = await v2.serve.listen();
    const { env, spec } = setup({ mcps: [] });
    spec.enginePort = port;
    const leaky = [
      { name: "desks", status: { status: "connected" } },
      { name: "toolbox", status: { status: "disabled" } },
      { name: "hidden", status: { status: "failed" } },
    ];
    const calls: SpawnCall[] = [];
    const eng = new OpenCodeEngine({
      version: "2.3.2",
      env,
      spawn: fakeSpawn(v2.serve, calls, (c) => {
        v2.password = c.env.OPENCODE_PASSWORD ?? "";
        v2.mcpCalls = 0;
        const cfg = JSON.parse(c.env.OPENCODE_CONFIG_CONTENT!) as { mcp: { servers: Record<string, { disabled?: boolean }> } };
        v2.mcpAnswers = cfg.mcp.servers.hidden?.disabled ? [leaky.map((e) => (e.name === "hidden" ? { ...e, status: { status: "disabled" } } : e))] : [[], leaky];
      }),
      stopGraceMs: 300,
      mcpSettleMs: 3000,
    });
    try {
      await eng.start(spec);
      assert.equal(calls.length, 2, "first boot leaked 'hidden', second boot disabled it");
      const second = JSON.parse(calls[1]!.env.OPENCODE_CONFIG_CONTENT!) as { mcp: { servers: Record<string, unknown> } };
      assert.deepEqual(second.mcp.servers.hidden, { type: "local", command: ["false"], disabled: true });
    } finally {
      await eng.stop();
    }
  });

  it("v2 leak check fails closed when the desks MCP never shows up (an empty list proves nothing)", async () => {
    const v2 = new FakeV2();
    v2.mcpAnswers = [[]];
    const port = await v2.serve.listen();
    const { env, spec } = setup();
    spec.enginePort = port;
    const eng = new OpenCodeEngine({ version: "2.2.5", env, spawn: v2.spawn([]), stopGraceMs: 300, mcpSettleMs: 600 });
    await assert.rejects(eng.start(spec), /did not list a settled "desks" MCP within 600 ms/);
    assert.equal(v2.serve.server.listening, false);
  });

  it("v2 readiness rejects a serve whose /api/info reports another API generation", async () => {
    const v2 = new FakeV2();
    v2.infoVersion = "1.19.0";
    const port = await v2.serve.listen();
    const { env, spec } = setup();
    spec.enginePort = port;
    const eng = new OpenCodeEngine({ version: "2.2.5", env, spawn: v2.spawn([]), stopGraceMs: 300 });
    await assert.rejects(eng.start(spec), /reports 1\.19\.0 on GET \/api\/info/);
  });

  it("v2 setGoal names a /goal command it cannot see in config (a plugin's) and interrupts the turn it may have started", async () => {
    const v2 = new FakeV2();
    v2.goalShadowed = true;
    const port = await v2.serve.listen();
    const { env, spec } = setup();
    spec.enginePort = port;
    const eng = new OpenCodeEngine({ version: "2.2.5", env, spawn: v2.spawn([]), stopGraceMs: 300, goalTimeoutMs: 600 });
    try {
      await eng.start(spec);
      await assert.rejects(eng.setGoal("ship it"), /did not confirm the goal \(opencode\.goal state: null\); the session's \/goal command is described as "my own goal template"/);
      assert.equal(v2.serve.of("POST", `/api/session/${v2.sid}/command`).length, 1);
      assert.equal(v2.serve.of("POST", `/api/session/${v2.sid}/interrupt`).length, 1, "the template turn is interrupted");
    } finally {
      await eng.stop();
    }
  });

  it("v2 setGoal refuses before posting when the opencode config defines its own goal command", async () => {
    const v2 = new FakeV2();
    const port = await v2.serve.listen();
    const { env, spec, home, cwd } = setup();
    const gcfg = join(home, ".config", "opencode", "opencode.json");
    writeFileSync(gcfg, JSON.stringify({ command: { goal: { template: "$ARGUMENTS", description: "mine" } } }));
    spec.enginePort = port;
    const eng = new OpenCodeEngine({ version: "2.2.5", env, spawn: v2.spawn([]), stopGraceMs: 300, goalTimeoutMs: 600 });
    try {
      await eng.start(spec);
      await assert.rejects(eng.setGoal("ship it"), (e: Error) => e.message.includes(`a "goal" command in ${gcfg} (command.goal) replaces opencode's built-in goal plugin`));
      assert.equal(v2.serve.of("POST", `/api/session/${v2.sid}/command`).length, 0, "nothing is posted");
    } finally {
      await eng.stop();
    }
    // Command directories count too, and a config without one finds nothing.
    writeFileSync(gcfg, "{}");
    assert.deepEqual(configuredGoalCommands(cwd, env), []);
    mkdirSync(join(cwd, ".opencode", "commands"), { recursive: true });
    writeFileSync(join(cwd, ".opencode", "commands", "goal.md"), "$ARGUMENTS\n");
    assert.deepEqual(configuredGoalCommands(cwd, env), [join(cwd, ".opencode", "commands", "goal.md")]);
    assert.deepEqual(configuredGoalCommands(cwd, { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ command: { goal: { template: "x" } } }) }).length, 2);
  });
});
