// Read-only native transcript projection beside the harness registry.
import type { RunRecord } from '../core/registry.ts';
import { transcriptView } from '../cli/transcript-view.ts';
import type { ScanOptions } from '../monitors/transcripts.ts';
import { FsRunSource, type RunSource } from './run-source.ts';
export class TranscriptRunSource implements RunSource {
  private readonly registry: FsRunSource;
  private rows: RunRecord[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private stopped = true;
  constructor(private readonly dir: string, private readonly scan: ScanOptions = {}) { this.registry = new FsRunSource(dir); }
  snapshot(): RunRecord[] {
    const runs = this.registry.snapshot();
    const sessions = new Set(runs.filter((r) => r.sessionId).map((r) => `${r.agent}\0${r.sessionId}`));
    return [...runs, ...this.rows.filter((r) => !sessions.has(`${r.agent}\0${r.sessionId}`))];
  }
  async start(onChange: (records: RunRecord[]) => void): Promise<void> {
    this.stopped = false;
    await this.registry.start(() => onChange(this.snapshot()));
    const refresh = async (): Promise<void> => {
      if (this.busy || this.stopped) return;
      this.busy = true;
      try {
        const rows = await transcriptView(this.dir, this.registry.snapshot(), this.scan);
        if (!this.stopped) { this.rows = rows; onChange(this.snapshot()); }
      } finally { this.busy = false; }
    };
    await refresh();
    this.timer = setInterval(() => void refresh().catch(() => {}), 30_000);
    this.timer.unref();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.registry.stop();
  }
}
