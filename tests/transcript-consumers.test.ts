import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { archiveTranscripts, restoreBatch, scanWarehouse } from '../src/core/warehouse.ts';
import { scanAll, scanOptionsForRoot } from '../src/monitors/transcripts.ts';
import { stopChild } from './helpers/stop-child.ts';

// Cursor/Goose read SQLite through the sqlite3 CLI; skip (with the reason) where it is absent.
const SQLITE_SKIP = spawnSync('sqlite3', ['-version'], { stdio: 'ignore' }).status === 0 ? false : 'sqlite3 CLI not on PATH';
const cli = fileURLToPath(new URL('../src/cli/ach.ts', import.meta.url));
const loaderArgs = process.versions.bun ? [] : ['--import', import.meta.resolve('tsx')];
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'ach-transcript-consumers-'));
  const state = join(home, 'state'); mkdirSync(state);
  const root = join(home, '.local/share/amp/threads'); mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'thread.json'), JSON.stringify({ id: 'external-session', messages: [{ role: 'assistant', timestamp: '2026-09-27T01:00:00Z', usage: { inputTokens: 12, outputTokens: 34 } }] }));
  const env = { ...process.env, HOME: home, AGENTIC_CODING_HARNESS_STATE_DIR: state };
  const run = (...args: string[]) => spawnSync(process.execPath, [...loaderArgs, cli, ...args], { cwd: home, env, encoding: 'utf8', timeout: 15000 });
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
test('public stats distinguishes transcript and state totals after filtering', () => {
  const f = fixture();
  try {
    const run = f.run('run', '--agent', 'null', '--json', 'offline');
    assert.equal(run.status, 0, run.stderr);
    const p = f.run('stats', '--json'); assert.equal(p.status, 0, p.stderr);
    const stats = JSON.parse(p.stdout);
    assert.equal(stats.sources.transcript.records, 1);
    assert.equal(stats.sources.transcript.inputTokens, 12);
    assert.ok(stats.sources.state.records > 0);
    assert.equal(stats.total.records, stats.sources.state.records + stats.sources.transcript.records);
    assert.match(f.run('stats').stdout, /source: transcript.*input=12/);
    assert.equal(JSON.parse(f.run('stats', '--state-only', '--json').stdout).sources, undefined);
    assert.equal(existsSync(join(f.state, 'runs', 'external-session.json')), false);
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
    const child = spawn(process.execPath, [...loaderArgs, cli, 'watch', '--dir', f.home, '--since', '2026-01-01'], { cwd: f.home, env: f.env });
    let text = ''; let errors = '';
    child.stdout.on('data', (b) => { text += b; if (text.includes('source: transcript')) child.kill('SIGTERM'); });
    child.stderr.on('data', (b) => { errors += b; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    await new Promise((resolve) => child.on('close', resolve)); clearTimeout(timer);
    assert.match(text, /amp\s+external-ses.*\+12 input.*\+34 output.*source: transcript/, errors);
    assert.equal(existsSync(join(f.state, 'runs')), false);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});
test('Cursor reads explicit reported bubble counts and skips malformed or unavailable counts', { skip: SQLITE_SKIP }, async () => {
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
test('archive keeps same-named Goose databases from distinct roots separate', { skip: SQLITE_SKIP }, async () => {
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
test('public watch emits only growth when a cumulative source rewrites its counts', { timeout: 15000 }, async () => {
  const f = fixture();
  try {
    const child = spawn(process.execPath, [...loaderArgs, cli, 'watch', '--dir', f.home, '--since', '2026-01-01'], { cwd: f.home, env: f.env });
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
test('Cursor missing sqlite3 is a warning rather than a crash', () => {
  // A fresh runtime avoids Bun's cached executable lookup after earlier
  // SQLite fixtures. A nonempty path to a non-directory prevents Bun from
  // substituting its default search path for an empty PATH.
  const moduleUrl = new URL('../src/monitors/cursor.ts', import.meta.url).href;
  const code = `import(${JSON.stringify(moduleUrl)}).then(async ({ parseCursorDb }) => {
    const warnings = [];
    const rows = await parseCursorDb('/missing/state.vscdb', (s) => warnings.push(s));
    console.log(JSON.stringify({ rows, warnings }));
  });`;
  const result = spawnSync(process.execPath, [...loaderArgs, '-e', code], { env: { ...process.env, PATH: '/dev/null' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const { rows, warnings } = JSON.parse(result.stdout);
  assert.deepEqual(rows, []);
  assert.match(warnings.join('\n'), /cursor: skipped unreadable store.*(?:ENOENT|ENOTDIR|Executable not found in \$PATH)/);
});
test('public watch discovers post-start sessions while retaining the initial baseline and growth control', { timeout: 20000 }, async () => {
  const f = fixture();
  let child: ReturnType<typeof spawn> | undefined;
  try {
    child = spawn(process.execPath, [...loaderArgs, cli, 'watch', '--dir', f.home], { cwd: f.home, env: f.env });
    let text = ''; let errors = '';
    child.stdout!.on('data', (b) => {
      text += b;
      if (text.includes('+10 input') && text.includes('+77 input')) child!.kill('SIGTERM');
    });
    child.stderr!.on('data', (b) => { errors += b; });
    // offsets.json is written after the initial poll, giving this no-lookback
    // test an observable baseline barrier instead of a timing assumption.
    const start = Date.now();
    while (!existsSync(join(f.state, 'offsets.json')) && Date.now() - start < 8000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(existsSync(join(f.state, 'offsets.json')), errors);
    assert.equal(text, '', 'pre-existing usage must baseline silently');
    const thread = (id: string, input: number, output: number) => JSON.stringify({ id, messages: [{ role: 'assistant', timestamp: '2026-09-27T01:00:00Z', usage: { inputTokens: input, outputTokens: output } }] });
    writeFileSync(join(f.root, 'thread.json'), thread('external-session', 22, 34));
    const nested = join(f.root, 'created-after-start'); mkdirSync(nested);
    writeFileSync(join(nested, 'new-session.json'), thread('new-session', 77, 3));
    const timer = setTimeout(() => child!.kill('SIGKILL'), 12000);
    await new Promise((resolve) => child!.on('close', resolve)); clearTimeout(timer);
    assert.match(text, /external-ses\s+\+10 input \+0 output/, errors);
    assert.match(text, /new-session\s+\+77 input \+3 output/, errors);
    assert.doesNotMatch(text, /\+22 input|\+12 input|\+34 output/);
  } finally { if (child) await stopChild(child); rmSync(f.home, { recursive: true, force: true }); }
});
