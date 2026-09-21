// mcp — run the harness MCP server over stdio: newline-delimited JSON-RPC on
// stdout (Content-Length framing tolerated), diagnostics on stderr. Same tool
// surface and gateway profile flags as `ach serve` (PLAN.md §D).
import { parseArgs } from "node:util";
import { HarnessError } from "../core/types.ts";
import { stateDir } from "../core/store.ts";
import { createMcpServer } from "../mcp/server.ts";
import { registerHarnessTools } from "../mcp/register-tools.ts";
import { gatewayConfigFromFlags } from "../serve/gateway.ts";
import { VERSION } from "../version.ts";

function optPositiveInt(v: string | undefined, flag: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) {
    throw new HarnessError(`${flag} expects a positive integer, got '${v}'`, "USAGE");
  }
  return n;
}

export async function cmdMcp(rest: string[]): Promise<number> {
  const args = parseArgs({
    args: rest,
    options: {
      gateway: { type: "boolean", default: false },
      root: { type: "string" },
      "max-jobs": { type: "string" },
      "max-output-bytes": { type: "string" },
      "allow-extra-args": { type: "string" },
    },
    allowPositionals: true,
  });
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
  const server = createMcpServer({ name: "agentic-coding-harness", version: VERSION });
  registerHarnessTools(server, { stateDir: stateDir(), gateway });
  try {
    await server.serve();
  } catch (err) {
    process.stderr.write(`mcp: fatal — ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  return 0;
}
