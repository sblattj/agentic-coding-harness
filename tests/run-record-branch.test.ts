// #47: the driver stamps the git branch of the run's cwd on the RunRecord at
// run start. Same in-process e2e shape as mcp-run-record.test.ts (PATH-shimmed
// `claude`), once inside a temp git repo and once in a plain directory.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { readRunRecord } from '../src/core/registry.ts';
import { createMcpServer } from '../src/mcp/server.ts';
import { registerRunTools } from '../src/mcp/tools-run.ts';

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'run-record-branch-')));
const STATE_DIR = join(ROOT, 'state');
const SHIM_DIR = join(ROOT, 'shim');
const ORIG_PATH = process.env.PATH;
const NDJSON = (sid: string) =>
  [
    `{"type":"system","subtype":"init","cwd":"${ROOT}","session_id":"${sid}","tools":[],"model":"claude-sonnet-4-5-20250929","permissionMode":"default","version":"2.0.14","output_style":"default"}`,
    `{"type":"result","subtype":"success","is_error":false,"duration_ms":12,"duration_api_ms":11,"num_turns":1,"result":"hi","session_id":"${sid}","total_cost_usd":0.0077,"usage":{"input_tokens":9,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":4,"service_tier":"standard"},"permission_denials":[]}`,
  ].join('\n');

after(() => {
  process.env.PATH = ORIG_PATH;
});

async function runIn(cwd: string, sid: string) {
  const server = createMcpServer({ name: 'test', version: '0' });
  registerRunTools(server, { stateDir: STATE_DIR });
  const res = await server.dispatch({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'harness_run', arguments: { agent: 'claude', prompt: 'hi', cwd } },
  });
  assert.ok(res?.result, JSON.stringify(res?.error ?? res));
  const content = (res.result as { content: Array<{ text: string }> }).content;
  const run = JSON.parse(content[0].text) as { runId: string };
  void sid;
  return readRunRecord(STATE_DIR, run.runId);
}

describe('driver records git branch on the RunRecord (#47)', () => {
  it('records branch+commit in a repo; records neither (and succeeds) in a plain dir', { timeout: 60_000 }, async () => {
    mkdirSync(SHIM_DIR, { recursive: true });
    const shim = join(SHIM_DIR, 'claude');
    writeFileSync(shim, `#!/bin/sh\ncat <<'HARNESS_NDJSON_EOF'\n${NDJSON('sess-branch-1')}\nHARNESS_NDJSON_EOF\n`);
    chmodSync(shim, 0o755);
    process.env.PATH = `${SHIM_DIR}:${ORIG_PATH}`;

    const repo = join(ROOT, 'repo');
    const plain = join(ROOT, 'plain');
    mkdirSync(repo);
    mkdirSync(plain);
    const g = (...a: string[]) => {
      const p = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd: repo, encoding: 'utf8' });
      assert.equal(p.status, 0, p.stderr);
    };
    g('init', '-q', '-b', 'wip/spend');
    writeFileSync(join(repo, 'f'), '1');
    g('add', 'f');
    g('commit', '-q', '-m', 'c');

    const inRepo = await runIn(repo, 'a');
    assert.equal(inRepo?.status, 'success');
    assert.equal(inRepo?.branch, 'wip/spend');
    assert.match(inRepo?.commit ?? '', /^[0-9a-f]{7}$/);

    const outside = await runIn(plain, 'b');
    assert.equal(outside?.status, 'success');
    assert.equal(outside?.branch, undefined);
    assert.equal(outside?.commit, undefined);
  });
});
