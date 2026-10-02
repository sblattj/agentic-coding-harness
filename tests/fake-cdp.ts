// Reusable fake CDP endpoint for kiro-ide tests: an http server on 127.0.0.1:0
// serving /json/list and /json/version, plus one ws server per fake target.
import http from "node:http";
import type net from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

export interface FakeContext {
  id: number;
  name: string;
  origin: string;
}

export interface FakeCall {
  targetId: string;
  method: string;
  params: any;
  contextId?: number;
}

/** Return a value for the CDP `result`, or throw / return {__error} to emit a CDP error. Return NO_REPLY to never answer. */
export type FakeHandler = (method: string, params: any, contextId?: number) => unknown | Promise<unknown>;

export const NO_REPLY = Symbol("no-reply");

export interface FakeTargetSpec {
  id: string;
  type: string;
  url: string;
  title?: string;
  contexts?: FakeContext[];
  handler?: FakeHandler;
}

export interface FakeCdpSpec {
  targets: FakeTargetSpec[];
  version?: Record<string, unknown>;
}

export interface FakeCdp {
  endpoint: string;
  calls: FakeCall[];
  /** Push an event frame to every connected socket of a target. */
  emit(targetId: string, method: string, params: unknown): void;
  close(): Promise<void>;
}

export async function startFakeCdp(spec: FakeCdpSpec): Promise<FakeCdp> {
  const calls: FakeCall[] = [];
  const sockets = new Map<string, Set<WebSocket>>();
  const wsServers: WebSocketServer[] = [];
  const wsPorts = new Map<string, number>();

  for (const t of spec.targets) {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    wsServers.push(wss);
    sockets.set(t.id, new Set());
    wss.on("connection", (ws) => {
      sockets.get(t.id)!.add(ws);
      ws.on("close", () => sockets.get(t.id)!.delete(ws));
      ws.on("message", async (raw) => {
        const msg = JSON.parse(raw.toString());
        const contextId: number | undefined = msg.params?.contextId;
        calls.push({ targetId: t.id, method: msg.method, params: msg.params, contextId });
        if (msg.method === "Runtime.enable") {
          ws.send(JSON.stringify({ id: msg.id, result: {} }));
          for (const c of t.contexts ?? []) {
            ws.send(JSON.stringify({ method: "Runtime.executionContextCreated", params: { context: c } }));
          }
          return;
        }
        try {
          const result = t.handler ? await t.handler(msg.method, msg.params, contextId) : {};
          if (result === NO_REPLY) return;
          if (result && typeof result === "object" && "__error" in (result as any)) {
            ws.send(JSON.stringify({ id: msg.id, error: { code: -32000, message: String((result as any).__error) } }));
          } else {
            ws.send(JSON.stringify({ id: msg.id, result: result ?? {} }));
          }
        } catch (e) {
          ws.send(JSON.stringify({ id: msg.id, error: { code: -32000, message: e instanceof Error ? e.message : String(e) } }));
        }
      });
    });
    wsPorts.set(t.id, await new Promise<number>((resolve) => wss.on("listening", () => resolve((wss.address() as net.AddressInfo).port))));
  }

  const server = http.createServer((req, res) => {
    const json = (v: unknown) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(v));
    };
    if (req.url === "/json/list") {
      return json(
        spec.targets.map((t) => ({
          id: t.id,
          type: t.type,
          url: t.url,
          title: t.title ?? "",
          webSocketDebuggerUrl: `ws://127.0.0.1:${wsPorts.get(t.id)}/devtools/page/${t.id}`,
        })),
      );
    }
    if (req.url === "/json/version") {
      return json(spec.version ?? { Browser: "Chrome/152.0.7977.130", "User-Agent": "Mozilla/5.0 Kiro/1.2.4", "Protocol-Version": "1.3" });
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;

  return {
    endpoint: `127.0.0.1:${port}`,
    calls,
    emit(targetId, method, params) {
      for (const ws of sockets.get(targetId) ?? []) ws.send(JSON.stringify({ method, params }));
    },
    async close() {
      for (const set of sockets.values()) for (const ws of set) ws.terminate();
      await Promise.all(wsServers.map((w) => new Promise<void>((r) => w.close(() => r()))));
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
