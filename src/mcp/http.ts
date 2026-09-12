// Streamable HTTP transport for the harness MCP server (Bun.serve — this
// repo runs on bun; do not port to node:http). One endpoint shape, PLAN.md
// §C: POST /mcp accepts a single JSON-RPC message or a batch array and
// answers plain application/json (no SSE streams for v1); GET /health is an
// unauthenticated readiness probe; everything else is 404, wrong verb 405.
import fs from "node:fs/promises";
import type { JsonRpcRequest, JsonRpcResponse, McpServer } from "./contract.ts";

export interface HttpServerHandle {
  /** The actually-bound port (differs from the requested one when port 0). */
  port: number;
  /** Stop accepting new connections, wait for in-flight requests, then
   *  force-close idle keep-alive sockets. Resolves once drained. */
  close(): Promise<void>;
}

// Same source of truth and fallback as src/report/html.ts readVersion.
async function readVersion(): Promise<string> {
  try {
    const raw = await fs.readFile(new URL("../../package.json", import.meta.url), "utf8");
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    if (typeof v === "string" && v !== "") return v;
  } catch {
    /* bundled/standalone builds fall through */
  }
  return "0.3.0";
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function notAllowed(allow: "POST" | "GET"): Response {
  return new Response("method not allowed", { status: 405, headers: { allow } });
}

export async function startHttpServer(opts: {
  server: McpServer;
  port: number;
  host: string;
  token?: string;
}): Promise<HttpServerHandle> {
  const version = await readVersion();
  const unauthorized: JsonRpcResponse = {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32600, message: "unauthorized" },
  };

  let inFlight = 0;
  let drained: (() => void) | null = null;

  const dispatchOne = async (msg: unknown): Promise<JsonRpcResponse | null> =>
    opts.server.dispatch(msg as JsonRpcRequest);

  const handlePostMcp = async (req: Request): Promise<Response> => {
    // Auth before anything else, including body parsing.
    if (opts.token !== undefined && req.headers.get("authorization") !== `Bearer ${opts.token}`) {
      return json(401, unauthorized);
    }
    let body: unknown;
    try {
      body = JSON.parse(await req.text());
    } catch {
      return json(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    if (Array.isArray(body)) {
      // Batch: every message dispatched; notifications dropped from the
      // response. An all-notification batch answers with an empty array.
      const responses = (await Promise.all(body.map(dispatchOne))).filter(
        (r): r is JsonRpcResponse => r !== null,
      );
      return json(200, responses);
    }
    if (typeof body !== "object" || body === null) {
      return json(400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
    }
    const response = await dispatchOne(body);
    // Single notification → no JSON-RPC response body (MCP streamable HTTP
    // answers notifications with 202 Accepted).
    if (response === null) return new Response(null, { status: 202 });
    return json(200, response);
  };

  const srv = Bun.serve({
    port: opts.port,
    hostname: opts.host,
    async fetch(req) {
      inFlight++;
      try {
        const { pathname } = new URL(req.url);
        if (pathname === "/health") {
          if (req.method !== "GET") return notAllowed("GET");
          return json(200, { status: "ok", version });
        }
        if (pathname === "/mcp") {
          if (req.method !== "POST") return notAllowed("POST");
          return await handlePostMcp(req);
        }
        return json(404, { error: "not found" });
      } finally {
        inFlight--;
        if (inFlight === 0 && drained) {
          const done = drained;
          drained = null;
          done();
        }
      }
    },
  });

  return {
    // bun-types types Server.port as number | undefined (unix-socket
    // servers); for a TCP listen it is always set once Bun.serve returns.
    port: srv.port!,
    async close(): Promise<void> {
      srv.stop(false); // stop accepting; in-flight requests keep running
      if (inFlight > 0) {
        await new Promise<void>((resolve) => {
          drained = resolve;
        });
      }
      srv.stop(true); // force-close idle keep-alive sockets
    },
  };
}
