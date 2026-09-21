// Issue #16 regression: the SYNC harness_run MCP tool must pass
// registry: { stateDir } to createDriver so the per-run RunRecord lands in
// <stateDir>/runs/<runId>.json, exactly like ach run and harness_run_async.
// In-process e2e: PATH-shimmed `claude` prints the NDJSON the adapter parses,
// so the whole createDriver -> spawn -> parse -> registry path runs for real.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { readRunRecord } from '../src/core/registry.ts';
import { createMcpServer } from '../src/mcp/server.ts';
import { registerRunTools } from '../src/mcp/tools-run.ts';

const STATE_DIR = mkdtempSync(join(tmpdir(), 'mcp-run-record-state-'));
const SHIM_DIR = mkdtempSync(join(tmpdir(), 'mcp-run-record-shim-'));
const ORIG_PATH = process.env.PATH;

const SESSION_ID = 'harness-run-record-test-0001';
const NDJSON_LINES = [
  `{"type":"system","subtype":"init","cwd":"${STATE_DIR}","session_id":"${SESSION_ID}","tools":[],"model":"claude-sonnet-4-5-20250929","permissionMode":"default","version":"2.0.14","output_style":"default"}`,
  `{"type":"result","subtype":"success","is_error":false,"duration_ms":12,"duration_api_ms":11,"num_turns":1,"result":"hi","session_id":"${SESSION_ID}","total_cost_usd":0.0077,"usage":{"input_tokens":9,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":4,"service_tier":"standard"},"modelUsage":{"claude-sonnet-4-5-20250929":{"inputTokens":9,"cacheCreationInputTokens":0,"cacheReadInputTokens":0,"outputTokens":4,"reasoningTokens":0,"serviceTier":"standard","contextWindow":200000,"webSearchRequests":0,"costUSD":0.0077}},"permission_denials":[]}`,
].join('\n');

after(() => {
  process.env.PATH = ORIG_PATH;
});

describe('harness_run persists its RunRecord to the run registry (#16)', () => {
  it('writes runs/<runId>.json on the sync MCP path', { timeout: 30_000 }, async () => {
    const shim = join(SHIM_DIR, 'claude');
    writeFileSync(shim, `#!/bin/sh\ncat <<'HARNESS_NDJSON_EOF'\n${NDJSON_LINES}\nHARNESS_NDJSON_EOF\n`);
    chmodSync(shim, 0o755);
    process.env.PATH = `${SHIM_DIR}:${ORIG_PATH}`;

    const server = createMcpServer({ name: 'test', version: '0' });
    registerRunTools(server, { stateDir: STATE_DIR });
    const res = await server.dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'harness_run',
        arguments: { agent: 'claude', prompt: 'say hi' },
      },
    });
    assert.ok(res?.result, `expected a JSON-RPC result, got ${JSON.stringify(res?.error ?? res)}`);
    const content = (res.result as { content: Array<{ type: string; text: string }> }).content;
    const run = JSON.parse(content[0].text) as { runId?: string };
    assert.ok(typeof run.runId === 'string' && run.runId.length > 0, 'RunResult must carry runId');

    const file = join(STATE_DIR, 'runs', `${run.runId}.json`);
    assert.ok(existsSync(file), `expected the RunRecord file on disk at ${file}`);

    const rec = readRunRecord(STATE_DIR, run.runId);
    assert.ok(rec, `readRunRecord(STATE_DIR, ${run.runId}) must be non-null`);
    assert.equal(rec?.agent, 'claude');
    assert.equal(rec?.status, 'success');
    assert.equal(rec?.sessionId, SESSION_ID);
  });
});
