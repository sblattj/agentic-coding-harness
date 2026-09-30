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
  AcpMcpServerSchema,
  HarnessError,
  isKnownAgent,
  KiroConfigSchema,
  type AcpMcpServer,
  type AgentEvent,
  type KiroConfig,
  type RunResult,
  type RunSpec,
} from "../core/types.ts";
import { DEFAULT_VERIFY_TIMEOUT_MS, type VerifyResult } from "../core/verify.ts";
import {
  formatRepeatGroupLine,
  formatStatsInline,
  formatVerifyLine,
  outcomeStats,
  repeatGroupRollup,
  runOnce,
  runRepeatGroup,
  type RunLabels,
  type TrialOutcome,
  type VerifyRequest,
} from "./trials.ts";
import { cmdRegrade } from "./regrade.ts";
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
  transcriptAgentNames,
  transcriptSources,
  scanOptionsForRoot,
  walkFiles,
} from "../monitors/transcripts.ts";
import { TRANSCRIPT_SOURCES, isTranscriptOnlyAgent, readOnlySourceMessage } from "../monitors/transcript-sources.ts";
import { drainTranscriptWarnings } from "../monitors/transcript-warnings.ts";
import { statsFromDb } from "../adapters/opencode.ts";
import { cacheHitRatio, fmtCacheHit } from "../core/cache-ratio.ts";
import { createPricer } from "../core/pricing.ts";
import { aggregate, extraArgsFromValues, fmtInt, fmtUsd, formatEventLine, formatSummary, joinOptionValues, resolveDirFlag, wantsHelp } from "./lib.ts";
import {
  aggregateDims,
  baseCacheRatios,
  cwdIndex,
  loadProjectAliases,
  parseByDims,
  parseModelAliases,
  projectMatches,
  renderDimsText,
  BY_DIMS,
  type DimRecord,
} from "./stats-dims.ts";
import {
  applyCostMode,
  COST_DISAGREEMENT_PCT,
  COST_MODE_ENV,
  costDisagreement,
  formatDisagreement,
  resolveCostMode,
  selectCost,
  type CostModeBucket,
} from "./cost-mode.ts";
import { statsProvenance, type StatsProvenanceRecord } from "./stats-provenance.ts";
import { markerFor, PROVENANCE_LEGEND, type ProvenanceMap } from "../core/provenance.ts";
import { kiroPreflight } from "../adapters/kiro-preflight.ts";
import {
  inWindow,
  joinAgoTokens,
  parseBy,
  resolveTimeZone,
  resolveWindow,
  TIME_GRANULARITIES,
  TZ_ENV,
  windowJson,
} from "./time-window.ts";
import { cmdReport } from "./report.ts";
import { runContextRows } from "./context-stats.ts";
import { scanRunRecords, skippedRunRecordsWarning } from "../core/registry.ts";
import { cmdDash } from "./dash.ts";
import { statsExtras } from "./usage-render.ts";
import { resolvePlan } from "../core/plans.ts";
import { cmdServe } from "./serve.ts";
import { cmdWeb } from "./web.ts";
import { cmdMcp } from "./mcp.ts";
import { cmdAudit } from "./audit.ts";
import { EXIT_CODES, noDataExitCode, parseExitCodesMode, repeatExitCode, runExitCode } from "./exit-codes.ts";
import { formatOutcomeLine, summarizeRunOutcomes } from "./run-outcomes.ts";
import { alertFlagsToBudget } from "./alerts.ts";
import { cmdStatus } from "./status.ts";
import { cmdStatusline } from "./statusline.ts";
import { cmdQuota } from "./quota.ts";
import { cmdArchive, statsMachineRecords, statsScanOptions, warehouseStateRecords } from "./archive.ts";
import {
  cmdAgents,
  descriptorTapRows,
  findDescriptor,
  loadCatalog,
  reportCatalogIssues,
  resolveRunAgent,
  runnableAgentNames,
  unknownAgentError,
  unmeteredRuns,
} from "./custom-agents.ts";
import { cmdDoctor } from "./doctor.ts";

const USAGE = `ach — agentic-coding-harness · run, watch & meter coding agents
version: ${VERSION}

usage:
  ach --version | -v        print the harness version
  ach run --agent <claude|opencode|kiro|codex|gemini|null> [--model M] [--resume SID]
              [--budget-usd N] [--max-turns N] [--wall-ms MS] [--idle-ms MS] [--json] "<prompt>"
              [--budget-alerts 0.5,0.8,1.0] [--warn-at 0.5,0.8,0.95] [--on-budget abort|warn]
                (threshold alerts warn once per crossing, never abort; fractions in (0,1];
                 'off' disables; state in <stateDir>/alerts.json, see docs/BUDGET-ALERTS.md)
              [--verify '<cmd>' [--verify-timeout-ms MS=120000]]  (checker run in cwd after
                           the agent exits; verdict on the RunRecord, failed checker exits 1; passing checker keeps the run exit code)
              [--repeat N [--parallel K]]  (N fresh sessions, one repeat group; exits with the most severe child code)
              [--experiment E] [--variant V]  (compare-view labels on the RunRecord)
              claude only: [--claude-default-config]  (use the default, authenticated
                           CLAUDE_CONFIG_DIR instead of a per-run one; or env
                           AGENTIC_CODING_HARNESS_DEFAULT_CLAUDE_CONFIG=1)
              null: negative-control smoke test — no CLI binary, no auth, no network,
                    deterministic zero-cost usage (ach run --agent null "<prompt>");
                    env AGENTIC_CODING_HARNESS_NULL_EXIT=error|timeout|budget_exceeded
                    forces that exitStatus; AGENTIC_CODING_HARNESS_NULL_TURNS=N sets
                    the scripted turn count (default 1)
              kiro only: [--kiro-transport headless|acp] [--kiro-agent A] [--kiro-engine v1|v2|v3]
                         [--kiro-effort E] [--kiro-tools all|none|a,b] [--kiro-require-mcp-startup]
                         [--kiro-startup-ms MS] [--kiro-require-model-ack]
                         [--kiro-mcp-server '<json>']...
  ach run --agent custom --template '<cmd {prompt}>' [--prompt-stdin] [--template-shell] [--model M] "<prompt>"
              any CLI via a template; placeholders {prompt} {model} {workspace} (= cwd).
              The template is split argv-style and spawned WITHOUT a shell: the prompt
              is always one literal argument (quotes, spaces, $() are never evaluated).
              --prompt-stdin   write the prompt to the CLI's stdin ({prompt} not needed)
              --template-shell run the template via /bin/sh -c. RISK: the template itself is shell
                               code (pipes, globs, $vars expand); placeholder values are passed as
                               "$ACH_PROMPT"/"$ACH_MODEL"/"$ACH_WORKSPACE", never pasted in — do
                               not quote placeholders yourself
              no usage source: the run is recorded metering=none (tokens/cost n/a)
  ach run --agent <agents.d name> ...  drop-in descriptor (.ach/agents.d/ or <state>/agents.d/;
              see docs/CUSTOM-AGENTS.md)
  ach agents [--json]       list built-in agents, agents.d descriptors and descriptor errors
  ach preflight --agent kiro [--model M] [--kiro-agent A] [--kiro-transport acp]
                    [--cwd DIR] [--json] [--kiro-startup-ms MS] [--kiro-mcp-server '<json>']...
                    (proves binary/auth/agent/model/set_model-ack/MCP over a real
                     ACP handshake; sends NO prompt, so it spends no tokens)
  ach doctor [--agent A] [--model M] [--cwd DIR] [--claude-default-config] [--json]
                 (all five agents by default: binary+version, auth material, model,
                  MCP config, plus state dir / pricing table / env sanity; kiro runs
                  the preflight handshake. Sends NO prompt; exit 1 if any check failed)
  ach regrade <run-id> --verify '<cmd>' [--verify-timeout-ms MS] [--json]
                (re-run a checker against a saved run's cwd; appends to the record's
                 regrades[] — no agent launched, run-time verify never rewritten)
  ach watch [--transcript-dir <home-shaped-root>] [--since DATE | --last D] [--tz Z]
                (--since/--last: print history newer than the bound on startup;
                 --dir is an alias of --transcript-dir here)
  ach stats [--agent A] [--days N | --since DATE [--until DATE] | --last D]
            [--tz Z] [--by day|week|month] [--json] [--state-only] [--include-unavailable]
                (machine claude/codex/gemini transcripts, read-only
                 amp/goose/qwen stores, + harness state;
                 --state-only skips machine transcript dirs; agents.d usage taps
                 count as machine transcripts; metering=none runs are a separate
                 "unmetered" group, never zeros in the totals;
                 window is [--since, --until): since inclusive, until exclusive;
                 --until alone = everything before it; --last 7d = --since "7d ago";
                 DATE: YYYY-MM-DD | RFC 3339 | '<N>m|h|d|w ago' | today | yesterday | now;
                 --tz: IANA zone, utc or local (default local) for day/week/month
                 boundaries and bare dates; --by week = ISO weeks (2026-W39),
                 month = 2026-09, comma lists allowed; run success rate
                 excludes 'unavailable' runs unless --include-unavailable)
            [--by model|project]... [--merge-models] [--model-alias FROM=TO]...
            [--project NAME] [--project-alias PATH=NAME]... [--project-aliases FILE.json]
                (--by takes time granularities and dimensions together, e.g.
                 --by week,model; --by model: agent/model rows + model x day table;
                 --by project: repo-root rollup, aliases also via
                 AGENTIC_CODING_HARNESS_PROJECT_ALIASES; every row shows
                 cacheHit = cacheRead/(input+cacheRead+cacheWrite))
            [--blocks] [--budget-usd N]
            [--plan pro|max5|max20|custom [--plan-window-tokens N --plan-window-usd N
             [--plan-window-messages N]]]
                (--blocks: Claude 5h billing windows; a block starts at its first
                 event floored to the hour and spans 5h; active block shows
                 burn = cost / (now - first event) and projected = cost + burn
                 x time left. Always: pace over trailing 15m/1h windows, ETA to
                 --budget-usd. --plan frames the active window as % of the
                 plan allowance; built-in presets are community estimates)
            [--with-warehouse] [--transcript-dir <root>]
                (--with-warehouse adds archived copies whose live file is gone;
                 --transcript-dir reads machine transcripts from
                 <root>/.claude/projects etc., e.g. a restore; --dir is an
                 alias of --transcript-dir here, NOT a state dir)
  ach archive [--agent A] [--days N] [--out DIR] [--state-dir <stateDir>] [--json]
  ach archive --restore <batch|latest|all> [--to DIR] [--out DIR] [--json]
                (snapshot transcripts + RunRecords into <stateDir>/warehouse,
                 sha256-deduped, never deletes; see docs/ARCHIVE.md;
                 --dir is an alias of --state-dir here)
  --exit-codes ladder   (run / stats / status / watch) automation exit codes: 0 ok,
                        10 near-limit, 11 limit hit, 20 unavailable, 30 no data,
                        1 errors — see docs/EXIT-CODES.md; default stays 0/1
  ach audit [--agent A] [--days N] [--json] [--tolerance-pct P] [--fix] [--state-dir <stateDir>]
                (re-derive each RunRecord's token/cost totals from its raw transcript
                 and report recorded vs recomputed deltas; exit 1 on drift;
                 --fix rewrites drifted totals and logs RunRecord.corrections;
                 --dir is an alias of --state-dir here)
  ach status [--compact|--json] [--transcripts] [--budget-usd N] [--exit-codes ladder]
             [--once] [--write-state <path>] [--interval-ms MS=5000]
                (runs, active runs, trailing-24h spend = \`stats --days 1\`,
                 budget left; --write-state writes the snapshot atomically,
                 once with --once, else every --interval-ms; see docs/STATUS.md)
  ach statusline [--chain "<cmd>"] [--separator " | "] [--chain-timeout-ms MS]
                 [--cache <path>] [--max-age-ms MS] [--no-cache] [--transcripts]
                (Claude Code statusLine.command: reads its JSON on stdin, prints
                 model · session · today · block · budget; --chain keeps your
                 existing statusline in front)
            [--cost-mode auto|calculate|display] (also AGENTIC_CODING_HARNESS_COST_MODE)
  ach emit --input <events.json> --format <atif|otel|langfuse> [--out path]
               [--agent A] [--model M] [--session-id SID]
               (langfuse POSTs OTLP to the Langfuse instance; auth via
                --langfuse-url/--langfuse-public-key/--langfuse-secret-key or
                env LANGFUSE_URL|LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY,
                LANGFUSE_SECRET_KEY)
  ach report <trials-dir> [--out path]
                 (single-file HTML comparison; a trials/ root scans subdirs)
  ach dash [--json] [--all] [--state-only] [--state-dir <stateDir>] [--budget-usd N]
               (live run dashboard; --json dumps RunRecords and exits; live
                runs get a pace row: $/h + tok/min over 15m/1h, budget ETA;
                QUOTA column shows vendor-reported headroom per agent;
                --dir is an alias of --state-dir here)
  ach quota [--json] [--agent A]
                (vendor-reported subscription headroom per agent: window, used,
                 time remaining, % left; n/a where the vendor reports nothing)
  ach quota ingest claude
                (reads Claude Code statusline JSON on stdin and snapshots its
                 rate_limits; call it from your statusLine script)
  ach serve [--http] [--port N=8398] [--host 127.0.0.1] [--token T]
                (MCP over streamable HTTP on POST /mcp; GET /health probe;
                 token via --token or env AGENTIC_CODING_HARNESS_HTTP_TOKEN)
  ach web [trials-dir] [--port N=8399] [--host 127.0.0.1] [--token T]
              [--state-dir <stateDir>] [--no-open] [--source URL] [--source-token T]
              [--source-mode poll|sse|ws] [--source-poll-ms N=3000]
              [--source-merge state|only=only]
                (browser dashboard over the live registry; token via --token
                  or env AGENTIC_CODING_HARNESS_HTTP_TOKEN; --no-open skips the browser;
                  --source reads runs from an external http(s) feed instead of the
                  state dir — flags or env AGENTIC_CODING_HARNESS_SOURCE[_TOKEN|_MODE|
                  _POLL_MS|_MERGE]; --source-token falls back to --token;
                  --source-merge state unions the local registry under the feed;
                  --dir is an alias of --state-dir here)
  ach mcp [--gateway --root R] [--max-jobs N] [--max-output-bytes N] [--allow-extra-args A]
              (MCP over stdio: newline-delimited JSON-RPC on stdin/stdout, Content-Length
               framing tolerated; same tools and gateway flags as \`ach serve\`)

env:
  AGENTIC_CODING_HARNESS_STATE_DIR   state root (default ~/.agentic-coding-harness)
  AGENTIC_CODING_HARNESS_HTTP_TOKEN  default for serve --token (CLI flags win over env)
  AGENTIC_CODING_HARNESS_BUDGET_USD  default for --budget-usd (CLI flags win over env)
  AGENTIC_CODING_HARNESS_MAX_TURNS   default for --max-turns (CLI flags win over env)
  AGENTIC_CODING_HARNESS_WALL_MS     default for --wall-ms (CLI flags win over env)
  AGENTIC_CODING_HARNESS_IDLE_MS     default for --idle-ms (CLI flags win over env)
  AGENTIC_CODING_HARNESS_BUDGET_ALERTS    default for --budget-alerts (CLI flags win over env)
  AGENTIC_CODING_HARNESS_WARN_THRESHOLDS  default for --warn-at (CLI flags win over env)
  AGENTIC_CODING_HARNESS_WARN_COOLDOWN_H  hours before a threshold may re-alert (default 24)
  AGENTIC_CODING_HARNESS_TZ          default for stats/watch --tz (CLI flags win over env)
  AGENTIC_CODING_HARNESS_PLAN        default for stats --plan (CLI flags win over env;
                                     also _PLAN_WINDOW_TOKENS/_USD/_MESSAGES)
  AGENTIC_CODING_HARNESS_QUOTA_CODEX_DIR    quota: Codex rollouts dir (default ~/.codex/sessions)
  AGENTIC_CODING_HARNESS_QUOTA_CLAUDE_FILE  quota: Claude snapshot (default <state>/quota/claude.json)
  AGENTIC_CODING_HARNESS_NULL_EXIT   --agent null only: force exitStatus (error|timeout|budget_exceeded)
  AGENTIC_CODING_HARNESS_NULL_TURNS  --agent null only: scripted turn count (default 1)`;

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
      "budget-alerts": { type: "string" },
      "warn-at": { type: "string" },
      "on-budget": { type: "string" },
      "extra-args": { type: "string", multiple: true },
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
      // Custom agents (#37): per-invocation command template.
      template: { type: "string" },
      "prompt-stdin": { type: "boolean", default: false },
      "template-shell": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      "exit-codes": { type: "string" },
      // Outcome scoring + repeat trials (#29/#57): see src/cli/trials.ts.
      verify: { type: "string" },
      "verify-timeout-ms": { type: "string" },
      repeat: { type: "string" },
      parallel: { type: "string" },
      experiment: { type: "string" },
      variant: { type: "string" },
    },
    allowPositionals: true,
  });
  const exitMode = parseExitCodesMode(args.values["exit-codes"]);
  const trialFlags = parseTrialFlags(args.values);
  const agent = args.values.agent;
  if (!agent) throw new HarnessError("run requires --agent <name>", "USAGE");
  // amp/goose/qwen (#22) are read-only transcript sources, never launchable.
  if (isTranscriptOnlyAgent(agent)) throw new HarnessError(readOnlySourceMessage(agent), "READ_ONLY_SOURCE");
  // Built-ins, `custom` (template), or an agents.d descriptor (#38).
  const catalog = isKnownAgent(agent) ? null : loadCatalog();
  if (catalog) reportCatalogIssues(catalog);
  const custom = resolveRunAgent(agent, args.values, catalog ?? { descriptors: [], errors: [], warnings: [] });
  const prompt = args.positionals.join(" ").trim();
  if (!prompt) throw new HarnessError("run requires a prompt argument", "USAGE");

  // The adapter registry takes no options (driver.ts defaultAdapters), so the
  // flag travels as the env var the Claude adapter already honours.
  if (args.values["claude-default-config"]) process.env.AGENTIC_CODING_HARNESS_DEFAULT_CLAUDE_CONFIG = "1";

  const onEvent = (e: AgentEvent) => process.stderr.write(formatEventLine(e) + "\n");
  const basePricer = createPricer();
  const driver = createDriver({
    adapters: custom.adapter ? { ...(await defaultAdapters()), [agent]: custom.adapter } : await defaultAdapters(),
    stateDir: stateDir(),
    pricer: custom.wrapPricer ? custom.wrapPricer(basePricer) : basePricer,
    onEvent,
    registry: { stateDir: stateDir() },
  });

  const budget = {
    usd: optNumWithEnv(args.values["budget-usd"], "--budget-usd", "AGENTIC_CODING_HARNESS_BUDGET_USD"),
    maxTurns: optIntWithEnv(args.values["max-turns"], "--max-turns", "AGENTIC_CODING_HARNESS_MAX_TURNS"),
    wallMs: optNumWithEnv(args.values["wall-ms"], "--wall-ms", "AGENTIC_CODING_HARNESS_WALL_MS"),
    idleMs: optNumWithEnv(args.values["idle-ms"], "--idle-ms", "AGENTIC_CODING_HARNESS_IDLE_MS"),
  };
  // Threshold alerts (#20): parsed with the other budget flags, before launch.
  const alertBudget = alertFlagsToBudget(args.values, budget);
  // #104: `--extra-args` is repeatable; each occurrence splits on spaces
  // (backwards compatibility) and the tokens accumulate in order.
  const extraArgs = extraArgsFromValues(args.values["extra-args"]);
  const spec: RunSpec = {
    prompt,
    model: args.values.model,
    resume: args.values.resume,
    budget: { ...budget, ...alertBudget },
    ...(extraArgs !== undefined ? { extraArgs } : {}),
    ...(agent === "kiro" ? { kiro: kiroConfigFromFlags(args.values) } : {}),
    ...(trialFlags.labels.variant !== undefined ? { variant: trialFlags.labels.variant } : {}),
  };
  const trialOpts = {
    driver,
    agent,
    spec,
    stateDir: stateDir(),
    ...(trialFlags.verify !== undefined ? { verify: trialFlags.verify } : {}),
    labels: trialFlags.labels,
  };

  if (trialFlags.repeat !== undefined) {
    return runRepeatCli(trialOpts, trialFlags.repeat, trialFlags.parallel, args.values.json, args.values.model, exitMode);
  }

  let outcome: TrialOutcome;
  try {
    outcome = await runOnce(trialOpts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Launch-time outage (#60): exit 20 under the ladder, 1 otherwise.
    if (err instanceof HarnessError && err.code === "UNAVAILABLE") {
      throw new HarnessError(message, "UNAVAILABLE", exitMode === "ladder" ? EXIT_CODES.indeterminate : 1);
    }
    throw new HarnessError(message, "RUN_FAILED");
  }
  const result = outcome.result!;
  for (const w of result.warnings) process.stderr.write(`[warn] ${w}\n`);
  if (outcome.annotateFailed) process.stderr.write(`[warn] registry: could not record verify/labels on run ${result.runId}\n`);

  if (args.values.json) {
    // Full RunResult: sessionId, events, tokens, totalCost, durationMs,
    // exitStatus, warnings — plus `verify` only when a checker ran.
    const out = outcome.verify !== undefined ? { ...result, verify: outcome.verify } : result;
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  } else {
    process.stdout.write(runSummaryText(agent, result, args.values.model, outcome.verify) + "\n");
  }
  // A failed --verify checker is a task failure: exit 1 in both modes (the
  // ladder files task failure under 1). Otherwise the #31 ladder decides.
  if (outcome.verify !== undefined && outcome.verify.status !== "pass") return EXIT_CODES.error;
  return runExitCode(result, { mode: exitMode, budget, agent });
}

/** `--repeat N [--parallel K]`: N fresh sessions, one summary block per child
 *  as it settles, then the group line. Default mode: exit 0 only when every
 *  child passed the gate (agent success and, with --verify, checker pass).
 *  Ladder: the most severe child code (`repeatExitCode`). */
async function runRepeatCli(
  opts: Omit<Parameters<typeof runRepeatGroup>[0], "count" | "parallel" | "onSettled">,
  count: number,
  parallel: number | undefined,
  json: boolean,
  modelFlag: string | undefined,
  exitMode: "binary" | "ladder",
): Promise<number> {
  const { group, outcomes } = await runRepeatGroup({
    ...opts,
    count,
    ...(parallel !== undefined ? { parallel } : {}),
    onSettled: (o) => {
      for (const w of o.result?.warnings ?? []) process.stderr.write(`[warn] [${o.index}] ${w}\n`);
      if (o.annotateFailed) process.stderr.write(`[warn] [${o.index}] registry: could not record repeat/verify on the run\n`);
      if (o.error !== undefined) process.stderr.write(`[error] [${o.index}] ${o.error}\n`);
    },
  });
  const succeeded = outcomes.filter((o) => o.result?.exitStatus === "success").length;
  const verified = outcomes.filter((o) => o.verify !== undefined);
  const passed = verified.filter((o) => o.verify!.status === "pass").length;
  const stats = outcomeStats(outcomes);
  if (json) {
    const runs = outcomes.map((o) =>
      o.result !== undefined
        ? { ...o.result, repeat: o.repeat, ...(o.verify !== undefined ? { verify: o.verify } : {}) }
        : { repeat: o.repeat, error: o.error },
    );
    const envelope = {
      repeat: { group, count, attempted: outcomes.length, succeeded, ...(verified.length > 0 ? { verified: verified.length, passed } : {}) },
      ...(stats !== undefined ? { stats } : {}),
      runs,
    };
    process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
  } else {
    for (const o of outcomes) {
      process.stdout.write(`--- repeat ${o.index + 1}/${count} (${group.slice(0, 8)})\n`);
      if (o.result !== undefined) {
        process.stdout.write(runSummaryText(opts.agent, o.result, modelFlag, o.verify) + "\n");
      } else {
        process.stdout.write(`error      ${o.error ?? "unknown"}\n`);
      }
    }
    let line = `repeat     ${outcomes.length} attempted · ${succeeded} succeeded`;
    if (verified.length > 0) line += ` · ${passed}/${verified.length} verified pass`;
    process.stdout.write(`--- group ${group}\n${line}\n`);
    if (stats !== undefined) process.stdout.write(`stats      ${formatStatsInline(stats)}\n`);
  }
  // Most severe child code wins: 1 > 20 > 11 > 10 > 0 (docs/EXIT-CODES.md).
  return repeatExitCode(outcomes, { mode: exitMode, budget: opts.spec.budget, agent: opts.agent });
}

/** Validate the #29/#57 flags up front (before any agent launches). */
function parseTrialFlags(v: {
  verify?: string;
  "verify-timeout-ms"?: string;
  repeat?: string;
  parallel?: string;
  resume?: string;
  experiment?: string;
  variant?: string;
}): { verify?: VerifyRequest; repeat?: number; parallel?: number; labels: RunLabels } {
  const verifyTimeout = optPositiveInt(v["verify-timeout-ms"], "--verify-timeout-ms");
  if (verifyTimeout !== undefined && v.verify === undefined) {
    throw new HarnessError("--verify-timeout-ms requires --verify '<cmd>'", "USAGE");
  }
  if (v.verify !== undefined && v.verify.trim() === "") {
    throw new HarnessError("--verify expects a non-empty command", "USAGE");
  }
  const repeat = optPositiveInt(v.repeat, "--repeat");
  const parallel = optPositiveInt(v.parallel, "--parallel");
  if (parallel !== undefined && repeat === undefined) {
    throw new HarnessError("--parallel requires --repeat N", "USAGE");
  }
  if (repeat !== undefined && v.resume !== undefined) {
    throw new HarnessError("--repeat starts fresh sessions; it cannot be combined with --resume", "USAGE");
  }
  for (const f of ["experiment", "variant"] as const) {
    if (v[f] !== undefined && v[f]!.trim() === "") throw new HarnessError(`--${f} expects a non-empty label`, "USAGE");
  }
  return {
    ...(v.verify !== undefined
      ? { verify: { command: v.verify, timeoutMs: verifyTimeout ?? DEFAULT_VERIFY_TIMEOUT_MS, cwd: process.cwd() } }
      : {}),
    ...(repeat !== undefined ? { repeat } : {}),
    ...(parallel !== undefined ? { parallel } : {}),
    labels: {
      ...(v.experiment !== undefined ? { experiment: v.experiment } : {}),
      ...(v.variant !== undefined ? { variant: v.variant } : {}),
    },
  };
}

/** The human `ach run` summary block (unchanged format; one `verify` line
 *  is appended only when a checker ran). */
function runSummaryText(agent: string, result: RunResult, modelFlag: string | undefined, verify: VerifyResult | undefined): string {
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

  let summary = formatSummary({
    agent,
    sessionId: result.sessionId,
    model: modelFlag ?? lastModel,
    tokens: sum,
    costUsd: result.totalCost,
    durationMs: result.durationMs,
    exitStatus: result.exitStatus,
    ...(result.usage !== undefined ? { usage: result.usage } : {}),
  });
  if (totalCredits !== undefined) summary += `\ncredits    ${totalCredits.toFixed(2)}`;
  if (agent === "kiro" && kiroSession !== undefined) summary += `\nkiroSession ${kiroSession}`;
  if (verify !== undefined) summary += `\n${formatVerifyLine(verify)}`;
  return summary;
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
      "extra-args": { type: "string", multiple: true },
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
  // #104: repeatable, space-split per occurrence — same rule as `run`.
  const extraArgs = extraArgsFromValues(args.values["extra-args"]);
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
    args: joinAgoTokens(rest),
    options: {
      dir: { type: "string" },
      "transcript-dir": { type: "string" },
      since: { type: "string" },
      last: { type: "string" },
      tz: { type: "string" },
      "exit-codes": { type: "string" },
    },
    allowPositionals: true,
  });
  // Accepted for uniformity (#31); watch only ends on SIGINT/SIGTERM (exit 0)
  // and never reaches a verdict, so the ladder has nothing to add here.
  parseExitCodesMode(args.values["exit-codes"]);
  // --since / --last (#26): initial lookback. On the first tick, history
  // newer than the bound is printed as deltas instead of baselined silently.
  const lookback = resolveWindow({
    since: args.values.since,
    last: args.values.last,
    now: Date.now(),
    timeZone: resolveTimeZone(args.values.tz, process.env[TZ_ENV]),
  }).sinceMs;
  // --transcript-dir (alias --dir): a home-shaped root to read transcripts from.
  const transcriptDir = resolveDirFlag(args.values, "transcript-dir");
  const sources = transcriptSources(transcriptDir ? scanOptionsForRoot(path.resolve(transcriptDir)) : {});
  const state = stateDir();
  const offsets = await loadOffsets();
  type WatchTotals = { agent: string; sessionId: string; model: string | null; input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number };
  const seenByFile = new Map<string, Map<string, WatchTotals>>();
  const seenOpencode = new Set<string>();
  const pricer = createPricer();
  process.stderr.write(`watch: ${sources.map((s) => `${s.agent}=${s.dir}`).join(" ")}\n`);
  process.stderr.write(`watch: state=${state}, poll=${POLL_MS / 1000}s — Ctrl-C to stop\n`);

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    saveOffsets(offsets).finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  type WatchedAgent = "claude" | "codex" | "gemini" | (typeof TRANSCRIPT_SOURCES)[number]["agent"];
  interface Watched {
    file: string;
    agent: WatchedAgent;
    parse: (file: string) => Promise<
      Array<{
        agent: WatchedAgent;
        sessionId: string | null;
        timestamp: string | null;
        model: string | null;
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        cacheWrite1h?: number;
        reasoning: number;
      }>
    >;
  }
  let firstTick = true;
  const tick = async (): Promise<void> => {
    // Discover on every poll: sessions and even source directories can be
    // created after watch starts. Dedupe paths within this poll only.
    const watched: Watched[] = [];
    const files = new Set<string>();
    for (const src of sources) {
      for (const file of await walkFiles(src.dir, src.keep)) {
        if (files.has(file)) continue;
        files.add(file);
        watched.push({ file, agent: src.agent, parse: src.parse });
      }
    }
    const deltas = new Map<string, { agent: string; sessionId: string; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; priced: boolean }>();
    const bump = (r: { agent?: string; sessionId?: string | null; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd?: number }) => {
      const agent = r.agent ?? "unknown";
      const sessionId = r.sessionId ?? "unknown";
      const key = `${agent}\u0000${sessionId}`;
      const d = deltas.get(key) ?? { agent, sessionId, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, priced: true };
      d.input += r.inputTokens;
      d.output += r.outputTokens;
      d.cacheRead += r.cacheReadTokens;
      d.cacheWrite += r.cacheWriteTokens;
      d.cost += r.costUsd ?? 0;
      if (r.costUsd === undefined) d.priced = false;
      deltas.set(key, d);
    };
    // Only records scanAll cannot see (opencode SQLite) are persisted to the
    // state dir; claude/codex/gemini history is read straight from the
    // machine transcript dirs by `ach stats`, so copying them into
    // stateDir/raw would double-count.
    const fresh: StatRecord[] = [];

    // --- machine transcripts (claude / codex / gemini)
    for (const w of watched) {
      let fingerprint: number;
      try {
        const st = await fs.stat(w.file);
        const wal = await fs.stat(`${w.file}-wal`).catch(() => null);
        fingerprint = st.mtimeMs + st.size + (wal ? wal.mtimeMs + wal.size : 0);
      } catch { continue; }
      const replay = firstTick && lookback !== undefined;
      const previous = seenByFile.get(w.file);
      if (offsets.files[w.file] === fingerprint && previous && !replay) continue;
      const totals = new Map<string, WatchTotals>();
      const recent = new Map<string, WatchTotals>();
      const collect = (map: Map<string, WatchTotals>, rec: Awaited<ReturnType<typeof w.parse>>[number]): void => {
        const key = `${rec.agent}\0${rec.sessionId}\0${rec.model}`;
        const value = map.get(key) ?? { agent: rec.agent, sessionId: rec.sessionId ?? "unknown", model: rec.model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };
        value.input += rec.input; value.output += rec.output;
        value.cacheRead += rec.cacheRead; value.cacheWrite += rec.cacheWrite;
        value.cacheWrite1h += rec.cacheWrite1h ?? 0;
        map.set(key, value);
      };
      for (const rec of await w.parse(w.file)) {
        collect(totals, rec);
        if (replay && inWindow(rec.timestamp ? Date.parse(rec.timestamp) : NaN, { sinceMs: lookback })) collect(recent, rec);
      }
      for (const [key, value] of replay ? recent : totals) {
        // Baseline on startup even with saved offsets. Later snapshots are
        // cumulative per file/session/model, including legacy Goose totals.
        // A newly discovered post-start file has a zero baseline.
        if (firstTick && !replay && !previous) continue;
        const before = replay ? undefined : previous?.get(key);
        const inputTokens = Math.max(0, value.input - (before?.input ?? 0));
        const outputTokens = Math.max(0, value.output - (before?.output ?? 0));
        const cacheReadTokens = Math.max(0, value.cacheRead - (before?.cacheRead ?? 0));
        const cacheWriteTokens = Math.max(0, value.cacheWrite - (before?.cacheWrite ?? 0));
        const cacheWrite1hTokens = Math.max(0, value.cacheWrite1h - (before?.cacheWrite1h ?? 0));
        if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens === 0) continue;
        const priced = value.model ? pricer.price({ model: value.model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cacheWrite1hTokens }) : NaN;
        bump({ agent: value.agent, sessionId: value.sessionId, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
          ...(Number.isFinite(priced) ? { costUsd: priced } : {}) });
      }
      seenByFile.set(w.file, totals);
      offsets.files[w.file] = fingerprint;
    }

    // --- opencode SQLite store (adapter). First tick baselines silently.
    try {
      for (const s of transcriptDir ? [] : await statsFromDb()) {
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
        if (!firstTick || (lookback !== undefined && s.time_created >= lookback)) bump(canonical);
      }
    } catch {
      /* no opencode db on this machine — claude/codex/gemini tailing still runs */
    }

    if (fresh.length > 0) await appendRecords(fresh);
    for (const w of drainTranscriptWarnings()) process.stderr.write(`[warn] ${w}\n`);
    for (const d of deltas.values()) {
      process.stdout.write(
        `${d.agent.padEnd(8)} ${d.sessionId.slice(0, 12).padEnd(12)} +${fmtInt(d.input)} input +${fmtInt(d.output)} output +${fmtInt(d.cacheRead)} cacheR +${fmtInt(d.cacheWrite)} cacheW ${d.priced ? fmtUsd(d.cost) : "n/a"} source: transcript\n`,
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
    args: joinAgoTokens(rest),
    options: {
      agent: { type: "string" },
      days: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      last: { type: "string" },
      tz: { type: "string" },
      by: { type: "string", multiple: true },
      json: { type: "boolean", default: false },
      "state-only": { type: "boolean", default: false },
      "include-unavailable": { type: "boolean", default: false },
      "exit-codes": { type: "string" },
      // #27 / #43 extra dimensions (src/cli/stats-dims.ts); --by is shared with #44
      "merge-models": { type: "boolean", default: false },
      "model-alias": { type: "string", multiple: true },
      project: { type: "string" },
      "project-alias": { type: "string", multiple: true },
      "project-aliases": { type: "string" },
      // #18 / #19 / #36 blocks, pace, plans (src/cli/usage-render.ts)
      blocks: { type: "boolean", default: false },
      plan: { type: "string" },
      "plan-window-tokens": { type: "string" },
      "plan-window-usd": { type: "string" },
      "plan-window-messages": { type: "string" },
      "budget-usd": { type: "string" },
      "with-warehouse": { type: "boolean", default: false },
      dir: { type: "string" },
      "transcript-dir": { type: "string" },
      "cost-mode": { type: "string" },
    },
    allowPositionals: true,
  });
  const exitMode = parseExitCodesMode(args.values["exit-codes"]);
  // --by carries both #44 calendar granularities (day|week|month) and #27/#43
  // dimensions (model|project); split them before each parser sees its half.
  const byTime: string[] = [];
  const byDims: string[] = [];
  for (const tok of (args.values.by ?? []).flatMap((x) => x.split(",")).map((s) => s.trim()).filter(Boolean)) {
    if ((BY_DIMS as readonly string[]).includes(tok)) byDims.push(tok);
    else if ((TIME_GRANULARITIES as readonly string[]).includes(tok.toLowerCase())) byTime.push(tok);
    else {
      throw new HarnessError(
        `--by: unknown value '${tok}' (expected one of: ${[...TIME_GRANULARITIES, ...BY_DIMS].join(", ")})`,
        "USAGE",
      );
    }
  }
  const costMode = resolveCostMode(args.values["cost-mode"], process.env[COST_MODE_ENV]);
  // --transcript-dir (alias --dir): a home-shaped root for machine transcripts.
  const transcriptDir = resolveDirFlag(args.values, "transcript-dir");

  // Every record gets a reported cost (state lines that carried costUsd; the
  // machine transcripts carry none) and a computed one (token × bundled price,
  // never reading CLI-reported slice costs), then --cost-mode picks between
  // them. `pricer` prices values the mode actually uses, so its unknown-model
  // warnings surface; `probe` prices values used only for the disagreement
  // check, and its warnings are dropped.
  const pricer = createPricer();
  const probe = createPricer();
  const disagreements: string[] = [];
  const costFor = (
    r: Pick<StatRecord, "agent" | "sessionId" | "model" | "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "cacheWrite1hTokens" | "extra">,
    reported: number | undefined,
  ) => {
    const needComputed = costMode === "calculate" || (costMode === "auto" && reported === undefined);
    let computed: number | undefined;
    const priceable = r.model && r.model !== "unknown" && r.extra?.tokensAvailable !== false;
    if (priceable && (needComputed || reported !== undefined)) {
      const c = (needComputed ? pricer : probe).price(
        {
          model: r.model,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          cacheReadTokens: r.cacheReadTokens,
          cacheWriteTokens: r.cacheWriteTokens,
          ...(r.cacheWrite1hTokens !== undefined ? { cacheWrite1hTokens: r.cacheWrite1hTokens } : {}),
          ...(r.extra !== undefined ? { extra: r.extra } : {}),
        },
        { computedOnly: true },
      );
      if (!Number.isNaN(c)) computed = c;
    }
    const d = costDisagreement(reported, computed);
    return { ...selectCost(costMode, reported, computed), ...(d ? { costDisagreement: formatDisagreement(`${r.agent} session=${r.sessionId ?? "unknown"} model=${r.model ?? "unknown"}`, d) } : {}) };
  };

  const dimsBy = parseByDims(byDims);
  const modelAliases = parseModelAliases(args.values["model-alias"]);
  const projectAliases = loadProjectAliases({
    envJson: process.env.AGENTIC_CODING_HARNESS_PROJECT_ALIASES,
    file: args.values["project-aliases"],
    pairs: args.values["project-alias"],
  });
  const wantProject = args.values.project;
  const plan = resolvePlan(args.values.plan ?? process.env.AGENTIC_CODING_HARNESS_PLAN, {
    windowTokens: optNumWithEnv(args.values["plan-window-tokens"], "--plan-window-tokens", "AGENTIC_CODING_HARNESS_PLAN_WINDOW_TOKENS"),
    windowUsd: optNumWithEnv(args.values["plan-window-usd"], "--plan-window-usd", "AGENTIC_CODING_HARNESS_PLAN_WINDOW_USD"),
    windowMessages: optNumWithEnv(args.values["plan-window-messages"], "--plan-window-messages", "AGENTIC_CODING_HARNESS_PLAN_WINDOW_MESSAGES"),
  });
  const statsBudgetUsd = optNumWithEnv(args.values["budget-usd"], "--budget-usd", "AGENTIC_CODING_HARNESS_BUDGET_USD");
  const agent = args.values.agent;
  // agents.d descriptors (#38) are valid --agent filters; `custom` runs too.
  const catalog = loadCatalog();
  reportCatalogIssues(catalog);
  // amp/goose/qwen (#22) are read-only transcript sources: valid filters.
  if (agent && !isKnownAgent(agent) && !isTranscriptOnlyAgent(agent) && agent !== "custom" && !findDescriptor(catalog, agent)) {
    throw new HarnessError(`unknown agent '${agent}' (expected one of: ${[...new Set([...runnableAgentNames(catalog), ...transcriptAgentNames()])].join(", ")})`, "UNKNOWN_AGENT");
  }
  // One code path computes the window (#26) and the zone (#84); every output
  // surface below (table, --json, per-bucket maps) reads the same records.
  const timeZone = resolveTimeZone(args.values.tz, process.env[TZ_ENV]);
  const by = parseBy(byTime);
  const window = resolveWindow({
    days: optNum(args.values.days, "--days"),
    since: args.values.since,
    until: args.values.until,
    last: args.values.last,
    now: Date.now(),
    timeZone,
  });
  const sinceTs = window.sinceMs;

  // Harness state (driver-run NDJSON + watch-persisted opencode) ...
  const withWarehouse = args.values["with-warehouse"];
  const stateRecords = [
    ...(await readAllRecords({ agent, sinceTs })),
    ...(withWarehouse ? await warehouseStateRecords(stateDir(), { agent, sinceTs }) : []),
  ].filter((r) => inWindow(Date.parse(r.ts), window));
  // One registry scan feeds both the cwd index and the run rollups; records
  // that fail to parse are counted (skippedRunRecords), never dropped silently.
  const registryScan = scanRunRecords(stateDir());
  const runCwd = cwdIndex(registryScan.records);
  let records: (DimRecord & StatsProvenanceRecord & { costDisagreement?: string; source: "state" | "transcript" })[] = stateRecords.map((r) => ({
    source: "state",
    extra: r.extra,
    cwd: runCwd(r.agent, r.sessionId),
    ts: r.ts,
    agent: r.agent,
    sessionId: r.sessionId,
    model: r.model,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens,
    cacheWriteTokens: r.cacheWriteTokens,
    ...(r.cacheWrite1hTokens !== undefined ? { cacheWrite1hTokens: r.cacheWrite1hTokens } : {}),
    reasoningTokens: r.reasoningTokens ?? 0,
    ...costFor(r, r.reportedCostUsd),
    ...(r.extra?.tokensAvailable === false ? { tokensAvailable: false } : {}),
  }));
  const seen = new Set(stateRecords.map(dedupeKey));

  // ... plus machine CLI transcripts (claude/codex/gemini), computed-only (no
  // reported cost on these rows). costUsd is set only when the record has a
  // model the pricer knows; undefined costs contribute nothing to the sums.
  // --state-only skips this scan entirely: stateDir records only (e.g. on a
  // machine whose transcript dirs are huge or being rotated).
  if (!args.values["state-only"]) {
    const machine = statsMachineRecords({ scan: statsScanOptions(transcriptDir), withWarehouse, stateDir: stateDir() });
    for await (const rec of machine) {
      if (agent && rec.agent !== agent) continue;
      const tsMs = rec.timestamp ? Date.parse(rec.timestamp) : NaN;
      if (!inWindow(tsMs, window)) continue;
      const row = {
        ts: Number.isFinite(tsMs) ? new Date(tsMs).toISOString() : null,
        agent: rec.agent,
        sessionId: rec.sessionId ?? "unknown",
        model: rec.model ?? undefined,
        inputTokens: rec.input,
        outputTokens: rec.output,
        cacheReadTokens: rec.cacheRead,
        cacheWriteTokens: rec.cacheWrite,
        ...(rec.cacheWrite1h !== undefined ? { cacheWrite1hTokens: rec.cacheWrite1h } : {}),
        reasoningTokens: rec.reasoning,
      };
      const key = dedupeKey(row);
      if (seen.has(key)) continue;
      seen.add(key);
      const cwd = rec.cwd ?? runCwd(rec.agent, rec.sessionId);
      records.push({ ...row, ...costFor(row, undefined), ...(cwd ? { cwd } : {}), source: "transcript" });
    }
    // agents.d usage taps (#38): descriptor-declared transcript sources.
    const tap = await descriptorTapRows(catalog, pricer, { agent, sinceTs, costMode });
    for (const row of tap.rows) {
      // Tap rows honour the full #26 [since, until) window, not only sinceTs.
      if (!inWindow(row.ts ? Date.parse(row.ts) : NaN, window)) continue;
      const key = dedupeKey(row);
      if (seen.has(key)) continue;
      seen.add(key);
      records.push({ ...row, source: "transcript" });
    }
    for (const w of new Set(tap.warnings)) process.stderr.write(`[warn] ${w}\n`);
  }
  for (const w of new Set(pricer.drainWarnings())) process.stderr.write(`[warn] ${w}\n`);
  for (const w of drainTranscriptWarnings()) process.stderr.write(`[warn] ${w}\n`);
  const skippedRunRecords = registryScan.skipped.length;
  const skippedWarning = skippedRunRecordsWarning(stateDir(), registryScan.skipped);
  if (skippedWarning) process.stderr.write(skippedWarning + "\n");

  if (wantProject !== undefined) records = records.filter((r) => projectMatches(r.cwd, wantProject, projectAliases));
  disagreements.push(...records.flatMap((r) => r.costDisagreement ? [r.costDisagreement] : []));
  const agg = aggregate(records, { timeZone, by });
  const showProject = dimsBy.has("project") || wantProject !== undefined;
  const dims = aggregateDims(records, {
    costMode, timeZone,
    pricer: createPricer(),
    mergeModels: args.values["merge-models"],
    modelAliases,
    byModelDay: dimsBy.has("model"),
    byProject: showProject,
    projectAliases,
  });
  if (dims.unpricedModels.length > 0) {
    process.stderr.write(
      `[warn] unpriced models (tokens counted, cost n/a and excluded from totals): ${dims.unpricedModels.join(", ")}\n`,
    );
  }
  // Run records from the registry, honouring the full #26 [since, until) window.
  const windowedRunRecords = registryScan.records.filter((r) => inWindow(r.startedAt, window) && (wantProject === undefined || projectMatches(r.cwd, wantProject, projectAliases)));
  // Run outcomes (#60) from the run registry: shown only when there are runs,
  // so the historical {total, byAgent, byDay} shape is untouched otherwise.
  const runRecords = windowedRunRecords.filter((r) => !agent || r.agent === agent);
  const outcomes =
    runRecords.length > 0
      ? summarizeRunOutcomes(runRecords, { includeUnavailable: args.values["include-unavailable"] })
      : undefined;
  // Per-repeat-group rollup (#57) over the same windowed, agent-filtered run
  // records; the key only appears when some `ach run --repeat` group exists.
  const repeatGroups = repeatGroupRollup(runRecords);
  // --by picks which calendar maps are emitted (default: byDay only).
  const timeMaps = {
    ...(by.includes("day") ? { byDay: agg.byDay } : {}),
    ...(agg.byWeek ? { byWeek: agg.byWeek } : {}),
    ...(agg.byMonth ? { byMonth: agg.byMonth } : {}),
  };
  // #18/#19/#36: blocks, pace and plan framing over the same windowed records.
  const extras = statsExtras({
    records,
    now: Date.now(),
    blocks: args.values.blocks,
    ...(plan !== undefined ? { plan } : {}),
    ...(statsBudgetUsd !== undefined ? { budgetUsd: statsBudgetUsd } : {}),
    spentUsd: agg.totals.costUsd,
  });
  // metering=none runs (#37) carry no token records: counted as runs, apart.
  const unmetered = unmeteredRuns(stateDir(), { agent, sinceTs, records: runRecords });
  probe.drainWarnings();
  // Disagreements go to stderr (capped) and are counted in total.costDisagreements.
  const MAX_DISAGREEMENT_LINES = 10;
  for (const msg of disagreements.slice(0, MAX_DISAGREEMENT_LINES)) process.stderr.write(`[warn] ${msg}\n`);
  if (disagreements.length > MAX_DISAGREEMENT_LINES) {
    process.stderr.write(
      `[warn] cost disagreement: ${disagreements.length - MAX_DISAGREEMENT_LINES} more record(s) not shown (${disagreements.length} total)\n`,
    );
  }

  const view = (b: typeof agg.totals) => applyCostMode(b, costMode);
  // Preserve origin through aggregation so readers can distinguish harness
  // state from read-only transcripts even when both contain the same agent.
  const sources = Object.fromEntries((["state", "transcript"] as const).map((source) => {
    const rows = records.filter((r) => r.source === source);
    return [source, { ...view(aggregate(rows, { timeZone, by }).totals), provenance: statsProvenance(rows, { timeZone, by }).total }];
  }));
  const hasTranscripts = records.some((r) => r.source === "transcript");
  // Issue #33: a sibling `provenance` map on every bucket (numbers unchanged).
  const prov = statsProvenance(records, { timeZone, by });
  const mapView = (m: Record<string, typeof agg.totals>, pm: Record<string, ProvenanceMap>) =>
    Object.fromEntries(Object.entries(m).map(([k, b]) => [k, { ...view(b), provenance: pm[k] ?? {} }]));

  if (args.values.json) {
    process.stdout.write(
      JSON.stringify(
        {
          total: { ...view(agg.totals), costDisagreements: disagreements.length, provenance: prov.total },
          byAgent: mapView(agg.byAgent, prov.byAgent),
          ...(hasTranscripts ? { sources } : {}),
          ...Object.fromEntries(Object.entries(timeMaps).map(([k, v]) => [k, mapView(v, k === "byDay" ? prov.byDay : k === "byWeek" ? prov.byWeek ?? {} : prov.byMonth ?? {})])),
          timezone: timeZone,
          window: windowJson(window),
          byModel: dims.byModel,
          unpricedModels: dims.unpricedModels,
          cacheHitRatio: baseCacheRatios(agg),
          ...(dims.byModelDay ? { byModelDay: dims.byModelDay } : {}),
          ...(args.values["merge-models"] ? { mergedModels: true, modelAliases } : {}),
          ...(dims.byProject ? { byProject: dims.byProject, projectAliases } : {}),
          // #21: per-run context-window pressure from the run registry.
          runs: runContextRows(windowedRunRecords, { agent }),
          // #60: run-outcome rollup. Named runOutcomes (not `runs`) because
          // #21 already owns the `runs` array key.
          ...(outcomes !== undefined ? { runOutcomes: outcomes } : {}),
          // #18/#19/#36: pace always; blocks/blocksNote with --blocks; plan with --plan.
          ...extras.json,
          // #37: present only when metering=none runs exist.
          ...(unmetered.runs > 0 ? { unmetered } : {}),
          ...(repeatGroups.length > 0 ? { byRepeatGroup: repeatGroups } : {}),
          // Registry files that failed to parse (not windowed: their time is unknown).
          ...(skippedRunRecords > 0 ? { skippedRunRecords } : {}),
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    const line = (label: string, b: CostModeBucket, p: ProvenanceMap | undefined) =>
      `${label.padEnd(9)} records=${fmtInt(b.records)} input=${fmtInt(b.inputTokens)} output=${fmtInt(b.outputTokens)} cacheRead=${fmtInt(b.cacheReadTokens)} cacheWrite=${fmtInt(b.cacheWriteTokens)} reasoning=${fmtInt(b.reasoningTokens)} cost=${b.costUsd === null ? "n/a" : fmtUsd(b.costUsd) + markerFor(p?.costUsd)} cacheHit=${fmtCacheHit(cacheHitRatio(b))}${b.unpricedRecords > 0 ? ` unpriced=${fmtInt(b.unpricedRecords)}` : ""}`;
    process.stdout.write(line("totals", view(agg.totals), prov.total) + ` costMode=${costMode}` + "\n");
    if (hasTranscripts) {
      for (const [source, bucket] of Object.entries(sources)) {
        process.stdout.write(line(`source: ${source}`, bucket, bucket.provenance) + "\n");
      }
    }
    if (skippedRunRecords > 0) process.stdout.write(`skipped   ${fmtInt(skippedRunRecords)} unreadable run record(s) (details on stderr)\n`);
    if (disagreements.length > 0) process.stdout.write(`disagree  ${disagreements.length} record(s) where reported and computed cost differ by >${COST_DISAGREEMENT_PCT}% (details on stderr)\n`);
    if (unmetered.runs > 0) {
      process.stdout.write(`unmetered runs=${fmtInt(unmetered.runs)} tokens=n/a cost=n/a\n`);
      for (const [a, g] of Object.entries(unmetered.byAgent).sort()) {
        process.stdout.write(`  ${a.padEnd(9)} runs=${fmtInt(g.runs)} tokens=n/a cost=n/a (unmetered)\n`);
      }
    }
    for (const [a, b] of Object.entries(agg.byAgent).sort()) {
      process.stdout.write(line(a, view(b), prov.byAgent[a]) + "\n");
      if (a === "claude" && extras.planLine) process.stdout.write(extras.planLine + "\n");
    }
    if (extras.planLine && !agg.byAgent.claude) process.stdout.write(extras.planLine + "\n");
    for (const m of Object.values(timeMaps)) {
      for (const [d, b] of Object.entries(m).sort()) process.stdout.write(line(d, view(b), prov.byDay[d] ?? prov.byWeek?.[d] ?? prov.byMonth?.[d]) + "\n");
    }
    for (const l of renderDimsText(dims, { model: dimsBy.has("model"), project: showProject })) {
      process.stdout.write(l + "\n");
    }
    if (outcomes !== undefined) {
      for (const [a, b] of Object.entries(outcomes.byAgent)) process.stdout.write(formatOutcomeLine(a, b) + "\n");
    }
    for (const l of extras.text) process.stdout.write(l + "\n");
    for (const g of repeatGroups) process.stdout.write(formatRepeatGroupLine(g, fmtUsd) + "\n");
    process.stdout.write(`${"legend".padEnd(9)} ${PROVENANCE_LEGEND}
`);
  }
  hintCcusage();
  return noDataExitCode(records.length + runRecords.length, exitMode);
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

/** Every subcommand `main` dispatches to (keep in sync with the switch below).
 *  Each accepts -h/--help (#101), answered from the shared USAGE text. */
const SUBCOMMANDS = new Set([
  "run", "preflight", "doctor", "watch", "stats", "audit", "status", "statusline",
  "archive", "emit", "regrade", "report", "dash", "serve", "web", "mcp", "quota", "agents",
]);

/**
 * The lines of the top-level USAGE block that describe one subcommand: from
 * the first `ach <cmd>` line up to the next command entry, the shared
 * `--flag` sections, or the `env:` footer. Empty when USAGE has no entry for
 * the command (callers fall back to the full USAGE).
 */
function subcommandUsageLines(cmd: string): string[] {
  const head = /^  ach (\S+)/;
  const lines = USAGE.split("\n");
  const first = lines.findIndex((l) => head.exec(l)?.[1] === cmd);
  if (first === -1) return [];
  const out: string[] = [];
  for (let i = first; i < lines.length; i++) {
    const line = lines[i]!;
    const m = head.exec(line);
    if (i > first && m !== null && m[1] !== undefined && m[1] !== cmd) break;
    if (i > first && (line === "env:" || /^  --/.test(line))) break;
    out.push(line);
  }
  return out;
}

/** `ach <cmd> --help` output (#101): the subcommand's own USAGE lines. */
function subcommandHelp(cmd: string): string {
  const lines = subcommandUsageLines(cmd);
  return lines.length > 0 ? ["usage:", ...lines].join("\n") : USAGE;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...raw] = argv;
  // #104: the space-separated `--extra-args <value>` form is joined into the
  // unambiguous `--extra-args=<value>` form before parseArgs (and before the
  // #101 help scan, so `--extra-args --help` passes --help through as the
  // flag's VALUE — the next token is always the value).
  const rest = cmd === "run" || cmd === "preflight" ? joinOptionValues(raw, ["extra-args"]) : raw;
  // #101: every subcommand accepts -h/--help (usage + exit 0).
  if (cmd !== undefined && SUBCOMMANDS.has(cmd) && wantsHelp(rest)) {
    process.stdout.write(subcommandHelp(cmd) + "\n");
    return 0;
  }
  switch (cmd) {
    case "run":
      return cmdRun(rest);
    case "preflight":
      return cmdPreflight(rest);
    case "doctor":
      return cmdDoctor(rest);
    case "watch":
      return cmdWatch(rest);
    case "stats":
      return cmdStats(rest);
    case "audit":
      return cmdAudit(rest);
    case "status":
      return cmdStatus(rest);
    case "statusline":
      return cmdStatusline(rest);
    case "archive":
      return cmdArchive(rest);
    case "emit":
      return cmdEmit(rest);
    case "regrade":
      return cmdRegrade(rest);
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
    case "quota":
      return cmdQuota(rest);
    case "agents":
      return cmdAgents(rest);
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
 * - standalone `bun build --compile` executable: both argv[1] and
 *   import.meta.url collapse to the SAME synthetic `/$bunfs/root/<name>`
 *   path baked in at compile time (verified: identical regardless of the
 *   real on-disk filename or how the binary is invoked). realpathSync
 *   throws ENOENT on that virtual path since it has no real inode — fall
 *   back to a raw string comparison so the compiled binary still runs
 *   instead of silently exiting 0 with no output.
 */
function invokedAsCli(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const entryPath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(argv1) === realpathSync(entryPath);
  } catch {
    return argv1 === entryPath;
  }
}

if (invokedAsCli()) {
  main(process.argv.slice(2))
    .catch((err: unknown) => {
      if (err instanceof HarnessError) {
        process.stderr.write(`harness: ${err.message}\n`);
        return err.exitCode;
      }
      // parseArgs usage errors (unknown option, missing/ambiguous value) are
      // TypeErrors with an ERR_PARSE_ARGS_* code (#101): render the message's
      // first line as a clean usage error — never a stack trace — and exit
      // nonzero, without silently swallowing the typo.
      if (err instanceof TypeError) {
        const code = (err as NodeJS.ErrnoException).code;
        if (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS_")) {
          process.stderr.write(`harness: ${err.message.split("\n")[0]}\n`);
          return EXIT_CODES.error;
        }
      }
      const msg = err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ""}` : String(err);
      process.stderr.write(`harness: unexpected error — ${msg}\n`);
      return 1;
    })
    .then(async (code) => {
      // stdout/stderr pipes are asynchronous on some supported platforms.
      // A forced exit may otherwise discard the tail of help or stats JSON.
      // Empty writes enqueue callbacks behind every command's prior output;
      // preserve forced shutdown only after both streams have flushed.
      await Promise.all([process.stdout, process.stderr].map((stream) =>
        new Promise<void>((resolve) => stream.write("", () => resolve())),
      ));
      process.exit(code);
    });
}
