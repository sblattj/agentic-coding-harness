// Run-to-directory artifacts (agentic-coding-harness#6): one output
// directory per run, holding the complete durable record of that run.
//
// Files written when RunSpec.outputDir is set (or via the runToDirectory()
// helper, src/core/run-to-directory.ts):
//   invocation.json — resolved command/args/cwd/startedAt, written at open
//   status.json     — lifecycle file, ALWAYS left in a terminal state
//   events.jsonl    — one canonical AgentEvent per line (streamed), hash-
//                     chained and closed by an `ach.seal` record (#59,
//                     src/core/hash-chain.ts); stripChain() recovers the event
//   stdout.txt      — raw agent stdout chunks exactly as received
//   stderr.txt      — harness-observed stderr (progress event lines)
//   result.json     — the final RunResult object
//
// status.json is written atomically (tmp+rename, like the run registry) and
// is persisted on EVERY exit path — natural end, watchdog timeout, idle
// timeout, abort, and any throw out of the run lifecycle. Lifecycle:
// running -> success | error | timeout | idle-timeout | aborted | unavailable. Artifact
// failures never break the run itself (registry precedent): the driver
// drains them into RunResult.warnings.

import { createWriteStream, renameSync, writeFileSync, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ChainWriter, type RunSeal, type SealTotals } from './hash-chain.ts';
import type { AgentEvent, ExitStatus, RunResult } from './types.ts';

/** Lifecycle states of status.json: 'running' until exactly one terminal state. */
export type RunDirStatus = 'running' | 'success' | 'error' | 'timeout' | 'idle-timeout' | 'aborted' | 'unavailable';

/** The status.json shape (required fields per #6 plus observed exit evidence). */
export interface RunStatusFile {
  runId: string;
  status: RunDirStatus;
  updatedAt: number;
  eventCount: number;
  /** RunResult.exitStatus of the settled run (absent while running). */
  exitStatus?: ExitStatus;
  /** Adapter session id once known. */
  sessionId?: string;
  /** Terminal seal of events.jsonl's hash chain (#59); the verify-run anchor. */
  seal?: RunSeal;
}

/** The invocation.json shape: what was launched, where, and when. */
export interface RunInvocation {
  runId: string;
  /** Resolved command in the driver sense: the agent (adapter) name. */
  command: string;
  args: string[];
  cwd: string;
  /** ms epoch. */
  startedAt: number;
  prompt: string;
  model?: string;
}

/** Atomic JSON write: <file>.tmp-<pid> then rename (registry.ts pattern). */
export function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

/**
 * Map a run's final ExitStatus onto the #6 terminal lifecycle states.
 * budgetTripKind distinguishes the driver's two timeout verdicts: an idle
 * trip reports 'idle-timeout', a wall-clock trip (or an adapter-reported
 * timeout) reports 'timeout'. cancelled/budget_exceeded/turn_limit are
 * purposeful cut-short exits, so they land on 'aborted' (same rule the run
 * registry applies).
 */
export function exitStatusToRunStatus(exitStatus: ExitStatus, budgetTripKind: 'wall' | 'idle' | null): RunDirStatus {
  switch (exitStatus) {
    case 'success':
      return 'success';
    case 'error':
      return 'error';
    case 'timeout':
      return budgetTripKind === 'idle' ? 'idle-timeout' : 'timeout';
    case 'unavailable':
      // CLI/service outage (#60): its own terminal state, never 'aborted'.
      return 'unavailable';
    default:
      return 'aborted';
  }
}

function endStream(stream: WriteStream | null): Promise<void> {
  if (stream === null) return Promise.resolve();
  return new Promise<void>((resolve) => stream.end(() => resolve()));
}

/**
 * Writer for one run's output directory. open() creates the directory and
 * the initial invocation/status files; event()/stdoutChunk() stream the
 * live artifacts; finish() closes the streams, writes result.json, and
 * leaves status.json in its terminal state. status.json is heartbeated
 * (throttled to >= 500ms, registry style) while events flow so a hard
 * process crash still leaves an honest 'running' file with the observed
 * eventCount — no reader can mistake it for a settled run.
 */
export class RunArtifacts {
  readonly dir: string;
  readonly #runId: string;
  #status: RunDirStatus = 'running';
  #eventCount = 0;
  #sessionId: string | undefined;
  #exitStatus: ExitStatus | undefined;
  #lastStatusWrite = 0;
  #stdout: WriteStream | null = null;
  #stderr: WriteStream | null = null;
  #events: WriteStream | null = null;
  readonly #chain: ChainWriter;
  #seal: RunSeal | undefined;

  private constructor(dir: string, runId: string) {
    this.dir = dir;
    this.#runId = runId;
    this.#chain = new ChainWriter(runId);
  }

  static async open(dir: string, invocation: RunInvocation): Promise<RunArtifacts> {
    await mkdir(dir, { recursive: true });
    const artifacts = new RunArtifacts(dir, invocation.runId);
    writeJsonAtomic(join(dir, 'invocation.json'), invocation);
    artifacts.#writeStatus(true);
    artifacts.#stdout = createWriteStream(join(dir, 'stdout.txt'), { flags: 'a' });
    artifacts.#stderr = createWriteStream(join(dir, 'stderr.txt'), { flags: 'a' });
    artifacts.#events = createWriteStream(join(dir, 'events.jsonl'), { flags: 'a' });
    return artifacts;
  }

  /** Raw stdout chunk, exactly as received (chunk boundaries preserved). */
  stdoutChunk(chunk: string): void {
    this.#stdout?.write(chunk);
  }

  /**
   * One canonical event: appended to events.jsonl, counted, and mined for
   * the stderr mirror — every `progress` event is a harness-observed stderr
   * line (runJsonlCli forwards child stderr there), so stderr.txt stays a
   * faithful line-per-line record of what the agent wrote to stderr.
   */
  event(event: AgentEvent): void {
    if (this.#seal !== undefined) return; // chain closed: nothing may follow the seal
    this.#events?.write(`${this.#chain.frame(JSON.stringify(event))}\n`);
    this.#eventCount++;
    if (event.type === 'progress' && typeof event.text === 'string' && event.text !== '') {
      this.#stderr?.write(`${event.text}\n`);
    }
    if (typeof event.sessionId === 'string' && event.sessionId) this.#sessionId = event.sessionId;
    this.#writeStatus(false);
  }

  /**
   * Close events.jsonl's hash chain with the terminal seal record (#59). The
   * driver calls this with the same `at` and totals it seals the raw
   * transcript with, so both logs end in the identical seal line. Idempotent.
   */
  seal(at: number, totals: SealTotals | null): RunSeal | undefined {
    const sealed = this.#chain.seal(at, totals);
    if (sealed !== null) {
      this.#events?.write(`${sealed.line}\n`);
      this.#seal = sealed.seal;
    }
    return this.#seal;
  }

  /**
   * Terminal settle: seal the chain (totals null when the driver did not seal
   * it first — a launch failure or crash), flush the streams, persist result.json (when the run
   * produced one), then write the terminal status.json LAST so a terminal
   * status implies every other artifact is already on disk.
   */
  async finish(status: RunDirStatus, result?: RunResult): Promise<void> {
    this.#status = status;
    if (result !== undefined && typeof result.sessionId === 'string' && result.sessionId) {
      this.#sessionId = result.sessionId;
    }
    this.seal(Date.now(), null);
    await Promise.all([endStream(this.#events), endStream(this.#stdout), endStream(this.#stderr)]);
    if (result !== undefined) {
      writeJsonAtomic(join(this.dir, 'result.json'), result);
    }
    // A launch-time outage (#60) settles with no RunResult; its exitStatus is
    // still known, so status.json carries it.
    this.#exitStatus = result?.exitStatus ?? (status === 'unavailable' ? 'unavailable' : undefined);
    this.#writeStatus(true);
  }

  #writeStatus(force: boolean): void {
    const now = Date.now();
    if (!force && now - this.#lastStatusWrite < 500) return;
    this.#lastStatusWrite = now;
    const file: RunStatusFile = {
      runId: this.#runId,
      status: this.#status,
      updatedAt: now,
      eventCount: this.#eventCount,
      ...(this.#exitStatus !== undefined ? { exitStatus: this.#exitStatus } : {}),
      ...(this.#sessionId !== undefined ? { sessionId: this.#sessionId } : {}),
      ...(this.#seal !== undefined ? { seal: this.#seal } : {}),
    };
    writeJsonAtomic(join(this.dir, 'status.json'), file);
  }
}
