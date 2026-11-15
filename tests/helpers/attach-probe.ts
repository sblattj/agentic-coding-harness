// `ach attach` probe for tests/interactive-run.test.ts (#195).
//
// `ach attach` needs a terminal, so this bun script hosts it in a bun-pty
// PTY, types into it, presses the Ctrl-] d detach chord and prints one
// `PROBE_RESULT <json>` line. argv: [cliPath, runIdPrefix]; the parent passes
// the state-dir env through.
import { spawn } from 'bun-pty';

const [cli = '', prefix = ''] = process.argv.slice(2);
const STEP_MS = 15_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(step: string, cond: () => boolean): Promise<void> {
  const deadline = Date.now() + STEP_MS;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(50);
  }
  throw new Error(`${step}: not met within ${STEP_MS}ms; output so far: ${JSON.stringify(out.slice(-600))}`);
}

let out = '';
let exitCode: number | null = null;
const heartbeat = setInterval(() => {}, 1000);
const term = spawn(process.execPath, [cli, 'attach', prefix], {
  name: 'xterm-256color',
  cols: 100,
  rows: 30,
  cwd: process.cwd(),
  env: process.env as Record<string, string>,
});
term.onData((d: string) => {
  out += d;
});
term.onExit((e: { exitCode: number }) => {
  exitCode = e.exitCode;
});

try {
  await waitFor('banner replayed from scrollback', () => out.includes('FAKE CLAUDE TUI'));
  term.write('from-attach');
  await sleep(150);
  term.write('\r');
  await waitFor('typed prompt answered by the run', () => out.includes('echo: from-attach'));
  term.write('\x1dd');
  await waitFor('attach exits after the detach chord', () => exitCode !== null);
  process.stdout.write(
    `PROBE_RESULT ${JSON.stringify({ sawBanner: true, sawEcho: true, exitCode, detachedMsg: /detached from/.test(out) })}\n`,
  );
  clearInterval(heartbeat);
  process.exit(0);
} catch (err) {
  process.stdout.write(`PROBE_FAIL ${err instanceof Error ? err.message : String(err)}\n`);
  try {
    term.kill();
  } catch {
    /* gone */
  }
  clearInterval(heartbeat);
  process.exit(1);
}
