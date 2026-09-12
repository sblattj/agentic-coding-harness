import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import type { SpawnFn } from '../../src/adapters/shared.ts';

/**
 * Scriptable child-process double: replays recorded NDJSON through real
 * PassThrough streams so adapters exercise their genuine chunking/buffering
 * path, records argv/env/cwd and kill signals, and emits 'close' on demand.
 */
export class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  /** Signals received, in order. */
  signals: string[] = [];
  closed = false;
  stdinEnded = false;

  constructor() {
    super();
    this.stdin.end = (() => {
      this.stdinEnded = true;
    }) as typeof this.stdin.end;
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    this.signals.push(String(signal));
    return true;
  }

  /** Write raw bytes (may contain partial lines — exercises buffering). */
  writeStdout(chunk: string): void {
    this.stdout.write(chunk);
  }

  writeStderr(chunk: string): void {
    this.stderr.write(chunk);
  }

  /** Flush stream buffers and emit the terminal close event. */
  close(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    process.nextTick(() => this.emit('close', code, signal));
  }
}

export interface FakeSpawnCall {
  command: string;
  args: string[];
  opts: { cwd?: string | URL; env?: NodeJS.ProcessEnv; stdio?: unknown };
}

/** SpawnFn that records each invocation and returns the supplied FakeChild. */
export function fakeSpawnFn(child: FakeChild, calls: FakeSpawnCall[] = []): SpawnFn {
  return (command, args, opts) => {
    calls.push({ command, args, opts });
    queueMicrotask(() => child.emit('spawn'));
    return child as unknown as ChildProcess;
  };
}

/**
 * SpawnFn for adapters that make a cached `--version` probe before the run
 * (KiroAdapter): the probe gets its OWN throwaway child that immediately
 * prints `version` and exits 0, and every other spawn gets `child`. Both
 * invocations are recorded in `calls`; use `runCall()` to select the real run.
 *
 * A plain `fakeSpawnFn` cannot be used here: it hands the SAME FakeChild to
 * the probe and the run, so the probe consumes the run's stdout and then waits
 * forever on a 'close' the already-closed child will never emit again.
 */
export function versionProbeSpawnFn(
  child: FakeChild,
  calls: FakeSpawnCall[] = [],
  version = 'kiro-cli 2.21.2\n',
): SpawnFn {
  return (command, args, opts) => {
    calls.push({ command, args, opts });
    if (args[0] === '--version') {
      const probe = new FakeChild();
      queueMicrotask(() => {
        probe.writeStdout(version);
        probe.close(0);
      });
      return probe as unknown as ChildProcess;
    }
    queueMicrotask(() => child.emit('spawn'));
    return child as unknown as ChildProcess;
  };
}

/** The recorded spawn that is NOT the `--version` probe. */
export function runCall(calls: FakeSpawnCall[]): FakeSpawnCall {
  const found = calls.filter((c) => c.args[0] !== '--version');
  if (found.length !== 1) {
    throw new Error(`expected exactly one non-version spawn, got ${JSON.stringify(calls.map((c) => c.args[0]))}`);
  }
  return found[0]!;
}

/** Split a string into two halves at an index inside the first line. */
export function splitMidFirstLine(text: string): [string, string] {
  const firstNewline = text.indexOf('\n');
  const cut = Math.max(1, Math.floor(firstNewline / 2));
  return [text.slice(0, cut), text.slice(cut)];
}
