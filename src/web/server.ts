// Dashboard web server: static assets, run JSON API, asciicast replays,
// and the /ws endpoints (runs list broadcast + per-run live tail).
//
// Live per-run text is NOT taken from the hub topic: hub broadcasts carry
// raw AgentEvents, which the dashboard cannot render. Instead each run
// socket runs its own transcript tailer that forwards eventToText output.
import type { Server, ServerWebSocket } from "bun";
import type { AgentEvent } from "../core/types.ts";
import { readRunRecord } from "../core/registry.ts";
import { createRunEventHub, RUN_TOPIC_PREFIX, RUNS_TOPIC } from "./hub.ts";
import { eventToText, eventsToAsciicast } from "./asciicast.ts";
import { deriveRunObservability } from "./derive.ts";

export interface WebServerOptions {
  port: number;
  host: string;
  token?: string;
  stateDir: string;
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

type WsData = RunsSocketData | RunSocketData;

const NOT_LIVE_AFTER_MS = 60_000;
const TAIL_INTERVAL_MS = 500;
const RUN_ACTION_ROUTE = /^\/api\/runs\/([^/]+)\/([^/]+)$/;

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

function notFound(): Response {
  return jsonError(404, "not found");
}

async function servePage(fileName: string): Promise<Response> {
  const file = Bun.file(new URL(`./${fileName}`, import.meta.url));
  if (!(await file.exists())) return notFound();
  return new Response(file, { headers: { "content-type": "text/html; charset=utf-8" } });
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

function safeSend(ws: ServerWebSocket<WsData>, payload: string): void {
  try {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  } catch {
    // socket died mid-send; the tailer stops via the close handler
  }
}

function isRunLive(stateDir: string, runId: string): boolean {
  const rec = readRunRecord(stateDir, runId);
  if (rec === null) return false;
  return rec.status === "running" && Date.now() - rec.updatedAt <= NOT_LIVE_AFTER_MS;
}

export function startWebServer(opts: WebServerOptions): WebServerHandle {
  const hub = createRunEventHub(opts.stateDir);
  const tailers = new Set<ReturnType<typeof setInterval>>();

  function sendEnd(ws: ServerWebSocket<RunSocketData>): void {
    if (ws.data.ended) return;
    ws.data.ended = true;
    if (ws.data.tailer !== null) {
      clearInterval(ws.data.tailer);
      tailers.delete(ws.data.tailer);
      ws.data.tailer = null;
    }
    safeSend(ws, JSON.stringify({ type: "end" }));
  }

  async function sendBacklogAndTail(ws: ServerWebSocket<RunSocketData>): Promise<void> {
    const runId = ws.data.runId;
    const events = await hub.readTranscript(runId);
    let sent = events.length;
    safeSend(ws, JSON.stringify({ type: "backlog", events: events.map(backlogEvent) }));
    if (!isRunLive(opts.stateDir, runId)) {
      sendEnd(ws);
      return;
    }
    const tick = async (): Promise<void> => {
      const now = await hub.readTranscript(runId);
      if (now.length > sent) {
        for (const ev of now.slice(sent)) {
          const text = eventToText(ev);
          if (text !== null) {
            safeSend(ws, JSON.stringify({ type: "event", text, event: { text } }));
          }
        }
        sent = now.length;
      }
      if (!isRunLive(opts.stateDir, runId)) sendEnd(ws);
    };
    ws.data.tailer = setInterval(() => {
      void tick();
    }, TAIL_INTERVAL_MS);
    tailers.add(ws.data.tailer);
  }

  const server = Bun.serve<WsData>({
    port: opts.port,
    hostname: opts.host,
    idleTimeout: 240,
    async fetch(req: Request, srv: Server<WsData>): Promise<Response | undefined> {
      const url = new URL(req.url);
      const pathname = url.pathname;
      const get = req.method === "GET";

      if (get && (pathname === "/" || pathname === "/index.html")) {
        return servePage("index.html");
      }

      if (get && pathname === "/grid") {
        return servePage("grid.html");
      }

      if (get && pathname === "/trio") {
        return servePage("trio.html");
      }

      if (get && pathname.startsWith("/vendor/")) {
        const raw = pathname.slice("/vendor/".length);
        if (raw.includes("..")) return jsonError(400, "bad path");
        let rel: string;
        try {
          rel = decodeURIComponent(raw);
        } catch {
          return jsonError(400, "bad path");
        }
        if (rel.includes("..") || rel.startsWith("/")) return jsonError(400, "bad path");
        const file = Bun.file(new URL(`./vendor/${rel}`, import.meta.url));
        if (!(await file.exists())) return notFound();
        return new Response(file, { headers: { "content-type": vendorContentType(rel) } });
      }

      if (get && pathname === "/api/runs") {
        return Response.json({ records: hub.snapshotRuns() });
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
        if (rec === null) return notFound();
        const events = await hub.readTranscript(runId);
        if (action === "cast") {
          const body = eventsToAsciicast(events, { title: runId });
          return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
        }
        if (action === "observability") {
          return Response.json(deriveRunObservability(events));
        }
        return notFound();
      }

      if (pathname === "/ws") {
        if (!get) return notFound();
        if (opts.token !== undefined && url.searchParams.get("token") !== opts.token) {
          return jsonError(401, "unauthorized");
        }
        const runsMode = url.searchParams.get("runs") === "1";
        const runId = url.searchParams.get("runId");
        let data: WsData;
        if (runsMode) {
          data = { mode: "runs" };
        } else if (runId !== null && runId.length > 0) {
          if (readRunRecord(opts.stateDir, runId) === null) return notFound();
          data = { mode: "run", runId, tailer: null, ended: false };
        } else {
          return jsonError(400, "missing runs or runId param");
        }
        if (srv.upgrade(req, { data })) return undefined;
        return jsonError(400, "upgrade failed");
      }

      return notFound();
    },
    websocket: {
      open(ws: ServerWebSocket<WsData>): void {
        if (ws.data.mode === "runs") {
          ws.subscribe(RUNS_TOPIC);
          safeSend(ws, JSON.stringify({ type: "runs", records: hub.snapshotRuns() }));
          return;
        }
        ws.subscribe(RUN_TOPIC_PREFIX + ws.data.runId);
        const rec = readRunRecord(opts.stateDir, ws.data.runId);
        if (rec !== null) {
          safeSend(ws, JSON.stringify({ type: "record", record: rec }));
        }
        void sendBacklogAndTail(ws as ServerWebSocket<RunSocketData>);
      },
      message(_ws: ServerWebSocket<WsData>, _msg: string | Buffer): void {
        // dashboard clients never send frames; nothing to do
      },
      close(ws: ServerWebSocket<WsData>): void {
        if (ws.data.mode === "run" && ws.data.tailer !== null) {
          clearInterval(ws.data.tailer);
          tailers.delete(ws.data.tailer);
          ws.data.tailer = null;
        }
      },
    },
  });

  hub.attach(server);
  hub.watchRegistry();

  return {
    port: server.port ?? opts.port,
    async close(): Promise<void> {
      hub.close();
      for (const t of tailers) clearInterval(t);
      tailers.clear();
      await server.stop(true);
    },
  };
}
