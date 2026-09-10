#!/usr/bin/env bun
// harness — unified CLI for driving agents, watching usage, aggregating
// stats, and emitting interchange formats. Single entry, hand-rolled dispatch
// (node:util parseArgs); no external CLI framework. Stdlib + zod only.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import {
  AGENTS,
  HarnessError,
  isKnownAgent,
  type AgentEvent,
  type RunResult,
} from "../core/types.ts";
import { z } from "zod";
import { createDriver, defaultAdapters } from "../core/driver.ts";
import { stateDir, loadOffsets, saveOffsets, appendRecords, readAllRecords, type StatRecord } from "../core/store.ts";
import { AtifWriter } from "../emitters/atif.ts";
import { toOtlpJson } from "../emitters/otel.ts";
import {
  parseClaudeTranscript,
  parseCodexRollout,
  parseGeminiChat,
  scanAll,
} from "../monitors/transcripts.ts";
import { statsFromDb } from "../adapters/opencode.ts";
import { createPricer } from "../core/pricing.ts";
import { aggregate, fmtInt, fmtUsd, formatEventLine, formatSummary, type AggregatableRecord } from "./lib.ts";

const USAGE = `harness — unified agent run harness

usage:
  harness run --agent <claude|opencode|kiro|codex|gemini> [--model M] [--resume SID]
              [--budget-usd N] [--max-turns N] [--json] "<prompt>"
  harness watch [--dir <transcriptDir>]
  harness stats [--agent A] [--days N] [--json]
                (machine claude/codex/gemini transcripts + harness state)
  harness emit --input <events.json> --format <atif|otel> [--out path]
               [--agent A] [--model M] [--session-id SID]

env:
  AGENT_HARNESS_STATE_DIR   state root (default ~/.agent-harness)`;

// ---------------------------------------------------------------- helpers

function optNum(v: string | undefined, flag: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) {
    throw new HarnessError(`${flag} expects a non-negative number, got '${v}'`, "USAGE");
  }
  return n;
}

function optInt(v: string | undefined, flag: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) {
    throw new HarnessError(`${flag} expects a non-negative integer, got '${v}'`, "USAGE");
  }
  return n;
}

// ---------------------------------------------------------------- run

async function cmdRun(rest: string[]): Promise<number> {
  const args = parseArgs({
    args: rest,
    options: {
      agent: { type: "string" },
      model: { type: "string" },
      resume: { type: "string" },
      "budget-usd": { type: "string" },
      "max-turns": { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const agent = args.values.agent;
  if (!agent) throw new HarnessError("run requires --agent <name>", "USAGE");
  if (!isKnownAgent(agent)) {
    throw new HarnessError(
      `unknown agent '${agent}' (expected one of: ${AGENTS.join(", ")})`,
      "UNKNOWN_AGENT",
    );
  }
  const prompt = args.positionals.join(" ").trim();
  if (!prompt) throw new HarnessError("run requires a prompt argument", "USAGE");

  const onEvent = (e: AgentEvent) => process.stderr.write(formatEventLine(e) + "\n");
  const driver = createDriver({
    adapters: await defaultAdapters(),
    stateDir: stateDir(),
    pricer: createPricer(),
    onEvent,
  });

  let result: RunResult;
  try {
    result = await driver.run(agent, {
      prompt,
      model: args.values.model,
      resume: args.values.resume,
      budget: {
        usd: optNum(args.values["budget-usd"], "--budget-usd"),
        maxTurns: optInt(args.values["max-turns"], "--max-turns"),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new HarnessError(message, "RUN_FAILED");
  }
  for (const w of result.warnings) process.stderr.write(`[warn] ${w}\n`);

  const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  let lastModel: string | undefined;
  for (const t of result.tokens) {
    sum.input += t.inputTokens;
    sum.output += t.outputTokens;
    sum.cacheRead += t.cacheReadTokens;
    sum.cacheWrite += t.cacheWriteTokens;
    sum.reasoning += t.reasoningTokens ?? 0;
    if (t.model) lastModel = t.model;
  }

  if (args.values.json) {
    // Full RunResult: sessionId, events, tokens, totalCost, durationMs,
    // exitStatus, warnings.
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(
      formatSummary({
        agent,
        sessionId: result.sessionId,
        model: args.values.model ?? lastModel,
        tokens: sum,
        costUsd: result.totalCost,
        durationMs: result.durationMs,
        exitStatus: result.exitStatus,
      }) + "\n",
    );
  }
  return result.exitStatus === "success" ? 0 : 1;
}

// ---------------------------------------------------------------- watch

const POLL_MS = 5_000;

async function cmdWatch(rest: string[]): Promise<number> {
  const args = parseArgs({
    args: rest,
    options: { dir: { type: "string" } },
    allowPositionals: true,
  });
  const claudeDir = args.values.dir || path.join(os.homedir(), ".claude", "projects");
  const codexDir = path.join(os.homedir(), ".codex", "sessions");
  const geminiDir = path.join(os.homedir(), ".gemini", "tmp");
  const state = stateDir();
  const offsets = await loadOffsets();
  const seenByFile = new Map<string, Set<string>>();
  const seenOpencode = new Set<string>();
  const pricer = createPricer();
  process.stderr.write(`watch: claude=${claudeDir} codex=${codexDir} gemini=${geminiDir}\n`);
  process.stderr.write(`watch: state=${state}, poll=${POLL_MS / 1000}s — Ctrl-C to stop\n`);

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    saveOffsets(offsets).finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  interface Watched {
    file: string;
    agent: "claude" | "codex" | "gemini";
    parse: (file: string) => Promise<
      Array<{
        agent: "claude" | "codex" | "gemini";
        sessionId: string | null;
        timestamp: string | null;
        model: string | null;
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        reasoning: number;
      }>
    >;
  }
  const watched: Watched[] = [];
  for (const f of await listByExt(claudeDir, ".jsonl")) watched.push({ file: f, agent: "claude", parse: parseClaudeTranscript });
  for (const f of await listByExt(codexDir, ".jsonl")) watched.push({ file: f, agent: "codex", parse: parseCodexRollout });
  for (const f of await listGeminiChats(geminiDir)) watched.push({ file: f, agent: "gemini", parse: parseGeminiChat });

  let firstTick = true;
  const tick = async (): Promise<void> => {
    const deltas = new Map<string, { agent: string; sessionId: string; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }>();
    const bump = (r: { agent?: string; sessionId?: string | null; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd?: number }) => {
      const agent = r.agent ?? "unknown";
      const sessionId = r.sessionId ?? "unknown";
      const key = `${agent}\u0000${sessionId}`;
      const d = deltas.get(key) ?? { agent, sessionId, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
      d.input += r.inputTokens;
      d.output += r.outputTokens;
      d.cacheRead += r.cacheReadTokens;
      d.cacheWrite += r.cacheWriteTokens;
      d.cost += r.costUsd ?? 0;
      deltas.set(key, d);
    };
    // Only records scanAll cannot see (opencode SQLite) are persisted to the
    // state dir; claude/codex/gemini history is read straight from the
    // machine transcript dirs by `harness stats`, so copying them into
    // stateDir/raw would double-count.
    const fresh: StatRecord[] = [];

    // --- machine transcripts (claude / codex / gemini)
    for (const w of watched) {
      let size: number;
      try {
        size = (await fs.stat(w.file)).size;
      } catch {
        continue;
      }
      const prev = offsets.files[w.file];
      if (prev === size) continue;
      // First sight or grew: parse the whole file; the parsers dedupe
      // internally (assistant replays, cumulative rollouts), and we diff
      // against records already emitted for this file.
      const seen = seenByFile.get(w.file) ?? new Set<string>();
      const firstSight = prev === undefined;
      try {
        for (const rec of await w.parse(w.file)) {
          const key = JSON.stringify(rec);
          if (seen.has(key)) continue;
          seen.add(key);
          const costUsd =
            rec.model != null
              ? safePrice(pricer, {
                  model: rec.model,
                  inputTokens: rec.input,
                  outputTokens: rec.output,
                  cacheReadTokens: rec.cacheRead,
                  cacheWriteTokens: rec.cacheWrite,
                })
              : 0;
          // First sight of a file baselines its existing records without
          // printing them as deltas; only post-watch growth prints lines.
          if (!firstSight) {
            bump({
              agent: rec.agent,
              sessionId: rec.sessionId ?? "unknown",
              inputTokens: rec.input,
              outputTokens: rec.output,
              cacheReadTokens: rec.cacheRead,
              cacheWriteTokens: rec.cacheWrite,
              costUsd,
            });
          }
        }
      } catch {
        continue; // unreadable mid-write; retry next tick
      }
      seenByFile.set(w.file, seen);
      offsets.files[w.file] = size;
    }

    // --- opencode SQLite store (adapter). First tick baselines silently.
    try {
      for (const s of await statsFromDb()) {
        const key = `opencode\u0000${s.id}\u0000${s.time_created}`;
        if (seenOpencode.has(key)) continue;
        seenOpencode.add(key);
        const canonical: StatRecord = {
          ts: new Date(s.time_created).toISOString(),
          agent: "opencode",
          sessionId: s.id,
          inputTokens: s.tokens_input,
          outputTokens: s.tokens_output,
          cacheReadTokens: s.tokens_cache_read,
          cacheWriteTokens: s.tokens_cache_write,
          reasoningTokens: s.tokens_reasoning,
          costUsd: s.cost,
        };
        fresh.push(canonical);
        if (!firstTick) bump(canonical);
      }
    } catch {
      /* no opencode db on this machine — claude/codex/gemini tailing still runs */
    }

    if (fresh.length > 0) await appendRecords(fresh);
    for (const d of deltas.values()) {
      process.stdout.write(
        `${d.agent.padEnd(8)} ${d.sessionId.slice(0, 12).padEnd(12)} +${fmtInt(d.input)} input +${fmtInt(d.output)} output +${fmtInt(d.cacheRead)} cacheR +${fmtInt(d.cacheWrite)} cacheW ${fmtUsd(d.cost)}\n`,
      );
    }
    firstTick = false;
    await saveOffsets(offsets).catch(() => {});
  };

  await tick();
  // The interval holds the event loop open; watch runs until SIGINT/SIGTERM.
  const timer = setInterval(() => void tick().catch(() => {}), POLL_MS);
  await new Promise<never>(() => {});
  return 0; // unreachable: the promise above never resolves
}

function safePrice(
  pricer: ReturnType<typeof createPricer>,
  t: { model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number },
): number {
  const cost = pricer.price({ model: t.model, inputTokens: t.inputTokens, outputTokens: t.outputTokens, cacheReadTokens: t.cacheReadTokens, cacheWriteTokens: t.cacheWriteTokens });
  if (Number.isNaN(cost)) {
    for (const w of pricer.drainWarnings()) process.stderr.write(`[warn] ${w}\n`);
    return 0;
  }
  return Math.round(cost * 1e6) / 1e6;
}

async function listByExt(dir: string, ext: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && e.name.endsWith(ext)) out.push(p);
    }
  };
  await walk(dir);
  return out.sort();
}

async function listGeminiChats(geminiDir: string): Promise<string[]> {
  const all = await listByExt(geminiDir, ".json");
  return all.filter((f) => path.basename(path.dirname(f)) === "chats");
}

// ---------------------------------------------------------------- stats

/** Composite identity used to collapse the same logical record when it is
 * visible both in a machine transcript dir (scanAll) and in stateDir/raw
 * (legacy watch backfill): agent + session + model + day + token counts. */
function dedupeKey(r: {
  agent?: string;
  sessionId?: string | null;
  model?: string | null;
  ts?: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens?: number;
}): string {
  return JSON.stringify([
    r.agent ?? "",
    r.sessionId ?? "",
    r.model ?? "",
    r.ts ?? "",
    r.inputTokens,
    r.outputTokens,
    r.cacheReadTokens,
    r.cacheWriteTokens,
    r.reasoningTokens ?? 0,
  ]);
}

async function cmdStats(rest: string[]): Promise<number> {
  const args = parseArgs({
    args: rest,
    options: {
      agent: { type: "string" },
      days: { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const agent = args.values.agent;
  if (agent && !isKnownAgent(agent)) {
    throw new HarnessError(
      `unknown agent '${agent}' (expected one of: ${AGENTS.join(", ")})`,
      "UNKNOWN_AGENT",
    );
  }
  const days = optNum(args.values.days, "--days");
  const sinceTs = days !== undefined ? Date.now() - days * 86_400_000 : undefined;

  // Harness state (driver-run NDJSON + watch-persisted opencode) ...
  const stateRecords = await readAllRecords({ agent, sinceTs });
  const records: AggregatableRecord[] = stateRecords.map((r) => ({
    ts: r.ts,
    agent: r.agent,
    sessionId: r.sessionId,
    model: r.model,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens,
    cacheWriteTokens: r.cacheWriteTokens,
    reasoningTokens: r.reasoningTokens ?? 0,
    costUsd: r.costUsd,
  }));
  const seen = new Set(stateRecords.map(dedupeKey));

  // ... plus machine CLI transcripts (claude/codex/gemini), priced with the
  // shared core pricer. costUsd is set only when the record has a model the
  // pricer knows; undefined costs contribute nothing to the sums.
  const pricer = createPricer();
  for await (const rec of scanAll()) {
    if (agent && rec.agent !== agent) continue;
    const tsMs = rec.timestamp ? Date.parse(rec.timestamp) : NaN;
    if (sinceTs !== undefined && (!Number.isFinite(tsMs) || tsMs < sinceTs)) continue;
    const row = {
      ts: Number.isFinite(tsMs) ? new Date(tsMs).toISOString() : null,
      agent: rec.agent,
      sessionId: rec.sessionId ?? "unknown",
      model: rec.model ?? undefined,
      inputTokens: rec.input,
      outputTokens: rec.output,
      cacheReadTokens: rec.cacheRead,
      cacheWriteTokens: rec.cacheWrite,
      reasoningTokens: rec.reasoning,
    };
    const key = dedupeKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    let costUsd: number | undefined;
    if (rec.model) {
      const cost = pricer.price({
        model: rec.model,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheWriteTokens: row.cacheWriteTokens,
      });
      if (!Number.isNaN(cost)) costUsd = cost;
    }
    records.push(costUsd === undefined ? { ...row } : { ...row, costUsd });
  }
  for (const w of new Set(pricer.drainWarnings())) process.stderr.write(`[warn] ${w}\n`);

  const agg = aggregate(records);

  if (args.values.json) {
    process.stdout.write(
      JSON.stringify(
        {
          total: agg.totals,
          byAgent: agg.byAgent,
          byDay: agg.byDay,
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    const line = (label: string, b: typeof agg.totals) =>
      `${label.padEnd(9)} records=${fmtInt(b.records)} input=${fmtInt(b.inputTokens)} output=${fmtInt(b.outputTokens)} cacheRead=${fmtInt(b.cacheReadTokens)} cacheWrite=${fmtInt(b.cacheWriteTokens)} reasoning=${fmtInt(b.reasoningTokens)} cost=${fmtUsd(b.costUsd)}`;
    process.stdout.write(line("totals", agg.totals) + "\n");
    for (const [a, b] of Object.entries(agg.byAgent).sort()) process.stdout.write(line(a, b) + "\n");
    for (const [d, b] of Object.entries(agg.byDay).sort()) process.stdout.write(line(d, b) + "\n");
  }
  hintCcusage();
  return 0;
}

function hintCcusage(): void {
  const probe = spawnSync("/bin/sh", ["-c", "command -v ccusage >/dev/null 2>&1"], { stdio: "ignore" });
  if (probe.status === 0) {
    process.stderr.write(
      "hint: 'ccusage' is installed — run `ccusage` for richer batch usage reports (daily/monthly/session breakdowns).\n",
    );
  }
}

// ---------------------------------------------------------------- emit

const EventStreamSchema = z.union([
  z.array(z.unknown()),
  z.object({ events: z.array(z.unknown()) }).transform((o) => o.events),
]);

async function cmdEmit(rest: string[]): Promise<number> {
  const args = parseArgs({
    args: rest,
    options: {
      input: { type: "string" },
      format: { type: "string" },
      out: { type: "string" },
      agent: { type: "string" },
      model: { type: "string" },
      "session-id": { type: "string" },
    },
    allowPositionals: true,
  });
  const input = args.values.input;
  if (!input) throw new HarnessError("emit requires --input <events.json>", "USAGE");
  const format = args.values.format;
  if (!format || (format !== "atif" && format !== "otel")) {
    throw new HarnessError(`emit requires --format <atif|otel> (got '${format ?? ""}')`, "USAGE");
  }
  let raw: string;
  try {
    raw = await fs.readFile(input, "utf8");
  } catch (e) {
    throw new HarnessError(`cannot read --input '${input}': ${e instanceof Error ? e.message : e}`, "IO");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new HarnessError(`--input '${input}' is not valid JSON: ${e instanceof Error ? e.message : e}`, "IO");
  }
  const stream = EventStreamSchema.safeParse(parsed);
  if (!stream.success) {
    throw new HarnessError(`--input '${input}' must be an event array or {events: [...]}`, "IO");
  }
  const events = stream.data as unknown as AgentEvent[];

  let body: string;
  if (format === "atif") {
    const writer = AtifWriter.fromEvents(events, {
      agent: args.values.agent ?? "unknown-agent",
      version: "0.1.0",
      modelName: args.values.model ?? "unknown-model",
      sessionId: args.values["session-id"],
    });
    if (args.values.out) {
      const doc = writer.finalize(args.values.out);
      body = JSON.stringify(doc, null, 2) + "\n";
      const { ok, errors } = AtifWriter.validate(path.resolve(args.values.out));
      if (!ok) {
        throw new HarnessError(`ATIF validation failed for '${args.values.out}':\n${errors.join("\n")}`, "EMIT");
      }
    } else {
      body = JSON.stringify(writer.toTrajectory(), null, 2) + "\n";
    }
  } else {
    const doc = toOtlpJson(events, {
      sessionId: args.values["session-id"] ?? "unknown-session",
      agentName: args.values.agent ?? "unknown-agent",
      model: args.values.model ?? "unknown-model",
    });
    body = JSON.stringify(doc, null, 2) + "\n";
    if (args.values.out) await fs.writeFile(args.values.out, body);
  }
  if (args.values.out) {
    process.stdout.write(`wrote ${args.values.out}\n`);
  } else {
    process.stdout.write(body);
  }
  return 0;
}

// ---------------------------------------------------------------- dispatch

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "run":
      return cmdRun(rest);
    case "watch":
      return cmdWatch(rest);
    case "stats":
      return cmdStats(rest);
    case "emit":
      return cmdEmit(rest);
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE + "\n");
      return 0;
    default:
      process.stderr.write(USAGE + "\n");
      if (cmd === undefined) return 1;
      throw new HarnessError(`unknown subcommand '${cmd}'`, "USAGE");
  }
}

main(process.argv.slice(2))
  .catch((err: unknown) => {
    if (err instanceof HarnessError) {
      process.stderr.write(`harness: ${err.message}\n`);
      return err.exitCode;
    }
    const msg = err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ""}` : String(err);
    process.stderr.write(`harness: unexpected error — ${msg}\n`);
    return 1;
  })
  .then((code) => process.exit(code));
