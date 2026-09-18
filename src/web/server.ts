// Dashboard web server: static assets, run JSON API, asciicast replays,
// and the /ws endpoints (runs list broadcast, per-run live tail, PTY relay).
//
// Built on node:http + the `ws` package (Bun implements both, so this one
// code path serves Bun and Node identically — no runtime branching).
//
// Pulls the wildcard ambient module declarations for the text-embedded
// assets (./assets.d.ts) into any program that includes this file, even
// when the ambient file itself is outside the program's include globs.
/// <reference path="./assets.d.ts" />
//
// Live per-run text is NOT taken from the hub topic: hub broadcasts carry
// raw AgentEvents, which the dashboard cannot render. Instead each run
// socket runs its own transcript tailer that forwards eventToText output.
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { WebSocketServer, type RawData, type WebSocket as WsSocket } from "ws";
import type { AgentEvent } from "../core/types.ts";
import { readRunRecord } from "../core/registry.ts";
import { createRunEventHub, RUN_TOPIC_PREFIX, RUNS_TOPIC, type WsPublisher } from "./hub.ts";
import { eventToText, eventsToAsciicast } from "./asciicast.ts";
import { deriveRunObservability } from "./derive.ts";
import { PtyManager } from "./pty-manager.ts";

export interface WebServerOptions {
  port: number;
  host: string;
  token?: string;
  stateDir: string;
  ptyManager?: PtyManager;
}

export interface WebServerHandle {
  port: number;
  close(): Promise<void>;
}

interface RunsSocketData {
  mode: "runs";
}

interface RunSocketData {
  mode: "run";
  runId: string;
  tailer: ReturnType<typeof setInterval> | null;
  ended: boolean;
}

interface PtySocketData {
  mode: "pty";
  sessionId: string;
  offData: (() => void) | null;
  offExit: (() => void) | null;
  closed: boolean;
}

type WsData = RunsSocketData | RunSocketData | PtySocketData;

/** A live dashboard websocket plus the bookkeeping the server keeps for it. */
interface DashSocket {
  ws: WsSocket;
  data: WsData;
  /** Heartbeat liveness flag; a socket that misses a ping round is dead. */
  alive: boolean;
  topics: Set<string>;
}

const NOT_LIVE_AFTER_MS = 60_000;
const TAIL_INTERVAL_MS = 500;
const HEARTBEAT_MS = 30_000;
const RUN_ACTION_ROUTE = /^\/api\/runs\/([^/]+)\/([^/]+)$/;
const PTY_KILL_ROUTE = /^\/api\/pty\/([^/]+)\/kill$/;
const PTY_WS_ROUTE = /^\/ws\/pty\/([^/]+)$/;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function jsonError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

function notFound(res: ServerResponse): void {
  jsonError(res, 404, "not found");
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Embedded asset fallbacks: `bun build` inlines these text imports, so the
// single-file bundle serves the dashboard with no sibling files on disk.
// Under plain `node --import tsx` from the source tree the disk read above
// always succeeds and these dynamic imports never execute (Node itself has
// no "text" import-attribute type). Note: bun-types types `*.html` modules
// as HTMLBundle; with the { type: "text" } attribute every runtime hands
// back the file's source string, hence the cast.
const text = (m: { default: unknown }): string => m.default as string;
const embeddedLoaders: Record<string, () => Promise<string>> = {
  "index.html": () => import("./index.html", { with: { type: "text" } }).then(text),
  "grid.html": () => import("./grid.html", { with: { type: "text" } }).then(text),
  "trio.html": () => import("./trio.html", { with: { type: "text" } }).then(text),
  "feed.js": () => import("./feed.js", { with: { type: "text" } }).then(text),
  "vendor/xterm/xterm.js": () =>
    import("./vendor/xterm/xterm.js", { with: { type: "text" } }).then(text),
  "vendor/xterm/xterm.css": () =>
    import("./vendor/xterm/xterm.css", { with: { type: "text" } }).then(text),
  "vendor/xterm/addon-fit.js": () =>
    import("./vendor/xterm/addon-fit.js", { with: { type: "text" } }).then(text),
  "vendor/xterm/addon-web-links.js": () =>
    import("./vendor/xterm/addon-web-links.js", { with: { type: "text" } }).then(text),
  "vendor/xterm/addon-webgl.js": () =>
    import("./vendor/xterm/addon-webgl.js", { with: { type: "text" } }).then(text),
  "vendor/xterm/LICENSE": () =>
    import("./vendor/xterm/LICENSE", { with: { type: "text" } }).then(text),
};

/** Read a served asset relative to this module. Disk copy first (source
 *  tree / installed package layout); embedded text fallback for the
 *  single-file bundle. Null when the asset does not exist at all. */
async function readAsset(rel: string): Promise<string | null> {
  try {
    return await readFile(new URL(`./${rel}`, import.meta.url), "utf8");
  } catch {
    const embedded = embeddedLoaders[rel];
    if (embedded === undefined) return null;
    try {
      return await embedded();
    } catch {
      return null;
    }
  }
}

function vendorContentType(name: string): string {
  if (name.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (name.endsWith(".css")) return "text/css; charset=utf-8";
  if (name.endsWith(".map")) return "application/json; charset=utf-8";
  return "text/plain; charset=utf-8";
}

/** Full raw AgentEvent with the rendered text attached (client reads .text). */
function backlogEvent(ev: AgentEvent): AgentEvent {
  const text = eventToText(ev);
  return text === null ? ev : { ...ev, text };
}

function safeSend(ws: WsSocket, payload: string): void {
  try {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  } catch {
    // socket died mid-send; the tailer stops via the close handler
  }
}

function rawToString(msg: RawData): string {
  if (typeof msg === "string") return msg;
  if (Array.isArray(msg)) return Buffer.concat(msg as Buffer[]).toString("utf8");
  if (msg instanceof Buffer) return msg.toString("utf8");
  return Buffer.from(msg as ArrayBuffer).toString("utf8");
}

function isRunLive(stateDir: string, runId: string): boolean {
  const rec = readRunRecord(stateDir, runId);
  if (rec === null) return false;
  return rec.status === "running" && Date.now() - (rec.updatedAt ?? 0) <= NOT_LIVE_AFTER_MS;
}

export async function startWebServer(opts: WebServerOptions): Promise<WebServerHandle> {
  const hub = createRunEventHub(opts.stateDir);
  const tailers = new Set<ReturnType<typeof setInterval>>();
  const ownsPty = opts.ptyManager === undefined;
  const ptyManager = opts.ptyManager ?? new PtyManager();

  const sockets = new Set<DashSocket>();
  const topics = new Map<string, Set<DashSocket>>();

  const publisher: WsPublisher = {
    publish(topic: string, data: string): void {
      const subs = topics.get(topic);
      if (subs === undefined) return;
      for (const ms of subs) safeSend(ms.ws, data);
    },
  };
  hub.attach(publisher);

  function subscribe(ms: DashSocket, topic: string): void {
    ms.topics.add(topic);
    let subs = topics.get(topic);
    if (subs === undefined) {
      subs = new Set();
      topics.set(topic, subs);
    }
    subs.add(ms);
  }

  function detachPtySocket(ms: DashSocket): void {
    const data = ms.data as PtySocketData;
    data.closed = true;
    data.offData?.();
    data.offExit?.();
    data.offData = null;
    data.offExit = null;
  }

  function openPtySocket(ms: DashSocket): void {
    const data = ms.data as PtySocketData;
    const sessionId = data.sessionId;
    const info = ptyManager.get(sessionId);
    if (info === null) {
      safeSend(ms.ws, JSON.stringify({ type: "exit", exitCode: null }));
      ms.ws.close();
      return;
    }
    const back = ptyManager.scrollback(sessionId);
    if (back.length > 0) safeSend(ms.ws, back);
    if (!info.alive) {
      data.closed = true;
      safeSend(ms.ws, JSON.stringify({ type: "exit", exitCode: info.exitCode ?? null }));
      ms.ws.close();
      return;
    }
    data.offData = ptyManager.onData(sessionId, (chunk) => {
      if (!data.closed) safeSend(ms.ws, chunk);
    });
    data.offExit = ptyManager.onExit(sessionId, (exitCode) => {
      if (data.closed) return;
      detachPtySocket(ms);
      safeSend(ms.ws, JSON.stringify({ type: "exit", exitCode }));
      ms.ws.close();
    });
  }

  function handlePtyMessage(ms: DashSocket, msg: string): void {
    const data = ms.data as PtySocketData;
    if (msg.startsWith("{")) {
      try {
        const ctrl = JSON.parse(msg) as { type?: unknown; cols?: unknown; rows?: unknown };
        if (ctrl !== null && typeof ctrl === "object" && ctrl.type === "resize") {
          const cols = Number(ctrl.cols);
          const rows = Number(ctrl.rows);
          if (Number.isInteger(cols) && cols > 0 && Number.isInteger(rows) && rows > 0) {
            ptyManager.resize(data.sessionId, cols, rows);
          }
          return;
        }
      } catch {
        // not a control frame; treat as raw keystrokes below
      }
    }
    ptyManager.write(data.sessionId, msg);
  }

  function sendEnd(ms: DashSocket): void {
    const data = ms.data as RunSocketData;
    if (data.ended) return;
    data.ended = true;
    if (data.tailer !== null) {
      clearInterval(data.tailer);
      tailers.delete(data.tailer);
      data.tailer = null;
    }
    safeSend(ms.ws, JSON.stringify({ type: "end" }));
  }

  async function sendBacklogAndTail(ms: DashSocket): Promise<void> {
    const data = ms.data as RunSocketData;
    const runId = data.runId;
    const events = await hub.readTranscript(runId);
    let sent = events.length;
    safeSend(ms.ws, JSON.stringify({ type: "backlog", events: events.map(backlogEvent) }));
    if (!isRunLive(opts.stateDir, runId)) {
      sendEnd(ms);
      return;
    }
    const tick = async (): Promise<void> => {
      const now = await hub.readTranscript(runId);
      if (now.length > sent) {
        for (const ev of now.slice(sent)) {
          // Every new event goes out with its FULL structure attached; the
          // feed client renders from structure and decides what is visible.
          // `text` stays on the envelope for the legacy text-only consumers
          // (grid/trio) until they migrate to HarnessFeed.
          const text = eventToText(ev);
          safeSend(
            ms.ws,
            JSON.stringify({ type: "event", ...(text === null ? {} : { text }), event: backlogEvent(ev) }),
          );
        }
        sent = now.length;
      }
      if (!isRunLive(opts.stateDir, runId)) sendEnd(ms);
    };
    data.tailer = setInterval(() => {
      void tick();
    }, TAIL_INTERVAL_MS);
    tailers.add(data.tailer);
  }

  function onSocketOpen(ms: DashSocket): void {
    if (ms.data.mode === "pty") {
      openPtySocket(ms);
      return;
    }
    if (ms.data.mode === "runs") {
      subscribe(ms, RUNS_TOPIC);
      safeSend(ms.ws, JSON.stringify({ type: "runs", records: hub.snapshotRuns() }));
      return;
    }
    subscribe(ms, RUN_TOPIC_PREFIX + ms.data.runId);
    const rec = readRunRecord(opts.stateDir, ms.data.runId);
    if (rec !== null) {
      safeSend(ms.ws, JSON.stringify({ type: "record", record: rec }));
    }
    void sendBacklogAndTail(ms);
  }

  function onSocketClose(ms: DashSocket): void {
    sockets.delete(ms);
    for (const topic of ms.topics) {
      const subs = topics.get(topic);
      if (subs === undefined) continue;
      subs.delete(ms);
      if (subs.size === 0) topics.delete(topic);
    }
    if (ms.data.mode === "pty") {
      detachPtySocket(ms);
      return;
    }
    if (ms.data.mode === "run" && ms.data.tailer !== null) {
      clearInterval(ms.data.tailer);
      tailers.delete(ms.data.tailer);
      ms.data.tailer = null;
    }
  }

  // ------- shared route resolution for plain HTTP and upgrade requests ----

  /** Resolve a /ws-family GET to its socket data, or a plain HTTP response
   *  status/body when the request must NOT be upgraded (auth failure, bad
   *  params, unknown session, missing Upgrade header). */
  function resolveWsRoute(
    pathname: string,
    url: URL,
  ): { data: WsData } | { reject: { status: number; message: string } } {
    const ptyWs = PTY_WS_ROUTE.exec(pathname);
    if (ptyWs !== null) {
      if (opts.token !== undefined && url.searchParams.get("token") !== opts.token) {
        return { reject: { status: 401, message: "unauthorized" } };
      }
      let sessionId: string;
      try {
        sessionId = decodeURIComponent(ptyWs[1] as string);
      } catch {
        sessionId = ptyWs[1] as string;
      }
      if (ptyManager.get(sessionId) === null) return { reject: { status: 404, message: "not found" } };
      return { data: { mode: "pty", sessionId, offData: null, offExit: null, closed: false } };
    }

    if (pathname === "/ws") {
      if (opts.token !== undefined && url.searchParams.get("token") !== opts.token) {
        return { reject: { status: 401, message: "unauthorized" } };
      }
      const runsMode = url.searchParams.get("runs") === "1";
      const runId = url.searchParams.get("runId");
      if (runsMode) {
        return { data: { mode: "runs" } };
      }
      if (runId !== null && runId.length > 0) {
        if (readRunRecord(opts.stateDir, runId) === null) return { reject: { status: 404, message: "not found" } };
        return { data: { mode: "run", runId, tailer: null, ended: false } };
      }
      return { reject: { status: 400, message: "missing runs or runId param" } };
    }

    return { reject: { status: 404, message: "not found" } };
  }

  const requestHandler = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const pathname = url.pathname;
        const get = req.method === "GET";

        if (get && (pathname === "/" || pathname === "/index.html")) {
          const page = await readAsset("index.html");
          if (page === null) return notFound(res);
          return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
        }

        if (get && pathname === "/feed.js") {
          const script = await readAsset("feed.js");
          if (script === null) return notFound(res);
          return res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(script);
        }

        if (get && pathname === "/grid") {
          const page = await readAsset("grid.html");
          if (page === null) return notFound(res);
          return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
        }

        if (get && pathname === "/trio") {
          const page = await readAsset("trio.html");
          if (page === null) return notFound(res);
          return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
        }

        if (get && pathname.startsWith("/vendor/")) {
          const raw = pathname.slice("/vendor/".length);
          if (raw.includes("..")) return jsonError(res, 400, "bad path");
          let rel: string;
          try {
            rel = decodeURIComponent(raw);
          } catch {
            return jsonError(res, 400, "bad path");
          }
          if (rel.includes("..") || rel.startsWith("/")) return jsonError(res, 400, "bad path");
          const asset = await readAsset(`vendor/${rel}`);
          if (asset === null) return notFound(res);
          return res.writeHead(200, { "content-type": vendorContentType(rel) }).end(asset);
        }

        if (get && pathname === "/api/runs") {
          return sendJson(res, 200, { records: hub.snapshotRuns() });
        }

        const runAction = RUN_ACTION_ROUTE.exec(pathname);
        if (get && runAction !== null) {
          let runId: string;
          let action: string;
          try {
            runId = decodeURIComponent(runAction[1] as string);
            action = decodeURIComponent(runAction[2] as string);
          } catch {
            runId = runAction[1] as string;
            action = runAction[2] as string;
          }
          const rec = readRunRecord(opts.stateDir, runId);
          if (rec === null) return notFound(res);
          const events = await hub.readTranscript(runId);
          if (action === "cast") {
            const body = eventsToAsciicast(events, { title: runId });
            return res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(body);
          }
          if (action === "observability") {
            return sendJson(res, 200, deriveRunObservability(events));
          }
          return notFound(res);
        }

        if (pathname === "/api/pty") {
          if (get) return sendJson(res, 200, { sessions: ptyManager.list() });
          if (req.method !== "POST") return notFound(res);
          let body: unknown;
          try {
            body = JSON.parse(await readBody(req));
          } catch {
            return jsonError(res, 400, "invalid JSON body");
          }
          const b = body as Record<string, unknown>;
          if (typeof b.command !== "string" || b.command.length === 0) {
            return jsonError(res, 400, "command must be a non-empty string");
          }
          if (b.args !== undefined && (!Array.isArray(b.args) || !b.args.every((a) => typeof a === "string"))) {
            return jsonError(res, 400, "args must be an array of strings");
          }
          if (b.cwd !== undefined && typeof b.cwd !== "string") return jsonError(res, 400, "cwd must be a string");
          if (b.cols !== undefined && (!Number.isInteger(b.cols) || (b.cols as number) < 1)) {
            return jsonError(res, 400, "cols must be a positive integer");
          }
          if (b.rows !== undefined && (!Number.isInteger(b.rows) || (b.rows as number) < 1)) {
            return jsonError(res, 400, "rows must be a positive integer");
          }
          if (b.runId !== undefined && typeof b.runId !== "string") {
            return jsonError(res, 400, "runId must be a string");
          }
          try {
            const info = await ptyManager.spawn({
              command: b.command,
              args: b.args as string[] | undefined,
              cwd: b.cwd as string | undefined,
              cols: b.cols as number | undefined,
              rows: b.rows as number | undefined,
              runId: b.runId as string | undefined,
            });
            return sendJson(res, 201, info);
          } catch (err) {
            return jsonError(res, 400, `spawn failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        const ptyKill = PTY_KILL_ROUTE.exec(pathname);
        if (ptyKill !== null && req.method === "POST") {
          let sessionId: string;
          try {
            sessionId = decodeURIComponent(ptyKill[1] as string);
          } catch {
            sessionId = ptyKill[1] as string;
          }
          if (!ptyManager.kill(sessionId)) return notFound(res);
          return sendJson(res, 200, { ok: true });
        }

        if (pathname === "/ws" || PTY_WS_ROUTE.test(pathname)) {
          // Non-upgrade GETs resolve the same route table so probes get the
          // right status (401/404/400); a well-formed request without an
          // Upgrade header lands here as "upgrade failed" 400.
          if (!get) return notFound(res);
          const resolved = resolveWsRoute(pathname, url);
          if ("reject" in resolved) return jsonError(res, resolved.reject.status, resolved.reject.message);
          return jsonError(res, 400, "upgrade failed");
        }

        return notFound(res);
      } catch (err) {
        process.stderr.write(`web: request handler error: ${err instanceof Error ? err.message : String(err)}\n`);
        if (!res.headersSent) jsonError(res, 500, "internal error");
        else res.end();
      }
    })();
  };

  // ---------------------------- websocket lane ----------------------------

  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  /** Wire one accepted websocket: events, bookkeeping, then open. */
  function acceptSocket(ws: WsSocket, data: WsData): void {
    const ms: DashSocket = { ws, data, alive: true, topics: new Set() };
    sockets.add(ms);
    ws.on("pong", () => {
      ms.alive = true;
    });
    ws.on("message", (msg: RawData) => {
      if (ms.data.mode === "pty") handlePtyMessage(ms, rawToString(msg));
      // dashboard clients never send frames; nothing to do
    });
    ws.on("close", () => onSocketClose(ms));
    ws.on("error", () => {
      // socket-level failure; close handler does the bookkeeping
    });
    onSocketOpen(ms);
  }

  const httpServer = createServer(requestHandler);

  /** Answer a rejected upgrade with a plain HTTP status, then drop the
   *  socket so the client sees an error instead of a hang. */
  function rejectUpgrade(socket: Socket, status: number, message: string): void {
    const reason =
      status === 401 ? "Unauthorized" : status === 404 ? "Not Found" : status === 400 ? "Bad Request" : "Error";
    const body = JSON.stringify({ error: message });
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\n` +
        "content-type: application/json\r\n" +
        `content-length: ${Buffer.byteLength(body)}\r\n` +
        "connection: close\r\n\r\n" +
        body,
    );
    socket.destroy();
  }

  httpServer.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    void (async () => {
      let url: URL;
      try {
        url = new URL(req.url ?? "/", "http://localhost");
      } catch {
        rejectUpgrade(socket, 404, "not found");
        return;
      }
      const pathname = url.pathname;
      if (req.method !== "GET" || (pathname !== "/ws" && !PTY_WS_ROUTE.test(pathname))) {
        rejectUpgrade(socket, 404, "not found");
        return;
      }
      const resolved = resolveWsRoute(pathname, url);
      if ("reject" in resolved) {
        rejectUpgrade(socket, resolved.reject.status, resolved.reject.message);
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        acceptSocket(ws, resolved.data);
      });
    })();
  });

  // Keepalive ping replaces Bun.serve's idleTimeout: browsers answer pings
  // automatically, so live dashboards stay connected and dead peers are
  // terminated within two heartbeat rounds.
  const heartbeat = setInterval(() => {
    for (const ms of sockets) {
      if (!ms.alive) {
        ms.ws.terminate();
        continue;
      }
      ms.alive = false;
      try {
        ms.ws.ping();
      } catch {
        // already dead; terminate next round
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  // Track open TCP sockets for forceful teardown in close().
  const httpSockets = new Set<Socket>();
  httpServer.on("connection", (socket: Socket) => {
    httpSockets.add(socket);
    socket.on("close", () => httpSockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    httpServer.once("error", onError);
    httpServer.listen(opts.port, opts.host, () => {
      httpServer.off("error", onError);
      resolve();
    });
  });

  hub.watchRegistry();

  let closed = false;
  return {
    port: (httpServer.address() as AddressInfo).port,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      hub.close();
      for (const t of tailers) clearInterval(t);
      tailers.clear();
      if (ownsPty) ptyManager.dispose();
      for (const ms of sockets) {
        try {
          ms.ws.close(1001, "server shutdown");
        } catch {
          // already dead
        }
      }
      sockets.clear();
      topics.clear();
      // Bound the teardown wait the way the Bun path did: never hang the
      // process on a socket that refuses to drain.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2000);
        timer.unref();
        const done = (): void => {
          clearTimeout(timer);
          resolve();
        };
        let pending = 2;
        const step = (): void => {
          if (--pending === 0) done();
        };
        wss.close(step);
        httpServer.close(() => {
          for (const s of httpSockets) s.destroy();
          httpSockets.clear();
          step();
        });
      });
    },
  };
}
