// Bun-only probe for tests/interactive-run.test.ts: does a LivePty built from
// the real bun-pty factory keep output the child wrote before LivePty
// subscribed?
//
// bun-pty starts reading the PTY in a microtask queued by spawn(), and fires
// each chunk only to the onData listeners present at that moment. `launch()`
// awaits the async factory before `new LivePty(term)` subscribes, so a run
// process that stalls between spawn() and that first read (a loaded CI
// machine) reads the child's first bytes with nobody listening. The stall
// here is a microtask queued before the factory call: it runs after spawn()
// returns and before bun-pty's first read, like a descheduled process.
import { LivePty, loadBunPty } from '../../src/interactive/live-pty.ts';

const STALL_MS = Number(process.argv[2] ?? 600);
const factory = await loadBunPty();
queueMicrotask(() => {
  const until = Date.now() + STALL_MS;
  while (Date.now() < until) {
    /* the run process is not scheduled */
  }
});
const termP = factory({ command: 'sh', args: ['-c', 'printf EARLY-OUTPUT; sleep 1; printf LATE-OUTPUT'], cwd: process.cwd(), env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, cols: 80, rows: 24 });
const live = new LivePty(await termP, { cols: 80, rows: 24 });
const code = await live.exited;
process.stdout.write(`EARLY_PROBE ${JSON.stringify({ scrollback: live.scrollback(), code })}\n`);
process.exit(0);
