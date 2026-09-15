// Library-entry contract (agentic-coding-harness#5):
//   1. the npm package must expose a library entry (src/index.ts ->
//      dist/index.js via package.json "exports") exporting the programmatic
//      API, and
//   2. importing EITHER that entry or the CLI module (src/cli/ach.ts ->
//      dist/cli/ach.js, the legacy consumer import path) must have NO CLI
//      side effects: no usage output, no process.exit.
// The side-effect checks run in a real child process under the same loader
// production uses, because an in-process import that printed-and-exited
// would kill the test runner itself.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

const REQUIRED_EXPORTS = [
  'createDriver',
  'defaultAdapters',
  'ClaudeCodeAdapter',
  'KiroAdapter',
  'CodexAdapter',
] as const;

describe('library entry (src/index.ts)', () => {
  it('exports the programmatic API: createDriver, defaultAdapters, adapter classes', async () => {
    const mod = await import('../src/index.ts');
    for (const name of REQUIRED_EXPORTS) {
      assert.equal(typeof mod[name], 'function', `${name} must be a function export`);
    }
    assert.equal(typeof (mod as { VERSION?: unknown }).VERSION, 'string');
    assert.equal(typeof mod.GeminiAdapter, 'function');
    assert.equal(typeof mod.OpenCodeAdapter, 'function');
  });
});

// Runs `node --import tsx -e <script>`: import the target module URL and
// verify exports WITHOUT printing anything; the parent then asserts the
// child produced no stdout/stderr and exited 0.
function importInChild(moduleUrl: string): { code: number; stdout: string; stderr: string } {
  const script = `
    import(${JSON.stringify(moduleUrl)}).then((mod) => {
      const need = ${JSON.stringify([...REQUIRED_EXPORTS])};
      const missing = need.filter((n) => typeof mod[n] !== 'function');
      if (missing.length) throw new Error('missing exports: ' + missing.join(','));
      if (typeof mod.VERSION !== 'string') throw new Error('missing VERSION');
    }).then(
      () => { /* print NOTHING on success */ },
      (err) => { process.stderr.write(String(err)); process.exitCode = 1; },
    );
  `;
  const p = spawnSync(process.execPath, ['--import', 'tsx', '--eval', script], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { code: p.status ?? -1, stdout: p.stdout ?? '', stderr: p.stderr ?? '' };
}

describe('importing the CLI module has no CLI side effects', () => {
  it('src/cli/ach.ts imports as a library: exports present, no usage printed, exit 0', () => {
    const out = importInChild(new URL('../src/cli/ach.ts', import.meta.url).href);
    assert.equal(out.code, 0, `child exited ${out.code}\nstdout: ${out.stdout}\nstderr: ${out.stderr}`);
    assert.equal(out.stdout, '', 'no stdout from a library import');
    assert.ok(!out.stderr.includes('usage:'), `CLI usage leaked into the import: ${out.stderr}`);
    assert.equal(out.stderr, '', `no stderr from a library import: ${out.stderr}`);
  });

  it('src/index.ts imports clean as well', () => {
    const out = importInChild(new URL('../src/index.ts', import.meta.url).href);
    assert.equal(out.code, 0, `child exited ${out.code}\nstderr: ${out.stderr}`);
    assert.equal(out.stdout, '');
    assert.equal(out.stderr, '');
  });
});
