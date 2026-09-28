// The PyPI wrapper (python/) ships its own version fields and a vendored
// ach.mjs bundle; both drifted for several releases (pyproject 0.10.1,
// __version__ 0.7.4, bundle from 0.7.4 while npm was at 0.11.0). These
// assertions pin every copy to package.json so a release can't ship one
// without the others. Rebuild the bundle with `npm run build:python`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(root + rel, "utf8");
const pkgVersion = (JSON.parse(read("package.json")) as { version: string }).version;

test("python/pyproject.toml version matches package.json", () => {
  const m = read("python/pyproject.toml").match(/^version = "([^"]+)"/m);
  assert.equal(m?.[1], pkgVersion);
});

test("agentic_coding_harness.__version__ matches package.json", () => {
  const m = read("python/src/agentic_coding_harness/__init__.py").match(/^__version__ = "([^"]+)"/m);
  assert.equal(m?.[1], pkgVersion);
});

test("src/version.ts bundled fallback matches package.json", () => {
  const m = read("src/version.ts").match(/return "([^"]+)";/);
  assert.equal(m?.[1], pkgVersion);
});

test("vendored python bundle reports the package.json version", () => {
  const bundle = root + "python/src/agentic_coding_harness/_vendor/ach.mjs";
  const r = spawnSync(process.execPath, [bundle, "--version"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`\\b${pkgVersion.replace(/\./g, "\\.")}\\b`), "rebuild with `npm run build:python`");
});
