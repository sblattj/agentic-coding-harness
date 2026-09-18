// Run event hub: pub/sub glue for the dashboard websockets.
//
// The hub itself never touches sockets. Package 2 (the websocket server)
// subscribes each client to topics ("run:<runId>" for per-run events,
// "runs" for run-list changes) and calls the publish helpers here.
// Catch-up is transcript tailing: readTranscript replays a run's persisted
// jsonl as AgentEvents before live push takes over.
//
// Run-record sourcing goes through the RunSource seam (default FsRunSource);
// the hub never reads the registry dir itself.
import fs from "node:fs";
import type { AgentEvent } from "../core/types.ts";
import {
  type RunRecord,
  readRunRecord,
  resolveRawTranscript,
} from "../core/registry.ts";
import { FsRunSource, type RunSource } from "./run-source.ts";

export const RUN_TOPIC_PREFIX = "run:";
export const RUNS_TOPIC = "runs";

/**
 * The topic-publish surface the websocket server exposes. Kept as a
 * single-method interface so the hub stays runtime-agnostic: under Bun it
 * is the native `server.publish`; under Node it is the server's own topic
 * registry over `ws` sockets.
 */
export interface WsPublisher {
  publish(topic: string, data: string): void;
}

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
  private publisher: WsPublisher | null = null;
  private watching = false;

  constructor(
    private readonly stateDir: string,
    private readonly source: RunSource = new FsRunSource(stateDir),
  ) {}

  attach(publisher: WsPublisher): void {
    this.publisher = publisher;
  }

  publishRunEvent(runId: string, event: AgentEvent): void {
    if (!this.publisher) return;
    const msg: RunEventMessage = { type: "event", runId, event };
    this.publisher.publish(RUN_TOPIC_PREFIX + runId, JSON.stringify(msg));
  }

  publishRuns(records: RunRecord[]): void {
    if (!this.publisher) return;
    const msg: RunsMessage = { type: "runs", records };
    this.publisher.publish(RUNS_TOPIC, JSON.stringify(msg));
  }

  snapshotRuns(): RunRecord[] {
    return this.source.snapshot();
  }

  async readTranscript(runId: string): Promise<AgentEvent[]> {
    const rec = readRunRecord(this.stateDir, runId);
    if (!rec) return [];
    let text: string;
    try {
      text = await fs.promises.readFile(resolveRawTranscript(this.stateDir, rec), "utf8");
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
    if (this.watching) return () => this.close();
    this.watching = true;
    // FsRunSource teardown is synchronous inside stop(), so close() stays
    // sync-safe even though stop() is async at the interface level.
    void this.source.start((records) => this.publishRuns(records));
    return () => this.close();
  }

  close(): void {
    this.watching = false;
    void this.source.stop();
  }
}

export function createRunEventHub(stateDir: string): RunEventHub {
  return new RunEventHub(stateDir);
}
