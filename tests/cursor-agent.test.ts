// Cursor CLI agent adapter (#24): usage parser fixtures (reported vs computed
// provenance), argv/sandbox mapping, the unauthenticated preflight, the
// cursor name shared with the read-only IDE monitor, and end-to-end runs
// against a stub `cursor-agent` (tests/fixtures/cursor-agent/stub-cursor-agent.mjs).
// All fixtures are synthetic: no authenticated Cursor CLI was available, so the
// stream-json shapes follow the public docs (see src/adapters/cursor.ts).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  CURSOR_CAPABILITIES,
  CursorAdapter,
  classifyCursorStderr,
  createCursorLineParser,
  cursorArgs,
  cursorModelSlug,
  cursorPreflight,
  cursorSandboxArgs,
  cursorUnsupportedSandbox,
  cursorUsageEvents,
  parseCursorResultUsage,
} from '../src/adapters/cursor.ts';
import { createDriver } from '../src/core/driver.ts';
import { createPricer } from '../src/core/pricing.ts';
import { listRunRecords } from '../src/core/registry.ts';
import { AGENTS, type RunResult } from '../src/core/types.ts';
import { isTranscriptOnlyAgent } from '../src/monitors/transcript-sources.ts';
import type { CanonicalEvent } from '../src/adapters/types.ts';
import { FakeChild, fakeSpawnFn, type FakeSpawnCall } from './helpers/fake-child.ts';

const FIX = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures/cursor-agent');
const STUB = join(FIX, 'stub-cursor-agent.mjs');
const fixture = (name: string): string => readFileSync(join(FIX, name), 'utf8').replaceAll('__SID__', SESSION);
const SESSION = '5b6f8f4e-0d6c-4c53-9f5c-3b0a7c7d9e22';

type Usage = Extract<CanonicalEvent, { type: 'usage' }>;
const usageOf = (events: CanonicalEvent[]): Usage[] => events.filter((e): e is Usage => e.type === 'usage');
const noticesOf = (events: CanonicalEvent[]): string[] =>
  events.flatMap((e) => {
    const p = e.type === 'step' ? (e as { payload?: { kind?: string; warning?: string } }).payload : undefined;
    return p?.kind === 'stderrNotice' && p.warning !== undefined ? [p.warning] : [];
  });
const parseAll = (name: string, opts = {}) => {
  const p = createCursorLineParser(opts);
  const events: CanonicalEvent[] = [];
  for (const line of fixture(name).split('\n')) if (line.trim() !== '') events.push(...p.parseLine(line));
  events.push(...p.finish());
  return { events, parser: p };
};

describe('usage parser fixtures: reported vs computed', () => {
  it('result.usage (camelCase, cost-bench shape) is read; no cost field -> costUsd null', () => {
    const last = JSON.parse(fixture('stream-computed.jsonl').trim().split('\n').pop()!);
    const u = parseCursorResultUsage(last);
    assert.deepEqual(
      [u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens, u.hasTokens, u.costUsd],
      [1000, 200, 5000, 0, true, null],
    );
    assert.equal(parseCursorResultUsage({ usage: { input_tokens: 3, output_tokens: 4 } }).outputTokens, 4);
    assert.equal(parseCursorResultUsage({}).hasTokens, false);
  });

  it('REPORTED path: a stated cost is the cost, flagged vendorMetered (never token math); no warning', () => {
    const { events } = parseAll('stream-reported.jsonl');
    const [u] = usageOf(events);
    assert.ok(u);
    assert.equal((u as unknown as { cost: number }).cost, 0.0421);
    const extra = (u.tokens as { extra?: Record<string, unknown> }).extra!;
    assert.equal(extra.vendorMetered, true);
    assert.equal(extra.costBasis, 'cursor-reported');
    assert.deepEqual(noticesOf(events), []);
    assert.equal((u as unknown as { model: string }).model, 'claude-4-sonnet');
  });

  it('COMPUTED path: tokens without cost carry no cost and no vendor flag, plus a warning step', () => {
    const { events } = parseAll('stream-computed.jsonl');
    const [u] = usageOf(events);
    assert.ok(u);
    assert.equal((u as unknown as { cost?: number }).cost, undefined);
    const extra = (u.tokens as { extra?: Record<string, unknown> }).extra!;
    assert.equal(extra.vendorMetered, undefined);
    assert.deepEqual([u.tokens.inputTokens, u.tokens.cacheReadTokens, u.tokens.outputTokens], [1000, 5000, 200]);
    const notices = noticesOf(events);
    assert.equal(notices.length, 1);
    assert.match(notices[0]!, /computed from the reported tokens/);
  });

  it('NO usage: no usage record, one warning, never an estimate', () => {
    const { events } = parseAll('stream-no-usage.jsonl');
    assert.deepEqual(usageOf(events), []);
    assert.match(noticesOf(events)[0]!, /stated no usage/);
    assert.deepEqual(cursorUsageEvents(null, undefined).events, []);
  });

  it('--model wins over the init display name; the display name is slugged', () => {
    assert.equal((usageOf(parseAll('stream-computed.jsonl', { model: 'gpt-5' }).events)[0] as unknown as { model: string }).model, 'gpt-5');
    assert.equal(cursorModelSlug('Claude 4 Sonnet'), 'claude-4-sonnet');
  });
});

describe('stdout line parser', () => {
  it('maps the documented stream: session once, assistant messages, tool start/result', () => {
    const { events, parser } = parseAll('stream-computed.jsonl');
    assert.equal(events.filter((e) => e.type === 'session').length, 1);
    assert.equal(parser.sessionId(), SESSION);
    assert.deepEqual(
      events.filter((e) => e.type === 'message').map((e) => (e as { text: string }).text),
      ['I will list the files.', 'Done: one file.'],
    );
    const tools = events.filter((e) => e.type === 'tool') as Array<{ toolName: string; phase: string; toolCallId: string; status?: string }>;
    assert.deepEqual(tools.map((t) => [t.toolName, t.phase, t.toolCallId, t.status]), [
      ['read', 'start', 'call_1', undefined],
      ['read', 'result', 'call_1', 'success'],
    ]);
  });

  it('an is_error result is an error event; an unknown event type is ignored; malformed JSON throws', () => {
    const { events } = parseAll('stream-run-error.jsonl');
    assert.ok(events.some((e) => e.type === 'error' && /cursor: run failed: model unavailable/.test((e as { message: string }).message)));
    assert.deepEqual(createCursorLineParser().parseLine('{"type":"thinking","subtype":"delta"}'), []);
    assert.throws(() => createCursorLineParser().parseLine('not json'));
  });

  it('a stream that never reaches `result` emits no usage warning (the auth error is the story)', () => {
    const p = createCursorLineParser();
    p.parseLine(fixture('stream-computed.jsonl').split('\n')[0]!);
    assert.deepEqual(p.finish(), []);
  });
});

describe('argv, sandbox and stderr classification', () => {
  it('headless argv: print + stream-json, --trust, --force, prompt after `--`', () => {
    assert.deepEqual(cursorArgs('hello', { model: 'gpt-5' }), ['--print', '--output-format', 'stream-json', '--trust', '--model', 'gpt-5', '--force', '--', 'hello']);
    assert.deepEqual(cursorArgs('-x').slice(-2), ['--', '-x']);
    const resumed = cursorArgs('go', { resume: 'chat-1' });
    assert.deepEqual(resumed.slice(resumed.indexOf('--resume'), resumed.indexOf('--resume') + 2), ['--resume', 'chat-1']);
    assert.equal(resumed[resumed.length - 2], '--');
    assert.equal(resumed[resumed.length - 1], 'go');
  });

  it('permissionMode: plan/ask -> --mode (no --force); dontAsk/unset -> --force; unsupported fields warn', () => {
    assert.deepEqual(cursorSandboxArgs({ permissionMode: 'plan' }), ['--mode', 'plan']);
    assert.deepEqual(cursorSandboxArgs({ permissionMode: 'ask' }), ['--mode', 'ask']);
    assert.deepEqual(cursorSandboxArgs({ permissionMode: 'dontAsk' }), ['--force']);
    assert.deepEqual(cursorSandboxArgs(undefined), ['--force']);
    const issues = cursorUnsupportedSandbox({ permissionMode: 'bogus', allowedTools: ['x'] } as never);
    assert.deepEqual(issues.map((i) => i.field), ['sandbox.permissionMode', 'sandbox.allowedTools']);
  });

  it('classifies the unauthenticated CLI (text observed on cursor-agent 2026.10.01)', () => {
    const real = "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.";
    assert.match(classifyCursorStderr(real) ?? '', /cursor-agent login.*CURSOR_API_KEY/);
    assert.match(classifyCursorStderr('Not logged in') ?? '', /cursor-agent login/);
    assert.equal(classifyCursorStderr('some other warning'), null);
  });

  it('is registered: AGENTS, capabilities', () => {
    assert.ok((AGENTS as readonly string[]).includes('cursor'));
    assert.equal(CURSOR_CAPABILITIES.headless, true);
    assert.equal(new CursorAdapter().name, 'cursor');
  });
});

describe('adapter over a fake child process', () => {
  it('CURSOR_AGENT_BIN is the default binary', () => {
    const prev = process.env.CURSOR_AGENT_BIN;
    process.env.CURSOR_AGENT_BIN = '/opt/test/cursor-agent-x';
    try {
      const child = new FakeChild();
      const calls: FakeSpawnCall[] = [];
      new CursorAdapter({ spawnFn: fakeSpawnFn(child, calls) }).spawn('hi');
      assert.equal(calls[0]!.command, '/opt/test/cursor-agent-x');
      child.close(0);
    } finally {
      if (prev === undefined) delete process.env.CURSOR_AGENT_BIN;
      else process.env.CURSOR_AGENT_BIN = prev;
    }
  });
});

describe('preflight', () => {
  const base = { command: STUB, env: { ...process.env } as Record<string, string | undefined> };
  it('"Not logged in" from `status` fails with the specific remedy', async () => {
    const r = await cursorPreflight({ ...base, env: { ...base.env, CURSOR_API_KEY: '', STUB_CURSOR_MODE: 'logged-out' } });
    assert.equal(r.ok, false);
    assert.match(r.message ?? '', /not authenticated.*cursor-agent login.*CURSOR_API_KEY/);
  });
  it('control: a logged-in status passes', async () => {
    assert.equal((await cursorPreflight({ ...base, env: { ...base.env, CURSOR_API_KEY: '', STUB_CURSOR_MODE: 'computed' } })).ok, true);
  });
  it('CURSOR_API_KEY in the env skips the status probe entirely (the logged-out stub would fail it)', async () => {
    const r = await cursorPreflight({ ...base, env: { ...base.env, CURSOR_API_KEY: 'synthetic-key', STUB_CURSOR_MODE: 'logged-out' } });
    assert.equal(r.ok, true);
  });
  it('a missing binary gets a specific install/override message', async () => {
    const r = await cursorPreflight({ command: join(tmpdir(), 'no-such-cursor-agent-bin'), env: { ...process.env } });
    assert.equal(r.ok, false);
    assert.match(r.message ?? '', /could not start.*brew install --cask cursor-cli.*CURSOR_AGENT_BIN/);
  });
});

function env(): { home: string; state: string; reg: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), 'cursor-e2e-'));
  const dirs = { home: join(root, 'home'), state: join(root, 'state'), reg: join(root, 'registry'), cwd: join(root, 'cwd') };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  return dirs;
}

async function driveStub(
  mode: string,
  dirs: ReturnType<typeof env>,
  spec: { resume?: string; model?: string } = {},
  extraEnv: Record<string, string> = {},
): Promise<{ result: RunResult; argv: string[] | null; statusCalls: number }> {
  const tag = Math.random().toString(36).slice(2);
  const argvFile = join(dirs.state, `argv-${tag}.json`);
  const statusFile = join(dirs.state, `status-${tag}.log`);
  const adapter = new CursorAdapter({
    command: STUB,
    env: { CURSOR_API_KEY: '', STUB_CURSOR_MODE: mode, STUB_CURSOR_ARGV: argvFile, STUB_CURSOR_STATUS: statusFile, ...extraEnv },
  });
  const driver = createDriver({
    adapters: { cursor: { name: 'cursor', launch: (s) => adapter.launch(s), validateProfile: (s) => adapter.validateProfile(s) } },
    stateDir: dirs.state,
    registry: { stateDir: dirs.reg },
  });
  const result = await driver.run('cursor', { prompt: 'list the files', cwd: dirs.cwd, ...spec });
  return {
    result,
    argv: existsSync(argvFile) ? (JSON.parse(readFileSync(argvFile, 'utf8')) as string[]) : null,
    statusCalls: existsSync(statusFile) ? readFileSync(statusFile, 'utf8').split('\n').filter(Boolean).length : 0,
  };
}

describe('end to end through the driver with a stub cursor-agent', () => {
  it('REPORTED: the stated cost is the run cost, provenance reported, never token math', async () => {
    const dirs = env();
    const { result, argv, statusCalls } = await driveStub('reported', dirs, { model: 'claude-sonnet-5' });
    assert.equal(result.exitStatus, 'success');
    assert.equal(statusCalls, 1, 'preflight ran `status` once');
    assert.deepEqual(argv!.slice(0, 4), ['--print', '--output-format', 'stream-json', '--trust']);
    assert.equal(argv![argv!.length - 1], 'list the files');
    assert.equal(result.sessionId, SESSION);
    assert.ok(Math.abs(result.totalCost - 0.0421) < 1e-12, `totalCost ${result.totalCost}`);
    assert.equal(result.usage!.cost?.costAvailability, 'reported');
    // Control: token math on the same tokens differs from the stated cost.
    const priced = createPricer().price({ agent: 'cursor', model: 'claude-sonnet-5', inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 0 });
    assert.notEqual(Math.round(priced * 1e6), Math.round(0.0421 * 1e6));
    const [rec] = listRunRecords(dirs.reg);
    assert.equal(rec!.agent, 'cursor');
    assert.equal(rec!.totals!.costSource, 'reported');
    assert.equal(rec!.totals!.provenance!.costUsd, 'reported');
    assert.ok(!result.warnings.some((w) => /computed from the reported tokens/.test(w)));
  });

  it('COMPUTED: tokens only -> cost from the pricing table, provenance computed, warning event', async () => {
    const dirs = env();
    const { result } = await driveStub('computed', dirs, { model: 'claude-sonnet-5' });
    assert.equal(result.exitStatus, 'success');
    const expected = createPricer().price({ agent: 'cursor', model: 'claude-sonnet-5', inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 0 });
    assert.ok(expected > 0);
    assert.ok(Math.abs(result.totalCost - expected) < 1e-12, `${result.totalCost} vs ${expected}`);
    assert.equal(result.usage!.tokens.available, true);
    assert.ok(result.warnings.some((w) => /computed from the reported tokens/.test(w)), result.warnings.join(' | '));
    assert.ok(result.events.some((e) => e.type === 'step' && /computed from the reported tokens/.test(JSON.stringify(e.data ?? ''))), 'warning also on the event stream');
    const [rec] = listRunRecords(dirs.reg);
    assert.equal(rec!.totals!.provenance!.costUsd, 'computed');
    assert.notEqual(rec!.totals!.costSource, 'reported');
  });

  it('NO usage: success run, no tokens, no cost, one warning', async () => {
    const dirs = env();
    const { result } = await driveStub('no-usage', dirs);
    assert.equal(result.exitStatus, 'success');
    assert.equal(result.totalCost, 0);
    assert.equal(result.usage!.usd.available, false);
    assert.ok(result.warnings.some((w) => /stated no usage/.test(w)), result.warnings.join(' | '));
  });

  it('resume passes --resume <chatId> and keeps the chat id as the session', async () => {
    const dirs = env();
    const { result, argv } = await driveStub('computed', dirs, { resume: 'chat-123' });
    const i = argv!.indexOf('--resume');
    assert.equal(argv![i + 1], 'chat-123');
    assert.equal(result.sessionId, 'chat-123');
  });

  it('unauthenticated (status says "Not logged in"): specific preflight error, run unavailable, the run is never launched', async () => {
    const dirs = env();
    const { result, argv } = await driveStub('logged-out', dirs);
    assert.equal(result.exitStatus, 'unavailable');
    const errors = result.events.filter((e) => e.type === 'error').map((e) => String(e.message ?? e.content ?? ''));
    assert.ok(errors.some((m) => /cursor: not authenticated\. Run `cursor-agent login`.*CURSOR_API_KEY/.test(m)), errors.join(' | '));
    assert.equal(argv, null, 'the main run was not spawned');
    const [rec] = listRunRecords(dirs.reg);
    assert.equal(rec!.agent, 'cursor');
  });

  it('control: with CURSOR_API_KEY set the same logged-out stub is not probed, and the run goes through (stub run-auth fails the run itself with the specific stderr error)', async () => {
    const dirs = env();
    const { result, argv, statusCalls } = await driveStub('run-auth', dirs, {}, { CURSOR_API_KEY: 'synthetic-key' });
    assert.equal(statusCalls, 0);
    assert.ok(argv !== null);
    assert.equal(result.exitStatus, 'unavailable');
    const errors = result.events.filter((e) => e.type === 'error').map((e) => String(e.message ?? e.content ?? ''));
    assert.ok(errors.some((m) => /cursor: not authenticated/.test(m)), errors.join(' | '));
  });

  it('a failing result (is_error, exit 1) after work is an error run, not unavailable', async () => {
    const dirs = env();
    const { result } = await driveStub('run-error', dirs);
    assert.equal(result.exitStatus, 'error');
  });
});

describe('the cursor name: launch adapter AND read-only IDE monitor', () => {
  it('is no longer refused as transcript-only; amp/goose/qwen still are (control)', () => {
    assert.equal(isTranscriptOnlyAgent('cursor'), false);
    for (const a of ['amp', 'goose', 'qwen']) assert.equal(isTranscriptOnlyAgent(a), true, a);
  });

  it('defaultAdapters() registers cursor and the MCP run schema accepts it', async () => {
    const { defaultAdapters } = await import('../src/core/driver.ts');
    const { RunArgsSchema } = await import('../src/mcp/tools-run.ts');
    assert.equal((await defaultAdapters()).cursor?.name, 'cursor');
    assert.ok(RunArgsSchema.safeParse({ agent: 'cursor', prompt: 'hi' }).success);
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
      env: { ...process.env, AGENTIC_CODING_HARNESS_TZ: 'UTC', AGENTIC_CODING_HARNESS_COST_MODE: 'auto', CURSOR_API_KEY: '', ...e },
    });
  };

  it('`ach run --agent cursor` records a run; `ach stats` renders the cursor row like another agent (control: null)', () => {
    const dirs = env();
    const e = { HOME: dirs.home, AGENTIC_CODING_HARNESS_STATE_DIR: dirs.state, CURSOR_AGENT_BIN: STUB, STUB_CURSOR_MODE: 'reported' };
    const run = invoke(e, ['run', '--agent', 'cursor', '--model', 'claude-sonnet-5', 'list the files'], dirs.cwd);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^cost\s+\$0\.0421$/m);
    assert.match(run.stdout, /^exit\s+success$/m);
    const ctl = invoke(e, ['run', '--agent', 'null', 'hi'], dirs.cwd);
    assert.equal(ctl.status, 0, ctl.stderr);
    const stats = invoke(e, ['stats', '--state-only'], dirs.cwd);
    assert.equal(stats.status, 0, stats.stderr);
    const row = (name: string): string => stats.stdout.split('\n').find((l) => l.startsWith(`${name} `))!;
    const shape = (l: string): string => l.replace(/\d[\d,]*(\.\d+)?/g, 'N').replace(/^\S+\s+/, 'AGENT ');
    assert.ok(row('cursor'), stats.stdout);
    assert.equal(shape(row('cursor')), shape(row('null')), `${row('cursor')} vs ${row('null')}`);
    const filtered = invoke(e, ['stats', '--state-only', '--agent', 'cursor'], dirs.cwd);
    assert.equal(filtered.status, 0, filtered.stderr);
    assert.ok(/^cursor /m.test(filtered.stdout), filtered.stdout);
  });

  it('an unauthenticated CLI fails `ach run --agent cursor` with the specific message and a non-zero exit', () => {
    const dirs = env();
    const e = { HOME: dirs.home, AGENTIC_CODING_HARNESS_STATE_DIR: dirs.state, CURSOR_AGENT_BIN: STUB, STUB_CURSOR_MODE: 'logged-out' };
    const run = invoke(e, ['run', '--agent', 'cursor', 'hi'], dirs.cwd);
    assert.notEqual(run.status, 0);
    assert.match(run.stdout + run.stderr, /cursor: not authenticated\. Run `cursor-agent login`/);
  });

  it('`--help` lists cursor with its auth prerequisite', () => {
    const help = invoke({ HOME: tmpdir() }, ['--help'], tmpdir());
    const text = help.stdout + help.stderr;
    assert.match(text, /--agent <[^>]*cursor[^>]*>/);
    assert.match(text, /cursor-agent login/);
    assert.match(text, /CURSOR_AGENT_BIN/);
  });
});
