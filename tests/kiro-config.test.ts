// Kiro config/usage type surface: the MCP `kiro` param, its validation, and
// forward/backward compatibility of the RunResult + RunRecord schemas.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  KiroConfigSchema,
  RunResultSchema,
  RunSpecSchema,
  type KiroConfig,
} from '../src/core/types.js';
import { RunRecordSchema } from '../src/core/registry.js';
import { RunArgsSchema, toRunSpec } from '../src/mcp/tools-run.js';
import { toSpec } from '../src/mcp/tools-jobs.js';

const KIRO: KiroConfig = {
  transport: 'acp',
  agent: 'default',
  engine: 'v2',
  effort: 'high',
  tools: ['read', 'write'],
  requireMcpStartup: true,
  mcpServers: [{ name: 'fs', command: 'mcp-fs', args: ['--root', '/tmp'], env: { A: 'b' } }],
  startupMs: 45_000,
  requireModelAck: true,
};

describe('KiroConfigSchema', () => {
  it('accepts the full config and every tools variant', () => {
    assert.deepEqual(KiroConfigSchema.parse(KIRO), KIRO);
    for (const tools of ['all', 'none', ['read']] as const) {
      assert.deepEqual(KiroConfigSchema.parse({ tools }).tools, tools);
    }
    assert.deepEqual(KiroConfigSchema.parse({}), {});
  });

  it('rejects an unknown key and an out-of-enum value', () => {
    const bad = KiroConfigSchema.safeParse({ transport: 'acp', trasnport: 'acp' });
    assert.equal(bad.success, false);
    assert.match(JSON.stringify(bad.error!.issues), /trasnport/);
    assert.equal(KiroConfigSchema.safeParse({ transport: 'stdio' }).success, false);
    assert.equal(KiroConfigSchema.safeParse({ tools: 'some' }).success, false);
  });
});

describe('MCP kiro param', () => {
  it('harness_run forwards spec.kiro verbatim', () => {
    const args = RunArgsSchema.parse({ agent: 'kiro', prompt: 'hi', model: 'm', kiro: KIRO });
    const spec = toRunSpec(args, []);
    assert.deepEqual(spec.kiro, KIRO);
    assert.equal(spec.model, 'm');
    assert.equal(spec.extraArgs, undefined);
  });

  it('harness_run_async forwards spec.kiro verbatim', () => {
    const args = RunArgsSchema.parse({ agent: 'kiro', prompt: 'hi', kiro: KIRO });
    const spec = toSpec(args, 'run-1');
    assert.deepEqual(spec.kiro, KIRO);
    assert.equal(spec.runId, 'run-1');
  });

  it('omits kiro entirely when the caller sends none', () => {
    const args = RunArgsSchema.parse({ agent: 'claude', prompt: 'hi' });
    assert.equal('kiro' in toRunSpec(args, []), false);
    assert.equal('kiro' in toSpec(args, 'run-2'), false);
  });

  it('an unknown key inside kiro is rejected, and the error names the field', () => {
    const parsed = RunArgsSchema.safeParse({
      agent: 'kiro',
      prompt: 'hi',
      kiro: { transport: 'acp', bogusKey: 1 },
    });
    assert.equal(parsed.success, false);
    const issue = parsed.error!.issues[0]!;
    // Same rendering the MCP handlers use: path + message.
    const rendered = `bad field '${issue.path.join('.')}': ${issue.message}`;
    assert.match(rendered, /kiro/);
    assert.match(`${rendered} ${JSON.stringify(issue)}`, /bogusKey/);
  });

  it('RunSpecSchema keeps kiro and still passes unknown adapter keys through', () => {
    const spec = RunSpecSchema.parse({ prompt: 'hi', kiro: KIRO, somethingElse: 7 });
    assert.deepEqual(spec.kiro, KIRO);
    assert.equal((spec as Record<string, unknown>).somethingElse, 7);
  });
});

const OLD_RESULT = {
  runId: 'r1',
  sessionId: 's1',
  events: [],
  tokens: [],
  totalCost: 0,
  durationMs: 10,
  exitStatus: 'success',
  warnings: [],
};

const USAGE = {
  tokens: { available: false },
  credits: { available: true, source: 'native', scope: 'run', cumulative: true, value: 12 },
  usd: { available: false },
};

describe('RunResultSchema / RunRecordSchema compatibility', () => {
  it('parses an old result (no kiro/usage) and a new one', () => {
    const oldOk = RunResultSchema.parse(OLD_RESULT);
    assert.equal(oldOk.kiro, undefined);
    assert.equal(oldOk.usage, undefined);
    const fresh = RunResultSchema.parse({
      ...OLD_RESULT,
      kiro: {
        cliVersion: '2.21.4',
        transport: 'acp',
        requested: KIRO,
        effective: { model: 'm', transport: 'acp' },
        nativeSessionId: 'acp-1',
        modelAck: 'acknowledged',
        configHash: 'deadbeef',
      },
      usage: USAGE,
    });
    assert.equal(fresh.kiro?.modelAck, 'acknowledged');
    assert.equal(fresh.usage?.credits.value, 12);
  });

  const OLD_RECORD = {
    runId: 'r1',
    agent: 'kiro',
    pid: 1,
    cwd: '/tmp',
    promptPreview: 'hi',
    startedAt: 1,
    updatedAt: 2,
    status: 'running',
    totals: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    },
    rawTranscript: '/tmp/x.jsonl',
  };

  it('parses an old record and a new one carrying kiro/usage', () => {
    const oldOk = RunRecordSchema.parse(OLD_RECORD);
    assert.equal(oldOk.kiro, undefined);
    const fresh = RunRecordSchema.parse({
      ...OLD_RECORD,
      kiro: {
        cliVersion: '2.21.4',
        transport: 'acp',
        modelAck: 'rejected',
        nativeSessionId: 'acp-1',
      },
      usage: USAGE,
    });
    assert.equal(fresh.kiro?.transport, 'acp');
    assert.equal(fresh.usage?.tokens.available, false);
  });
});
