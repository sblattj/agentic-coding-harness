// HTTP run source (spec §5.2): the dashboard as a CLIENT of an external
// feed. Default mode polls GET <url>/runs; sse/ws modes subscribe to
// <url>/runs/stream or <url>/runs/ws for live pushes (the snapshot
// endpoint stays <url>/runs in every mode). Incoming records are
// validated individually — a bad record is dropped with one counted
// warning per fetch, a failed fetch marks the source unhealthy and the
// loop keeps running. The store upserts by runId and never removes, so
// the feed may send full or delta snapshots interchangeably.
import { RunRecordSchema, type RunRecord } from "../core/registry.ts";
import { type RunSource, type SourceHealth } from "./run-source.ts";
import { WebSocket } from "ws";

export interface HttpRunSourceOptions {
  url: string;
  token?: string;
  mode?: "poll" | "sse" | "ws";
  pollMs?: number;
}

const BAD_PAYLOAD_REASON = "feed payload is not { records: [...] }";

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Validate a feed payload record-by-record: valid RunRecords pass through
 * (with the `source` default filled), invalid ones are counted in
 * `skipped` with the first failure's zod message as `reason`. A payload
 * that is not `{ records: [...] }` at all returns skipped 0 — nothing was
 * dropped, the fetch itself failed validation.
 */
export function ingestFeedPayload(payload: unknown): {
  records: RunRecord[];
  skipped: number;
  reason?: string;
} {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !Array.isArray((payload as { records?: unknown }).records)
  ) {
    return { records: [], skipped: 0, reason: BAD_PAYLOAD_REASON };
  }
  const records: RunRecord[] = [];
  let skipped = 0;
  let reason: string | undefined;
  for (const el of (payload as { records: unknown[] }).records) {
    const parsed = RunRecordSchema.safeParse(el);
    if (parsed.success) {
      records.push(parsed.data as RunRecord);
    } else {
      skipped++;
      if (reason === undefined) reason = parsed.error.issues[0]?.message ?? "invalid record";
    }
  }
  return { records, skipped, reason };
}

/** HTTP(S)-backed source: poll, SSE, or WS client for an external feed. */
export class HttpRunSource implements RunSource {
  private readonly base: string;
  private readonly token?: string;
  private readonly mode: "poll" | "sse" | "ws";
  private readonly pollMs: number;
  private readonly store = new Map<string, RunRecord>();
  private onChange: ((records: RunRecord[]) => void) | null = null;
  private stopped = false;
  private healthy = true;
  private lastError: string | undefined;
  private pollTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private abort: AbortController | null = null;
  private ws: WebSocket | null = null;

  constructor(opts: HttpRunSourceOptions) {
    this.base = opts.url.replace(/\/+$/, "");
    this.token = opts.token;
    this.mode = opts.mode ?? "poll";
    this.pollMs = opts.pollMs ?? 3000;
  }

  start(onChange: (records: RunRecord[]) => void): Promise<void> {
    this.onChange = onChange;
    this.stopped = false;
    if (this.mode === "poll") {
      void this.pollOnce(); // immediate first fetch, then the interval
      this.pollTimer = setInterval(() => void this.pollOnce(), this.pollMs);
      this.pollTimer.unref();
    } else if (this.mode === "sse") {
      this.connectSse();
    } else {
      this.connectWs();
    }
    return Promise.resolve();
  }

  snapshot(): RunRecord[] {
    return [...this.store.values()];
  }

  stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.abort?.abort(); // kills any in-flight poll or SSE body
    this.abort = null;
    if (this.ws) {
      this.ws.terminate();
      this.ws = null;
    }
    return Promise.resolve();
  }

  health(): SourceHealth {
    return this.healthy ? { healthy: true } : { healthy: false, detail: this.lastError };
  }

  // --- shared ingest: valid records upsert, bad fetch unhealthy, never throws

  private authHeaders(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  private ingestAndEmit(payload: unknown): void {
    const { records, skipped, reason } = ingestFeedPayload(payload);
    if (reason === BAD_PAYLOAD_REASON) {
      // Top-level validation failed (skipped 0): the fetch itself is bad.
      this.markUnhealthy(reason);
      return;
    }
    if (skipped > 0) {
      process.stderr.write(`web: source: skipped ${skipped} record(s): ${reason}\n`);
    }
    this.healthy = true;
    this.lastError = undefined;
    for (const rec of records) this.store.set(rec.runId, rec);
    if (!this.stopped && this.onChange) this.onChange([...this.store.values()]);
  }

  private markUnhealthy(detail: string): void {
    this.healthy = false;
    this.lastError = detail;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      if (this.mode === "sse") this.connectSse();
      else this.connectWs();
    }, this.pollMs);
    this.reconnectTimer.unref();
  }

  // --- poll mode

  private async pollOnce(): Promise<void> {
    if (this.stopped) return;
    const controller = new AbortController();
    this.abort = controller;
    try {
      const res = await fetch(`${this.base}/runs`, {
        headers: { Accept: "application/json", ...this.authHeaders() },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`GET /runs -> HTTP ${res.status}`);
      this.ingestAndEmit(await res.json());
    } catch (e) {
      if (!this.stopped && !controller.signal.aborted) this.markUnhealthy(errMessage(e));
    } finally {
      if (this.abort === controller) this.abort = null;
    }
  }

  // --- sse mode: minimal event-stream framing (event:/data: lines,
  // blank-line separated); each data payload runs the shared ingest.

  private connectSse(): void {
    if (this.stopped) return;
    const controller = new AbortController();
    this.abort = controller;
    void (async () => {
      try {
        const res = await fetch(`${this.base}/runs/stream`, {
          headers: { Accept: "text/event-stream", ...this.authHeaders() },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`GET /runs/stream -> HTTP ${res.status}`);
        this.healthy = true;
        this.lastError = undefined;
        let buf = "";
        const decoder = new TextDecoder();
        for await (const chunk of res.body) {
          buf += decoder.decode(chunk as Uint8Array, { stream: true });
          let sep: number;
          while ((sep = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            this.handleSseBlock(block);
          }
        }
        if (!this.stopped && !controller.signal.aborted) {
          this.markUnhealthy("stream closed");
          this.scheduleReconnect();
        }
      } catch (e) {
        if (this.stopped || controller.signal.aborted) return;
        this.markUnhealthy(errMessage(e));
        this.scheduleReconnect();
      } finally {
        if (this.abort === controller) this.abort = null;
      }
    })();
  }

  private handleSseBlock(block: string): void {
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) return;
    if (event !== undefined && event !== "runs") return;
    try {
      this.ingestAndEmit(JSON.parse(dataLines.join("\n")));
    } catch (e) {
      this.markUnhealthy(`bad stream JSON: ${errMessage(e)}`);
    }
  }

  // --- ws mode: connect, receive {type:"runs", records} frames, reconnect on loss.

  private connectWs(): void {
    if (this.stopped) return;
    const url = `${this.base.replace(/^http:/, "ws:").replace(/^https:/, "wss:")}/runs/ws`;
    const ws = new WebSocket(url, this.token ? { headers: this.authHeaders() } : undefined);
    this.ws = ws;
    ws.on("open", () => {
      this.healthy = true;
      this.lastError = undefined;
    });
    ws.on("message", (data: unknown) => {
      try {
        const msg: unknown = JSON.parse(String(data));
        if (
          typeof msg === "object" &&
          msg !== null &&
          (msg as { type?: unknown }).type === "runs"
        ) {
          this.ingestAndEmit(msg);
        }
      } catch (e) {
        this.markUnhealthy(`bad ws JSON: ${errMessage(e)}`);
      }
    });
    ws.on("close", () => {
      if (this.stopped) return;
      this.markUnhealthy("ws closed");
      this.scheduleReconnect();
    });
    ws.on("error", (err: Error) => {
      if (this.stopped) return;
      this.markUnhealthy(err.message);
      // ws always follows "error" with "close", which schedules the reconnect.
    });
  }
}
