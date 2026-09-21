// Shared tool registration for every transport lane (stdio `ach mcp` /
// src/mcp/index.ts, HTTP `ach serve` in src/cli/serve.ts). Lives apart from
// src/mcp/index.ts so CLI lanes can import it without triggering that
// entrypoint's self-executing stdio main().
import type { McpServer } from "./contract.ts";
import { registerRunTools } from "./tools-run.ts";
import { registerInspectTools } from "./tools-inspect.ts";
import { registerJobTools } from "./tools-jobs.ts";
import { registerPreflightTools } from "./tools-preflight.ts";
import type { GatewayConfig } from "../serve/gateway.ts";

export function registerHarnessTools(
  server: McpServer,
  opts: { stateDir: string; gateway?: GatewayConfig },
): void {
  registerRunTools(server, opts);
  registerInspectTools(server, opts);
  registerJobTools(server, opts);
  registerPreflightTools(server, { ...(opts.gateway ? { gateway: opts.gateway } : {}) });
}
