// serve — expose the harness MCP server over streamable HTTP (node:http —
// one code path under Bun and Node).
// Registers every tool family (run, inspect, jobs) and answers POST /mcp
// (single or batch JSON-RPC), GET /health, with optional bearer-token auth.
// Without a token (--token or env AGENTIC_CODING_HARNESS_HTTP_TOKEN) the server binds
// loopback only and runs unauthenticated with a stderr warning.
import { parseArgs } from "node:util";
import { HarnessError } from "../core/types.ts";
import { stateDir } from "../core/store.ts";
import { createMcpServer } from "../mcp/server.ts";
import { startHttpServer, type HttpServerHandle } from "../mcp/http.ts";
import { registerHarnessTools } from "../mcp/register-tools.ts";
import { gatewayConfigFromFlags } from "../serve/gateway.ts";

// Distinct from src/cli/web.ts's DEFAULT_PORT (8399) so `harness serve --http`
// and `harness web` can both bind loopback on one host without a manual
// --port pick (observed collision: a running `harness web` on 8399 blocked
// `harness serve --http` from binding).
const DEFAULT_PORT = 8398;
const DEFAULT_HOST = "127.0.0.1";
// Mirrors src/mcp/index.ts (importing it would start the stdio lane).
import { VERSION } from '../version.ts';
const DRAIN_MS = 5_000;

function optPort(v: string | undefined, flag: string): number {
  const n = Number(v ?? DEFAULT_PORT);
  if (!Number.isInteger(n) || n < 0 || n > 65_535) {
    throw new HarnessError(`${flag} expects a port number 0-65535, got '${v}'`, "USAGE");
  }
  return n;
}

/** Recognize a listen failure that means the address is already bound, and
 *  build the operator-facing message for it. Under Bun the old Bun.serve
 *  path threw a plain Error with `code: "EADDRINUSE"` and
 *  `message: "Failed to start server. Is port <N> in use?"`; node:http
 *  (both runtimes now) emits an EADDRINUSE 'error' event with
 *  `message: "listen EADDRINUSE: address already in use ..."` (observed via
 *  live two-process control runs on this host); check both the code and the
 *  message text since callers may pass a wrapped or synthetic error. Returns
 *  null for any other error, which must propagate unchanged. Exported pure
 *  (no socket bound) so it is unit-testable. */
export function describeListenError(err: unknown, host: string, port: number): string | null {
  const code = err !== null && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
  const message = err instanceof Error ? err.message : "";
  const isAddrInUse = code === "EADDRINUSE" || /\bin use\b/i.test(message);
  if (!isAddrInUse) return null;
  return `serve: port ${port} on ${host} is already in use (another harness serve or harness web?); pass --port to choose another`;
}

function optPositiveInt(v: string | undefined, flag: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) {
    throw new HarnessError(`${flag} expects a positive integer, got '${v}'`, "USAGE");
  }
  return n;
}

export async function cmdServe(rest: string[]): Promise<number> {
  const args = parseArgs({
    args: rest,
    options: {
      port: { type: "string" },
      host: { type: "string" },
      token: { type: "string" },
      // Accepted for PLAN.md §C CLI-shape compatibility; serve is the HTTP
      // transport by definition, so the flag is a no-op.
      http: { type: "boolean", default: false },
      // PLAN.md §D gateway profile (seat W4). Flags win over env mirrors —
      // precedence handled inside gatewayConfigFromFlags.
      gateway: { type: "boolean", default: false },
      root: { type: "string" },
      "max-jobs": { type: "string" },
      "max-output-bytes": { type: "string" },
      "allow-extra-args": { type: "string" },
    },
    allowPositionals: true,
  });
  const port = optPort(args.values.port, "--port");
  const gateway = gatewayConfigFromFlags(
    {
      gateway: args.values.gateway,
      root: args.values.root,
      maxJobs: optPositiveInt(args.values["max-jobs"], "--max-jobs"),
      maxOutputBytes: optPositiveInt(args.values["max-output-bytes"], "--max-output-bytes"),
      allowExtraArgs: args.values["allow-extra-args"],
    },
    process.env,
  );
  if (gateway.enabled && gateway.root === undefined) {
    throw new HarnessError(
      "--gateway requires --root (or env AGENTIC_CODING_HARNESS_ROOT)",
      "USAGE",
    );
  }
  // Note: undefined run-tool cwd defers to the server's own cwd by design
  // (PLAN §D) — no boot-time containment gate on process.cwd(); clients may
  // also target any dir the server account can reach, root-policed per call.
  // CLI flag wins over env; when both are unset: warn + force loopback.
  const token = args.values.token ?? (process.env.AGENTIC_CODING_HARNESS_HTTP_TOKEN || undefined);
  let host = args.values.host ?? DEFAULT_HOST;
  if (token === undefined) {
    process.stderr.write("serve: no token set — unauthenticated loopback only\n");
    host = DEFAULT_HOST;
  }

  const server = createMcpServer({ name: "agentic-coding-harness", version: VERSION });
  registerHarnessTools(server, { stateDir: stateDir(), gateway });
  let http: HttpServerHandle;
  try {
    http = await startHttpServer({ server, port, host, token });
  } catch (err) {
    const described = describeListenError(err, host, port);
    if (described !== null) {
      process.stderr.write(`${described}\n`);
      return 1;
    }
    throw err;
  }
  process.stderr.write(`serve: http://${host}:${http.port}/mcp (auth ${token === undefined ? "off" : "on"})\n`);

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    const force = setTimeout(() => process.exit(0), DRAIN_MS);
    force.unref();
    // Drain in-flight requests (≤ DRAIN_MS via the force timer), then exit 0.
    void http.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise<never>(() => {}); // signals own shutdown via shutdown()
  return 0; // unreachable
}
