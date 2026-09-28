import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { startWebServer } from '../src/web/server.ts';

it('SIGINT preserves completed repeat children for stats and comparison', { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ach-repeat-interrupt-'));
  const state = join(root, 'state');
  await mkdir(state);
  const bin = join(root, 'kiro-cli');
  await writeFile(bin, `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'kiro-cli 2.21.2'; exit 0; fi
if [ -f '${root}/first' ]; then
  touch '${root}/second'
  sleep 30
else
  touch '${root}/first'
fi
echo '{"type":"session_start","sessionId":"session-'$$'"}'
echo '{"type":"assistant","text":"done"}'
`, { mode: 0o755 });
  const cli = new URL('../src/cli/ach.ts', import.meta.url).pathname;
  const launcher = (process.versions as { bun?: string }).bun ? [] : ['--import', import.meta.resolve('tsx')];
  const env = { ...process.env, HOME: root, AGENTIC_CODING_HARNESS_STATE_DIR: state,
    KIRO_CLI_BIN: bin, MITMDUMP_BIN: '/nonexistent/mitmdump' };
  const child = spawn(process.execPath, [...launcher, cli, 'run', '--agent', 'kiro', '--repeat', '5',
    '--verify', 'true', '--experiment', 'interrupt', '--variant', 'A', 'demo'], { env, detached: true, stdio: 'ignore' });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })));
  let server: Awaited<ReturnType<typeof startWebServer>> | undefined;
  try {
    const deadline = Date.now() + 12000;
    while (true) {
      try { await readFile(join(root, 'second')); break; } catch { /* waiting for second launch */ }
      assert.ok(Date.now() < deadline, 'second child must start before interrupt');
      await new Promise((r) => setTimeout(r, 40));
    }
    const files = (await readdir(join(state, 'runs'))).filter((f) => f.endsWith('.json'));
    const before = await Promise.all(files.map(async (f) => ({ file: f, text: await readFile(join(state, 'runs', f), 'utf8') })));
    const completed = before.find((r) => JSON.parse(r.text).repeat?.index === 0);
    assert.ok(completed, 'completed child was annotated before next launch');
    assert.equal(JSON.parse(completed.text).verify.status, 'pass');
    process.kill(-child.pid!, 'SIGINT');
    const result = await exited;
    assert.ok(result.signal === 'SIGINT' || result.code !== 0, 'interruption cannot report success');
    assert.equal(await readFile(join(state, 'runs', completed.file), 'utf8'), completed.text);
    const stats = spawnSync(process.execPath, [...launcher, cli, 'stats', '--json', '--agent', 'kiro'], { env, encoding: 'utf8' });
    assert.equal(stats.status, 0, stats.stderr);
    const groups = JSON.parse(stats.stdout).byRepeatGroup;
    assert.equal(groups.length, 1);
    assert.equal(groups[0].runs, 1);
    assert.equal(groups[0].count, 5);
    assert.equal(groups[0].passed, 1);
    server = await startWebServer({ port: 0, host: '127.0.0.1', token: 'test', stateDir: state });
    const response = await fetch(`http://127.0.0.1:${server.port}/api/compare?by=experiment,variant`);
    assert.equal(response.status, 200);
    const body = await response.json() as { rows: Array<{ experiment?: string; passRate?: number; repeats?: { k: number } }> };
    const row = body.rows.find((r) => r.experiment === 'interrupt');
    assert.equal(row?.passRate, 1);
    assert.equal(row?.repeats?.k, 1);
  } finally {
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already exited */ }
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
});
