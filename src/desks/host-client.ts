// HTTP client for the Host API (#204). Owner: host seat. Signatures frozen in wave 0.
// Thin fetch wrappers with timeouts; errors carry the URL and the status/body.
import type { DeskMessage, GoalStatus, HostEvent, HostEventType, HostHealth, Sender } from "./types.ts";

export const HOST_CLIENT_TIMEOUT_MS = 5_000;
export const HOST_SET_GOAL_TIMEOUT_MS = 50_000;
const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

const join = (base: string, path: string): string => `${base.replace(/\/+$/, "")}${path}`;

async function call<T>(base: string, method: "GET" | "POST", path: string, body?: unknown, timeoutMs = HOST_CLIENT_TIMEOUT_MS): Promise<T> {
  const url = join(base, path);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const why = e instanceof Error ? (e.name === "TimeoutError" ? `timed out after ${timeoutMs} ms` : e.message) : String(e);
    throw new Error(`desk host ${method} ${url}: ${why}`);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`desk host ${method} ${url}: HTTP ${res.status}: ${text.slice(0, 500)}`);
  try {
    return (text === "" ? {} : JSON.parse(text)) as T;
  } catch {
    throw new Error(`desk host ${method} ${url}: HTTP ${res.status}: invalid JSON: ${text.slice(0, 200)}`);
  }
}

/** null on connection failure, timeout, or a non-2xx answer. */
export async function hostHealth(url: string, timeoutMs = HOST_CLIENT_TIMEOUT_MS): Promise<HostHealth | null> {
  try {
    return await call<HostHealth>(url, "GET", "/health", undefined, timeoutMs);
  } catch {
    return null;
  }
}
export async function hostSend(url: string, from: Sender, text: string): Promise<Pick<DeskMessage, "id" | "delivered">> {
  return call(url, "POST", "/send", { from, text });
}
export async function hostNote(url: string, text: string): Promise<void> {
  await call(url, "POST", "/note", { text });
}
export async function hostRecord(url: string, type: HostEventType, data: Record<string, unknown>): Promise<number> {
  const r = await call<{ seq: number }>(url, "POST", "/record", { type, data });
  return r.seq;
}
export async function hostGoal(url: string): Promise<GoalStatus> {
  return call(url, "GET", "/goal");
}
export async function hostSetGoal(url: string, objective: string): Promise<void> {
  await call(url, "POST", "/goal", { objective }, HOST_SET_GOAL_TIMEOUT_MS);
}
export async function hostMcp(url: string): Promise<Record<string, string>> {
  return call(url, "GET", "/mcp");
}
export async function hostEvents(url: string, since = 0): Promise<HostEvent[]> {
  const r = await call<{ events: HostEvent[] }>(url, "GET", `/events?since=${since}`);
  return r.events;
}

/**
 * SSE subscription; returns an unsubscribe function. Reconnects with backoff
 * (1 s doubling to 30 s, reset after a successful connect), resuming at the
 * last seq seen; events with seq <= lastSeq are dropped.
 */
export function hostSubscribe(url: string, since: number, onEvent: (e: HostEvent) => void): () => void {
  let lastSeq = since;
  let closed = false;
  let backoff = BACKOFF_START_MS;
  let timer: NodeJS.Timeout | undefined;
  let ctrl: AbortController | undefined;

  const handleBlock = (block: string): void => {
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (data.length === 0) return;
    let ev: HostEvent;
    try {
      ev = JSON.parse(data.join("\n")) as HostEvent;
    } catch {
      return;
    }
    if (typeof ev.seq !== "number" || ev.seq <= lastSeq) return;
    lastSeq = ev.seq;
    try {
      onEvent(ev);
    } catch {
      /* a throwing listener must not kill the stream */
    }
  };

  const connect = async (): Promise<void> => {
    if (closed) return;
    ctrl = new AbortController();
    try {
      const res = await fetch(join(url, `/events?since=${lastSeq}`), {
        headers: { accept: "text/event-stream" },
        signal: ctrl.signal,
      });
      if (!res.ok || res.body === null) throw new Error(`HTTP ${res.status}`);
      backoff = BACKOFF_START_MS;
      const decoder = new TextDecoder();
      let buf = "";
      const reader = res.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          handleBlock(block);
        }
      }
    } catch {
      /* fall through to reconnect */
    }
    if (closed) return;
    timer = setTimeout(() => void connect(), backoff);
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  };

  void connect();
  return () => {
    closed = true;
    if (timer !== undefined) clearTimeout(timer);
    ctrl?.abort();
  };
}

export async function hostAttach(url: string): Promise<string[]> {
  const r = await call<{ argv: string[] }>(url, "GET", "/attach");
  return r.argv;
}
export async function hostStop(url: string): Promise<void> {
  await call(url, "POST", "/stop", {});
}
