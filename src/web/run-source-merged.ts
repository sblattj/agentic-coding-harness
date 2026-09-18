// MergedRunSource (spec §5.3): the union of several run sources — e.g.
// the local state dir plus one or more external HTTP feeds. Snapshots
// merge in constructor order, so a runId seen by several sources resolves
// to the LAST source that carries it (later = more authoritative, the
// external feed over the local registry). Health is the AND of the
// children; children without a health() implementation count as healthy.
import type { RunRecord } from "../core/registry.ts";
import { type RunSource, type SourceHealth } from "./run-source.ts";

export class MergedRunSource implements RunSource {
  constructor(private readonly sources: RunSource[]) {}

  snapshot(): RunRecord[] {
    const merged = new Map<string, RunRecord>();
    for (const source of this.sources) {
      for (const rec of source.snapshot()) merged.set(rec.runId, rec);
    }
    return [...merged.values()];
  }

  start(onChange: (records: RunRecord[]) => void): Promise<void> {
    return Promise.all(this.sources.map((s) => s.start(() => onChange(this.snapshot())))).then(
      () => undefined,
    );
  }

  stop(): Promise<void> {
    return Promise.all(this.sources.map((s) => s.stop())).then(() => undefined);
  }

  health(): SourceHealth {
    const details: string[] = [];
    for (const source of this.sources) {
      const h = source.health?.();
      if (h && !h.healthy && h.detail) details.push(h.detail);
    }
    return details.length === 0 ? { healthy: true } : { healthy: false, detail: details.join("; ") };
  }
}
