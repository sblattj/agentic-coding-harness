// withMkdirLock: a stale-lock takeover only ever removes the lock it judged stale, never a successor.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { withMkdirLock } from '../src/core/mkdir-lock.ts';

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'ach-mkdir-lock-'));
  dirs.push(d);
  return d;
}

/** A pid that has exited (a just-reaped child). */
function deadPid(): number {
  const pid = spawnSync(process.execPath, ['-e', '']).pid;
  assert.ok(pid);
  return pid;
}

/** Plants a lock dir as another holder would: mkdir, then an owner file of `pid token`. */
function plant(lock: string, pid: number, token: string): void {
  mkdirSync(lock);
  writeFileSync(join(lock, 'owner'), `${pid} ${token}\n`);
}

const ownerToken = (lock: string): string | undefined => {
  try {
    return readFileSync(join(lock, 'owner'), 'utf8').trim().split(' ')[1];
  } catch {
    return undefined;
  }
};

describe('withMkdirLock stale takeover', () => {
  it('a waiter that judged L1 stale never deletes the successor lock another process created', () => {
    const lock = join(scratch(), 'x.lock');
    plant(lock, deadPid(), 'l1');
    let fired = 0;
    let ranB = false;
    // B judges L1 stale (dead owner). Before B acts, A takes L1 over and C acquires a successor.
    const b = () =>
      withMkdirLock(lock, () => (ranB = true), {
        staleMs: 60_000,
        waitMs: 300,
        beforeTakeover: () => {
          if (fired++ > 0) return;
          rmSync(lock, { recursive: true, force: true }); // A's takeover of L1
          plant(lock, process.ppid, 'c-successor'); // C's acquire: a live foreign owner
        },
      });
    assert.throws(b, /timed out waiting/);
    assert.equal(ownerToken(lock), 'c-successor', "B's takeover deleted C's successor lock");
    assert.equal(ranB, false, 'B entered fn while C held the lock');
    assert.deepEqual(readdirSync(join(lock, '..')).sort(), ['x.lock'], 'takeover guard left behind');
  });

  it('a dead-owner lock is still taken over at once (seam fires, nothing raced)', () => {
    const lock = join(scratch(), 'x.lock');
    plant(lock, deadPid(), 'l1');
    let fired = 0;
    const r = withMkdirLock(lock, () => 'ran', { staleMs: 60_000, waitMs: 2_000, beforeTakeover: () => fired++ });
    assert.equal(r, 'ran');
    assert.ok(fired >= 1);
    assert.equal(existsSync(lock), false);
    assert.deepEqual(readdirSync(join(lock, '..')), []);
  });

  it('an ownerless lock (holder died between mkdir and owner write) is taken over once older than staleMs', () => {
    const lock = join(scratch(), 'x.lock');
    mkdirSync(lock);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    assert.equal(withMkdirLock(lock, () => 'ran', { staleMs: 10_000, waitMs: 2_000 }), 'ran');
    assert.deepEqual(readdirSync(join(lock, '..')), []);
  });

  it('a live holder is waited on, and onTimeout "run" proceeds without touching its lock', () => {
    const lock = join(scratch(), 'x.lock');
    plant(lock, process.ppid, 'live');
    assert.equal(withMkdirLock(lock, () => 'ran', { staleMs: 60_000, waitMs: 100, onTimeout: 'run' }), 'ran');
    assert.equal(ownerToken(lock), 'live');
  });

  it('a leftover takeover guard from a dead process is cleared once old enough', () => {
    const lock = join(scratch(), 'x.lock');
    plant(lock, deadPid(), 'l1');
    plant(`${lock}.takeover`, deadPid(), 'g');
    const old = new Date(Date.now() - 120_000);
    utimesSync(`${lock}.takeover`, old, old);
    assert.equal(withMkdirLock(lock, () => 'ran', { staleMs: 60_000, waitMs: 2_000 }), 'ran');
    assert.deepEqual(readdirSync(join(lock, '..')), []);
  });

  it('six processes contending for a dead-owner lock never overlap inside fn (10 rounds)', async () => {
    const mod = new URL('../src/core/mkdir-lock.ts', import.meta.url).pathname;
    const bun = Boolean((process.versions as { bun?: string }).bun);
    const code = `
      import { appendFileSync } from 'node:fs';
      import { withMkdirLock, sleepSync } from ${JSON.stringify(mod)};
      const [lock, log, startAt] = process.argv.slice(-3);
      while (Date.now() < Number(startAt)) sleepSync(1);
      withMkdirLock(lock, () => {
        const enter = Date.now();
        sleepSync(15);
        appendFileSync(log, enter + ' ' + Date.now() + '\\n');
      }, { staleMs: 60000, waitMs: 30000, pollMs: 1, beforeTakeover: () => sleepSync(Math.random() * 3) });`;
    const run = (args: string[]): Promise<void> =>
      new Promise((resolve, reject) => {
        const a = bun ? ['-e', code, ...args] : ['--import', 'tsx', '--input-type=module', '-e', code, ...args];
        const c = spawn(process.execPath, a, { stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        c.stderr.on('data', (b) => (err += b));
        c.on('error', reject);
        c.on('close', (rc) => (rc === 0 ? resolve() : reject(new Error(`worker exited ${rc}: ${err}`))));
      });
    for (let round = 0; round < 10; round++) {
      const d = scratch();
      const lock = join(d, 'x.lock');
      const log = join(d, 'log');
      plant(lock, deadPid(), 'stale');
      const startAt = String(Date.now() + 1_500);
      await Promise.all(Array.from({ length: 6 }, () => run([lock, log, startAt])));
      const spans = readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split(' ').map(Number));
      assert.equal(spans.length, 6, `round ${round}: a worker never ran fn`);
      spans.sort((x, y) => x[0] - y[0]);
      for (let i = 1; i < spans.length; i++) {
        assert.ok(spans[i][0] >= spans[i - 1][1], `round ${round}: fn overlapped ${JSON.stringify(spans)}`);
      }
      assert.deepEqual(readdirSync(d).sort(), ['log'], `round ${round}: lock or guard left behind`);
    }
  });
});
