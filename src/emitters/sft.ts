// SFT emitter (#78): recorded runs -> OpenAI chat-format JSONL for fine-tuning.
//
// One line per sample, each `{"messages": [...]}`. Turn mapping:
//   message(user)            -> {role:"user", content}
//   message(system)          -> {role:"system", content}
//   message(agent|assistant) -> {role:"assistant", content}
//   tool_call                -> appended to the open assistant message's
//                               `tool_calls` (OpenAI function-call shape;
//                               arguments is a JSON string)
//   tool_result              -> {role:"tool", tool_call_id, content}
// Two sampling modes: turn-level (one sample per assistant message, holding
// the whole conversation up to and including it) and full-conversation (one
// sample per run). Run filters (--min-score, --exit, --agent) apply per run.
import fs from "node:fs/promises";
import path from "node:path";
import { HarnessError } from "../core/types.ts";
import type { AgentEvent } from "../core/types.ts";
import { looksLikeRunResult, repeatEnvelopeRuns } from "../report/model.ts";

export interface SftToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type SftMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: SftToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface SftSample {
  messages: SftMessage[];
}

/** One run as the SFT emitter sees it. Missing fields mean "input did not carry it". */
export interface SftRun {
  /** Where it came from (file path, plus index inside a repeat envelope). */
  source: string;
  events: AgentEvent[];
  agent?: string;
  exitStatus?: string;
  /** Numeric score: top-level `score`, else verify verdict (pass = 1, fail/error = 0). */
  score?: number;
}

export interface SftFilters {
  minScore?: number;
  exit?: string;
  agent?: string;
}

function text(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v ?? "");
}

/** Fold an event stream into an OpenAI-valid message list (see file header). */
export function eventsToMessages(events: readonly AgentEvent[]): SftMessage[] {
  const out: SftMessage[] = [];
  // Index (in `out`) of the assistant message that may still collect tool calls/results.
  let open = -1;
  const openCalls = new Set<string>();

  for (const ev of events) {
    if (ev.type === "message") {
      const role = (ev as { role?: unknown }).role;
      const src: string = typeof ev.source === "string" ? ev.source : typeof role === "string" ? role : "agent";
      const content = text(ev.content);
      if (src === "user" || src === "system") {
        out.push({ role: src, content });
        open = -1;
      } else {
        out.push({ role: "assistant", content });
        open = out.length - 1;
      }
      openCalls.clear();
    } else if (ev.type === "tool_call") {
      if (typeof ev.toolCallId !== "string" || typeof ev.functionName !== "string") continue;
      const tail = out[out.length - 1];
      // Calls join the assistant message directly before them; after a tool
      // result (or a user turn) they start a fresh assistant message.
      if (open < 0 || tail === undefined || tail.role !== "assistant") {
        out.push({ role: "assistant", content: "" });
        open = out.length - 1;
        openCalls.clear();
      }
      const msg = out[open] as Extract<SftMessage, { role: "assistant" }>;
      (msg.tool_calls ??= []).push({
        id: ev.toolCallId,
        type: "function",
        function: { name: ev.functionName, arguments: text(ev.arguments ?? {}) },
      });
      openCalls.add(ev.toolCallId);
    } else if (ev.type === "tool_result") {
      // A result with no pending call in the open assistant message cannot be
      // placed validly; drop it rather than emit a dangling tool message.
      if (typeof ev.toolCallId !== "string" || open < 0 || !openCalls.has(ev.toolCallId)) continue;
      out.push({ role: "tool", tool_call_id: ev.toolCallId, content: text(ev.content) });
      openCalls.delete(ev.toolCallId);
    }
  }

  // Strip calls that never got a result (OpenAI rejects dangling tool_calls).
  const answered = new Set<string>();
  for (const m of out) if (m.role === "tool") answered.add(m.tool_call_id);
  const cleaned: SftMessage[] = [];
  for (const m of out) {
    if (m.role === "assistant" && m.tool_calls) {
      const kept = m.tool_calls.filter((c) => answered.has(c.id));
      if (kept.length > 0) {
        cleaned.push({ ...m, tool_calls: kept });
        continue;
      }
      if (m.content === "") continue;
      cleaned.push({ role: "assistant", content: m.content });
      continue;
    }
    cleaned.push(m);
  }
  return cleaned;
}

/** Turn-level: one sample per assistant message, with all context before it. */
export function turnSamples(messages: readonly SftMessage[]): SftSample[] {
  const samples: SftSample[] = [];
  messages.forEach((m, i) => {
    if (m.role === "assistant") samples.push({ messages: messages.slice(0, i + 1) as SftMessage[] });
  });
  return samples;
}

/** Full conversation: one sample, trimmed to end at the last assistant message. */
export function fullSample(messages: readonly SftMessage[]): SftSample[] {
  let last = -1;
  messages.forEach((m, i) => {
    if (m.role === "assistant") last = i;
  });
  // A trailing tool_calls assistant message is only valid with its results.
  return last < 0 ? [] : [{ messages: messages.slice(0, last + 1) as SftMessage[] }];
}

function scoreOf(o: Record<string, unknown>): number | undefined {
  if (typeof o.score === "number" && Number.isFinite(o.score)) return o.score;
  const v = o.verify as { status?: unknown } | undefined;
  if (v && typeof v === "object") {
    if (v.status === "pass") return 1;
    if (v.status === "fail" || v.status === "error") return 0;
  }
  return undefined;
}

function toRun(source: string, o: Record<string, unknown>, fallbackAgent?: string): SftRun {
  const tokens = Array.isArray(o.tokens) ? (o.tokens as Array<{ agent?: unknown }>) : [];
  const tokAgent = tokens.find((t) => typeof t?.agent === "string" && t.agent !== "")?.agent as string | undefined;
  const agent = (typeof o.agent === "string" && o.agent !== "" ? o.agent : undefined) ?? tokAgent ?? fallbackAgent;
  return {
    source,
    events: o.events as AgentEvent[],
    ...(agent !== undefined ? { agent } : {}),
    ...(typeof o.exitStatus === "string" ? { exitStatus: o.exitStatus } : {}),
    ...(scoreOf(o) !== undefined ? { score: scoreOf(o) as number } : {}),
  };
}

function runsFromParsed(source: string, parsed: unknown, fallbackAgent?: string): SftRun[] {
  if (Array.isArray(parsed)) return [{ source, events: parsed as AgentEvent[] }];
  if (typeof parsed !== "object" || parsed === null) return [];
  const children = repeatEnvelopeRuns(parsed);
  if (children !== null) {
    return children.map((c, i) => toRun(`${source}#${i}`, c as unknown as Record<string, unknown>, fallbackAgent));
  }
  const o = parsed as Record<string, unknown>;
  if (Array.isArray(o.events)) return [toRun(source, o, fallbackAgent)];
  return [];
}

async function readJson(file: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (e) {
    throw new HarnessError(`cannot read --input '${file}': ${e instanceof Error ? e.message : e}`, "IO");
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new HarnessError(`--input '${file}' is not valid JSON: ${e instanceof Error ? e.message : e}`, "IO");
  }
}

async function jsonFilesIn(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => path.join(dir, e.name))
    .sort();
}

/**
 * Load runs from `--input`: a JSON file (event array, `{events}`, a RunResult,
 * or a `--repeat` envelope) or a directory of RunResult JSON files (a trial
 * dir, or a trials root whose subdirectories are trial dirs; the same layout
 * `ach report` reads, e.g. `<ledger>.runs/` from `ach trial`).
 */
export async function loadSftRuns(input: string): Promise<SftRun[]> {
  const abs = path.resolve(input);
  const st = await fs.stat(abs).catch((e: unknown) => {
    throw new HarnessError(`cannot read --input '${input}': ${e instanceof Error ? e.message : e}`, "IO");
  });
  if (!st.isDirectory()) return runsFromParsed(input, await readJson(abs));
  const files = await jsonFilesIn(abs);
  const sub = (await fs.readdir(abs, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => path.join(abs, e.name)).sort();
  for (const d of sub) files.push(...(await jsonFilesIn(d)));
  const runs: SftRun[] = [];
  for (const f of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(f, "utf8"));
    } catch {
      continue;
    }
    if (!looksLikeRunResult(parsed) && repeatEnvelopeRuns(parsed) === null) continue;
    // Trial files are named `<agent>[~model~trialN].json`; use that as a fallback agent.
    runs.push(...runsFromParsed(f, parsed, path.basename(f, ".json").split("~")[0]));
  }
  return runs;
}

/** Apply per-run filters. Throws USAGE when a filter has no data to act on. */
export function filterSftRuns(runs: readonly SftRun[], f: SftFilters): SftRun[] {
  if (f.minScore !== undefined && !runs.some((r) => r.score !== undefined)) {
    throw new HarnessError(
      "--min-score needs score data, but no run in --input carries one (a numeric `score` or a `verify` verdict, e.g. from `ach run --verify --json`)",
      "USAGE",
    );
  }
  if (f.exit !== undefined && !runs.some((r) => r.exitStatus !== undefined)) {
    throw new HarnessError(
      "--exit needs run outcomes, but no run in --input carries an `exitStatus` (pass a RunResult JSON or a directory of them)",
      "USAGE",
    );
  }
  return runs.filter(
    (r) =>
      (f.minScore === undefined || (r.score !== undefined && r.score >= f.minScore)) &&
      (f.exit === undefined || r.exitStatus === f.exit) &&
      (f.agent === undefined || r.agent === f.agent),
  );
}

export interface SftOptions extends SftFilters {
  input: string;
  out?: string;
  fullConversation?: boolean;
}

export interface SftResult {
  body: string;
  runsRead: number;
  runsKept: number;
  samples: number;
}

export async function buildSft(opts: SftOptions): Promise<SftResult> {
  const runs = await loadSftRuns(opts.input);
  const kept = filterSftRuns(runs, opts);
  const lines: string[] = [];
  for (const r of kept) {
    const msgs = eventsToMessages(r.events);
    for (const s of opts.fullConversation ? fullSample(msgs) : turnSamples(msgs)) lines.push(JSON.stringify(s));
  }
  return {
    body: lines.length > 0 ? lines.join("\n") + "\n" : "",
    runsRead: runs.length,
    runsKept: kept.length,
    samples: lines.length,
  };
}

/** CLI entry for `ach emit --format sft`; returns the process exit code. */
export async function runSftEmit(opts: SftOptions): Promise<number> {
  const res = await buildSft(opts);
  if (opts.out) {
    await fs.writeFile(opts.out, res.body);
    process.stdout.write(`wrote ${opts.out} (${res.samples} samples from ${res.runsKept}/${res.runsRead} runs)\n`);
  } else {
    process.stdout.write(res.body);
    process.stderr.write(`sft: ${res.samples} samples from ${res.runsKept}/${res.runsRead} runs\n`);
  }
  return 0;
}
