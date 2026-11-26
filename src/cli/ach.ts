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
import { parseArgs as nodeParseArgs } from "node:util";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
// #41: config-aware drop-in for node:util parseArgs (src/cli/config.ts).
import { applyConfig, cmdConfig, cmdProfiles, CONFIG_USAGE, PROFILES_USAGE, configuredCapturePolicy, parseArgs, profileRecord, takeConfigFlag, takeResolution, type OptionTable } from "./config.ts";
import { parseCaptureMode } from "../core/capture.ts";
import { fileURLToPath } from "node:url";
import { flushAndExit, trackStdioBackpressure } from "./stdio-flush.ts";
import {
  AcpMcpServerSchema,
  EFFORT_LEVELS,
  HarnessError,
  isKnownAgent,
  KiroConfigSchema,
  KiroIdeConfigSchema,
  type AcpMcpServer,
  type AgentEvent,
  type EffortLevel,
  type KiroConfig,
  type KiroIdeConfig,
  type RunResult,
  type RunSpec,
  type RunProfileInfo,
  type SandboxPolicy,
} from "../core/types.ts";
import { isEffortLevel } from "../core/effort.ts";
import {
  buildRunMetrics,
  describeSandbox,
  formatSandboxHeader,
  sandboxDropWarnings,
  sandboxFromFlags,
  writeMetricsSidecar,
} from "./run-sandbox.ts";
import { DEFAULT_VERIFY_TIMEOUT_MS, type VerifyResult } from "../core/verify.ts";
import { parsePrValue } from "../core/git-pr.ts";
import { findAncestorInstructions, formatAncestorWarning } from "../core/ancestor-instructions.ts";
import { ISOLATE_FLAG_OPTIONS, formatIsolateLine, isolateOptionsFromFlags, type IsolatedWorkspace } from "../core/isolate.ts";
import { formatHermeticLine, HermeticSyncError, hermeticSyncErrorInfo, type HermeticWorkspace } from "../core/hermetic.ts";
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
import { cmdTrial } from "./trial-matrix.ts";
import { z } from "zod";
import { checkAdapterProfile, createDriver, defaultAdapters, type DriverOptions } from "../core/driver.ts";
import { parseRunSpec } from "../core/validate.ts";
import { VERSION } from "../version.ts";
import { stateDir, loadOffsets, saveOffsets, appendRecords, type StatRecord } from "../core/store.ts";
import { AtifWriter } from "../emitters/atif.ts";
import { deriveSpans, toOtlpJson } from "../emitters/otel.ts";
import { loadEnricher, resolveEnrichAttributes, resolveEnricherPath, runEnricher, type EnricherInput } from "../emitters/enrich.ts";
import { formatTraceLine, readRunTraceContext } from "../core/trace-context.ts";
import { emitToLangfuse } from "../emitters/langfuse.ts";
import { runSftEmit } from "../emitters/sft.ts";
import { MASK_OPTIONS, maskForExport } from "../core/masking.ts";
import { PRIVACY_OPTIONS, privacyId } from "../core/privacy.ts";
import { maskPolicyFor, noteMasked, notePrivacy, writeMaskPreview } from "./mask-cli.ts";
import { cmdScrub } from "./scrub.ts";
import { cmdExport, EXPORT_USAGE_LINES, STATS_ARGV } from "./export.ts";
import {
  parseClaudeTranscript,
  parseCodexRollout,
  codexSessionUsageFromRecords,
  reconcileCodexSessions,
  parseGeminiChat,
  scanAll,
  transcriptAgentNames,
  transcriptSources,
  scanOptionsForRoot,
  walkFiles,
} from "../monitors/transcripts.ts";
import { TRANSCRIPT_SOURCES, isTranscriptOnlyAgent, readOnlySourceMessage } from "../monitors/transcript-sources.ts";
import { drainTranscriptWarnings } from "../monitors/transcript-warnings.ts";
import { dashboardSpan, inDashboardSpan, reconcileDashboardWithState, type DashboardSpan } from "./cursor-dashboard-merge.ts";
import { statsFromDb } from "../adapters/opencode.ts";
import { cacheHitRatio, fmtCacheHit } from "../core/cache-ratio.ts";
import { createPricer, pricingMeta, pricingStaleNotice } from "../core/pricing.ts";
import { OfflineViolation, installOfflineGuard } from "../core/offline.ts";
import { autoUpdateNotice, checkForUpdate, formatUpdateResult } from "./update-check.ts";
import { aggregate, fmtInt, fmtUsd, formatEventLine, formatLatencyLines, formatSummary, joinOptionValues, orderedExtraArgs, resolveDirFlags, wantsHelp } from "./lib.ts";
import { runLatency } from "../core/latency.ts";
import {
  aggregateDims,
  baseCacheRatios,
  cwdIndex,
  branchIndex,
  deskIndex,
  deskByRunId,
  runIdIndex,
  branchLabel,
  deskLabel,
  prIndex,
  loadProjectAliases,
  parseByDims,
  parseModelAliases,
  projectMatches,
  projectOf,
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
  dayKey,
  inWindow,
  joinAgoTokens,
  parseBy,
  resolveTimeZone,
  resolveWindow,
  TIME_GRANULARITIES,
  TZ_ENV,
  windowJson,
  type TimeWindow,
} from "./time-window.ts";
import {
  compareJson,
  parseCompareSpec,
  periodTotals,
  renderCompareText,
  resolveComparePeriods,
  unexplainedDays,
} from "./compare-periods.ts";
import { cmdReport } from "./report.ts";
import { runContextRows } from "./context-stats.ts";
import { cmdDesk, cmdLane, cmdListener } from "./desk.ts";
import type { RunRecord } from "../core/registry.ts";
import { cmdDash } from "./dash.ts";
import { statsExtras } from "./usage-render.ts";
import { resolvePlan } from "../core/plans.ts";
import { cmdServe } from "./serve.ts";
import { cmdWeb } from "./web.ts";
import { cmdMcp } from "./mcp.ts";
import { cmdAudit } from "./audit.ts";
import { creditUnitOfAgent } from "../core/credit-units.ts";
import { ccusageHintText, cmdImport, parseStatsOrigin, statsOriginIndex, type StatsOrigin } from "./import.ts";
import { cmdVerifyRun } from "./verify-run.ts";
import { cmdReplay } from "./replay-vet.ts";
import { cmdSmoke } from "./smoke.ts";
import { EXIT_CODES, noDataExitCode, parseExitCodesMode, repeatExitCode, runExitCode } from "./exit-codes.ts";
import { formatOutcomeLine, summarizeRunOutcomes } from "./run-outcomes.ts";
import { alertFlagsToBudget } from "./alerts.ts";
import { cmdStatus } from "./status.ts";
import { cmdStatusline } from "./statusline.ts";
import { cmdQuota } from "./quota.ts";
import { cmdQueue, QUEUE_USAGE } from "./queue.ts";
import { cmdArchive } from "./archive.ts";
import { STATS_REWRITE_FIELDS, WATCH_REWRITE_FIELDS, openStatsSources, parseRewriteRules, rewritePath, rewritesJson, rewritesTextLine } from "./multi-source.ts";
import { cmdGc } from "./gc.ts";
import { cmdAttach } from "./attach.ts";
import { randomUUID } from "node:crypto";
import { ClaudeInteractiveAdapter } from "../interactive/claude-tui.ts";
import { assertInteractiveSupported, parseInteractiveFlags } from "../interactive/flags.ts";
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
import { cmdDoctor, checkKiroIde } from "./doctor.ts";
import { cmdInit, INIT_USAGE } from "./init.ts";
import { endpointFrom } from "../adapters/kiro-ide-cdp.ts";
import { lastNDays, sparkline, sparkSupported } from "./sparkline.ts";

const SPARK_DAYS = 14;

const USAGE = `ach — agentic-coding-harness · run, watch & meter coding agents
version: ${VERSION}

usage:
  ach --version | -v        print the harness version
  ach --config <path> <command> ...  read that JSON config instead of the default search
                            (./.ach/config.json over ~/.config/agentic-coding-harness/config.json);
                            precedence flag > env > config file > default, see \`ach config\`
  ach run --agent <claude|opencode|kiro|codex|gemini|agy|prime|kiro-ide|copilot|cursor|null> [--model M] [--resume SID]
              [--budget-usd N] [--max-turns N] [--wall-ms MS] [--idle-ms MS] [--json] "<prompt>"
              [--profile NAME]  (expand a named agent profile from the config file: its flags
                           and env; precedence flag > env > profile > config run section >
                           default; the RunRecord keeps profile.{name,expanded,argv}; see
                           ach profiles list and docs/CONFIG.md "Agent profiles")
              [--pr N|auto]  (PR number stamped on the run record as pr + prSource; precedence
                           flag > AGENTIC_CODING_HARNESS_PR > branch name (482-slug, pr-482, issue-482);
                           'auto' also tries gh pr view; see ach stats --by pr)
              [--budget-alerts 0.5,0.8,1.0] [--warn-at 0.5,0.8,0.95] [--on-budget abort|warn]
                (threshold alerts warn once per crossing, never abort; fractions in (0,1];
                 'off' disables; state in <stateDir>/alerts.json, see docs/BUDGET-ALERTS.md)
              [--verify '<cmd>' [--verify-timeout-ms MS=120000]]  (checker run in cwd after
                           the agent exits; verdict on the RunRecord, failed checker exits 1; passing checker keeps the run exit code)
              [--repeat N [--parallel K]]  (N fresh sessions, one repeat group; exits with the most severe child code)
              [--experiment E] [--variant V]  (compare-view labels on the RunRecord)
              [--effort low|medium|high|xhigh|max]  (portable reasoning effort, mapped to each
                           agent's native mechanism: claude/agy/kiro --effort, codex -c
                           model_reasoning_effort=, copilot --reasoning-effort, opencode --variant,
                           cursor <model>[effort=]; gemini/prime/kiro-ide/null/custom have none and
                           run anyway with a warning. Recorded as effort {requested, applied,
                           mechanism} on the RunRecord; see docs/EFFORT.md)
              [--capture-mode full|metadata|off]  (what ach records of the run's text, applied
                           at record time: full = everything (default); metadata = types, ids,
                           model/tool names, timings and tokens, every other string [STRIPPED];
                           off = lifecycle events and totals only. Env ACH_CAPTURE_MODE; config
                           run.captureMode / contentCapture (per-agent overrides beat both);
                           recorded as captureMode on the RunRecord; see docs/CAPTURE.md)
              [--extra-args '<a b>']... [--extra-arg <token>]...  (extra CLI args for the
                           launched agent, every launchable agent; both repeatable and kept in
                           command-line order. --extra-args splits each value on spaces;
                           --extra-arg is ONE verbatim argv token, never split, so a value with
                           spaces works. e.g. route codex to a custom provider:
                           --extra-arg -c --extra-arg 'model_provider=ferry')
              [--permission-mode <mode>] [--allowed-tools <list>]... [--disallowed-tools <list>]...
              [--mcp-config <path|json>]  (typed sandbox policy; <mode> is ask|dontAsk or an agent-native
                           value, e.g. claude bypassPermissions/acceptEdits. Tool lists are repeatable
                           and comma-separated (commas inside parentheses are kept: 'Bash(git log:*)').
                           --mcp-config is a file path, or inline JSON when it starts with '{'.
                           Honored by: claude all four; gemini all four; codex --permission-mode only;
                           kiro --allowed-tools only; prime --allowed-tools only; copilot all four;
                           cursor --permission-mode only (dontAsk|plan|ask); agy --permission-mode
                           only (dontAsk|ask, or agy's accept-edits|auto|plan). Any other field/agent
                           prints a [warn] naming the dropped flag. The resolved policy is printed as a
                           '[sandbox]' header line and added to --json output)
              [--evidence-dir <dir>]  (after the run, write <dir>/metrics.json (repeat: metrics-<i>.json):
                           agent, model, exit status, wall seconds, turns, cost + provenance, token
                           totals, credits, sandbox policy, ach version, timestamps. NO prompt, responses, tool
                           inputs or file contents, so it is safe to commit; see docs/TRIALS.md)
              [--hermetic]  (run in a temp copy of cwd whose ancestor dirs hold no
                           CLAUDE.md/AGENTS.md/GEMINI.md, then sync edits (and deletions)
                           back before --verify; fails if the temp root is not clean.
                           Without it, ancestor instruction files are warned about and
                           recorded as ancestorInstructions; see README "Ancestor
                           instruction files". Not with --resume or --parallel > 1)
              [--isolate [--allow-dirty] [--cleanup] [--isolate-node-modules]]
                          (run in its own git worktree <stateDir>/worktrees/<runId> on a new branch
                           ach/<runId> cut from HEAD; the RunRecord keeps worktree.{path,branch,baseSha,
                           cleanup}. Refuses a dirty tree unless --allow-dirty. Worktree + branch are
                           kept for review; --cleanup commits leftover edits to the branch and removes
                           the worktree (branch kept). --isolate-node-modules symlinks each non-dot
                           node_modules entry from the primary checkout. Safe with --parallel; not
                           with --hermetic or --resume. See README "Isolated runs")
              [--interactive | --tui] [--then "<prompt>"]... [--pause-between] [--trust-workspace]
                          (claude only for now: run the agent's own TUI in a PTY owned by ach
                           instead of claude -p. Same model, permission mode, tool policy and first
                           prompt, plus a fixed --session-id. Tokens and cost come from the session
                           transcript (the file ach watch reads); budget/wall/idle caps, --verify and
                           the .cast replay work as for a headless run, and a budget abort sends
                           SIGINT, then kills. Watch and type from ach web (TUI on the run's tile)
                           or ach attach <runId>; in a terminal the TUI is also shown here.
                           --then types each next prompt once the agent finishes a turn;
                           --pause-between waits for Ctrl-] n or the web NEXT STEP button first.
                           --trust-workspace answers Claude's "trust this folder?" prompt. --idle-ms
                           counts agent activity, so it ends a session left waiting at its prompt.
                           Needs the npm/bun install (bun-pty); not with --repeat/--parallel/--resume)
              claude only: [--claude-default-config]  (use the default, authenticated
                           CLAUDE_CONFIG_DIR instead of a per-run one; or env
                           AGENTIC_CODING_HARNESS_DEFAULT_CLAUDE_CONFIG=1)
                         [--claude-no-background-tasks]  (set CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1
                           so claude -p waits for spawned sub-agents instead of exiting; or env
                           AGENTIC_CODING_HARNESS_CLAUDE_DISABLE_BACKGROUND_TASKS=1)
              null: negative-control smoke test: no CLI binary, no auth, no network,
                    deterministic zero-cost usage (ach run --agent null "<prompt>");
                    env AGENTIC_CODING_HARNESS_NULL_EXIT=error|timeout|budget_exceeded
                    forces that exitStatus; AGENTIC_CODING_HARNESS_NULL_TURNS=N sets
                    the scripted turn count (default 1)
              kiro only: [--kiro-transport headless|acp] [--kiro-agent A] [--kiro-engine v1|v2|v3]
                         [--kiro-effort E] (same argv as --effort E) [--kiro-tools all|none|a,b] [--kiro-require-mcp-startup]
                         [--kiro-startup-ms MS] [--kiro-require-model-ack]
                         [--kiro-mcp-server '<json>']...
              kiro-ide only: drives the Kiro IDE desktop app over CDP (no CLI, no token counts)
                         [--kiro-ide-cdp HOST:PORT] [--kiro-ide-port N] [--kiro-ide-bin PATH]
                         [--kiro-ide-user-data-dir DIR] [--kiro-ide-no-new-session]
                         (--kiro-ide-cdp attaches to a running IDE instead of launching one;
                          Autopilot must be on; usd budgets are not enforceable)
              copilot: GitHub Copilot CLI (copilot, npm @github/copilot; binary override
                         COPILOT_CLI_BIN). Needs a GitHub login with Copilot access: copilot login,
                         COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN, or gh auth login.
                         Cost is the CLI's own AIU telemetry at 1 AIU = $0.01 (shown as USD and as
                         credits); when the telemetry is missing the cost is n/a, never estimated
                         from tokens. --resume continues a session (usage is this run's share only)
              cursor: Cursor CLI agent (cursor-agent, brew cask cursor-cli; binary override
                         CURSOR_AGENT_BIN). Needs "cursor-agent login" or CURSOR_API_KEY; an
                         unauthenticated CLI fails fast with a specific error (run recorded unavailable).
                         Cost is the CLI's own stated figure when its result carries one, else
                         computed from its reported tokens, else n/a (never estimated).
                         The Cursor IDE store is still metered by: ach stats --agent cursor.
              agy: Antigravity CLI (agy; sign in by running agy once). Runs agy -p with
                         --output-format stream-json and --dangerously-skip-permissions unless
                         --permission-mode is set. Tokens and per-call TTFT come from the stream;
                         A model with no exact rate prices via a known family when one matches
                         (warned as estimated), else cost is n/a (gemini-4 ids today). Without --model the model id is
                         read from agy's own log (~/.gemini/antigravity-cli/brain).
                         --resume continues a conversation (agy --conversation <id>)
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
  ach update --check [--json] [--offline]
              one GET of the GitHub release feed: prints "up to date" or "new version X available: <url>"
              (exit 1 and a plain message if the feed is unreachable). NEVER downloads, installs, replaces
              or modifies anything, including this binary: it only reports. Writes only
              <state>/update-check.json (last check time). Without --check this usage is shown.
  ach preflight --agent kiro-ide [--kiro-ide-cdp HOST:PORT] [--kiro-ide-port N] [--kiro-ide-bin PATH] [--json]
                    (read-only: binary, CDP reachability, signed-in chat; same rows as doctor)
  ach preflight --agent kiro [--model M] [--kiro-agent A] [--kiro-transport acp]
                    [--cwd DIR] [--json] [--kiro-startup-ms MS] [--kiro-mcp-server '<json>']...
                    [--extra-args '<a b>']... [--extra-arg <token>]...
                    (same as ach run: --extra-args splits on spaces, --extra-arg is verbatim)
                    (proves binary/auth/agent/model/set_model-ack/MCP over a real
                     ACP handshake; sends NO prompt, so it spends no tokens)
  ach doctor [--agent A] [--model M] [--cwd DIR] [--claude-default-config] [--json]
                 [--kiro-ide-cdp HOST:PORT] [--kiro-ide-port N] [--kiro-ide-bin PATH]
                 (all seven agents by default: binary+version, auth material, model,
                  MCP config, plus state dir / pricing table / env sanity; kiro runs
                  the preflight handshake. Sends NO prompt; exit 1 if any check failed)
  ach regrade <run-id> --verify '<cmd>' [--verify-timeout-ms MS] [--json]
                (re-run a checker against a saved run's cwd; appends to the record's
                 regrades[]; no agent launched, run-time verify never rewritten)
  ach trial --matrix <plan.json> [--dry-run] [--retry-failed] [--ledger PATH] [--json] [--hermetic]
                [--isolate [--allow-dirty] [--cleanup] [--isolate-node-modules]]
                [--claude-no-background-tasks]
                [--effort low|medium|high|xhigh|max]  (every cell, as ach run --effort; overrides plan effort)
                [--capture-mode full|metadata|off]  (every cell, as ach run --capture-mode)
                (resumable agents x tasks x models x trials grid; every cell is one
                 run labelled experiment/variant/cellId=agent:task:model:trialN;
                 <plan>.ledger.jsonl records finalized cells, so re-running the same
                 command skips cells with a verdict (passed / verify-failed); error
                 cells re-run only with --retry-failed; unavailable-CLI and
                 provider-limit (usage/rate limit, 429) cells have no verdict and
                 run again; exit 1 only on errors or interruption; see docs/TRIALS.md)
  ach trial --suite core [--agent A]... [--task T]... [--model M]... [--repeat N] [--effort E] [--capture-mode C]
                [--tasks-dir DIR] [--ledger PATH] [--dry-run] [--retry-failed] [--json] [--hermetic]
                [--isolate [--allow-dirty] [--cleanup] [--isolate-node-modules]]
                [--claude-no-background-tasks]
                [--permission-mode <mode>] [--allowed-tools <list>]... [--disallowed-tools <list>]...
                [--mcp-config <path|json>]
                (bundled self-verifying tasks as a matrix; default agents = every
                 installed CLI, missing ones skipped with a reason; experiment
                 suite/core, variant agent:model; HTML report next to the ledger in
                 <stateDir>/suites/; --hermetic runs each cell's agent in a clean
                 temp copy, as for ach run; --isolate runs each cell whose workspace is
                 the project cwd in its own git worktree + branch (fresh-workspace cells
                 already run in a new empty dir and are left alone); the four sandbox flags work as for ach run and
                 become the plan-level sandbox: per-cell drop warnings, listed in --dry-run
                 --json, recorded on every ledger row, not part of the cell identity)
  ach watch [--transcript-dir <home-shaped-root>]... [--rewrite FROM=TO]...
            [--since DATE | --last D] [--tz Z] [--offline]
                (--since/--last: print history newer than the bound on startup;
                 --dir is an alias of --transcript-dir here; repeat it to tail
                 several roots in one stream, each line ending 'dir: <root>';
                 --rewrite maps that root path, e.g. /mnt/c=C:)
  ach stats [--agent A] [--days N | --since DATE [--until DATE] | --last D]
            [--tz Z] [--by day|week|month] [--json] [--state-only] [--include-unavailable]
            [--compare prev|prev:<dur>] [--offline]
                (--compare prev: the selected window vs the window of the same length right
                 before it; --compare prev:7d: vs the same window shifted 7 days earlier
                 (calendar-exact in --tz). Needs a bounded window (--days/--since/--last).
                 Adds a compare block with tokens, cost and run deltas (n/a on a zero
                 base) and, with --json, a top-level "compare" object; days whose run
                 transcripts were pruned are named unexplained)
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
                 = successes / runs with a verdict (success, error, aborted); interrupted
                 and still-running runs have no verdict and are left out (shown as
                 noVerdict=N); 'unavailable' runs are also left out unless
                 --include-unavailable, which adds back only those;
                 --offline: refuse any non-loopback network call via fetch, http(s),
                 net, tls or dns (OfflineViolation);
                 --json adds a pricing block: snapshotDate, sourceUrl, modelCount,
                 ageDays, stale, source; a snapshot older than
                 AGENTIC_CODING_HARNESS_PRICING_STALE_DAYS (default 180, 0 = silent)
                 prints a one-line [notice] on stderr)
            [--by model|project|branch|pr|desk]... [--merge-models] [--model-alias FROM=TO]...
            [--project NAME] [--project-alias PATH=NAME]... [--project-aliases FILE.json]
                (--by takes time granularities and dimensions together, e.g.
                 --by week,model; --by model: agent/model rows + model x day table;
                 --by branch: per-git-branch rollup (branch recorded at run start;
                 unattributed rows land in '(no branch)'); --by pr: per-PR rollup (PR recorded
                 at run time via ach run --pr, env or branch name; no network; no PR = 'none'); --by desk: per desk/lane rollup
                 as <stack>/<name> (desk host records and driver turn runs; others '(none)'); --by project: repo-root rollup, aliases also via
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
            [--with-warehouse] [--transcript-dir <root>]... [--state-dir <stateDir>]...
            [--rewrite FROM=TO]...
            [--origin all|native|imported|transcript]
                (--origin counts only rows of that provenance: native = ach
                 runs, imported = sessions \`ach import\` recorded, transcript =
                 machine transcripts not in the registry; default all)
                (--with-warehouse adds archived copies whose live file is gone;
                 --transcript-dir reads machine transcripts from
                 <root>/.claude/projects etc., e.g. a restore; --dir is an
                 alias of --transcript-dir here, NOT a state dir;
                 --state-dir reads harness state (runs/, raw/) from that dir
                 instead of the default; repeat either flag to merge dirs: a run
                 or session in two dirs counts once, a conflicting copy warns
                 with both paths and the newest mtime wins; --rewrite FROM=TO
                 maps path fields in the output (byProject keys), e.g.
                 /mnt/c=C: shows /mnt/c/Users/x as C:\\Users\\x; rules are echoed
                 in --json "rewrites" and on a 'rewrite' text line; see docs/MULTI-DIR.md)
  ach archive [--agent A] [--days N] [--out DIR] [--state-dir <stateDir>] [--json]
  ach archive --restore <batch|latest|all> [--to DIR] [--out DIR] [--json]
                (snapshot transcripts + RunRecords into <stateDir>/warehouse,
                 sha256-deduped, never deletes; see docs/ARCHIVE.md;
                 --dir is an alias of --state-dir here)
  ach gc [--dry-run] [--before <date|duration>] [--keep-summaries]
         [--transcripts-ttl <dur|never>] [--runs-ttl <dur|never>] [--state-dir <stateDir>] [--json]
                (retention: delete old <stateDir>/raw transcripts (default 30d)
                 and run records (default never); skips live runs and symlinks)
  --exit-codes ladder   (run / stats / status / watch) automation exit codes: 0 ok,
                        10 near-limit, 11 limit hit, 20 unavailable, 30 no data,
                        1 errors — see docs/EXIT-CODES.md; default stays 0/1
  ach audit [--agent A] [--days N] [--json] [--tolerance-pct P] [--fix] [--state-dir <stateDir>]
                (re-derive each RunRecord's token/cost totals from its raw transcript
                 and report recorded vs recomputed deltas; exit 1 on drift;
                 --fix rewrites drifted totals and logs RunRecord.corrections;
                 --dir is an alias of --state-dir here)
  ach import --agent claude [--days N=30] [--transcript-dir <root>] [--state-dir <stateDir>]
             [--dry-run] [--json]
                (record existing local transcripts as RunRecords with
                 source "imported" so dash/web/compare show history; idempotent,
                 skips sessions a native run already owns and sessions whose
                 last activity is older than --days; a corrupt file is an error
                 line and the import continues (exit 0); \`ach stats\` totals
                 are unchanged by import; --dir is an alias of --state-dir here)
  ach import --agent cursor --usage-export <file> [--usage-export <file>]...
             [--state-dir <stateDir>] [--dry-run] [--json]
                (validate a Cursor dashboard usage export, CSV or JSON, and store a
                 verbatim copy under <stateDir>/cursor-dashboard/<sha256>.<ext>;
                 prints records, date span and reported cost per file; re-importing
                 the same file is \`unchanged\`; writes no RunRecords and nothing
                 under raw/; --days and --transcript-dir do not apply)
  ach verify-run <runId|runDir> [--json] [--records] [--state-dir <stateDir>]
                (recompute the run's sha256 hash-chained event log and check its
                 terminal seal + sealed totals (#59); exit 0 intact, 2 tampered
                 (names the first bad line), 3 unsealed legacy log, 4 open chain)
  ach replay vet <pr-number|pr-url> [--repo owner/name] [--clone PATH=.] [--fallback-clone PATH]...
                 [--trunk BRANCH] [--min-files N=3] [--test-regex RE] [--ticket-regex RE] [--json]
                (read-only replay-case vetting (#115): merged, approved, trunk, size, tests,
                 ticket id (title/body/branch), merge + base commits in the clone or a fallback,
                 squash vs merge, diff stat; prints a draft {pr, workItem, merge, base} entry and
                 the next commands; uses gh. exit 0 pass/warn, 40 fail; see docs/REPLAY.md)
  ach smoke <message-file> [--account EMAIL] [--agent A=claude] [--cdp URL] [--no-browser]
            [--stub SPEC]... [--block-host HOST]... [--allow-path DIR]... [--timeout SECS=300]
            [--no-fix] [--fix-agent A] [--fix-tool REPO] [--out DIR] [--copy]
            [--format text|markdown] [--json] [--keep] [--no-keychain]
                (smoke the instructions (#139): run a how-to message's steps literally as a
                 brand-new user in a sandbox (fresh HOME, own keychain, minimal PATH), browser
                 auth over CDP in a new tab with an account guard, outward writes hit local
                 stubs (--stub jira=JIRA_BASE_URL), fix the message in place and rerun; prints
                 the friction table, writes <name>.smoked.md (--out DIR), --copy as rich text.
                 exit 0 clean, 1 friction left, 2 usage; see docs/SMOKE.md)
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
            [--spark cost|tokens] [--no-spark]
                (14-day trend bar on the totals line; --no-spark or a non-UTF
                 terminal prints plain min=.. max=.. text)
  ach emit --input <events.json> --format <atif|otel|langfuse|sft> [--out path]
               [--agent A] [--model M] [--session-id SID]
               [--attr key=value]... [--attr-env key=ENVVAR]... [--enricher ./enrich.mjs]
               (custom attributes on every OTel/Langfuse span and the OTLP resource,
                ATIF extra.attributes; an unset ENVVAR is skipped with a warning;
                --enricher: a JS module whose default export maps each span to
                extra attributes (sync or async, 5s per call, fail open);
                config file section "emit"; ignored for sft; docs/CONFIG.md#export-enrichers)
               (sft: OpenAI chat JSONL for fine-tuning; --input may be a RunResult
                JSON or a trials directory; [--min-score N] [--exit <status>]
                [--agent A] filter runs (--exit takes an exitStatus such as
                success, error, timeout), --full-conversation = one sample per
                run instead of one per assistant turn; --model, --session-id
                and --langfuse-* are rejected; docs/SFT-EXPORT.md)
               (langfuse POSTs OTLP to the Langfuse instance; auth via
                --langfuse-url/--langfuse-public-key/--langfuse-secret-key or
                env LANGFUSE_URL|LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY,
                LANGFUSE_SECRET_KEY)
               [--mask none|preview|all] [--mask-style replace|partial]
               [--mask-entropy] [--mask-pattern <regex>]...
               (secret masking before export: preview lists findings and writes
                and sends nothing, all masks keys, tokens, emails, home paths;
                default all for otel and langfuse, none for atif and sft;
                env AGENTIC_CODING_HARNESS_MASK, config mask.*;
                docs/MASKING.md)
               [--privacy off|redact|anon]
               (privacy mode for shared output: redact shortens paths to
                basenames and $HOME to ~; anon also drops prompt text and hashes
                run/session ids; numbers never change; the mode is stamped in
                the output; default off; env AGENTIC_CODING_HARNESS_PRIVACY,
                config mask.privacy; docs/MASKING.md)
  ach report <trials-dir> [--out path] [--json] [--mask none|preview|all] [--mask-style ..]
               [--privacy off|redact|anon]
                 (single-file HTML comparison; a trials/ root scans subdirs;
                  --json prints the report model (with a privacy field) instead,
                  or writes it to --out; --mask* and --privacy as for emit)
  ach scrub <file|dir>... --mask preview|all [--out-dir <dir>] [--json]
               [--mask-style replace|partial] [--mask-entropy] [--mask-pattern <regex>]...
                 (share-time scrub of exported artifacts: preview lists every
                  finding (file, location, detector, what would change) and
                  touches nothing; all writes <name>.masked.<ext> copies (or the
                  tree under --out-dir) with per-detector counts, never editing
                  the originals; docs/MASKING.md)
${EXPORT_USAGE_LINES}
  ach dash [--json] [--all] [--state-only] [--state-dir <stateDir>] [--budget-usd N] [--offline]
               (live run dashboard; --json dumps RunRecords and exits; live
                runs get a pace row: $/h + tok/min over 15m/1h, budget ETA;
                QUOTA column shows vendor-reported headroom per agent;
                --dir is an alias of --state-dir here; --offline refuses outbound
                network calls (loopback allowed);
                --set-terminal-title[=FMT] keeps {active} {done} {total}
                {pct} {spend} in the tab title, TTY only)
${QUEUE_USAGE}
  ach quota [--json] [--agent A]
                (vendor-reported subscription headroom per agent: window, used,
                 time remaining, % left; n/a where the vendor reports nothing)
  ach quota ingest claude
                (reads Claude Code statusline JSON on stdin and snapshots its
                 rate_limits; call it from your statusLine script)
  ach quota wait [--agent A=claude] [--max-used PCT=95] [--window 5h,7d]
                 [--poll-s S=60] [--grace-s S=60] [--timeout-s S] [--allow-unknown]
                 [-- <cmd> [args...]]
                (blocks until every counted vendor window is under --max-used or
                 has reset, checking the wall clock so laptop sleep cannot
                 stretch the wait, then runs <cmd> and exits with its code;
                 exit 1 on --timeout-s or when the agent has no vendor number)
  ach serve [--http] [--port N=8398] [--host 127.0.0.1] [--token T]
                (MCP over streamable HTTP on POST /mcp; GET /health probe;
                 token via --token or env AGENTIC_CODING_HARNESS_HTTP_TOKEN)
  ach attach [<runId|prefix>] [--list] [--json] [--read-only] [--state-dir <stateDir>]
                (mirror a live --interactive run's TUI in this terminal; keys go to the run.
                 Ctrl-] d detaches and leaves the run going, Ctrl-] n sends the next --then
                 step. No id (or --list): list the live interactive runs)
  ach web [trials-dir] [--port N=8399] [--host 127.0.0.1] [--token T]
              [--state-dir <stateDir>] [--no-open] [--state-only]
              [--recent <N>m|h|d|w|all=7d] [--page-size N=200] [--source URL] [--source-token T]
              [--source-mode poll|sse|ws] [--source-poll-ms N=3000]
              [--source-merge state|only=only] [--offline]
                (browser dashboard over the live registry plus this machine's agent
                  transcripts; --state-only shows only registry runs (ach run) and skips
                  the transcript scan; the run list holds the newest --page-size runs
                  started within --recent (running runs always), and "load older" on
                  /grid pages back through the rest (config keys web.recent, web.pageSize);
                  token via --token
                  or env AGENTIC_CODING_HARNESS_HTTP_TOKEN, else one generated and kept in
                  <stateDir>/web/token (loopback only); the printed URL carries ?token=,
                  which sets a cookie for the pages; --no-open skips the browser;
                  --source reads runs from an external http(s) feed instead of the
                  state dir — flags or env AGENTIC_CODING_HARNESS_SOURCE[_TOKEN|_MODE|
                  _POLL_MS|_MERGE]; --source-token falls back to --token;
                  --source-merge state unions the local registry under the feed;
                  --dir is an alias of --state-dir here;
                  --offline refuses outbound network calls (OfflineViolation) and a
                  non-loopback --source; loopback stays allowed; /api/stats carries
                  the pricing snapshot block;
                  GET /api/runs filters: ?agent=&status=&minCost=&maxCost=&since=&until=
                  &q=[&qin=events]&limit=&offset=&order=newest , see README "Run list filters";
                  GET /api/runs/<runId> returns one full record)
  ach mcp [--gateway --root R] [--max-jobs N] [--max-output-bytes N] [--allow-extra-args A]
              (MCP over stdio: newline-delimited JSON-RPC on stdin/stdout, Content-Length
               framing tolerated; same tools and gateway flags as \`ach serve\`)
  ach desk up [--layout F] [--port-base N] [--term tmux|ghostty|none] [--tmux-session S] [--tmux-socket S] [--stack S] [--json]
  ach desk down | attach [--term ...] | roster [--json] [--no-prune] | decisions [--state S] [--json] | costs [--json]
  ach desk send <to> <text...> [--from NAME] | inbox [name] [--limit N] [--since <ms|10m>] [--json]
  ach desk events <name> [--since SEQ] [--json] [--follow] | chat <name> | engine <name> <agent> [--model M]
  ach desk answer <Dn> <text...> [--from NAME] | close <Dn> [--reason R]
  ach desk reload <name>|--all [--force] | reload --stale [--force]
  ach desk status <name> | on <name> [--resume] | off <name> [--force] | toggle <name>
  ach desk auto <name> [--poll S] [--grace S] | auto <name> --stop
  ach listener status | on | off | toggle | auto [--stop]   (the same, for the LISTENER desk)
              (desks and lanes: one detached host process each, see docs/DESKS.md; every desk
               subcommand takes --stack S, --from defaults to $ACH_DESK_NAME else "human";
               "ach desk host --spec <file>" is internal)
  ach lane new <name> --goal "<objective>" [--agent A] [--model M] [--mcps a,b] [--cwd D] [--budget-usd N] [--brief TEXT]
  ach lane status [name] [--json] | stop <name> | approve <Ln> | reject <Ln> [--reason R]
${CONFIG_USAGE}
${PROFILES_USAGE}
${INIT_USAGE}

env:
  AGENTIC_CODING_HARNESS_CONFIG      config file path (same as --config; replaces the default search)
  AGENTIC_CODING_HARNESS_STATE_DIR   state root (default ~/.agentic-coding-harness)
  AGENTIC_CODING_HARNESS_HTTP_TOKEN  default for serve/web --token (CLI flags win over env)
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
  AGENTIC_CODING_HARNESS_UPDATE_CHECK=1     opt in to one stderr line at most every 24h when a newer release exists
                                     (default off: no network call from any command; see docs/UPDATE-CHECK.md)
  AGENTIC_CODING_HARNESS_UPDATE_FEED_URL    override the release feed URL (default: GitHub releases/latest)
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

/** `--kiro-ide-*` flags → KiroIdeConfig (undefined when no flag was given). */
export function kiroIdeConfigFromFlags(v: {
  "kiro-ide-cdp"?: string;
  "kiro-ide-port"?: string;
  "kiro-ide-bin"?: string;
  "kiro-ide-user-data-dir"?: string;
  "kiro-ide-no-new-session"?: boolean;
}): KiroIdeConfig | undefined {
  const cfg: Record<string, unknown> = {};
  if (v["kiro-ide-cdp"] !== undefined) cfg.cdp = v["kiro-ide-cdp"];
  const port = optPositiveInt(v["kiro-ide-port"], "--kiro-ide-port");
  if (port !== undefined) cfg.port = port;
  if (v["kiro-ide-bin"] !== undefined) cfg.bin = v["kiro-ide-bin"];
  if (v["kiro-ide-user-data-dir"] !== undefined) cfg.userDataDir = v["kiro-ide-user-data-dir"];
  if (v["kiro-ide-no-new-session"]) cfg.newSession = false;
  if (Object.keys(cfg).length === 0) return undefined;
  const parsed = KiroIdeConfigSchema.safeParse(cfg);
  if (!parsed.success) {
    throw new HarnessError(`invalid --kiro-ide-* flags: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, "USAGE");
  }
  return parsed.data;
}

/** `--effort <level>` (#54): a usage error on anything outside EFFORT_LEVELS. */
export function parseEffortFlag(raw: string): EffortLevel {
  if (!isEffortLevel(raw)) throw new HarnessError(`--effort must be one of ${EFFORT_LEVELS.join("|")} (got '${raw}')`, "USAGE");
  return raw;
}

/** `--pr N|auto` (#48): a usage error on anything else. */
function parseRunPr(raw: string): number | "auto" {
  try {
    return parsePrValue(raw);
  } catch (e) {
    throw new HarnessError(`--pr: ${(e as Error).message}`, "USAGE");
  }
}

/** The flag values `runSpecFromFlags` reads (the `ach run` option table's). */
type RunSpecFlagValues = Parameters<typeof alertFlagsToBudget>[0] &
  Parameters<typeof sandboxFromFlags>[0] &
  Parameters<typeof kiroConfigFromFlags>[0] &
  Parameters<typeof kiroIdeConfigFromFlags>[0] & {
    model?: string;
    effort?: string;
    resume?: string;
    pr?: string;
    "budget-usd"?: string;
    "max-turns"?: string;
    "wall-ms"?: string;
    "idle-ms"?: string;
  };

/**
 * The RunSpec `ach run` builds from its parsed flags, before any agent
 * launches: budget caps (with their env defaults), alerts, extra args in
 * command-line order, sandbox policy and the per-agent typed config. Shared
 * with the save-time profile check (#77, checkRunProfile) so a profile is
 * validated against exactly the spec a run would get.
 */
/** DriverOptions.capture for a CLI run (#72): `--capture-mode` (any layer) + the config file's policy. */
export function runCaptureOptions(
  raw: string | undefined,
  resolution: { effective: Array<{ flag: string; source: string }> } | null,
): NonNullable<DriverOptions["capture"]> {
  const policy = configuredCapturePolicy();
  if (raw === undefined) return { policy };
  const layer = resolution?.effective.find((e) => e.flag === "capture-mode")?.source ?? "flag";
  return { mode: parseCaptureMode(raw, "--capture-mode"), modeSource: layer.startsWith("file:") ? "config" : layer, policy };
}

function runSpecFromFlags(
  agent: string,
  values: RunSpecFlagValues,
  tokens: Parameters<typeof orderedExtraArgs>[0],
  prompt: string,
  variant?: string,
): { spec: RunSpec; budget: { usd?: number; maxTurns?: number; wallMs?: number; idleMs?: number }; sandbox: SandboxPolicy | undefined } {
  const budget = {
    usd: optNumWithEnv(values["budget-usd"], "--budget-usd", "AGENTIC_CODING_HARNESS_BUDGET_USD"),
    maxTurns: optIntWithEnv(values["max-turns"], "--max-turns", "AGENTIC_CODING_HARNESS_MAX_TURNS"),
    wallMs: optNumWithEnv(values["wall-ms"], "--wall-ms", "AGENTIC_CODING_HARNESS_WALL_MS"),
    idleMs: optNumWithEnv(values["idle-ms"], "--idle-ms", "AGENTIC_CODING_HARNESS_IDLE_MS"),
  };
  // Threshold alerts (#20): parsed with the other budget flags, before launch.
  const alertBudget = alertFlagsToBudget(values, budget);
  // #104: `--extra-args` is repeatable; each occurrence splits on spaces
  // (backwards compatibility). `--extra-arg` is one verbatim token. Both
  // accumulate in command-line order.
  const extraArgs = orderedExtraArgs(tokens);
  // #13: sandbox flags → the SandboxPolicy adapters already consume.
  const sandbox = sandboxFromFlags(values);
  const spec: RunSpec = {
    prompt,
    model: values.model,
    ...(values.effort !== undefined ? { effort: parseEffortFlag(values.effort) } : {}),
    resume: values.resume,
    ...(values.pr !== undefined ? { pr: parseRunPr(values.pr) } : {}),
    budget: { ...budget, ...alertBudget },
    ...(extraArgs !== undefined ? { extraArgs } : {}),
    ...(sandbox !== undefined ? { sandbox } : {}),
    ...(agent === "kiro" ? { kiro: kiroConfigFromFlags(values) } : {}),
    ...(agent === "kiro-ide" ? { kiroIde: kiroIdeConfigFromFlags(values) } : {}),
    ...(variant !== undefined ? { variant } : {}),
  };
  return { spec, budget, sandbox };
}

/**
 * Save-time check of an agent profile (#77, `ach config --set profiles.*`):
 * parse the profile's argv with the `ach run` option table, build the spec a
 * run would build (placeholder prompt) and run the agent's validateProfile
 * through the driver's own checkAdapterProfile, so an illegal combination is
 * rejected with the message a run would print. Agents without a built-in
 * adapter (agents.d descriptors, custom templates) have no hook to call.
 */
async function checkRunProfile(argv: string[], table: OptionTable): Promise<void> {
  const parsed = nodeParseArgs({ args: argv, options: table as never, allowPositionals: true, tokens: true });
  const values = parsed.values as Record<string, unknown>;
  const agent = typeof values.agent === "string" ? values.agent : undefined;
  if (agent === undefined) return;
  const adapter = (await defaultAdapters())[agent];
  if (adapter === undefined) return;
  const { spec } = runSpecFromFlags(agent, values as RunSpecFlagValues, parsed.tokens, "(profile check)");
  // Model pinning is not checked here: a profile may leave --model to the command line.
  const valid = parseRunSpec(agent, spec.model === undefined ? { ...spec, model: "profile-check" } : spec);
  if (spec.model === undefined) delete valid.model;
  checkAdapterProfile(agent, adapter, valid);
}

async function cmdRun(rest: string[]): Promise<number> {
  const args = parseArgs({
    args: rest,
    options: {
      agent: { type: "string" },
      // #77: a named agent profile from the config file (docs/CONFIG.md).
      profile: { type: "string" },
      model: { type: "string" },
      // #54: portable reasoning effort, mapped per agent (src/core/effort.ts).
      effort: { type: "string" },
      // #72: record-time content-capture tier (src/core/capture.ts).
      "capture-mode": { type: "string" },
      resume: { type: "string" },
      pr: { type: "string" },
      "budget-usd": { type: "string" },
      "max-turns": { type: "string" },
      "wall-ms": { type: "string" },
      "idle-ms": { type: "string" },
      "budget-alerts": { type: "string" },
      "warn-at": { type: "string" },
      "on-budget": { type: "string" },
      "extra-args": { type: "string", multiple: true },
      "extra-arg": { type: "string", multiple: true },
      // #13: SandboxPolicy flags (src/cli/run-sandbox.ts) and the metrics sidecar.
      "permission-mode": { type: "string" },
      "allowed-tools": { type: "string", multiple: true },
      "disallowed-tools": { type: "string", multiple: true },
      "mcp-config": { type: "string", multiple: true },
      "evidence-dir": { type: "string" },
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
      "claude-no-background-tasks": { type: "boolean", default: false },
      "kiro-mcp-server": { type: "string", multiple: true },
      // Kiro IDE typed config (src/core/types.ts KiroIdeConfig, #110). Ignored
      // for other agents, like the --kiro-* flags above.
      "kiro-ide-cdp": { type: "string" },
      "kiro-ide-port": { type: "string" },
      "kiro-ide-bin": { type: "string" },
      "kiro-ide-user-data-dir": { type: "string" },
      "kiro-ide-no-new-session": { type: "boolean", default: false },
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
      // #106: run in a temp copy with no ancestor instruction files.
      hermetic: { type: "boolean", default: false },
      // #75: run in a git worktree + branch.
      ...ISOLATE_FLAG_OPTIONS,
      // #195: interactive runs (the agent's TUI in an ach-owned PTY).
      interactive: { type: "boolean", default: false },
      tui: { type: "boolean", default: false },
      then: { type: "string", multiple: true },
      "pause-between": { type: "boolean", default: false },
      "trust-workspace": { type: "boolean", default: false },
    },
    allowPositionals: true,
    tokens: true,
  });
  // #77: the profile the choke point expanded, recorded on the RunRecord.
  const resolution = takeResolution();
  const profileInfo = resolution !== null ? profileRecord(resolution) : undefined;
  const profileEnv = resolution?.profile !== undefined && Object.keys(resolution.profile.env).length > 0 ? resolution.profile.env : undefined;
  const exitMode = parseExitCodesMode(args.values["exit-codes"]);
  const trialFlags = parseTrialFlags(args.values);
  const interactive = parseInteractiveFlags(args.values, trialFlags);
  const hermetic = args.values.hermetic === true;
  if (hermetic && args.values.resume !== undefined) {
    // Claude (and codex) look sessions up by project directory; a fresh temp
    // copy is a different directory, so a resumed hermetic run would not find
    // the session it names.
    throw new HarnessError("--hermetic runs in a fresh temp copy of the workspace; it cannot be combined with --resume", "USAGE");
  }
  if (hermetic && trialFlags.parallel !== undefined && trialFlags.parallel > 1) {
    throw new HarnessError("--hermetic syncs each run back into the one workspace; it cannot be combined with --parallel > 1", "USAGE");
  }
  const isolate = isolateOptionsFromFlags(args.values, { hermetic, resume: args.values.resume !== undefined });
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
  if (interactive !== null) assertInteractiveSupported(agent, args.values.resume);
  // #72: the global tier from the flag (or the file's run.captureMode / a
  // profile, injected by the choke point), labeled with its layer; the env
  // var and the file's contentCapture policy are resolved by the driver.
  const captureOptions = runCaptureOptions(args.values["capture-mode"], resolution);

  // The adapter registry takes no options (driver.ts defaultAdapters), so the
  // flag travels as the env var the Claude adapter already honours.
  if (args.values["claude-default-config"]) process.env.AGENTIC_CODING_HARNESS_DEFAULT_CLAUDE_CONFIG = "1";
  if (args.values["claude-no-background-tasks"]) process.env.AGENTIC_CODING_HARNESS_CLAUDE_DISABLE_BACKGROUND_TASKS = "1";

  // #195: with --interactive in a terminal, the TUI is mirrored there and the
  // usual one-line event feed would draw over it.
  const mirror = interactive !== null && !args.values.json && process.stdin.isTTY === true && process.stdout.isTTY === true;
  const callStarts = new Map<string, number>();
  const onEvent = (e: AgentEvent) => {
    if (mirror) return;
    const line = formatEventLine(e, callStarts);
    if (line !== null) process.stderr.write(line + "\n");
  };
  const basePricer = createPricer();
  const runAdapters = custom.adapter ? { ...(await defaultAdapters()), [agent]: custom.adapter } : await defaultAdapters();
  if (interactive !== null) {
    runAdapters.claude = new ClaudeInteractiveAdapter({
      stateDir: stateDir(),
      then: interactive.then,
      pauseBetween: interactive.pauseBetween,
      trustWorkspace: interactive.trustWorkspace,
      mirror,
      ...(mirror && process.stdout.columns > 0 ? { cols: process.stdout.columns, rows: process.stdout.rows } : {}),
    });
  }
  const driver = createDriver({
    adapters: runAdapters,
    stateDir: stateDir(),
    pricer: custom.wrapPricer ? custom.wrapPricer(basePricer) : basePricer,
    onEvent,
    registry: { stateDir: stateDir() },
    capture: captureOptions,
  });

  const built = runSpecFromFlags(agent, args.values, args.tokens, prompt, trialFlags.labels.variant);
  const { budget, sandbox } = built;
  // #13: warn once per sandbox field the chosen agent has no flag for, and
  // print the resolved policy.
  if (sandbox !== undefined) {
    for (const w of sandboxDropWarnings(agent, sandbox, { kiroToolsSet: args.values["kiro-tools"] !== undefined })) {
      process.stderr.write(`[warn] ${w}\n`);
    }
    process.stderr.write(formatSandboxHeader(sandbox) + "\n");
  }
  const evidenceDir = args.values["evidence-dir"];
  if (evidenceDir !== undefined && evidenceDir.trim() === "") throw new HarnessError("--evidence-dir needs a directory", "USAGE");
  if (profileEnv !== undefined && ENV_IGNORING_AGENTS.has(agent)) {
    process.stderr.write(`[warn] profile '${profileInfo!.name}' sets env (${Object.keys(profileEnv).join(", ")}), but agent '${agent}' starts no child process to pass it to; ignored\n`);
  }
  const spec: RunSpec = {
    ...built.spec,
    // #195: an interactive run is keyed by runId before launch (live socket, .cast).
    ...(interactive !== null ? { runId: randomUUID() } : {}),
    // #77: profile env goes to the agent process only, never into ach's own env.
    ...(profileEnv !== undefined ? { env: profileEnv } : {}),
    ...(profileInfo !== undefined ? { profile: profileInfo } : {}),
  };
  // #106: ancestor instruction files. Non-hermetic: warn BEFORE launch (the
  // driver records them on the RunRecord). Hermetic: announce the temp copy.
  if (!hermetic) {
    const runCwd = process.cwd();
    const leaks = findAncestorInstructions(agent, runCwd);
    if (leaks.length > 0) process.stderr.write(formatAncestorWarning(agent, runCwd, leaks) + "\n");
  }
  const trialOpts = {
    driver,
    agent,
    spec,
    stateDir: stateDir(),
    ...(trialFlags.verify !== undefined ? { verify: trialFlags.verify } : {}),
    labels: trialFlags.labels,
    ...(isolate !== undefined
      ? {
          isolate: {
            ...isolate,
            onPrepared: (ws: IsolatedWorkspace) => process.stderr.write(`[isolate] running in ${ws.agentCwd} on branch ${ws.branch} (base ${ws.baseSha.slice(0, 7)})\n`),
          },
        }
      : {}),
    ...(hermetic
      ? {
          hermetic: {
            onPrepared: (ws: HermeticWorkspace) => {
              const avoided = ws.avoided.length > 0 ? ` (avoids ${ws.avoided.length} ancestor instruction file${ws.avoided.length === 1 ? "" : "s"}: ${ws.avoided.join(", ")})` : "";
              process.stderr.write(`[hermetic] running in ${ws.dir}, synced back to ${ws.source} afterwards${avoided}\n`);
            },
          },
        }
      : {}),
  };

  if (trialFlags.repeat !== undefined) {
    return runRepeatCli(trialOpts, trialFlags.repeat, trialFlags.parallel, args.values.json, args.values.model, exitMode, sandbox, evidenceDir);
  }

  let outcome: TrialOutcome;
  try {
    outcome = await runOnce(trialOpts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // #113: the run settled but the hermetic sync-back failed. Still emit the
    // run record (usage, events, --verify graded on the KEPT copy) with the
    // error attached, then exit non-zero.
    if (err instanceof HermeticSyncError && err.partial?.result !== undefined) {
      const { result: settled, verify } = err.partial;
      for (const w of settled.warnings) process.stderr.write(`[warn] ${w}\n`);
      if (args.values.json) {
        const out = { ...settled, ...(verify !== undefined ? { verify } : {}), error: hermeticSyncErrorInfo(err) };
        process.stdout.write(JSON.stringify(out, null, 2) + "\n");
      } else {
        process.stdout.write(runSummaryText(agent, settled, args.values.model, verify) + "\n");
      }
      throw new HarnessError(message, "HERMETIC_SYNC_FAILED");
    }
    // Launch-time outage (#60): exit 20 under the ladder, 1 otherwise.
    if (err instanceof HarnessError && err.code === "UNAVAILABLE") {
      throw new HarnessError(message, "UNAVAILABLE", exitMode === "ladder" ? EXIT_CODES.indeterminate : 1);
    }
    throw new HarnessError(message, "RUN_FAILED");
  }
  const result = outcome.result!;
  for (const w of result.warnings) process.stderr.write(`[warn] ${w}\n`);
  if (outcome.annotateFailed) process.stderr.write(`[warn] registry: could not record verify/labels on run ${result.runId}\n`);

  if (evidenceDir !== undefined) {
    const p = writeMetricsSidecar(evidenceDir, buildRunMetrics({ agent, ...(args.values.model !== undefined ? { modelFlag: args.values.model } : {}), result, ...(sandbox ? { sandbox } : {}), ...(outcome.verify ? { verifyStatus: outcome.verify.status } : {}) }));
    process.stderr.write(`[evidence] wrote ${p}\n`);
  }

  if (args.values.json) {
    // Full RunResult: sessionId, events, tokens, totalCost, durationMs,
    // exitStatus, warnings — plus `verify` only when a checker ran, and the
    // resolved `sandbox` policy (inline MCP JSON redacted) when flags set one.
    const out = {
      ...result,
      ...(outcome.verify !== undefined ? { verify: outcome.verify } : {}),
      ...(sandbox !== undefined ? { sandbox: describeSandbox(sandbox) } : {}),
      ...(profileInfo !== undefined ? { profile: profileInfo } : {}),
    };
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  } else {
    process.stdout.write(runSummaryText(agent, result, args.values.model, outcome.verify) + (profileInfo !== undefined ? `\n${formatProfileLine(profileInfo)}` : "") + "\n");
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
  sandbox?: SandboxPolicy,
  evidenceDir?: string,
): Promise<number> {
  const { group, outcomes } = await runRepeatGroup({
    ...opts,
    count,
    ...(parallel !== undefined ? { parallel } : {}),
    onSettled: (o) => {
      for (const w of o.result?.warnings ?? []) process.stderr.write(`[warn] [${o.index}] ${w}\n`);
      if (o.annotateFailed) process.stderr.write(`[warn] [${o.index}] registry: could not record repeat/verify on the run\n`);
      if (o.error !== undefined) process.stderr.write(`[error] [${o.index}] ${o.error}\n`);
      if (evidenceDir !== undefined && o.result !== undefined) {
        const p = writeMetricsSidecar(evidenceDir, buildRunMetrics({ agent: opts.agent, ...(modelFlag !== undefined ? { modelFlag } : {}), result: o.result, ...(sandbox ? { sandbox } : {}), ...(o.verify ? { verifyStatus: o.verify.status } : {}) }), `metrics-${o.index}.json`);
        process.stderr.write(`[evidence] wrote ${p}\n`);
      }
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
    ).map((r, i) => (outcomes[i]!.result !== undefined && outcomes[i]!.error !== undefined ? { ...r, error: outcomes[i]!.error } : r));
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

/** Agents that start no child process, so a profile's `env` cannot reach them. */
const ENV_IGNORING_AGENTS: ReadonlySet<string> = new Set(["kiro-ide", "null"]);

/** `profile    fast (budget-usd=0.2 from flag; profile had 0.5)` under the run summary. */
function formatProfileLine(p: RunProfileInfo): string {
  const over = Object.entries(p.overridden ?? {}).map(([flag, was]) => `${flag}=${String(p.expanded[flag])} from ${p.sources[flag]}; profile had ${String(was)}`);
  return `profile    ${p.name}${over.length > 0 ? ` (${over.join(", ")})` : ""}`;
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
  // #158: the reconciled usage value (stream > session store > tap) beats the
  // raw per-record sum, which is the 56x-low tap total on a kiro V3 run.
  const reconciledCredits = result.usage?.credits;
  if (agent === "kiro" && reconciledCredits?.available === true && reconciledCredits.value !== undefined) {
    totalCredits = reconciledCredits.value;
  }
  if (totalCredits !== undefined) {
    // Units stay apart (#23): kiro credits vs copilot AIU ("AI credits").
    summary += creditUnitOfAgent(agent) === "copilot"
      ? `\nAI credits (copilot) ${totalCredits.toFixed(2)}`
      : `\ncredits    ${totalCredits.toFixed(2)}`;
  }
  if (agent === "kiro" && kiroSession !== undefined) summary += `\nkiroSession ${kiroSession}`;
  // #32: ttft / throughput / per-tool durations, only the ones measured.
  for (const l of formatLatencyLines(runLatency(result))) summary += `\n${l}`;
  // #106: ancestor instruction files that reached the run, or the hermetic copy.
  if (result.ancestorInstructions !== undefined && result.ancestorInstructions.length > 0) {
    summary += `\nancestors  ${result.ancestorInstructions.length} instruction file${result.ancestorInstructions.length === 1 ? "" : "s"} from ancestor dirs: ${result.ancestorInstructions.join(", ")}`;
  }
  if (result.hermetic !== undefined) summary += `\n${formatHermeticLine(result.hermetic)}`;
  if (result.worktree !== undefined) summary += `\n${formatIsolateLine(result.worktree)}`;
  // #73: the run's W3C traceparent (copy into any tracing UI or a downstream TRACEPARENT).
  if (result.trace !== undefined) summary += `\n${formatTraceLine(result.trace)}`;
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
      "kiro-ide-cdp": { type: "string" },
      "kiro-ide-port": { type: "string" },
      "kiro-ide-bin": { type: "string" },
      "extra-args": { type: "string", multiple: true },
      "extra-arg": { type: "string", multiple: true },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
    tokens: true,
  });
  const agent = args.values.agent;
  if (agent === "kiro-ide") {
    // No ACP handshake here: the IDE is observed over CDP, read-only. Same
    // rows as `ach doctor --agent kiro-ide`.
    const ide = kiroIdeConfigFromFlags({
      ...(args.values["kiro-ide-cdp"] !== undefined ? { "kiro-ide-cdp": args.values["kiro-ide-cdp"] } : {}),
      ...(args.values["kiro-ide-port"] !== undefined ? { "kiro-ide-port": args.values["kiro-ide-port"] } : {}),
      ...(args.values["kiro-ide-bin"] !== undefined ? { "kiro-ide-bin": args.values["kiro-ide-bin"] } : {}),
    });
    const checks = await checkKiroIde({
      env: { ...process.env },
      cwd: args.values.cwd ?? process.cwd(),
      endpoint: endpointFrom(ide?.cdp, ide?.port ?? 9222),
      ...(ide?.bin !== undefined ? { bin: ide.bin } : {}),
    });
    const ok = checks.every((c) => c.status !== "failed");
    if (args.values.json) {
      process.stdout.write(JSON.stringify({ ok, checks }, null, 2) + "\n");
    } else {
      for (const c of checks) process.stdout.write(`${c.status.padEnd(8)} ${c.name.padEnd(11)} ${c.detail} (${c.ms}ms)\n`);
      process.stdout.write(`ok       ${String(ok)}\n`);
    }
    return ok ? 0 : 1;
  }
  if (agent !== "kiro") {
    throw new HarnessError(
      `preflight supports --agent kiro|kiro-ide only (got '${agent ?? "<missing>"}')`,
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
  // #104: repeatable; --extra-args space-split, --extra-arg verbatim — same rule as `run`.
  const extraArgs = orderedExtraArgs(args.tokens);
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
      // #99: repeatable; several roots are tailed in one stream, each line tagged with its root.
      dir: { type: "string", multiple: true },
      "transcript-dir": { type: "string", multiple: true },
      rewrite: { type: "string", multiple: true },
      since: { type: "string" },
      last: { type: "string" },
      tz: { type: "string" },
      "exit-codes": { type: "string" },
      offline: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  if (args.values.offline) installOfflineGuard();
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
  // --transcript-dir (alias --dir): home-shaped roots to read transcripts from.
  // Several roots (#99) multiplex into one stream; each event names its root.
  const transcriptDirs = resolveDirFlags(args.values, "transcript-dir");
  const rewrites = parseRewriteRules(args.values.rewrite);
  const tagRoots = transcriptDirs.length > 1;
  const sources: Array<ReturnType<typeof transcriptSources>[number] & { root?: string }> =
    transcriptDirs.length === 0
      ? transcriptSources({})
      : transcriptDirs.flatMap((d) => transcriptSources(scanOptionsForRoot(path.resolve(d))).map((s) => ({ ...s, root: path.resolve(d) })));
  const state = stateDir();
  const offsets = await loadOffsets();
  type WatchTotals = { agent: string; sessionId: string; model: string | null; input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number; vendorCost?: number; vendorMetered?: boolean };
  const seenByFile = new Map<string, Map<string, WatchTotals>>();
  const seenOpencode = new Set<string>();
  const pricer = createPricer();
  process.stderr.write(`watch: ${sources.map((s) => `${s.agent}=${s.dir}`).join(" ")}\n`);
  process.stderr.write(`watch: state=${state}, poll=${POLL_MS / 1000}s — Ctrl-C to stop\n`);
  const rewriteLine = rewritesTextLine(rewrites, WATCH_REWRITE_FIELDS);
  if (rewriteLine !== null) process.stdout.write(rewriteLine + "\n");

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void saveOffsets(offsets).finally(() => flushAndExit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  type WatchedAgent = "claude" | "codex" | "gemini" | "prime" | (typeof TRANSCRIPT_SOURCES)[number]["agent"];
  interface Watched {
    file: string;
    agent: WatchedAgent;
    /** The --dir root the file was found under; set only when several roots are tailed. */
    root?: string;
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
        costUsd?: number;
        extra?: Record<string, unknown>;
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
        watched.push({ file, agent: src.agent, parse: src.parse, ...(tagRoots && src.root !== undefined ? { root: src.root } : {}) });
      }
    }
    const deltas = new Map<string, { agent: string; sessionId: string; root?: string; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; priced: boolean }>();
    const bump = (r: { agent?: string; sessionId?: string | null; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd?: number }, root?: string) => {
      const agent = r.agent ?? "unknown";
      const sessionId = r.sessionId ?? "unknown";
      // The same session under two roots stays two lines, one per root (#99).
      const key = root === undefined ? `${agent}\u0000${sessionId}` : `${agent}\u0000${sessionId}\u0000${root}`;
      const d = deltas.get(key) ?? { agent, sessionId, ...(root !== undefined ? { root } : {}), input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, priced: true };
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
        // Vendor-metered (copilot AIU) rows carry their own USD; never token-priced.
        if (rec.extra?.vendorMetered === true) {
          value.vendorMetered = true;
          if (rec.costUsd !== undefined) value.vendorCost = (value.vendorCost ?? 0) + rec.costUsd;
        }
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
        const vendorCost = value.vendorMetered ? Math.max(0, (value.vendorCost ?? 0) - (before?.vendorCost ?? 0)) : undefined;
        if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens === 0 && !vendorCost) continue;
        const priced = value.vendorMetered ? (value.vendorCost !== undefined ? vendorCost! : NaN) : value.model ? pricer.price({ model: value.model, sessionId: value.sessionId, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cacheWrite1hTokens }) : NaN;
        bump({ agent: value.agent, sessionId: value.sessionId, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
          ...(Number.isFinite(priced) ? { costUsd: priced } : {}) }, w.root);
      }
      seenByFile.set(w.file, totals);
      offsets.files[w.file] = fingerprint;
    }

    // --- opencode SQLite store (adapter). First tick baselines silently.
    try {
      for (const s of transcriptDirs.length > 0 ? [] : await statsFromDb()) {
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
        `${d.agent.padEnd(8)} ${d.sessionId.slice(0, 12).padEnd(12)} +${fmtInt(d.input)} input +${fmtInt(d.output)} output +${fmtInt(d.cacheRead)} cacheR +${fmtInt(d.cacheWrite)} cacheW ${d.priced ? fmtUsd(d.cost) : "n/a"} source: transcript${d.root !== undefined ? ` dir: ${rewritePath(d.root, rewrites)}` : ""}\n`,
      );
    }
    firstTick = false;
    await saveOffsets(offsets).catch(() => {});
  };

  await tick();
  // The interval holds the event loop open; watch runs until SIGINT/SIGTERM.
  const timer = setInterval(
    () =>
      void tick().catch((err: unknown) => {
        // Transient tick errors are ignored, but an --offline breach is never silent.
        if (err instanceof OfflineViolation) {
          process.stderr.write(`harness: ${err.message}\n`);
          process.exit(err.exitCode);
        }
      }),
    POLL_MS,
  );
  await new Promise<never>(() => {});
  return 0; // unreachable: the promise above never resolves
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

/** `write` receives the --json document (default stdout); `ach export` (#96) captures it as stats.json. */
async function cmdStats(rest: string[], write: (chunk: string) => void = (chunk) => void process.stdout.write(chunk)): Promise<number> {
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
      // #42: period-over-period comparison: prev | prev:<dur>
      compare: { type: "string" },
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
      // #99: repeatable transcript roots and state dirs, merged; --rewrite maps output paths.
      dir: { type: "string", multiple: true },
      "transcript-dir": { type: "string", multiple: true },
      "state-dir": { type: "string", multiple: true },
      rewrite: { type: "string", multiple: true },
      "cost-mode": { type: "string" },
      // #85: trend sparkline on the totals line.
      spark: { type: "string" },
      "no-spark": { type: "boolean", default: false },
      // #25: provenance filter. Not --source: `ach web --source` is a run feed,
      // and stats rows already carry source: state|transcript.
      origin: { type: "string" },
      // #40: no network may be touched; any outbound call throws OfflineViolation.
      offline: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  if (args.values.offline) installOfflineGuard();
  const exitMode = parseExitCodesMode(args.values["exit-codes"]);
  const wantOrigin = parseStatsOrigin(args.values.origin);
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
  const sparkMetric = args.values.spark;
  if (sparkMetric !== undefined && sparkMetric !== "cost" && sparkMetric !== "tokens") {
    throw new HarnessError(`--spark: unknown metric '${sparkMetric}' (expected cost or tokens)`, "USAGE");
  }
  // --transcript-dir (alias --dir): home-shaped roots for machine transcripts;
  // --state-dir: harness state dirs (#99). Several of either merge.
  const transcriptDirs = resolveDirFlags(args.values, "transcript-dir");
  const stateDirs = resolveDirFlags({ "state-dir": args.values["state-dir"] }, "state-dir");
  const rewrites = parseRewriteRules(args.values.rewrite);

  // Every record gets a reported cost (state lines that carried costUsd; the
  // machine transcripts carry none) and a computed one (token × bundled price,
  // never reading CLI-reported slice costs), then --cost-mode picks between
  // them. `pricer` prices values the mode actually uses, so its unknown-model
  // warnings surface; `probe` prices values used only for the disagreement
  // check, and its warnings are dropped.
  const pricer = createPricer();
  const probe = createPricer();
  const disagreements: string[] = [];
  // Desk-host lines are per-message DELTAS (src/desks/host-metering.ts): an engine-priced message writes its whole
  // reported cost on the line that first carries it and costUsd 0 on later lines that only add tokens. A per-line
  // check would flag every such line (reported 0 vs computed > 0), so their figures are kept here (keyed by the
  // shared `extra` object, which the record keeps) and compared per message once the records are filtered.
  const clippedDeskMsgs = new Set<string>();
  const deskDelta = new WeakMap<object, { key: string; label: string; reported?: number; computed?: number }>();
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
    const label = `${r.agent} session=${r.sessionId ?? "unknown"} model=${r.model ?? "unknown"}`;
    const ex = r.extra;
    if (ex && ex.source === "desk-host" && typeof ex.messageId === "string" && ex.messageId !== "") {
      deskDelta.set(ex, { key: `${r.agent}\0${r.sessionId ?? ""}\0${String(ex.runId ?? "")}\0${ex.messageId}`, label, reported, computed });
      return selectCost(costMode, reported, computed);
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
  if (agent && !isKnownAgent(agent) && !isTranscriptOnlyAgent(agent) && !transcriptAgentNames().includes(agent) && agent !== "custom" && !findDescriptor(catalog, agent)) {
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
  // #42: --compare reads from the earlier window's start and buckets into the two windows below.
  const compareSpec = args.values.compare !== undefined ? parseCompareSpec(args.values.compare) : undefined;
  const periods = compareSpec ? resolveComparePeriods(compareSpec, window, Date.now(), timeZone) : undefined;
  const loadWindow: TimeWindow = periods
    ? { sinceMs: Math.min(periods.previous.sinceMs, periods.current.sinceMs), ...(window.untilMs !== undefined ? { untilMs: window.untilMs } : {}) }
    : window;
  const loadSinceTs = loadWindow.sinceMs;

  // Harness state (driver-run NDJSON + watch-persisted opencode) ...
  const withWarehouse = args.values["with-warehouse"];
  const src = await openStatsSources({
    stateDirs: stateDirs.length > 0 ? stateDirs : [stateDir()],
    transcriptDirs,
    withWarehouse,
    read: { agent, sinceTs: loadSinceTs },
    warn: (l) => process.stderr.write(l + "\n"),
  });
  const stateRecords = src.stateRecords.filter((r) => {
    if (inWindow(Date.parse(r.ts), loadWindow)) return true;
    // A desk message with a line outside the window is partial in-window: its reported cost can't be compared to the in-window tokens.
    const ex = r.extra as Record<string, unknown> | undefined;
    if (ex && ex.source === "desk-host" && typeof ex.messageId === "string" && ex.messageId !== "") {
      clippedDeskMsgs.add(`${r.agent}\0${r.sessionId ?? ""}\0${String(ex.runId ?? "")}\0${ex.messageId}`);
    }
    return false;
  });
  // One registry scan feeds both the cwd index and the run rollups; records
  // that fail to parse are counted (skippedRunRecords), never dropped silently.
  const registryScan = src.registryScan;
  const runCwd = cwdIndex(registryScan.records);
  const runBranch = branchIndex(registryScan.records);
  const runPr = prIndex(registryScan.records);
  const runDesk = deskIndex(registryScan.records);
  // Driver NDJSON usage lines carry no sessionId: look those up by run id first.
  const cwdByRun = runIdIndex(registryScan.records, (r) => r.cwd ?? undefined);
  const branchByRun = runIdIndex(registryScan.records, (r) => branchLabel(r));
  const prByRun = runIdIndex(registryScan.records, (r) => r.pr ?? undefined);
  const deskByRun = deskByRunId(registryScan.records);
  const originIndex = statsOriginIndex(registryScan.records);
  let records: (DimRecord & StatsProvenanceRecord & { costDisagreement?: string; source: "state" | "transcript"; origin?: StatsOrigin })[] = stateRecords.map((r) => ({
    source: "state",
    extra: r.extra,
    cwd: cwdByRun(r.runId) ?? runCwd(r.agent, r.sessionId),
    branch: branchByRun(r.runId) ?? runBranch(r.agent, r.sessionId),
    pr: prByRun(r.runId) ?? runPr(r.agent, r.sessionId),
    // #204: the desk host stamps extra.desk on its own records; driver-engine turn runs map via the registry.
    desk: deskLabel(r.extra?.desk) ?? deskByRun(r.runId) ?? runDesk(r.agent, r.sessionId),
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
  // Sessions `ach run` owns (state records or a non-imported registry run).
  // Copilot's shutdown record is a CUMULATIVE per-session snapshot whose
  // timestamp never equals the run's own record, so the composite dedupeKey
  // cannot collapse the pair: skip the transcript copy by session instead (#23).
  const runOwned = new Set<string>(stateRecords.map((r) => `${r.agent}\0${r.sessionId}`));
  for (const r of registryScan.records) if (r.sessionId && r.source !== "imported") runOwned.add(`${r.agent}\0${r.sessionId}`);

  // Imported Cursor dashboard exports (stateDir data, so read even with
  // --state-only) carry the billed cost: they replace the matching `ach run`
  // cursor rows and the Cursor IDE-store rows inside their span.
  let dashSpan: DashboardSpan | null = null;
  if (!agent || agent === "cursor") {
    const dashAll = src.cursorDashboard();
    dashSpan = dashboardSpan(dashAll);
    const dash = dashAll.filter((d) => inWindow(d.timestamp ? Date.parse(d.timestamp) : NaN, loadWindow));
    const rec = reconcileDashboardWithState(dash, records);
    records = records.filter((r) => !rec.dropped.has(r));
    for (const m of rec.matches) {
      const d = m.rec;
      const from = m.replaced[0];
      const row = {
        ts: d.timestamp,
        agent: d.agent,
        sessionId: m.sessionId ?? "unknown",
        model: d.model ?? undefined,
        inputTokens: d.input,
        outputTokens: d.output,
        cacheReadTokens: d.cacheRead,
        cacheWriteTokens: d.cacheWrite,
        reasoningTokens: d.reasoning,
        ...(d.extra !== undefined ? { extra: d.extra } : {}),
      };
      const cwd = from?.cwd ?? runCwd(d.agent, m.sessionId ?? undefined);
      const branch = from?.branch ?? runBranch(d.agent, m.sessionId ?? undefined);
      const pr = runPr(d.agent, m.sessionId ?? undefined);
      records.push({ ...row, ...costFor(row, d.costUsd), ...(cwd ? { cwd } : {}), ...(branch ? { branch } : {}), ...(pr ? { pr } : {}), source: "transcript" });
    }
  }

  // ... plus machine CLI transcripts (claude/codex/gemini), computed-only (no
  // reported cost on these rows). costUsd is set only when the record has a
  // model the pricer knows; undefined costs contribute nothing to the sums.
  // --state-only skips this scan entirely: stateDir records only (e.g. on a
  // machine whose transcript dirs are huge or being rotated).
  if (!args.values["state-only"]) {
    const machine = src.machineRecords();
    for await (const rec of machine) {
      if (agent && rec.agent !== agent) continue;
      const tsMs = rec.timestamp ? Date.parse(rec.timestamp) : NaN;
      if (!inWindow(tsMs, loadWindow)) continue;
      // The dashboard export covers this span with billed numbers: its rows replace the IDE store's.
      if (rec.agent === "cursor" && inDashboardSpan(dashSpan, tsMs)) continue;
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
        ...(rec.extra !== undefined ? { extra: rec.extra } : {}),
      };
      // copilot + agy: the run already recorded these calls (agy run rows may
      // carry a different model label, so dedupeKey alone would not collapse them).
      if ((rec.agent === "copilot" || rec.agent === "agy") && runOwned.has(`${rec.agent}\0${rec.sessionId}`)) continue;
      const key = dedupeKey(row);
      if (seen.has(key)) continue;
      seen.add(key);
      const cwd = rec.cwd ?? runCwd(rec.agent, rec.sessionId);
      // Branch only via the run registry (session match): no fixture proves transcripts carry gitBranch, and we never shell out per row.
      const branch = runBranch(rec.agent, rec.sessionId);
      const pr = runPr(rec.agent, rec.sessionId);
      records.push({ ...row, ...costFor(row, rec.costUsd), ...(cwd ? { cwd } : {}), ...(branch ? { branch } : {}), ...(pr ? { pr } : {}), source: "transcript" });
    }
    // agents.d usage taps (#38): descriptor-declared transcript sources.
    const tap = await descriptorTapRows(catalog, pricer, { agent, sinceTs: loadSinceTs, costMode });
    for (const row of tap.rows) {
      // Tap rows honour the full #26 [since, until) window, not only sinceTs.
      if (!inWindow(row.ts ? Date.parse(row.ts) : NaN, loadWindow)) continue;
      const key = dedupeKey(row);
      if (seen.has(key)) continue;
      seen.add(key);
      records.push({ ...row, source: "transcript" });
    }
    for (const w of new Set(tap.warnings)) process.stderr.write(`[warn] ${w}\n`);
  }
  for (const w of new Set(pricer.drainWarnings())) process.stderr.write(`[warn] ${w}\n`);
  // #40: bundled-snapshot provenance; the notice goes to stderr so --json stays clean.
  const pricingInfo = pricer.meta?.() ?? pricingMeta();
  const staleNotice = pricingStaleNotice(pricingInfo);
  if (staleNotice !== null) process.stderr.write(staleNotice + "\n");
  for (const w of drainTranscriptWarnings()) process.stderr.write(`[warn] ${w}\n`);
  const skippedRunRecords = registryScan.skipped.length;
  for (const w of src.skippedWarnings) process.stderr.write(w + "\n");
  // --project also accepts the rewritten spelling of a root (#99).
  const rewriteProject = rewrites.length > 0 ? (p: string) => rewritePath(p, rewrites) : undefined;
  const matchesProject = (cwd: string | null | undefined, want: string): boolean =>
    projectMatches(cwd, want, projectAliases) || (rewriteProject !== undefined && !!cwd && rewriteProject(projectOf(cwd, projectAliases).name) === want);

  if (wantProject !== undefined) records = records.filter((r) => matchesProject(r.cwd, wantProject));
  // #25: label every row with its origin (numbers unchanged), then --origin filters.
  for (const r of records) r.origin = originIndex.originOf(r);
  if (wantOrigin !== "all") records = records.filter((r) => r.origin === wantOrigin);
  // #42: split the wide read into the selected and the comparison window. Everything below
  // (totals, byDay, dims, blocks) sees only the selected window, exactly as without --compare.
  let previousRecords: typeof records = [];
  if (periods) {
    const inP = (r: { ts: string | null }, w: { sinceMs: number; untilMs: number }) => inWindow(r.ts ? Date.parse(r.ts) : NaN, { sinceMs: w.sinceMs, untilMs: w.untilMs });
    previousRecords = records.filter((r) => inP(r, periods.previous));
    records = records.filter((r) => inP(r, periods.current));
  }
  disagreements.push(...records.flatMap((r) => r.costDisagreement ? [r.costDisagreement] : []));
  {
    // Per message: the sum of a desk message's reported deltas vs the price of the sum of its token deltas.
    const msgs = new Map<string, { label: string; reported: number; anyReported: boolean; computed: number; priced: boolean }>();
    for (const r of records) {
      const m = r.extra ? deskDelta.get(r.extra) : undefined;
      if (!m) continue;
      const g = msgs.get(m.key) ?? { label: m.label, reported: 0, anyReported: false, computed: 0, priced: true };
      if (m.reported !== undefined) {
        g.reported += m.reported;
        g.anyReported = true;
      }
      if (m.computed === undefined) g.priced = false;
      else g.computed += m.computed;
      msgs.set(m.key, g);
    }
    for (const [key, g] of msgs) {
      // A message with a line outside the window is skipped (partial computed vs full reported). A reported message always sums above 0; a 0 sum means the window cut off the line that carried its cost.
      if (!g.anyReported || !g.priced || g.reported === 0 || clippedDeskMsgs.has(key)) continue;
      const d = costDisagreement(g.reported, g.computed);
      if (d) disagreements.push(formatDisagreement(g.label, d));
    }
  }
  const agg = aggregate(records, { timeZone, by });
  // #142: codex parent/child reconciliation over the windowed codex rows —
  // which totals include child sessions, and which trees miss some.
  const codexRows = records.filter((r) => r.agent === "codex");
  const codexAccounting = codexRows.length > 0 ? reconcileCodexSessions(codexSessionUsageFromRecords(codexRows)) : undefined;
  const codexAccountingJson =
    codexAccounting === undefined
      ? undefined
      : {
          ...codexAccounting.summary,
          incomplete: codexAccounting.roots
            .filter((r) => !r.complete)
            .map((r) => ({
              rootSessionId: r.rootSessionId,
              rootFound: r.rootFound,
              scope: r.scope,
              countedChildSessions: r.countedChildSessionIds.length,
              missingChildSessionIds: r.missingChildSessionIds,
            })),
        };
  const showProject = dimsBy.has("project") || wantProject !== undefined;
  const dims = aggregateDims(records, {
    costMode, timeZone,
    pricer: createPricer(),
    mergeModels: args.values["merge-models"],
    modelAliases,
    byModelDay: dimsBy.has("model"),
    byProject: showProject,
    byBranch: dimsBy.has("branch"),
    byPr: dimsBy.has("pr"),
    byDesk: dimsBy.has("desk"),
    projectAliases,
    ...(rewriteProject !== undefined ? { rewriteProject } : {}),
  });
  if (dims.unpricedModels.length > 0) {
    process.stderr.write(
      `[warn] unpriced models (tokens counted, cost n/a and excluded from totals): ${dims.unpricedModels.join(", ")}\n`,
    );
  }
  // Run records from the registry, honouring the full #26 [since, until) window.
  const windowedRunRecords = registryScan.records.filter((r) => inWindow(r.startedAt, window) && (wantProject === undefined || matchesProject(r.cwd, wantProject)) && (wantOrigin === "all" || originIndex.runOrigin(r) === wantOrigin));
  // Run outcomes (#60) from the run registry: shown only when there are runs,
  // so the historical {total, byAgent, byDay} shape is untouched otherwise.
  // Imported sessions (#25) carry no task verdict: kept out of the outcome,
  // repeat-group and unmetered rollups (they still appear in `runs`).
  const runRecords = windowedRunRecords.filter((r) => (!agent || r.agent === agent) && r.source !== "imported");
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
  const unmetered = unmeteredRuns(src.primaryStateDir, { agent, sinceTs, records: runRecords });
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
  // #42: the compare section (only with --compare).
  let compare: ReturnType<typeof compareJson> | undefined;
  if (periods && compareSpec) {
    const runFilter = (r: RunRecord) =>
      (wantProject === undefined || projectMatches(r.cwd, wantProject, projectAliases)) &&
      (wantOrigin === "all" || originIndex.runOrigin(r) === wantOrigin) &&
      (!agent || r.agent === agent) &&
      r.source !== "imported";
    const hasData = new Set(stateRecords.map((r) => r.runId).filter((x): x is string => typeof x === "string"));
    const period = (w: { sinceMs: number; untilMs: number }, rows: typeof records) => {
      const runsIn = registryScan.records.filter((r) => inWindow(r.startedAt, w) && runFilter(r));
      return {
        window: w,
        totals: periodTotals(view(aggregate(rows, { timeZone, by }).totals), runsIn.length),
        unexplained: unexplainedDays(runsIn, w, timeZone, hasData),
      };
    };
    compare = compareJson(period(periods.current, records), period(periods.previous, previousRecords), compareSpec);
  }
  // Preserve origin through aggregation so readers can distinguish harness
  // state from read-only transcripts even when both contain the same agent.
  const sources = Object.fromEntries((["state", "transcript"] as const).map((source) => {
    const rows = records.filter((r) => r.source === source);
    return [source, { ...view(aggregate(rows, { timeZone, by }).totals), provenance: statsProvenance(rows, { timeZone, by }).total }];
  }));
  const hasTranscripts = records.some((r) => r.source === "transcript");
  // #25: per-origin totals, shown once the registry holds imported sessions
  // (or --origin is given) so the historical output shape is otherwise untouched.
  const showOrigins = originIndex.hasImported || wantOrigin !== "all";
  const origins = Object.fromEntries((["native", "imported", "transcript"] as const).map((o) => {
    const rows = records.filter((r) => r.origin === o);
    return [o, { ...view(aggregate(rows, { timeZone, by }).totals), provenance: statsProvenance(rows, { timeZone, by }).total }];
  }));
  // Issue #33: a sibling `provenance` map on every bucket (numbers unchanged).
  const prov = statsProvenance(records, { timeZone, by });
  const mapView = (m: Record<string, typeof agg.totals>, pm: Record<string, ProvenanceMap>) =>
    Object.fromEntries(Object.entries(m).map(([k, b]) => [k, { ...view(b), provenance: pm[k] ?? {} }]));

  const sparkValues =
    sparkMetric === undefined
      ? undefined
      : lastNDays(
          Object.fromEntries(Object.entries(agg.byDay).map(([d, b]) => [d, { ...b, costUsd: view(b).costUsd ?? 0 }])),
          SPARK_DAYS,
          sparkMetric,
          // The trend ends at the window's last day (today when --until is absent), so quiet
          // recent days show as low bars instead of dropping off the end.
          dayKey(window.untilMs !== undefined ? window.untilMs - 1 : Date.now(), timeZone),
        );
  if (args.values.json) {
    write(
      JSON.stringify(
        {
          total: { ...view(agg.totals), costDisagreements: disagreements.length, provenance: prov.total },
          byAgent: mapView(agg.byAgent, prov.byAgent),
          ...(hasTranscripts ? { sources } : {}),
          ...(showOrigins ? { origin: wantOrigin, origins } : {}),
          ...Object.fromEntries(Object.entries(timeMaps).map(([k, v]) => [k, mapView(v, k === "byDay" ? prov.byDay : k === "byWeek" ? prov.byWeek ?? {} : prov.byMonth ?? {})])),
          ...(sparkValues !== undefined ? { spark: { metric: sparkMetric, days: SPARK_DAYS, values: sparkValues } } : {}),
          timezone: timeZone,
          window: windowJson(window),
          ...(compare !== undefined ? { compare } : {}),
          pricing: pricingInfo,
          byModel: dims.byModel,
          unpricedModels: dims.unpricedModels,
          cacheHitRatio: baseCacheRatios(agg),
          ...(dims.byModelDay ? { byModelDay: dims.byModelDay } : {}),
          ...(args.values["merge-models"] ? { mergedModels: true, modelAliases } : {}),
          ...(dims.byProject ? { byProject: dims.byProject, projectAliases } : {}),
          ...(dims.byBranch ? { byBranch: dims.byBranch } : {}),
          ...(dims.byPr ? { byPr: dims.byPr } : {}),
          ...(dims.byDesk ? { byDesk: dims.byDesk } : {}),
          // #142: codex token-accounting scope and completeness.
          ...(codexAccountingJson !== undefined ? { codexAccounting: codexAccountingJson } : {}),
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
          // #99: the --rewrite rules applied to path fields (absent with none).
          ...(rewrites.length > 0 ? { rewrites: rewritesJson(rewrites) } : {}),
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    const line = (label: string, b: CostModeBucket, p: ProvenanceMap | undefined) =>
      `${label.padEnd(9)} records=${fmtInt(b.records)} input=${fmtInt(b.inputTokens)} output=${fmtInt(b.outputTokens)} cacheRead=${fmtInt(b.cacheReadTokens)} cacheWrite=${fmtInt(b.cacheWriteTokens)} reasoning=${fmtInt(b.reasoningTokens)} cost=${b.costUsd === null ? "n/a" : fmtUsd(b.costUsd) + markerFor(p?.costUsd)} cacheHit=${fmtCacheHit(cacheHitRatio(b))}${b.unpricedRecords > 0 ? ` unpriced=${fmtInt(b.unpricedRecords)}` : ""}`;
    const sparkText =
      sparkValues === undefined
        ? ""
        : ` spark(${sparkMetric},${SPARK_DAYS}d)=${sparkline(sparkValues, {
            ascii: args.values["no-spark"] || !sparkSupported(),
            fmt: sparkMetric === "cost" ? fmtUsd : fmtInt,
          })}`;
    process.stdout.write(line("totals", view(agg.totals), prov.total) + ` costMode=${costMode}` + sparkText + "\n");
    if (hasTranscripts) {
      for (const [source, bucket] of Object.entries(sources)) {
        process.stdout.write(line(`source: ${source}`, bucket, bucket.provenance) + "\n");
      }
    }
    if (showOrigins) {
      for (const [o, bucket] of Object.entries(origins)) process.stdout.write(line(`origin: ${o}`, bucket, bucket.provenance) + "\n");
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
      if (a === "codex" && codexAccounting !== undefined) process.stdout.write(formatCodexAccountingLine(codexAccounting.summary) + "\n");
    }
    if (extras.planLine && !agg.byAgent.claude) process.stdout.write(extras.planLine + "\n");
    for (const m of Object.values(timeMaps)) {
      for (const [d, b] of Object.entries(m).sort()) process.stdout.write(line(d, view(b), prov.byDay[d] ?? prov.byWeek?.[d] ?? prov.byMonth?.[d]) + "\n");
    }
    for (const l of renderDimsText(dims, { model: dimsBy.has("model"), project: showProject, branch: dimsBy.has("branch"), pr: dimsBy.has("pr"), desk: dimsBy.has("desk") })) {
      process.stdout.write(l + "\n");
    }
    if (outcomes !== undefined) {
      for (const [a, b] of Object.entries(outcomes.byAgent)) process.stdout.write(formatOutcomeLine(a, b) + "\n");
    }
    for (const l of extras.text) process.stdout.write(l + "\n");
    if (compare !== undefined && periods) {
      for (const l of renderCompareText(compare, periods.current, periods.previous, timeZone)) process.stdout.write(l + "\n");
    }
    for (const g of repeatGroups) process.stdout.write(formatRepeatGroupLine(g, fmtUsd) + "\n");
    const rewriteLine = rewritesTextLine(rewrites, STATS_REWRITE_FIELDS);
    if (rewriteLine !== null) process.stdout.write(rewriteLine + "\n");
    process.stdout.write(`${"legend".padEnd(9)} ${PROVENANCE_LEGEND}
`);
  }
  hintCcusage();
  return noDataExitCode(records.length + runRecords.length, exitMode);
}

/** One stats line: how many codex root sessions are complete, and what their totals include (#142). */
function formatCodexAccountingLine(s: ReturnType<typeof reconcileCodexSessions>["summary"]): string {
  const missing = s.missingChildSessions > 0 ? `, ${fmtInt(s.missingChildSessions)} missing: usage unknown` : "";
  const roots = s.missingRootSessions > 0 ? ` · ${fmtInt(s.missingRootSessions)} parent session(s) not found` : "";
  return `  scope   codex sessions: ${fmtInt(s.roots)} root${s.roots === 1 ? "" : "s"}, ${fmtInt(s.complete)} complete, ${fmtInt(s.partial)} partial · session=${fmtInt(s.scopes.session)} child-inclusive=${fmtInt(s.scopes["child-inclusive"])} parent-only=${fmtInt(s.scopes["parent-only"])} · child sessions ${fmtInt(s.countedChildSessions)}/${fmtInt(s.childSessions)} counted${missing}${roots}`;
}

function hintCcusage(): void {
  const probe = spawnSync("/bin/sh", ["-c", "command -v ccusage >/dev/null 2>&1"], { stdio: "ignore" });
  // #25: offer `ach import` first; ccusage stays the alternative.
  if (probe.status === 0) process.stderr.write(ccusageHintText());
}

// ---------------------------------------------------------------- emit

const EventStreamSchema = z.union([
  z.array(z.unknown()),
  z.object({ events: z.array(z.unknown()) }).transform((o) => o.events),
]);

/** #95: resolve `ach emit --attr/--attr-env` into the enricher attribute map,
 *  printing one stderr warning per skipped entry. Never throws. */
function emitEnrichAttributes(attrs: string[] | undefined, attrEnv: string[] | undefined): Record<string, string> | undefined {
  try {
    const r = resolveEnrichAttributes({ attrs, attrEnv });
    for (const w of r.warnings) process.stderr.write(`ach emit: warning: ${w}\n`);
    return Object.keys(r.attributes).length > 0 ? r.attributes : undefined;
  } catch (e) {
    process.stderr.write(`ach emit: warning: enrichers failed, exporting without them: ${e instanceof Error ? e.message : e}\n`);
    return undefined;
  }
}

/** #95: run the opt-in `--enricher` module. OTel/Langfuse get one result per
 *  span (deriveSpans order); ATIF gets one trajectory-level map merged over
 *  the static attributes. Fail open: every problem is one stderr warning. */
async function emitUserEnricher(
  enricher: string | undefined,
  format: "atif" | "otel" | "langfuse",
  events: AgentEvent[],
  run: { sessionId: string; agent: string; model: string },
  attributes: Record<string, string> | undefined,
): Promise<{ attributes: Record<string, string> | undefined; spanAttributes?: (Record<string, string> | undefined)[] }> {
  if (enricher === undefined || enricher === "") return { attributes };
  const warn = (w: string): void => void process.stderr.write(`ach emit: warning: ${w}\n`);
  const loaded = await loadEnricher(resolveEnricherPath(enricher));
  if (!loaded.fn) {
    if (loaded.warning) warn(loaded.warning);
    return { attributes };
  }
  const ctx = { format, ...run };
  if (format === "atif") {
    const r = await runEnricher(loaded.fn, [{ kind: "trajectory", name: run.agent, operation: "trajectory", attributes: {}, run: ctx }]);
    r.warnings.forEach(warn);
    const dyn = r.results[0];
    return { attributes: dyn ? { ...attributes, ...dyn } : attributes };
  }
  const { root, children } = deriveSpans(events, { sessionId: run.sessionId, agentName: run.agent, model: run.model });
  const inputs: EnricherInput[] = [root, ...children].map((s) => ({
    kind: "span",
    name: s.name,
    operation: String(s.attributes["gen_ai.operation.name"] ?? s.role),
    attributes: { ...s.attributes },
    startTimeMs: s.startMs,
    endTimeMs: s.endMs,
    run: ctx,
  }));
  const r = await runEnricher(loaded.fn, inputs);
  r.warnings.forEach(warn);
  return { attributes, spanAttributes: r.results };
}

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
      "min-score": { type: "string" },
      exit: { type: "string" },
      "full-conversation": { type: "boolean" },
      ...MASK_OPTIONS,
      ...PRIVACY_OPTIONS,
      attr: { type: "string", multiple: true },
      "attr-env": { type: "string", multiple: true },
      enricher: { type: "string" },
    },
    allowPositionals: true,
  });
  // #95: keys the config file's emit section filled in are not typed flags, so
  // the cross-format rejections below must not fire on them.
  const fromFile = new Set((takeResolution()?.effective ?? []).filter((e) => e.source !== "flag").map((e) => e.flag));
  const typed = (k: string): boolean => args.values[k as keyof typeof args.values] !== undefined && !fromFile.has(k);
  const input = args.values.input;
  if (!input) throw new HarnessError("emit requires --input <events.json>", "USAGE");
  const format = args.values.format;
  if (!format || (format !== "atif" && format !== "otel" && format !== "langfuse" && format !== "sft")) {
    throw new HarnessError(`emit requires --format <atif|otel|langfuse|sft> (got '${format ?? ""}')`, "USAGE");
  }
  if (format === "sft") {
    const otherOnly = (["model", "session-id", "langfuse-url", "langfuse-public-key", "langfuse-secret-key"] as const).filter(typed);
    if (otherOnly.length > 0) {
      throw new HarnessError(`${otherOnly.map((k) => `--${k}`).join(", ")} do not apply to --format sft`, "USAGE");
    }
    return runSftEmit({
      input,
      out: args.values.out,
      minScore: optNum(args.values["min-score"], "--min-score"),
      exit: args.values.exit,
      agent: args.values.agent,
      fullConversation: args.values["full-conversation"],
      mask: maskPolicyFor("sft", args.values),
    });
  }
  const sftOnly = (["min-score", "exit", "full-conversation"] as const).filter(typed);
  if (sftOnly.length > 0) {
    throw new HarnessError(`${sftOnly.map((k) => `--${k}`).join(", ")} only applies to --format sft (got '${format}')`, "USAGE");
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
  // #71: the export chokepoint. Mode none (atif's built-in default) passes the input through
  // untouched; otel and langfuse default to all (SINK_DEFAULT_MASK_MODE).
  const gate = maskForExport(parsed, maskPolicyFor(format, args.values));
  if (gate.mode === "preview") {
    writeMaskPreview(input, gate.findings);
    return 0;
  }
  if (gate.mode === "all") noteMasked(input, gate.findings);
  parsed = gate.value;
  // #46: the privacy stamp each sink carries (none when off, so output stays today's).
  const privacy = gate.privacy;
  const stamped = privacy !== "off";
  if (stamped) notePrivacy(input, privacy);
  const stream = EventStreamSchema.safeParse(parsed);
  if (!stream.success) {
    throw new HarnessError(`--input '${input}' must be an event array or {events: [...]}`, "IO");
  }
  const events = stream.data as unknown as AgentEvent[];
  // #95: --attr / --attr-env enrichers (fail open: bad entries warn, never abort).
  const attributes = emitEnrichAttributes(args.values.attr, args.values["attr-env"]);

  // When --input is a full RunResult (not just an event stream), inherit its
  // sessionId/agent/model so callers don't have to restate them per-flag.
  const runResult = (parsed && typeof parsed === "object" && !Array.isArray(parsed))
    ? parsed as { sessionId?: unknown; agent?: unknown; model?: unknown; tokens?: unknown; captureMode?: unknown; trace?: unknown }
    : {};
  // #72: a RunResult carries captureMode only below `full`; stamp it then,
  // so a full run's export stays byte-for-byte what it was.
  const captureStamp: { captureMode?: string } =
    typeof runResult.captureMode === "string" && runResult.captureMode !== "full" ? { captureMode: runResult.captureMode } : {};
  // #73: a RunResult's W3C ids (RunResult.trace); otel/langfuse adopt them.
  const runTrace = readRunTraceContext(runResult.trace);
  // RunResult doesn't carry top-level agent/model — fall back to the first
  // token record's fields so Langfuse span names stay meaningful.
  const firstToken = Array.isArray(runResult.tokens) && runResult.tokens.length > 0
    ? runResult.tokens[0] as { agent?: unknown; model?: unknown }
    : {};
  const defaultSessionId = typeof runResult.sessionId === "string" && runResult.sessionId !== ""
    ? runResult.sessionId
    : "unknown-session";
  // #46: under anon a typed --session-id is hashed too (already-hashed ids stay as they are).
  const sessionId = privacyId(args.values["session-id"] ?? defaultSessionId, privacy);
  const resourceAttributes = stamped ? { "ach.privacy": privacy } : undefined;
  const defaultAgent =
    (typeof runResult.agent === "string" && runResult.agent !== "" && runResult.agent) ||
    (typeof firstToken.agent === "string" && firstToken.agent !== "" && firstToken.agent) ||
    "unknown-agent";
  const defaultModel =
    (typeof runResult.model === "string" && runResult.model !== "" && runResult.model) ||
    (typeof firstToken.model === "string" && firstToken.model !== "" && firstToken.model) ||
    "unknown-model";
  const enriched = await emitUserEnricher(args.values.enricher, format, events, {
    sessionId: args.values["session-id"] ?? defaultSessionId,
    agent: args.values.agent ?? defaultAgent,
    model: args.values.model ?? defaultModel,
  }, attributes);

  let body: string;
  if (format === "atif") {
    const writer = AtifWriter.fromEvents(events, {
      agent: args.values.agent ?? defaultAgent,
      version: VERSION,
      modelName: args.values.model ?? defaultModel,
      sessionId,
      ...(stamped ? { extra: { privacy } } : {}),
      attributes: enriched.attributes,
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
        sessionId,
        agentName: args.values.agent ?? defaultAgent,
        model: args.values.model ?? defaultModel,
        ...(resourceAttributes !== undefined ? { resourceAttributes } : {}),
        ...captureStamp,
        attributes,
        spanAttributes: enriched.spanAttributes,
        ...(runTrace !== undefined ? { trace: runTrace } : {}),
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
        (stamped ? `, privacy ${privacy}` : "") +
        "\n",
    );
    return 0;
  } else {
    const doc = toOtlpJson(events, {
      sessionId,
      agentName: args.values.agent ?? defaultAgent,
      model: args.values.model ?? defaultModel,
      ...(resourceAttributes !== undefined ? { resourceAttributes } : {}),
      ...captureStamp,
      attributes,
      spanAttributes: enriched.spanAttributes,
      ...(runTrace !== undefined ? { trace: runTrace } : {}),
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
  "run", "preflight", "doctor", "watch", "stats", "audit", "verify-run", "status", "statusline",
  "archive", "emit", "regrade", "report", "dash", "serve", "web", "mcp", "quota", "agents", "import",
  "trial", "queue", "replay", "smoke", "gc", "config", "init", "attach", "desk", "lane", "listener", "update", "profiles",
  "scrub", "export",
]);

/** #98: commands that never get the automatic update line (stdio protocols and
 *  per-prompt hot paths), besides `update` itself and --version/help. */
const NO_AUTO_UPDATE_CHECK = new Set(["update", "mcp", "statusline"]);

/**
 * `ach update --check [--json] [--offline]` (#98). Reads the release feed and
 * says whether a newer version exists. Never downloads, replaces or modifies
 * anything: the only write is the small cache file in the state dir.
 */
async function cmdUpdate(argv: string[]): Promise<number> {
  const args = parseArgs({
    args: argv,
    options: {
      check: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      offline: { type: "boolean", default: false },
    },
  });
  if (!args.values.check) {
    process.stderr.write(subcommandHelp("update") + "\n");
    return 1;
  }
  if (args.values.offline) installOfflineGuard();
  let r;
  try {
    r = await checkForUpdate(VERSION);
  } catch (e) {
    if (e instanceof OfflineViolation) throw e;
    throw new HarnessError(`update check failed: ${e instanceof Error ? e.message : String(e)}`, "UPDATE_CHECK", 1);
  }
  process.stdout.write(args.values.json ? JSON.stringify(r) + "\n" : formatUpdateResult(r) + "\n");
  return 0;
}

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

/** #41: the commands whose option tables define the config file sections. */
const CONFIG_COMMANDS = { run: cmdRun, stats: cmdStats, web: cmdWeb, serve: cmdServe, emit: cmdEmit };

async function main(argvIn: string[]): Promise<number> {
  const { argv, config } = takeConfigFlag(argvIn);
  const [cmd, ...raw] = argv;
  // #104: the space-separated `--extra-args <value>` form is joined into the
  // unambiguous `--extra-args=<value>` form before parseArgs (and before the
  // #101 help scan, so `--extra-args --help` passes --help through as the
  // flag's VALUE — the next token is always the value).
  const rest = cmd === "run" || cmd === "preflight" ? joinOptionValues(raw, ["extra-args", "extra-arg"]) : raw;
  // #101: every subcommand accepts -h/--help (usage + exit 0).
  if (cmd !== undefined && SUBCOMMANDS.has(cmd) && wantsHelp(rest)) {
    process.stdout.write(subcommandHelp(cmd) + "\n");
    return 0;
  }
  // #41: one choke point; `config` loads files itself (it may be fixing one).
  if (cmd === "config") return cmdConfig(rest, config, CONFIG_COMMANDS, { checkProfile: checkRunProfile });
  // #80: init edits the config file itself, like `config` (it may be repairing one).
  if (cmd === "init") return cmdInit(rest, config, CONFIG_COMMANDS);
  if (cmd !== undefined && SUBCOMMANDS.has(cmd)) await applyConfig(cmd, config, CONFIG_COMMANDS);
  // #98: opt-in (env, default OFF) once-per-24h update line, stderr only.
  if (cmd !== undefined && SUBCOMMANDS.has(cmd) && !NO_AUTO_UPDATE_CHECK.has(cmd) && !rest.includes("--offline")) {
    const notice = await autoUpdateNotice(VERSION);
    if (notice !== null) process.stderr.write(notice + "\n");
  }
  switch (cmd) {
    case "update":
      return cmdUpdate(rest);
    case "run":
      return cmdRun(rest);
    case "attach":
      return cmdAttach(rest);
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
    case "import":
      return cmdImport(rest);
    case "verify-run":
      return cmdVerifyRun(rest);
    case "replay":
      return cmdReplay(rest);
    case "smoke":
      return cmdSmoke(rest);
    case "status":
      return cmdStatus(rest);
    case "statusline":
      return cmdStatusline(rest);
    case "archive":
      return cmdArchive(rest);
    case "gc":
      return cmdGc(rest);
    case "emit":
      return cmdEmit(rest);
    case "regrade":
      return cmdRegrade(rest);
    case "trial":
      return cmdTrial(rest);
    case "report":
      return cmdReport(rest);
    case "scrub":
      return cmdScrub(rest);
    case "export":
      // #96: stats.json is the exact stdout of `ach stats --json`, with the
      // same config-file defaults a direct `ach stats` call would get.
      return cmdExport(rest, {
        version: VERSION,
        statsJson: async () => {
          await applyConfig("stats", config, CONFIG_COMMANDS);
          let text = "";
          await cmdStats(STATS_ARGV.slice(1), (chunk) => {
            text += chunk;
          });
          return text;
        },
      });
    case "dash":
      return cmdDash(rest);
    case "serve":
      return cmdServe(rest);
    case "web":
      return cmdWeb(rest);
    case "desk":
      return cmdDesk(rest);
    case "lane":
      return cmdLane(rest);
    case "listener":
      return cmdListener(rest);
    case "mcp":
      return cmdMcp(rest);
    case "quota":
      return cmdQuota(rest);
    case "queue":
      return cmdQueue(rest);
    case "agents":
      return cmdAgents(rest);
    case "profiles":
      return cmdProfiles(rest, config, CONFIG_COMMANDS);
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
 * - bin execution (`ach …`, `node dist/cli/ach.js …`, `bun dist/cli/ach.js …`,
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
  // Piped stdout is asynchronous: remember backpressure so the forced exit
  // below waits for queued output to drain instead of truncating it (#128).
  trackStdioBackpressure();
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
    .then((code) => flushAndExit(code));
}
