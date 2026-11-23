// OpenCode adapter: (a) `--extra-arg` must reach `opencode run`'s argv, and
// (b) an opencode tool call must become ach tool events (tool_call +
// tool_result). Both are driven through the real CLI entry point
// (`ach run --agent opencode --json`) against a FAKE `opencode` on PATH that
// records its argv and replays NDJSON recorded from a live `opencode run
// --format json` (opencode 1.19.0, model opencode/deepseek-v4.1-flash-free;
// paths rewritten to /tmp/ach-fixture).
//
// A cross-adapter table then proves every other CLI adapter forwards
// extraArgs too (same PATH-shim technique, one binary per adapter).
//
// The live check (real opencode, real model, real read tool call) runs only
// with ACH_OPENCODE_LIVE=1, so `npm test` / prepack never touch the network.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { buildRunArgs, parseOpencodeLine, parseOpencodeLineRecord } from '../src/adapters/opencode.ts';

const CLI = new URL('../src/cli/ach.ts', import.meta.url).pathname;
const isBun = (process.versions as { bun?: string }).bun !== undefined;
// Absolute loader URL: the child runs in a temp cwd, where a bare `--import tsx` cannot resolve.
const TSX = isBun ? '' : import.meta.resolve('tsx');

const SID = 'ses_df937dc43ffe3guBEBvgXB1yZc';
const CALL_ID = 'call_00_ET_sXdRvs3EI8PfocrjqNBh1810';
const READ_OUTPUT =
  '<path>/tmp/ach-fixture/proj/note.txt</path>\n<type>file</type>\n<content>\n1: magic-word: pelican-42\n\n(End of file - total 1 lines)\n</content>';

// Recorded live (opencode 1.19.0): the model calls `read`, then answers.
const TOOL_RUN_LINES = [
  `{"type":"step_start","timestamp":1795410110781,"sessionID":"${SID}","part":{"id":"prt_206c8293b001wfxcLUbKVo30Cl","messageID":"msg_206c824900015pqJhtKUegtoIf","sessionID":"${SID}","type":"step-start"}}`,
  JSON.stringify({
    type: 'tool_use',
    timestamp: 1795410110973,
    sessionID: SID,
    part: {
      type: 'tool',
      tool: 'read',
      callID: CALL_ID,
      state: {
        status: 'completed',
        input: { filePath: '/tmp/ach-fixture/proj/note.txt' },
        output: READ_OUTPUT,
        metadata: { preview: 'magic-word: pelican-42', truncated: false, loaded: [] },
        title: 'tmp/ach-fixture/proj/note.txt',
        time: { start: 1795410110960, end: 1795410110966 },
      },
      id: 'prt_206c8294c001y3LUAv1XwGFZ2J',
      sessionID: SID,
      messageID: 'msg_206c824900015pqJhtKUegtoIf',
    },
  }),
  `{"type":"step_finish","timestamp":1795410110973,"sessionID":"${SID}","part":{"id":"prt_206c829f8001dxNh5YQscqyJyA","reason":"tool-calls","messageID":"msg_206c824900015pqJhtKUegtoIf","sessionID":"${SID}","type":"step-finish","tokens":{"total":7898,"input":6053,"output":53,"reasoning":0,"cache":{"write":0,"read":1792}},"cost":0}}`,
  `{"type":"step_start","timestamp":1795410111506,"sessionID":"${SID}","part":{"id":"prt_206c82c0f001JBsPKVoHFQsVml","messageID":"msg_206c829fb001gGzMgupskVlurB","sessionID":"${SID}","type":"step-start"}}`,
  `{"type":"text","timestamp":1795410111530,"sessionID":"${SID}","part":{"id":"prt_206c82c11001jHK87rNFFn6VJ5","messageID":"msg_206c829fb001gGzMgupskVlurB","sessionID":"${SID}","type":"text","text":"pelican-42","time":{"start":1795410111505,"end":1795410111524}}}`,
  `{"type":"step_finish","timestamp":1795410111530,"sessionID":"${SID}","part":{"id":"prt_206c82c25001iakzKvaeivfFHM","reason":"stop","messageID":"msg_206c829fb001gGzMgupskVlurB","sessionID":"${SID}","type":"step-finish","tokens":{"total":7967,"input":154,"output":5,"reasoning":0,"cache":{"write":0,"read":7808}},"cost":0}}`,
];

// Recorded live (opencode 1.19.0): a read of a file that does not exist.
const TOOL_ERROR_LINE =
  '{"type":"tool_use","timestamp":1795410281802,"sessionID":"ses_df935478fffe4SbHdf7tQ5ocb4","part":{"type":"tool","tool":"read","callID":"call-4e638c53-125b-42b2-b762-760abfc67c28","state":{"status":"error","input":{"filePath":"/tmp/ach-fixture/proj/missing-file.txt"},"error":"File not found: /tmp/ach-fixture/proj/missing-file.txt","time":{"start":1795410281798,"end":1795410281801}},"id":"prt_206cac543001prN8JkrFJiDa1A","sessionID":"ses_df935478fffe4SbHdf7tQ5ocb4","messageID":"msg_206cab9ba001CshW3MWBQj27E7"}}';

// One shim script, copied under every agent binary name. It appends
// {bin, argv} to $SHIM_ARGV_LOG for EVERY invocation (version probes
// included), and replays $SHIM_FIXTURE only for `opencode run`.
const SHIM_JS = `
const fs = require('node:fs');
const path = require('node:path');
const bin = path.basename(process.env.SHIM_BIN_NAME || process.argv[1]);
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.SHIM_ARGV_LOG, JSON.stringify({ bin, argv }) + '\\n');
if (bin === 'opencode' && argv[0] === 'run' && process.env.SHIM_FIXTURE) {
  process.stdout.write(fs.readFileSync(process.env.SHIM_FIXTURE, 'utf8'));
}
process.exit(0);
`;

interface Invocation {
  bin: string;
  argv: string[];
}

interface RunJson {
  exitStatus: string;
  events: Array<Record<string, unknown>>;
}

describe('opencode adapter: extraArgs and tool events (end to end, fake opencode)', () => {
  let root: string;
  let fakeBin: string;
  let shimJs: string;
  let fixture: string;

  const BINS = ['opencode', 'claude', 'codex', 'gemini', 'agy', 'prime-agent', 'copilot', 'cursor-agent', 'kiro-cli'];

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'ach-oc-extra-'));
    fakeBin = join(root, 'bin');
    mkdirSync(fakeBin);
    shimJs = join(root, 'shim.cjs');
    writeFileSync(shimJs, SHIM_JS);
    for (const b of BINS) {
      const p = join(fakeBin, b);
      writeFileSync(p, `#!/bin/sh\nSHIM_BIN_NAME=${b} exec '${process.execPath}' '${shimJs}' "$@"\n`);
      chmodSync(p, 0o755);
    }
    fixture = join(root, 'tool-run.jsonl');
    writeFileSync(fixture, TOOL_RUN_LINES.join('\n') + '\n');
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  function cli(args: string[], env: Record<string, string> = {}): { code: number; stdout: string; stderr: string; calls: Invocation[] } {
    const state = mkdtempSync(join(root, 'state-'));
    const home = mkdtempSync(join(root, 'home-'));
    const log = join(state, 'argv.jsonl');
    // Unset (not empty): an empty *_BIN override would replace the PATH lookup.
    const base: NodeJS.ProcessEnv = { ...process.env };
    for (const k of ['CURSOR_AGENT_BIN', 'COPILOT_CLI_BIN', 'KIRO_CLI_BIN', 'OPENCODE_SERVER_URL']) delete base[k];
    const p = spawnSync(process.execPath, isBun ? [CLI, ...args] : ['--import', TSX, CLI, ...args], {
      env: {
        ...base,
        AGENTIC_CODING_HARNESS_STATE_DIR: state,
        HOME: home,
        AGENTIC_CODING_HARNESS_BUDGET_USD: '',
        AGENTIC_CODING_HARNESS_MAX_TURNS: '',
        AGENTIC_CODING_HARNESS_WALL_MS: '',
        AGENTIC_CODING_HARNESS_IDLE_MS: '',
        PATH: `${fakeBin}:/usr/bin:/bin`,
        SHIM_ARGV_LOG: log,
        SHIM_FIXTURE: fixture,
        ...env,
      },
      cwd: home,
      encoding: 'utf8',
      timeout: 60_000,
    });
    const calls = existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Invocation)
      : [];
    return { code: p.status ?? -1, stdout: p.stdout ?? '', stderr: p.stderr ?? '', calls };
  }

  function opencodeRun(calls: Invocation[]): string[] {
    const run = calls.filter((c) => c.bin === 'opencode' && c.argv[0] === 'run');
    assert.equal(run.length, 1, `expected exactly one 'opencode run' call, got ${JSON.stringify(calls)}`);
    return run[0]!.argv;
  }

  it('(a) --extra-arg reaches opencode run argv (both --extra-arg and --extra-args forms)', () => {
    const r = cli([
      'run', '--agent', 'opencode', '--json', '--wall-ms', '30000', '--idle-ms', '20000',
      '--extra-arg', '--agent', '--extra-arg', 'fleet-probe', '--extra-args', '--variant high',
      'read note.txt',
    ]);
    const argv = opencodeRun(r.calls);
    // control: the base argv is there on both sides of the fix.
    assert.equal(argv[0], 'run');
    assert.equal(argv[1], 'read note.txt');
    assert.deepEqual(argv.slice(2, 4), ['--format', 'json']);
    // the claim: the extra args arrive verbatim, in command-line order, after the built flags.
    assert.deepEqual(argv.slice(-4), ['--agent', 'fleet-probe', '--variant', 'high'], `argv: ${JSON.stringify(argv)}`);
  });

  it('(b) an opencode tool call becomes ach tool_call + tool_result events', () => {
    const r = cli(['run', '--agent', 'opencode', '--json', '--wall-ms', '30000', '--idle-ms', '20000', 'read note.txt']);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout) as RunJson;
    assert.equal(out.exitStatus, 'success');
    // control: the assistant reply after the tool call is there on both sides of the fix.
    assert.ok(out.events.some((e) => e.type === 'message' && e.content === 'pelican-42'), 'final assistant message');
    const call = out.events.find((e) => e.type === 'tool_call');
    assert.ok(call, `no tool_call event in ${JSON.stringify(out.events.map((e) => e.type))}`);
    assert.equal(call.functionName, 'read');
    assert.equal(call.toolCallId, CALL_ID);
    assert.deepEqual(call.arguments, { filePath: '/tmp/ach-fixture/proj/note.txt' });
    const result = out.events.find((e) => e.type === 'tool_result');
    assert.ok(result, 'no tool_result event');
    assert.equal(result.toolCallId, CALL_ID);
    assert.equal(result.isError, false);
    assert.match(String(result.content), /pelican-42/);
    // the tool span is opencode's own state.time (6 ms), not the ~0 ms receive gap.
    assert.equal(call.timestamp, 1795410110960);
    assert.equal(result.timestamp, 1795410110966);
    // ordering: call before result, both before the final answer.
    const idx = (pred: (e: Record<string, unknown>) => boolean) => out.events.findIndex(pred);
    assert.ok(idx((e) => e.type === 'tool_call') < idx((e) => e.type === 'tool_result'));
    assert.ok(idx((e) => e.type === 'tool_result') < idx((e) => e.type === 'message' && e.content === 'pelican-42'));
  });

  // Every other CLI adapter: extraArgs must reach the agent binary's argv.
  const TABLE: Array<{ agent: string; bin: string }> = [
    { agent: 'claude', bin: 'claude' },
    { agent: 'codex', bin: 'codex' },
    { agent: 'gemini', bin: 'gemini' },
    { agent: 'agy', bin: 'agy' },
    { agent: 'prime', bin: 'prime-agent' },
    { agent: 'copilot', bin: 'copilot' },
    { agent: 'cursor', bin: 'cursor-agent' },
    { agent: 'kiro', bin: 'kiro-cli' },
  ];
  for (const { agent, bin } of TABLE) {
    it(`extraArgs reach the ${agent} binary (${bin})`, () => {
      const r = cli(['run', '--agent', agent, '--json', '--wall-ms', '20000', '--idle-ms', '15000', '--extra-arg=--zz-probe', 'p'], {
        CURSOR_API_KEY: 'test-key',
      });
      const own = r.calls.filter((c) => c.bin === bin);
      assert.ok(own.length > 0, `${bin} was never spawned; stderr: ${r.stderr.slice(0, 400)}`);
      assert.ok(
        own.some((c) => c.argv.includes('--zz-probe')),
        `--zz-probe missing from every ${bin} call: ${JSON.stringify(own)}`,
      );
    });
  }
});

describe('opencode adapter: unit (buildRunArgs, tool part mapping)', () => {
  it('buildRunArgs appends extraArgs after the built flags', () => {
    assert.deepEqual(
      buildRunArgs({ prompt: 'p', model: 'a/b', resume: { sessionId: 'ses_1' }, extraArgs: ['--agent', 'x'] } as Parameters<typeof buildRunArgs>[0]),
      ['run', 'p', '--format', 'json', '--model', 'a/b', '--session', 'ses_1', '--agent', 'x'],
    );
  });

  it('a completed tool_use line maps to tool start + result with the same callID', () => {
    const parsed = parseOpencodeLineRecord(TOOL_RUN_LINES[1]!);
    assert.equal(parsed.sessionId, SID);
    assert.deepEqual(parsed.events, [
      { type: 'tool', phase: 'start', toolName: 'read', toolCallId: CALL_ID, input: { filePath: '/tmp/ach-fixture/proj/note.txt' }, title: 'tmp/ach-fixture/proj/note.txt', timestamp: 1795410110960 },
      { type: 'tool', phase: 'result', toolName: 'read', toolCallId: CALL_ID, output: READ_OUTPUT, status: 'success', timestamp: 1795410110966 },
    ]);
  });

  it('an error tool_use line maps to a result with status error and the error text', () => {
    const events = parseOpencodeLine(TOOL_ERROR_LINE);
    assert.equal(events.length, 2);
    assert.deepEqual(events[1], {
      type: 'tool',
      phase: 'result',
      toolName: 'read',
      toolCallId: 'call-4e638c53-125b-42b2-b762-760abfc67c28',
      output: 'File not found: /tmp/ach-fixture/proj/missing-file.txt',
      status: 'error',
      timestamp: 1795410281801,
    });
  });

  it('a pending/running tool part emits only the start (no result yet)', () => {
    const line = JSON.stringify({ type: 'tool_use', sessionID: 's', part: { type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'running', input: { command: 'ls' } } } });
    assert.deepEqual(parseOpencodeLine(line), [{ type: 'tool', phase: 'start', toolName: 'bash', toolCallId: 'c1', input: { command: 'ls' } }]);
  });
});

// Live: one short real `opencode run` through ach where the model calls the
// read tool. Isolated config (OPENCODE_CONFIG + XDG_CONFIG_HOME + XDG_STATE_HOME
// + OPENCODE_TEST_HOME under a temp dir); auth/data stay the user's. Bounded by
// --wall-ms/--idle-ms and the spawnSync timeout.
const LIVE = process.env.ACH_OPENCODE_LIVE === '1';
describe('opencode live: a real read tool call becomes an ach tool event', { skip: LIVE ? false : 'set ACH_OPENCODE_LIVE=1 (needs opencode on PATH + network)' }, () => {
  it('tool_call(read) + tool_result arrive, and the answer quotes the file', () => {
    const which = spawnSync('sh', ['-c', 'command -v opencode'], { encoding: 'utf8' });
    assert.equal(which.status, 0, 'opencode not on PATH');
    const iso = mkdtempSync(join(tmpdir(), 'ach-oc-live-'));
    try {
      for (const d of ['cfg', 'state', 'home', 'proj', 'ach-state']) mkdirSync(join(iso, d));
      writeFileSync(join(iso, 'only.json'), '{"$schema":"https://opencode.ai/config.json"}\n');
      writeFileSync(join(iso, 'proj', 'note.txt'), 'magic-word: heron-77\n');
      const model = process.env.ACH_OPENCODE_LIVE_MODEL ?? 'opencode/deepseek-v4.1-flash-free';
      const env: Record<string, string | undefined> = {
        ...process.env,
        OPENCODE_CONFIG: join(iso, 'only.json'),
        XDG_CONFIG_HOME: join(iso, 'cfg'),
        XDG_STATE_HOME: join(iso, 'state'),
        OPENCODE_TEST_HOME: join(iso, 'home'),
        OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
        AGENTIC_CODING_HARNESS_STATE_DIR: join(iso, 'ach-state'),
        // spawnSync's cwd does not update PWD, and opencode resolves paths from PWD.
        PWD: join(iso, 'proj'),
      };
      delete env.OPENCODE_CONFIG_CONTENT;
      delete env.OPENCODE_CONFIG_DIR;
      const args = [
        'run', '--agent', 'opencode', '--model', model, '--json', '--wall-ms', '150000', '--idle-ms', '90000',
        'Use the read tool to read note.txt, then reply with the magic word only.',
      ];
      const p = spawnSync(process.execPath, isBun ? [CLI, ...args] : ['--import', TSX, CLI, ...args], {
        env: env as NodeJS.ProcessEnv,
        cwd: join(iso, 'proj'),
        encoding: 'utf8',
        timeout: 180_000,
      });
      assert.equal(p.status, 0, `exit ${p.status}; stderr: ${p.stderr?.slice(-800)}`);
      const out = JSON.parse(p.stdout) as RunJson;
      const call = out.events.find((e) => e.type === 'tool_call' && e.functionName === 'read');
      assert.ok(call, `no read tool_call; event types: ${JSON.stringify(out.events.map((e) => e.type))}`);
      const result = out.events.find((e) => e.type === 'tool_result' && e.toolCallId === call.toolCallId);
      assert.ok(result, 'no matching tool_result');
      assert.match(String(result.content), /heron-77/);
      assert.ok(out.events.some((e) => e.type === 'message' && /heron-77/.test(String(e.content))), 'answer quotes the file');
      console.log(`LIVE verdict: tool_call ${call.functionName} ${call.toolCallId} -> tool_result isError=${result.isError}`);
    } finally {
      rmSync(iso, { recursive: true, force: true });
    }
  });
});
