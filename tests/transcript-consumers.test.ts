import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { archiveTranscripts, restoreBatch, scanWarehouse } from '../src/core/warehouse.ts';
import { scanAll, scanOptionsForRoot } from '../src/monitors/transcripts.ts';
const cli = new URL('../src/cli/ach.ts', import.meta.url).pathname;
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'ach-transcript-consumers-'));
  const state = join(home, 'state'); mkdirSync(state);
  const root = join(home, '.local/share/amp/threads'); mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'thread.json'), JSON.stringify({ id: 'external-session', messages: [{ role: 'assistant', timestamp: '2026-09-27T01:00:00Z', usage: { inputTokens: 12, outputTokens: 34 } }] }));
  const env = { ...process.env, HOME: home, AGENTIC_CODING_HARNESS_STATE_DIR: state };
  const run = (...args: string[]) => spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, ...args], { cwd: home, env, encoding: 'utf8', timeout: 15000 });
  return { home, state, root, env, run };
}
test('public dash projects meter-only taps and transcripts, state-only excludes both, no registry writes', () => {
  const f = fixture();
  try {
    const agents = join(f.state, 'agents.d'); mkdirSync(agents);
    const tap = join(f.home, 'tap.jsonl');
    writeFileSync(tap, JSON.stringify({ sessionId: 'meter-session', inputTokens: 100, outputTokens: 20, timestamp: '2026-09-27T00:00:00Z' })+'\n');
    writeFileSync(join(agents, 'meter.json'), JSON.stringify({ name: 'meter', launch: null, usageTap: { type: 'transcript', path: tap, format: 'jsonl', fields: { sessionId: 'sessionId', input: 'inputTokens', output: 'outputTokens', timestamp: 'timestamp' } } }));
    const p = f.run('dash', '--json', '--all'); assert.equal(p.status, 0, p.stderr);
    const rows = JSON.parse(p.stdout); assert.equal(rows.length, 2, p.stderr);
    assert.ok(rows.every((r: any) => r.source === 'transcript' && r.live === false && r.effectiveStatus === null));
    assert.equal(rows.reduce((n: number, r: any) => n+r.totals.inputTokens, 0), 112);
    assert.deepEqual(JSON.parse(f.run('dash', '--json', '--state-only').stdout), []);
    assert.equal(existsSync(join(f.state, 'runs')), false);
    const cursor = f.run('run', '--agent', 'cursor', 'hello'); assert.notEqual(cursor.status, 0); assert.match(cursor.stderr, /read-only transcript source/);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});
test('archive restores extra source and warehouse avoids counting live copy twice', async () => {
  const f = fixture();
  try {
    const scan = scanOptionsForRoot(f.home);
    const res = await archiveTranscripts({ stateDir: f.state, scan });
    assert.equal(res.entries.filter((e) => e.agent === 'amp').length, 1);
    const live = []; for await (const r of scanWarehouse({ warehouseDir: res.warehouseDir, live: scan })) live.push(r);
    assert.equal(live.length, 0);
    rmSync(join(f.root, 'thread.json'));
    const old = []; for await (const r of scanWarehouse({ warehouseDir: res.warehouseDir, live: scan })) old.push(r);
    assert.equal(old.length, 1); assert.equal(old[0]!.source, 'transcript');
    const to = join(f.home, 'restore'); await restoreBatch({ warehouseDir: res.warehouseDir, batch: 'latest', to });
    const rows = []; for await (const r of scanAll(scanOptionsForRoot(to))) rows.push(r);
    assert.equal(rows.length, 1); assert.equal(rows[0]!.input, 12);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});
test('public watch --dir discovers extra sources only under the supplied home-shaped root', async () => {
  const f = fixture();
  try {
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), cli, 'watch', '--dir', f.home, '--since', '2026-01-01'], { cwd: f.home, env: f.env });
    let text = ''; let errors = '';
    child.stdout.on('data', (b) => { text += b; if (text.includes('source: transcript')) child.kill('SIGTERM'); });
    child.stderr.on('data', (b) => { errors += b; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    await new Promise((resolve) => child.on('close', resolve)); clearTimeout(timer);
    assert.match(text, /amp\s+external-ses.*\+12 input.*\+34 output.*source: transcript/, errors);
    assert.equal(existsSync(join(f.state, 'runs')), false);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});
test('Cursor reads explicit reported bubble counts and skips malformed or unavailable counts', async () => {
  const { parseCursorDb } = await import('../src/monitors/cursor.ts');
  const { readFileSync } = await import('node:fs');
  const f = fixture();
  try {
    for (const [name, input, output] of [['reported', 120, 34], ['malformed', 10, 2]] as const) {
      const db = join(f.home, `${name}.db`);
      const built = spawnSync('sqlite3', [db], { input: readFileSync(new URL(`./fixtures/cursor/${name}.sql`, import.meta.url)), encoding: 'utf8' });
      assert.equal(built.status, 0, built.stderr);
      const warnings: string[] = [];
      const rows = await parseCursorDb(db, (s) => warnings.push(s));
      assert.equal(rows.reduce((n, r) => n+r.input, 0), input);
      assert.equal(rows.reduce((n, r) => n+r.output, 0), output);
      assert.ok(warnings.length > 0);
      assert.ok(rows.every((r) => r.agent === 'cursor'));
    }
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});
test('web source includes transcript rows and suppresses sessions already owned by registry', async () => {
  const { TranscriptRunSource } = await import('../src/web/run-source-transcript.ts');
  const f = fixture();
  const source = new TranscriptRunSource(f.state, scanOptionsForRoot(f.home));
  try {
    await source.start(() => {});
    const rows = source.snapshot(); assert.equal(rows.length, 1);
    assert.equal(rows[0]!.metadata?.source, 'transcript'); assert.equal(rows[0]!.lastEvent, 'source: transcript');
    assert.ok(rows[0]!.endedAt);
    writeFileSync(join(f.state, 'runs', 'owned.json'), JSON.stringify({ runId: 'owned', agent: 'amp', sessionId: 'external-session', startedAt: 1, status: 'success' }));
    assert.equal(source.snapshot().length, 1); assert.equal(source.snapshot()[0]!.runId, 'owned');
  } finally { await source.stop(); rmSync(f.home, { recursive: true, force: true }); }
});
test('archive keeps same-named Goose databases from distinct roots separate', async () => {
  const { readFileSync } = await import('node:fs'); const f = fixture();
  try {
    const scan = scanOptionsForRoot(f.home);
    for (const root of scan.sourceRoots.goose!.slice(0, 2)) {
      mkdirSync(root, { recursive: true });
      assert.equal(spawnSync('sqlite3', [join(root, 'sessions.db')], { input: readFileSync(new URL('./fixtures/goose/sessions-ledger.sql', import.meta.url)) }).status, 0);
    }
    const archive = await archiveTranscripts({ stateDir: f.state, scan });
    const goose = archive.entries.filter((r) => r.agent === 'goose');
    assert.equal(goose.length, 2); assert.notEqual(goose[0]!.archivePath, goose[1]!.archivePath);
    const repeat = await archiveTranscripts({ stateDir: f.state, scan }); assert.equal(repeat.archived, 0);
    const to = join(f.home, 'restored'); await restoreBatch({ warehouseDir: archive.warehouseDir, batch: 'latest', to });
    const roots = scanOptionsForRoot(to).sourceRoots.goose!;
    assert.ok(existsSync(join(roots[0]!, 'sessions.db'))); assert.ok(existsSync(join(roots[1]!, 'sessions.db')));
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});
test('public watch emits only growth when a cumulative source rewrites its counts', async () => {
  const f = fixture();
  try {
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), cli, 'watch', '--dir', f.home, '--since', '2026-01-01'], { cwd: f.home, env: f.env });
    let text = ''; let changed = false;
    child.stdout.on('data', (b) => {
      text += b;
      if (!changed && text.includes('+34 output')) {
        changed = true;
        writeFileSync(join(f.root, 'thread.json'), JSON.stringify({ id: 'external-session', messages: [{ role: 'assistant', timestamp: '2026-09-27T01:00:00Z', usage: { inputTokens: 12, outputTokens: 40 } }] }));
      }
      if (text.includes('+6 output')) child.kill('SIGTERM');
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 12000);
    await new Promise((resolve) => child.on('close', resolve)); clearTimeout(timer);
    assert.match(text, /\+0 input \+6 output/); assert.doesNotMatch(text, /\+40 output/);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});
test('Cursor missing sqlite3 is a warning rather than a crash', async () => {
  const { parseCursorDb } = await import('../src/monitors/cursor.ts');
  const previous = process.env.PATH;
  const warnings: string[] = [];
  try {
    process.env.PATH = '';
    assert.deepEqual(await parseCursorDb('/missing/state.vscdb', (s) => warnings.push(s)), []);
    assert.match(warnings.join('\n'), /cursor: skipped unreadable store.*ENOENT/);
  } finally { process.env.PATH = previous; }
});
