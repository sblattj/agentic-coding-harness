// Run event hub: pub/sub glue for the dashboard websockets.
//
// The hub itself never touches sockets. Package 2 (the websocket server)
// subscribes each client to Bun-native topics ("run:<runId>" for per-run
// events, "runs" for run-list changes) and calls the publish helpers here.
// Catch-up is transcript tailing: readTranscript replays a run's persisted
// jsonl as AgentEvents before live push takes over.
import fs from "node:fs";
import type { Server } from "bun";
import type { AgentEvent } from "../core/types.ts";
import { type RunRecord, listRunRecords, readRunRecord, registryDir } from "../core/registry.ts";

export const RUN_TOPIC_PREFIX = "run:";
export const RUNS_TOPIC = "runs";

// The socket-data type parameter belongs to Package 2's websocket server;
// the hub only needs the topic-publish surface, so it stays unconstrained.
type AnyServer = Server<any>;

export interface RunEventMessage {
  type: "event";
  runId: string;
  event: AgentEvent;
}

export interface RunsMessage {
  type: "runs";
  records: RunRecord[];
}

export type HubMessage = RunEventMessage | RunsMessage;

export class RunEventHub {
  private server: AnyServer | null = null;
  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly stateDir: string) {}

  attach(server: AnyServer): void {
    this.server = server;
  }

  publishRunEvent(runId: string, event: AgentEvent): void {
    if (!this.server) return;
    const msg: RunEventMessage = { type: "event", runId, event };
    this.server.publish(RUN_TOPIC_PREFIX + runId, JSON.stringify(msg));
  }

  publishRuns(records: RunRecord[]): void {
    if (!this.server) return;
    const msg: RunsMessage = { type: "runs", records };
    this.server.publish(RUNS_TOPIC, JSON.stringify(msg));
  }

  snapshotRuns(): RunRecord[] {
    return listRunRecords(this.stateDir);
  }

  async readTranscript(runId: string): Promise<AgentEvent[]> {
    const rec = readRunRecord(this.stateDir, runId);
    if (!rec) return [];
    let text: string;
    try {
      text = await fs.promises.readFile(rec.rawTranscript, "utf8");
    } catch {
      return [];
    }
    const events: AgentEvent[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        events.push(JSON.parse(trimmed) as AgentEvent);
      } catch {
        // partial/underway line from a live writer — skip, never throw
      }
    }
    return events;
  }

  watchRegistry(): () => void {
    if (this.watcher) return () => this.close();
    let dir: string;
    try {
      dir = registryDir(this.stateDir);
      fs.mkdirSync(dir, { recursive: true });
      this.watcher = fs.watch(dir, () => {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = null;
          this.publishRuns(this.snapshotRuns());
        }, 250);
      });
    } catch {
      this.watcher = null;
      return () => {};
    }
    return () => this.close();
  }

  close(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }
}

export function createRunEventHub(stateDir: string): RunEventHub {
  return new RunEventHub(stateDir);
}
