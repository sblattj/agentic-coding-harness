import type { AgentEvent, EventTimestamp } from "../core/types.ts";

export type AsciicastEvent = [number, "o" | "m", string];

export interface AsciicastHeader {
  version: 2;
  width: number;
  height: number;
  timestamp: number;
  duration?: number;
  title?: string;
}

export interface AsciicastOptions {
  width?: number;
  height?: number;
  title?: string;
}

interface RenderedEvent {
  text: string;
  marker?: string;
}

export function eventToText(ev: AgentEvent): string | null {
  const rendered = renderEvent(ev);
  return rendered === null ? null : rendered.text;
}

function toMs(t: EventTimestamp): number | null {
  if (t instanceof Date && Number.isFinite(t.getTime())) return t.getTime();
  if (typeof t === "number" && Number.isFinite(t)) return t;
  if (typeof t === "string") {
    const p = Date.parse(t);
    if (Number.isFinite(p)) return p;
  }
  return null;
}

function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max - 3) + "...";
}

function argsSummary(args: Record<string, unknown> | string | undefined): string {
  let s: string;
  if (typeof args === "string") s = args;
  else if (args === undefined) s = "";
  else s = JSON.stringify(args);
  return truncate(s, 120);
}

function resultText(content: string | Record<string, unknown> | undefined): string {
  if (typeof content === "string") return content;
  if (content !== undefined) return JSON.stringify(content);
  return "";
}

function renderEvent(ev: AgentEvent): RenderedEvent | null {
  switch (ev.type) {
    case "message": {
      const content = typeof ev.content === "string" ? ev.content : "";
      if (content.trim().length === 0) return null;
      const rendered: RenderedEvent = { text: content };
      if (ev.source === "assistant") rendered.marker = truncate(content, 60);
      return rendered;
    }
    case "tool_call": {
      const name = ev.functionName ?? "tool";
      const summary = argsSummary(ev.arguments);
      return { text: `$ ${name}${summary.length > 0 ? ` ${summary}` : ""}` };
    }
    case "tool_result": {
      const content = resultText(ev.content);
      if (content.trim().length === 0) return null;
      return { text: ev.isError ? `! ${content}` : content };
    }
    case "progress": {
      const text = ev.text ?? "";
      if (text.trim().length === 0) return null;
      return { text };
    }
    case "error": {
      const message = ev.message ?? "";
      if (message.trim().length === 0) return null;
      return { text: message };
    }
    default:
      return null;
  }
}

export function asciicastHeader(opts: AsciicastOptions): AsciicastHeader {
  const header: AsciicastHeader = {
    version: 2,
    width: opts.width ?? 100,
    height: opts.height ?? 30,
    timestamp: Math.floor(Date.now() / 1000),
  };
  if (opts.title !== undefined) header.title = opts.title;
  return header;
}

/**
 * Synthesize an asciicast v2 (.cast) replay from structured events.
 * This is a readable text rendering, not ANSI-faithful TTY capture.
 * The output is JSONL, but if it is embedded in an HTML <script> tag,
 * escaping `</script>` is the caller's responsibility.
 */
export function eventsToAsciicast(events: AgentEvent[], opts: AsciicastOptions = {}): string {
  const rows = events.map((ev) => ({ ev, ms: toMs(ev.timestamp) }));

  let carry: number | null = null;
  for (const row of rows) {
    if (row.ms === null) row.ms = carry;
    else carry = row.ms;
  }
  const firstFinite = rows.find((row) => row.ms !== null)?.ms;
  if (firstFinite === undefined) {
    for (const row of rows) row.ms = 0;
  } else {
    for (const row of rows) {
      if (row.ms === null) row.ms = firstFinite;
    }
  }

  rows.sort((a, b) => (a.ms as number) - (b.ms as number));

  const t0 = rows.length > 0 ? (rows[0]!.ms as number) : 0;
  const lastMs = rows.length > 0 ? (rows[rows.length - 1]!.ms as number) : t0;
  const sec = (ms: number): number => Math.round(((ms - t0) / 1000) * 1000) / 1000;

  const header = asciicastHeader(opts);
  if (events.length > 0) header.timestamp = Math.floor(t0 / 1000);
  header.duration = sec(lastMs);

  const frames: AsciicastEvent[] = [];
  for (const row of rows) {
    const rendered = renderEvent(row.ev);
    if (rendered === null) continue;
    const t = sec(row.ms as number);
    if (rendered.marker !== undefined) frames.push([t, "m", rendered.marker]);
    const text = rendered.text.endsWith("\n") ? rendered.text : `${rendered.text}\n`;
    frames.push([t, "o", text]);
  }

  const lines = [JSON.stringify(header), ...frames.map((f) => JSON.stringify(f))];
  return `${lines.join("\n")}\n`;
}
