// Transcript tail for interactive runs (#195).
//
// An interactive Claude run has no stream-json stdout: the TUI owns the PTY.
// Its native session transcript (<projects>/<encoded-cwd>/<sessionId>.jsonl)
// is the metering source instead, the same file `ach watch` reads. This
// module turns that file into driver events:
//
// - events: assistant text, tool calls, tool results and typed user prompts
//   from the main transcript, read incrementally (byte offset + partial line
//   buffer) so each line is emitted once.
// - usage: per-model totals from parseClaudeSession (main file plus
//   <sessionId>/subagents/agent-*.jsonl, deduped on message id + request id
//   exactly as `ach watch` does), emitted as non-negative per-model DELTAS on
//   every poll. The deltas sum to the parseClaudeSession totals, so the
//   RunRecord matches what `ach watch` reports for the session.
// - turn ends: Claude Code writes {type:"system", subtype:"turn_duration"}
//   when a turn finishes. `--then` waits on that marker.
import { existsSync, readdirSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseClaudeSession } from "../monitors/transcripts.ts";
import type { AgentEvent, CanonicalTokenRecord } from "../core/types.ts";

/** Claude Code's projects root: $CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects. */
export function claudeProjectsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configDir = env.CLAUDE_CONFIG_DIR;
  if (configDir !== undefined && configDir !== "") return path.join(configDir, "projects");
  return path.join(os.homedir(), ".claude", "projects");
}

/**
 * Find `<root>/<any project dir>/<sessionId>.jsonl`. Globbing for the session
 * id avoids re-deriving Claude Code's cwd encoding (symlinked tmp dirs,
 * dots, non-ASCII all encode differently across versions).
 */
export function findSessionTranscript(root: string, sessionId: string): string | null {
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return null;
  }
  const name = `${sessionId}.jsonl`;
  for (const d of dirs) {
    const candidate = path.join(root, d, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

interface ModelTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  reasoning: number;
}

function zero(): ModelTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0 };
}

/** Per-model totals of a session, the way `ach watch` groups them. */
export async function sessionTotalsByModel(dir: string, sessionId: string): Promise<Map<string, ModelTotals>> {
  const out = new Map<string, ModelTotals>();
  for (const r of await parseClaudeSession(dir, sessionId)) {
    const key = r.model ?? "unknown";
    const t = out.get(key) ?? zero();
    t.input += r.input;
    t.output += r.output;
    t.cacheRead += r.cacheRead;
    t.cacheWrite += r.cacheWrite;
    t.cacheWrite1h += r.cacheWrite1h ?? 0;
    t.reasoning += r.reasoning;
    out.set(key, t);
  }
  return out;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: string; text: string } => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string")
    .map((b) => b.text)
    .join("");
}

function toolResultText(value: unknown): string | Record<string, unknown> {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return textOf(value);
  if (typeof value === "object" && value !== null) return value as Record<string, unknown>;
  return "";
}

/** What one transcript line contributes. Exported for unit tests. */
export interface LineOutcome {
  events: AgentEvent[];
  /** A new assistant message id: one model turn (counts against --max-turns). */
  newMessage: boolean;
  /** Claude Code's end-of-turn marker. */
  turnEnd: boolean;
}

/**
 * Map one parsed main-transcript line to driver events. `seenMessages`
 * tracks assistant message ids so a multi-block response yields one step.
 */
export function eventsFromTranscriptLine(raw: unknown, sessionId: string, seenMessages: Set<string>, now: number = Date.now()): LineOutcome {
  const none: LineOutcome = { events: [], newMessage: false, turnEnd: false };
  if (typeof raw !== "object" || raw === null) return none;
  const line = raw as Record<string, unknown>;
  const ts = typeof line.timestamp === "string" && Number.isFinite(Date.parse(line.timestamp)) ? Date.parse(line.timestamp) : now;
  if (line.type === "system" && line.subtype === "turn_duration") return { events: [], newMessage: false, turnEnd: true };
  const message = typeof line.message === "object" && line.message !== null ? (line.message as Record<string, unknown>) : null;
  if (message === null) return none;
  if (line.type === "assistant") {
    const model = typeof message.model === "string" ? message.model : undefined;
    if (model === "<synthetic>") return none;
    const events: AgentEvent[] = [];
    const id = typeof message.id === "string" ? message.id : undefined;
    let newMessage = false;
    if (id !== undefined && !seenMessages.has(id)) {
      seenMessages.add(id);
      newMessage = true;
      events.push({ type: "step", agent: "claude", sessionId, ...(model !== undefined ? { model } : {}), data: { kind: "modelTurn", messageId: id }, timestamp: ts });
    }
    const text = textOf(message.content);
    if (text !== "") events.push({ type: "message", agent: "claude", source: "agent", sessionId, ...(model !== undefined ? { model } : {}), content: text, timestamp: ts });
    if (Array.isArray(message.content)) {
      for (const b of message.content as Array<Record<string, unknown>>) {
        if (b?.type !== "tool_use") continue;
        events.push({
          type: "tool_call",
          agent: "claude",
          sessionId,
          ...(typeof b.id === "string" ? { toolCallId: b.id } : {}),
          ...(typeof b.name === "string" ? { functionName: b.name } : {}),
          arguments: (typeof b.input === "object" && b.input !== null ? (b.input as Record<string, unknown>) : "") as Record<string, unknown> | string,
          timestamp: ts,
        });
      }
    }
    return { events, newMessage, turnEnd: false };
  }
  if (line.type === "user") {
    if (line.isMeta === true) return none;
    const content = message.content;
    const events: AgentEvent[] = [];
    if (Array.isArray(content)) {
      for (const b of content as Array<Record<string, unknown>>) {
        if (b?.type !== "tool_result") continue;
        events.push({
          type: "tool_result",
          agent: "claude",
          sessionId,
          ...(typeof b.tool_use_id === "string" ? { toolCallId: b.tool_use_id } : {}),
          content: toolResultText(b.content),
          ...(b.is_error === true ? { isError: true } : {}),
          timestamp: ts,
        });
      }
    }
    if (events.length === 0) {
      const text = textOf(content);
      // Slash-command echoes and local command output are wrapped in tags; skip them.
      if (text !== "" && !text.startsWith("<")) events.push({ type: "message", agent: "claude", source: "user", sessionId, content: text, timestamp: ts });
    }
    return { events, newMessage: false, turnEnd: false };
  }
  return none;
}

/** Non-negative per-field delta of two totals; null when nothing grew. */
export function usageDelta(model: string, now: ModelTotals, before: ModelTotals | undefined, sessionId: string, timestamp: number): CanonicalTokenRecord | null {
  const b = before ?? zero();
  const d = {
    input: Math.max(0, now.input - b.input),
    output: Math.max(0, now.output - b.output),
    cacheRead: Math.max(0, now.cacheRead - b.cacheRead),
    cacheWrite: Math.max(0, now.cacheWrite - b.cacheWrite),
    cacheWrite1h: Math.max(0, now.cacheWrite1h - b.cacheWrite1h),
    reasoning: Math.max(0, now.reasoning - b.reasoning),
  };
  if (d.input + d.output + d.cacheRead + d.cacheWrite + d.cacheWrite1h + d.reasoning === 0) return null;
  return {
    agent: "claude",
    model,
    sessionId,
    timestamp,
    inputTokens: d.input,
    outputTokens: d.output,
    cacheReadTokens: d.cacheRead,
    cacheWriteTokens: d.cacheWrite,
    ...(d.cacheWrite1h > 0 ? { cacheWrite1hTokens: d.cacheWrite1h } : {}),
    ...(d.reasoning > 0 ? { reasoningTokens: d.reasoning } : {}),
    extra: { source: "transcript" },
  };
}

/** Name, size and mtime of every sub-agent transcript of a session ("" when none). */
export function subagentSignature(projectDir: string, sessionId: string): string {
  const sub = path.join(projectDir, sessionId, "subagents");
  let names: string[];
  try {
    names = readdirSync(sub).filter((n) => n.endsWith(".jsonl")).sort();
  } catch {
    return "";
  }
  const parts: string[] = [];
  for (const n of names) {
    try {
      const st = statSync(path.join(sub, n));
      parts.push(`${n}:${st.size}:${st.mtimeMs}`);
    } catch {
      /* removed between listing and stat */
    }
  }
  return parts.join("|");
}

export interface TranscriptTailOptions {
  sessionId: string;
  /** Projects root to search (default claudeProjectsRoot()). */
  root?: string;
  /** Poll interval, ms (default 1000). */
  pollMs?: number;
  onEvent: (e: AgentEvent) => void;
  /** Called once per end-of-turn marker, with the running count. */
  onTurnEnd?: (count: number) => void;
  /** A poll failed (unreadable transcript, I/O error). Metering keeps
   *  polling; the caller decides how loudly to report it. */
  onError?: (err: unknown) => void;
}

/**
 * Poll the session transcript and emit events. `flush()` reads whatever is
 * left (call it after the TUI exits, so the last turn's usage lands).
 */
export class TranscriptTail {
  readonly #opts: TranscriptTailOptions;
  readonly #root: string;
  #file: string | null = null;
  #offset = 0;
  // Bytes after the last newline: a line still being written, possibly
  // ending mid-character, so it stays raw until its newline lands.
  #partial: Buffer = Buffer.alloc(0);
  #seen = new Set<string>();
  #emitted = new Map<string, ModelTotals>();
  #turnEnds = 0;
  #timer: ReturnType<typeof setInterval> | null = null;
  #busy: Promise<void> = Promise.resolve();
  #lastSize = -1;
  #lastMtime = -1;
  #lastSubSig = "";

  constructor(opts: TranscriptTailOptions) {
    this.#opts = opts;
    this.#root = opts.root ?? claudeProjectsRoot();
  }

  get file(): string | null {
    return this.#file;
  }

  get turnEnds(): number {
    return this.#turnEnds;
  }

  start(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => void this.poll(), this.#opts.pollMs ?? 1000);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** One serialized poll (concurrent callers queue behind the running one). */
  poll(force = false): Promise<void> {
    this.#busy = this.#busy
      .then(() => this.#pollOnce(force))
      .catch((err: unknown) => {
        try {
          this.#opts.onError?.(err);
        } catch {
          /* a reporting failure must not stop metering */
        }
      });
    return this.#busy;
  }

  async flush(): Promise<void> {
    this.stop();
    await this.poll(true);
  }

  async #pollOnce(force: boolean): Promise<void> {
    if (this.#file === null) {
      this.#file = findSessionTranscript(this.#root, this.#opts.sessionId);
      if (this.#file === null) return;
    }
    // A transcript found once and unreadable now throws here; poll() hands
    // the error to onError and the next poll retries.
    const st = statSync(this.#file);
    const size = st.size;
    const mtime = st.mtimeMs;
    const changed = size !== this.#lastSize || mtime !== this.#lastMtime;
    this.#lastSize = size;
    this.#lastMtime = mtime;
    // Sub-agent transcripts grow the session's usage without touching the
    // main file, so their sizes and mtimes count as a change too.
    const subSig = subagentSignature(path.dirname(this.#file), this.#opts.sessionId);
    const subChanged = subSig !== this.#lastSubSig;
    this.#lastSubSig = subSig;
    if (changed && size > this.#offset) await this.#readNewLines(size);
    if (changed || subChanged || force) await this.#emitUsage();
  }

  async #readNewLines(size: number): Promise<void> {
    const fh = await open(this.#file!, "r");
    try {
      const len = size - this.#offset;
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, this.#offset);
      this.#offset += bytesRead;
      const bytes = Buffer.concat([this.#partial, buf.subarray(0, bytesRead)]);
      // Split on the newline byte, never inside a UTF-8 sequence (0x0a cannot
      // occur in one), and decode whole lines only.
      const lastNl = bytes.lastIndexOf(0x0a);
      this.#partial = lastNl < 0 ? bytes : Buffer.from(bytes.subarray(lastNl + 1));
      const lines = lastNl < 0 ? [] : bytes.subarray(0, lastNl).toString("utf8").split("\n");
      for (const l of lines) {
        const trimmed = l.trim();
        if (trimmed === "") continue;
        let raw: unknown;
        try {
          raw = JSON.parse(trimmed);
        } catch {
          continue;
        }
        const out = eventsFromTranscriptLine(raw, this.#opts.sessionId, this.#seen);
        for (const e of out.events) this.#opts.onEvent(e);
        if (out.turnEnd) {
          this.#turnEnds++;
          this.#opts.onTurnEnd?.(this.#turnEnds);
        }
      }
    } finally {
      await fh.close();
    }
  }

  async #emitUsage(): Promise<void> {
    const dir = path.dirname(this.#file!);
    const totals = await sessionTotalsByModel(dir, this.#opts.sessionId);
    const now = Date.now();
    for (const [model, t] of totals) {
      const delta = usageDelta(model, t, this.#emitted.get(model), this.#opts.sessionId, now);
      this.#emitted.set(model, { ...t });
      if (delta === null) continue;
      this.#opts.onEvent({ type: "usage", agent: "claude", sessionId: this.#opts.sessionId, usage: delta, timestamp: now });
    }
  }
}
