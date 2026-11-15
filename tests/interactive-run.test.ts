import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import WebSocket from 'ws';
import { connectLive, type LiveClient } from '../src/interactive/live-socket.ts';
import { parseClaudeSession } from '../src/monitors/transcripts.ts';
import { readRunRecord } from '../src/core/registry.ts';

// ---------------------------------------------------------------------------
// #195 end to end with a real PTY: `ach run --agent claude --interactive`
// drives a fake Claude TUI (tests/helpers/fake-claude-tui.ts, on PATH as
// `claude`) through bun-pty, meters it from the session transcript, types
// --then steps, publishes the PTY to `ach web` and `ach attach`, and aborts
// on budget with SIGINT. bun-pty needs Bun, so the CLI runs as a bun child
// (skipped when bun is not on PATH, like the other PTY suites).
// ---------------------------------------------------------------------------

const isBun = spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0;
const CLI = new URL('../src/cli/ach.ts', import.meta.url).pathname;
const FAKE = new URL('./helpers/fake-claude-tui.ts', import.meta.url).pathname;
const WEB_RUNNER = new URL('./helpers/web-server-runner.ts', import.meta.url).pathname;
const ATTACH_PROBE = new URL('./helpers/attach-probe.ts', import.meta.url).pathname;
const SKIP = isBun ? false : 'bun not on PATH';
// `--import tsx` resolves from the child's cwd, so tsx children run from the repo root.
const REPO = new URL('..', import.meta.url).pathname;

const dirs: string[] = [];
const children: ChildProcess[] = [];
after(() => {
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Sandbox {
  root: string;
  home: string;
  state: string;
  work: string;
  env: NodeJS.ProcessEnv;
}

function sandbox(extraEnv: Record<string, string> = {}): Sandbox {
  // Short root: Unix socket paths are capped near 104 bytes on macOS.
  const root = mkdtempSync('/tmp/ach-irun-');
  dirs.push(root);
  const home = join(root, 'h');
  const state = join(root, 's');
  const work = join(root, 'w');
  const bin = join(root, 'bin');
  for (const d of [home, state, work, bin, join(root, 'k')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\nexec bun "${FAKE}" "$@"\n`);
  chmodSync(join(bin, 'claude'), 0o755);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, AGENTIC_CODING_HARNESS_STATE_DIR: state, AGENTIC_CODING_HARNESS_LIVE_SOCKET_DIR: join(root, 'k'), ...extraEnv };
  for (const k of ['CLAUDE_CONFIG_DIR', 'AGENTIC_CODING_HARNESS_BUDGET_USD', 'AGENTIC_CODING_HARNESS_WALL_MS', 'AGENTIC_CODING_HARNESS_IDLE_MS', 'AGENTIC_CODING_HARNESS_DEFAULT_CLAUDE_CONFIG']) delete env[k];
  return { root, home, state, work, env };
}

interface RunProc {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  done: Promise<number | null>;
}

function startRun(sb: Sandbox, args: string[]): RunProc {
  const child = spawn('bun', [CLI, 'run', '--agent', 'claude', '--interactive', '--json', ...args], { cwd: sb.work, env: sb.env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let out = '';
  let err = '';
  child.stdout!.setEncoding('utf8').on('data', (c: string) => (out += c));
  child.stderr!.setEncoding('utf8').on('data', (c: string) => (err += c));
  const done = new Promise<number | null>((resolve) => child.once('exit', (c) => resolve(c)));
  return { child, stdout: () => out, stderr: () => err, done };
}

async function waitFor<T>(what: string, fn: () => T | null | undefined | false, ms = 20_000, diag: () => string = () => ''): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out: ${what}\n${diag()}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

interface LiveFile {
  runId: string;
  sessionId: string;
  socket: string;
}
function liveFiles(state: string): LiveFile[] {
  try {
    return readdirSync(join(state, 'live'))
      .filter((n) => n.endsWith('.json'))
      .map((n) => JSON.parse(readFileSync(join(state, 'live', n), 'utf8')) as LiveFile);
  } catch {
    return [];
  }
}

async function attachClient(socket: string): Promise<{ client: LiveClient; screen: () => string }> {
  let screen = '';
  const client = await connectLive(socket, { onScrollback: (d) => (screen += d), onOut: (d) => (screen += d) });
  return { client, screen: () => screen };
}

async function typeLine(client: LiveClient, text: string): Promise<void> {
  client.input(text);
  await new Promise((r) => setTimeout(r, 120));
  client.input('\r');
}

function sumTokens(tokens: Array<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }>) {
  return tokens.reduce((a, t) => ({ input: a.input + t.inputTokens, output: a.output + t.outputTokens, cacheRead: a.cacheRead + t.cacheReadTokens, cacheWrite: a.cacheWrite + t.cacheWriteTokens }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
}

describe('ach run --interactive (bun-pty + fake claude TUI)', { skip: SKIP }, () => {
  it('runs the TUI with the run flags, types --then steps, takes input over the socket, meters from the transcript', async () => {
    const sb = sandbox();
    const run = startRun(sb, ['--model', 'claude-sonnet-4-5', '--permission-mode', 'bypassPermissions', '--allowed-tools', 'Read', '--then', 'second step', 'first prompt']);
    const live = await waitFor('live file', () => liveFiles(sb.state)[0], 20_000, run.stderr);
    const { client, screen } = await attachClient(live.socket);
    await waitFor('--then step answered', () => screen().includes('echo: second step'), 20_000, () => screen() + run.stderr());
    assert.ok(screen().includes('FAKE CLAUDE TUI'), 'scrollback replays the banner');
    await typeLine(client, 'third from client');
    await waitFor('typed prompt answered', () => screen().includes('echo: third from client'));
    await typeLine(client, '/exit');
    assert.equal(await run.done, 0, run.stderr());

    const result = JSON.parse(run.stdout());
    assert.equal(result.exitStatus, 'success');
    assert.equal(result.sessionId, live.sessionId);
    assert.equal(result.runId, live.runId);
    // 3 turns x (10 in, 5 out, 100 cacheR, 50 cacheW); streamed partial blocks not double counted.
    const metered = sumTokens(result.tokens);
    assert.deepEqual(metered, { input: 30, output: 15, cacheRead: 300, cacheWrite: 150 });
    const truth = (await parseClaudeSession(join(sb.home, '.claude', 'projects', '-fake-project'), live.sessionId)).reduce(
      (a, r) => ({ input: a.input + r.input, output: a.output + r.output, cacheRead: a.cacheRead + r.cacheRead, cacheWrite: a.cacheWrite + r.cacheWrite }),
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    );
    assert.deepEqual(metered, truth, 'RunResult tokens equal the `ach watch` parser totals for the session');
    assert.ok(result.totalCost > 0, 'priced like a headless run');
    assert.ok(result.events.some((e: { type: string }) => e.type === 'tool_call'));

    const argv = JSON.parse(readFileSync(join(sb.home, 'fake-tui-argv.json'), 'utf8')) as string[];
    assert.equal(argv[0], 'first prompt');
    assert.deepEqual(argv.slice(argv.indexOf('--session-id'), argv.indexOf('--session-id') + 2), ['--session-id', live.sessionId]);
    assert.ok(argv.includes('--permission-mode') && argv.includes('bypassPermissions') && argv.includes('--allowedTools'));
    assert.ok(!argv.includes('-p'));

    const rec = readRunRecord(sb.state, live.runId);
    assert.equal(rec?.sessionId, live.sessionId);
    assert.equal(liveFiles(sb.state).length, 0, 'live entry removed when the run ends');
    const cast = readFileSync(join(sb.state, 'casts', `${live.runId}.cast`), 'utf8');
    assert.match(cast.split('\n')[0]!, /"version":2/);
    assert.ok(cast.includes('FAKE CLAUDE TUI'), 'raw TUI bytes recorded as asciicast');
  });

  it('a budget abort ends the run like a headless one: SIGINT to the TUI, exitStatus budget_exceeded', async () => {
    const sb = sandbox({ FAKE_TUI_USAGE: JSON.stringify({ input_tokens: 2_000_000, output_tokens: 10 }) });
    const marker = join(sb.root, 'signals');
    sb.env.FAKE_TUI_MARKER = marker;
    const run = startRun(sb, ['--model', 'claude-sonnet-4-5', '--budget-usd', '0.01', '--on-budget', 'abort', 'spend a lot']);
    const code = await run.done;
    const result = JSON.parse(run.stdout());
    assert.equal(result.exitStatus, 'budget_exceeded', run.stderr());
    assert.notEqual(code, 0);
    assert.equal(readFileSync(marker, 'utf8').split('\n')[0], 'SIGINT');
    assert.equal(liveFiles(sb.state).length, 0);
  });

  it('ach web attaches the run PTY by runId (scrollback, typing reaches the same session) and serves the TUI cast', async () => {
    const sb = sandbox();
    const run = startRun(sb, ['--model', 'claude-sonnet-4-5', 'hello web']);
    const live = await waitFor('live file', () => liveFiles(sb.state)[0], 20_000, run.stderr);
    const web = spawn('bun', [WEB_RUNNER, sb.state, ''], { env: sb.env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(web);
    let webOut = '';
    web.stdout!.setEncoding('utf8').on('data', (c: string) => (webOut += c));
    const port = Number(await waitFor('web READY', () => /READY (\d+)/.exec(webOut)?.[1]));
    const base = `http://127.0.0.1:${port}`;

    const list = (await (await fetch(`${base}/api/live`)).json()) as { live: LiveFile[] };
    assert.deepEqual(list.live.map((l) => l.runId), [live.runId]);
    const one = (await (await fetch(`${base}/api/live/${live.runId}`)).json()) as { ptyId: string; sessionId: string };
    assert.equal(one.ptyId, `run:${live.runId}`);
    assert.equal(one.sessionId, live.sessionId);
    assert.equal((await fetch(`${base}/api/live/nope`)).status, 404);
    // An entry for another run id that points at this run's socket (stale or
    // forged) can neither be read nor release a step.
    writeFileSync(join(sb.state, 'live', 'other000-0000.json'), JSON.stringify({ ...live, runId: 'other000-0000', pid: process.pid }));
    assert.equal((await fetch(`${base}/api/live/other000-0000`)).status, 404);
    assert.equal((await fetch(`${base}/api/live/other000-0000/continue`, { method: 'POST' })).status, 404, 'continue checks the socket owner too');
    rmSync(join(sb.state, 'live', 'other000-0000.json'));

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/pty/${encodeURIComponent(`run:${live.runId}`)}`);
    const frames: string[] = [];
    ws.on('message', (m) => frames.push(m.toString()));
    await new Promise((r, j) => {
      ws.once('open', r);
      ws.once('error', j);
    });
    await waitFor('scrollback frame', () => frames.join('').includes('FAKE CLAUDE TUI'));
    ws.send('from-web');
    await new Promise((r) => setTimeout(r, 120));
    ws.send('\r');
    await waitFor('typed in the browser, answered by the run', () => frames.join('').includes('echo: from-web'), 20_000, () => frames.join(''));
    ws.close();
    // Keys sent the moment the socket opens, before the server's relay
    // connection is up, are held and delivered, not dropped.
    const early = new WebSocket(`ws://127.0.0.1:${port}/ws/pty/${encodeURIComponent(`run:${live.runId}`)}`);
    const earlyFrames: string[] = [];
    early.on('message', (m) => earlyFrames.push(m.toString()));
    await new Promise((r, j) => {
      early.once('open', () => {
        early.send('early-bird');
        r(null);
      });
      early.once('error', j);
    });
    await new Promise((r) => setTimeout(r, 150));
    early.send('\r');
    await waitFor('keys sent on open reach the run', () => earlyFrames.join('').includes('echo: early-bird'), 20_000, () => earlyFrames.join(''));
    early.close();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(liveFiles(sb.state).length, 1, 'closing the browser pane leaves the run going');

    const transcript = readFileSync(join(sb.home, '.claude', 'projects', '-fake-project', `${live.sessionId}.jsonl`), 'utf8');
    assert.ok(transcript.split('\n').some((l) => l.includes('"from-web"') && l.includes(live.sessionId)), 'the web prompt landed in the run session');

    const { client } = await attachClient(live.socket);
    await typeLine(client, '/exit');
    assert.equal(await run.done, 0, run.stderr());
    const result = JSON.parse(run.stdout());
    assert.deepEqual(sumTokens(result.tokens), { input: 30, output: 15, cacheRead: 300, cacheWrite: 150 }, 'the browser turns are metered on the run');
    const cast = await (await fetch(`${base}/api/runs/${live.runId}/cast`)).text();
    assert.ok(cast.includes('FAKE CLAUDE TUI'));
    assert.equal((await fetch(`${base}/ws/pty/${encodeURIComponent(`run:${live.runId}`)}`)).status, 404, 'no live PTY after the run ends');
    web.kill('SIGTERM');
  });

  it('ach attach mirrors the PTY in a terminal, types into the run, and Ctrl-] d detaches without ending it', async () => {
    const sb = sandbox();
    const run = startRun(sb, ['--model', 'claude-sonnet-4-5', 'hello attach']);
    const live = await waitFor('live file', () => liveFiles(sb.state)[0], 20_000, run.stderr);
    const probe = spawnSync('bun', [ATTACH_PROBE, CLI, live.runId.slice(0, 8)], { cwd: sb.work, env: sb.env, encoding: 'utf8', timeout: 60_000 });
    const line = probe.stdout.split('\n').find((l) => l.startsWith('PROBE_RESULT ') || l.startsWith('PROBE_FAIL'));
    assert.ok(line?.startsWith('PROBE_RESULT '), `${line ?? ''}\n${probe.stderr}`);
    const r = JSON.parse(line!.slice('PROBE_RESULT '.length));
    assert.deepEqual(r, { sawBanner: true, sawEcho: true, exitCode: 0, detachedMsg: true });
    assert.equal(liveFiles(sb.state).length, 1, 'the run keeps going after detach');
    const { client } = await attachClient(live.socket);
    await typeLine(client, '/exit');
    assert.equal(await run.done, 0, run.stderr());
    assert.equal(existsSync(join(sb.state, 'live', `${live.runId}.json`)), false);
  });
});

describe('ach run --interactive guards', () => {
  const tsxArgs = (args: string[]) => (isBun ? ['bun', [CLI, ...args]] : [process.execPath, ['--import', 'tsx', CLI, ...args]]) as [string, string[]];
  it('rejects agents interactive runs do not support yet', () => {
    const sb = sandbox();
    const [cmd, args] = tsxArgs(['run', '--agent', 'codex', '--interactive', 'hi']);
    const p = spawnSync(cmd, args, { cwd: REPO, env: sb.env, encoding: 'utf8' });
    assert.notEqual(p.status, 0);
    assert.match(p.stderr, /--interactive is not yet supported for agent 'codex'/);
  });

  it('under Node, prints the "needs the npm/bun install" error', () => {
    const sb = sandbox();
    const p = spawnSync('node', ['--import', 'tsx', CLI, 'run', '--agent', 'claude', '--interactive', 'hi'], { cwd: REPO, env: sb.env, encoding: 'utf8' });
    assert.notEqual(p.status, 0);
    assert.match(p.stderr, /interactive runs need the npm\/bun install/);
  });

  it('ach attach with nothing live says so', () => {
    const sb = sandbox();
    const [cmd, args] = tsxArgs(['attach']);
    const p = spawnSync(cmd, args, { cwd: REPO, env: sb.env, encoding: 'utf8' });
    assert.equal(p.status, 1);
    assert.match(p.stdout, /no interactive run is live/);
    const [cmd2, args2] = tsxArgs(['attach', 'abc123']);
    const q = spawnSync(cmd2, args2, { cwd: REPO, env: sb.env, encoding: 'utf8' });
    assert.notEqual(q.status, 0);
    assert.match(q.stderr, /no live interactive run 'abc123'/);
  });
});
