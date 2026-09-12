import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { McpServer, McpToolDef } from '../src/mcp/contract.js';
import { registerJobTools } from '../src/mcp/tools-jobs.js';
import { writeRunRecord, type RunRecord } from '../src/core/registry.js';

// ---------------------------------------------------------------------------
// Async job tools (src/serve/PLAN.md §B), exercised IN PROCESS: the four
// harness_run_* handlers are registered on a stub server and invoked directly
// (contract: handler(args) -> result or throw; the JSON/text wrapping is the
// server's job and not under test here).
//
// The agent under the runs is `kiro` pointed at a FAKE kiro-cli shell script
// via $KIRO_CLI_BIN (the adapter resolves the binary from that env var at
// launch; precedent: tests/cli.test.ts). The MITM tap is pinned off via a
// nonexistent $MITMDUMP_BIN for determinism.
//
// EXPECTED-RED until seat W2 lands src/mcp/tools-jobs.ts (and its driver
// change: caller-chosen runId passthrough used as the registry record id).
// ---------------------------------------------------------------------------

interface RunAsyncResult {
  runId: string;
  sessionId?: unknown;
  started?: boolean;
  transcriptPath?: string;
}
interface RunStatusResult {
  found: boolean;
  runId?: string;
  status?: string;
  exitStatus?: string;
}
interface RunEventsResult {
  found?: boolean;
  events?: Array<Record<string, unknown>>;
  nextCursor?: number;
  total?: number;
  truncated?: boolean;
}
interface RunCancelResult {
  cancelled: boolean;
  status?: string;
  reason?: string;
}

let stateDir = '';
let binTmp = '';
const savedEnv: Record<string, string | undefined> = {};

function mkState(): string {
  stateDir = mkdtempSync(join(tmpdir(), 'harness-jobs-state-'));
  return stateDir;
}

function fakeCli(name: string, body: string): string {
  const p = join(binTmp, `${name}.sh`);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

const QUICK_SUCCESS = `echo '{"type":"session_start","sessionId":"sess-jobs-quick"}'
echo '{"type":"assistant","text":"done"}'
exit 0`;

// Emits the session id, then hangs until SIGTERM (driver abort path), taking
// its own sleep child down with it.
const LONG_RUNNING = `echo '{"type":"session_start","sessionId":"sess-jobs-long"}'
sleep 30 &
child=$!
trap 'kill "$child" 2>/dev/null; exit 0' TERM INT
wait "$child"`;

/** Register the job tools on a stub server; return the defs by name. */
function jobTools(dir: string): Map<string, McpToolDef> {
  const defs: McpToolDef[] = [];
  const stub = {
    registerTool(def: McpToolDef): void {
      defs.push(def);
    },
    serve: async (): Promise<void> => {},
  } as unknown as McpServer;
  registerJobTools(stub, { stateDir: dir });
  return new Map(defs.map((d) => [d.name, d]));
}

async function call<T>(tools: Map<string, McpToolDef>, name: string, args: Record<string, unknown>): Promise<T> {
  const def = tools.get(name);
  assert.ok(def, `tool ${name} must be registered`);
  return (await def.handler(args)) as T;
}

async function until<T>(
  probe: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  timeoutMs: number,
  label: string,
  everyMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** Minimal registry record (schema-valid per src/core/registry.ts). */
function rec(runId: string, over: Partial<RunRecord> = {}): RunRecord {
  return {
    runId,
    agent: 'kiro',
    pid: process.pid,
    cwd: '/tmp/proj',
    promptPreview: 'seeded',
    startedAt: 1_000,
    updatedAt: 1_000,
    status: 'success',
    exitStatus: 'success',
    totals: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
    rawTranscript: '/tmp/proj/raw/kiro-s1.jsonl',
    ...over,
  };
}

before(() => {
  binTmp = mkdtempSync(join(tmpdir(), 'harness-jobs-bin-'));
  savedEnv.KIRO_CLI_BIN = process.env.KIRO_CLI_BIN;
  savedEnv.MITMDUMP_BIN = process.env.MITMDUMP_BIN;
  // Deterministic tap-off (mirrors tests/cli.test.ts).
  process.env.MITMDUMP_BIN = '/nonexistent/mitmdump';
});

afterEach(() => {
  delete process.env.KIRO_CLI_BIN;
  if (stateDir) {
    rmSync(stateDir, { recursive: true, force: true });
    stateDir = '';
  }
});

after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (binTmp) rmSync(binTmp, { recursive: true, force: true });
});

describe('harness_run_async', () => {
  it('returns promptly (<2s) with a runId and the registry record appears', { timeout: 30_000 }, async () => {
    const dir = mkState();
    process.env.KIRO_CLI_BIN = fakeCli('quick', QUICK_SUCCESS);
    const tools = jobTools(dir);

    const t0 = Date.now();
    const res = await call<RunAsyncResult>(tools, 'harness_run_async', { agent: 'kiro', prompt: 'hi' });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 2_000, `run_async took ${elapsed}ms — it must not await the run`);
    assert.match(res.runId, /^[0-9a-f-]{36}$/i, `runId must be a uuid, got: ${res.runId}`);
    assert.equal(res.started, true);

    // The registry file for THAT id must appear (caller-chosen runId is the
    // registry record id per PLAN §B).
    await until(
      () => existsSync(join(dir, 'runs', `${res.runId}.json`)),
      10_000,
      `registry record for ${res.runId}`,
    );
    // Let the fake run drain so the process does not keep dangling work.
    await until(
      () =>
        (JSON.parse(readFileSync(join(dir, 'runs', `${res.runId}.json`), 'utf8')) as RunRecord).status !==
        'running',
      15_000,
      'quick fake run to finish',
    );
  });
});

describe('harness_run_status', () => {
  it('found:false for an unknown runId', { timeout: 30_000 }, async () => {
    const tools = jobTools(mkState());
    const res = await call<RunStatusResult>(tools, 'harness_run_status', { runId: randomUUID() });
    assert.equal(res.found, false);
  });

  it('transitions running → success for a quick fake run', { timeout: 30_000 }, async () => {
    const dir = mkState();
    process.env.KIRO_CLI_BIN = fakeCli('quick2', QUICK_SUCCESS);
    const tools = jobTools(dir);
    const started = await call<RunAsyncResult>(tools, 'harness_run_async', { agent: 'kiro', prompt: 'hi' });

    // Poll: found immediately, then terminal success once the driver finalizes.
    const final = await until<RunStatusResult | undefined>(async () => {
      const s = await call<RunStatusResult>(tools, 'harness_run_status', { runId: started.runId });
      if (!s.found) return undefined; // registry record not flushed yet
      assert.equal(s.runId, started.runId);
      if (s.status === 'running') return undefined;
      return s;
    }, 15_000, `run ${started.runId} to leave 'running'`);
    assert.equal(final!.status, 'success');
    assert.equal(final!.exitStatus, 'success');
  });
});

describe('harness_run_events', () => {
  it('pages a seeded transcript with cursor/limit and reports nextCursor/total/truncated', { timeout: 30_000 }, async () => {
    const dir = mkState();
    const tools = jobTools(dir);

    const runId = 'evseed-run-0001';
    mkdirSync(join(dir, 'raw'), { recursive: true });
    const transcript = join(dir, 'raw', 'evseed.jsonl');
    const seeded = Array.from({ length: 7 }, (_, i) => ({ type: 'step', seq: i }));
    writeFileSync(transcript, seeded.map((e) => JSON.stringify(e)).join('\n') + '\n');
    writeRunRecord(dir, rec(runId, { rawTranscript: transcript }));

    // Default page: everything.
    const all = await call<RunEventsResult>(tools, 'harness_run_events', { runId });
    assert.equal(all.found, true);
    assert.equal(all.total, 7);
    assert.equal(all.truncated, false);
    assert.equal(all.nextCursor, 7);
    assert.equal(all.events!.length, 7);
    assert.deepEqual(all.events![0], { type: 'step', seq: 0 });

    // Mid page: cursor=2 limit=3 → seq 2..4, more remain.
    const mid = await call<RunEventsResult>(tools, 'harness_run_events', { runId, cursor: 2, limit: 3 });
    assert.deepEqual(
      mid.events,
      seeded.slice(2, 5),
      'events must be the transcript lines [cursor, cursor+limit)',
    );
    assert.equal(mid.total, 7);
    assert.equal(mid.nextCursor, 5);
    assert.equal(mid.truncated, true);

    // Tail page: cursor past the data.
    const tail = await call<RunEventsResult>(tools, 'harness_run_events', { runId, cursor: 7, limit: 3 });
    assert.deepEqual(tail.events, []);
    assert.equal(tail.nextCursor, 7);
    assert.equal(tail.truncated, false);
  });

  it('found:false for an unknown runId', { timeout: 30_000 }, async () => {
    const tools = jobTools(mkState());
    const res = await call<RunEventsResult>(tools, 'harness_run_events', { runId: randomUUID() });
    assert.equal(res.found, false);
  });
});

describe('harness_run_cancel', () => {
  it('cancels a long-running fake (status → aborted); a second cancel reports cancelled:false', { timeout: 30_000 }, async () => {
    const dir = mkState();
    process.env.KIRO_CLI_BIN = fakeCli('long', LONG_RUNNING);
    const tools = jobTools(dir);
    const started = await call<RunAsyncResult>(tools, 'harness_run_async', { agent: 'kiro', prompt: 'hang' });

    // Wait until the record exists and is live/running before cancelling.
    await until(async () => {
      const s = await call<RunStatusResult>(tools, 'harness_run_status', { runId: started.runId });
      return s.found && s.status === 'running' ? s : undefined;
    }, 10_000, `run ${started.runId} to reach 'running'`);

    const first = await call<RunCancelResult>(tools, 'harness_run_cancel', { runId: started.runId });
    assert.equal(first.cancelled, true, `first cancel must cancel: ${JSON.stringify(first)}`);

    const aborted = await until<RunStatusResult | undefined>(async () => {
      const s = await call<RunStatusResult>(tools, 'harness_run_status', { runId: started.runId });
      return s.found && s.status === 'aborted' ? s : undefined;
    }, 15_000, `run ${started.runId} to reach 'aborted'`);
    assert.equal(aborted!.status, 'aborted');

    // Second cancel: the run is already terminal → cancelled:false. The
    // in-process handle may still be draining when we get here, so retry
    // briefly rather than race the driver's cleanup.
    const second = await until<RunCancelResult | undefined>(async () => {
      const c = await call<RunCancelResult>(tools, 'harness_run_cancel', { runId: started.runId });
      return c.cancelled === false ? c : undefined;
    }, 5_000, 'second cancel to report cancelled:false');
    assert.equal(second!.cancelled, false);
  });
});
