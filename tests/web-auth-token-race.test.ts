// An empty/short token file is replaced atomically; every starter ends with the file's token.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { loadOrCreateWebToken, webTokenPath } from '../src/web/auth.ts';

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('loadOrCreateWebToken with an invalid token file', () => {
  for (const seed of ['', 'short\n']) {
    it(`two loads over ${JSON.stringify(seed)} both return the file's content (0600, no temp left)`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ach-web-token-race-'));
      dirs.push(dir);
      const file = webTokenPath(dir);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, seed, { mode: 0o600 });
      const seedIno = statSync(file).ino;
      const [a, b] = await Promise.all([
        Promise.resolve().then(() => loadOrCreateWebToken(dir)),
        Promise.resolve().then(() => loadOrCreateWebToken(dir)),
      ]);
      const content = readFileSync(file, 'utf8').trim();
      assert.equal(b.token, content);
      assert.equal(a.token, content);
      assert.equal(statSync(file).mode & 0o777, 0o600);
      // Replaced by rename, never truncated in place (an in-place truncate is what let racers diverge).
      assert.notEqual(statSync(file).ino, seedIno);
      assert.deepEqual(readdirSync(dirname(file)), ['token']);
    });
  }
  it('six processes starting at once over an empty file all end with the token the file holds', async () => {
    const auth = new URL('../src/web/auth.ts', import.meta.url).pathname;
    const bun = Boolean((process.versions as { bun?: string }).bun);
    const code = `import { loadOrCreateWebToken } from ${JSON.stringify(auth)}; process.stdout.write(loadOrCreateWebToken(process.argv.at(-1)).token);`;
    const run = (dir: string): Promise<string> =>
      new Promise((resolve, reject) => {
        const args = bun ? ['-e', code, dir] : ['--import', 'tsx', '--input-type=module', '-e', code, dir];
        const c = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        c.stdout.on('data', (b) => (out += b));
        c.stderr.on('data', (b) => (err += b));
        c.on('error', reject);
        c.on('close', (rc) => (rc === 0 ? resolve(out) : reject(new Error(`loader exited ${rc}: ${err}`))));
      });
    for (let round = 0; round < 8; round++) {
      const dir = mkdtempSync(join(tmpdir(), 'ach-web-token-race-'));
      dirs.push(dir);
      const file = webTokenPath(dir);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, '', { mode: 0o600 });
      const tokens = await Promise.all(Array.from({ length: 6 }, () => run(dir)));
      const content = readFileSync(file, 'utf8').trim();
      assert.ok(content.length >= 16, `round ${round}: file holds no valid token`);
      assert.deepEqual(tokens, tokens.map(() => content), `round ${round}: a starter kept a token the file does not hold`);
      assert.deepEqual(readdirSync(dirname(file)), ['token'], `round ${round}: temp or aside file left behind`);
    }
  });

  it('a replace lock left by a crashed starter is taken over once stale', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ach-web-token-race-'));
    dirs.push(dir);
    const file = webTokenPath(dir);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '', { mode: 0o600 });
    mkdirSync(`${file}.lock`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${file}.lock`, old, old);
    const r = loadOrCreateWebToken(dir);
    assert.equal(r.token, readFileSync(file, 'utf8').trim());
    assert.ok(r.token.length >= 16);
    assert.deepEqual(readdirSync(dirname(file)), ['token']);
  });

  it('a loader holding a stale token is impossible: sequential loads agree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ach-web-token-race-'));
    dirs.push(dir);
    const file = webTokenPath(dir);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '', { mode: 0o600 });
    const first = loadOrCreateWebToken(dir);
    assert.equal(loadOrCreateWebToken(dir).token, first.token);
  });
});
