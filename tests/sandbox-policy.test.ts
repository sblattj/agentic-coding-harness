import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { SpawnOptions } from 'node:child_process';
import { describe, it } from 'node:test';
import { ClaudeCodeAdapter, claudeSandboxArgs } from '../src/adapters/claude.ts';
import { CodexAdapter, codexSandboxArgs } from '../src/adapters/codex.ts';
import { GeminiAdapter, geminiSandboxArgs } from '../src/adapters/gemini.ts';
import { OpenCodeAdapter } from '../src/adapters/opencode.ts';
import { KiroAdapter, applySandboxToKiroSpec } from '../src/adapters/kiro.ts';
import { KiroAcpClient } from '../src/adapters/kiro-acp.ts';
import {
  PROVIDER_CREDENTIAL_ENV_VARS,
  mcpConfigToken,
  scrubEnvVars,
} from '../src/adapters/shared.ts';
import { RunSpecSchema, type SandboxPolicy } from '../src/core/types.ts';
import { FakeChild, fakeSpawnFn, type FakeSpawnCall } from './helpers/fake-child.ts';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Set/restore process.env entries around a synchronous body. */
function withEnv(overrides: Record<string, string>, fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(overrides)) {
    saved.set(k, process.env[k]);
    process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Minimal claude-lane child (claude.ts has its own SpawnFn contract). */
class ClaudeFakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  kill(): boolean {
    return true;
  }
  close(code: number | null = 0): void {
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit('close', code, null));
  }
}

interface ClaudeCaptured {
  args?: string[];
  options?: SpawnOptions;
}

function makeClaudeAdapter(): { adapter: ClaudeCodeAdapter; captured: ClaudeCaptured; stateDir: string } {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'ach-sandbox-test-'));
  const captured: ClaudeCaptured = {};
  const spawnFn = (_command: string, args: readonly string[], opts: SpawnOptions) => {
    captured.args = [...args];
    captured.options = opts;
    const child = new ClaudeFakeChild();
    // Session line so launch()'s sessionId capture settles immediately
    // instead of waiting out the 2s default.
    child.stdout.write('{"type":"system","subtype":"init","session_id":"sess-sandbox"}\n');
    return child as never;
  };
  const adapter = new ClaudeCodeAdapter({ stateDir, spawnFn });
  return { adapter, captured, stateDir };
}

// ---------------------------------------------------------------------------
// Pure helpers (shared.ts)
// ---------------------------------------------------------------------------

describe('sandbox policy — shared helpers', () => {
  it('scrubEnvVars(true) removes every known provider credential var', () => {
    const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: 'a', PATH: '/bin', KIRO_API_KEY: 'k' };
    for (const name of PROVIDER_CREDENTIAL_ENV_VARS) env[name] = 'x';
    env.PATH = '/bin';
    const out = scrubEnvVars(env, true);
    for (const name of PROVIDER_CREDENTIAL_ENV_VARS) assert.equal(out[name], undefined, `${name} scrubbed`);
    assert.equal(out.PATH, '/bin', 'unrelated vars survive');
  });

  it('scrubEnvVars(string[]) removes exactly the listed vars', () => {
    const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', PATH: '/bin' };
    const out = scrubEnvVars(env, ['ANTHROPIC_API_KEY']);
    assert.equal(out.ANTHROPIC_API_KEY, undefined);
    assert.equal(out.OPENAI_API_KEY, 'o', 'unlisted credentials survive the targeted scrub');
    assert.equal(out.PATH, '/bin');
  });

  it('scrubEnvVars(undefined/false) returns the input unchanged (same reference)', () => {
    const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: 'a' };
    assert.equal(scrubEnvVars(env, undefined), env);
    assert.equal(scrubEnvVars(env, false), env);
  });

  it('mcpConfigToken passes a string through and JSON-stringifies an object', () => {
    assert.equal(mcpConfigToken('/tmp/mcp.json'), '/tmp/mcp.json');
    assert.equal(
      mcpConfigToken({ mcpServers: { fetch: { command: 'uvx' } } }),
      '{"mcpServers":{"fetch":{"command":"uvx"}}}',
    );
  });

  it('RunSpecSchema round-trips a typed sandbox policy', () => {
    const parsed = RunSpecSchema.parse({
      prompt: 'hi',
      sandbox: { allowedTools: ['Read'], permissionMode: 'ask', scrubEnv: true },
    });
    assert.deepEqual(parsed.sandbox, { allowedTools: ['Read'], permissionMode: 'ask', scrubEnv: true });
  });
});

// ---------------------------------------------------------------------------
// Claude: --allowedTools / --disallowedTools / --permission-mode / --mcp-config
// ---------------------------------------------------------------------------

describe('sandbox policy — claude argv translation', () => {
  it('claudeSandboxArgs maps every policy field (pure)', () => {
    assert.deepEqual(
      claudeSandboxArgs({
        allowedTools: ['Read', 'Bash'],
        disallowedTools: ['WebFetch'],
        permissionMode: 'ask',
        mcpConfig: { mcpServers: {} },
      }),
      [
        '--allowedTools',
        'Read,Bash',
        '--disallowedTools',
        'WebFetch',
        '--permission-mode',
        'default',
        '--mcp-config',
        '{"mcpServers":{}}',
      ],
    );
  });

  it('permissionMode: dontAsk → bypassPermissions; native spellings verbatim; empty lists emit no flag', () => {
    assert.deepEqual(claudeSandboxArgs({ permissionMode: 'dontAsk' }), [
      '--permission-mode',
      'bypassPermissions',
    ]);
    assert.deepEqual(claudeSandboxArgs({ permissionMode: 'acceptEdits' }), [
      '--permission-mode',
      'acceptEdits',
    ]);
    assert.deepEqual(claudeSandboxArgs({ allowedTools: [], disallowedTools: [] }), []);
  });

  it('spawn() forwards the policy as claude CLI flags; mcpConfig path string verbatim', () => {
    const { adapter, captured } = makeClaudeAdapter();
    adapter.spawn({
      prompt: 'x',
      sandbox: {
        allowedTools: ['Read'],
        disallowedTools: ['Bash'],
        permissionMode: 'dontAsk',
        mcpConfig: '/etc/mcp.json',
      },
    });
    assert.deepEqual(captured.args, [
      '-p',
      'x',
      '--output-format',
      'stream-json',
      '--verbose',
      '--max-turns',
      '250',
      '--allowedTools',
      'Read',
      '--disallowedTools',
      'Bash',
      '--permission-mode',
      'bypassPermissions',
      '--mcp-config',
      '/etc/mcp.json',
    ]);
  });

  it('launch() forwards spec.sandbox through the driver contract', async () => {
    const { adapter, captured } = makeClaudeAdapter();
    const launchPromise = adapter.launch({
      prompt: 'x',
      sandbox: { permissionMode: 'ask' },
    });
    await launchPromise;
    assert.ok(captured.args?.includes('--permission-mode'));
    assert.equal(captured.args?.[captured.args.indexOf('--permission-mode') + 1], 'default');
  });
});

describe('sandbox policy — claude scrubEnv', () => {
  it('scrubEnv: true strips provider credentials from the merged env; per-run CLAUDE_CONFIG_DIR survives', () => {
    const { adapter, captured, stateDir } = makeClaudeAdapter();
    try {
      withEnv({ ANTHROPIC_API_KEY: 'sk-ambient', CLAUDE_CONFIG_DIR: '/ambient/claude' }, () => {
        adapter.spawn({
          prompt: 'x',
          env: { OPENAI_API_KEY: 'sk-overlay' },
          sandbox: { scrubEnv: true },
        });
      });
      const env = captured.options?.env ?? {};
      assert.equal(env.ANTHROPIC_API_KEY, undefined, 'ambient credential scrubbed');
      assert.equal(env.OPENAI_API_KEY, undefined, 'spec.env credential scrubbed after the overlay');
      assert.notEqual(env.CLAUDE_CONFIG_DIR, '/ambient/claude', 'inherited config-dir override scrubbed');
      assert.ok(
        typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR.startsWith(stateDir),
        'adapter re-applies its own per-run config dir after the scrub',
      );
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('scrubEnv: [names] removes exactly those vars', () => {
    const { adapter, captured } = makeClaudeAdapter();
    withEnv({ ANTHROPIC_API_KEY: 'sk-a', OPENAI_API_KEY: 'sk-o' }, () => {
      adapter.spawn({ prompt: 'x', sandbox: { scrubEnv: ['ANTHROPIC_API_KEY'] } });
    });
    const env = captured.options?.env ?? {};
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.OPENAI_API_KEY, 'sk-o', 'unlisted credential survives the targeted scrub');
  });

  it('no scrubEnv keeps credentials flowing through (control)', () => {
    const { adapter, captured } = makeClaudeAdapter();
    withEnv({ ANTHROPIC_API_KEY: 'sk-keep' }, () => {
      adapter.spawn({ prompt: 'x' });
    });
    assert.equal(captured.options?.env?.ANTHROPIC_API_KEY, 'sk-keep');
  });
});

// ---------------------------------------------------------------------------
// Codex: --ask-for-approval only
// ---------------------------------------------------------------------------

describe('sandbox policy — codex translation', () => {
  it('codexSandboxArgs maps permissionMode only (ask→on-request, dontAsk→never, native verbatim)', () => {
    assert.deepEqual(codexSandboxArgs({ permissionMode: 'ask' }), ['--ask-for-approval', 'on-request']);
    assert.deepEqual(codexSandboxArgs({ permissionMode: 'dontAsk' }), ['--ask-for-approval', 'never']);
    assert.deepEqual(codexSandboxArgs({ permissionMode: 'on-failure' }), [
      '--ask-for-approval',
      'on-failure',
    ]);
    // Fields codex has no flags for are omitted.
    assert.deepEqual(
      codexSandboxArgs({ allowedTools: ['shell'], disallowedTools: ['web'], mcpConfig: '/mcp.json' }),
      [],
    );
  });

  it('launch() appends --ask-for-approval and omits unsupported fields', async () => {
    const child = new FakeChild();
    const calls: FakeSpawnCall[] = [];
    const adapter = new CodexAdapter({ spawnFn: fakeSpawnFn(child, calls) });
    const launchPromise = adapter.launch({
      prompt: 'x',
      model: 'gpt-5.2-codex',
      sandbox: { permissionMode: 'dontAsk', allowedTools: ['shell'], mcpConfig: '/mcp.json' },
    });
    child.close(0);
    await launchPromise;
    assert.deepEqual(calls[0]!.args, [
      'exec',
      '--json',
      '--ask-for-approval',
      'never',
      '-m',
      'gpt-5.2-codex',
      'x',
    ]);
  });

  it('launch() scrubEnv: true strips provider credentials from the child env', async () => {
    const child = new FakeChild();
    const calls: FakeSpawnCall[] = [];
    const adapter = new CodexAdapter({ spawnFn: fakeSpawnFn(child, calls) });
    withEnv({ OPENAI_API_KEY: 'sk-codex', CODEX_HOME: '/ambient/codex' }, () => {
      const launchPromise = adapter.launch({ prompt: 'x', sandbox: { scrubEnv: true } });
      child.close(0);
      return launchPromise;
    });
    const env = calls[0]!.opts.env ?? {};
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.CODEX_HOME, undefined);
    assert.ok(env.PATH !== undefined, 'ambient env otherwise intact');
  });

  it('launch() without sandbox keeps credentials (control) and array-form scrub is targeted', async () => {
    const control = new FakeChild();
    const controlCalls: FakeSpawnCall[] = [];
    const controlAdapter = new CodexAdapter({ spawnFn: fakeSpawnFn(control, controlCalls) });
    withEnv({ OPENAI_API_KEY: 'sk-codex', ANTHROPIC_API_KEY: 'sk-claude' }, () => {
      const p = controlAdapter.launch({ prompt: 'x' });
      control.close(0);
      return p;
    });
    assert.equal(controlCalls[0]!.opts.env?.OPENAI_API_KEY, 'sk-codex');

    const targeted = new FakeChild();
    const targetedCalls: FakeSpawnCall[] = [];
    const targetedAdapter = new CodexAdapter({ spawnFn: fakeSpawnFn(targeted, targetedCalls) });
    withEnv({ OPENAI_API_KEY: 'sk-codex', ANTHROPIC_API_KEY: 'sk-claude' }, () => {
      const p = targetedAdapter.launch({ prompt: 'x', sandbox: { scrubEnv: ['OPENAI_API_KEY'] } });
      targeted.close(0);
      return p;
    });
    assert.equal(targetedCalls[0]!.opts.env?.OPENAI_API_KEY, undefined);
    assert.equal(targetedCalls[0]!.opts.env?.ANTHROPIC_API_KEY, 'sk-claude');
  });
});

// ---------------------------------------------------------------------------
// Gemini: --allowed-tools / --blocked-tools / --approval-mode / --mcp-config
// ---------------------------------------------------------------------------

describe('sandbox policy — gemini translation', () => {
  it('geminiSandboxArgs maps allow/deny lists, approval mode, and mcp config (pure)', () => {
    assert.deepEqual(
      geminiSandboxArgs({
        allowedTools: ['read_file', 'google_web_search'],
        disallowedTools: ['run_shell_command'],
        permissionMode: 'ask',
      }),
      [
        '--allowed-tools',
        'read_file,google_web_search',
        '--blocked-tools',
        'run_shell_command',
        '--approval-mode',
        'default',
      ],
    );
    assert.deepEqual(geminiSandboxArgs({ permissionMode: 'dontAsk' }), ['--approval-mode', 'yolo']);
    assert.deepEqual(geminiSandboxArgs({ permissionMode: 'auto' }), ['--approval-mode', 'auto']);
    assert.deepEqual(geminiSandboxArgs({ mcpConfig: '/tmp/mcp.json' }), ['--mcp-config', '/tmp/mcp.json']);
  });

  it('launch() emits exactly one --approval-mode; permissionMode replaces the default yolo', async () => {
    const child = new FakeChild();
    const calls: FakeSpawnCall[] = [];
    const adapter = new GeminiAdapter({ spawnFn: fakeSpawnFn(child, calls) });
    const launchPromise = adapter.launch({
      prompt: 'x',
      sandbox: { allowedTools: ['read_file'], permissionMode: 'ask' },
    });
    child.close(0);
    await launchPromise;
    const args = calls[0]!.args;
    assert.equal(args.filter((a) => a === '--approval-mode').length, 1, 'exactly one approval-mode flag');
    assert.equal(args[args.indexOf('--approval-mode') + 1], 'default');
    assert.ok(args.includes('--allowed-tools'));
    assert.equal(args[args.indexOf('--allowed-tools') + 1], 'read_file');
    assert.ok(!args.includes('yolo'));
  });

  it('launch() without a sandbox keeps the default --approval-mode yolo (control)', async () => {
    const child = new FakeChild();
    const calls: FakeSpawnCall[] = [];
    const adapter = new GeminiAdapter({ spawnFn: fakeSpawnFn(child, calls) });
    const launchPromise = adapter.launch({ prompt: 'x' });
    child.close(0);
    await launchPromise;
    const args = calls[0]!.args;
    assert.equal(args.filter((a) => a === '--approval-mode').length, 1);
    assert.equal(args[args.indexOf('--approval-mode') + 1], 'yolo');
  });

  it('launch() scrubEnv: true strips GEMINI_API_KEY from the child env', async () => {
    const child = new FakeChild();
    const calls: FakeSpawnCall[] = [];
    const adapter = new GeminiAdapter({ spawnFn: fakeSpawnFn(child, calls) });
    withEnv({ GEMINI_API_KEY: 'g-key' }, () => {
      const launchPromise = adapter.launch({ prompt: 'x', sandbox: { scrubEnv: true } });
      child.close(0);
      return launchPromise;
    });
    assert.equal(calls[0]!.opts.env?.GEMINI_API_KEY, undefined);
  });
});

// ---------------------------------------------------------------------------
// OpenCode: no CLI flags — policy fields omitted, scrubEnv still applies
// ---------------------------------------------------------------------------

describe('sandbox policy — opencode translation', () => {
  it('launch() omits unsupported policy fields from argv entirely', async () => {
    const child = new FakeChild();
    const calls: FakeSpawnCall[] = [];
    const adapter = new OpenCodeAdapter({ spawnFn: fakeSpawnFn(child, calls) });
    const launchPromise = adapter.launch({
      prompt: 'x',
      sandbox: {
        allowedTools: ['edit'],
        disallowedTools: ['bash'],
        permissionMode: 'ask',
        mcpConfig: '/mcp.json',
      },
    });
    child.close(0);
    await launchPromise;
    assert.deepEqual(calls[0]!.args, ['run', 'x', '--format', 'json']);
  });

  it('launch() applies scrubEnv to the child env', async () => {
    const child = new FakeChild();
    const calls: FakeSpawnCall[] = [];
    const adapter = new OpenCodeAdapter({ spawnFn: fakeSpawnFn(child, calls) });
    withEnv({ OPENCODE_CONFIG: '/ambient/opencode' }, () => {
      const launchPromise = adapter.launch({ prompt: 'x', sandbox: { scrubEnv: true } });
      child.close(0);
      return launchPromise;
    });
    assert.equal(calls[0]!.opts.env?.OPENCODE_CONFIG, undefined);
  });
});

// ---------------------------------------------------------------------------
// Kiro: allowedTools folds into the native trust policy; scrubEnv applies
// ---------------------------------------------------------------------------

describe('sandbox policy — kiro translation', () => {
  it('applySandboxToKiroSpec folds allowedTools into kiro.tools; native tools win (pure)', () => {
    type Spec = Parameters<typeof applySandboxToKiroSpec>[0];
    const folded = applySandboxToKiroSpec({ sandbox: { allowedTools: ['read', 'edit'] } } as Spec);
    assert.deepEqual(folded.kiro?.tools, ['read', 'edit']);

    const nativeWins = applySandboxToKiroSpec({
      kiro: { tools: ['native'] },
      sandbox: { allowedTools: ['read'] },
    } as Spec);
    assert.deepEqual(nativeWins.kiro?.tools, ['native'], 'explicit kiro.tools is never overridden');

    const untouched = applySandboxToKiroSpec({ kiro: { effort: 'high' } } as Spec);
    assert.equal(untouched.kiro?.tools, undefined, 'no sandbox allowlist → no injected trust');
    assert.deepEqual(applySandboxToKiroSpec({} as Spec), {});
  });

  it('spawn() maps sandbox.allowedTools onto --trust-tools=<csv>', () => {
    const child = new FakeChild();
    const calls: FakeSpawnCall[] = [];
    const adapter = new KiroAdapter({ spawnFn: fakeSpawnFn(child, calls), mitm: false });
    adapter.spawn({ prompt: 'x', sandbox: { allowedTools: ['read', 'edit'] } });
    assert.ok(calls[0]!.args.includes('--trust-tools=read,edit'));

    const native = new KiroAdapter({ spawnFn: fakeSpawnFn(new FakeChild(), calls), mitm: false });
    native.spawn({
      prompt: 'x',
      kiro: { tools: ['native-tool'] },
      sandbox: { allowedTools: ['read'] },
    });
    const run = calls.filter((c) => c.args[0] === 'chat').at(-1)!;
    assert.ok(run.args.includes('--trust-tools=native-tool'), 'native kiro.tools wins over sandbox');
  });

  it('spawn() scrubEnv: true strips KIRO_API_KEY and the AWS chain from the child env', () => {
    const child = new FakeChild();
    const calls: FakeSpawnCall[] = [];
    const adapter = new KiroAdapter({ spawnFn: fakeSpawnFn(child, calls), mitm: false });
    withEnv({ KIRO_API_KEY: 'k-secret', AWS_SESSION_TOKEN: 'aws-tok' }, () => {
      adapter.spawn({ prompt: 'x', sandbox: { scrubEnv: true } });
    });
    assert.equal(calls[0]!.opts.env?.KIRO_API_KEY, undefined);
    assert.equal(calls[0]!.opts.env?.AWS_SESSION_TOKEN, undefined);
  });

  it('KiroAcpClient (ACP transport) scrubs the merged child env at start()', () => {
    const calls: FakeSpawnCall[] = [];
    const child = new FakeChild();
    const client = new KiroAcpClient({
      args: ['acp'],
      env: { KIRO_API_KEY: 'overlay-secret' },
      scrubEnv: true,
      spawnFn: fakeSpawnFn(child, calls),
    });
    withEnv({ OPENAI_API_KEY: 'ambient' }, () => {
      client.start();
    });
    const env = calls[0]!.opts.env ?? {};
    assert.equal(env.KIRO_API_KEY, undefined, 'spec.env credential scrubbed after the overlay');
    assert.equal(env.OPENAI_API_KEY, undefined, 'ambient credential scrubbed');
    child.close(0);
  });
});

// ---------------------------------------------------------------------------
// Type-level: SandboxPolicy field surface (compile-time contract)
// ---------------------------------------------------------------------------

describe('sandbox policy — type surface', () => {
  it('accepts the issue-proposed option shape', () => {
    const policy: SandboxPolicy = {
      allowedTools: ['Read', 'Bash'],
      disallowedTools: ['WebFetch'],
      permissionMode: 'ask',
      mcpConfig: { mcpServers: { fetch: { command: 'uvx', args: ['mcp-server-fetch'] } } },
      scrubEnv: ['ANTHROPIC_API_KEY'],
    };
    assert.ok(Array.isArray(policy.scrubEnv) && policy.scrubEnv.length === 1);
  });
});
