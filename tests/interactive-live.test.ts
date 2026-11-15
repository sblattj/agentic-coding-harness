import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { LivePty, loadBunPty, NEEDS_BUN_PTY, type PtyLike } from '../src/interactive/live-pty.ts';
import { confirmLive, connectLive, continueLive, frameReader, listConfirmedLiveRuns, MAX_CLIENT_BACKLOG, PendingInput, probeLive, startLiveServer, type StepState } from '../src/interactive/live-socket.ts';
import { listLiveRuns, liveSocketPath, readLiveInfo, removeLiveInfo, resolveLiveRun, writeLiveInfo } from '../src/interactive/live-registry.ts';
import { StepController } from '../src/interactive/steps.ts';
import { bridgeTerminal, ChordFilter } from '../src/interactive/terminal-bridge.ts';
import { claudeTuiArgs, stripAnsi, trustDialogKeys } from '../src/interactive/claude-tui.ts';
import { attachTarget } from '../src/cli/attach.ts';
import { assertInteractiveSupported, parseInteractiveFlags } from '../src/interactive/flags.ts';

// ---------------------------------------------------------------------------
// #195 interactive runs: the PTY wrapper, the Unix-socket relay `ach web` and
// `ach attach` connect through, the live registry, --then steps, the detach
// chord and flag validation. Runtime-agnostic (a fake PTY stands in for
// bun-pty); the real-PTY path is covered by tests/interactive-run.test.ts.
// ---------------------------------------------------------------------------

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tmp(prefix: string): string {
  // Short base: Unix socket paths are capped near 104 bytes on macOS.
  const d = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', prefix));
  dirs.push(d);
  return d;
}

class FakePty implements PtyLike {
  pid: number;
  written: string[] = [];
  sizes: Array<[number, number]> = [];
  killed = 0;
  #data = new Set<(d: string) => void>();
  #exit = new Set<(e: { exitCode: number }) => void>();
  constructor(pid = 999_999) {
    this.pid = pid;
  }
  write(d: string): void {
    this.written.push(d);
  }
  resize(c: number, r: number): void {
    this.sizes.push([c, r]);
  }
  kill(): void {
    this.killed++;
    this.exit(137);
  }
  onData(cb: (d: string) => void): void {
    this.#data.add(cb);
  }
  onExit(cb: (e: { exitCode: number }) => void): void {
    this.#exit.add(cb);
  }
  emit(d: string): void {
    for (const cb of this.#data) cb(d);
  }
  exit(code: number): void {
    for (const cb of this.#exit) cb({ exitCode: code });
  }
}

function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const t = setInterval(() => {
      if (pred()) {
        clearInterval(t);
        resolve();
      } else if (Date.now() - start > ms) {
        clearInterval(t);
        reject(new Error('timed out waiting'));
      }
    }, 10);
  });
}

describe('LivePty', () => {
  it('keeps scrollback, fans out data, records an asciicast, reports exit', async () => {
    const dir = tmp('ach-lp-');
    const fake = new FakePty();
    const castPath = join(dir, 'casts', 'r.cast');
    const live = new LivePty(fake, { cols: 80, rows: 24, castPath, castTitle: 't' });
    const seen: string[] = [];
    live.onData((d) => seen.push(d));
    fake.emit('hello ');
    fake.emit('\x1b[1mworld\x1b[0m');
    assert.equal(live.scrollback(), 'hello \x1b[1mworld\x1b[0m');
    assert.deepEqual(seen, ['hello ', '\x1b[1mworld\x1b[0m']);
    assert.equal(live.write('x'), true);
    assert.deepEqual(fake.written, ['x']);
    assert.equal(live.resize(100, 30), true);
    assert.equal(live.resize(0, 30), false);
    assert.deepEqual(live.size, { cols: 100, rows: 30 });
    fake.exit(0);
    assert.equal(await live.exited, 0);
    assert.equal(live.alive, false);
    assert.equal(live.write('y'), false, 'no writes after exit');
    await new Promise((r) => setTimeout(r, 50));
    const lines = readFileSync(castPath, 'utf8').trim().split('\n');
    assert.deepEqual(JSON.parse(lines[0]!), { version: 2, width: 80, height: 24, timestamp: JSON.parse(lines[0]!).timestamp, title: 't' });
    assert.deepEqual(lines.slice(1).map((l) => JSON.parse(l).slice(1)), [['o', 'hello '], ['o', '\x1b[1mworld\x1b[0m'], ['r', '100x30']]);
  });

  it('interrupt() sends SIGINT, then SIGTERM, then SIGKILL to a process that ignores them', { skip: process.platform === 'win32' ? 'POSIX signals' : false }, async () => {
    const dir = tmp('ach-sig-');
    const marker = join(dir, 'signals');
    writeFileSync(marker, '');
    const child = spawn(process.execPath, ['-e', `const fs=require('fs');for (const s of ['SIGINT','SIGTERM']) process.on(s,()=>fs.appendFileSync(${JSON.stringify(marker)}, s+'\\n'));setInterval(()=>{},1000);`], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 400));
    const fake = new FakePty(child.pid!);
    const live = new LivePty(fake, { cols: 80, rows: 24, sigtermAfterMs: 150, sigkillAfterMs: 150 });
    const gone = new Promise<string | null>((r) => child.once('exit', (_c, sig) => r(sig)));
    live.interrupt();
    live.interrupt(); // idempotent
    assert.equal(live.interrupted, true);
    assert.equal(await gone, 'SIGKILL');
    assert.equal(readFileSync(marker, 'utf8'), 'SIGINT\nSIGTERM\n');
    assert.equal(fake.killed, 1, 'the PTY handle is closed on the last step');
  });
});

describe('loadBunPty', () => {
  it('fails with the "needs the npm/bun install" error outside Bun', { skip: typeof (process.versions as Record<string, string | undefined>).bun === 'string' ? 'running under bun' : false }, async () => {
    await assert.rejects(loadBunPty(), (err: Error) => {
      assert.match(err.message, /interactive runs need the npm\/bun install/);
      assert.match(err.message, /Node/);
      return true;
    });
    assert.match(NEEDS_BUN_PTY, /standalone binaries/);
  });
});

describe('live socket relay', () => {
  it('replays scrollback, streams output, forwards input/resize/continue, ends on exit', async () => {
    const dir = tmp('ach-ls-');
    const fake = new FakePty();
    const live = new LivePty(fake, { cols: 80, rows: 24 });
    fake.emit('before-attach\r\n');
    const steps = new StepController({ prompts: ['next one'], pauseBetween: true, write: (d) => void live.write(d), settleMs: 0, enterDelayMs: 0 });
    const socketPath = join(dir, 's.sock');
    const server = await startLiveServer({ socketPath, runId: 'run-1', sessionId: 'sess-1', agent: 'claude', target: live, controls: steps });

    const hello = await probeLive(socketPath);
    assert.equal(hello.runId, 'run-1');
    assert.equal(hello.sessionId, 'sess-1');
    assert.deepEqual(hello.steps, { total: 1, sent: 0, waiting: false, next: 'next one' });

    const got: string[] = [];
    let scroll = '';
    const states: StepState[] = [];
    let exitCode: number | null | undefined;
    let closed = false;
    const client = await connectLive(socketPath, {
      onScrollback: (d) => {
        scroll = d;
      },
      onOut: (d) => got.push(d),
      onState: (s) => states.push(s),
      onExit: (c) => {
        exitCode = c;
      },
      onClose: () => {
        closed = true;
      },
    });
    await waitFor(() => scroll !== '');
    assert.equal(scroll, 'before-attach\r\n');
    fake.emit('live-bytes');
    await waitFor(() => got.join('') === 'live-bytes');
    client.input('typed');
    client.resize(132, 40);
    await waitFor(() => fake.written.includes('typed') && fake.sizes.length === 1);
    assert.deepEqual(fake.sizes, [[132, 40]]);
    assert.equal(server.clients(), 1);

    steps.turnEnded();
    await waitFor(() => states.some((s) => s.waiting));
    await continueLive(socketPath);
    await waitFor(() => fake.written.includes('next one') && fake.written.includes('\r'));
    await waitFor(() => states.some((s) => s.sent === 1 && !s.waiting));

    fake.exit(3);
    await waitFor(() => closed);
    assert.equal(exitCode, 3);
    await server.close();
    assert.equal(existsSync(socketPath), false, 'socket file removed on close');
  });
});

describe('live registry', () => {
  it('writes, reads, resolves prefixes and skips dead owners', () => {
    const state = tmp('ach-lr-');
    const sockDir = tmp('ach-lrs-');
    const env = { AGENTIC_CODING_HARNESS_LIVE_SOCKET_DIR: sockDir };
    const sock = liveSocketPath('abcdef12-3456-7890-abcd-ef1234567890', env);
    assert.ok(sock.startsWith(sockDir));
    assert.ok(sock.length < 104);
    writeFileSync(sock, '');
    writeLiveInfo(state, { runId: 'abcdef12-3456-7890-abcd-ef1234567890', sessionId: 's-1', agent: 'claude', pid: process.pid, socket: sock, cwd: '/w', startedAt: 2 });
    writeLiveInfo(state, { runId: 'dead0000-0000', sessionId: 's-2', agent: 'claude', pid: 2_147_483_000, socket: sock, cwd: '/w', startedAt: 3 });
    assert.equal(readLiveInfo(state, 'abcdef12-3456-7890-abcd-ef1234567890')?.sessionId, 's-1');
    assert.equal(readLiveInfo(state, 'dead0000-0000'), null, 'owner pid gone');
    assert.equal(readLiveInfo(state, '../etc'), null, 'ids are path-safe');
    assert.deepEqual(listLiveRuns(state).map((r) => r.runId), ['abcdef12-3456-7890-abcd-ef1234567890']);
    assert.equal(resolveLiveRun(state, 'abcdef12').runId, 'abcdef12-3456-7890-abcd-ef1234567890');
    assert.equal(resolveLiveRun(state, 's-1').runId, 'abcdef12-3456-7890-abcd-ef1234567890', 'session id prefix works too');
    assert.throws(() => resolveLiveRun(state, 'zzz'), /no live interactive run 'zzz'/);
    removeLiveInfo(state, 'abcdef12-3456-7890-abcd-ef1234567890');
    assert.equal(readLiveInfo(state, 'abcdef12-3456-7890-abcd-ef1234567890'), null);
    assert.throws(() => resolveLiveRun(state, 'abc'), /No interactive run is live/);
  });
});

describe('StepController', () => {
  it('types the next prompt after a turn ends, one step per turn end', async () => {
    const out: string[] = [];
    const sc = new StepController({ prompts: ['a\nb', 'c'], pauseBetween: false, write: (d) => out.push(d), settleMs: 0, enterDelayMs: 0 });
    sc.turnEnded();
    await waitFor(() => out.length === 2);
    assert.deepEqual(out, ['a b', '\r'], 'newlines are flattened so the prompt submits once');
    sc.turnEnded();
    await waitFor(() => out.length === 4);
    sc.turnEnded();
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(out, ['a b', '\r', 'c', '\r']);
    assert.deepEqual(sc.state(), { total: 2, sent: 2, waiting: false });
    assert.equal(sc.continue(), false);
  });

  it('with pauseBetween, waits for continue()', async () => {
    const out: string[] = [];
    const sc = new StepController({ prompts: ['x'], pauseBetween: true, write: (d) => out.push(d), settleMs: 0, enterDelayMs: 0 });
    sc.turnEnded();
    await waitFor(() => sc.state().waiting);
    assert.deepEqual(out, []);
    assert.equal(sc.continue(), true);
    await waitFor(() => out.length === 2);
    assert.deepEqual(out, ['x', '\r']);
    sc.stop();
  });
});

describe('ChordFilter', () => {
  const flat = (r: { passthrough: string; actions: string[] }) => ({ passthrough: r.passthrough, actions: r.actions });
  it('passes keys through and turns Ctrl-] d / n into actions', () => {
    const f = new ChordFilter();
    assert.deepEqual(flat(f.feed('abc')), { passthrough: 'abc', actions: [] });
    assert.deepEqual(flat(f.feed('x\x1d')), { passthrough: 'x', actions: [] });
    assert.deepEqual(flat(f.feed('n')), { passthrough: '', actions: ['next'] });
    assert.deepEqual(flat(f.feed('\x1d\x1d')), { passthrough: '\x1d', actions: [] });
    assert.deepEqual(flat(f.feed('\x1dq')), { passthrough: '\x1dq', actions: [] });
    assert.deepEqual(flat(f.feed('y\x1dd')), { passthrough: 'y', actions: ['detach'] });
  });

  it('keeps typing order around Ctrl-] n and drops what follows Ctrl-] d', () => {
    const f = new ChordFilter();
    assert.deepEqual(f.feed('a\x1dnb\x1ddzz').ops, [{ input: 'a' }, { action: 'next' }, { input: 'b' }, { action: 'detach' }]);
  });
});

describe('bridgeTerminal', () => {
  it('detaches before any key typed after Ctrl-] d in the same chunk reaches the PTY', async () => {
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
    const log: string[] = [];
    let detached = 0;
    bridgeTerminal({
      target: { input: (d) => log.push(`in:${d}`), resize: () => {}, continueStep: () => log.push('next') },
      onDetach: () => {
        detached++;
        log.push('detach');
      },
      stdin,
      stdout,
      driveSize: false,
    });
    (stdin as unknown as PassThrough).write('ab\x1dncd\x1ddrm -rf\r');
    await new Promise((r) => setImmediate(r));
    (stdin as unknown as PassThrough).write('later');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(log, ['in:ab', 'next', 'in:cd', 'detach']);
    assert.equal(detached, 1);
  });
});

describe('claude TUI helpers', () => {
  it('builds argv with the prompt first, a fixed session id, model and sandbox flags', () => {
    const args = claudeTuiArgs({ prompt: 'hi there', model: 'claude-sonnet-5-5', sandbox: { permissionMode: 'bypassPermissions', allowedTools: ['Read', 'Bash(git log:*)'] }, extraArgs: ['--verbose'] }, 'sid-1');
    assert.equal(args[0], 'hi there');
    assert.deepEqual(args.slice(1, 5), ['--session-id', 'sid-1', '--model', 'claude-sonnet-5-5']);
    assert.ok(args.includes('--permission-mode') && args.includes('bypassPermissions'));
    assert.ok(args.includes('--allowedTools'));
    assert.equal(args.at(-1), '--verbose');
    assert.ok(!args.includes('-p'), 'never print mode');
    const dash = claudeTuiArgs({ prompt: '-x' }, 's');
    assert.deepEqual(dash.slice(-2), ['--', '-x']);
  });

  it('recognises the trust dialog and picks Yes', () => {
    // As Claude Code draws it: cursor moves (ESC[1C) instead of spaces.
    const screen = 'Quick\x1b[1Csafety\x1b[1Ccheck:\x1b[1CIs\x1b[1Cthis\x1b[1Ca\x1b[1Cproject\x1b[1Cyou\x1b[1Ccreated\x1b[1Cor\x1b[1Cone\x1b[1Cyou\x1b[1Ctrust?\r\n\x1b[36m❯\x1b[39m No, exit\r\n  Yes, I trust this folder';
    assert.deepEqual(trustDialogKeys(screen), ['\x1b[B', '\r']);
    assert.deepEqual(trustDialogKeys('one you trust ❯ 1. Yes, I trust this folder  2. No, exit'), ['\r']);
    assert.equal(trustDialogKeys('welcome to Claude Code'), null);
    assert.equal(stripAnsi('\x1b[1ma\x1b[0m\x1b]0;title\x07b'), 'ab');
  });
});

describe('interactive flags', () => {
  it('parses --interactive / --tui and rejects stray or conflicting flags', () => {
    assert.equal(parseInteractiveFlags({}, {}), null);
    assert.deepEqual(parseInteractiveFlags({ tui: true, then: [' b '], 'pause-between': true }, {}), { then: ['b'], pauseBetween: true, trustWorkspace: false });
    assert.throws(() => parseInteractiveFlags({ then: ['x'] }, {}), /--then only works with --interactive/);
    assert.throws(() => parseInteractiveFlags({ interactive: true, 'pause-between': true }, {}), /needs at least one --then/);
    assert.throws(() => parseInteractiveFlags({ interactive: true }, { repeat: 2 }), /--repeat or --parallel/);
    assert.throws(() => parseInteractiveFlags({ interactive: true, then: [''] }, {}), /non-empty/);
  });

  it('says clearly which agents are not supported yet', () => {
    assert.doesNotThrow(() => assertInteractiveSupported('claude', undefined));
    assert.throws(() => assertInteractiveSupported('codex', undefined), /--interactive is not yet supported for agent 'codex'.*claude/);
    assert.throws(() => assertInteractiveSupported('claude', 'abc'), /--resume is not yet supported/);
  });
});


describe('frameReader', () => {
  it('keeps a multi-byte character split across socket chunks intact', () => {
    const frames: Array<Record<string, unknown>> = [];
    const read = frameReader((f) => frames.push(f));
    const wire = Buffer.from(JSON.stringify({ t: 'out', d: '❯ héllo ✓' }) + '\n', 'utf8');
    const cut = wire.indexOf(Buffer.from('✓', 'utf8')) + 2; // two bytes into the three
    read(wire.subarray(0, cut));
    assert.equal(frames.length, 0);
    read(wire.subarray(cut));
    assert.deepEqual(frames, [{ t: 'out', d: '❯ héllo ✓' }]);
  });
});

describe('live socket backpressure', () => {
  it('drops a viewer that stops reading instead of buffering without bound', { timeout: 30_000 }, async () => {
    const net = await import('node:net');
    const dir = tmp('ach-bp-');
    const fake = new FakePty();
    const live = new LivePty(fake, { cols: 80, rows: 24 });
    const socketPath = join(dir, 's.sock');
    const server = await startLiveServer({ socketPath, runId: 'run-bp', sessionId: 'sess-bp', agent: 'claude', target: live });
    const stuck = net.createConnection(socketPath);
    await new Promise<void>((r) => stuck.once('connect', () => r()));
    stuck.pause(); // a frozen viewer: never reads
    const deadline = Date.now() + 10_000;
    while (server.clients() === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    assert.equal(server.clients(), 1);
    const chunk = 'x'.repeat(64 * 1024);
    for (let sent = 0; sent < MAX_CLIENT_BACKLOG * 2 && server.clients() > 0; sent += chunk.length) {
      fake.emit(chunk);
      await new Promise((r) => setImmediate(r));
    }
    while (server.clients() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    assert.equal(server.clients(), 0, 'the stuck viewer was dropped');
    stuck.destroy();
    await server.close();
  });
});

describe('stale live entries (crashed owner, reused pid)', () => {
  it('an entry whose socket does not answer is not attachable; the real owner is', async () => {
    const state = tmp('ach-stale-');
    const sockDir = tmp('ach-stales-');
    // The pid is alive (it is ours, as if the OS reused a crashed owner's pid)
    // and a file sits at the socket path, so the registry check passes.
    const staleSock = join(sockDir, 'stale.sock');
    writeFileSync(staleSock, '');
    writeLiveInfo(state, { runId: 'stale000-0000', sessionId: 's-x', agent: 'claude', pid: process.pid, socket: staleSock, cwd: '/w', startedAt: 1 });
    const stale = readLiveInfo(state, 'stale000-0000');
    assert.ok(stale !== null, 'the pid check alone would call it live');
    assert.equal(await confirmLive(stale!), false);

    const fake = new FakePty();
    const live = new LivePty(fake, { cols: 80, rows: 24 });
    const realSock = join(sockDir, 'real.sock');
    const server = await startLiveServer({ socketPath: realSock, runId: 'real0000-0000', sessionId: 's-r', agent: 'claude', target: live });
    writeLiveInfo(state, { runId: 'real0000-0000', sessionId: 's-r', agent: 'claude', pid: process.pid, socket: realSock, cwd: '/w', startedAt: 2 });
    // An entry pointing at another run's socket is not confirmed either.
    writeLiveInfo(state, { runId: 'other000-0000', sessionId: 's-o', agent: 'claude', pid: process.pid, socket: realSock, cwd: '/w', startedAt: 3 });
    assert.deepEqual((await listConfirmedLiveRuns(state)).map((r) => r.runId), ['real0000-0000']);
    await server.close();
  });
});

describe('attachTarget', () => {
  it('--read-only sends no keys, no resizes and no step releases', () => {
    const calls: string[] = [];
    const client = { input: () => calls.push('input'), resize: () => calls.push('resize'), continueStep: () => calls.push('continue') };
    const ro = attachTarget(client, true);
    ro.input('x');
    ro.resize(80, 24);
    ro.continueStep();
    assert.deepEqual(calls, []);
    const rw = attachTarget(client, false);
    rw.input('x');
    rw.resize(80, 24);
    rw.continueStep();
    assert.deepEqual(calls, ['input', 'resize', 'continue']);
  });
});

describe('PendingInput', () => {
  it('holds early input in order, bounded, and delivers it once', () => {
    const q = new PendingInput(10);
    assert.equal(q.hold('abc'), true);
    assert.equal(q.hold('\r'), true);
    assert.equal(q.hold('toolongforit'), false, 'over the cap is refused');
    assert.equal(q.hold('de'), true);
    const out: string[] = [];
    q.drain((m) => out.push(m));
    assert.deepEqual(out, ['abc', '\r', 'de']);
    assert.equal(q.size, 0);
    q.drain((m) => out.push(m));
    assert.equal(out.length, 3, 'delivered once');
  });
});
