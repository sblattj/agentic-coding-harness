// The desk host process (#204): `ach desk host --spec <file>`. Owner: host seat.
//
// One host per desk/lane. It listens on 127.0.0.1:<spec.port> (Host HTTP API in
// types.ts above HOST_ROUTES), owns the engine, the optional feed, the message
// queue, the meter (run record + token records + budget) and the event log
// <stateDir>/desks/<stack>/events/<runId>.jsonl.
//
// Trust: every route but GET /health needs `Bearer <spec.token>`; every route refuses a
// foreign Host or Origin, and POSTs must be JSON (see checkHostOrigin, bearerOk).
//
// Test hook: env ACH_DESK_FAKE_ENGINE=1 swaps in EchoEngine (replies "echo: <text>")
// and a no-op meter, so a real child process can be exercised without an agent CLI
// or a run registry.
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { probeInstalledVersion, spawnAutoReload, startVersionWatcher, versionPollMs, type VersionWatcher, type VersionWatcherOpts } from "./auto-reload.ts";
import { createEngine as realCreateEngine } from "./engines/index.ts";
import { startFeed as realStartFeed, type FeedHandle } from "./feeds.ts";
import { createHostMeter as realCreateHostMeter, type HostMeter, type UsageSample } from "./host-metering.ts";
import { deskPaths } from "./roster.ts";
import { achSelfArgv } from "./self.ts";
import { VERSION } from "../version.ts";
import {
  DESKS_API_VERSION,
  peerHeader,
  type DeskMessage,
  type Engine,
  type EngineEvent,
  type EngineKind,
  type GoalStatus,
  type HostEvent,
  type HostEventType,
  type HostHealth,
  type HostSpec,
  type HostState,
  type Sender,
} from "./types.ts";

/** Exit codes of runHost. */
export const HOST_EXIT = { ok: 0, engineFailed: 1, portInUse: 3 } as const;

/** Events kept in memory; the events file is always complete. */
export const HOST_EVENT_MEMORY_CAP = 5000;
/** Messages held while the engine is busy; the next one is refused (HTTP 429 on /send, an error event from the feed). */
export const HOST_QUEUE_CAP = 1000;
const HEARTBEAT_MS = 5_000;
const SSE_KEEPALIVE_MS = 15_000;
const GOAL_TIMEOUT_MS = 45_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface HostDeps {
  createEngine?: (kind: EngineKind) => Promise<Engine>;
  startFeed?: typeof realStartFeed;
  createHostMeter?: (spec: HostSpec) => HostMeter;
  /** Install SIGTERM/SIGINT handlers (default true; tests running in-process pass false). */
  installSignals?: boolean;
  /** Called once the server listens (before the engine starts); tests use it with port 0. */
  onReady?: (info: { port: number; url: string }) => void;
  env?: NodeJS.ProcessEnv;
  /** Heartbeat interval override (tests). */
  heartbeatMs?: number;
  /** In-memory event cap override (tests); default HOST_EVENT_MEMORY_CAP. */
  eventMemoryCap?: number;
  /** Pending-message queue cap override (tests); default HOST_QUEUE_CAP. */
  queueCap?: number;
  /** Auto-reload after an ach upgrade (desks only; auto-reload.ts): overrides for tests. */
  versionWatcher?: Partial<Pick<VersionWatcherOpts, "probe" | "spawn" | "pollMs" | "running" | "settleMs" | "retryAfterMs">>;
}

export function newMessageId(): string {
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// EchoEngine + NullMeter: the ACH_DESK_FAKE_ENGINE=1 test hook
// ---------------------------------------------------------------------------

/** Scripted engine: every send emits turn_start, text "echo: <text>", usage, turn_end after delayMs. */
export class EchoEngine implements Engine {
  readonly kind: EngineKind = "driver";
  readonly sent: string[] = [];
  readonly notes: string[] = [];
  started = false;
  stopped = false;
  private cbs: ((e: EngineEvent) => void)[] = [];
  private busy = false;
  private goal: GoalStatus = { objective: "", state: "none", source: "ach-loop", updatedAt: Date.now() };
  private name = "";
  constructor(private readonly delayMs = 20) {}

  async start(spec: HostSpec): Promise<{ sessionId?: string; engineUrl?: string; childPid?: number }> {
    this.started = true;
    this.name = spec.name;
    // Honors a reload's resume request, like the real engines, so `desk reload` is testable offline.
    return { sessionId: spec.resumeSessionId ?? `echo-${spec.runId}` };
  }
  async send(text: string): Promise<void> {
    this.sent.push(text);
    this.busy = true;
    this.emit({ type: "turn_start", data: {} });
    setTimeout(() => {
      this.emit({ type: "text", data: { text: `echo: ${text}` } });
      this.emit({
        type: "usage",
        data: { inputTokens: text.length, outputTokens: text.length + 6, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
      });
      this.busy = false;
      this.emit({ type: "turn_end", data: {} });
    }, this.delayMs);
  }
  async note(text: string): Promise<void> {
    this.notes.push(text);
  }
  async state(): Promise<"busy" | "idle"> {
    return this.busy ? "busy" : "idle";
  }
  async setGoal(objective: string): Promise<void> {
    this.goal = { objective, state: "active", source: "ach-loop", updatedAt: Date.now() };
  }
  async goalStatus(): Promise<GoalStatus> {
    return { ...this.goal };
  }
  async mcpStatus(): Promise<Record<string, string>> {
    return { desks: "connected" };
  }
  attachCommand(): string[] {
    return [...achSelfArgv(), "desk", "chat", this.name];
  }
  onEvent(cb: (e: EngineEvent) => void): void {
    this.cbs.push(cb);
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
  private emit(e: EngineEvent): void {
    for (const cb of this.cbs) cb(e);
  }
}

/** Meter that records nothing (fake-engine test hook only). */
export function nullMeter(): HostMeter {
  return {
    begin() {},
    usage() {},
    heartbeat() {},
    overBudget: () => false,
    finish() {},
    totals: () => ({ costUsd: null, inputTokens: 0, outputTokens: 0 }),
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, after?: () => void): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text, after);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = chunk as Buffer;
    size += b.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "body too large");
    chunks.push(b);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "body must be a JSON object");
  return parsed as Record<string, unknown>;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/**
 * True when `header` is `Bearer <token>` for a non-empty `token` (constant-time compare).
 * A host with no token (an old or hand-written spec) accepts no bearer at all: fail closed.
 */
export function bearerOk(header: string | undefined, token: string | undefined): boolean {
  if (token === undefined || token === "" || header === undefined) return false;
  const m = /^Bearer (.+)$/i.exec(header);
  if (m === null) return false;
  const got = Buffer.from(m[1] as string, "utf8");
  const want = Buffer.from(token, "utf8");
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * Refuse what a browser page could send: a Host other than the loopback name with this
 * port (DNS rebinding, 421) and an Origin other than this host itself (cross-site, 403).
 * Native clients (host-client, curl) send no Origin and Host 127.0.0.1:<port>.
 */
function checkHostOrigin(req: IncomingMessage, port: number): void {
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
  const host = (req.headers.host ?? "").toLowerCase();
  if (!allowed.includes(host)) throw new HttpError(421, `misdirected request: Host ${JSON.stringify(req.headers.host ?? "")} is not this desk host`);
  const origin = req.headers.origin;
  if (origin !== undefined && !allowed.some((a) => origin.toLowerCase() === `http://${a}`)) {
    throw new HttpError(403, `cross-origin request refused (Origin ${JSON.stringify(origin)})`);
  }
}

/** POST bodies must be JSON: a text/plain or form POST is what a page sends without a CORS preflight. */
function checkJsonType(req: IncomingMessage): void {
  const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") throw new HttpError(415, "content-type must be application/json");
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// ---------------------------------------------------------------------------
// runHost
// ---------------------------------------------------------------------------

/** Runs until POST /stop or SIGTERM. Resolves with the exit code. */
export async function runHost(spec: HostSpec, deps: HostDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const fake = env.ACH_DESK_FAKE_ENGINE === "1";
  const makeEngine = deps.createEngine ?? (fake ? async () => new EchoEngine() : realCreateEngine);
  const makeMeter = deps.createHostMeter ?? (fake ? () => nullMeter() : realCreateHostMeter);
  const feedStarter = deps.startFeed ?? realStartFeed;
  const installSignals = deps.installSignals ?? true;
  const memoryCap = Math.max(1, deps.eventMemoryCap ?? HOST_EVENT_MEMORY_CAP);
  const queueCap = Math.max(1, deps.queueCap ?? HOST_QUEUE_CAP);

  const paths = deskPaths(spec.stateDir, spec.stack);
  const eventsFile = join(paths.events, `${spec.runId}.jsonl`);

  let state: HostState = "starting";
  let seq = 0;
  const events: HostEvent[] = [];
  const sseClients = new Set<ServerResponse>();
  const queue: { text: string }[] = [];
  let goal: GoalStatus | undefined;
  let sessionId: string | undefined;
  let engineUrl: string | undefined;
  let feed: FeedHandle | undefined;
  let engine: Engine | undefined;
  let meter: HostMeter | undefined;
  let lastPreview: string | undefined;
  let budgetAlerted = false;
  let tokenRecordFailuresSeen = 0;
  let stopping: Promise<number> | undefined;
  /**
   * Set by POST /stop-if-idle in the same tick as its idle check: from then on no message is
   * accepted (send gets 503, a feed message is refused), so nothing can start a turn or queue
   * between that check and the stop that follows.
   */
  let intakeClosed = false;
  /** Engine creation + engine.start(), while in flight: stop() waits for it so no engine outlives the host. */
  let startup: Promise<void> | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let versionWatcher: VersionWatcher | undefined;
  let resolveDone!: (code: number) => void;
  const done = new Promise<number>((r) => (resolveDone = r));

  const record = (type: HostEventType, data: Record<string, unknown>): HostEvent => {
    const ev: HostEvent = { seq: ++seq, at: Date.now(), runId: spec.runId, name: spec.name, type, data };
    events.push(ev);
    if (events.length > memoryCap) events.splice(0, events.length - memoryCap);
    try {
      mkdirSync(paths.events, { recursive: true });
      appendFileSync(eventsFile, `${JSON.stringify(ev)}\n`);
    } catch (e) {
      process.stderr.write(`desk host ${spec.name}: cannot append event: ${errText(e)}\n`);
    }
    if (type === "text" && typeof data.text === "string") lastPreview = data.text.slice(0, 200);
    else if (type !== "usage" && type !== "status") lastPreview = `${type}`;
    const line = `data: ${JSON.stringify(ev)}\n\n`;
    for (const c of sseClients) c.write(line);
    return ev;
  };

  const setState = (s: HostState): void => {
    if (s === state) return;
    state = s;
    record("status", { state: s });
    if (s === "idle") versionWatcher?.nudge();
    try {
      meter?.heartbeat(s, lastPreview);
    } catch {
      /* metering must not take the host down */
    }
  };

  const eventsSince = (since: number): HostEvent[] => {
    const first = events[0];
    if (first !== undefined && since < first.seq - 1 && existsSync(eventsFile)) {
      // older than the memory window: the file is complete
      const out: HostEvent[] = [];
      for (const line of readFileSync(eventsFile, "utf8").split("\n")) {
        if (line.trim() === "") continue;
        try {
          const ev = JSON.parse(line) as HostEvent;
          if (ev.seq > since) out.push(ev);
        } catch {
          /* skip a torn line */
        }
      }
      return out;
    }
    return events.filter((e) => e.seq > since);
  };

  const refreshGoal = async (): Promise<void> => {
    if (engine === undefined) return;
    try {
      const g = await engine.goalStatus();
      const changed = goal === undefined || g.state !== goal.state || g.objective !== goal.objective || g.evidence !== goal.evidence || g.reason !== goal.reason;
      goal = g;
      if (changed && g.state !== "none") record("goal", { goal: g });
    } catch {
      /* goal status is best effort */
    }
  };

  // --- turns + queue -------------------------------------------------------

  const startTurn = (text: string): void => {
    if (engine === undefined) return;
    setState("busy");
    engine.send(text).catch((e: unknown) => {
      record("error", { error: `send failed: ${errText(e)}` });
      if (state === "busy") setState("idle");
      drain();
    });
  };

  const drain = (): void => {
    if (state !== "idle" || queue.length === 0) return;
    const merged = queue.splice(0, queue.length).map((q) => q.text).join("\n\n");
    startTurn(merged);
  };

  /**
   * Record the message, then deliver it now or queue it. message_in is recorded BEFORE the turn
   * starts: an engine may emit turn_start synchronously inside send(), and subscribers and replay
   * must see the message ahead of the turn it caused.
   */
  const acceptMessage = (from: Sender, text: string, header: boolean): DeskMessage => {
    if (intakeClosed || stopping !== undefined) throw new HttpError(503, "host is stopping");
    const engineText = header ? peerHeader(from) + text : text;
    const delivered: "now" | "queued" = state === "idle" && queue.length === 0 ? "now" : "queued";
    if (delivered === "queued" && queue.length >= queueCap) throw new HttpError(429, `message queue full (${queueCap} pending); retry when the engine is idle`);
    const message: DeskMessage = { id: newMessageId(), from, to: spec.name, text, at: Date.now(), delivered };
    record("message_in", { message });
    if (delivered === "now") startTurn(engineText);
    else queue.push({ text: engineText });
    return message;
  };

  // --- engine events ---------------------------------------------------------

  const onEngineEvent = (e: EngineEvent): void => {
    record(e.type, e.data);
    // fatal: the engine cannot continue (its server died); stop with status error, exit 1.
    if (e.type === "error" && e.data.fatal === true) void stop("error", HOST_EXIT.engineFailed);
    if (e.type === "turn_start") {
      if (state === "idle") setState("busy");
    } else if (e.type === "turn_end") {
      // The driver engine learns its agent session id from the first turn: expose it on /health,
      // so the roster and `desk reload` see it.
      if (typeof e.data.sessionId === "string" && e.data.sessionId !== "") sessionId = e.data.sessionId;
      if (state === "busy") setState("idle");
      void refreshGoal();
      drain();
    } else if (e.type === "usage") {
      const d = e.data;
      const sample: UsageSample = {
        model: typeof d.model === "string" ? d.model : spec.model,
        inputTokens: num(d.inputTokens),
        outputTokens: num(d.outputTokens),
        cacheReadTokens: num(d.cacheReadTokens),
        cacheWriteTokens: num(d.cacheWriteTokens),
        ...(d.reasoningTokens !== undefined ? { reasoningTokens: num(d.reasoningTokens) } : {}),
        costUsd: typeof d.costUsd === "number" ? d.costUsd : null,
        messageId: typeof d.messageId === "string" ? d.messageId : undefined,
        at: Date.now(),
        ...(d.recorded === true ? { recorded: true } : {}),
      };
      try {
        meter?.usage(sample);
        // A lost token record undercounts `ach desk costs`; the meter keeps running, so make it visible.
        const lost = meter?.totals().tokenRecordFailures ?? 0;
        if (lost > tokenRecordFailuresSeen) {
          tokenRecordFailuresSeen = lost;
          record("error", { error: "metering: token record write failed", tokenRecordFailures: lost });
        }
        if (!budgetAlerted && meter?.overBudget() === true) {
          budgetAlerted = true;
          record("error", { error: "budget exceeded", budgetUsd: spec.budgetUsd ?? null });
          // A lane has no human to read the alert: stop it, recorded as an error (a budget stop is a failure, not a plain abort).
          if (spec.kind === "lane") void stop("error");
        }
      } catch (err) {
        record("error", { error: `metering: ${errText(err)}` });
      }
    }
  };

  // --- shutdown --------------------------------------------------------------

  const onSignal = (): void => {
    void stop();
  };
  const removeSignals = (): void => {
    if (!installSignals) return;
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
  };

  let server: Server | undefined;
  /** The port the server really listens on (spec.port, or the OS pick when spec.port is 0). */
  let boundPort = spec.port;
  const closeServer = async (): Promise<void> => {
    for (const c of sseClients) c.end();
    sseClients.clear();
    if (server === undefined) return;
    const s = server;
    await new Promise<void>((r) => {
      s.close(() => r());
      s.closeAllConnections();
    });
  };

  function stop(status?: "success" | "error" | "aborted", code: number = HOST_EXIT.ok): Promise<number> {
    if (stopping !== undefined) return stopping;
    // Only a start still in flight when stop() begins needs the second engine stop below.
    const startInFlight = startup;
    stopping = (async () => {
      setState("stopping");
      if (heartbeat !== undefined) clearInterval(heartbeat);
      versionWatcher?.stop();
      if (feed !== undefined) {
        try {
          await feed.stop();
          record("feed", { note: "feed stopped", active: false });
        } catch (e) {
          record("error", { error: `feed stop: ${errText(e)}` });
        }
      }
      await refreshGoal();
      if (engine !== undefined) {
        try {
          await engine.stop();
        } catch (e) {
          record("error", { error: `engine stop: ${errText(e)}` });
        }
      }
      if (startInFlight !== undefined) {
        // An engine.start() still running when stop() began may have come up after the stop above:
        // wait for it to settle, then stop the engine again.
        await startInFlight.catch(() => undefined);
        try {
          await engine?.stop();
        } catch (e) {
          record("error", { error: `engine stop: ${errText(e)}` });
        }
      }
      try {
        meter?.finish(status ?? (goal?.state === "achieved" ? "success" : "aborted"));
      } catch (e) {
        process.stderr.write(`desk host ${spec.name}: meter.finish failed: ${errText(e)}\n`);
      }
      removeSignals();
      await closeServer();
      resolveDone(code);
      return code;
    })();
    return stopping;
  }

  // --- HTTP ------------------------------------------------------------------

  const health = (): HostHealth => ({
    version: DESKS_API_VERSION,
    name: spec.name,
    kind: spec.kind,
    engine: spec.engine,
    agent: spec.agent,
    runId: spec.runId,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(engineUrl !== undefined ? { engineUrl } : {}),
    pid: process.pid,
    state,
    queueDepth: queue.length,
    ...(goal !== undefined ? { goal } : {}),
    ...(feed !== undefined ? { feedPid: feed.pid } : {}),
    lastSeq: seq,
  });

  const needEngine = (): Engine => {
    if (engine === undefined || state === "starting") throw new HttpError(503, "engine not started yet");
    if (state === "stopping") throw new HttpError(503, "host is stopping");
    return engine;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const route = `${req.method ?? "GET"} ${url.pathname}`;
    checkHostOrigin(req, boundPort);
    if (route !== "GET /health") {
      if (!bearerOk(req.headers.authorization, spec.token)) throw new HttpError(401, "unauthorized: this desk host needs its bearer token");
      if (req.method !== "GET") checkJsonType(req);
    }
    switch (route) {
      case "GET /health":
        return sendJson(res, 200, health());
      case "POST /send": {
        const b = await readJson(req);
        const from = typeof b.from === "string" && b.from !== "" ? b.from : "human";
        const text = typeof b.text === "string" ? b.text : "";
        if (text.trim() === "") throw new HttpError(400, "text must be a non-empty string");
        needEngine();
        const m = acceptMessage(from, text, true);
        return sendJson(res, 200, { id: m.id, delivered: m.delivered });
      }
      case "POST /note": {
        const b = await readJson(req);
        if (typeof b.text !== "string" || b.text === "") throw new HttpError(400, "text must be a non-empty string");
        await needEngine().note(b.text);
        return sendJson(res, 200, {});
      }
      case "POST /record": {
        const b = await readJson(req);
        if (b.type !== "message_out" && b.type !== "feed") throw new HttpError(400, `type must be "message_out" or "feed", got ${JSON.stringify(b.type)}`);
        const data = b.data !== null && typeof b.data === "object" && !Array.isArray(b.data) ? (b.data as Record<string, unknown>) : {};
        const ev = record(b.type, data);
        return sendJson(res, 200, { seq: ev.seq });
      }
      case "GET /goal": {
        const g = await needEngine().goalStatus();
        goal = g;
        return sendJson(res, 200, g);
      }
      case "POST /goal": {
        const b = await readJson(req);
        if (typeof b.objective !== "string" || b.objective.trim() === "") throw new HttpError(400, "objective must be a non-empty string");
        const e = needEngine();
        await withTimeout(e.setGoal(b.objective), GOAL_TIMEOUT_MS, "setGoal");
        await refreshGoal();
        return sendJson(res, 200, {});
      }
      case "GET /mcp":
        return sendJson(res, 200, await needEngine().mcpStatus());
      case "GET /attach":
        return sendJson(res, 200, { argv: needEngine().attachCommand() });
      case "GET /events": {
        const since = Number(url.searchParams.get("since") ?? "0");
        const from = Number.isFinite(since) ? since : 0;
        if ((req.headers.accept ?? "").includes("text/event-stream")) {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
          res.write(": desks-api/1\n\n");
          for (const ev of eventsSince(from)) res.write(`data: ${JSON.stringify(ev)}\n\n`);
          sseClients.add(res);
          const ka = setInterval(() => res.write(": keep-alive\n\n"), SSE_KEEPALIVE_MS);
          ka.unref();
          const cleanup = (): void => {
            clearInterval(ka);
            sseClients.delete(res);
          };
          // Only the response's close means the client went away: the request's close can fire
          // as soon as its (empty) body is consumed, which would drop a live subscriber.
          res.on("close", cleanup);
          if (stopping !== undefined) res.end();
          return;
        }
        return sendJson(res, 200, { events: eventsSince(from) });
      }
      case "POST /stop":
        return sendJson(res, 200, {}, () => void stop());
      case "POST /stop-if-idle": {
        // `desk reload` without force: check idle and close intake in one tick, so a message that
        // arrives after the caller's /health snapshot is refused (503) instead of cut or dropped.
        if (state !== "idle" || queue.length > 0) {
          return sendJson(res, 409, { error: `busy (state ${state}, ${queue.length} queued)`, state, queueDepth: queue.length });
        }
        intakeClosed = true;
        return sendJson(res, 200, { stopping: true }, () => void stop());
      }
      default:
        throw new HttpError(404, `no route ${route}`);
    }
  };

  server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (!res.headersSent) sendJson(res, status, { error: errText(e) });
      else res.end();
    });
  });

  const listenErr = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
    const s = server as Server;
    s.once("error", (e: NodeJS.ErrnoException) => resolve(e));
    s.listen(spec.port, "127.0.0.1", () => resolve(null));
  });
  if (listenErr !== null) {
    if (listenErr.code === "EADDRINUSE") {
      process.stderr.write(`desk host ${spec.name}: port 127.0.0.1:${spec.port} is already in use (another desk host or process holds it)\n`);
      return HOST_EXIT.portInUse;
    }
    process.stderr.write(`desk host ${spec.name}: cannot listen on 127.0.0.1:${spec.port}: ${listenErr.message}\n`);
    return HOST_EXIT.engineFailed;
  }
  server.on("error", (e) => process.stderr.write(`desk host ${spec.name}: server error: ${errText(e)}\n`));
  const addr = server.address();
  const port = addr !== null && typeof addr === "object" ? addr.port : spec.port;
  boundPort = port;
  if (installSignals) {
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
  }
  record("status", { state: "starting" });
  deps.onReady?.({ port, url: `http://127.0.0.1:${port}` });

  // --- startup -----------------------------------------------------------------
  try {
    startup = (async () => {
      meter = makeMeter(spec);
      const eng = await makeEngine(spec.engine);
      engine = eng;
      eng.onEvent(onEngineEvent);
      meter.begin({ pid: process.pid });
      if (stopping !== undefined) return; // stopped while the engine was being created: never start it
      const started = await eng.start(spec);
      sessionId = started.sessionId;
      engineUrl = started.engineUrl;
      if (sessionId !== undefined) meter.begin({ sessionId, pid: process.pid });
    })().finally(() => {
      startup = undefined;
    });
    await startup;
  } catch (e) {
    // A stop already in flight owns finish + close; a start it cut short is not an error.
    if (stopping !== undefined) return done;
    record("error", { error: `engine start failed: ${errText(e)}` });
    process.stderr.write(`desk host ${spec.name}: engine start failed: ${errText(e)}\n`);
    setState("error");
    stopping = Promise.resolve(HOST_EXIT.engineFailed);
    try {
      meter?.finish("error");
    } catch {
      /* already failing */
    }
    try {
      await engine?.stop();
    } catch {
      /* best effort */
    }
    removeSignals();
    await closeServer();
    return HOST_EXIT.engineFailed;
  }
  if (stopping !== undefined) return done; // a stop arrived during start

  setState("idle");
  heartbeat = setInterval(() => {
    try {
      meter?.heartbeat(state, lastPreview);
    } catch {
      /* best effort */
    }
  }, deps.heartbeatMs ?? HEARTBEAT_MS);
  heartbeat.unref();

  if (spec.feed !== undefined) {
    try {
      feed = feedStarter(spec.feed, async (text) => {
        if (stopping !== undefined || text.trim() === "") return;
        try {
          acceptMessage("feed", text, false);
        } catch (e) {
          record("error", { error: `feed message refused: ${errText(e)}` });
        }
      }, {
        cwd: spec.cwd,
        onNote: (note) => record("feed", { note }),
        onActive: (active) => record("feed", { note: active ? "call active" : "call not active", active }),
        onError: (error) => record("error", { error: `feed: ${error}` }),
      });
      record("feed", { note: `feed started (pid ${feed.pid})`, pid: feed.pid });
    } catch (e) {
      record("error", { error: `feed start failed: ${errText(e)}` });
    }
  }

  // Desks only (a lane is short-lived and never reloaded): reload once after an ach upgrade, when idle.
  const vw = deps.versionWatcher ?? {};
  const pollMs = vw.pollMs ?? versionPollMs(env);
  if (spec.kind === "desk" && pollMs > 0) {
    versionWatcher = startVersionWatcher({
      spec,
      running: vw.running ?? VERSION,
      pollMs,
      isIdle: () => state === "idle" && queue.length === 0 && stopping === undefined && !intakeClosed && goal?.state !== "active",
      probe: vw.probe ?? (() => probeInstalledVersion(env)),
      spawn: vw.spawn ?? (() => spawnAutoReload(spec, env)),
      log: (line) => process.stderr.write(`desk host ${spec.name}: ${line}\n`),
      ...(vw.settleMs !== undefined ? { settleMs: vw.settleMs } : {}),
      ...(vw.retryAfterMs !== undefined ? { retryAfterMs: vw.retryAfterMs } : {}),
    });
  }

  if (spec.kind === "lane" && engine !== undefined) {
    try {
      if (spec.brief !== undefined && spec.brief !== "") await engine.note(spec.brief);
      if (spec.goal !== undefined && spec.goal !== "") {
        await withTimeout(engine.setGoal(spec.goal), GOAL_TIMEOUT_MS, "setGoal");
        await refreshGoal();
      }
    } catch (e) {
      record("error", { error: `lane goal: ${errText(e)}` });
    }
  }

  return done;
}

// ---------------------------------------------------------------------------
// spawnHost
// ---------------------------------------------------------------------------

/** Spawn `ach desk host --spec <specFile>` fully detached (own session), stdout/stderr to logFile. Returns its pid. */
export function spawnHost(specFile: string, logFile: string): number {
  const [cmd, ...args] = [...achSelfArgv(), "desk", "host", "--spec", specFile];
  mkdirSync(dirname(logFile), { recursive: true });
  const fd = openSync(logFile, "a");
  try {
    const child = spawn(cmd as string, args, { detached: true, stdio: ["ignore", fd, fd], env: process.env });
    child.on("error", (e) => process.stderr.write(`spawnHost: ${cmd}: ${errText(e)}\n`));
    child.unref();
    if (child.pid === undefined) throw new Error(`spawnHost: could not start ${cmd}`);
    return child.pid;
  } finally {
    closeSync(fd);
  }
}
