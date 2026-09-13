// Streamable HTTP transport for the harness MCP server, built on node:http
// (Bun implements node:http, so this one code path serves both runtimes).
// One endpoint shape, PLAN.md §C: POST /mcp accepts a single JSON-RPC
// message or a batch array and answers plain application/json (no SSE
// streams for v1); GET /health is an unauthenticated readiness probe;
// everything else is 404, wrong verb 405.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { JsonRpcRequest, JsonRpcResponse, McpServer } from "./contract.ts";
import { VERSION } from "../version.ts";

export interface HttpServerHandle {
  /** The actually-bound port (differs from the requested one when port 0). */
  port: number;
  /** Stop accepting new connections, wait for in-flight requests, then
   *  force-close idle keep-alive sockets. Resolves once drained. */
  close(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function notAllowed(res: ServerResponse, allow: "POST" | "GET"): void {
  res.writeHead(405, { allow }).end("method not allowed");
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function startHttpServer(opts: {
  server: McpServer;
  port: number;
  host: string;
  token?: string;
}): Promise<HttpServerHandle> {
  const unauthorized: JsonRpcResponse = {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32600, message: "unauthorized" },
  };

  let inFlight = 0;
  let drained: (() => void) | null = null;

  const dispatchOne = async (msg: unknown): Promise<JsonRpcResponse | null> =>
    opts.server.dispatch(msg as JsonRpcRequest);

  const handlePostMcp = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Auth before anything else, including body parsing.
    if (opts.token !== undefined && req.headers.authorization !== `Bearer ${opts.token}`) {
      sendJson(res, 401, unauthorized);
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    if (Array.isArray(body)) {
      // Batch: every message dispatched; notifications dropped from the
      // response. An all-notification batch answers with an empty array.
      const responses = (await Promise.all(body.map(dispatchOne))).filter(
        (r): r is JsonRpcResponse => r !== null,
      );
      sendJson(res, 200, responses);
      return;
    }
    if (typeof body !== "object" || body === null) {
      sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
      return;
    }
    const response = await dispatchOne(body);
    // Single notification → no JSON-RPC response body (MCP streamable HTTP
    // answers notifications with 202 Accepted).
    if (response === null) res.writeHead(202).end();
    else sendJson(res, 200, response);
  };

  const requestHandler = (req: IncomingMessage, res: ServerResponse): void => {
    inFlight++;
    void (async () => {
      try {
        const { pathname } = new URL(req.url ?? "/", "http://localhost");
        if (pathname === "/health") {
          if (req.method !== "GET") return notAllowed(res, "GET");
          return sendJson(res, 200, { status: "ok", version: VERSION });
        }
        if (pathname === "/mcp") {
          if (req.method !== "POST") return notAllowed(res, "POST");
          return await handlePostMcp(req, res);
        }
        return sendJson(res, 404, { error: "not found" });
      } catch (err) {
        process.stderr.write(`serve: request handler error: ${err instanceof Error ? err.message : String(err)}\n`);
        if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
        else res.end();
      } finally {
        inFlight--;
        if (inFlight === 0 && drained) {
          const done = drained;
          drained = null;
          done();
        }
      }
    })();
  };

  // node:http (and Bun's implementation of it) does not throw listen
  // failures synchronously — it emits 'error' on the server.
  const server = createServer(requestHandler);

  // Track every open socket so close() can force idle keep-alives after
  // the in-flight drain (Server#close alone waits for them forever).
  const sockets = new Set<{ destroy(): void }>();
  server.on("connection", (socket: { on: (ev: string, cb: () => void) => void; destroy(): void }) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once("error", onError);
    server.listen(opts.port, opts.host, () => {
      server.off("error", onError);
      resolve();
    });
  });

  let closed = false;
  return {
    // For a TCP listen, address() is always an AddressInfo once listening.
    port: (server.address() as AddressInfo).port,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      server.close(); // stop accepting; in-flight requests keep running
      if (inFlight > 0) {
        await new Promise<void>((resolve) => {
          drained = resolve;
        });
      }
      // All remaining sockets are idle keep-alives: force-close them.
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
  };
}
