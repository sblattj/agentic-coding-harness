// Download and verify the exact registry tarball before updating the tap formula.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const version = process.argv[2];
assert.match(version ?? '', /^\d+\.\d+\.\d+$/);
const registry = `https://registry.npmjs.org/agentic-coding-harness/${version}`;
// npm can hold a just-published version for ~8+ minutes before serving it
// (v0.15.1 took 8). Wait up to NPM_WAIT_MINUTES (default 45) before failing.
const waitMinutes = Number(process.env.NPM_WAIT_MINUTES ?? 45);
assert.ok(Number.isFinite(waitMinutes) && waitMinutes >= 0, 'NPM_WAIT_MINUTES must be a non-negative number');
const pollMs = Number(process.env.NPM_POLL_SECONDS ?? 30) * 1000;
const deadline = Date.now() + waitMinutes * 60_000;
let metadata;
for (;;) {
  const response = await fetch(registry, { signal: AbortSignal.timeout(30_000) });
  if (response.ok) { metadata = await response.json(); break; }
  if (response.status !== 404) throw new Error(`Registry returned ${response.status}`);
  if (Date.now() + pollMs > deadline) break;
  console.log(`npm ${version} not visible yet; retrying in ${pollMs / 1000}s`);
  await new Promise(resolve => setTimeout(resolve, pollMs));
}
assert.equal(metadata?.version, version, `npm version ${version} is not published after ${waitMinutes} min`);
const expectedUrl = `https://registry.npmjs.org/agentic-coding-harness/-/agentic-coding-harness-${version}.tgz`;
assert.equal(metadata.dist.tarball, expectedUrl);
const response = await fetch(expectedUrl, { signal: AbortSignal.timeout(30_000) });
assert.ok(response.ok, `Tarball returned ${response.status}`);
const tarball = Buffer.from(await response.arrayBuffer());
assert.equal(createHash('sha1').update(tarball).digest('hex'), metadata.dist.shasum);
const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
assert.equal(integrity, metadata.dist.integrity, 'Registry integrity mismatch');
const sha256 = createHash('sha256').update(tarball).digest('hex');
const path = new URL('../Formula/ach.rb', import.meta.url);
let formula = readFileSync(path, 'utf8');
assert.equal((formula.match(/^  url /gm) ?? []).length, 1);
assert.equal((formula.match(/^  sha256 /gm) ?? []).length, 1);
formula = formula.replace(/^  url .*$/m, `  url "${expectedUrl}"`)
  .replace(/^  sha256 .*$/m, `  sha256 "${sha256}"`);
writeFileSync(path, formula);
console.log(`Homebrew ${version}: ${sha256}`);
