// PtyManager probe for tests/web-pty.test.ts.
//
// PtyManager.spawn() constructs PTYs through bun-pty, which only works under
// Bun; the tsx/node test runner (`npm test`) therefore spawns this file as a
// bun subprocess. The probe drives a full manager scenario and prints one
// final `PROBE_RESULT <json>` line whose fields the parent test asserts on.
// Any thrown error or step timeout prints `PROBE_FAIL ...` and exits 1.
//
// Every wait is a polling waitFor() backed by a timer, and a heartbeat
// interval runs for the probe's whole life: awaiting a bare exit-event
// promise leaves Bun's event loop empty for a moment, and Bun then exits
// the process silently (code 0) before the event fires.
import { PtyManager } from '../../src/web/pty-manager.ts';

const STEP_TIMEOUT_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(step: string, cond: () => boolean, timeoutMs = STEP_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(50);
  }
  throw new Error(`${step}: condition not met within ${timeoutMs}ms`);
}

async function main(): Promise<void> {
  const beat = setInterval(() => {}, 250); // keep the Bun event loop alive
  const mgr = new PtyManager();
  const r: Record<string, unknown> = {};

  // -- session lifecycle: spawn → data → write → scrollback → kill/exit ----
  const info = await mgr.spawn({
    command: 'bash',
    args: ['-lc', 'echo READY; read x; echo GOT:$x; read y'],
    id: 'probe-1',
    cols: 100,
    rows: 30,
    cwd: process.cwd(),
  });
  r.spawnInfoOk =
    info.id === 'probe-1' &&
    info.command === 'bash' &&
    Array.isArray(info.args) &&
    typeof info.pid === 'number' &&
    info.pid > 0 &&
    info.alive === true &&
    info.cols === 100 &&
    info.rows === 30;

  const live: string[] = [];
  const unsub = mgr.onData('probe-1', (d) => live.push(d));
  await waitFor('READY in scrollback', () => mgr.scrollback('probe-1').includes('READY'));
  await waitFor('echo of keystroke via onData callback', () => live.join('').length > 0);

  r.writeOk = mgr.write('probe-1', 'world\n');
  await waitFor('GOT:world in scrollback', () => mgr.scrollback('probe-1').includes('GOT:world'));
  await waitFor('GOT:world via onData callback', () => live.join('').includes('GOT:world'));
  unsub();
  r.scrollbackHasGot = mgr.scrollback('probe-1').includes('GOT:');
  r.getAlive = mgr.get('probe-1')?.alive === true;

  // resize guards against non-positive / non-integer dims on a live session
  r.resizeZeroColsFalse = mgr.resize('probe-1', 0, 24) === false;
  r.resizeZeroRowsFalse = mgr.resize('probe-1', 80, 0) === false;
  r.resizeFracColsFalse = mgr.resize('probe-1', 80.5, 24) === false;
  r.resizeOk = mgr.resize('probe-1', 120, 40) === true;
  const resized = mgr.get('probe-1');
  r.resizeUpdatesInfo = resized?.cols === 120 && resized?.rows === 40;

  // kill → exit event (bun-pty reports exitCode 0 for kill), then guards
  let exitCode: number | null = null;
  mgr.onExit('probe-1', (c) => {
    exitCode = c;
  });
  r.killTrue = mgr.kill('probe-1') === true;
  await waitFor('exit event after kill', () => exitCode !== null);
  r.exitCodeOnKill = exitCode;
  r.killAgainFalse = mgr.kill('probe-1') === false;
  await waitFor('alive flips false', () => mgr.get('probe-1')?.alive === false);
  r.writeAfterExitFalse = mgr.write('probe-1', 'x') === false;
  const dead = mgr.get('probe-1');
  r.deadInfoOk = dead?.alive === false && dead?.exitCode === exitCode;
  r.scrollbackSurvivesExit = mgr.scrollback('probe-1').includes('GOT:world');

  // unknown-id guards
  r.writeUnknownFalse = mgr.write('no-such', 'x') === false;
  r.killUnknownFalse = mgr.kill('no-such') === false;
  r.getUnknownNull = mgr.get('no-such') === null;
  r.resizeUnknownFalse = mgr.resize('no-such', 80, 24) === false;
  r.scrollbackUnknownEmpty = mgr.scrollback('no-such') === '';

  // -- scrollback ring cap: 400 KB of output through a 200 KB buffer -------
  const capId = 'probe-cap';
  let capExitCode: number | null = null;
  await mgr.spawn({
    command: 'bash',
    args: ['-lc', "head -c 400000 /dev/zero | tr '\\0' 'A'; echo; echo CAPEND"],
    id: capId,
  });
  mgr.onExit(capId, (c) => {
    capExitCode = c;
  });
  await waitFor('cap session exits', () => capExitCode !== null);
  await sleep(200); // let the final onData chunks land
  const capLen = mgr.scrollback(capId).length;
  r.scrollbackCapLen = capLen;
  r.scrollbackCapOk = capLen > 150_000 && capLen <= 200 * 1024 && mgr.scrollback(capId).includes('CAPEND');

  // list() filters dead sessions unless told otherwise
  r.listAliveOnlyEmpty = mgr.list().length === 0 && mgr.list().every((s) => s.alive);
  r.listIncludeDead = mgr.list(true).map((s) => s.id).sort().join(',') === 'probe-1,probe-cap';

  // -- dispose kills remaining sessions ------------------------------------
  let disposeExitCode: number | null = null;
  await mgr.spawn({ command: 'bash', args: ['-lc', 'read x'], id: 'probe-sleep' });
  mgr.onExit('probe-sleep', (c) => {
    disposeExitCode = c;
  });
  mgr.dispose();
  let disposeKilled = false;
  try {
    await waitFor('dispose kills remaining session', () => disposeExitCode !== null, 5_000);
    disposeKilled = true;
  } catch {
    disposeKilled = false;
  }
  r.disposeKills = disposeKilled;

  clearInterval(beat);
  await new Promise<void>((resolve) => {
    process.stdout.write(`PROBE_RESULT ${JSON.stringify(r)}\n`, () => resolve());
  });
}

main().catch((err: unknown) => {
  const msg = `PROBE_FAIL ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`;
  process.stdout.write(`${msg}\n`, () => process.exit(1));
});
