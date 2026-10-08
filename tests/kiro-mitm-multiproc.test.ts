// #114: two SEPARATE `ach` processes starting a kiro MITM tap at the same
// moment must each end up with their own working tap on distinct ports. A
// per-process lock cannot do that; the fake mitmdump below behaves like the
// real one (binds the requested port, `-p 0` = kernel-chosen, banner reports
// the REAL bound port, bind failure exits) but delays its bind so that any
// probe-then-bind scheme has both processes picking the same "free" port.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE_MITMDUMP = `#!/usr/bin/env node
const net = require('node:net');
const argv = process.argv.slice(2);
const port = Number(argv[argv.indexOf('-p') + 1]);
const srv = net.createServer((s) => s.destroy());
srv.on('error', (e) => {
  console.error('Error: [Errno 48] ' + (e.code === 'EADDRINUSE' ? 'Address already in use' : e.message));
  process.exit(1);
});
setTimeout(() => {
  srv.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
    console.log('[00:00:00.000] HTTP(S) proxy listening at 127.0.0.1:' + srv.address().port + '.');
  });
}, 400);
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`;

const FAKE_KIRO = `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'kiro-cli 2.21.2'; exit 0; fi
if [ -n "$FAKE_KIRO_ENV_FILE" ]; then env > "$FAKE_KIRO_ENV_FILE"; fi
echo '{"type":"session_start","sessionId":"sess-mp-1"}'
echo '{"type":"assistant","text":"done"}'
exit 0
`;

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'kiro-mp-'));
  for (const [name, body] of [['fake-mitmdump.js', FAKE_MITMDUMP], ['fake-kiro.sh', FAKE_KIRO]] as const) {
    writeFileSync(join(dir, name), body, { mode: 0o755 });
    chmodSync(join(dir, name), 0o755);
  }
});

after(() => rmSync(dir, { recursive: true, force: true }));

interface ChildResult {
  proxy: string | null;
  stderr: string;
}

function runChild(startAt: number, tag: string): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import', 'tsx',
        join(dirname(fileURLToPath(import.meta.url)), 'helpers/kiro-tap-child.ts'),
        String(startAt),
        join(dir, 'fake-mitmdump.js'),
        join(dir, 'fake-kiro.sh'),
        join(dir, `${tag}.env`),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        resolve(JSON.parse(out.trim().split('\n').pop() ?? '') as ChildResult);
      } catch {
        reject(new Error(`child ${tag} exited ${code} without a result: ${out} ${err}`));
      }
    });
  });
}

describe('kiro MITM tap across processes (#114)', () => {
  it('two simultaneous processes each get their own tap on distinct ports', { timeout: 60_000 }, async () => {
    const startAt = Date.now() + 4000; // both children finish booting tsx first
    const [a, b] = await Promise.all([runChild(startAt, 'a'), runChild(startAt, 'b')]);
    assert.doesNotMatch(a.stderr + b.stderr, /MITM tap skipped/, `a=${a.stderr} b=${b.stderr}`);
    assert.ok(a.proxy && b.proxy, `both runs must be tapped: a=${a.proxy} b=${b.proxy}`);
    assert.notEqual(a.proxy, b.proxy, 'two processes shared one tap port');
  });
});
