// MCP stdio server entrypoint for agentic-coding-harness.
//
// Speaks MCP (protocolVersion 2025-06-18) over stdio: newline-delimited
// JSON-RPC on stdout, tolerating Content-Length framing on read. All
// diagnostics go to stderr — stdout carries protocol only.
//
// Client config: see docs/MCP.md.

import { createMcpServer } from './server.ts';
import { registerHarnessTools } from './register-tools.ts';
import { stateDir } from '../core/store.ts';

import { VERSION } from '../version.ts';

async function main(): Promise<void> {
  const server = createMcpServer({ name: 'agentic-coding-harness', version: VERSION });
  registerHarnessTools(server, { stateDir: stateDir() });
  await server.serve();
}

main().catch((err) => {
  process.stderr.write(`harness-mcp: fatal — ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
