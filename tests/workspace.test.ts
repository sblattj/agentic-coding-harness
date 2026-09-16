// Workspace confinement (agentic-coding-harness#9): the realpath-based
// utility rejects `..` and symlink escapes, and the driver enforces it on
// caller-supplied spec paths before launch.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import {
  WorkspaceEscapeError,
  assertInsideWorkspace,
  canonicalPath,
  isInsideWorkspace,
} from '../src/core/workspace.js';
import { createDriver } from '../src/core/driver.js';
import type { AgentAdapter, AgentEvent, AgentHandle, RunSpec } from '../src/core/types.js';

/** Workspace fixture: root dir plus a sibling "outside" dir and symlinks. */
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'harness-ws-'));
  const root = join(base, 'ws');
  const outside = join(base, 'outside');
  mkdirSync(join(root, 'sub'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  // Symlink INSIDE root pointing OUT of the workspace.
  symlinkSync(outside, join(root, 'escape-link'));
  // Symlink inside root pointing deeper inside the workspace.
  symlinkSync(join(root, 'sub'), join(root, 'inner-link'));
  // A path into the root itself through an outside symlink.
  symlinkSync(root, join(base, 'ws-link'));
  return { base, root, outside };
}

describe('workspace confinement utility', () => {
  it('accepts legitimate in-workspace paths (direct, nested, internal ..)', () => {
    const { root } = fixture();
    assert.equal(assertInsideWorkspace(root, root), canonicalPath(root));
    assert.ok(isInsideWorkspace(root, join(root, 'sub')));
    assert.ok(isInsideWorkspace(root, join(root, 'sub', '..', 'sub'))); // .. collapses back inside
    assert.ok(isInsideWorkspace(root, join(root, 'not', 'yet', 'created'))); // missing tail is fine
  });

  it('rejects .. escapes', () => {
    const { root, outside } = fixture();
    assert.throws(() => assertInsideWorkspace(root, join(root, '..', 'outside')), WorkspaceEscapeError);
    assert.throws(() => assertInsideWorkspace(root, join(root, 'sub', '..', '..', 'outside')), WorkspaceEscapeError);
    assert.equal(isInsideWorkspace(root, join(root, '..', 'outside')), false);
    void outside;
  });

  it('rejects symlink escapes (the symlink itself and paths through it)', () => {
    const { root } = fixture();
    assert.throws(() => assertInsideWorkspace(root, join(root, 'escape-link')), WorkspaceEscapeError);
    assert.throws(() => assertInsideWorkspace(root, join(root, 'escape-link', 'file.txt')), WorkspaceEscapeError);
    // A not-yet-existing path THROUGH the escaping symlink still resolves out.
    assert.throws(() => assertInsideWorkspace(root, join(root, 'escape-link', 'new', 'dir')), WorkspaceEscapeError);
  });

  it('accepts symlinks that stay inside the workspace', () => {
    const { root } = fixture();
    assert.ok(isInsideWorkspace(root, join(root, 'inner-link')));
    assert.ok(isInsideWorkspace(root, join(root, 'inner-link', 'file.txt')));
  });

  it('admits a root given through a symlink, and sibling-prefix roots do not over-admit', () => {
    const { base, root } = fixture();
    // root referenced via symlink: real children still contained.
    const rootLink = join(base, 'ws-link');
    assert.ok(isInsideWorkspace(rootLink, join(root, 'sub', 'deeper')));
    // /x/ws-root must not admit /x/ws-root-evil (separator-boundary check).
    const evil = `${root}-evil`;
    assert.equal(isInsideWorkspace(root, evil), false);
  });

  it('rejects ../ escapes lexically even when nothing exists on the path', () => {
    const { root } = fixture();
    assert.throws(() => assertInsideWorkspace(root, join(root, 'ghost', '..', '..', 'elsewhere')), WorkspaceEscapeError);
  });

  it('error message names the label, candidate, and both resolved paths', () => {
    const { root } = fixture();
    assert.throws(
      () => assertInsideWorkspace(root, join(root, 'escape-link'), { label: 'spec.cwd' }),
      (err: unknown) => {
        assert.ok(err instanceof WorkspaceEscapeError);
        assert.equal(err.code, 'WORKSPACE_ESCAPE');
        assert.match(err.message, /spec\.cwd/);
        assert.match(err.message, /escape-link/);
        assert.match(err.message, /outside the workspace root/);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Driver wiring
// ---------------------------------------------------------------------------

class OkHandle implements AgentHandle {
  readonly sessionId = 'ws-test-session';
  constructor(readonly spec: RunSpec) {}
  async *attach(): AsyncIterable<AgentEvent> {
    yield { type: 'step', sessionId: this.sessionId, timestamp: Date.now() };
  }
  abort(): void {}
  async wait(): Promise<'success'> {
    return 'success';
  }
}

class RecordingAdapter implements AgentAdapter {
  readonly name = 'mock';
  lastSpec?: RunSpec;
  async launch(spec: RunSpec): Promise<AgentHandle> {
    this.lastSpec = spec;
    return new OkHandle(spec);
  }
}

function confineDriver(root: string, adapter = new RecordingAdapter()) {
  return { adapter, driver: createDriver({ adapters: { mock: adapter }, stateDir: mkdtempSync(join(tmpdir(), 'harness-wsdrv-')), confineToWorkspace: true, workspaceRoot: root }) };
}

describe('driver workspace confinement', () => {
  it('rejects spec.cwd escaping via .. before launch', async () => {
    const { root } = fixture();
    const { adapter, driver } = confineDriver(root);
    await assert.rejects(
      driver.run('mock', { prompt: 'hi', cwd: join(root, '..', 'outside') }),
      (err: unknown) => {
        assert.ok(err instanceof WorkspaceEscapeError);
        assert.match(err.message, /spec\.cwd/);
        return true;
      },
    );
    assert.equal(adapter.lastSpec, undefined, 'adapter.launch was never called');
  });

  it('rejects spec.cwd escaping via a symlink', async () => {
    const { root } = fixture();
    const { adapter, driver } = confineDriver(root);
    await assert.rejects(driver.run('mock', { prompt: 'hi', cwd: join(root, 'escape-link') }), WorkspaceEscapeError);
    assert.equal(adapter.lastSpec, undefined);
  });

  it('rejects spec.stateDir escaping', async () => {
    const { root, outside } = fixture();
    const { driver } = confineDriver(root);
    await assert.rejects(driver.run('mock', { prompt: 'hi', stateDir: outside }), WorkspaceEscapeError);
  });

  it('accepts legitimate in-workspace cwd and launches', async () => {
    const { root } = fixture();
    const { adapter, driver } = confineDriver(root);
    const result = await driver.run('mock', { prompt: 'hi', cwd: join(root, 'sub') });
    assert.equal(result.exitStatus, 'success');
    assert.equal(adapter.lastSpec?.cwd, join(root, 'sub'));
  });

  it('does not confine when the option is off', async () => {
    const { root, outside } = fixture();
    const adapter = new RecordingAdapter();
    const driver = createDriver({ adapters: { mock: adapter }, stateDir: mkdtempSync(join(tmpdir(), 'harness-wsdrv-')), workspaceRoot: root });
    const result = await driver.run('mock', { prompt: 'hi', cwd: outside });
    assert.equal(result.exitStatus, 'success');
    assert.equal(adapter.lastSpec?.cwd, outside);
  });
});
