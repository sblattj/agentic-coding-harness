// Desks Web API (#205): every /api/desks route of `ach web`. Contract: the Web API
// block in src/desks/types.ts (above WEB_API_PREFIX). Returns true when it handled
// the request (it owns every path under /api/desks, unknown ones answer 404).
//
// Everything stack-shaped goes through src/desks/service.ts; the stream also reads
// the stack files directly (read-only) through src/desks/roster.ts and subscribes
// to each live host's event SSE through src/desks/host-client.ts. Every outside
// dependency is injectable (DesksApiDeps) so tests run against a fake service.
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, watch, type FSWatcher } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import * as realService from "../desks/service.ts";
import { hostAttach, hostHealth, hostSubscribe } from "../desks/host-client.ts";
import { deskPaths, readDecisions, readRoster, validStackName } from "../desks/roster.ts";
import { loadLayout } from "../desks/config.ts";
import { AGENTS, type AgentName } from "../core/types.ts";
import { kiroIdeDefaultBin, resolveOnPath, runDoctor, scanMcp, type DoctorCheck } from "../cli/doctor.ts";
import { WEB_API_PREFIX } from "../desks/types.ts";
import type { Decision, DeskMessage, HostEvent, Layout, RosterRow, RosterView, TerminalKind } from "../desks/types.ts";

export interface DesksApiOptions {
  stateDir: string;
  token?: string;
}

/** One row of GET /api/desks/engines. */
export interface DeskEngineInfo {
  agent: string;
  found: boolean;
  path?: string;
  auth?: string;
}

export type DesksService = Pick<
  typeof realService,
  | "deskUp"
  | "deskDown"
  | "deskSend"
  | "deskRoster"
  | "deskInbox"
  | "deskEvents"
  | "deskSwitchEngine"
  | "laneNew"
  | "laneApprove"
  | "laneReject"
  | "laneStop"
  | "decisionAnswer"
  | "decisionList"
  | "deskCosts"
  | "resolveStack"
>;

export interface DesksApiDeps {
  service: DesksService;
  hostSubscribe: (url: string, since: number, onEvent: (e: HostEvent) => void) => () => void;
  /** The host's current last seq, so a stream subscription starts at "now" instead of replaying history. */
  hostLastSeq: (url: string) => Promise<number>;
  /** GET /api/desks/:name/attach: the argv a terminal runs to show that session (host GET /attach). */
  hostAttach: (url: string) => Promise<string[]>;
  engines: (stateDir: string) => Promise<DeskEngineInfo[]>;
  mcps: (stateDir: string, stack: string) => Promise<string[]>;
}

// ---------------------------------------------------------------- engines

const ENGINES_TTL_MS = 60_000;
/** Adapters whose doctor checks are deep (ACP handshake, CDP probe): resolved on disk only here. */
const SHALLOW_ONLY = new Set<AgentName>(["kiro", "kiro-ide"]);
let enginesCache: { at: number; value: Promise<DeskEngineInfo[]> } | undefined;

/** `binary` check detail -> resolved path: "<path> (--version exited 0)" or "'<path> --version' exited N...". */
function pathFromBinaryCheck(c: DoctorCheck | undefined): string | undefined {
  if (c === undefined) return undefined;
  const ok = /^(.+) \(--version exited 0\)$/.exec(c.detail);
  if (ok) return ok[1];
  const bad = /^'(.+) --version' exited /.exec(c.detail);
  if (bad) return bad[1];
  return undefined;
}

/** Every adapter ach knows, from the same checks `ach doctor` runs (binary on PATH + auth). */
export async function probeEngines(env: NodeJS.ProcessEnv = process.env, stateDir?: string): Promise<DeskEngineInfo[]> {
  const doctorAgents = AGENTS.filter((a) => !SHALLOW_ONLY.has(a));
  const report = await runDoctor({ agents: doctorAgents, env, cwd: homedir(), versionTimeoutMs: 5_000, ...(stateDir !== undefined ? { stateDir } : {}) });
  return AGENTS.map((agent): DeskEngineInfo => {
    if (agent === "kiro") {
      const p = resolveOnPath(env.KIRO_CLI_BIN && env.KIRO_CLI_BIN !== "" ? env.KIRO_CLI_BIN : "kiro-cli", env.PATH);
      return { agent, found: p !== undefined, ...(p !== undefined ? { path: p } : {}), auth: "unproven" };
    }
    if (agent === "kiro-ide") {
      const bin = kiroIdeDefaultBin(process.platform, env);
      const found = bin !== undefined && existsSync(bin);
      return { agent, found, ...(found ? { path: bin } : {}), auth: "unproven" };
    }
    const mine = report.checks.filter((c) => c.agent === agent);
    if (agent === "null") return { agent, found: true, auth: "verified" };
    const binary = mine.find((c) => c.name === "binary");
    const auth = mine.find((c) => c.name === "auth");
    const p = pathFromBinaryCheck(binary);
    return { agent, found: p !== undefined, ...(p !== undefined ? { path: p } : {}), ...(auth !== undefined ? { auth: auth.status } : {}) };
  });
}

function cachedEngines(stateDir: string): Promise<DeskEngineInfo[]> {
  const now = Date.now();
  if (enginesCache === undefined || now - enginesCache.at > ENGINES_TTL_MS) {
    const value = probeEngines(process.env, stateDir);
    enginesCache = { at: now, value };
    value.catch(() => {
      if (enginesCache?.value === value) enginesCache = undefined;
    });
  }
  return enginesCache.value;
}

// ---------------------------------------------------------------- mcps

/** The layout the stack runs (layout.json written by `desk up`), else the one `desk up` would load. */
function stackLayout(stateDir: string, stack: string): Layout | null {
  const p = deskPaths(stateDir, stack);
  try {
    if (existsSync(p.layout)) return JSON.parse(readFileSync(p.layout, "utf8")) as Layout;
  } catch {
    /* fall through */
  }
  try {
    const roster = readRoster(stateDir, stack);
    return loadLayout(roster.layoutFile).layout;
  } catch {
    return null;
  }
}

/** Layout lanes.defaultMcps + every desk's mcps + layout.mcpServers + the user MCP config of every agent the layout uses. */
export async function listDeskMcps(stateDir: string, stack: string, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const names = new Set<string>();
  const layout = stackLayout(stateDir, stack);
  const agents = new Set<string>(["opencode"]);
  if (layout !== null) {
    for (const n of layout.lanes?.defaultMcps ?? []) names.add(n);
    for (const d of layout.desks ?? []) {
      for (const n of d.mcps ?? []) names.add(n);
      if (d.agent) agents.add(d.agent);
    }
    for (const n of Object.keys(layout.mcpServers ?? {})) names.add(n);
    if (layout.agent) agents.add(layout.agent);
    if (layout.lanes?.agent) agents.add(layout.lanes.agent);
  }
  for (const r of Object.values(safeRoster(stateDir, stack)?.entries ?? {})) {
    for (const n of r.mcps ?? []) names.add(n);
    agents.add(r.agent);
  }
  const cwd = layout?.cwd ?? homedir();
  for (const a of agents) {
    if (!(AGENTS as readonly string[]).includes(a)) continue;
    try {
      const scan = await scanMcp(a as AgentName, env, cwd);
      for (const s of scan.servers) names.add(s.name);
    } catch {
      /* an unreadable config contributes nothing */
    }
  }
  names.delete("ach"); // always added to every desk; not a choice
  return [...names].sort();
}

function safeRoster(stateDir: string, stack: string): ReturnType<typeof readRoster> | null {
  try {
    return readRoster(stateDir, stack);
  } catch {
    return null;
  }
}

export const defaultDesksApiDeps: DesksApiDeps = {
  service: realService,
  hostSubscribe,
  hostAttach,
  hostLastSeq: async (url) => (await hostHealth(url, 2_000))?.lastSeq ?? 0,
  engines: cachedEngines,
  mcps: (stateDir, stack) => listDeskMcps(stateDir, stack),
};

// ---------------------------------------------------------------- http helpers

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

const BODY_MAX = 1024 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (c: Buffer) => {
      if (over) return; // keep draining (and discarding) so the 413 reaches a client that is still writing
      size += c.length;
      if (size > BODY_MAX) {
        over = true;
        chunks.length = 0;
        reject(new HttpError(413, `body over ${BODY_MAX} bytes`));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

type Body = Record<string, unknown>;

async function jsonBody(req: IncomingMessage): Promise<Body> {
  const raw = (await readBody(req)).trim();
  if (raw === "") return {};
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "body is not valid JSON");
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "body must be a JSON object");
  return v as Body;
}

function reqStr(b: Body, k: string): string {
  const v = b[k];
  if (typeof v !== "string" || v.trim() === "") throw new HttpError(400, `${k} must be a non-empty string`);
  return v;
}

function optStr(b: Body, k: string): string | undefined {
  const v = b[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new HttpError(400, `${k} must be a string`);
  return v === "" ? undefined : v;
}

function optStrArr(b: Body, k: string): string[] | undefined {
  const v = b[k];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new HttpError(400, `${k} must be an array of strings`);
  return v as string[];
}

function optNum(b: Body, k: string): number | undefined {
  const v = b[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new HttpError(400, `${k} must be a non-negative number`);
  return v;
}

function numParam(url: URL, k: string): number | undefined {
  const raw = url.searchParams.get(k);
  if (raw === null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${k} must be a non-negative number`);
  return n;
}

/**
 * Service errors are plain Errors; their message picks the status (shapes are the ones
 * src/desks/*.ts throws; see the table in docs/DESKS.md):
 * HttpError keeps its own; server-side or config failure (bad layout or role file, corrupt
 * roster, host start timeout, upstream host failure, "not implemented") -> 500; bad input
 * (empty text/goal/question, invalid lane name, send to self) -> 400; a desk, lane, decision
 * or pending item named in the request that does not exist -> 404; any other refusal (already
 * up, port busy, name in use, dead target, wrong kind, closed; CONFLICT below) -> 409; a
 * non-Error throw, and any message no rule matches (a server bug) -> 500.
 */
const SERVER_FAILURE =
  /not implemented|layout file not found|invalid layout|cannot parse layout|corrupt (layout|roster)|roles\/common\.md not found|role file .* not found|invalid role name|the layout has no desks|did not become idle|timed out after|no spec or layout entry|^desk host |spawnHost:|ACH_SELF_ARGV/i;
const FORBIDDEN = /only the human or the decisions desk/i;
const BAD_INPUT =
  /must not be empty|must be (a non-empty string|an array)|needs a label|invalid (lane|stack|desk or lane) name|invalid run id|cannot send to yourself/i;
const MISSING_RESOURCE =
  /\bunknown (desk|lane|decision|pending)\b|\bno pending lane\b|\bno decision\b|\bno such\b|does not exist|\b(desk|lane|decision|pending)\b[^\n]* not found/i;

const CONFLICT =
  /is already (up|pending approval|approving|approved|rejected)|already in use|still busy|is not running \(dead\)|is a (lane|desk)\b|is closed|no free lane port/i;

export function statusForError(e: unknown): number {
  if (e instanceof HttpError) return e.status;
  if (!(e instanceof Error)) return 500;
  const m = e.message;
  if (SERVER_FAILURE.test(m)) return 500;
  if (FORBIDDEN.test(m)) return 403;
  if (BAD_INPUT.test(m)) return 400;
  if (MISSING_RESOURCE.test(m)) return 404;
  if (CONFLICT.test(m)) return 409;
  return 500;
}

function authorized(req: IncomingMessage, url: URL, token: string | undefined): boolean {
  if (token === undefined) return true;
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
  return url.searchParams.get("token") === token || bearer === token;
}

function decodeSeg(s: string): string {
  let d: string;
  try {
    d = decodeURIComponent(s);
  } catch {
    throw new HttpError(400, `bad path segment ${JSON.stringify(s)}`);
  }
  // A segment names a desk, lane, decision or pending id; `..%2F..%2Fx` must not become a path.
  if (/[/\\]/.test(d) || d.startsWith(".")) throw new HttpError(400, `bad path segment ${JSON.stringify(s)}`);
  return d;
}

const TERMS: readonly TerminalKind[] = ["tmux", "ghostty", "none"];
const DECISION_STATES: readonly Decision["state"][] = ["open", "answered", "closed"];

// ---------------------------------------------------------------- router

export async function handleDesksApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  opts: DesksApiOptions,
  deps: DesksApiDeps = defaultDesksApiDeps,
): Promise<boolean> {
  const pathname = url.pathname;
  if (pathname !== WEB_API_PREFIX && !pathname.startsWith(`${WEB_API_PREFIX}/`)) return false;
  if (!authorized(req, url, opts.token)) {
    sendJson(res, 401, { error: "unauthorized" });
    return true;
  }
  const svc = deps.service;
  const stackParam = url.searchParams.get("stack");
  if (stackParam && !validStackName(stackParam)) {
    sendJson(res, 400, { error: `desks: invalid stack name ${JSON.stringify(stackParam)}` });
    return true;
  }
  const so = { stateDir: opts.stateDir, ...(stackParam ? { stack: stackParam } : {}) };
  const method = req.method ?? "GET";
  const want = (m: "GET" | "POST"): void => {
    if (method !== m) throw new HttpError(405, `${method} not allowed here; use ${m}`);
  };

  try {
    const segs = pathname.slice(WEB_API_PREFIX.length).split("/").filter((s) => s !== "").map(decodeSeg);
    const [a, b, c] = segs;
    const n = segs.length;
    if (n === 0) {
      want("GET");
      return done(res, 200, await svc.deskRoster(so));
    }
    if (n === 1) {
      switch (a) {
        case "messages": {
          want("GET");
          const sinceMs = numParam(url, "since");
          const limit = numParam(url, "limit");
          const name = url.searchParams.get("name") ?? undefined;
          const messages = await svc.deskInbox({ ...so, ...(sinceMs !== undefined ? { sinceMs } : {}), ...(limit !== undefined ? { limit } : {}), ...(name ? { name } : {}) });
          return done(res, 200, { messages });
        }
        case "stream": {
          want("GET");
          const stack = stackParam || svc.resolveStack({ stateDir: opts.stateDir });
          await openStream(req, res, opts.stateDir, stack, deps);
          return true;
        }
        case "decisions": {
          want("GET");
          const st = url.searchParams.get("state");
          if (st !== null && !DECISION_STATES.includes(st as Decision["state"])) throw new HttpError(400, `state must be one of ${DECISION_STATES.join(", ")}`);
          const decisions = await svc.decisionList({ ...so, ...(st !== null ? { state: st as Decision["state"] } : {}) });
          return done(res, 200, { decisions });
        }
        case "send": {
          want("POST");
          const body = await jsonBody(req);
          const to = reqStr(body, "to");
          const text = reqStr(body, "text");
          return done(res, 200, await svc.deskSend({ ...so, from: "human", to, text }));
        }
        case "up": {
          want("POST");
          const body = await jsonBody(req);
          const layoutFile = optStr(body, "layoutFile");
          // Additive: the web/app default is no terminal panes (the macOS app "launches with no terminal open").
          const term = optStr(body, "term") ?? "none";
          if (!TERMS.includes(term as TerminalKind)) throw new HttpError(400, `term must be one of ${TERMS.join(", ")}`);
          return done(res, 200, await svc.deskUp({ ...so, term: term as TerminalKind, ...(layoutFile !== undefined ? { layoutFile } : {}) }));
        }
        case "down": {
          want("POST");
          await jsonBody(req);
          return done(res, 200, await svc.deskDown(so));
        }
        case "lanes": {
          want("POST");
          const body = await jsonBody(req);
          const name = reqStr(body, "name");
          const goal = reqStr(body, "goal");
          const mcps = optStrArr(body, "mcps");
          const cwd = optStr(body, "cwd");
          const agent = optStr(body, "agent");
          const model = optStr(body, "model");
          const budgetUsd = optNum(body, "budgetUsd");
          const r = await svc.laneNew({
            ...so,
            name,
            goal,
            launchedBy: "human",
            ...(mcps !== undefined ? { mcps } : {}),
            ...(cwd !== undefined ? { cwd } : {}),
            ...(agent !== undefined ? { agent } : {}),
            ...(model !== undefined ? { model } : {}),
            ...(budgetUsd !== undefined ? { budgetUsd } : {}),
          });
          return done(res, 200, r);
        }
        case "costs": {
          want("GET");
          return done(res, 200, { rows: await svc.deskCosts(so) });
        }
        case "engines": {
          want("GET");
          return done(res, 200, { engines: await deps.engines(opts.stateDir) });
        }
        case "mcps": {
          want("GET");
          const stack = stackParam || svc.resolveStack({ stateDir: opts.stateDir });
          return done(res, 200, { names: await deps.mcps(opts.stateDir, stack) });
        }
      }
    }
    if (n === 3 && a === "decisions" && c === "answer") {
      want("POST");
      const body = await jsonBody(req);
      const text = reqStr(body, "text");
      return done(res, 200, await svc.decisionAnswer({ ...so, id: b!, text, by: "human" }));
    }
    if (n === 3 && a === "lanes" && c === "stop") {
      want("POST");
      const body = await jsonBody(req);
      if (body.now !== undefined && typeof body.now !== "boolean") throw new HttpError(400, "now must be a boolean");
      await svc.laneStop({ ...so, name: b!, by: "human", ...(body.now === true ? { now: true } : {}) });
      return done(res, 200, {});
    }
    if (n === 3 && a === "pending" && (c === "approve" || c === "reject")) {
      want("POST");
      const body = await jsonBody(req);
      if (c === "approve") return done(res, 200, await svc.laneApprove({ ...so, id: b!, by: "human" }));
      const reason = optStr(body, "reason");
      return done(res, 200, await svc.laneReject({ ...so, id: b!, by: "human", ...(reason !== undefined ? { reason } : {}) }));
    }
    if (n === 2 && b === "engine") {
      want("POST");
      const body = await jsonBody(req);
      const agent = reqStr(body, "agent");
      const model = optStr(body, "model");
      return done(res, 200, await svc.deskSwitchEngine({ ...so, name: a!, agent, ...(model !== undefined ? { model } : {}) }));
    }
    if (n === 2 && b === "attach") {
      want("GET");
      const view = await svc.deskRoster({ ...so, prune: false });
      const entry = view.rows.find((r) => r.name === a);
      if (entry === undefined) throw new HttpError(404, `unknown desk or lane ${a} (known: ${view.rows.map((r) => r.name).join(", ") || "none"})`);
      if (entry.state === "dead") throw new HttpError(409, `${a} is not running (dead)`);
      return done(res, 200, { argv: await deps.hostAttach(entry.url) });
    }
    if (n === 2 && b === "events") {
      want("GET");
      const since = numParam(url, "since");
      const events = await svc.deskEvents({ ...so, name: a!, ...(since !== undefined ? { since } : {}) });
      return done(res, 200, { events });
    }
    return done(res, 404, { error: `no desks route ${method} ${pathname}` });
  } catch (e) {
    if (res.headersSent) {
      res.end();
      return true;
    }
    const status = statusForError(e);
    // An oversized body is still arriving: answer, then close the connection instead of reading on.
    if (status === 413) res.setHeader("connection", "close");
    return done(res, status, { error: e instanceof Error ? e.message : String(e) });
  }
}

function done(res: ServerResponse, status: number, body: unknown): true {
  sendJson(res, status, body);
  return true;
}

// ---------------------------------------------------------------- stream

export const STREAM_POLL_MS = 500;
export const STREAM_ROSTER_DEBOUNCE_MS = 250;
export const STREAM_KEEPALIVE_MS = 15_000;

let openStreams = 0;
/** Live /api/desks/stream connections (tests assert cleanup with it). */
export function openDesksStreamCount(): number {
  return openStreams;
}

/** Byte-offset tail of a JSONL file: starts at EOF, carries a torn last line, restarts when the file shrinks. */
class JsonlTail {
  private offset: number;
  private rest = Buffer.alloc(0);
  constructor(private readonly file: string) {
    this.offset = sizeOf(file);
  }
  read(): unknown[] {
    const size = sizeOf(this.file);
    if (size < this.offset) {
      this.offset = 0;
      this.rest = Buffer.alloc(0);
    }
    if (size === this.offset) return [];
    const len = size - this.offset;
    const buf = Buffer.alloc(len);
    let fd: number | undefined;
    try {
      fd = openSync(this.file, "r");
      const got = readSync(fd, buf, 0, len, this.offset);
      this.offset += got;
      this.rest = Buffer.concat([this.rest, buf.subarray(0, got)]);
    } catch {
      return [];
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    const out: unknown[] = [];
    let nl: number;
    while ((nl = this.rest.indexOf(0x0a)) >= 0) {
      const line = this.rest.subarray(0, nl).toString("utf8").trim();
      this.rest = this.rest.subarray(nl + 1);
      if (line === "") continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* malformed line: skip */
      }
    }
    return out;
  }
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

function signature(file: string): string {
  try {
    const s = statSync(file);
    return `${s.ino}:${s.size}:${s.mtimeMs}`;
  } catch {
    return "missing";
  }
}

async function openStream(req: IncomingMessage, res: ServerResponse, stateDir: string, stack: string, deps: DesksApiDeps): Promise<void> {
  const p = deskPaths(stateDir, stack);
  // Capture offsets and signatures BEFORE the first await: nothing appended from now on is missed.
  const messages = new JsonlTail(p.messages);
  const decisions = new JsonlTail(p.decisions);
  let rosterSig = signature(p.roster);
  let pendingSig = signature(p.pendingLanes);

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
  res.write(": desks-api/1\n\n");
  openStreams++;

  let closed = false;
  let watcher: FSWatcher | undefined;
  let rosterTimer: NodeJS.Timeout | undefined;
  let lastRosterJson: string | undefined;
  let refreshing = false;
  let refreshAgain = false;
  /** key name|runId|url -> unsubscribe (null while the subscription is being set up). */
  const subs = new Map<string, (() => void) | null>();

  const send = (obj: unknown): void => {
    if (closed) return;
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch {
      cleanup();
    }
  };

  const syncSubs = (rows: RosterRow[]): void => {
    const wanted = new Map<string, RosterRow>();
    for (const r of rows) if (r.state !== "dead" && r.url) wanted.set(`${r.name}|${r.runId}|${r.url}`, r);
    for (const [key, unsub] of subs) {
      if (wanted.has(key)) continue;
      subs.delete(key);
      unsub?.();
    }
    for (const [key, row] of wanted) {
      if (subs.has(key)) continue;
      subs.set(key, null);
      void (async () => {
        let since = 0;
        try {
          since = await deps.hostLastSeq(row.url);
        } catch {
          since = 0;
        }
        if (closed || !subs.has(key) || subs.get(key) !== null) return;
        subs.set(key, deps.hostSubscribe(row.url, since, (event) => send({ kind: "event", event })));
      })();
    }
  };

  const refreshRoster = async (): Promise<void> => {
    if (closed) return;
    if (refreshing) {
      refreshAgain = true;
      return;
    }
    refreshing = true;
    try {
      const view: RosterView = await deps.service.deskRoster({ stateDir, stack, prune: false });
      if (closed) return;
      const json = JSON.stringify(view);
      if (json !== lastRosterJson) {
        lastRosterJson = json;
        send({ kind: "roster", view });
      }
      syncSubs(view.rows);
    } catch (e) {
      if (!closed) {
        try {
          res.write(`: roster error ${String(e instanceof Error ? e.message : e).replace(/\s+/g, " ").slice(0, 300)}\n\n`);
        } catch {
          /* closed */
        }
      }
    } finally {
      refreshing = false;
      if (refreshAgain && !closed) {
        refreshAgain = false;
        void refreshRoster();
      }
    }
  };

  const scheduleRoster = (): void => {
    if (closed) return;
    if (rosterTimer !== undefined) clearTimeout(rosterTimer);
    rosterTimer = setTimeout(() => {
      rosterTimer = undefined;
      void refreshRoster();
    }, STREAM_ROSTER_DEBOUNCE_MS);
  };

  const check = (): void => {
    if (closed) return;
    for (const m of messages.read()) {
      if (m && typeof m === "object" && typeof (m as DeskMessage).id === "string") send({ kind: "message", message: m });
    }
    const ids: string[] = [];
    for (const ev of decisions.read()) {
      const e = ev as { type?: string; id?: unknown; decision?: { id?: unknown } };
      const id = e.type === "open" ? e.decision?.id : e.id;
      if (typeof id === "string" && !ids.includes(id)) ids.push(id);
    }
    if (ids.length > 0) {
      const folded = readDecisions(stateDir, stack);
      for (const id of ids) {
        const d = folded.find((x) => x.id === id);
        if (d) send({ kind: "decision", decision: d });
      }
      scheduleRoster(); // openDecisions lives in the view
    }
    const rs = signature(p.roster);
    const ps = signature(p.pendingLanes);
    if (rs !== rosterSig || ps !== pendingSig) {
      rosterSig = rs;
      pendingSig = ps;
      scheduleRoster();
    }
  };

  // roster.json is replaced by rename (updateRoster), so watch the DIRECTORY; the dir may not exist yet.
  const tryWatch = (): void => {
    if (watcher !== undefined || closed || !existsSync(p.root)) return;
    try {
      const w = watch(p.root, () => check());
      w.on("error", () => {
        w.close();
        if (watcher === w) watcher = undefined;
      });
      watcher = w;
    } catch {
      watcher = undefined;
    }
  };

  // The poll is the fallback for missed or unavailable watch events; reads are offset-based, so double checks are no-ops.
  const poll = setInterval(() => {
    tryWatch();
    check();
  }, STREAM_POLL_MS);
  const keepAlive = setInterval(() => {
    if (closed) return;
    try {
      res.write(": keep-alive\n\n");
    } catch {
      cleanup();
    }
  }, STREAM_KEEPALIVE_MS);

  function cleanup(): void {
    if (closed) return;
    closed = true;
    openStreams--;
    clearInterval(poll);
    clearInterval(keepAlive);
    if (rosterTimer !== undefined) clearTimeout(rosterTimer);
    watcher?.close();
    watcher = undefined;
    for (const unsub of subs.values()) unsub?.();
    subs.clear();
  }
  // res "close" = the client went away or the server destroyed the socket. (req "close" can fire as soon as
  // the request body is consumed, which for a GET is immediately, so it must not end the stream.)
  res.on("close", cleanup);
  res.on("error", cleanup);
  req.socket.setKeepAlive(true);

  tryWatch();
  await refreshRoster();
  check();
}
