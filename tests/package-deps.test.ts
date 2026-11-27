// Package shape (#236, #249): dist/cli/ach.js and dist/index.js are self-contained
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

// The bundles are minified (#249), so these match `;import{a as b}from"x"` and
// `import"x"` as well as formatted imports: static, side-effect, dynamic, require().
const IMPORT_RE =
  /(?<=(?:^|[;}\n])\s*)import\s*(?:[\w$]+\s*,?\s*)?(?:\*\s*as\s+[\w$]+|\{[^{}"'`]*\})?\s*from\s*["']([^"']+)["']|(?<=(?:^|[;}\n])\s*)import\s*["']([^"']+)["']|(?<![.\w$"'`])import\(\s*["']([^"']+)["']\s*\)|(?<![.\w$])require\(\s*["']([^"']+)["']\s*\)/g;

/** Bare specifiers a bundle still loads at runtime. Skips require() text inside string literals (code-gen) and member calls like JXA's `ObjC.import(...)`. */
function bareImports(code: string): string[] {
  const out = new Set<string>();
  for (const m of code.matchAll(IMPORT_RE)) {
    if (m[4] && /[`'"]/.test(code[m.index! + m[0].indexOf('require') - 1] ?? '')) continue;
    const spec = m[1] ?? m[2] ?? m[3] ?? m[4]!;
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

  it('the import scan catches minified and formatted bare imports', () => {
    const sample = [
      'var a=1;import{Tracer as b}from"@scope/pkg";',
      'import"side-effect-pkg";',
      "import * as z from 'zod';",
      'let m=await import("lazy-pkg");',
      'const r=require("cjs-pkg");',
      'ObjC.import("Foundation");import{x}from"./chunk.js";',
      'case"import":return 1;let s=`ach import: agent`;let q="ach import";let w="would import x from \'y\'";',
    ].join('\n');
    assert.deepEqual(bareImports(sample), ['@scope/pkg', 'side-effect-pkg', 'zod', 'lazy-pkg', 'cjs-pkg']);
  });

  it('both bundles are minified, and build:node does not also copy the web assets the bundle embeds', () => {
    assert.match(pkg.scripts['build:node']!, /bun build src\/cli\/ach\.ts [^&]*--minify/);
    assert.match(pkg.scripts['build:lib']!, /bun build src\/index\.ts [^&]*--minify/);
    // src/web/server.ts inlines every dashboard page and vendor/xterm file as a text import,
    // so copying them next to the bundle shipped each one twice.
    assert.doesNotMatch(pkg.scripts['build:node']!, /src\/web\/|vendor/);
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
