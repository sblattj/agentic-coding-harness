// Adapter-owned profile validation (agentic-coding-harness#9): adapters
// validate their own agent profile/config; the driver enforces the verdict.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { AgentAdapter, AgentEvent, AgentHandle, RunSpec } from '../src/core/types.js';
import { createDriver, defaultAdapters } from '../src/core/driver.js';
import { KiroAdapter, validateKiroProfile } from '../src/adapters/kiro.js';
import { ClaudeCodeAdapter } from '../src/adapters/claude.js';

const SESSION = '7a30b2b1-9f55-4f0a-8b1e-1a2b3c4d5e6f';

describe('validateKiroProfile (kiro adapter owns its config)', () => {
  it('accepts a valid full config and a bare spec', () => {
    const full = validateKiroProfile({
      prompt: 'hi',
      model: 'claude-sonnet-4',
      resume: SESSION,
      kiro: {
        transport: 'acp',
        agent: 'default',
        engine: 'v2',
        effort: 'high',
        tools: ['read', 'write'],
        requireMcpStartup: true,
        mcpServers: [{ name: 'fs', command: 'mcp-fs', args: ['--root', '/tmp'] }],
        startupMs: 45_000,
        requireModelAck: true,
      },
    });
    assert.equal(full.ok, true);
    assert.deepEqual(full.errors, []);
    assert.deepEqual(full.warnings, []);
    assert.equal(validateKiroProfile({ prompt: 'hi' }).ok, true);
  });

  it('rejects schema violations with dotted field names', () => {
    const bad = validateKiroProfile({
      prompt: 'hi',
      // Intentional typo + bad enum: strict schema must name both.
      kiro: { trasnport: 'acp', effort: 'mega' } as unknown as RunSpec['kiro'],
    });
    assert.equal(bad.ok, false);
    const fields = bad.errors.map((e) => e.field);
    assert.ok(fields.includes('kiro.effort'), `fields: ${fields.join(', ')}`);
    // strict schema reports the unknown key on the root path but names it in the message
    assert.ok(bad.errors.some((e) => e.field === 'kiro.(root)' && /trasnport/.test(e.message)), JSON.stringify(bad.errors));
  });

  it('rejects duplicate, empty, and blank MCP server names/commands', () => {
    const bad = validateKiroProfile({
      prompt: 'hi',
      kiro: {
        transport: 'acp',
        mcpServers: [
          { name: 'fs', command: 'mcp-fs' },
          { name: 'fs', command: 'mcp-fs' },
          { name: '  ', command: 'mcp-fs' },
          { name: 'ok', command: '' },
        ],
      },
    });
    assert.equal(bad.ok, false);
    const fields = bad.errors.map((e) => e.field);
    assert.ok(fields.includes('kiro.mcpServers.1.name'), `fields: ${fields.join(', ')}`);
    assert.ok(fields.includes('kiro.mcpServers.2.name'), `fields: ${fields.join(', ')}`);
    assert.ok(fields.includes('kiro.mcpServers.3.command'), `fields: ${fields.join(', ')}`);
  });

  it('warns (does not fail) on ACP-only fields carried on the headless transport', () => {
    const r = validateKiroProfile({
      prompt: 'hi',
      kiro: { mcpServers: [{ name: 'fs', command: 'mcp-fs' }], requireModelAck: true },
    });
    assert.equal(r.ok, true);
    const fields = r.warnings.map((w) => w.field);
    assert.ok(fields.includes('kiro.mcpServers'), `warnings: ${fields.join(', ')}`);
    assert.ok(fields.includes('kiro.requireModelAck'), `warnings: ${fields.join(', ')}`);
  });

  it('warns when requireMcpStartup is set with no servers', () => {
    const r = validateKiroProfile({ prompt: 'hi', kiro: { requireMcpStartup: true } });
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some((w) => w.field === 'kiro.requireMcpStartup'));
  });

  it('owns the shared model/resume token checks', () => {
    assert.equal(validateKiroProfile({ prompt: 'hi', resume: 'abc/def' }).ok, false);
    assert.equal(validateKiroProfile({ prompt: 'hi', resume: '--flag' }).ok, false);
    assert.equal(validateKiroProfile({ prompt: 'hi', model: '   ' }).ok, false);
    assert.equal(validateKiroProfile({ prompt: 'hi', model: '-weird-model' }).ok, true); // warning only
  });

  it('KiroAdapter exposes it as validateProfile', () => {
    const adapter = new KiroAdapter();
    assert.equal(adapter.validateProfile?.({ prompt: 'hi', kiro: { effort: 'nope' } as unknown as RunSpec['kiro'] }).ok, false);
    assert.equal(adapter.validateProfile?.({ prompt: 'hi' }).ok, true);
  });
});

describe('claude profile validation', () => {
  it('accepts a clean spec and rejects malformed resume/model tokens', () => {
    const adapter = new ClaudeCodeAdapter();
    assert.equal(adapter.validateProfile?.({ prompt: 'hi', model: 'sonnet', resume: SESSION }).ok, true);
    const slash = adapter.validateProfile?.({ prompt: 'hi', resume: '../../etc/passwd' });
    assert.equal(slash?.ok, false);
    assert.ok(slash?.errors.some((e) => e.field === 'resume'));
    assert.equal(adapter.validateProfile?.({ prompt: 'hi', model: '' }).ok, false);
    assert.equal(adapter.validateProfile?.({ prompt: 'hi', resume: '--danger' }).ok, false);
  });
});

// ---------------------------------------------------------------------------
// Driver enforcement
// ---------------------------------------------------------------------------

class CheckHandle implements AgentHandle {
  readonly sessionId = 'profile-test-session';
  async *attach(): AsyncIterable<AgentEvent> {
    yield { type: 'step', sessionId: this.sessionId, timestamp: Date.now() };
  }
  abort(): void {}
  async wait(): Promise<'success'> {
    return 'success';
  }
}

class ProfileAdapter implements AgentAdapter {
  readonly name = 'mock';
  launched = false;
  constructor(private readonly check: { ok: boolean; errors: { field: string; message: string }[]; warnings: { field: string; message: string }[] }) {}
  validateProfile(): { ok: boolean; errors: { field: string; message: string }[]; warnings: { field: string; message: string }[] } {
    return this.check;
  }
  async launch(spec: RunSpec): Promise<AgentHandle> {
    this.launched = true;
    return new CheckHandle();
  }
}

function driverWith(adapter: AgentAdapter) {
  return createDriver({ adapters: { [adapter.name]: adapter }, stateDir: mkdtempSync(join(tmpdir(), 'harness-prof-')) });
}

describe('driver profile validation enforcement', () => {
  it('fails the run before launch when the adapter reports errors', async () => {
    const adapter = new ProfileAdapter({ ok: false, errors: [{ field: 'kiro.effort', message: 'invalid' }], warnings: [] });
    const driver = driverWith(adapter);
    await assert.rejects(
      driver.run('mock', { prompt: 'hi' }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /profile validation failed/);
        assert.match(err.message, /kiro\.effort: invalid/);
        return true;
      },
    );
    assert.equal(adapter.launched, false);
  });

  it('drains profile warnings into run warnings and still runs', async () => {
    const adapter = new ProfileAdapter({ ok: true, errors: [], warnings: [{ field: 'kiro.mcpServers', message: 'ACP-only' }] });
    const result = await driverWith(adapter).run('mock', { prompt: 'hi' });
    assert.equal(result.exitStatus, 'success');
    assert.ok(result.warnings.some((w) => w.includes('kiro.mcpServers') && w.includes('ACP-only')), result.warnings.join('; '));
  });

  it('adapters without validateProfile (no-op default) are untouched', async () => {
    const plain = new (class implements AgentAdapter {
      readonly name = 'plain';
      async launch(): Promise<AgentHandle> {
        return new CheckHandle();
      }
    })();
    const result = await driverWith(plain).run('plain', { prompt: 'hi' });
    assert.equal(result.exitStatus, 'success');
  });
});

describe('bundled adapters own their profile validation', () => {
  it('defaultAdapters forwards validateProfile for every bundled agent', async () => {
    const adapters = await defaultAdapters();
    for (const name of ['claude', 'opencode', 'kiro', 'codex', 'gemini']) {
      const adapter = adapters[name];
      assert.ok(adapter, `${name} registered`);
      assert.equal(typeof adapter.validateProfile, 'function', `${name} exposes validateProfile`);
      const ok = adapter.validateProfile?.({ prompt: 'hi', resume: SESSION, model: 'some-model' });
      assert.equal(ok?.ok, true, `${name} accepts a clean spec`);
    }
  });

  it('the kiro bundled adapter rejects a bad kiro config through the driver', async () => {
    const adapters = await defaultAdapters();
    const driver = createDriver({ adapters, stateDir: mkdtempSync(join(tmpdir(), 'harness-prof-')) });
    await assert.rejects(
      driver.run('kiro', { prompt: 'hi', kiro: { transport: 'acp', mcpServers: [{ name: 'a', command: 'x' }, { name: 'a', command: 'x' }] } }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /profile validation failed/);
        assert.match(err.message, /duplicate MCP server name 'a'/);
        return true;
      },
    );
  });
});
