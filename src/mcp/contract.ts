// Contract for the harness MCP server. All seats code against THIS file.
// JSON-RPC 2.0 over stdio, newline-delimited (one message per line, no
// Content-Length headers — the "NDJSON stdio" variant used by bun-based
// servers; server must also tolerate Content-Length framing on read).

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpToolDef {
  name: string;
  description: string;
  /** JSON Schema object for the tool's arguments. */
  inputSchema: Record<string, unknown>;
  /** Execute the tool. Throw on failure — the server maps throws to
   *  JSON-RPC error responses with the error message. */
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

/** Implemented by src/mcp/server.ts (S1). Pure plumbing — no harness imports. */
export interface McpServer {
  registerTool(def: McpToolDef): void;
  /** Reads stdin, writes stdout. Resolves when stdin closes. */
  serve(): Promise<void>;
  /** Handle one parsed JSON-RPC message (any lane). Resolves with the
   *  response, or null for notifications (no id, or notifications/* method)
   *  — which get no response at all. Never rejects: handler throws are
   *  mapped to a -32603 error response naming the message. */
  dispatch(msg: JsonRpcRequest): Promise<JsonRpcResponse | null>;
}

/** S1 exports this factory from src/mcp/server.ts. */
export declare function createMcpServer(opts: {
  name: string;
  version: string;
}): McpServer;

// MCP method surface the server must answer:
//   initialize            -> { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name, version } }
//   notifications/initialized -> (no response)
//   tools/list            -> { tools: [{ name, description, inputSchema }] }
//   tools/call            -> { content: [{ type: 'text', text: <JSON-stringified handler result> }] }
//   ping                  -> {}
// Unknown method -> error -32601. Parse error -> -32700. Handler throw -> -32603 with message.
