// MCP stdio server entrypoint for agent-harness.
//
// Speaks MCP (protocolVersion 2025-06-18) over stdio: newline-delimited
// JSON-RPC on stdout, tolerating Content-Length framing on read. All
// diagnostics go to stderr — stdout carries protocol only.
//
// Client config: see docs/MCP.md.

import { createMcpServer } from './server.ts';
import { registerRunTools } from './tools-run.ts';
import { registerInspectTools } from './tools-inspect.ts';
import { registerJobTools } from './tools-jobs.ts';
import { stateDir } from '../core/store.ts';

const VERSION = '0.3.0';

async function main(): Promise<void> {
  const server = createMcpServer({ name: 'agent-harness', version: VERSION });
  const opts = { stateDir: stateDir() };
  registerRunTools(server, opts);
  registerInspectTools(server, opts);
  registerJobTools(server, opts);
  await server.serve();
}

main().catch((err) => {
  process.stderr.write(`harness-mcp: fatal — ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
