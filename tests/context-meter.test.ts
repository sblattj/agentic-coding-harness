// Context-window pressure meter for every non-kiro agent (issue #21).
//
// claude/codex are driven END TO END through their real parsers and the
// shared driver bridge with a replayed child (same seam as
// tests/normalized-usage.test.ts). Expected numbers are derived from the
// fixture lines and the bundled LiteLLM window table (max_input_tokens in
// src/core/pricing-data.json), not from the implementation.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { SpawnOptions } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';
import { createDriver } from '../src/core/driver.ts';
import { ClaudeCodeAdapter } from '../src/adapters/claude.ts';
import { CodexAdapter } from '../src/adapters/codex.ts';
import {
  CONTEXT_WARN_FRACTION,
  createContextMeter,
  lookupContextWindow,
} from '../src/core/context-meter.ts';
import { runContextRows } from '../src/cli/context-stats.ts';
import { frame } from '../src/cli/dash.ts';
import { listRunRecords, type RunRecord } from '../src/core/registry.ts';
import { UsageAvailabilitySchema, type AgentAdapter, type AgentEvent, type CanonicalTokenRecord, type RunResult } from '../src/core/types.ts';

// ---------------------------------------------------------------------------
// Harness plumbing
// ---------------------------------------------------------------------------

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = null;
  readonly pid = 424242;
  killed = false;
  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit('close', 143, null));
    return true;
  }
}

function replaySpawn(lines: string) {
  return (command: string, args: readonly string[], options: SpawnOptions): FakeChild => {
    void command;
    void args;
    void options;
    const child = new FakeChild();
    queueMicrotask(() => {
      child.stdout.write(lines);
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 0, null);
    });
    return child;
  };
}

const dirs: string[] = [];
function tmp(prefix = 'harness-ctx-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function runWith(
  adapter: AgentAdapter,
  spec: Record<string, unknown> = {},
  registryDir?: string,
): Promise<RunResult> {
  const driver = createDriver({
    adapters: { [adapter.name]: adapter },
    stateDir: registryDir ?? tmp(),
    ...(registryDir !== undefined ? { registry: { stateDir: registryDir } } : {}),
  });
  return driver.run(adapter.name, { prompt: 'context meter fixture', ...spec });
}

const ndjson = (line: unknown): string => `${JSON.stringify(line)}\n`;

const CLAUDE_FIXTURE = readFileSync(
  new URL('../src/adapters/fixtures/claude-ndjson-sample.ndjson', import.meta.url),
  'utf8',
);
const CODEX_FIXTURE = readFileSync(new URL('./fixtures/codex-session.ndjson', import.meta.url), 'utf8');

const rec = (model: string, input: number, cacheRead = 0, cacheWrite = 0): CanonicalTokenRecord => ({
  agent: 'x',
  model,
  inputTokens: input,
  outputTokens: 1,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: cacheWrite,
});
const msg = (usage: CanonicalTokenRecord): AgentEvent =>
  ({ type: 'message', source: 'agent', content: 'hi', usage, timestamp: 1 }) as AgentEvent;
const usageEv = (usage: CanonicalTokenRecord): AgentEvent => ({ type: 'usage', usage, timestamp: 1 }) as AgentEvent;
const toolResult = (content: string): AgentEvent =>
  ({ type: 'tool_result', toolCallId: 't', content, timestamp: 1 }) as AgentEvent;

// ---------------------------------------------------------------------------
// Window table (bundled LiteLLM extract, never a guess)
// ---------------------------------------------------------------------------

describe('context window table', () => {
  it('reads max_input_tokens from the bundled LiteLLM extract, alias-resolved', () => {
    assert.equal(lookupContextWindow('claude-sonnet-4-5-20250929'), 200_000);
    assert.equal(lookupContextWindow('anthropic/claude-sonnet-4-5'), 200_000);
    assert.equal(lookupContextWindow('gpt-5-codex'), 272_000);
    assert.equal(lookupContextWindow('openai/gpt-5'), 272_000);
    assert.equal(lookupContextWindow('gemini-2.5-pro'), 1_048_576);
  });

  it('honors an explicit [1m] window tag on the model id', () => {
    assert.equal(lookupContextWindow('claude-sonnet-4-5[1m]'), 1_000_000);
  });

  it('returns undefined for an unknown model (never a guessed window)', () => {
    assert.equal(lookupContextWindow('no-such-model-9000'), undefined);
    assert.equal(lookupContextWindow('unknown'), undefined);
    assert.equal(lookupContextWindow(''), undefined);
  });
});

// ---------------------------------------------------------------------------
// Meter unit behavior
// ---------------------------------------------------------------------------

describe('context meter', () => {
  it('is not created for kiro (its session store owns the meter) or unknown agents', () => {
    assert.equal(createContextMeter({ agent: 'kiro' }), null);
    assert.equal(createContextMeter({ agent: 'mock' }), null);
    for (const a of ['claude', 'codex', 'gemini', 'opencode']) assert.ok(createContextMeter({ agent: a }), a);
  });

  it('claude: per-call message usage wins over the run-aggregate result record', () => {
    const m = createContextMeter({ agent: 'claude' })!;
    m.observe(msg(rec('claude-sonnet-4-5', 10, 40_000, 9_990)));
    m.observe(usageEv(rec('claude-sonnet-4-5', 999, 999_999, 999))); // result aggregate
    const ctx = m.snapshot()!;
    assert.equal(ctx.available, true);
    assert.equal(ctx.tokens, 50_000);
    assert.equal(ctx.windowTokens, 200_000);
    assert.equal(ctx.percentage, 25);
    assert.equal(ctx.windowSource, 'assumed');
    assert.equal(ctx.basis, 'last-call');
    assert.equal(ctx.estimated, true);
  });

  it('opencode: per-step usage is a last-call basis', () => {
    const m = createContextMeter({ agent: 'opencode', requestedModel: 'anthropic/claude-sonnet-4-5' })!;
    m.observe(usageEv(rec('unknown', 1_000)));
    m.observe(usageEv(rec('unknown', 2_000, 18_000)));
    const ctx = m.snapshot()!;
    assert.equal(ctx.tokens, 20_000);
    assert.equal(ctx.percentage, 10);
    assert.equal(ctx.basis, 'last-call');
    assert.equal(ctx.model, 'anthropic/claude-sonnet-4-5');
  });

  it('unknown model: available false, no percentage, model echoed', () => {
    const m = createContextMeter({ agent: 'codex' })!;
    m.observe(usageEv(rec('unknown', 1_000)));
    const ctx = m.snapshot()!;
    assert.equal(ctx.available, false);
    assert.equal(ctx.percentage, undefined);
    assert.equal(ctx.windowTokens, undefined);
    assert.ok(UsageAvailabilitySchema.shape.context.safeParse(ctx).success);
  });

  it('no usage observed: snapshot is undefined (caller keeps its own verdict)', () => {
    const m = createContextMeter({ agent: 'claude', requestedModel: 'claude-sonnet-4-5' })!;
    m.observe(toolResult('x'));
    assert.equal(m.snapshot(), undefined);
  });

  it('warns exactly once on the 85% crossing (edge-triggered, never re-arms in a run)', () => {
    assert.equal(CONTEXT_WARN_FRACTION, 0.85);
    const m = createContextMeter({ agent: 'claude' })!;
    const warnings: string[] = [];
    const series = [50, 84.9, 86, 90, 70, 95, 99]; // percent of a 200k window
    for (const pct of series) {
      const w = m.observe(msg(rec('claude-sonnet-4-5', (pct / 100) * 200_000)));
      if (w !== undefined) warnings.push(w);
    }
    assert.equal(warnings.length, 1, warnings.join('\n'));
    assert.match(warnings[0]!, /^context: /);
    assert.match(warnings[0]!, /85%/);
    assert.match(warnings[0]!, /86\.0%/);
  });

  it('never warns off an upper-bound (turn-total) basis', () => {
    const m = createContextMeter({ agent: 'codex', requestedModel: 'gpt-5-codex' })!;
    assert.equal(m.observe(usageEv(rec('unknown', 270_000))), undefined);
    assert.equal(m.snapshot()!.basis, 'turn-total');
  });

  it('tool-output share: estimated from tool result size when tool events exist', () => {
    const m = createContextMeter({ agent: 'claude' })!;
    m.observe(toolResult('a'.repeat(4_000))); // ~1000 tok at 4 chars/token
    m.observe({ type: 'tool', toolName: 'Read', phase: 'result', output: 'b'.repeat(4_000), timestamp: 1 } as AgentEvent);
    m.observe(msg(rec('claude-sonnet-4-5', 20_000)));
    const ctx = m.snapshot()!;
    assert.equal(ctx.toolOutputTokens, 2_000);
    assert.equal(ctx.toolOutputShare, 0.1);
  });

  it('tool-output share is OMITTED (not zero) when no tool events exist', () => {
    const m = createContextMeter({ agent: 'claude' })!;
    m.observe(msg(rec('claude-sonnet-4-5', 20_000)));
    const ctx = m.snapshot()!;
    assert.equal('toolOutputShare' in ctx, false);
    assert.equal('toolOutputTokens' in ctx, false);
  });
});

// ---------------------------------------------------------------------------
// End to end through the real adapters + driver
// ---------------------------------------------------------------------------

describe('driver: usage.context for claude and codex fixtures', () => {
  it('claude fixture: last assistant call ÷ documented window, windowSource assumed', async () => {
    const result = await runWith(new ClaudeCodeAdapter({ stateDir: tmp(), spawnFn: replaySpawn(CLAUDE_FIXTURE) }));
    assert.equal(result.exitStatus, 'success');
    // Fixture assistant usage: input 4 + cache_read 84 + cache_creation 14629.
    const tokens = 4 + 84 + 14_629;
    assert.deepEqual(result.usage?.context, {
      available: true,
      source: 'derived',
      percentage: (tokens / 200_000) * 100,
      windowTokens: 200_000,
      windowSource: 'assumed',
      tokens,
      model: 'claude-sonnet-4-5-20250929',
      basis: 'last-call',
      estimated: true,
    });
    assert.ok(UsageAvailabilitySchema.safeParse(result.usage).success);
  });

  it('codex fixture: turn usage ÷ documented window for the requested model', async () => {
    const result = await runWith(new CodexAdapter({ spawnFn: replaySpawn(CODEX_FIXTURE) }), { model: 'gpt-5-codex' });
    assert.equal(result.exitStatus, 'success');
    // turn.completed: input_tokens 1200 (includes the 800 cached) -> 1200 in the prompt.
    const ctx = result.usage?.context;
    assert.equal(ctx?.available, true);
    assert.equal(ctx?.tokens, 1_200);
    assert.equal(ctx?.windowTokens, 272_000);
    assert.equal(ctx?.percentage, (1_200 / 272_000) * 100);
    assert.equal(ctx?.windowSource, 'assumed');
    assert.equal(ctx?.basis, 'turn-total');
    assert.equal(ctx?.estimated, true);
    // Tool events exist in the fixture (command_execution) -> share present.
    assert.equal(typeof ctx?.toolOutputShare, 'number');
  });

  it('codex with no model anywhere: context unavailable (n/a), never a guessed window', async () => {
    const result = await runWith(new CodexAdapter({ spawnFn: replaySpawn(CODEX_FIXTURE) }));
    assert.equal(result.usage?.context?.available, false);
    assert.equal(result.usage?.context?.percentage, undefined);
  });

  it('claude mocked stream: the 85% warning fires once across the crossing', async () => {
    const assistant = (input: number) =>
      ndjson({
        type: 'assistant',
        message: {
          model: 'claude-sonnet-4-5-20250929',
          content: [{ type: 'text', text: 'working' }],
          usage: { input_tokens: 10, cache_read_input_tokens: input, cache_creation_input_tokens: 0, output_tokens: 5 },
        },
      });
    const lines =
      ndjson({ type: 'system', subtype: 'init', session_id: 's-ctx', model: 'claude-sonnet-4-5-20250929' }) +
      assistant(100_000) +
      assistant(175_000) + // 87.5% -> crossing
      assistant(180_000) +
      assistant(190_000) +
      ndjson({ type: 'result', subtype: 'success', session_id: 's-ctx', usage: { input_tokens: 40, cache_read_input_tokens: 645_000, cache_creation_input_tokens: 0, output_tokens: 20 } });
    const registry = tmp();
    const result = await runWith(new ClaudeCodeAdapter({ stateDir: tmp(), spawnFn: replaySpawn(lines) }), {}, registry);
    const alerts = result.events.filter((e) => e.type === 'budget.alert' && e.metric === 'context');
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.threshold, 0.85);
    assert.equal(alerts[0]!.value, 87.505);
    const records = listRunRecords(registry);
    assert.equal(records[0]!.alerts?.[0]?.metric, 'context');
    assert.match(frame(records, registry, false, 200, false), /ALERT .*context 85%/);
    const state = JSON.parse(readFileSync(join(registry, 'alerts.json'), 'utf8'));
    assert.ok(state.fired[`run:${result.runId}:context|0.85`]);
    // The same stream with an unknown model or only an aggregate bill must stay quiet.
    for (const control of [lines.replaceAll('claude-sonnet-4-5-20250929', 'unknown-test-model'), lines.trim().split('\n').slice(-1).join('\n') + '\n']) {
      const quiet = await runWith(new ClaudeCodeAdapter({ stateDir: tmp(), spawnFn: replaySpawn(control) }));
      assert.equal(quiet.events.filter((e) => e.type === 'budget.alert' && e.metric === 'context').length, 0);
    }
    assert.equal(result.usage?.context?.tokens, 190_010);
  });

  it('registry record carries usage.context and totals.contextTokens; dash renders the ctx cell', async () => {
    const registry = tmp('harness-ctx-reg-');
    await runWith(new ClaudeCodeAdapter({ stateDir: tmp(), spawnFn: replaySpawn(CLAUDE_FIXTURE) }), {}, registry);
    const [r] = listRunRecords(registry);
    assert.ok(r);
    assert.equal(r.totals?.contextTokens, 14_717);
    const lines = frame([r], registry, true, 200, false).split('\n');
    const row = lines.find((l) => l.includes(r.runId.slice(0, 8)));
    assert.ok(row, lines.join('\n'));
    assert.ok(row.includes('14.7k (7.4%)'), row);
  });
});

// ---------------------------------------------------------------------------
// dash ctx cell: n/a for an unknown model, blank for pre-#21 records
// ---------------------------------------------------------------------------

function runRec(over: Record<string, unknown>): RunRecord {
  return {
    runId: 'run-x',
    agent: 'claude',
    startedAt: Date.now() - 5_000,
    updatedAt: Date.now(),
    status: 'success',
    totals: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 },
    ...over,
  } as RunRecord;
}
function rowOf(r: RunRecord): string {
  const lines = frame([r], '/tmp/state', true, 200, false).split('\n');
  const row = lines.find((l) => l.includes(r.runId.slice(0, 8)));
  assert.ok(row, lines.join('\n'));
  return row;
}
const BASE_USAGE = { tokens: { available: true }, credits: { available: false }, usd: { available: true, source: 'pricer', value: 0.01 } };

describe('dash ctx column (#21)', () => {
  it('unknown model renders n/a in the ctx column', () => {
    const row = rowOf(runRec({ runId: 'ctx-unknown', usage: { ...BASE_USAGE, context: { available: false, source: 'derived', model: 'mystery' } } }));
    assert.equal((row.match(/n\/a/g) ?? []).length, 1, row);
  });

  it('an upper-bound (turn-total) estimate is marked ≤', () => {
    const row = rowOf(
      runRec({
        runId: 'ctx-upper',
        agent: 'codex',
        usage: {
          ...BASE_USAGE,
          context: { available: true, source: 'derived', percentage: 10, windowTokens: 272_000, windowSource: 'assumed', tokens: 27_200, basis: 'turn-total', estimated: true },
        },
      }),
    );
    assert.ok(row.includes('≤27.2k (10.0%)'), row);
  });

  it('a record without usage.context stays blank (pre-#21 records unchanged)', () => {
    const row = rowOf(runRec({ runId: 'ctx-legacy' }));
    assert.ok(!row.includes('n/a'), row);
  });
});

// ---------------------------------------------------------------------------
// stats JSON: per-run context percentage
// ---------------------------------------------------------------------------

describe('stats JSON per-run context (#21)', () => {
  const withCtx = runRec({
    runId: 'r-ctx',
    usage: {
      ...BASE_USAGE,
      context: { available: true, source: 'derived', percentage: 7.3585, windowTokens: 200_000, windowSource: 'assumed', tokens: 14_717, model: 'claude-sonnet-4-5', basis: 'last-call', estimated: true, toolOutputShare: 0.25, toolOutputTokens: 3_679 },
    },
  });
  const unknown = runRec({ runId: 'r-unknown', agent: 'codex', usage: { ...BASE_USAGE, context: { available: false, source: 'derived' } } });
  const legacy = runRec({ runId: 'r-legacy', agent: 'gemini' });

  it('maps each run to a row; unknowable values are null, never 0', () => {
    const rows = runContextRows([withCtx, unknown, legacy]);
    assert.deepEqual(rows.find((r) => r.runId === 'r-ctx'), {
      runId: 'r-ctx',
      agent: 'claude',
      startedAt: withCtx.startedAt,
      status: 'success',
      model: 'claude-sonnet-4-5',
      contextPercentage: 7.3585,
      contextTokens: 14_717,
      windowTokens: 200_000,
      windowSource: 'assumed',
      basis: 'last-call',
      estimated: true,
      toolOutputShare: 0.25,
    });
    const u = rows.find((r) => r.runId === 'r-unknown')!;
    assert.equal(u.contextPercentage, null);
    assert.equal(u.windowTokens, null);
    assert.equal('toolOutputShare' in u, false);
    assert.equal(rows.find((r) => r.runId === 'r-legacy')!.contextPercentage, null);
  });

  it('filters by agent and since', () => {
    assert.deepEqual(runContextRows([withCtx, unknown], { agent: 'codex' }).map((r) => r.runId), ['r-unknown']);
    assert.deepEqual(runContextRows([withCtx], { sinceTs: Date.now() + 60_000 }), []);
  });

  it('`ach stats --json` exposes runs[] with contextPercentage', () => {
    const state = tmp('harness-ctx-stats-');
    const home = tmp('harness-ctx-home-');
    mkdirSync(join(state, 'runs'), { recursive: true });
    writeFileSync(join(state, 'runs', 'r-ctx.json'), JSON.stringify(withCtx));
    const cli = new URL('../src/cli/ach.ts', import.meta.url).pathname;
    const isBun = (process.versions as { bun?: string }).bun !== undefined;
    const p = spawnSync(process.execPath, isBun ? [cli, 'stats', '--json', '--state-only'] : ['--import', 'tsx', cli, 'stats', '--json', '--state-only'], {
      env: { ...process.env, AGENTIC_CODING_HARNESS_STATE_DIR: state, HOME: home },
      encoding: 'utf8',
    });
    assert.equal(p.status, 0, p.stderr);
    const out = JSON.parse(p.stdout) as { runs: Array<{ runId: string; contextPercentage: number | null }> };
    assert.deepEqual(out.runs.map((r) => [r.runId, r.contextPercentage]), [['r-ctx', 7.3585]]);
  });
});
