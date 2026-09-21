// harness — unified CLI for driving agents, watching usage, aggregating
// stats, and emitting interchange formats. Single entry, hand-rolled dispatch
// (node:util parseArgs); no external CLI framework. Stdlib + zod only.
//
// This module doubles as the legacy LIBRARY import surface: importing
// dist/cli/ach.js (or this source) as a module yields the programmatic API
// via the re-export below with NO CLI side effects — main() only runs when
// this file is the process entry point (bin execution).
export * from "../index.ts";
import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import {
  AGENTS,
  AcpMcpServerSchema,
  HarnessError,
  isKnownAgent,
  KiroConfigSchema,
  type AcpMcpServer,
  type AgentEvent,
  type KiroConfig,
  type RunResult,
} from "../core/types.ts";
import { z } from "zod";
import { createDriver, defaultAdapters } from "../core/driver.ts";
import { VERSION } from "../version.ts";
import { stateDir, loadOffsets, saveOffsets, appendRecords, readAllRecords, type StatRecord } from "../core/store.ts";
import { AtifWriter } from "../emitters/atif.ts";
import { toOtlpJson } from "../emitters/otel.ts";
import { emitToLangfuse } from "../emitters/langfuse.ts";
import {
  parseClaudeTranscript,
  parseCodexRollout,
  parseGeminiChat,
  scanAll,
} from "../monitors/transcripts.ts";
import { statsFromDb } from "../adapters/opencode.ts";
import { createPricer } from "../core/pricing.ts";
import { aggregate, fmtInt, fmtUsd, formatEventLine, formatSummary, type AggregatableRecord } from "./lib.ts";
import { kiroPreflight } from "../adapters/kiro-preflight.ts";
import { cmdReport } from "./report.ts";
import { cmdDash } from "./dash.ts";
import { cmdServe } from "./serve.ts";
import { cmdWeb } from "./web.ts";
import { cmdMcp } from "./mcp.ts";

const USAGE = `ach — agentic-coding-harness · run, watch & meter coding agents
version: ${VERSION}

usage:
  ach --version | -v        print the harness version
  ach run --agent <claude|opencode|kiro|codex|gemini> [--model M] [--resume SID]
              [--budget-usd N] [--max-turns N] [--wall-ms MS] [--idle-ms MS] [--json] "<prompt>"
              claude only: [--claude-default-config]  (use the default, authenticated
                           CLAUDE_CONFIG_DIR instead of a per-run one; or env
                           AGENTIC_CODING_HARNESS_DEFAULT_CLAUDE_CONFIG=1)
              kiro only: [--kiro-transport headless|acp] [--kiro-agent A] [--kiro-engine v1|v2|v3]
                         [--kiro-effort E] [--kiro-tools all|none|a,b] [--kiro-require-mcp-startup]
                         [--kiro-startup-ms MS] [--kiro-require-model-ack]
                         [--kiro-mcp-server '<json>']...
  ach preflight --agent kiro [--model M] [--kiro-agent A] [--kiro-transport acp]
                    [--cwd DIR] [--json] [--kiro-startup-ms MS] [--kiro-mcp-server '<json>']...
                    (proves binary/auth/agent/model/set_model-ack/MCP over a real
                     ACP handshake; sends NO prompt, so it spends no tokens)
  ach watch [--dir <transcriptDir>]
  ach stats [--agent A] [--days N] [--json] [--state-only]
                (machine claude/codex/gemini transcripts + harness state;
                 --state-only skips machine transcript dirs)
  ach emit --input <events.json> --format <atif|otel|langfuse> [--out path]
               [--agent A] [--model M] [--session-id SID]
               (langfuse POSTs OTLP to the Langfuse instance; auth via
                --langfuse-url/--langfuse-public-key/--langfuse-secret-key or
                env LANGFUSE_URL|LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY,
                LANGFUSE_SECRET_KEY)
  ach report <trials-dir> [--out path]
                 (single-file HTML comparison; a trials/ root scans subdirs)
  ach dash [--json] [--all] [--dir <stateDir>]
               (live run dashboard; --json dumps RunRecords and exits)
  ach serve [--http] [--port N=8398] [--host 127.0.0.1] [--token T]
                (MCP over streamable HTTP on POST /mcp; GET /health probe;
                 token via --token or env AGENTIC_CODING_HARNESS_HTTP_TOKEN)
  ach web [trials-dir] [--port N=8399] [--host 127.0.0.1] [--token T]
              [--dir D] [--no-open] [--source URL] [--source-token T]
              [--source-mode poll|sse|ws] [--source-poll-ms N=3000]
              [--source-merge state|only=only]
                (browser dashboard over the live registry; token via --token
                  or env AGENTIC_CODING_HARNESS_HTTP_TOKEN; --no-open skips the browser;
                  --source reads runs from an external http(s) feed instead of the
                  state dir — flags or env AGENTIC_CODING_HARNESS_SOURCE[_TOKEN|_MODE|
                  _POLL_MS|_MERGE]; --source-token falls back to --token;
                  --source-merge state unions the local registry under the feed)
  ach mcp [--gateway --root R] [--max-jobs N] [--max-output-bytes N] [--allow-extra-args A]
              (MCP over stdio: newline-delimited JSON-RPC on stdin/stdout, Content-Length
               framing tolerated; same tools and gateway flags as \`ach serve\`)

env:
  AGENTIC_CODING_HARNESS_STATE_DIR   state root (default ~/.agentic-coding-harness)
  AGENTIC_CODING_HARNESS_HTTP_TOKEN  default for serve --token (CLI flags win over env)
  AGENTIC_CODING_HARNESS_BUDGET_USD  default for --budget-usd (CLI flags win over env)
  AGENTIC_CODING_HARNESS_MAX_TURNS   default for --max-turns (CLI flags win over env)
  AGENTIC_CODING_HARNESS_WALL_MS     default for --wall-ms (CLI flags win over env)
  AGENTIC_CODING_HARNESS_IDLE_MS     default for --idle-ms (CLI flags win over env)`;

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

/** CLI flag value wins; otherwise fall back to an env default (parsed like the flag). */
function optNumWithEnv(flagVal: string | undefined, flag: string, envName: string): number | undefined {
  if (flagVal !== undefined) return optNum(flagVal, flag);
  const envVal = process.env[envName];
  if (envVal === undefined || envVal === "") return undefined;
  return optNum(envVal, envName);
}

function optIntWithEnv(flagVal: string | undefined, flag: string, envName: string): number | undefined {
  if (flagVal !== undefined) return optInt(flagVal, flag);
  const envVal = process.env[envName];
  if (envVal === undefined || envVal === "") return undefined;
  return optInt(envVal, envName);
}

/** Positive-integer flag (unlike optInt, 0 is not allowed — startupMs is a budget). */
function optPositiveInt(v: string | undefined, flag: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw new HarnessError(`${flag} expects a positive integer, got '${v}'`, "USAGE");
  }
  return n;
}

/** `--kiro-mcp-server` (repeatable): each value is a JSON object of the
 *  AcpMcpServer shape ({name, command, args?, env?}, strict). Shared by
 *  `run` and `preflight` so the error text and validation never drift. */
function optAcpMcpServers(values: string[] | undefined, flag: string): AcpMcpServer[] | undefined {
  if (values === undefined) return undefined;
  return values.map((raw) => {
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      throw new HarnessError(
        `${flag} expects a JSON object, got '${raw}': ${e instanceof Error ? e.message : String(e)}`,
        "USAGE",
      );
    }
    const parsed = AcpMcpServerSchema.safeParse(obj);
    if (!parsed.success) {
      throw new HarnessError(
        `${flag} '${raw}' does not match {name, command, args?, env?}: ${parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ")}`,
        "USAGE",
      );
    }
    return parsed.data;
  });
}

// ---------------------------------------------------------------- run

/** `--kiro-*` flags → KiroConfig (undefined when no flag was given, so the
 *  driver sees exactly what the caller asked for and nothing implied). */
function kiroConfigFromFlags(v: {
  "kiro-transport"?: string;
  "kiro-agent"?: string;
  "kiro-engine"?: string;
  "kiro-effort"?: string;
  "kiro-tools"?: string;
  "kiro-require-mcp-startup"?: boolean;
  "kiro-startup-ms"?: string;
  "kiro-require-model-ack"?: boolean;
  "kiro-mcp-server"?: string[];
}): KiroConfig | undefined {
  const cfg: Record<string, unknown> = {};
  if (v["kiro-transport"] !== undefined) cfg.transport = v["kiro-transport"];
  if (v["kiro-agent"] !== undefined) cfg.agent = v["kiro-agent"];
  if (v["kiro-engine"] !== undefined) cfg.engine = v["kiro-engine"];
  if (v["kiro-effort"] !== undefined) cfg.effort = v["kiro-effort"];
  if (v["kiro-tools"] !== undefined) {
    const t = v["kiro-tools"];
    cfg.tools = t === "all" || t === "none" ? t : t.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (v["kiro-require-mcp-startup"]) cfg.requireMcpStartup = true;
  const startupMs = optPositiveInt(v["kiro-startup-ms"], "--kiro-startup-ms");
  if (startupMs !== undefined) cfg.startupMs = startupMs;
  if (v["kiro-require-model-ack"]) cfg.requireModelAck = true;
  const mcpServers = optAcpMcpServers(v["kiro-mcp-server"], "--kiro-mcp-server");
  if (mcpServers !== undefined) cfg.mcpServers = mcpServers;
  if (Object.keys(cfg).length === 0) return undefined;
  const parsed = KiroConfigSchema.safeParse(cfg);
  if (!parsed.success) {
    throw new HarnessError(`invalid --kiro-* flags: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, "USAGE");
  }
  return parsed.data;
}

async function cmdRun(rest: string[]): Promise<number> {
  const args = parseArgs({
    args: rest,
    options: {
      agent: { type: "string" },
      model: { type: "string" },
      resume: { type: "string" },
      "budget-usd": { type: "string" },
      "max-turns": { type: "string" },
      "wall-ms": { type: "string" },
      "idle-ms": { type: "string" },
      "extra-args": { type: "string" },
      // Kiro-only typed config (src/core/types.ts KiroConfig). Ignored for
      // other agents; the driver's RunSpecSchema validates the shape.
      "kiro-transport": { type: "string" },
      "kiro-agent": { type: "string" },
      "kiro-engine": { type: "string" },
      "kiro-effort": { type: "string" },
      "kiro-tools": { type: "string" },
      "kiro-require-mcp-startup": { type: "boolean", default: false },
      "kiro-startup-ms": { type: "string" },
      "kiro-require-model-ack": { type: "boolean", default: false },
      "claude-default-config": { type: "boolean", default: false },
      "kiro-mcp-server": { type: "string", multiple: true },
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

  // The adapter registry takes no options (driver.ts defaultAdapters), so the
  // flag travels as the env var the Claude adapter already honours.
  if (args.values["claude-default-config"]) process.env.AGENTIC_CODING_HARNESS_DEFAULT_CLAUDE_CONFIG = "1";

  const onEvent = (e: AgentEvent) => process.stderr.write(formatEventLine(e) + "\n");
  const driver = createDriver({
    adapters: await defaultAdapters(),
    stateDir: stateDir(),
    pricer: createPricer(),
    onEvent,
    registry: { stateDir: stateDir() },
  });

  let result: RunResult;
  try {
    result = await driver.run(agent, {
      prompt,
      model: args.values.model,
      resume: args.values.resume,
      budget: {
        usd: optNumWithEnv(args.values["budget-usd"], "--budget-usd", "AGENTIC_CODING_HARNESS_BUDGET_USD"),
        maxTurns: optIntWithEnv(args.values["max-turns"], "--max-turns", "AGENTIC_CODING_HARNESS_MAX_TURNS"),
        wallMs: optNumWithEnv(args.values["wall-ms"], "--wall-ms", "AGENTIC_CODING_HARNESS_WALL_MS"),
        idleMs: optNumWithEnv(args.values["idle-ms"], "--idle-ms", "AGENTIC_CODING_HARNESS_IDLE_MS"),
      },
      extraArgs: args.values["extra-args"]?.split(" ").filter(Boolean),
      ...(agent === "kiro" ? { kiro: kiroConfigFromFlags(args.values) } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new HarnessError(message, "RUN_FAILED");
  }
  for (const w of result.warnings) process.stderr.write(`[warn] ${w}\n`);

  const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  let lastModel: string | undefined;
  let totalCredits: number | undefined;
  let kiroSession: string | undefined;
  for (const t of result.tokens) {
    sum.input += t.inputTokens;
    sum.output += t.outputTokens;
    sum.cacheRead += t.cacheReadTokens;
    sum.cacheWrite += t.cacheWriteTokens;
    sum.reasoning += t.reasoningTokens ?? 0;
    if (t.model) lastModel = t.model;
    // Kiro metering credits (MITM tap, extra.credits): metering units, not
    // USD — summed separately, never into totalCost.
    const credits = t.extra?.credits;
    if (typeof credits === "number" && Number.isFinite(credits)) {
      totalCredits = (totalCredits ?? 0) + credits;
    }
    // Kiro native session id (extra.kiroSessionId): the bare uuid kiro-cli
    // writes on disk, kept for grep correlation against the namespaced
    // harness sessionId (`kiro-<uuid>`).
    if (kiroSession === undefined && typeof t.extra?.kiroSessionId === "string" && t.extra.kiroSessionId !== "") {
      kiroSession = t.extra.kiroSessionId;
    }
  }

  if (args.values.json) {
    // Full RunResult: sessionId, events, tokens, totalCost, durationMs,
    // exitStatus, warnings.
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    let summary = formatSummary({
      agent,
      sessionId: result.sessionId,
      model: args.values.model ?? lastModel,
      tokens: sum,
      costUsd: result.totalCost,
      durationMs: result.durationMs,
      exitStatus: result.exitStatus,
      ...(result.usage !== undefined ? { usage: result.usage } : {}),
    });
    if (totalCredits !== undefined) summary += `\ncredits    ${totalCredits.toFixed(2)}`;
    if (agent === "kiro" && kiroSession !== undefined) summary += `\nkiroSession ${kiroSession}`;
    process.stdout.write(summary + "\n");
  }
  return result.exitStatus === "success" ? 0 : 1;
}

// ------------------------------------------------------------ preflight

/** `ach preflight --agent kiro` — see src/adapters/kiro-preflight.ts.
 *  Exit 0 only when no check failed. Kiro is the only agent with a preflight
 *  today; another agent is a USAGE error, never a silent pass. */
async function cmdPreflight(rest: string[]): Promise<number> {
  const args = parseArgs({
    args: rest,
    options: {
      agent: { type: "string" },
      model: { type: "string" },
      cwd: { type: "string" },
      "kiro-agent": { type: "string" },
      "kiro-transport": { type: "string" },
      "kiro-startup-ms": { type: "string" },
      "kiro-mcp-server": { type: "string", multiple: true },
      "extra-args": { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const agent = args.values.agent;
  if (agent !== "kiro") {
    throw new HarnessError(
      `preflight supports --agent kiro only (got '${agent ?? "<missing>"}')`,
      "USAGE",
    );
  }
  const transport = args.values["kiro-transport"] ?? "acp";
  if (transport !== "acp") {
    throw new HarnessError(
      `preflight requires --kiro-transport acp (got '${transport}'): the checks are ACP handshake observations`,
      "USAGE",
    );
  }
  // startupMs/mcpServers are meaningful here: kiroPreflight's handshake spawns
  // the ACP client with kiro.startupMs and forwards kiro.mcpServers to
  // session/new (see src/adapters/kiro-preflight.ts). requireModelAck is a
  // run-time (session/prompt) gate and has no preflight equivalent.
  const startupMs = optPositiveInt(args.values["kiro-startup-ms"], "--kiro-startup-ms");
  const mcpServers = optAcpMcpServers(args.values["kiro-mcp-server"], "--kiro-mcp-server");
  const extraArgs = args.values["extra-args"]?.split(" ").filter(Boolean);
  const receipt = await kiroPreflight({
    cwd: args.values.cwd ?? process.cwd(),
    ...(args.values.model !== undefined ? { model: args.values.model } : {}),
    kiro: {
      transport: "acp",
      ...(args.values["kiro-agent"] !== undefined ? { agent: args.values["kiro-agent"] } : {}),
      ...(startupMs !== undefined ? { startupMs } : {}),
      ...(mcpServers !== undefined ? { mcpServers } : {}),
    },
    ...(extraArgs !== undefined ? { extraArgs } : {}),
  });
  if (args.values.json) {
    process.stdout.write(JSON.stringify(receipt, null, 2) + "\n");
  } else {
    for (const c of receipt.checks) {
      process.stdout.write(`${c.status.padEnd(8)} ${c.name.padEnd(11)} ${c.detail} (${c.ms}ms)\n`);
    }
    process.stdout.write(`ok       ${String(receipt.ok)}\n`);
    for (const u of receipt.unproven) process.stdout.write(`unproven ${u}\n`);
  }
  return receipt.ok ? 0 : 1;
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
    // machine transcript dirs by `ach stats`, so copying them into
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
      "state-only": { type: "boolean", default: false },
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
  // --state-only skips this scan entirely: stateDir records only (e.g. on a
  // machine whose transcript dirs are huge or being rotated).
  const pricer = createPricer();
  if (!args.values["state-only"]) {
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
      "langfuse-url": { type: "string" },
      "langfuse-public-key": { type: "string" },
      "langfuse-secret-key": { type: "string" },
    },
    allowPositionals: true,
  });
  const input = args.values.input;
  if (!input) throw new HarnessError("emit requires --input <events.json>", "USAGE");
  const format = args.values.format;
  if (!format || (format !== "atif" && format !== "otel" && format !== "langfuse")) {
    throw new HarnessError(`emit requires --format <atif|otel|langfuse> (got '${format ?? ""}')`, "USAGE");
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

  // When --input is a full RunResult (not just an event stream), inherit its
  // sessionId/agent/model so callers don't have to restate them per-flag.
  const runResult = (parsed && typeof parsed === "object" && !Array.isArray(parsed))
    ? parsed as { sessionId?: unknown; agent?: unknown; model?: unknown; tokens?: unknown }
    : {};
  // RunResult doesn't carry top-level agent/model — fall back to the first
  // token record's fields so Langfuse span names stay meaningful.
  const firstToken = Array.isArray(runResult.tokens) && runResult.tokens.length > 0
    ? runResult.tokens[0] as { agent?: unknown; model?: unknown }
    : {};
  const defaultSessionId = typeof runResult.sessionId === "string" && runResult.sessionId !== ""
    ? runResult.sessionId
    : "unknown-session";
  const defaultAgent =
    (typeof runResult.agent === "string" && runResult.agent !== "" && runResult.agent) ||
    (typeof firstToken.agent === "string" && firstToken.agent !== "" && firstToken.agent) ||
    "unknown-agent";
  const defaultModel =
    (typeof runResult.model === "string" && runResult.model !== "" && runResult.model) ||
    (typeof firstToken.model === "string" && firstToken.model !== "" && firstToken.model) ||
    "unknown-model";

  let body: string;
  if (format === "atif") {
    const writer = AtifWriter.fromEvents(events, {
      agent: args.values.agent ?? defaultAgent,
      version: VERSION,
      modelName: args.values.model ?? defaultModel,
      sessionId: args.values["session-id"] ?? defaultSessionId,
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
  } else if (format === "langfuse") {
    const baseUrl =
      args.values["langfuse-url"] ??
      process.env.LANGFUSE_URL ??
      process.env.LANGFUSE_HOST ??
      "http://localhost:3000";
    const publicKey = args.values["langfuse-public-key"] ?? process.env.LANGFUSE_PUBLIC_KEY;
    const secretKey = args.values["langfuse-secret-key"] ?? process.env.LANGFUSE_SECRET_KEY;
    if (!publicKey || !secretKey) {
      throw new HarnessError(
        "emit --format langfuse requires --langfuse-public-key/--langfuse-secret-key " +
          "or env LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY",
        "USAGE",
      );
    }
    let result;
    try {
      result = await emitToLangfuse(events, {
        baseUrl,
        publicKey,
        secretKey,
        sessionId: args.values["session-id"] ?? defaultSessionId,
        agentName: args.values.agent ?? defaultAgent,
        model: args.values.model ?? defaultModel,
      });
    } catch (e) {
      throw new HarnessError(
        `langfuse ingest to '${baseUrl}' failed: ${e instanceof Error ? e.message : e}`,
        "EMIT",
      );
    }
    if (!result.ok) {
      throw new HarnessError(
        `langfuse ingest failed (HTTP ${result.status}) at ${result.url}: ${result.body.slice(0, 500)}`,
        "EMIT",
      );
    }
    if (args.values.out) {
      await fs.writeFile(args.values.out, JSON.stringify(result.payload, null, 2) + "\n");
    }
    process.stdout.write(
      `langfuse: posted ${result.spanCount} spans to ${result.url} — trace ${result.traceId} (HTTP ${result.status})` +
        (args.values.out ? `, wrote ${args.values.out}` : "") +
        "\n",
    );
    return 0;
  } else {
    const doc = toOtlpJson(events, {
      sessionId: args.values["session-id"] ?? defaultSessionId,
      agentName: args.values.agent ?? defaultAgent,
      model: args.values.model ?? defaultModel,
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
    case "preflight":
      return cmdPreflight(rest);
    case "watch":
      return cmdWatch(rest);
    case "stats":
      return cmdStats(rest);
    case "emit":
      return cmdEmit(rest);
    case "report":
      return cmdReport(rest);
    case "dash":
      return cmdDash(rest);
    case "serve":
      return cmdServe(rest);
    case "web":
      return cmdWeb(rest);
    case "mcp":
      return cmdMcp(rest);
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE + "\n");
      return 0;
    case "--version":
    case "-v":
      process.stdout.write(VERSION + "\n");
      return 0;
    default:
      process.stderr.write(USAGE + "\n");
      if (cmd === undefined) return 1;
      throw new HarnessError(`unknown subcommand '${cmd}'`, "USAGE");
  }
}

/**
 * True only when this module IS the running program: the resolved process
 * entry (argv[1]) and this file are the same file on disk (realpath on both
 * sides, so npm bin symlinks and launchers resolve to the real bundle).
 *
 * - bin execution (`ach …`, `node dist/cli/ach.js …`, `bun dist/bun/ach.js …`,
 *   `tsx src/cli/ach.ts …`): argv[1] is this file -> run the CLI.
 * - library import (`import('agentic-coding-harness')`,
 *   `await import(pathToFileURL('…/dist/cli/ach.js').href)`): argv[1] is the
 *   CONSUMER's entry (its script / test runner) -> no CLI, no process.exit.
 */
function invokedAsCli(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsCli()) {
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
}
