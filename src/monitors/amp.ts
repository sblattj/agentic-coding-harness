// Read-only Amp (ampcode.com) thread parser.
//
// Where: ~/.local/share/amp/threads/**/*.json — one JSON object per thread.
// Format provenance: Amp is closed source, so there is no vendor schema to
// cite. The shape below is the one ccusage parses in production
// (ryoppippi/ccusage rust/adapters/amp/src/parser.rs @ a0a1fc53, including its
// test fixtures). See docs/transcript-adapters.md for the matrix row.
//
// Accounting:
//  - usageLedger.events[] wins when present (one record per event); the
//    event carries input/output, and cache tokens come from the assistant
//    message whose messageId equals event.toMessageId.
//  - otherwise every assistant message with `usage` is one record.
//  - message `inputTokens` is uncached-only: ccusage's fixture has
//    inputTokens 10 + cacheCreation 986 + cacheRead 11372 = totalInputTokens
//    12368, so no subtraction is applied.
//  - a usage block that carries only `totalTokens` (no input/output split) is
//    skipped with a warning: attributing it to input or output would be a guess.

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { CanonicalTokenRecord } from "./transcripts.ts";
import { warnTranscript, type WarnFn } from "./transcript-warnings.ts";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

export async function parseAmpThread(
  path: string,
  warn: WarnFn = warnTranscript,
): Promise<CanonicalTokenRecord[]> {
  let thread: unknown;
  try {
    thread = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    warn(`amp: skipped unreadable thread file ${path}: ${(err as Error).message}`);
    return [];
  }
  if (!isObj(thread)) {
    warn(`amp: skipped ${path}: top level is not a JSON object`);
    return [];
  }
  const threadId = str(thread.id) ?? basename(path, ".json");
  const rawMessages = Array.isArray(thread.messages) ? thread.messages : [];
  const messages: Obj[] = [];
  rawMessages.forEach((m, i) => {
    if (isObj(m)) messages.push(m);
    else warn(`amp: ${path}: skipped messages[${i}] (not an object)`);
  });

  const ledger = isObj(thread.usageLedger) ? thread.usageLedger : null;
  const events = ledger && Array.isArray(ledger.events) ? ledger.events : null;
  if (events) return fromLedger(path, threadId, events, messages, warn);
  return fromMessages(path, threadId, messages, warn);
}

function fromLedger(
  path: string,
  threadId: string,
  events: unknown[],
  messages: Obj[],
  warn: WarnFn,
): CanonicalTokenRecord[] {
  const cacheByMessageId = new Map<number, { read: number; write: number }>();
  for (const m of messages) {
    if (m.role !== "assistant" || typeof m.messageId !== "number") continue;
    const u = isObj(m.usage) ? m.usage : {};
    cacheByMessageId.set(m.messageId, { read: num(u.cacheReadInputTokens), write: num(u.cacheCreationInputTokens) });
  }
  const out: CanonicalTokenRecord[] = [];
  events.forEach((e, i) => {
    if (!isObj(e) || !isObj(e.tokens)) {
      warn(`amp: ${path}: skipped usageLedger.events[${i}] (no tokens object)`);
      return;
    }
    const input = num(e.tokens.input);
    const output = num(e.tokens.output);
    const cache = typeof e.toMessageId === "number" ? cacheByMessageId.get(e.toMessageId) : undefined;
    const cacheRead = cache?.read ?? 0;
    const cacheWrite = cache?.write ?? 0;
    if (input + output + cacheRead + cacheWrite === 0) {
      if (num(e.tokens.total) > 0) {
        warn(`amp: ${path}: skipped usageLedger.events[${i}]: only totalTokens (${num(e.tokens.total)}), no input/output split`);
      }
      return;
    }
    out.push({
      agent: "amp",
      sessionId: threadId,
      timestamp: str(e.timestamp),
      model: str(e.model),
      input,
      output,
      cacheRead,
      cacheWrite,
      reasoning: 0,
    });
  });
  return out;
}

function fromMessages(path: string, threadId: string, messages: Obj[], warn: WarnFn): CanonicalTokenRecord[] {
  const out: CanonicalTokenRecord[] = [];
  messages.forEach((m, i) => {
    if (m.role !== "assistant" || !isObj(m.usage)) return;
    const u = m.usage;
    const input = num(u.inputTokens);
    const output = num(u.outputTokens);
    const cacheRead = num(u.cacheReadInputTokens);
    const cacheWrite = num(u.cacheCreationInputTokens);
    if (input + output + cacheRead + cacheWrite === 0) {
      if (num(u.totalTokens) > 0) {
        warn(`amp: ${path}: skipped message ${i}: only totalTokens (${num(u.totalTokens)}), no input/output split`);
      }
      return;
    }
    out.push({
      agent: "amp",
      sessionId: threadId,
      timestamp: str(u.timestamp) ?? str(m.timestamp),
      model: str(u.model) ?? str(m.model),
      input,
      output,
      cacheRead,
      cacheWrite,
      reasoning: 0,
    });
  });
  return out;
}
