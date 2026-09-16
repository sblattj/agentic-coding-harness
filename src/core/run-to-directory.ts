// runToDirectory helper (agentic-coding-harness#6): one-call entry for the
// run-to-directory mode. The driver itself implements the mode whenever a
// RunSpec carries outputDir (src/core/run-artifacts.ts); this helper adds a
// default driver on top so a watchdog only needs agent + spec + outputDir.

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDriver, defaultAdapters, type Driver } from './driver.ts';
import type { RunResult, RunSpec } from './types.ts';

export interface RunToDirectoryOptions {
  /** Driver to run through; built from defaultAdapters() when omitted. */
  driver?: Driver;
  /** Agent (adapter) name, e.g. 'claude', 'codex', 'kiro'. */
  agent: string;
  /** Run spec; outputDir is forced to the option below either way. */
  spec: RunSpec;
  /** Directory the run's artifacts + durable status.json are written to. */
  outputDir: string;
}

/** What runToDirectory() resolves with: the result plus artifact paths. */
export interface RunToDirectoryOutcome {
  result: RunResult;
  outputDir: string;
  paths: {
    invocation: string;
    status: string;
    events: string;
    stdout: string;
    stderr: string;
    result: string;
  };
}

/**
 * Run one agent with the run-to-directory mode (#6): all artifacts land in
 * outputDir and status.json is guaranteed to reach a terminal state —
 * success | error | timeout | idle-timeout | aborted — even when the run is
 * cut short by the watchdog (timeoutMs / idleTimeoutMs) or driver.abort().
 * The promise rejects only when the underlying run rejects (unknown agent,
 * malformed spec, crash); status.json then holds status "error".
 */
export async function runToDirectory(options: RunToDirectoryOptions): Promise<RunToDirectoryOutcome> {
  const { agent, spec, outputDir } = options;
  const driver = options.driver ?? createDriver({ adapters: await defaultAdapters(), stateDir: await mkdtemp(join(tmpdir(), 'ach-run-')) });
  const result = await driver.run(agent, { ...spec, outputDir });
  return {
    result,
    outputDir,
    paths: {
      invocation: join(outputDir, 'invocation.json'),
      status: join(outputDir, 'status.json'),
      events: join(outputDir, 'events.jsonl'),
      stdout: join(outputDir, 'stdout.txt'),
      stderr: join(outputDir, 'stderr.txt'),
      result: join(outputDir, 'result.json'),
    },
  };
}
