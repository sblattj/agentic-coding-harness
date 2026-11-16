// Read-only native transcript projection beside the harness registry.
//
// #202: the projection is a per-file index (TranscriptIndex). start() parses
// the files touched within `recentMs` first (the page `ach web` shows) and
// resolves, then backfills older files in the background, yielding to the
// event loop, so "load older", /api/stats and /api/compare become complete
// without blocking the first page. Every 30s refresh re-reads only files
// whose mtime/size changed, and the per-file rows persist in
// <stateDir>/cache/transcript-index.json, so a restart re-reads only what
// changed since the last save.
import { join } from 'node:path';
import type { RunRecord } from '../core/registry.ts';
import { TranscriptIndex, type TranscriptIndexProgress } from '../cli/transcript-view.ts';
import type { ScanOptions } from '../monitors/transcripts.ts';
import { FsRunSource, type RunSource } from './run-source.ts';

export interface TranscriptSourceOptions {
  /** Parse files modified within this many ms first; undefined = one full pass before start() resolves. */
  recentMs?: number;
  /** Refresh cadence; default 30s. */
  refreshMs?: number;
}

export class TranscriptRunSource implements RunSource {
  private readonly registry: FsRunSource;
  private readonly index: TranscriptIndex;
  private rows: RunRecord[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private busy: Promise<void> | null = null;
  private stopped = true;
  private savedComplete = false;
  constructor(private readonly dir: string, scan: ScanOptions = {}, private readonly opts: TranscriptSourceOptions = {}) {
    this.registry = new FsRunSource(dir);
    // #202: per-file rows persist across restarts (mtime/size keyed).
    this.index = new TranscriptIndex(dir, scan, join(dir, 'cache', 'transcript-index.json'));
  }
  snapshot(): RunRecord[] {
    const runs = this.registry.snapshot();
    const sessions = new Set(runs.filter((r) => r.sessionId).map((r) => `${r.agent}\0${r.sessionId}`));
    return [...runs, ...this.rows.filter((r) => !sessions.has(`${r.agent}\0${r.sessionId}`))];
  }
  /** How far the transcript backfill has got (surfaced on /api/runs, /api/stats, /health). */
  progress(): TranscriptIndexProgress {
    return this.index.progress();
  }
  async start(onChange: (records: RunRecord[]) => void): Promise<void> {
    this.stopped = false;
    await this.registry.start(() => onChange(this.snapshot()));
    const publish = async (): Promise<void> => {
      const rows = await this.index.rows(this.registry.snapshot());
      if (!this.stopped) { this.rows = rows; onChange(this.snapshot()); }
    };
    // One pass at a time; a tick that finds a pass running skips.
    const pass = (update: Parameters<TranscriptIndex['update']>[0]): Promise<void> => {
      if (this.busy !== null || this.stopped) return this.busy ?? Promise.resolve();
      this.busy = (async () => {
        try {
          await this.index.update({ ...update, shouldStop: () => this.stopped });
          await publish();
          // Persist after the first full pass, then at most every 5 minutes.
          await this.index.save(this.index.progress().complete && !this.savedComplete ? 0 : 300_000);
          if (this.index.progress().complete) this.savedComplete = true;
        } finally { this.busy = null; }
      })();
      return this.busy;
    };
    const recentMs = this.opts.recentMs;
    if (recentMs === undefined) {
      await pass({});
    } else {
      await pass({ minMtimeMs: Date.now() - recentMs });
      // Backfill everything older without holding up start().
      void pass({ yieldEvery: 20 }).catch(() => {});
    }
    this.timer = setInterval(() => void pass({ yieldEvery: 20 }).catch(() => {}), this.opts.refreshMs ?? 30_000);
    this.timer.unref();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.busy?.catch(() => {});
    await this.index.save();
    await this.registry.stop();
  }
}
