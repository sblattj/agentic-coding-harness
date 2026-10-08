// GitHub Copilot CLI adapter (#23): AIU arithmetic, telemetry parsing, the
// missing-telemetry honesty path, argv/sandbox mapping, and end-to-end runs
// against a stub `copilot` binary (tests/fixtures/copilot/stub-copilot.mjs)
// that reproduces the stdout stream and exit-time files observed on 1.0.93.
// Live-authenticated behaviour is NOT covered here: no Copilot entitlement was
// available when this was written (see docs/transcript-adapters.md).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  COPILOT_CAPABILITIES,
  CopilotAdapter,
  classifyCopilotStderr,
  copilotArgs,
  copilotEventsPath,
  copilotSandboxArgs,
  copilotUnsupportedSandbox,
  copilotUsageEvents,
  createCopilotLineParser,
  inlineNanoAiu,
  nanoAiuToAiu,
  nanoAiuToUsd,
  parseCopilotShutdowns,
  parseCopilotUsageSummary,
  readCopilotTelemetry,
  subtractCopilotSummary,
  type CopilotTelemetry,
} from '../src/adapters/copilot.ts';
import { createDriver } from '../src/core/driver.ts';
import { createPricer } from '../src/core/pricing.ts';
import { listRunRecords } from '../src/core/registry.ts';
import { AGENTS, type RunResult } from '../src/core/types.ts';
import type { CanonicalEvent } from '../src/adapters/types.ts';
import { FakeChild, fakeSpawnFn, type FakeSpawnCall } from './helpers/fake-child.ts';

const FIX = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures/copilot');
const STUB = join(FIX, 'stub-copilot.mjs');
const fixture = (name: string): string => readFileSync(join(FIX, name), 'utf8');
const SESSION = '5b6f8f4e-0d6c-4c53-9f5c-3b0a7c7d9e11';

type Usage = Extract<CanonicalEvent, { type: 'usage' }>;
/** The producer sidecar the adapter attaches to a usage event's tokens. */
const ex = (u: Usage): Record<string, unknown> => (u.tokens as { extra?: Record<string, unknown> }).extra ?? {};
const usageOf = (events: CanonicalEvent[]): Usage[] => events.filter((e): e is Usage => e.type === 'usage');
const noticesOf = (events: CanonicalEvent[]): string[] =>
  events.flatMap((e) => {
    const p = e.type === 'step' ? (e as { payload?: { kind?: string; warning?: string } }).payload : undefined;
    return p?.kind === 'stderrNotice' && p.warning !== undefined ? [p.warning] : [];
  });

describe('AIU arithmetic (nano -> AIU -> USD), pinned', () => {
  it('1 AIU = 1e9 nano-AIU = $0.01', () => {
    assert.equal(nanoAiuToAiu(1_000_000_000), 1);
    assert.equal(nanoAiuToUsd(1_000_000_000), 0.01);
    assert.equal(nanoAiuToAiu(2_500_000_000), 2.5);
    assert.equal(nanoAiuToUsd(2_500_000_000), 0.025);
    assert.equal(nanoAiuToAiu(500_000_000), 0.5);
    assert.equal(nanoAiuToUsd(500_000_000), 0.005);
    assert.equal(nanoAiuToUsd(3_000_000_000), 0.03);
    // A figure whose AIU * 0.01 would round twice: nano / 1e11 is the nearest double.
    assert.equal(nanoAiuToAiu(1_234_567_890), 1.23456789);
    assert.equal(nanoAiuToUsd(1_234_567_890), 0.0123456789);
    assert.equal(nanoAiuToUsd(0), 0);
  });
});

describe('usage summary parsing (usage-output-file JSON / session.shutdown data)', () => {
  it('reads totalNanoAiu and per-model metrics from the observed shape', () => {
    const s = parseCopilotUsageSummary(JSON.parse(fixture('usage-aiu.json')));
    assert.ok(s);
    assert.equal(s.totalNanoAiu, 3_000_000_000);
    assert.deepEqual(s.models.map((m) => [m.model, m.inputTokens, m.outputTokens, m.cacheReadTokens, m.nanoAiu]), [
      ['gpt-5', 1000, 50, 600, 2_500_000_000],
      ['claude-haiku-4.5', 200, 10, 0, 500_000_000],
    ]);
  });

  it('accepts the snake_case spelling total_nano_aiu', () => {
    const s = parseCopilotUsageSummary({ total_nano_aiu: 2_500_000_000, modelMetrics: { m: { usage: { inputTokens: 5 }, total_nano_aiu: 2_500_000_000 } } });
    assert.equal(s?.totalNanoAiu, 2_500_000_000);
    assert.equal(s?.models[0]?.nanoAiu, 2_500_000_000);
  });

  it('is null for an object with neither AIU nor model metrics', () => {
    assert.equal(parseCopilotUsageSummary({ codeChanges: {} }), null);
    assert.equal(parseCopilotUsageSummary('nope'), null);
  });

  it('inline per-call AIU: both documented positions, snake_case', () => {
    const lines = fixture('stdout-inline-aiu.jsonl').trim().split('\n').map((l) => JSON.parse(l) as unknown);
    const nanos = lines.map(inlineNanoAiu).filter((n) => n !== null);
    assert.deepEqual(nanos, [1_500_000_000, 1_000_000_000]);
    assert.equal(inlineNanoAiu({ type: 'assistant.message', data: { total_nano_aiu: 5 } }), null);
  });

  it('shutdown scan keeps order and skips unparseable lines', () => {
    const shut = (n: number): string => JSON.stringify({ type: 'session.shutdown', data: { totalNanoAiu: n } });
    const got = parseCopilotShutdowns(`${shut(1)}\nnot json session.shutdown\n{"type":"user.message"}\n${shut(5)}\n`);
    assert.deepEqual(got.map((g) => g.totalNanoAiu), [1, 5]);
  });

  it('a resumed session is cumulative: this run is final minus baseline (per model, clamped)', () => {
    const final = parseCopilotUsageSummary(JSON.parse(fixture('usage-aiu.json')))!;
    const doubled = parseCopilotUsageSummary({
      totalNanoAiu: 6_000_000_000,
      modelMetrics: {
        'gpt-5': { requests: { count: 4 }, usage: { inputTokens: 2000, outputTokens: 100, cacheReadTokens: 1200, cacheWriteTokens: 0 }, totalNanoAiu: 5_000_000_000 },
        'claude-haiku-4.5': { requests: { count: 2 }, usage: { inputTokens: 400, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 }, totalNanoAiu: 1_000_000_000 },
      },
    })!;
    assert.deepEqual(subtractCopilotSummary(doubled, final), final);
    assert.equal(subtractCopilotSummary(final, null), final);
    const shrunk = subtractCopilotSummary(final, doubled);
    assert.equal(shrunk.totalNanoAiu, 0, 'a smaller final never goes negative');
  });
});

describe('copilotUsageEvents: cost only from AIU telemetry', () => {
  it('AIU present -> one usage record per model with exact USD, credits and uncached input', () => {
    const summary = parseCopilotUsageSummary(JSON.parse(fixture('usage-aiu.json')))!;
    const { events, warnings } = copilotUsageEvents(summary, 'usage-output-file');
    assert.deepEqual(warnings, []);
    const [gpt, haiku] = usageOf(events) as Array<Usage & { model?: string }>;
    assert.equal(gpt!.model, 'gpt-5');
    // inputTokens 1000 includes 600 cache reads: the house input is the uncached 400.
    assert.equal(gpt!.tokens.inputTokens, 400);
    assert.equal(gpt!.tokens.cacheReadTokens, 600);
    assert.equal(gpt!.tokens.outputTokens, 50);
    assert.equal(gpt!.cost, 0.025);
    assert.equal(ex(gpt!).credits, 2.5);
    assert.equal(ex(gpt!).nanoAiu, 2_500_000_000);
    assert.equal(ex(gpt!).vendorMetered, true);
    assert.equal(ex(gpt!).aiuSource, 'usage-output-file');
    assert.equal(haiku!.model, 'claude-haiku-4.5');
    assert.equal(haiku!.tokens.inputTokens, 200);
    assert.equal(haiku!.cost, 0.005);
    assert.equal(ex(haiku!).credits, 0.5);
    assert.equal(ex(haiku!).creditsCumulative, 3);
    const totalUsd = usageOf(events).reduce((a, u) => a + (u.cost ?? 0), 0);
    assert.ok(Math.abs(totalUsd - nanoAiuToUsd(3_000_000_000)) < 1e-12);
  });

  it('a single model with no per-model figure owns the total', () => {
    const { events } = copilotUsageEvents(
      { totalNanoAiu: 2_500_000_000, models: [{ model: 'm', inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 1, nanoAiu: null }] },
      'events.jsonl',
    );
    assert.equal(usageOf(events).length, 1);
    assert.equal(usageOf(events)[0]!.cost, 0.025);
  });

  it('AIU the model rows do not cover becomes a cost-only record (tokens flagged unavailable)', () => {
    const { events } = copilotUsageEvents(
      { totalNanoAiu: 3_000_000_000, models: [{ model: 'm', inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 1, nanoAiu: 2_000_000_000 }] },
      'events.jsonl',
    );
    const u = usageOf(events);
    assert.equal(u.length, 2);
    assert.equal(u[1]!.cost, 0.01);
    assert.equal(ex(u[1]!).tokensAvailable, false);
  });

  it('MISSING telemetry: tokens are kept, cost is absent, a warning says why (no token-math estimate)', () => {
    const summary = parseCopilotUsageSummary(JSON.parse(fixture('usage-no-aiu.json')))!;
    assert.equal(summary.totalNanoAiu, null);
    const { events, warnings } = copilotUsageEvents(summary, 'usage-output-file');
    const [u] = usageOf(events);
    assert.equal(usageOf(events).length, 1);
    assert.equal(u!.tokens.inputTokens, 400);
    assert.equal(u!.tokens.outputTokens, 50);
    assert.equal(u!.cost, undefined, 'no cost field at all');
    assert.equal(ex(u!).credits, undefined);
    assert.equal(ex(u!).vendorMetered, true, 'flagged so the pricer cannot token-price it');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /AIU telemetry \(totalNanoAiu\) missing; cost unavailable \(never estimated from tokens\)/);
  });

  it('a reported 0 nano-AIU (BYOK / unmetered) is unknown cost, never $0', () => {
    const { events, warnings } = copilotUsageEvents(
      { totalNanoAiu: 0, models: [{ model: 'm', inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 1, nanoAiu: 0 }] },
      'usage-output-file',
    );
    assert.equal(usageOf(events)[0]!.cost, undefined);
    assert.match(warnings[0]!, /reported 0 nano-AIU/);
  });

  it('no telemetry at all -> no usage events, one warning', () => {
    const { events, warnings } = copilotUsageEvents(null, null);
    assert.deepEqual(events, []);
    assert.match(warnings[0]!, /no usage telemetry found/);
  });
});

describe('stdout line parser', () => {
  const run = (telemetry: CopilotTelemetry, text = fixture('stdout-run.jsonl').replaceAll('__SID__', SESSION)): CanonicalEvent[] => {
    const parser = createCopilotLineParser(() => telemetry, { sessionId: SESSION });
    const events: CanonicalEvent[] = [];
    for (const line of text.trim().split('\n')) events.push(...parser.parseLine(line));
    events.push(...parser.finish());
    return events;
  };

  it('maps the observed 1.0.93 stream: session once, messages, tools, model-call boundaries', () => {
    const events = run({ summary: null, source: null });
    assert.equal(events.filter((e) => e.type === 'session').length, 1);
    assert.deepEqual(events.filter((e) => e.type === 'message').map((e) => (e as { text: string }).text), ['Listing', 'Two files.']);
    const tools = events.filter((e) => e.type === 'tool') as Array<Extract<CanonicalEvent, { type: 'tool' }>>;
    assert.deepEqual(tools.map((t) => [t.phase, t.toolName, t.toolCallId, t.status]), [
      ['start', 'bash', 'call_1', undefined],
      ['result', 'unknown_tool', 'call_1', 'success'],
    ]);
    assert.deepEqual(tools[0]!.input, { command: 'ls', description: 'list' });
    const calls = events.filter((e) => e.type === 'model_call') as Array<Extract<CanonicalEvent, { type: 'model_call' }>>;
    assert.deepEqual(calls.map((c) => [c.phase, c.callId, c.model]), [
      ['start', 'call-1', undefined],
      ['end', 'call-1', 'gpt-5'],
      ['start', 'call-2', undefined],
      ['end', 'call-2', 'gpt-5'],
    ]);
    const chunks = events.filter((e) => e.type === 'step' && (e as { payload?: { kind?: string } }).payload?.kind === 'chunk');
    assert.equal(chunks.length, 2, 'one first-output chunk per model call');
    assert.ok(events.some((e) => e.type === 'progress' && /Third-party MCP servers are disabled/.test((e as { text: string }).text)));
  });

  it('result.sessionId wins over the id we passed', () => {
    const events = run({ summary: null, source: null }, fixture('stdout-run.jsonl').replaceAll('__SID__', 'from-result'));
    assert.deepEqual(events.filter((e) => e.type === 'session').map((e) => (e as { sessionId: string }).sessionId), [SESSION, 'from-result']);
  });

  it('inline AIU fixture (total_nano_aiu) -> exact AIU and USD when no summary exists', () => {
    const parser = createCopilotLineParser((_sid, inline) => ({
      summary: inline === null ? null : { totalNanoAiu: inline, models: [] },
      source: inline === null ? null : 'stdout-inline',
    }));
    for (const line of fixture('stdout-inline-aiu.jsonl').trim().split('\n')) parser.parseLine(line);
    const events = parser.finish();
    const [u] = usageOf(events);
    assert.equal(usageOf(events).length, 1);
    assert.equal(u!.cost, 0.025);
    assert.equal(ex(u!).credits, 2.5);
    assert.equal(ex(u!).nanoAiu, 2_500_000_000);
    assert.equal(ex(u!).tokensAvailable, false);
    assert.match(noticesOf(events).join('\n'), /per-call stdout events only/);
  });

  it('a run that did no work and found no telemetry reports nothing (the auth error is the story)', () => {
    const parser = createCopilotLineParser(() => ({ summary: null, source: null }));
    assert.deepEqual(parser.finish(), []);
  });

  it('a run that worked but found no telemetry emits the warning as a stderrNotice step', () => {
    const events = run({ summary: null, source: null });
    assert.match(noticesOf(events).join('\n'), /no usage telemetry found/);
    assert.equal(usageOf(events).length, 0);
  });

  it('malformed stdout throws (the run loop surfaces it)', () => {
    const parser = createCopilotLineParser(() => ({ summary: null, source: null }));
    assert.throws(() => parser.parseLine('not json'));
  });
});

describe('readCopilotTelemetry', () => {
  const scratch = (): string => mkdtempSync(join(tmpdir(), 'copilot-test-'));
  const shutdownLine = (obj: unknown): string => `${JSON.stringify({ type: 'session.shutdown', data: obj })}\n`;
  const aiu = JSON.parse(fixture('usage-aiu.json')) as Record<string, unknown>;

  it('prefers the usage file, falls back to events.jsonl, then inline, then nothing', () => {
    const home = scratch();
    const env = { COPILOT_HOME: home };
    mkdirSync(join(home, 'session-state', SESSION), { recursive: true });
    writeFileSync(copilotEventsPath(SESSION, env), shutdownLine(aiu));
    const usageFile = join(home, 'u.json');
    writeFileSync(usageFile, JSON.stringify({ ...aiu, totalNanoAiu: 1_000_000_000, modelMetrics: {} }));
    let t = readCopilotTelemetry({ usageFile, sessionId: SESSION, inlineNanoAiu: 7, resumed: false, env });
    assert.equal(t.source, 'usage-output-file');
    assert.equal(t.summary?.totalNanoAiu, 1_000_000_000);
    t = readCopilotTelemetry({ usageFile: join(home, 'missing.json'), sessionId: SESSION, inlineNanoAiu: 7, resumed: false, env });
    assert.equal(t.source, 'events.jsonl');
    assert.equal(t.summary?.totalNanoAiu, 3_000_000_000);
    t = readCopilotTelemetry({ sessionId: 'no-such-session', inlineNanoAiu: 7, resumed: false, env });
    assert.deepEqual([t.source, t.summary?.totalNanoAiu], ['stdout-inline', 7]);
    t = readCopilotTelemetry({ sessionId: 'no-such-session', inlineNanoAiu: null, resumed: false, env });
    assert.deepEqual(t, { summary: null, source: null });
  });

  it('resume: subtracts the previous shutdown snapshot whether or not events.jsonl already holds this run', () => {
    const home = scratch();
    const env = { COPILOT_HOME: home };
    mkdirSync(join(home, 'session-state', SESSION), { recursive: true });
    const cum = { ...aiu, totalNanoAiu: 5_000_000_000, modelMetrics: {} };
    // events.jsonl has [previous=3 AIU, this run's cumulative=5 AIU]; the file has the same 5.
    writeFileSync(copilotEventsPath(SESSION, env), shutdownLine(aiu) + shutdownLine(cum));
    const usageFile = join(home, 'u.json');
    writeFileSync(usageFile, JSON.stringify(cum));
    assert.equal(readCopilotTelemetry({ usageFile, sessionId: SESSION, inlineNanoAiu: null, resumed: true, env }).summary?.totalNanoAiu, 2_000_000_000);
    // events.jsonl not yet flushed with this run: baseline is its last snapshot.
    writeFileSync(copilotEventsPath(SESSION, env), shutdownLine(aiu));
    assert.equal(readCopilotTelemetry({ usageFile, sessionId: SESSION, inlineNanoAiu: null, resumed: true, env }).summary?.totalNanoAiu, 2_000_000_000);
    // A fresh (non-resumed) session is never reduced.
    assert.equal(readCopilotTelemetry({ usageFile, sessionId: SESSION, inlineNanoAiu: null, resumed: false, env }).summary?.totalNanoAiu, 5_000_000_000);
  });
});

describe('argv, sandbox and stderr classification', () => {
  it('headless argv: prompt as --prompt=, JSON output, pinned session id, usage file', () => {
    assert.deepEqual(copilotArgs('-x fix it', { model: 'gpt-5', sessionId: SESSION, usageFile: '/t/u.json' }), [
      '--prompt=-x fix it',
      '--output-format',
      'json',
      '--no-auto-update',
      '--model',
      'gpt-5',
      `--session-id=${SESSION}`,
      '--usage-output-file',
      '/t/u.json',
      '--allow-all-tools',
    ]);
    // A resume uses --resume=, never also --session-id.
    const resumed = copilotArgs('go', { resume: 'abc', sessionId: SESSION });
    assert.ok(resumed.includes('--resume=abc'));
    assert.ok(!resumed.some((a) => a.startsWith('--session-id')));
  });

  it('allowedTools/disallowedTools restrict the tool list (--available-tools / --excluded-tools), not --allow-tool', () => {
    const args = copilotSandboxArgs({ allowedTools: ['view', 'grep'], disallowedTools: ['bash'], mcpConfig: { mcpServers: {} } });
    assert.deepEqual(args, ['--allow-all-tools', '--available-tools=view', '--available-tools=grep', '--excluded-tools=bash', '--additional-mcp-config={"mcpServers":{}}']);
    assert.ok(!args.some((a) => a.startsWith('--allow-tool')));
    assert.deepEqual(copilotSandboxArgs({ mcpConfig: '/p/mcp.json' }), ['--allow-all-tools', '--additional-mcp-config=@/p/mcp.json']);
  });

  it('permissionMode: plan/autopilot map to --mode; unknown modes warn', () => {
    assert.deepEqual(copilotSandboxArgs({ permissionMode: 'plan' }), ['--mode=plan']);
    assert.deepEqual(copilotSandboxArgs({ permissionMode: 'autopilot' }), ['--mode=autopilot', '--allow-all-tools']);
    assert.equal(copilotUnsupportedSandbox({ permissionMode: 'plan' }).length, 0);
    assert.match(copilotUnsupportedSandbox({ permissionMode: 'ask' })[0]!.message, /treated as 'dontAsk'/);
    assert.match(copilotUnsupportedSandbox({ permissionMode: 'acceptEdits' })[0]!.message, /no permission mode 'acceptEdits'/);
  });

  it('classifies the two authentication failures observed on 1.0.93', () => {
    assert.match(classifyCopilotStderr('Error: No authentication information found.')!, /not authenticated.*copilot login.*COPILOT_GITHUB_TOKEN.*gh auth login/);
    assert.match(classifyCopilotStderr('Error: Access denied by policy settings (Request ID: X)')!, /access denied by policy.*no Copilot access/);
    assert.equal(classifyCopilotStderr('some other line'), null);
  });

  it('is registered: AGENTS, capabilities', () => {
    assert.ok(AGENTS.includes('copilot'));
    assert.deepEqual(COPILOT_CAPABILITIES, { headless: true, streaming: true, resume: true, acp: false, tmuxFallback: false });
  });
});

describe('adapter over a fake child process', () => {
  it('spawns with the headless argv, passes the prompt through, and surfaces an auth failure as a specific error event', async () => {
    const child = new FakeChild();
    const calls: FakeSpawnCall[] = [];
    const adapter = new CopilotAdapter({ command: 'copilot-bin', spawnFn: fakeSpawnFn(child, calls) });
    const handle = adapter.spawn('do it', { model: 'gpt-5' });
    child.writeStderr('Error: No authentication information found.\n\nCopilot can be authenticated...\n');
    child.close(1);
    const events: CanonicalEvent[] = [];
    for await (const e of handle.events) events.push(e);
    assert.equal(await handle.wait(), 1);
    assert.equal(calls[0]!.command, 'copilot-bin');
    assert.equal(calls[0]!.args[0], '--prompt=do it');
    assert.ok(calls[0]!.args.some((a) => /^--session-id=[0-9a-f-]{36}$/.test(a)));
    assert.ok(calls[0]!.args.includes('--usage-output-file'));
    const errors = events.filter((e) => e.type === 'error').map((e) => (e as { message: string }).message);
    assert.ok(errors.some((m) => /not authenticated/.test(m)), errors.join(' | '));
    assert.equal(errors.filter((m) => /not authenticated/.test(m)).length, 1, 'classified once');
    assert.ok(!events.some((e) => e.type === 'usage' || e.type === 'step'), 'no telemetry noise for a run that never started');
  });

  it('COPILOT_CLI_BIN is the default binary', () => {
    const prev = process.env.COPILOT_CLI_BIN;
    process.env.COPILOT_CLI_BIN = '/opt/copilot-x';
    try {
      const child = new FakeChild();
      const calls: FakeSpawnCall[] = [];
      new CopilotAdapter({ spawnFn: fakeSpawnFn(child, calls) }).spawn('p');
      child.close(0);
      assert.equal(calls[0]!.command, '/opt/copilot-x');
    } finally {
      if (prev === undefined) delete process.env.COPILOT_CLI_BIN;
      else process.env.COPILOT_CLI_BIN = prev;
    }
  });
});

describe('pricer: vendor-metered records are never token-priced', () => {
  const base = { model: 'gpt-5', inputTokens: 400, outputTokens: 50, cacheReadTokens: 600, cacheWriteTokens: 0 };
  it('control: the same tokens on a plain record DO price by token math', () => {
    const p = createPricer();
    assert.ok(p.price(base) > 0 && Number.isFinite(p.price(base)));
  });
  it('vendorMetered without a stated cost is unpriced (NaN) even for a priced model', () => {
    const p = createPricer();
    assert.ok(Number.isNaN(p.price({ ...base, extra: { vendorMetered: true } })));
    assert.deepEqual(p.drainWarnings(), [], 'unpriced, not an unknown-model warning');
  });
  it('vendorMetered with a stated cost returns exactly that cost; computed-only math has no answer', () => {
    const p = createPricer();
    assert.equal(p.price({ ...base, costUsd: 0.025, extra: { vendorMetered: true } }), 0.025);
    assert.ok(Number.isNaN(p.price({ ...base, costUsd: 0.025, extra: { vendorMetered: true } }, { computedOnly: true })));
  });
});

// ---------------------------------------------------------------- end to end

function env(): { home: string; state: string; reg: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), 'copilot-e2e-'));
  const dirs = { home: join(root, 'copilot-home'), state: join(root, 'state'), reg: join(root, 'registry'), cwd: join(root, 'cwd') };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  return dirs;
}

async function driveStub(
  mode: string,
  dirs: ReturnType<typeof env>,
  spec: { resume?: string; model?: string } = {},
): Promise<{ result: RunResult; argv: string[] }> {
  const argvFile = join(dirs.state, `argv-${Math.random().toString(36).slice(2)}.json`);
  const adapter = new CopilotAdapter({ command: STUB, env: { COPILOT_HOME: dirs.home, STUB_COPILOT_MODE: mode, STUB_COPILOT_ARGV: argvFile } });
  const driver = createDriver({
    adapters: { copilot: { name: 'copilot', launch: (s) => adapter.launch(s), validateProfile: (s) => adapter.validateProfile(s) } },
    stateDir: dirs.state,
    registry: { stateDir: dirs.reg },
  });
  const result = await driver.run('copilot', { prompt: 'list the files', cwd: dirs.cwd, ...spec });
  return { result, argv: JSON.parse(readFileSync(argvFile, 'utf8')) as string[] };
}

describe('end to end through the driver with a stub copilot binary', () => {
  it('AIU present: cost is AIU/100 dollars, credits are the AIU, provenance is reported, never token math', async () => {
    const dirs = env();
    const { result, argv } = await driveStub('ok', dirs, { model: 'gpt-5' });
    assert.equal(result.exitStatus, 'success');
    assert.ok(argv.includes('--prompt=list the files'));
    assert.match(argv.find((a) => a.startsWith('--session-id='))!, /^--session-id=[0-9a-f-]{36}$/);
    assert.equal(result.sessionId, argv.find((a) => a.startsWith('--session-id='))!.slice('--session-id='.length));
    assert.ok(Math.abs(result.totalCost - 0.03) < 1e-12, `totalCost ${result.totalCost}`);
    assert.deepEqual(result.usage!.usd, { available: true, source: 'vendor', value: result.totalCost });
    assert.equal(result.usage!.credits.available, true);
    assert.equal(result.usage!.credits.value, 3);
    assert.equal(result.usage!.credits.source, 'native');
    assert.equal(result.usage!.cost?.costAvailability, 'reported');
    assert.ok(Math.abs((result.usage!.cost?.reportedCostUsd ?? 0) - 0.03) < 1e-12);
    assert.deepEqual(result.tokens.map((t) => [t.model, t.inputTokens, t.cacheReadTokens, t.outputTokens]), [
      ['gpt-5', 400, 600, 50],
      ['claude-haiku-4.5', 200, 0, 10],
    ]);
    // Control: token math on the same gpt-5 tokens would have said $0.001075, not $0.025.
    assert.equal(result.tokens[0]!.costUsd, 0.025);
    assert.ok(!result.warnings.some((w) => /unknown model/.test(w)), result.warnings.join(' | '));
    const [rec] = listRunRecords(dirs.reg);
    assert.equal(rec!.totals!.costSource, 'reported');
    assert.equal(rec!.totals!.provenance!.costUsd, 'reported');
    assert.equal(rec!.totals!.credits, 3);
    assert.equal(rec!.usage!.usd.available, true);
  });

  it('AIU missing: tokens recorded, cost unavailable (null), a warning event, and NO token-math cost', async () => {
    const dirs = env();
    const { result } = await driveStub('no-aiu', dirs);
    assert.equal(result.exitStatus, 'success');
    assert.equal(result.usage!.tokens.available, true);
    assert.deepEqual(result.tokens.map((t) => [t.model, t.inputTokens, t.cacheReadTokens, t.outputTokens]), [['gpt-5', 400, 600, 50]]);
    assert.equal(result.usage!.usd.available, false);
    assert.equal(result.totalCost, 0);
    assert.deepEqual(result.usage!.cost, { costAvailability: 'unavailable', reportedCostUsd: null, tokens: { inputTokens: 400, outputTokens: 50, cacheReadTokens: 600, cacheWriteTokens: 0 } });
    assert.equal(result.usage!.credits.available, false);
    assert.ok(result.warnings.some((w) => /AIU telemetry \(totalNanoAiu\) missing; cost unavailable \(never estimated from tokens\)/.test(w)), result.warnings.join(' | '));
    assert.ok(result.events.some((e) => e.type === 'step' && /AIU telemetry/.test(JSON.stringify(e.data ?? ''))), 'the warning is also an event on the stream');
    const [rec] = listRunRecords(dirs.reg);
    assert.equal(rec!.usage!.usd.available, false);
    assert.equal(rec!.totals!.provenance!.costUsd, undefined, 'n/a, never labelled');
  });

  it('no telemetry files at all: no tokens, no cost, one warning', async () => {
    const dirs = env();
    const { result } = await driveStub('no-telemetry', dirs);
    assert.equal(result.usage!.tokens.available, false);
    assert.equal(result.usage!.usd.available, false);
    assert.ok(result.warnings.some((w) => /no usage telemetry found/.test(w)));
  });

  it('only inline per-call AIU on stdout: cost is reported but flagged partial, tokens unavailable', async () => {
    const dirs = env();
    const { result } = await driveStub('inline', dirs);
    assert.equal(result.usage!.tokens.available, false);
    assert.deepEqual(result.usage!.usd, { available: true, source: 'vendor', value: 0.025 });
    assert.equal(result.usage!.credits.value, 2.5);
    assert.ok(result.warnings.some((w) => /per-call stdout events only/.test(w)));
  });

  it('resume: the second run is billed its own share of the cumulative session, not the whole session', async () => {
    const dirs = env();
    const first = await driveStub('ok', dirs);
    assert.ok(Math.abs(first.result.totalCost - 0.03) < 1e-12);
    const second = await driveStub('ok', dirs, { resume: first.result.sessionId });
    assert.ok(second.argv.includes(`--resume=${first.result.sessionId}`));
    assert.ok(!second.argv.some((a) => a.startsWith('--session-id')));
    // The stub's session now reports 6 AIU / 2000 input tokens cumulatively.
    const cumulative = parseCopilotShutdowns(readFileSync(copilotEventsPath(first.result.sessionId, { COPILOT_HOME: dirs.home }), 'utf8'));
    assert.deepEqual(cumulative.map((c) => c.totalNanoAiu), [3_000_000_000, 6_000_000_000]);
    assert.ok(Math.abs(second.result.totalCost - 0.03) < 1e-12, `second run cost ${second.result.totalCost} (cumulative would be 0.06)`);
    assert.equal(second.result.usage!.credits.value, 3);
    assert.deepEqual(second.result.tokens.map((t) => [t.model, t.inputTokens, t.cacheReadTokens, t.outputTokens]), [
      ['gpt-5', 400, 600, 50],
      ['claude-haiku-4.5', 200, 0, 10],
    ]);
  });

  it('authentication failure: a specific error, run classified unavailable, no telemetry warning', async () => {
    const dirs = env();
    const { result } = await driveStub('auth', dirs);
    assert.equal(result.exitStatus, 'unavailable');
    const errors = result.events.filter((e) => e.type === 'error').map((e) => String(e.message ?? e.content ?? ''));
    assert.ok(errors.some((m) => /copilot: not authenticated\. Run `copilot login`/.test(m)), errors.join(' | '));
    assert.ok(!result.warnings.some((w) => /telemetry/.test(w)), result.warnings.join(' | '));
  });

  it('policy denial: a specific error, run classified unavailable', async () => {
    const dirs = env();
    const { result } = await driveStub('policy', dirs);
    assert.equal(result.exitStatus, 'unavailable');
    const errors = result.events.filter((e) => e.type === 'error').map((e) => String(e.message ?? e.content ?? ''));
    assert.ok(errors.some((m) => /access denied by policy/.test(m)), errors.join(' | '));
  });
});

describe('registration', () => {
  it('defaultAdapters() registers copilot and the MCP run schema accepts it', async () => {
    const { defaultAdapters } = await import('../src/core/driver.ts');
    const { RunArgsSchema } = await import('../src/mcp/tools-run.ts');
    const adapters = await defaultAdapters();
    assert.equal(adapters.copilot?.name, 'copilot');
    assert.ok(RunArgsSchema.safeParse({ agent: 'copilot', prompt: 'hi' }).success);
  });
});

describe('ach run / ach stats through the real CLI entrypoint', () => {
  const cli = fileURLToPath(new URL('../src/cli/ach.ts', import.meta.url));
  const invoke = (e: Record<string, string>, args: string[], cwd: string) => {
    const bun = Boolean((process.versions as { bun?: string }).bun);
    return spawnSync(process.execPath, bun ? [cli, ...args] : ['--import', import.meta.resolve('tsx'), cli, ...args], {
      encoding: 'utf8',
      timeout: 60000,
      cwd,
      env: { ...process.env, AGENTIC_CODING_HARNESS_TZ: 'UTC', AGENTIC_CODING_HARNESS_COST_MODE: 'auto', ...e },
    });
  };

  it('`ach run --agent copilot` records a run; `ach stats` shows the copilot row in the same format as another agent (control: null)', () => {
    const dirs = env();
    const e = { HOME: dirs.home, AGENTIC_CODING_HARNESS_STATE_DIR: dirs.state, COPILOT_CLI_BIN: STUB, COPILOT_HOME: dirs.home };
    const run = invoke(e, ['run', '--agent', 'copilot', '--model', 'gpt-5', 'list the files'], dirs.cwd);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^cost\s+\$0\.0300$/m);
    assert.match(run.stdout, /^AI credits \(copilot\) 3\.00$/m);
    assert.match(run.stdout, /^exit\s+success$/m);
    const ctl = invoke(e, ['run', '--agent', 'null', 'hi'], dirs.cwd);
    assert.equal(ctl.status, 0, ctl.stderr);
    const stats = invoke(e, ['stats', '--state-only'], dirs.cwd);
    assert.equal(stats.status, 0, stats.stderr);
    const row = (name: string): string => stats.stdout.split('\n').find((l) => l.startsWith(`${name} `))!;
    const shape = (l: string): string => l.replace(/\d+(\.\d+)?/g, 'N').replace(/^\S+\s+/, 'AGENT ');
    assert.ok(row('copilot'), stats.stdout);
    assert.equal(shape(row('copilot')), shape(row('null')), `${row('copilot')} vs ${row('null')}`);
    assert.match(row('copilot'), /cost=\$0\.0300 /, 'AIU-derived dollars, unmarked (reported)');
    assert.ok(!/\*/.test(row('copilot')), 'no computed-by-ach marker');
    const json = JSON.parse(invoke(e, ['stats', '--state-only', '--json'], dirs.cwd).stdout) as { byAgent: Record<string, { costUsd?: number; cost?: number }> };
    const agg = json.byAgent.copilot!;
    assert.ok(Math.abs((agg.costUsd ?? agg.cost ?? NaN) - 0.03) < 1e-12, JSON.stringify(agg));
  });

  it('`ach run --help` and the usage text list copilot with its auth prerequisite', () => {
    const help = invoke({ HOME: tmpdir() }, ['--help'], tmpdir());
    const text = help.stdout + help.stderr;
    assert.match(text, /--agent <[^>]*copilot[^>]*>/);
    assert.match(text, /copilot login/);
    assert.match(text, /COPILOT_GITHUB_TOKEN/);
  });
});
