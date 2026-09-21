import { z } from 'zod';
import type { JsonRpcRequest, JsonRpcResponse, McpServer, McpToolDef } from './contract.js';

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

const PROTOCOL_VERSION = '2025-06-18';

/**
 * Stream framing for MCP stdio: accepts both newline-delimited JSON (one
 * message per line) and Content-Length framing (headers + byte-counted body).
 * The mode is re-detected per message so the two framings may be interleaved.
 * Bodies under Content-Length may contain newlines, which is why NDJSON
 * splitting never runs inside headers mode.
 */
export class FramingParser {
  private buf = '';
  private mode: 'detect' | 'ndjson' | 'headers' = 'detect';

  push(chunk: string): string[] {
    this.buf += chunk;
    const out: string[] = [];
    for (;;) {
      if (this.mode === 'detect') {
        this.buf = this.buf.replace(/^[\r\n]+/, '');
        if (this.buf.length === 0) return out;
        this.mode = /^content-length\s*:/i.test(this.buf) ? 'headers' : 'ndjson';
        continue;
      }
      if (this.mode === 'ndjson') {
        const idx = this.buf.indexOf('\n');
        if (idx < 0) return out;
        const line = this.buf.slice(0, idx).trim();
        this.buf = this.buf.slice(idx + 1);
        this.mode = 'detect';
        if (line) out.push(line);
        continue;
      }
      const headEnd = this.buf.indexOf('\r\n\r\n');
      if (headEnd < 0) return out;
      const m = /content-length\s*:\s*(\d+)/i.exec(this.buf.slice(0, headEnd));
      if (!m) {
        this.buf = this.buf.slice(headEnd + 4);
        this.mode = 'detect';
        continue;
      }
      const len = Number(m[1]);
      const bodyStart = headEnd + 4;
      if (this.buf.length - bodyStart < len) return out;
      const body = this.buf.slice(bodyStart, bodyStart + len).trim();
      this.buf = this.buf.slice(bodyStart + len);
      this.mode = 'detect';
      if (body) out.push(body);
    }
  }
}

const ToolCallParamsSchema = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

function errorResponse(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export function createMcpServer(opts: { name: string; version: string }): McpServer {
  const tools = new Map<string, McpToolDef>();

  const writeLine = (text: string): void => {
    process.stdout.write(text + '\n');
  };
  const send = (response: JsonRpcResponse): void => {
    writeLine(JSON.stringify(response));
  };
  const sendJsonArray = (responses: JsonRpcResponse[]): void => {
    writeLine(JSON.stringify(responses));
  };

  // Shared by every transport lane (stdio below, HTTP in src/mcp/http.ts).
  // Notifications (no id, or the notifications/* surface) never get a
  // response — including unknown notification methods.
  const dispatch = async (msg: JsonRpcRequest): Promise<JsonRpcResponse | null> => {
    if (
      typeof msg !== "object" ||
      msg === null ||
      typeof msg.method !== "string" ||
      msg.method.length === 0
    ) {
      if (typeof msg === "object" && msg !== null && "id" in msg) {
        return errorResponse(
          (msg as { id: string | number | null }).id,
          INVALID_REQUEST,
          "Invalid request",
        );
      }
      return null;
    }
    const method = msg.method;
    const hasId = 'id' in msg;
    const id = hasId ? msg.id : null;
    if (!hasId || method.startsWith('notifications/')) return null;

    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: opts.name, version: opts.version },
          },
        };
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: [...tools.values()].map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          },
        };
      case 'tools/call': {
        try {
          const parsed = ToolCallParamsSchema.safeParse(msg.params);
          if (!parsed.success) {
            return errorResponse(id, INVALID_PARAMS, 'Invalid params for tools/call');
          }
          const tool = tools.get(parsed.data.name);
          if (!tool) {
            return errorResponse(id, INVALID_PARAMS, `Unknown tool: ${parsed.data.name}`);
          }
          const result = await tool.handler(parsed.data.arguments ?? {});
          const text =
            typeof result === 'string'
              ? result
              : (JSON.stringify(result, null, 2) ?? String(result));
          return {
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text }] },
          };
        } catch (err) {
          return errorResponse(
            id,
            INTERNAL_ERROR,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      default:
        return errorResponse(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  };

  const handleMessage = async (text: string): Promise<void> => {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      send(errorResponse(null, PARSE_ERROR, 'Parse error'));
      return;
    }
    if (Array.isArray(raw)) {
      const responses = (
        await Promise.all(raw.map((m: unknown) => dispatch(m as JsonRpcRequest)))
      ).filter((r): r is JsonRpcResponse => r !== null);
      sendJsonArray(responses);
      return;
    }
    if (typeof raw !== 'object' || raw === null) {
      send(errorResponse(null, INVALID_REQUEST, 'Invalid request'));
      return;
    }

    const response = await dispatch(raw as JsonRpcRequest);
    if (response) send(response);
  };

  const parser = new FramingParser();

  return {
    registerTool(def: McpToolDef): void {
      tools.set(def.name, def);
    },
    dispatch,
    serve(): Promise<void> {
      const stdin = process.stdin;
      stdin.setEncoding('utf8');
      return new Promise<void>((resolve, reject) => {
        stdin.on('data', (chunk: string) => {
          for (const message of parser.push(chunk)) {
            void handleMessage(message);
          }
        });
        stdin.on('end', () => resolve());
        stdin.on('error', (err: Error) => reject(err));
      });
    },
  };
}

export const __testables__ = { FramingParser };
