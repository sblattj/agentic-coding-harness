// Package shape (#236): dist/cli/ach.js and dist/index.js are self-contained
// node bundles, so the libraries they inline must not also be runtime
// dependencies (every install would download them twice), and the unused
// --target bun copy of the CLI (dist/bun/) is not built or shipped.
//
// The bundle check rebuilds both entries with the exact `bun build` commands
// from package.json into a temp dir, then lists every bare import left in the
// output: only node builtins and the runtime dependencies may remain.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
  files: string[];
};
const RUNTIME_DEPS = Object.keys(pkg.dependencies ?? {});
const hasBun = spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0;

/** Bare specifiers a bundle still loads at runtime. Skips require() text inside string literals (code-gen) and member calls like JXA's `ObjC.import(...)`. */
function bareImports(code: string): string[] {
  const out = new Set<string>();
  const re = /(?:^|\n)\s*import\s[^;]*?from\s*["']([^"']+)["']|(?<![.\w$])import\(\s*["']([^"']+)["']\s*\)|(?<![.\w$])require\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of code.matchAll(re)) {
    if (m[3] && /[`'"]/.test(code[m.index! + m[0].indexOf('require') - 1] ?? '')) continue;
    const spec = m[1] ?? m[2] ?? m[3]!;
    if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:') || spec.startsWith('bun:')) continue;
    out.add(spec);
  }
  return [...out];
}

const isBuiltin = (spec: string) => builtinModules.includes(spec) || builtinModules.includes(spec.split('/')[0]!);
const pkgName = (spec: string) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!);

describe('package dependencies and dist shape (#236)', () => {
  it('runtime dependencies are only what the bundles leave external (bun-pty)', () => {
    assert.deepEqual(RUNTIME_DEPS, ['bun-pty']);
  });

  it('no --target bun copy of the CLI is built', () => {
    assert.equal(pkg.scripts['build:bun'], undefined);
    assert.doesNotMatch(pkg.scripts.build!, /build:bun|dist\/bun/);
    assert.match(pkg.scripts['build:node']!, /rm -rf dist\/cli dist\/bun /, 'build:node clears a stale dist/bun from older builds');
  });

  const tmp = mkdtempSync(path.join(tmpdir(), 'ach-pkg-deps-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));

  for (const [script, entry] of [['build:node', 'src/cli/ach.ts'], ['build:lib', 'src/index.ts']] as const) {
    it(`${script} output loads only node builtins and runtime dependencies`, { skip: hasBun ? false : 'bun not on PATH' }, () => {
      const cmd = pkg.scripts[script]!.split('&&').map((s) => s.trim()).find((s) => s.startsWith(`bun build ${entry}`));
      assert.ok(cmd, `${script} has a 'bun build ${entry}' step`);
      const outfile = path.join(tmp, `${script.replace(':', '-')}.js`);
      const args = cmd
        .replace(/^bun build /, '')
        .replace(/--banner\s+"[^"]*"/, '')
        .replace(/--outdir\s+\S+|--outfile\s+\S+/, `--outfile ${outfile}`)
        .split(/\s+/)
        .filter(Boolean);
      const r = spawnSync('bun', ['build', ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
      assert.equal(r.status, 0, r.stderr);
      const leftover = bareImports(readFileSync(outfile, 'utf8')).filter((s) => !isBuiltin(s) && !RUNTIME_DEPS.includes(pkgName(s)));
      assert.deepEqual(leftover, [], `${entry} bundle still imports packages that are not runtime dependencies`);
    });
  }
});
