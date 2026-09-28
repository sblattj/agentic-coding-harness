// Download and verify the exact registry tarball before updating the tap formula.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const version = process.argv[2];
assert.match(version ?? '', /^\d+\.\d+\.\d+$/);
const registry = `https://registry.npmjs.org/agentic-coding-harness/${version}`;
let metadata;
for (let attempt = 0; attempt < 30; attempt++) {
  const response = await fetch(registry, { signal: AbortSignal.timeout(30_000) });
  if (response.ok) { metadata = await response.json(); break; }
  if (response.status !== 404) throw new Error(`Registry returned ${response.status}`);
  await new Promise(resolve => setTimeout(resolve, 10_000));
}
assert.equal(metadata?.version, version, `npm version ${version} is not published`);
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
