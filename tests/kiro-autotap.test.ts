// Kiro MITM auto-tap integration: launch() starting/stopping the tap, credit
// capture, env routing, graceful degradation, and the tap's own helpers
// (port scan, mitmdump probe).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { KiroAdapter } from '../src/adapters/kiro.js';
import { findKiroMitmPort, mitmdumpAvailable } from '../src/monitors/kiro-mitm.js';
import { FakeChild, runCall, versionProbeSpawnFn, type FakeSpawnCall } from './helpers/fake-child.ts';
import type { AgentEvent } from '../src/core/types.js';

// What the fake mitmdump prints: one meteringEvent record carrying 0.05 credits.
const METERING_LINE = JSON.stringify({
  event: 'meteringEvent',
  tokenUsage: {
    uncachedInputTokens: 1200,
    cacheReadInputTokens: 3400,
    cacheWriteInputTokens: 500,
    outputTokens: 210,
    totalTokens: 5310,
  },
  credits: 0.05,
  contextUsagePercentage: 11.7,
  ts: 1_700_000_000,
});

// The two fakes hand-shake through a per-port READY marker so the run cannot
// finish before the "proxy" has produced its record: real records only exist
// because kiro-cli talked THROUGH mitmdump, so a fake kiro-cli that exits in
// 5 ms while the fake mitmdump shell is still starting up (and dies unprinted
// on the adapter's SIGTERM) would be racing something reality never races.
function fakeMitmdump(readyDir: string): string {
  return `#!/bin/sh
# fake mitmdump: print one meteringEvent line, mark ready, then sleep until SIGTERM.
# argv: -p <port> -s <script>
port="$2"
if [ -n "$FAKE_MITMDUMP_PIDFILE" ]; then echo $$ > "$FAKE_MITMDUMP_PIDFILE"; fi
echo '${METERING_LINE}'
touch "${readyDir}/ready.$port"
sleep 30 &
child=$!
trap 'rm -f "${readyDir}/ready.$port"; kill "$child" 2>/dev/null; exit 0' TERM INT
wait $!
`;
}

function fakeKiroCli(readyDir: string): string {
  return `#!/bin/sh
# fake kiro-cli: answer the adapter's --version probe; otherwise wait for the
# fake mitmdump (port taken from HTTPS_PROXY) to be ready, dump env when
# asked, print a stream-json reply, exit 0.
if [ "$1" = "--version" ]; then echo 'kiro-cli 2.21.2'; exit 0; fi
if [ -n "$HTTPS_PROXY" ]; then
  port="\${HTTPS_PROXY##*:}"
  i=0
  while [ ! -f "${readyDir}/ready.$port" ] && [ "$i" -lt 300 ]; do sleep 0.01; i=$((i+1)); done
fi
if [ -n "$FAKE_KIRO_ENV_FILE" ]; then env > "$FAKE_KIRO_ENV_FILE"; fi
echo '{"type":"session_start","sessionId":"sess-autotap-1"}'
echo '{"type":"assistant","text":"done"}'
exit 0
`;
}

let dir: string;
let mitmdump: string;
let kiroCli: string;

function writeExecutable(name: string, body: string): string {
  const file = join(dir, name);
  writeFileSync(file, body, { mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

async function collect(handle: { attach(): AsyncIterable<AgentEvent> }): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of handle.attach()) events.push(event);
  return events;
}

/** Run fn with process.stderr writes captured (adapter degradation warnings). */
async function withCapturedStderr<T>(fn: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  const orig = process.stderr.write.bind(process.stderr);
  let out = '';
  (process.stderr as unknown as { write: unknown }).write = ((chunk: unknown) => {
    out += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await fn();
    return { result, stderr: out };
  } finally {
    process.stderr.write = orig;
  }
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'kiro-autotap-'));
  mitmdump = writeExecutable('fake-mitmdump.sh', fakeMitmdump(dir));
  kiroCli = writeExecutable('fake-kiro-cli.sh', fakeKiroCli(dir));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('kiro MITM auto-tap (launch)', () => {
  it('mitm:true routes the child through the tap, captures credits, exits success, stops the tap', async () => {
    const pidFile = join(dir, 'mitm.pid');
    const envFile = join(dir, 'kiro.env');
    process.env.FAKE_MITMDUMP_PIDFILE = pidFile;
    process.env.FAKE_KIRO_ENV_FILE = envFile;
    try {
      const adapter = new KiroAdapter({ command: kiroCli, mitm: true, mitmdumpBin: mitmdump });
      const handle = await adapter.launch({ prompt: 'tap me' });
      const events = await collect(handle);
      assert.equal(await handle.wait(), 'success');

      // One usage event from the tap. The tap's OWN counts survive verbatim
      // (this fixture is non-zero), so extra.tokensAvailable is true; on real
      // kiro 2.21.2 every field is 0 and the flag goes false instead.
      const usage = events.filter((e) => e.type === 'usage');
      assert.equal(usage.length, 1, `expected exactly one tap usage event, got ${JSON.stringify(events.map((e) => e.type))}`);
      const record = usage[0]!.usage;
      assert.equal(record.inputTokens, 1200);
      assert.equal(record.outputTokens, 210);
      assert.equal(record.cacheReadTokens, 3400);
      assert.equal(record.cacheWriteTokens, 500);
      assert.equal(record.costUsd, undefined);
      assert.equal(record.extra?.tokensAvailable, true);
      assert.equal(record.extra?.source, 'tap');
      assert.equal(record.extra?.credits, 0.05);
      assert.equal(record.extra?.event, 'meteringEvent');
      assert.equal(record.extra?.totalTokens, 5310);

      // Stdout events interleaved in the same stream.
      assert.ok(events.some((e) => e.type === 'session'), 'no session event');
      assert.ok(events.some((e) => e.type === 'message' && e.content === 'done'), 'no reply message');
      assert.equal(handle.sessionId, 'sess-autotap-1');

      // The kiro child env pointed at the tap (port from the 8900-8999 range).
      const childEnv = readFileSync(envFile, 'utf8');
      assert.match(childEnv, /^HTTPS_PROXY=http:\/\/127\.0\.0\.1:89\d\d$/m);
      assert.match(childEnv, /^SSL_CERT_FILE=/m);

      // The tap was stopped (graceful SIGTERM) before wait() resolved.
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      assert.ok(Number.isInteger(pid) && pid > 0, `bad pid file content: ${pid}`);
      assert.throws(() => process.kill(pid, 0), /ESRCH/, 'mitmdump still alive after run');
    } finally {
      delete process.env.FAKE_MITMDUMP_PIDFILE;
      delete process.env.FAKE_KIRO_ENV_FILE;
    }
  });

  it('default (no mitm option, no spawnFn): tap on when the mitmdump bin resolves', async () => {
    const adapter = new KiroAdapter({ command: kiroCli, mitmdumpBin: mitmdump });
    const handle = await adapter.launch({ prompt: 'auto tap' });
    const events = await collect(handle);
    assert.equal(await handle.wait(), 'success');
    const usage = events.filter((e) => e.type === 'usage');
    assert.equal(usage.length, 1);
    assert.equal(usage[0]!.usage.extra?.credits, 0.05);
  });

  it('mitm:false spawns only kiro-cli, no proxy env, no usage events', async () => {
    const child = new FakeChild();
    const calls: FakeSpawnCall[] = [];
    const adapter = new KiroAdapter({ command: 'kiro-cli', spawnFn: versionProbeSpawnFn(child, calls), mitm: false });
    const launchPromise = adapter.launch({ prompt: 'plain' });
    child.writeStdout('{"type":"session_start","sessionId":"s-plain"}\n');
    child.writeStdout('{"type":"assistant","text":"hi"}\n');
    child.close(0);
    const handle = await launchPromise;
    const events = await collect(handle);
    assert.equal(await handle.wait(), 'success');
    assert.equal(runCall(calls).command, 'kiro-cli');
    assert.ok(!runCall(calls).opts.env?.HTTPS_PROXY, 'HTTPS_PROXY leaked into child env');
    assert.ok(!events.some((e) => e.type === 'usage'));
    assert.equal(handle.sessionId, 's-plain');
  });

  it('injected spawnFn keeps the tap off by default (hermetic unit runs)', async () => {
    const child = new FakeChild();
    const calls: FakeSpawnCall[] = [];
    const adapter = new KiroAdapter({ command: 'kiro-cli', spawnFn: versionProbeSpawnFn(child, calls), mitmdumpBin: mitmdump });
    const launchPromise = adapter.launch({ prompt: 'hermetic' });
    child.close(0);
    const handle = await launchPromise;
    await collect(handle);
    assert.equal(await handle.wait(), 'success');
    assert.ok(!runCall(calls).opts.env?.HTTPS_PROXY);
  });

  it('mitmdump missing: mitm:true degrades to an untapped run with a stderr warning', async () => {
    const child = new FakeChild();
    const calls: FakeSpawnCall[] = [];
    const adapter = new KiroAdapter({
      command: 'kiro-cli',
      spawnFn: versionProbeSpawnFn(child, calls),
      mitm: true,
      mitmdumpBin: join(dir, 'no-such-mitmdump'),
    });
    const { result: handle, stderr } = await withCapturedStderr(async () => {
      const launchPromise = adapter.launch({ prompt: 'degraded' });
      // launch() awaits the tap probe before spawning: let it settle so the
      // FakeChild's listeners attach before we feed it (real children cannot
      // exit before spawn; the fake can).
      await new Promise((resolve) => setImmediate(resolve));
      child.writeStdout('{"type":"assistant","text":"still works"}\n');
      child.close(0);
      return launchPromise;
    });
    const events = await collect(handle);
    assert.equal(await handle.wait(), 'success');
    assert.match(stderr, /mitmdump .*not found.*without the credit\/token tap/);
    assert.ok(!runCall(calls).opts.env?.HTTPS_PROXY);
    assert.ok(!events.some((e) => e.type === 'usage'));
    assert.ok(events.some((e) => e.type === 'message'));
  });
});

describe('findKiroMitmPort', () => {
  it('returns the first bindable port in range, skipping taken ones', async () => {
    const p1 = await findKiroMitmPort(8930, 8939);
    assert.ok(p1 !== null && p1 >= 8930 && p1 <= 8939);
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(p1, '127.0.0.1', resolve));
    try {
      const p2 = await findKiroMitmPort(8930, 8939);
      assert.ok(p2 !== null && p2 >= 8930 && p2 <= 8939 && p2 !== p1);
    } finally {
      blocker.close();
    }
  });

  it('returns null when the whole range is busy', async () => {
    const blockers = [8950, 8951, 8952].map(() => net.createServer());
    await Promise.all(
      blockers.map((s, i) => new Promise<void>((resolve) => s.listen(8950 + i, '127.0.0.1', resolve))),
    );
    try {
      assert.equal(await findKiroMitmPort(8950, 8952), null);
    } finally {
      for (const s of blockers) s.close();
    }
  });
});

describe('mitmdumpAvailable (cached probe)', () => {
  it('resolves path binaries via existsSync and caches', () => {
    assert.equal(mitmdumpAvailable(join(dir, 'no-such-mitmdump')), false);
    assert.equal(mitmdumpAvailable(mitmdump), true);
  });

  it('resolves bare names from PATH', () => {
    assert.equal(mitmdumpAvailable('sh'), true);
    assert.equal(mitmdumpAvailable('definitely-not-a-real-binary-xyz'), false);
  });
});
