// Issue #54: cross-CLI effort normalization. One table (src/core/effort.ts)
// maps `--effort <level>` onto each agent's native mechanism; these tests pin
// the argv every adapter actually spawns, the unmapped-adapter warning and
// record, the RunRecord fields, kiro's unchanged argv, and the MCP routing.
import assert from 'node:assert/strict';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { AgyAdapter } from '../src/adapters/agy.ts';
import { ClaudeCodeAdapter } from '../src/adapters/claude.ts';
import { CodexAdapter } from '../src/adapters/codex.ts';
import { CopilotAdapter } from '../src/adapters/copilot.ts';
import { CursorAdapter } from '../src/adapters/cursor.ts';
import { GeminiAdapter } from '../src/adapters/gemini.ts';
import { buildKiroAcpArgs } from '../src/adapters/kiro-acp.ts';
import { buildKiroArgs, KiroAdapter } from '../src/adapters/kiro.ts';
import { NullAdapter } from '../src/adapters/null.ts';
import { buildRunArgs, OpenCodeAdapter } from '../src/adapters/opencode.ts';
import { PrimeAdapter } from '../src/adapters/prime.ts';
import type { SpawnFn } from '../src/adapters/shared.ts';
import { createDriver } from '../src/core/driver.ts';
import { createPricer } from '../src/core/pricing.ts';
import {
  applyEffortToSpec,
  EFFORT_LEVELS,
  EFFORT_TABLE,
  effortModelArg,
  nearestEffort,
  resolveEffort,
  type EffortLevel,
} from '../src/core/effort.ts';
import { listRunRecords, readRunRecord } from '../src/core/registry.ts';
import type { KiroConfig, RunSpec } from '../src/core/types.ts';
import { createMcpServer } from '../src/mcp/server.ts';
import { toSpec } from '../src/mcp/tools-jobs.ts';
import { registerRunTools, toRunSpec } from '../src/mcp/tools-run.ts';
import { FakeChild, type FakeSpawnCall } from './helpers/fake-child.ts';

const ROOT = resolve(import.meta.dirname, '..');
const CLI = join(ROOT, 'src', 'cli', 'ach.ts');

/**
 * SpawnFn that hands every spawn a fresh FakeChild which exits 0 with no
 * output (a `--version` probe answers with a version line), recording argv.
 * Runs end quickly (error/success does not matter); the argv is the point.
 */
function exitingSpawn(calls: FakeSpawnCall[]): SpawnFn {
  return (command, args, opts) => {
    calls.push({ command, args, opts });
    const child = new FakeChild();
    queueMicrotask(() => {
      child.emit('spawn');
      setTimeout(() => {
        if (args[0] === '--version' || args.includes('--version')) child.writeStdout('kiro-cli 3.5.0\n');
        child.close(0);
      }, 5);
    });
    return child as unknown as ChildProcess;
  };
}

interface Launchable {
  launch(spec: RunSpec): Promise<unknown>;
  validateProfile?(spec: RunSpec): unknown;
}

/** Run `agent` through the REAL driver (resolveEffort + applyEffortToSpec) with a real adapter on a fake spawn. */
async function driveArgv(
  agent: string,
  make: (spawnFn: SpawnFn) => Launchable,
  spec: Partial<RunSpec>,
): Promise<{ argv: string[]; calls: FakeSpawnCall[]; result: Awaited<ReturnType<ReturnType<typeof createDriver>['run']>>; reg: string }> {
  const calls: FakeSpawnCall[] = [];
  const adapter = make(exitingSpawn(calls));
  const root = mkdtempSync(join(tmpdir(), `effort-${agent}-`));
  const reg = join(root, 'reg');
  const driver = createDriver({
    adapters: {
      [agent]: {
        name: agent,
        launch: (s: RunSpec) => adapter.launch(s) as never,
        ...(adapter.validateProfile ? { validateProfile: (s: RunSpec) => adapter.validateProfile!(s) as never } : {}),
      },
    },
    stateDir: join(root, 'state'),
    registry: { stateDir: reg },
  });
  const result = await driver.run(agent, { prompt: 'hi', cwd: root, ...spec } as RunSpec);
  const run = calls.filter((c) => !c.args.includes('--version') && c.args[0] !== 'status' && c.args[0] !== 'debug');
  assert.ok(run.length >= 1, `${agent}: expected a run spawn, got ${JSON.stringify(calls.map((c) => c.args))}`);
  return { argv: run[run.length - 1]!.args, calls, result, reg };
}

/** True when `argv` contains `seq` contiguously. */
function hasSeq(argv: string[], seq: string[]): boolean {
  for (let i = 0; i + seq.length <= argv.length; i++) if (seq.every((s, j) => argv[i + j] === s)) return true;
  return false;
}

describe('effort table (#54)', () => {
  it('has exactly one row per natively mapped agent', () => {
    assert.deepEqual(Object.keys(EFFORT_TABLE).sort(), ['agy', 'claude', 'codex', 'copilot', 'cursor', 'kiro', 'opencode']);
  });
  it('level set is low|medium|high|xhigh|max', () => {
    assert.deepEqual([...EFFORT_LEVELS], ['low', 'medium', 'high', 'xhigh', 'max']);
  });
  it('nearestEffort clamps to the nearest supported level, ties go higher', () => {
    assert.equal(nearestEffort('xhigh', ['low', 'medium', 'high']), 'high');
    assert.equal(nearestEffort('medium', ['low', 'high']), 'high');
    assert.equal(nearestEffort('max', ['low', 'medium', 'high', 'xhigh', 'max']), 'max');
  });
  it('effortModelArg appends or merges the bracket override', () => {
    assert.equal(effortModelArg('cursor', 'gpt-5', 'high'), 'gpt-5[effort=high]');
    assert.equal(effortModelArg('cursor', 'claude-opus-4-8[context=1m]', 'max'), 'claude-opus-4-8[context=1m,effort=max]');
    assert.equal(effortModelArg('cursor', 'm[effort=low]', 'max'), 'm[effort=low]');
    assert.equal(effortModelArg('claude', 'gpt-5', 'high'), 'gpt-5');
  });
});

describe('criterion 1: per-adapter argv through the driver (#54)', () => {
  const levels: EffortLevel[] = ['low', 'max'];
  for (const level of levels) {
    it(`claude --effort ${level} -> --effort ${level}`, async () => {
      const { argv, result } = await driveArgv('claude', (spawnFn) => new ClaudeCodeAdapter({ spawnFn: spawnFn as never }), { effort: level });
      assert.ok(hasSeq(argv, ['--effort', level]), argv.join(' '));
      assert.deepEqual(result.effort, { requested: level, applied: true, mechanism: '--effort' });
    });
    it(`codex --effort ${level} -> -c model_reasoning_effort=${level}`, async () => {
      const { argv, result } = await driveArgv('codex', (spawnFn) => new CodexAdapter({ spawnFn }), { effort: level });
      assert.ok(hasSeq(argv, ['-c', `model_reasoning_effort=${level}`]), argv.join(' '));
      assert.deepEqual(result.effort, { requested: level, applied: true, mechanism: `-c model_reasoning_effort=${level}` });
    });
    it(`agy --effort ${level} -> --effort ${level}`, async () => {
      const { argv, result } = await driveArgv('agy', (spawnFn) => new AgyAdapter({ spawnFn }), { effort: level });
      assert.ok(hasSeq(argv, ['--effort', level]), argv.join(' '));
      assert.equal(result.effort?.mechanism, '--effort');
    });
    it(`copilot --effort ${level} -> --reasoning-effort ${level}`, async () => {
      const { argv, result } = await driveArgv('copilot', (spawnFn) => new CopilotAdapter({ spawnFn }), { effort: level });
      assert.ok(hasSeq(argv, ['--reasoning-effort', level]), argv.join(' '));
      assert.equal(result.effort?.mechanism, '--reasoning-effort');
    });
    it(`opencode --effort ${level} -> --variant ${level}`, async () => {
      const { argv, result } = await driveArgv('opencode', (spawnFn) => new OpenCodeAdapter({ spawnFn }), { effort: level });
      assert.ok(hasSeq(argv, ['--variant', level]), argv.join(' '));
      assert.equal(result.effort?.mechanism, '--variant');
    });
    it(`cursor --effort ${level} --model gpt-5 -> --model gpt-5[effort=${level}]`, async () => {
      const { argv, result } = await driveArgv(
        'cursor',
        (spawnFn) => new CursorAdapter({ spawnFn, env: { CURSOR_API_KEY: 'test-key' } }),
        { effort: level, model: 'gpt-5' },
      );
      assert.ok(hasSeq(argv, ['--model', `gpt-5[effort=${level}]`]), argv.join(' '));
      assert.equal(result.effort?.mechanism, 'model-suffix');
    });
    it(`kiro --effort ${level} -> --effort ${level} (headless chat)`, async () => {
      const { argv, result } = await driveArgv('kiro', (spawnFn) => new KiroAdapter({ spawnFn, mitm: false }), { effort: level });
      assert.equal(argv[0], 'chat');
      assert.ok(hasSeq(argv, ['--effort', level]), argv.join(' '));
      assert.deepEqual(result.effort, { requested: level, applied: true, mechanism: '--effort' });
    });
  }

  it('gemini --effort high: no flag added, applied:false, warning names gemini', async () => {
    const without = await driveArgv('gemini', (spawnFn) => new GeminiAdapter({ spawnFn }), {});
    const withE = await driveArgv('gemini', (spawnFn) => new GeminiAdapter({ spawnFn }), { effort: 'high' });
    assert.deepEqual(withE.argv, without.argv);
    assert.deepEqual(withE.result.effort, { requested: 'high', applied: false, mechanism: 'none' });
    assert.ok(withE.result.warnings.some((w) => w.includes('gemini') && w.includes('no native effort control')));
  });

  for (const agent of ['kiro-ide', 'custom', 'null', 'my-descriptor-agent']) {
    it(`${agent} --effort high: resolves to none with a warning naming ${agent}`, () => {
      const r = resolveEffort(agent, 'high', { model: 'm', extraArgs: [] });
      assert.deepEqual(r.provenance, { requested: 'high', applied: false, mechanism: 'none' });
      assert.equal(r.extraArgs, undefined);
      assert.equal(r.kiroEffort, undefined);
      assert.deepEqual(r.warnings, [`effort: ${agent} has no native effort control; --effort high was not applied (recorded applied:false, mechanism none)`]);
    });
  }

  it('prime --effort high: no flag added, applied:false', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'effort-prime-agent-'));
    const without = await driveArgv('prime', (spawnFn) => new PrimeAdapter({ spawnFn, agentDir: dir }), {});
    const withE = await driveArgv('prime', (spawnFn) => new PrimeAdapter({ spawnFn, agentDir: dir }), { effort: 'high' });
    assert.deepEqual(withE.argv, without.argv);
    assert.deepEqual(withE.result.effort, { requested: 'high', applied: false, mechanism: 'none' });
  });

  it('cursor --effort without --model: argv has no --model, applied:false with a warning', async () => {
    const { argv, result } = await driveArgv(
      'cursor',
      (spawnFn) => new CursorAdapter({ spawnFn, env: { CURSOR_API_KEY: 'test-key' } }),
      { effort: 'high' },
    );
    assert.ok(!argv.includes('--model'), argv.join(' '));
    assert.equal(result.effort?.applied, false);
    assert.ok(result.warnings.some((w) => w.startsWith('effort: cursor')));
  });

  it('cursor: argv carries the suffix, pricing still uses the plain model (stub cursor-agent)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'effort-cursor-stub-'));
    const argvFile = join(root, 'argv.json');
    const adapter = new CursorAdapter({
      command: join(ROOT, 'tests', 'fixtures', 'cursor-agent', 'stub-cursor-agent.mjs'),
      env: { CURSOR_API_KEY: 'synthetic-key', STUB_CURSOR_MODE: 'computed', STUB_CURSOR_ARGV: argvFile },
    });
    const driver = createDriver({
      adapters: { cursor: { name: 'cursor', launch: (s: RunSpec) => adapter.launch(s), validateProfile: (s: RunSpec) => adapter.validateProfile(s) } },
      stateDir: join(root, 'state'),
      registry: { stateDir: join(root, 'reg') },
    });
    const result = await driver.run('cursor', { prompt: 'p', cwd: root, model: 'claude-sonnet-5', effort: 'high' });
    assert.equal(result.exitStatus, 'success');
    const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
    assert.ok(hasSeq(argv, ['--model', 'claude-sonnet-5[effort=high]']), argv.join(' '));
    const expected = createPricer().price({ agent: 'cursor', model: 'claude-sonnet-5', inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 0 });
    assert.ok(expected > 0);
    assert.ok(Math.abs(result.totalCost - expected) < 1e-12, `${result.totalCost} vs ${expected}`);
  });

  it('opencode buildRunArgs passes the injected --variant through verbatim', () => {
    const spec = applyEffortToSpec({ prompt: 'p', extraArgs: ['--x'] }, resolveEffort('opencode', 'xhigh', {}));
    const argv = buildRunArgs(spec as never);
    assert.ok(hasSeq(argv, ['--variant', 'xhigh', '--x']), argv.join(' '));
  });

  it('opencode preferServer: applied:false (serve path takes no argv)', () => {
    const r = resolveEffort('opencode', 'high', { preferServer: true });
    assert.deepEqual(r.provenance, { requested: 'high', applied: false, mechanism: 'none' });
    assert.equal(r.extraArgs, undefined);
  });

  it('kiro-acp v2 emits --effort; v3 emits only --agent-engine v3 and records acp:effortLevel', () => {
    const v2 = applyEffortToSpec({ kiro: { transport: 'acp' } as KiroConfig }, resolveEffort('kiro', 'high', { kiro: { transport: 'acp' } }));
    assert.deepEqual(buildKiroAcpArgs({ effort: v2.kiro!.effort as never }), ['acp', '--effort', 'high']);
    const v3view = { kiro: { transport: 'acp', engine: 'v3' } as KiroConfig };
    const r3 = resolveEffort('kiro', 'high', v3view);
    assert.equal(r3.provenance.mechanism, 'acp:effortLevel');
    const v3 = applyEffortToSpec(v3view, r3);
    assert.equal(v3.kiro!.effort, 'high');
    assert.deepEqual(buildKiroAcpArgs({ engine: 'v3', effort: 'high' }), ['acp', '--agent-engine', 'v3']);
  });

  it('an explicit native flag in extraArgs wins: not applied, warned, argv untouched', async () => {
    const { argv, result } = await driveArgv('claude', (spawnFn) => new ClaudeCodeAdapter({ spawnFn: spawnFn as never }), {
      effort: 'max',
      extraArgs: ['--effort', 'low'],
    });
    assert.ok(hasSeq(argv, ['--effort', 'low']));
    assert.ok(!argv.includes('max'), argv.join(' '));
    assert.equal(result.effort?.applied, false);
    assert.ok(result.warnings.some((w) => w.includes('extraArgs already set --effort')));
    const codex = resolveEffort('codex', 'max', { extraArgs: ['-c', 'model_reasoning_effort=low'] });
    assert.equal(codex.provenance.applied, false);
  });

  it('kiro: --effort conflicting with --kiro-effort is a USAGE error; equal values are fine', () => {
    assert.throws(() => resolveEffort('kiro', 'max', { kiro: { effort: 'low' } }), /conflicts with kiro\.effort/);
    assert.equal(resolveEffort('kiro', 'low', { kiro: { effort: 'low' } }).provenance.applied, true);
  });
});

describe('criterion 2: unmapped adapter completes, warns, records applied:false (#54)', () => {
  it('null agent: run succeeds, warning names the agent, result and persisted record say none', async () => {
    const root = mkdtempSync(join(tmpdir(), 'effort-null-'));
    const reg = join(root, 'reg');
    const adapter = new NullAdapter();
    const driver = createDriver({
      adapters: { null: { name: 'null', launch: (s: RunSpec) => adapter.launch(s) } },
      stateDir: join(root, 'state'),
      registry: { stateDir: reg },
    });
    const result = await driver.run('null', { prompt: 'hi', cwd: root, effort: 'xhigh' });
    assert.equal(result.exitStatus, 'success');
    assert.ok(
      result.warnings.some((w) => w === 'effort: null has no native effort control; --effort xhigh was not applied (recorded applied:false, mechanism none)'),
      JSON.stringify(result.warnings),
    );
    assert.deepEqual(result.effort, { requested: 'xhigh', applied: false, mechanism: 'none' });
    const rec = readRunRecord(reg, result.runId!);
    assert.deepEqual(rec?.effort, { requested: 'xhigh', applied: false, mechanism: 'none' });
    assert.equal(rec?.usage?.model?.requestedEffort, 'xhigh');
  });
});

describe('criterion 3: RunRecord fields on every --effort run; kiro unchanged without it (#54)', () => {
  it('mapped agent: persisted record has effort {requested, applied, mechanism} and usage.model.requestedEffort', async () => {
    const { result, reg } = await driveArgv('claude', (spawnFn) => new ClaudeCodeAdapter({ spawnFn: spawnFn as never }), { effort: 'high' });
    const rec = readRunRecord(reg, result.runId!);
    assert.deepEqual(rec?.effort, { requested: 'high', applied: true, mechanism: '--effort' });
    assert.equal(rec?.usage?.model?.requestedEffort, 'high');
  });

  it('no --effort: record and result carry no effort key', async () => {
    const { result, reg } = await driveArgv('claude', (spawnFn) => new ClaudeCodeAdapter({ spawnFn: spawnFn as never }), {});
    assert.equal(result.effort, undefined);
    assert.equal(readRunRecord(reg, result.runId!)?.effort, undefined);
  });

  it('kiro argv snapshot: no effort, --kiro-effort high, and generic --effort high', async () => {
    const plain = await driveArgv('kiro', (spawnFn) => new KiroAdapter({ spawnFn, mitm: false }), {});
    assert.deepEqual(plain.argv, ['chat', '--no-interactive', '--output-format', 'stream-json', '--agent-engine', 'v2', 'hi']);
    const legacy = await driveArgv('kiro', (spawnFn) => new KiroAdapter({ spawnFn, mitm: false }), { kiro: { effort: 'high' } });
    const generic = await driveArgv('kiro', (spawnFn) => new KiroAdapter({ spawnFn, mitm: false }), { effort: 'high' });
    const expected = ['chat', '--no-interactive', '--output-format', 'stream-json', '--agent-engine', 'v2', '--effort', 'high', 'hi'];
    assert.deepEqual(legacy.argv, expected);
    assert.deepEqual(generic.argv, expected);
    assert.equal(legacy.result.effort, undefined, '--kiro-effort alone adds no effort record');
  });

  it('kiro without --effort: applyEffort path leaves the spec object identical (no new keys)', () => {
    const spec = { prompt: 'p', kiro: { agent: 'a' } };
    const out = applyEffortToSpec(spec, { provenance: { requested: 'high', applied: false, mechanism: 'none' }, warnings: [] });
    assert.equal(out, spec);
    assert.deepEqual(buildKiroArgs(spec), ['chat', '--no-interactive', '--output-format', 'stream-json', '--agent-engine', 'v2', '--agent', 'a', 'p']);
  });
});

describe('criterion 4: MCP routes effort through the same table (#54)', () => {
  it('toRunSpec and toSpec (harness_run_async) pass the top-level effort; nested kiro effort still works', () => {
    assert.equal(toRunSpec({ agent: 'claude', prompt: 'p', effort: 'max' } as never, []).effort, 'max');
    assert.equal((toSpec({ agent: 'claude', prompt: 'p', effort: 'low' } as never, 'r1') as RunSpec).effort, 'low');
    assert.equal(toRunSpec({ agent: 'kiro', prompt: 'p', kiro: { effort: 'high' } } as never, []).kiro?.effort, 'high');
  });

  it('harness_run with effort records the same provenance as ach run', { timeout: 30_000 }, async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'effort-mcp-'));
    const shimDir = mkdtempSync(join(tmpdir(), 'effort-mcp-shim-'));
    const argvFile = join(shimDir, 'argv.txt');
    const sid = 'effort-mcp-session-0001';
    const ndjson = [
      `{"type":"system","subtype":"init","cwd":"${stateDir}","session_id":"${sid}","tools":[],"model":"claude-sonnet-4-5-20250929","permissionMode":"default","version":"2.0.14","output_style":"default"}`,
      `{"type":"result","subtype":"success","is_error":false,"duration_ms":12,"duration_api_ms":11,"num_turns":1,"result":"hi","session_id":"${sid}","total_cost_usd":0.001,"usage":{"input_tokens":9,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":4,"service_tier":"standard"},"permission_denials":[]}`,
    ].join('\n');
    const shim = join(shimDir, 'claude');
    writeFileSync(shim, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${argvFile}'\ncat <<'EOF_NDJSON'\n${ndjson}\nEOF_NDJSON\n`);
    chmodSync(shim, 0o755);
    const origPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${origPath}`;
    try {
      const server = createMcpServer({ name: 'test', version: '0' });
      registerRunTools(server, { stateDir });
      const res = await server.dispatch({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'harness_run', arguments: { agent: 'claude', prompt: 'say hi', effort: 'xhigh' } },
      });
      const run = JSON.parse((res!.result as { content: Array<{ text: string }> }).content[0]!.text) as { runId: string; effort?: unknown };
      assert.deepEqual(run.effort, { requested: 'xhigh', applied: true, mechanism: '--effort' });
      const rec = readRunRecord(stateDir, run.runId);
      assert.deepEqual(rec?.effort, { requested: 'xhigh', applied: true, mechanism: '--effort' });
      const argv = readFileSync(argvFile, 'utf8').split('\n');
      assert.ok(hasSeq(argv, ['--effort', 'xhigh']), argv.join(' '));
    } finally {
      process.env.PATH = origPath;
    }
  });

  it('harness_run and harness_run_async advertise effort in their input schemas', async () => {
    const server = createMcpServer({ name: 'test', version: '0' });
    registerRunTools(server, { stateDir: mkdtempSync(join(tmpdir(), 'effort-mcp-list-')) });
    const { registerJobTools } = await import('../src/mcp/tools-jobs.ts');
    registerJobTools(server, { stateDir: mkdtempSync(join(tmpdir(), 'effort-mcp-jobs-')) } as never);
    const res = await server.dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const tools = (res!.result as { tools: Array<{ name: string; inputSchema: { properties: Record<string, { enum?: string[] }> } }> }).tools;
    for (const name of ['harness_run', 'harness_run_async']) {
      const t = tools.find((x) => x.name === name);
      assert.deepEqual(t?.inputSchema.properties.effort?.enum, ['low', 'medium', 'high', 'xhigh', 'max'], name);
    }
  });
});

describe('CLI: ach run / ach trial --effort (#54)', () => {
  function ach(args: string[]): { code: number; stdout: string; stderr: string; state: string } {
    const state = mkdtempSync(join(tmpdir(), 'effort-cli-'));
    const p = spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], {
      cwd: ROOT,
      env: { ...process.env, AGENTIC_CODING_HARNESS_STATE_DIR: state },
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { code: p.status ?? -1, stdout: p.stdout ?? '', stderr: p.stderr ?? '', state };
  }

  it('ach run --agent null --effort high: completes, warns naming null, JSON carries effort', () => {
    const out = ach(['run', '--agent', 'null', '--effort', 'high', '--json', 'hi']);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stderr, /\[warn\] effort: null has no native effort control/);
    const res = JSON.parse(out.stdout) as { effort?: unknown };
    assert.deepEqual(res.effort, { requested: 'high', applied: false, mechanism: 'none' });
  });

  it('ach run --effort bogus: USAGE error naming the level set', () => {
    const out = ach(['run', '--agent', 'null', '--effort', 'bogus', 'hi']);
    assert.notEqual(out.code, 0);
    assert.match(out.stderr, /low\|medium\|high\|xhigh\|max/);
  });

  it('ach trial --matrix: a plan-level effort alone applies to every cell', () => {
    const dir = mkdtempSync(join(tmpdir(), 'effort-trial-plan-'));
    const plan = join(dir, 'plan.json');
    writeFileSync(plan, JSON.stringify({ experiment: 'effort-plan', agents: ['null'], tasks: [{ id: 'p1', prompt: 'hi' }], trials: 2, effort: 'medium' }));
    const out = ach(['trial', '--matrix', plan, '--ledger', join(dir, 'ledger.jsonl')]);
    assert.equal(out.code, 0, out.stderr);
    const recs = listRunRecords(out.state);
    assert.equal(recs.length, 2, out.stderr);
    for (const r of recs) assert.deepEqual(r.effort, { requested: 'medium', applied: false, mechanism: 'none' });
  });

  it('ach trial --suite --effort applies the level to every suite cell', () => {
    const dir = mkdtempSync(join(tmpdir(), 'effort-trial-suite-'));
    const task = join(dir, 'tasks', 'say-hi');
    mkdirSync(task, { recursive: true });
    writeFileSync(join(task, 'task.md'), 'say hi\n');
    writeFileSync(join(task, 'meta.json'), JSON.stringify({ suites: ['core'], workspace: 'fresh' }));
    const out = ach(['trial', '--suite', 'core', '--agent', 'null', '--tasks-dir', join(dir, 'tasks'), '--effort', 'xhigh', '--ledger', join(dir, 'ledger.jsonl')]);
    assert.equal(out.code, 0, out.stderr);
    const recs = listRunRecords(out.state);
    assert.equal(recs.length, 1, out.stderr);
    assert.deepEqual(recs[0]!.effort, { requested: 'xhigh', applied: false, mechanism: 'none' });
  });

  it('ach trial --effort bogus: USAGE error naming the level set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'effort-trial-bad-'));
    const plan = join(dir, 'plan.json');
    writeFileSync(plan, JSON.stringify({ experiment: 'x', agents: ['null'], tasks: [{ id: 'p1', prompt: 'hi' }] }));
    const out = ach(['trial', '--matrix', plan, '--effort', 'bogus']);
    assert.notEqual(out.code, 0);
    assert.match(out.stderr, /--effort must be one of low\|medium\|high\|xhigh\|max/);
    assert.equal(listRunRecords(out.state).length, 0);
  });

  it('ach trial --matrix --effort overrides the plan effort for every cell', () => {
    const dir = mkdtempSync(join(tmpdir(), 'effort-trial-'));
    mkdirSync(join(dir, 'out'));
    const plan = join(dir, 'plan.json');
    writeFileSync(plan, JSON.stringify({ experiment: 'effort-matrix', agents: ['null'], tasks: [{ id: 'p1', prompt: 'hi' }], effort: 'max' }));
    const out = ach(['trial', '--matrix', plan, '--effort', 'low', '--ledger', join(dir, 'out', 'ledger.jsonl')]);
    assert.equal(out.code, 0, out.stderr);
    const recs = listRunRecords(out.state);
    assert.equal(recs.length, 1, out.stderr);
    assert.deepEqual(recs[0]!.effort, { requested: 'low', applied: false, mechanism: 'none' });
  });
});
