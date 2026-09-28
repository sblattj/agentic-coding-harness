// RunSource: the seam between the run hub and wherever run records come
// from. The hub only knows this interface; the default implementation
// (FsRunSource) is the historical state-dir behavior lifted verbatim out
// of hub.ts — snapshot via listRunRecords plus a debounced fs.watch on
// <stateDir>/runs, with periodic reconciliation for missed notifications. Future sources (HTTP poll, merged union — spec §5.3)
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
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly stateDir: string) {}

  start(onChange: (records: RunRecord[]) => void): Promise<void> {
    // start/stop are synchronous internally, including on a repeated start.
    void this.stop();
    const dir = registryDir(this.stateDir);
    const directoryStamp = () => {
      try {
        const stat = fs.statSync(dir, { bigint: true });
        return `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`;
      } catch { return "missing"; }
    };
    // Registry writes are tmp+rename (registry.ts writeRunRecord), so both
    // new records and replacements change directory metadata. Read the stamp
    // before the snapshot: a concurrent rename then triggers the next poll.
    let previousStamp = directoryStamp();
    let previous = JSON.stringify(this.snapshot());
    const reconcile = (force = false) => {
      const stamp = directoryStamp();
      if (!force && stamp === previousStamp) return;
      const records = this.snapshot();
      previousStamp = stamp;
      const next = JSON.stringify(records);
      if (next === previous) return;
      previous = next;
      onChange(records);
    };
    // fs.watch is a latency optimization, not the only delivery mechanism:
    // platforms can coalesce or lose notifications, including during startup.
    // Independent reconciliation also prevents continuous writes from starving
    // a trailing debounce. Compare content so unchanged polls never publish.
    this.reconcileTimer = setInterval(() => reconcile(), 500);
    this.reconcileTimer.unref();
    try {
      fs.mkdirSync(dir, { recursive: true });
      const watcher = fs.watch(dir, () => {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = null;
          reconcile(true);
        }, 250);
      });
      this.watcher = watcher;
      watcher.on("error", () => {
        watcher.close();
        if (this.watcher === watcher) this.watcher = null;
      });
    } catch {
      this.watcher = null; // reconciliation still observes readable snapshots
    }
    return Promise.resolve();
  }

  snapshot(): RunRecord[] {
    return listRunRecords(this.stateDir);
  }

  stop(): Promise<void> {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
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
