import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { createPricer } from '../src/core/pricing.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

it('distributed CLI and library retain authoritative prices and context windows', { timeout: 120_000 }, (t) => {
  if (spawnSync('bun', ['--version'], { encoding: 'utf8' }).status !== 0) {
    t.skip('bun compiler not on PATH; source pricing tests still run');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'ach-bundled-pricing-'));
  const env = { ...process.env, HOME: dir, AGENTIC_CODING_HARNESS_STATE_DIR: dir };
  const run = (command: string, args: string[]) => {
    const result = spawnSync(command, args, { cwd: dir, env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  const runJson = (command: string, args: string[]) => {
    const out = run(command, args);
    try {
      return JSON.parse(out);
    } catch (err) {
      throw new Error(`${command} ${args.join(' ')}: stdout is not JSON (${String(err)}): ${JSON.stringify(out.slice(0, 400))}`);
    }
  };
  try {
    const cli = join(root, 'src/cli/ach.ts');
    const nodeCli = join(dir, 'cli.mjs');
    const bunCli = join(dir, 'cli-bun.mjs');
    const standalone = join(dir, 'ach');
    const library = join(dir, 'library.mjs');
    for (const [entry, output, target, compile] of [
      [cli, nodeCli, 'node', false], [cli, bunCli, 'bun', false],
      [cli, standalone, 'bun', true], [join(root, 'src/index.ts'), library, 'node', false],
    ] as const) {
      run('bun', ['build', entry, '--target', target, '--external', 'bun-pty', '--outfile', output, ...(compile ? ['--compile'] : [])]);
    }
    mkdirSync(join(dir, 'raw/claude'), { recursive: true });
    const commands = [[process.execPath, nodeCli], ['bun', bunCli], [standalone]];
    for (const model of ['claude-3-haiku', 'claude-sonnet-4-5']) {
      const record = { agent: 'claude', model, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      const expected = createPricer().price(record);
      assert.ok(Number.isFinite(expected) && expected > 0);
      writeFileSync(join(dir, 'raw/claude/model.jsonl'), JSON.stringify({ ...record, ts: new Date().toISOString(), sessionId: 'parity' }) + '\n');
      for (const [command, ...prefix] of commands) {
        const result = runJson(command, [...prefix, 'stats', '--state-only', '--json', '--cost-mode', 'calculate']);
        assert.equal(result.total.costUsd, expected, `${command}: ${model} differs from source`);
      }
    }
    for (const [command, ...prefix] of commands) {
      const report = runJson(command, [...prefix, 'doctor', '--agent', 'null', '--json']);
      const pricing = report.checks.find((check: { name: string }) => check.name === 'pricing');
      assert.equal(pricing.status, 'verified');
      assert.match(pricing.detail, /bundled LiteLLM extract/);
      assert.doesNotMatch(pricing.detail, /absent|fallback only/);
    }
    const fixture = readFileSync(join(root, 'src/adapters/fixtures/claude-ndjson-sample.ndjson'), 'utf8');
    // Import the actual published library entry, then replay a real adapter fixture
    // through its public driver API. No direct imports of internal bundled helpers.
    const consumer = join(dir, 'consumer.mjs');
    writeFileSync(consumer, `
      import { createDriver, ClaudeCodeAdapter } from './library.mjs';
      import { EventEmitter } from 'node:events';
      import { PassThrough } from 'node:stream';
      class Child extends EventEmitter {
        stdout = new PassThrough(); stderr = new PassThrough(); stdin = null; pid = 424242;
        kill() { queueMicrotask(() => this.emit('close', 143, null)); return true; }
      }
      const adapter = new ClaudeCodeAdapter({ stateDir: process.cwd(), spawnFn: () => {
        const child = new Child();
        queueMicrotask(() => { child.stdout.end(${JSON.stringify(fixture)}); child.stderr.end(); child.emit('close', 0, null); });
        return child;
      }});
      const result = await createDriver({ adapters: { claude: adapter }, stateDir: process.cwd() }).run('claude', { prompt: 'fixture' });
      console.log(JSON.stringify(result.usage.context));
    `);
    const context = runJson(process.execPath, [consumer]);
    assert.equal(context.available, true);
    assert.equal(context.windowTokens, 200_000);
    assert.equal(context.tokens, 4 + 84 + 14_629);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
