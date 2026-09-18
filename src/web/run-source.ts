// RunSource: the seam between the run hub and wherever run records come
// from. The hub only knows this interface; the default implementation
// (FsRunSource) is the historical state-dir behavior lifted verbatim out
// of hub.ts — snapshot via listRunRecords plus a debounced fs.watch on
// <stateDir>/runs. Future sources (HTTP poll, merged union — spec §5.3)
// implement the same contract.
import fs from "node:fs";
import { type RunRecord, listRunRecords, registryDir } from "../core/registry.ts";

export interface SourceHealth {
  healthy: boolean;
  detail?: string;
}

export interface RunSource {
  start(onChange: (records: RunRecord[]) => void): Promise<void>;
  snapshot(): RunRecord[];
  stop(): Promise<void>;
  health?(): SourceHealth;
}

/** Filesystem-backed source: reads and watches <stateDir>/runs/. */
export class FsRunSource implements RunSource {
  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly stateDir: string) {}

  start(onChange: (records: RunRecord[]) => void): Promise<void> {
    // On failure behave like the old hub.watchRegistry: no throw, start
    // resolves, and there is simply no watcher (a later start retries).
    try {
      const dir = registryDir(this.stateDir);
      fs.mkdirSync(dir, { recursive: true });
      this.watcher = fs.watch(dir, () => {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = null;
          onChange(this.snapshot());
        }, 250);
      });
    } catch {
      this.watcher = null;
    }
    return Promise.resolve();
  }

  snapshot(): RunRecord[] {
    return listRunRecords(this.stateDir);
  }

  stop(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    return Promise.resolve();
  }

  health(): SourceHealth {
    return { healthy: true };
  }
}
