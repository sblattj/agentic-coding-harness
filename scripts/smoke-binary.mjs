// Exercise the distributed executable, with no checkout or assets in its cwd.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { once } from 'node:events';

const binary = resolve(process.argv[2]);
const dir = mkdtempSync(join(tmpdir(), 'ach-binary-smoke-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTIC_CODING_HARNESS_')));
env.HOME = dir;
env.AGENTIC_CODING_HARNESS_STATE_DIR = join(dir, 'state');
const options = { cwd: dir, env, encoding: 'utf8', timeout: 30_000 };
let server;
try {
  const version = spawnSync(binary, ['--version'], options);
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);
  if (process.env.EXPECTED_VERSION) assert.equal(version.stdout.trim(), process.env.EXPECTED_VERSION);
  const help = spawnSync(binary, ['help'], options);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /usage:/);
  // Required for release CI; older source snapshots may run the asset regression alone.
  if (process.argv.includes('--doctor')) {
    const doctor = spawnSync(binary, ['doctor', '--agent', 'null', '--json'], options);
    assert.equal(doctor.status, 0, doctor.stderr + doctor.stdout);
    const report = JSON.parse(doctor.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.promptsSent, 0);
    assert.ok(report.checks.length > 0);
    assert.ok(report.checks.some(check => check.agent === 'null'));
    assert.ok(report.checks.every(check => check.status !== 'fail'));
    console.log('doctor:', doctor.stdout.trim());
  }
  const stats = spawnSync(binary, ['stats', '--json', '--state-only'], options);
  assert.equal(stats.status, 0, stats.stderr);
  assert.equal(JSON.parse(stats.stdout).total.records, 0);
  server = spawn(binary, ['web', '--port', '0', '--dir', env.AGENTIC_CODING_HARNESS_STATE_DIR, '--no-open'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  server.stderr.on('data', chunk => { output += chunk; });
  server.stdout.resume();
  server.on('error', error => { output += error.message; });
  let base;
  for (let i = 0; i < 200; i++) {
    base = output.match(/web dashboard: (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    if (base || server.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(base, `web failed to start: ${output}`);
  for (const [route, marker] of [
    ['/', /<!doctype html/i], ['/grid', /<!doctype html/i],
    ['/compare', /<!doctype html/i], ['/trio', /<!doctype html/i],
    ['/term-pane.html', /createTermPane/], ['/feed.js', /function/],
    ['/vendor/xterm/xterm.js', /Terminal/], ['/vendor/xterm/xterm.css', /\.xterm/],
    ['/vendor/xterm/addon-fit.js', /FitAddon/], ['/vendor/xterm/addon-web-links.js', /WebLinksAddon/],
    ['/vendor/xterm/addon-webgl.js', /WebglAddon/], ['/vendor/xterm/LICENSE', /MIT/],
  ]) {
    const response = await fetch(base + route, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200, route);
    assert.match(await response.text(), marker, route);
    console.log(`200 ${route}`);
  }
  assert.equal((await fetch(base + '/missing-asset')).status, 404);
  console.log(`Standalone ${version.stdout.trim()} smoke passed`);
} finally {
  if (server && server.exitCode === null) {
    const exited = once(server, 'exit');
    server.kill('SIGTERM');
    const timer = setTimeout(() => server.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(timer);
  }
  rmSync(dir, { recursive: true, force: true });
}
