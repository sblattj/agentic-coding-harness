import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  composePrompt,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  type ComposePromptResult,
} from '../src/core/attachments.js';
import { createDriver } from '../src/core/driver.js';
import type { AgentAdapter, AgentHandle, RunSpec } from '../src/core/types.js';

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'harness-attachments-'));
}

describe('composePrompt', () => {
  it('appends each file with delimiters, path, and correct sha256', async () => {
    const dir = tmpDir();
    const a = join(dir, 'a.txt');
    const b = join(dir, 'b.log');
    writeFileSync(a, 'alpha contents\n');
    writeFileSync(b, 'beta contents without newline');
    const { prompt, manifest } = await composePrompt('do the thing', [a, b]);

    assert.ok(prompt.startsWith('do the thing\n\n'), 'base prompt preserved at the head');
    assert.ok(prompt.includes(`-----BEGIN ATTACHED FILE: ${a} (sha256=${sha256('alpha contents\n')}, bytes=15)-----`), 'file A header');
    assert.ok(prompt.includes('alpha contents\n-----END ATTACHED FILE'), 'file A body then END on its own line');
    assert.ok(prompt.includes(`sha256=${sha256('beta contents without newline')}`), 'file B header');
    assert.ok(prompt.endsWith(`-----END ATTACHED FILE: ${b}-----`), 'file B END delimiter closes the prompt');
    // Hashes in the manifest match an independent crypto computation.
    assert.equal(manifest.files[0]?.sha256, sha256('alpha contents\n'));
    assert.equal(manifest.files[1]?.sha256, sha256('beta contents without newline'));
  });

  it('returns a manifest of {path, sha256, bytes}, promptSha256, and totalBytes', async () => {
    const dir = tmpDir();
    const a = join(dir, 'a.txt');
    const b = join(dir, 'b.txt');
    const bodyA = 'x'.repeat(100);
    const bodyB = 'y'.repeat(50);
    writeFileSync(a, bodyA);
    writeFileSync(b, bodyB);
    const { prompt, manifest }: ComposePromptResult = await composePrompt('p', [a, b]);

    assert.deepEqual(
      manifest.files.map((f) => Object.keys(f).sort()),
      [['bytes', 'path', 'sha256'], ['bytes', 'path', 'sha256']],
    );
    assert.deepEqual(
      manifest.files.map((f) => f.path),
      [a, b],
    );
    assert.deepEqual(
      manifest.files.map((f) => f.bytes),
      [100, 50],
    );
    assert.equal(manifest.totalBytes, 150);
    assert.equal(manifest.promptSha256, sha256(prompt));
  });

  it('with no files returns the prompt unchanged and hashes it', async () => {
    const { prompt, manifest } = await composePrompt('just me', []);
    assert.equal(prompt, 'just me');
    assert.deepEqual(manifest.files, []);
    assert.equal(manifest.totalBytes, 0);
    assert.equal(manifest.promptSha256, sha256('just me'));
  });

  it('enforces a custom total byte cap with a clear error naming the offending file', async () => {
    const dir = tmpDir();
    const a = join(dir, 'small.txt');
    const b = join(dir, 'big.txt');
    writeFileSync(a, '12345'); // 5 bytes, fits under 10 alone
    writeFileSync(b, '1234567890'); // pushes total to 15 > 10
    await assert.rejects(
      composePrompt('p', [a, b], { maxTotalBytes: 10 }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as { code?: string }).code, 'PROMPT_ATTACHMENT_CAP');
        assert.match(err.message, /15 bytes exceeds the 10-byte cap/);
        assert.match(err.message, new RegExp(b.replaceAll('/', '\\/')));
        return true;
      },
    );
  });

  it('enforces the default 1 MiB cap', async () => {
    assert.equal(DEFAULT_MAX_ATTACHMENT_BYTES, 1024 * 1024);
    const dir = tmpDir();
    const big = join(dir, 'big.bin');
    writeFileSync(big, Buffer.alloc(DEFAULT_MAX_ATTACHMENT_BYTES + 1, 7));
    await assert.rejects(
      composePrompt('p', [big]),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as { code?: string }).code, 'PROMPT_ATTACHMENT_CAP');
        assert.match(err.message, /exceeds the 1048576-byte cap/);
        return true;
      },
    );
    // At exactly the cap it passes.
    const exact = join(dir, 'exact.bin');
    writeFileSync(exact, Buffer.alloc(DEFAULT_MAX_ATTACHMENT_BYTES, 7));
    const { manifest } = await composePrompt('p', [exact]);
    assert.equal(manifest.totalBytes, DEFAULT_MAX_ATTACHMENT_BYTES);
  });

  it('wraps unreadable/missing files in a PROMPT_ATTACHMENT_READ error naming the path', async () => {
    await assert.rejects(
      composePrompt('p', ['/nonexistent/definitely-missing-file.txt']),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as { code?: string }).code, 'PROMPT_ATTACHMENT_READ');
        assert.match(err.message, /failed to read "\/nonexistent\/definitely-missing-file\.txt"/);
        return true;
      },
    );
  });

  it('resolves relative paths against opts.cwd and records the caller-given path', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'rel.txt'), 'relative body');
    const { manifest, prompt } = await composePrompt('p', ['rel.txt'], { cwd: dir });
    assert.deepEqual(
      manifest.files.map((f) => f.path),
      ['rel.txt'],
    );
    assert.equal(manifest.files[0]?.sha256, sha256('relative body'));
    assert.ok(prompt.includes('ATTACHED FILE: rel.txt'));
  });
});

describe('driver attachment wiring (#12)', () => {
  class CapturingAdapter implements AgentAdapter {
    readonly name = 'capture';
    lastSpec?: RunSpec;

    async launch(spec: RunSpec): Promise<AgentHandle> {
      this.lastSpec = spec;
      const events: Spec[] = [];
      return {
        sessionId: 'sess-attach',
        async *attach() {
          for (const e of events) yield e as never;
        },
        abort: () => {},
        wait: async () => 'success' as const,
      };
    }
  }
  type Spec = { type: 'step'; sessionId: string; timestamp: number };

  it('launches with the composed prompt, strips attachment keys, and echoes the manifest', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'notes.md'), '# notes\nbody');
    const adapter = new CapturingAdapter();
    const driver = createDriver({ adapters: { capture: adapter }, stateDir: tmpDir() });

    const result = await driver.run('capture', {
      prompt: 'review the notes',
      attachments: [join(dir, 'notes.md')],
      attachmentsMaxBytes: 1024,
    });

    const spec = adapter.lastSpec!;
    assert.ok(spec.prompt.startsWith('review the notes\n\n-----BEGIN ATTACHED FILE:'), 'adapter got composed prompt');
    assert.ok(spec.prompt.includes('# notes\nbody'));
    assert.equal(spec.attachments, undefined, 'attachments key stripped before launch');
    assert.equal(spec.attachmentsMaxBytes, undefined, 'attachmentsMaxBytes key stripped before launch');

    assert.ok(result.attachments, 'manifest echoed on RunResult');
    assert.deepEqual(
      result.attachments!.files.map((f) => f.path),
      [join(dir, 'notes.md')],
    );
    assert.equal(result.attachments!.files[0]?.sha256, sha256('# notes\nbody'));
    assert.equal(result.attachments!.totalBytes, '# notes\nbody'.length);
    assert.equal(result.attachments!.promptSha256, sha256(spec.prompt));
  });

  it('rejects a run whose attachments exceed the cap before launching anything', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'big.txt'), 'x'.repeat(100));
    const adapter = new CapturingAdapter();
    const driver = createDriver({ adapters: { capture: adapter }, stateDir: tmpDir() });

    await assert.rejects(
      driver.run('capture', { prompt: 'p', attachments: [join(dir, 'big.txt')], attachmentsMaxBytes: 10 }),
      (err: unknown) => {
        assert.equal((err as { code?: string }).code, 'PROMPT_ATTACHMENT_CAP');
        return true;
      },
    );
    assert.equal(adapter.lastSpec, undefined, 'no launch happened');
  });
});
