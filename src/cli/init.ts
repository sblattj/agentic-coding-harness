// `ach init` (#80): first-run setup. Detects which agent CLIs are on PATH,
// picks defaults (agent, model, budget, max turns), runs the doctor checks for
// the chosen agent and writes the choices into the config file (#41) through
// the same key machinery as `ach config --set`, so a re-run overwrites values
// in place (no duplicate keys, no stale sections). The core is non-interactive
// (flags + --yes); a thin node:readline wizard sits on top when stdin AND
// stdout are terminals and --yes is absent. See docs/CONFIG.md.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { AGENTS, HarnessError, isKnownAgent, type AgentName } from "../core/types.ts";
import { stateDir as defaultStateDir } from "../core/store.ts";
import { EXIT_CODES } from "./exit-codes.ts";
import {
  CONFIG_ENV,
  CONFIG_SCHEMA_URL,
  captureTables,
  configCandidates,
  configProblems,
  parseArgs,
  projectConfigPath,
  readConfigFile,
  setConfigKey,
  userConfigPath,
  type LoadedFile,
  type SectionCommands,
} from "./config.ts";
import { AGENT_BINARY, INSTALL_HINT, formatDoctorTable, resolveOnPath, runDoctor, type DoctorReport } from "./doctor.ts";

export const INIT_USAGE = `  ach init [--agent A] [--model M] [--budget-usd N] [--max-turns N] [--yes] [--dry-run] [--show] [--project]
                (first-run setup: detects the agent CLIs on PATH, runs the doctor checks for the
                 chosen agent and writes run.agent / run.model / run.budgetUsd / run.maxTurns into
                 the config file. Target: the user config file; --project writes ./.ach/config.json;
                 --config <file> / AGENTIC_CODING_HARNESS_CONFIG wins over both. Interactive prompts
                 only when stdin and stdout are terminals and --yes is absent; otherwise --yes (or
                 --agent) proceeds without asking. A missing agent binary refuses to write.
                 --dry-run prints the config JSON and writes nothing; --show prints the current
                 config and exits 0; re-running overwrites the same keys; docs/CONFIG.md)`;

/** Agents whose CLI binary is probed on PATH, in the order they are offered. */
const DETECTABLE = ["claude", "codex", "gemini", "agy", "opencode", "copilot", "cursor", "prime", "kiro"] as const;
/** Env vars that point doctor at a non-default binary (same lookups as runDoctor / checkKiro). */
const BIN_ENV: Readonly<Record<string, string>> = { copilot: "COPILOT_CLI_BIN", cursor: "CURSOR_AGENT_BIN", kiro: "KIRO_CLI_BIN" };

export interface InitIo {
  stdin: Readable & { isTTY?: boolean };
  stdout: Writable & { isTTY?: boolean };
}

/** Which of the known agent CLIs resolve on `pathVar`: name -> absolute path or undefined. */
export function detectAgents(pathVar: string | undefined, env: NodeJS.ProcessEnv = process.env): Array<{ agent: string; bin: string; found: string | undefined }> {
  return DETECTABLE.map((agent) => {
    const override = BIN_ENV[agent] !== undefined ? env[BIN_ENV[agent]!] : undefined;
    const bin = override !== undefined && override !== "" ? override : agent === "kiro" ? "kiro-cli" : (AGENT_BINARY[agent] ?? agent);
    return { agent, bin, found: resolveOnPath(bin, pathVar) };
  });
}

interface Choices {
  agent?: string;
  model?: string;
  budgetUsd?: string;
  maxTurns?: string;
}

function readRun(file: LoadedFile | null): Choices {
  const run = file?.data.run;
  if (run === null || typeof run !== "object" || Array.isArray(run)) return {};
  const r = run as Record<string, unknown>;
  const s = (v: unknown): string | undefined => (typeof v === "string" || typeof v === "number" ? String(v) : undefined);
  const out: Choices = {};
  const agent = s(r.agent);
  const model = s(r.model);
  const budget = s(r.budgetUsd);
  const turns = s(r.maxTurns);
  if (agent !== undefined) out.agent = agent;
  if (model !== undefined) out.model = model;
  if (budget !== undefined) out.budgetUsd = budget;
  if (turns !== undefined) out.maxTurns = turns;
  return out;
}

function checkNumber(flag: string, raw: string, integer: boolean): void {
  const n = raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) {
    throw new HarnessError(`init: ${flag} expects a positive ${integer ? "integer" : "number"}, got '${raw}'`, "USAGE");
  }
}

function checkAgent(agent: string): asserts agent is AgentName {
  if (!isKnownAgent(agent)) {
    throw new HarnessError(`init: unknown agent '${agent}' (expected one of: ${AGENTS.join(", ")})`, "UNKNOWN_AGENT");
  }
}

/** One prompt: blank keeps the shown default; "none" clears it (a blank answer with no default is "none" too). */
async function ask(rl: readline.Interface, question: string, def: string | undefined, clearable = true): Promise<string> {
  const suffix = def !== undefined && def !== "" ? (clearable ? ` [${def}, 'none' clears]` : ` [${def}]`) : "";
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  if (answer.toLowerCase() === "none") return "";
  return answer === "" ? (def ?? "") : answer;
}

/** The wizard: shows what was detected, asks the four choices, confirms. */
async function wizard(
  io: InitIo,
  detected: ReturnType<typeof detectAgents>,
  current: Choices,
): Promise<Choices | undefined> {
  const out = io.stdout;
  const rl = readline.createInterface({ input: io.stdin, output: io.stdout, terminal: false });
  try {
    out.write("ach init: first-run setup\n\nAgent CLIs on PATH:\n");
    for (const d of detected) out.write(`  ${d.found !== undefined ? "found  " : "missing"}  ${d.agent.padEnd(9)}${d.found ?? INSTALL_HINT[d.agent as keyof typeof INSTALL_HINT]}\n`);
    out.write("\n");
    const firstFound = detected.find((d) => d.found !== undefined)?.agent;
    const agent = await ask(rl, "Default agent", current.agent ?? firstFound, false);
    if (agent === "") throw new HarnessError("init: no default agent chosen (none found on PATH)", "USAGE");
    checkAgent(agent);
    const model = await ask(rl, "Default model (blank = none)", current.model);
    const budgetUsd = await ask(rl, "Budget cap in USD per run (blank = none)", current.budgetUsd);
    const maxTurns = await ask(rl, "Max turns per run (blank = none)", current.maxTurns);
    const answer = (await rl.question("Write this config? [Y/n]: ")).trim().toLowerCase();
    if (answer !== "" && answer !== "y" && answer !== "yes") return undefined;
    return { agent, model, budgetUsd, maxTurns };
  } finally {
    rl.close();
  }
}

function quickstart(agent: string, target: string): string {
  return [
    "",
    "Quickstart:",
    `  ach run --agent ${agent} "summarize this repo in three bullets"   # --agent/--model/--budget-usd/--max-turns now default from ${target}`,
    "  ach dash                                                         # spend and usage overview",
    "  ach web                                                          # dashboard in the browser",
    "",
  ].join("\n");
}

/** Doctor rows that make the chosen agent unlaunchable (binary missing or not runnable). Other failures
 *  (auth, model, MCP) are shown but do not block: a login can be added after init. */
const BLOCKING_CHECKS = new Set(["binary", "version", "cdp"]);
function doctorFailures(report: DoctorReport, agent: string): DoctorReport["checks"] {
  return report.checks.filter((c) => c.status === "failed" && c.agent === agent && BLOCKING_CHECKS.has(c.name));
}

/** `ach init`; see INIT_USAGE. Exit 0 on success, 1 when the doctor step refuses the config. */
export async function cmdInit(
  rest: string[],
  explicit: string | undefined,
  commands: SectionCommands,
  io: InitIo = { stdin: process.stdin, stdout: process.stdout },
): Promise<number> {
  const args = parseArgs({
    args: rest,
    options: {
      agent: { type: "string" },
      model: { type: "string" },
      "budget-usd": { type: "string" },
      "max-turns": { type: "string" },
      yes: { type: "boolean", short: "y", default: false },
      "dry-run": { type: "boolean", default: false },
      show: { type: "boolean", default: false },
      project: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  const v = args.values;
  const out = (s: string) => io.stdout.write(s);
  const err = (s: string) => process.stderr.write(s);

  const candidates = configCandidates({ explicit });
  const pinned = explicit !== undefined || (process.env[CONFIG_ENV] ?? "") !== "";
  if (pinned && v.project) throw new HarnessError("init: --project conflicts with --config / AGENTIC_CODING_HARNESS_CONFIG (the pinned file is the target)", "USAGE");
  const target = pinned ? candidates[0]!.path : v.project ? projectConfigPath() : userConfigPath();
  const kind: LoadedFile["kind"] = pinned ? "explicit" : v.project ? "project" : "user";

  if (v.show) {
    for (const c of candidates) {
      const f = readConfigFile(c.path, c.kind, true);
      out(f === null ? `# ${c.kind}: ${c.path} (not found)\n` : `# ${c.kind}: ${c.path}\n${JSON.stringify(f.data, null, 2)}\n`);
    }
    return EXIT_CODES.ok;
  }

  const existing = readConfigFile(target, kind, true);
  const current = readRun(existing);
  const detected = detectAgents(process.env.PATH, process.env);
  const interactive = io.stdin.isTTY === true && io.stdout.isTTY === true && !v.yes;

  let choices: Choices = {
    ...current,
    ...(v.agent !== undefined ? { agent: v.agent } : {}),
    ...(v.model !== undefined ? { model: v.model } : {}),
    ...(v["budget-usd"] !== undefined ? { budgetUsd: v["budget-usd"] } : {}),
    ...(v["max-turns"] !== undefined ? { maxTurns: v["max-turns"] } : {}),
  };
  if (interactive) {
    const answered = await wizard(io, detected, choices);
    if (answered === undefined) {
      err("init: cancelled, nothing written\n");
      return EXIT_CODES.error;
    }
    choices = answered;
  } else {
    if (choices.agent === undefined) {
      const first = detected.find((d) => d.found !== undefined);
      if (first === undefined) {
        throw new HarnessError(`init: no agent CLI found on PATH; install one (${INSTALL_HINT.claude}) or pass --agent`, "USAGE");
      }
      choices.agent = first.agent;
    }
    if (!v.yes && v.agent === undefined && !v["dry-run"]) {
      err(
        `init: not a terminal, so no prompts. Would write run.agent=${choices.agent}` +
          `${choices.model ? ` run.model=${choices.model}` : ""}${choices.budgetUsd ? ` run.budgetUsd=${choices.budgetUsd}` : ""}` +
          `${choices.maxTurns ? ` run.maxTurns=${choices.maxTurns}` : ""} to ${target}.\n` +
          "init: pass --yes (or --agent <name>) to write it, or --dry-run to print the config.\n",
      );
      return EXIT_CODES.error;
    }
  }

  const agent = choices.agent!;
  checkAgent(agent);
  if (choices.budgetUsd) checkNumber("--budget-usd", choices.budgetUsd, false);
  if (choices.maxTurns) checkNumber("--max-turns", choices.maxTurns, true);

  const tables = await captureTables(commands);
  const doc: Record<string, unknown> = existing ? structuredClone(existing.data) : { $schema: CONFIG_SCHEMA_URL };
  setConfigKey(doc, "run.agent", agent, tables);
  const optional: Array<[string, string | undefined]> = [
    ["run.model", choices.model],
    ["run.budgetUsd", choices.budgetUsd],
    ["run.maxTurns", choices.maxTurns],
  ];
  for (const [key, raw] of optional) setConfigKey(doc, key, raw === undefined || raw === "" ? undefined : raw, tables);
  for (const msg of configProblems({ path: target, kind, data: doc }, tables)) err(`config: warning: ${msg}\n`);

  // Inline doctor step: the chosen agent must actually work, else no config is written.
  const report = await runDoctor({
    agents: [agent],
    env: process.env,
    cwd: process.cwd(),
    stateDir: defaultStateDir(),
    ...(choices.model ? { model: choices.model } : {}),
  });
  const failed = doctorFailures(report, agent);
  err("Doctor:\n" + formatDoctorTable(report) + "\n");
  if (failed.length === 0 && !report.ok) err(`init: warning: doctor reports failures above (not blocking: the ${agent} binary runs); fix them before \`ach run\`\n`);
  if (failed.length > 0) {
    const hints = [...new Set(failed.map((c) => c.hint).filter((h): h is string => h !== undefined))];
    err(
      `init: agent '${agent}' failed ${failed.map((c) => c.name).join(", ")}; ` +
        (v["dry-run"] ? "this config cannot work (dry run, nothing written)\n" : "refusing to write a config that cannot work\n") +
        (hints.length > 0 ? `hint: ${hints.join("; ")}\n` : "\n"),
    );
  }

  const json = JSON.stringify(doc, null, 2) + "\n";
  if (v["dry-run"]) {
    err(`init: dry run, ${target} not written\n`);
    out(json);
    return failed.length > 0 ? EXIT_CODES.error : EXIT_CODES.ok;
  }
  if (failed.length > 0) return EXIT_CODES.error;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, json);
  err(`init: wrote ${target}\n`);
  out(quickstart(agent, target));
  return 0;
}
