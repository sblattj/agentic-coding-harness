// Config file (#41): one JSON file feeds defaults into `run`, `stats`, `web`
// and `serve` (keys mirror each command's long flag names in camelCase) plus a
// shared `stateDir`. Precedence: flag > AGENTIC_CODING_HARNESS_* env > config
// file > built-in default. See docs/CONFIG.md.
//
// The choke point is `parseArgs` below: ach.ts, web.ts and serve.ts import it
// instead of node:util's. `main` arms it once per invocation; the armed
// command's first parseArgs call gets the file's values for every option the
// command line did not set (and whose env mirror is unset). Config keys are
// derived from the option table that call passes, so a flag added to a
// command later is configurable with no edit here. The same hook, armed in
// "capture" mode, reads the option tables for validation, `config --show` and
// the published JSON schema without running the commands.
//
// Agent profiles (#77): a top-level `profiles.<name>` object whose keys are
// the `run` section's keys (plus an `env` map for the agent process). `ach
// run --profile <name>` (or `run.profile` in the file) expands it in the same
// choke point, so precedence is flag > env > profile > file `run` > default.
import { parseArgs as nodeParseArgs } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { HarnessError, type RunProfileInfo } from "../core/types.ts";
import { EXIT_CODES } from "./exit-codes.ts";
import { DEFAULT_MASK_MODE, MASK_ENV, MaskConfigSchema, type MaskConfig } from "../core/masking.ts";

export const CONFIG_ENV = "AGENTIC_CODING_HARNESS_CONFIG";
export const STATE_DIR_ENV = "AGENTIC_CODING_HARNESS_STATE_DIR";
export const CONFIG_SECTIONS = ["run", "stats", "web", "serve"] as const;
export type ConfigSection = (typeof CONFIG_SECTIONS)[number];
/** Top-level key holding the named agent profiles (#77). */
export const PROFILES_KEY = "profiles";
/** Top-level key holding the export masking settings (#71, docs/MASKING.md). */
export const MASK_KEY = "mask";
/** The `ach run` flag that selects a profile; never a key inside one. */
export const PROFILE_FLAG = "profile";
/** The section whose flags a profile body holds. */
export const PROFILE_SECTION = "run" satisfies ConfigSection;
/** Profile names: no dots (they would break `profiles.<name>.<key>` paths). */
export const PROFILE_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;
/** Env var names a profile's `env` map may set. */
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * Repeatable flags whose value may be inline JSON that carries tokens (MCP
 * server env/headers). The RunRecord copy of such a value is a size marker,
 * the same redaction `describeSandbox` applies to `--mcp-config`.
 */
export const SECRET_JSON_FLAGS: ReadonlySet<string> = new Set(["mcp-config", "kiro-mcp-server"]);
export const CONFIG_SCHEMA_URL =
  "https://raw.githubusercontent.com/sblattj/agentic-coding-harness/main/docs/config.schema.json";

/** Where the default search looks (low to high precedence; a key in the
 *  project file overrides the same key in the user file). */
export function userConfigPath(home: string = os.homedir()): string {
  return path.join(home, ".config", "agentic-coding-harness", "config.json");
}
export function projectConfigPath(cwd: string = process.cwd()): string {
  return path.join(cwd, ".ach", "config.json");
}

/**
 * Flags whose command code already reads an AGENTIC_CODING_HARNESS_* env
 * default. Env names do not follow one rule (`--warn-at` reads
 * _WARN_THRESHOLDS, `--token` reads _HTTP_TOKEN), so this list is explicit:
 * when the env var is set, the config value for that flag is skipped so env
 * keeps beating the file. A flag with no env mirror needs no entry.
 */
export const ENV_MIRRORS: Readonly<Record<string, string>> = {
  "budget-usd": "AGENTIC_CODING_HARNESS_BUDGET_USD",
  "max-turns": "AGENTIC_CODING_HARNESS_MAX_TURNS",
  "wall-ms": "AGENTIC_CODING_HARNESS_WALL_MS",
  "idle-ms": "AGENTIC_CODING_HARNESS_IDLE_MS",
  "budget-alerts": "AGENTIC_CODING_HARNESS_BUDGET_ALERTS",
  "warn-at": "AGENTIC_CODING_HARNESS_WARN_THRESHOLDS",
  "claude-default-config": "AGENTIC_CODING_HARNESS_DEFAULT_CLAUDE_CONFIG",
  "claude-no-background-tasks": "AGENTIC_CODING_HARNESS_CLAUDE_DISABLE_BACKGROUND_TASKS",
  pr: "AGENTIC_CODING_HARNESS_PR",
  tz: "AGENTIC_CODING_HARNESS_TZ",
  plan: "AGENTIC_CODING_HARNESS_PLAN",
  "plan-window-tokens": "AGENTIC_CODING_HARNESS_PLAN_WINDOW_TOKENS",
  "plan-window-usd": "AGENTIC_CODING_HARNESS_PLAN_WINDOW_USD",
  "plan-window-messages": "AGENTIC_CODING_HARNESS_PLAN_WINDOW_MESSAGES",
  "cost-mode": "AGENTIC_CODING_HARNESS_COST_MODE",
  "project-aliases": "AGENTIC_CODING_HARNESS_PROJECT_ALIASES",
  token: "AGENTIC_CODING_HARNESS_HTTP_TOKEN",
  source: "AGENTIC_CODING_HARNESS_SOURCE",
  "source-token": "AGENTIC_CODING_HARNESS_SOURCE_TOKEN",
  "source-mode": "AGENTIC_CODING_HARNESS_SOURCE_MODE",
  "source-poll-ms": "AGENTIC_CODING_HARNESS_SOURCE_POLL_MS",
  "source-merge": "AGENTIC_CODING_HARNESS_SOURCE_MERGE",
  gateway: "AGENTIC_CODING_HARNESS_GATEWAY",
  root: "AGENTIC_CODING_HARNESS_ROOT",
  "max-jobs": "AGENTIC_CODING_HARNESS_MAX_JOBS",
  "max-output-bytes": "AGENTIC_CODING_HARNESS_MAX_OUTPUT_BYTES",
  "allow-extra-args": "AGENTIC_CODING_HARNESS_ALLOW_EXTRA_ARGS",
};

/**
 * Mirrors that only apply in one section, keyed `<section>.<flag>`. `web`'s
 * `--state-dir` / `--dir` fall back to the state-dir env var (store.ts
 * stateDir()); `stats --dir` is a transcript root with no env var, so it has
 * no entry.
 */
export const SECTION_ENV_MIRRORS: Readonly<Record<string, string>> = {
  "web.state-dir": STATE_DIR_ENV,
  "web.dir": STATE_DIR_ENV,
};

/** The env var that beats the file for `<section>` `--<flag>`, if any. */
export function envMirror(section: string, flag: string): string | undefined {
  return SECTION_ENV_MIRRORS[`${section}.${flag}`] ?? ENV_MIRRORS[flag];
}

/**
 * Path-typed flags: a relative value in a config file resolves against the
 * config file's directory (and `~` expands), not the process cwd.
 */
export const PATH_FLAGS: ReadonlySet<string> = new Set([
  "dir",
  "state-dir",
  "transcript-dir",
  "evidence-dir",
  "kiro-ide-user-data-dir",
  "root",
]);

/**
 * Flags whose value is a number. The option tables only say string/boolean,
 * so `--set` needs this list to store `5` (not `"5"`) for them; any other
 * string flag keeps its text verbatim (`007` stays `"007"`).
 */
export const NUMERIC_FLAGS: ReadonlySet<string> = new Set([
  "budget-usd",
  "max-turns",
  "wall-ms",
  "idle-ms",
  "kiro-startup-ms",
  "kiro-ide-port",
  "verify-timeout-ms",
  "repeat",
  "parallel",
  "days",
  "port",
  "plan-window-tokens",
  "plan-window-usd",
  "plan-window-messages",
  "source-poll-ms",
  "max-jobs",
  "max-output-bytes",
]);

type Env = Record<string, string | undefined>;
const isSet = (v: string | undefined): v is string => v !== undefined && v !== "";

// ---------------------------------------------------------------- option tables

export interface OptionSpec {
  type: "string" | "boolean";
  multiple?: boolean;
  short?: string;
  default?: unknown;
}
export type OptionTable = Record<string, OptionSpec>;
export type SectionTables = Record<ConfigSection, OptionTable>;
/** The command entry points whose option tables define each section. */
export type SectionCommands = Record<ConfigSection, (rest: string[]) => Promise<number>>;

/** `budget-usd` -> `budgetUsd`. */
export function flagToKey(flag: string): string {
  return flag.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

class CaptureSignal {
  constructor(readonly options: OptionTable) {}
}

interface ApplyEntry {
  flag: string;
  value: unknown;
  /** The env var that beats this entry (section-aware), if any. */
  mirror?: string | undefined;
  /** `file:<path>` or `profile:<name>`. */
  source: string;
}
const DIR_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["dir", "state-dir"],
  ["dir", "transcript-dir"],
];

type Armed =
  | { mode: "capture" }
  | { mode: "apply"; section: ConfigSection; entries: ApplyEntry[]; profiles: Map<string, MergedProfile> };
let armed: Armed | null = null;

/**
 * What the armed parse resolved (#77): the selected profile (if any) and,
 * for every option the run will use, its value and the layer it came from.
 * `ach run` reads it right after its parseArgs call (takeResolution).
 */
export interface Resolution {
  section: ConfigSection;
  profile?: { name: string; values: Record<string, unknown>; env: Record<string, string> };
  /** Effective options in the option table's order (the profile flag excluded). */
  effective: Array<{ flag: string; value: unknown; source: string }>;
  /** The effective options as argv, in command-line order. */
  argv: string[];
}
let lastResolution: Resolution | null = null;

/** The resolution of the last armed parse, once (null when nothing was armed). */
export function takeResolution(): Resolution | null {
  const r = lastResolution;
  lastResolution = null;
  return r;
}

/**
 * Drop-in for node:util `parseArgs`. Unarmed (every call but the armed
 * command's first) it is exactly node's. Armed for "apply", it parses the
 * command line, then fills each config entry the command line left unset;
 * when the caller asked for `tokens`, injected values come first as synthetic
 * option tokens so token readers (e.g. `orderedExtraArgs`) see them too.
 */
export const parseArgs = ((config?: Parameters<typeof nodeParseArgs>[0]) => {
  const a = armed;
  if (a === null) return nodeParseArgs(config);
  armed = null;
  const options = (config?.options ?? {}) as OptionTable;
  if (a.mode === "capture") throw new CaptureSignal(options);
  const res = nodeParseArgs({ ...config, tokens: true }) as {
    values: Record<string, unknown>;
    positionals: string[];
    tokens?: Array<Record<string, unknown>>;
  };
  const given = new Set((res.tokens ?? []).filter((t) => t.kind === "option").map((t) => t.name as string));
  // `--dir` is an alias of `--state-dir` / `--transcript-dir` (lib.ts
  // resolveDirFlag): the command-line spelling of either one beats the file's.
  for (const [a, b] of DIR_ALIASES) {
    // A table with both spellings (`stats`, #99) takes --dir as --transcript-dir
    // only: its --state-dir is a different directory, not an alias.
    if (b === "state-dir" && "transcript-dir" in options) continue;
    if (given.has(a)) given.add(b);
    if (given.has(b)) given.add(a);
  }
  // #77: a selected profile's keys sit between env and the file's section.
  let entries = a.entries;
  let profile: Resolution["profile"];
  if (options[PROFILE_FLAG] !== undefined) {
    const fromFile = a.entries.find((e) => e.flag === PROFILE_FLAG);
    const name = given.has(PROFILE_FLAG) ? (res.values[PROFILE_FLAG] as string) : fromFile !== undefined ? String(fromFile.value) : undefined;
    if (name !== undefined) {
      const p = pickProfile(name, a.profiles);
      const own = [...p.flags].map(([flag, fv]) => ({ flag, value: fv.value, mirror: envMirror(a.section, flag), source: `profile:${name}` }));
      entries = [...own, ...a.entries.filter((e) => !p.flags.has(e.flag))];
      profile = {
        name,
        values: Object.fromEntries([...p.flags].map(([flag, fv]) => [flag, fv.value])),
        env: Object.fromEntries([...p.env].map(([k, fv]) => [k, String(fv.value)])),
      };
    }
  }
  const sources = new Map<string, string>();
  const injected: Array<Record<string, unknown>> = [];
  for (const e of entries) {
    const spec = options[e.flag];
    if (spec === undefined || given.has(e.flag)) continue;
    if (e.mirror !== undefined && isSet(process.env[e.mirror])) continue;
    const v = toOptionValue(spec, e.value);
    if (spec.type === "boolean" && v !== true) continue; // false = unset (there is no --no-<flag>)
    res.values[e.flag] = v;
    sources.set(e.flag, e.source);
    if (spec.type === "boolean") {
      injected.push({ kind: "option", name: e.flag, rawName: `--${e.flag}`, index: -1, value: undefined, inlineValue: undefined });
    } else {
      for (const one of Array.isArray(v) ? v : [v]) {
        injected.push({ kind: "option", name: e.flag, rawName: `--${e.flag}`, index: -1, value: one, inlineValue: true });
      }
    }
  }
  lastResolution = resolution(a.section, options, res, given, sources, [...injected, ...(res.tokens ?? [])], profile);
  if (config?.tokens) res.tokens = [...injected, ...(res.tokens ?? [])];
  else delete res.tokens;
  return res;
}) as typeof nodeParseArgs;

/** Every option the parse settled on, with its layer, and the same set as argv. */
function resolution(
  section: ConfigSection,
  options: OptionTable,
  res: { values: Record<string, unknown> },
  given: Set<string>,
  sources: Map<string, string>,
  tokens: Array<Record<string, unknown>>,
  profile: Resolution["profile"],
): Resolution {
  const effective: Resolution["effective"] = [];
  const fromEnv: string[] = [];
  for (const [flag, spec] of Object.entries(options)) {
    if (flag === PROFILE_FLAG) continue;
    if (given.has(flag) && res.values[flag] !== undefined) {
      effective.push({ flag, value: res.values[flag], source: "flag" });
      continue;
    }
    const src = sources.get(flag);
    if (src !== undefined) {
      effective.push({ flag, value: res.values[flag], source: src });
      continue;
    }
    // An env mirror the command reads itself (optNumWithEnv, ...): part of
    // the option set the run used, though parseArgs never saw it.
    const mirror = envMirror(section, flag);
    const raw = mirror !== undefined ? process.env[mirror] : undefined;
    if (mirror === undefined || !isSet(raw)) continue;
    if (spec.type === "boolean") {
      if (raw !== "1" && raw !== "true") continue;
      effective.push({ flag, value: true, source: `env:${mirror}` });
      fromEnv.push(`--${flag}`);
    } else {
      effective.push({ flag, value: raw, source: `env:${mirror}` });
      fromEnv.push(`--${flag}=${raw}`);
    }
  }
  const argv: string[] = [];
  for (const t of tokens) {
    if (t.kind !== "option" || t.name === PROFILE_FLAG || (t.name as string) === undefined) continue;
    const name = t.name as string;
    if (options[name] === undefined) continue;
    argv.push(t.value === undefined ? `--${name}` : `--${name}=${String(t.value)}`);
  }
  return { section, ...(profile !== undefined ? { profile } : {}), effective, argv: [...argv, ...fromEnv] };
}

/** The RunRecord form of a profiled run's resolution (#77): env values and
 *  inline MCP JSON never leave the process. */
export function profileRecord(r: Resolution): RunProfileInfo | undefined {
  if (r.profile === undefined) return undefined;
  const redacted = new Set<string>();
  const mask = (flag: string, v: unknown): unknown => {
    if (!SECRET_JSON_FLAGS.has(flag)) return v;
    const one = (x: unknown) => {
      if (typeof x !== "string" || !x.trim().startsWith("{")) return x;
      redacted.add(flag);
      return `<inline JSON, ${x.length} bytes>`;
    };
    return Array.isArray(v) ? v.map(one) : one(v);
  };
  const expanded: Record<string, unknown> = {};
  const sources: Record<string, string> = {};
  const overridden: Record<string, unknown> = {};
  for (const e of r.effective) {
    expanded[e.flag] = mask(e.flag, e.value);
    sources[e.flag] = e.source;
    if (Object.hasOwn(r.profile.values, e.flag) && e.source !== `profile:${r.profile.name}`) {
      overridden[e.flag] = mask(e.flag, r.profile.values[e.flag]);
    }
  }
  const argv = r.argv.map((a) => {
    const eq = a.indexOf("=");
    if (eq === -1) return a;
    const flag = a.slice(2, eq);
    const masked = mask(flag, a.slice(eq + 1));
    return `--${flag}=${String(masked)}`;
  });
  const envKeys = Object.keys(r.profile.env);
  return {
    name: r.profile.name,
    expanded,
    sources,
    argv,
    ...(Object.keys(overridden).length > 0 ? { overridden } : {}),
    ...(envKeys.length > 0 ? { envKeys } : {}),
    ...(redacted.size > 0 ? { redacted: [...redacted] } : {}),
  };
}

/** A config value (already type-checked) in the shape parseArgs would return. */
function toOptionValue(spec: OptionSpec, v: unknown): unknown {
  const one = (x: unknown) => (spec.type === "boolean" ? x : String(x));
  if (spec.multiple) return (Array.isArray(v) ? v : [v]).map(one);
  return one(v);
}

/** Read each section's option table by arming capture and calling the
 *  command with no args: its first parseArgs call hands the table over. */
export async function captureTables(commands: SectionCommands): Promise<SectionTables> {
  const out: Partial<SectionTables> = {};
  for (const section of CONFIG_SECTIONS) {
    armed = { mode: "capture" };
    try {
      await commands[section]([]);
    } catch (e) {
      if (e instanceof CaptureSignal) {
        out[section] = e.options;
        continue;
      }
      throw e;
    } finally {
      armed = null;
    }
    throw new HarnessError(`internal: '${section}' did not parse its flags; cannot read its config keys`, "CONFIG");
  }
  return out as SectionTables;
}

// ---------------------------------------------------------------- files

export interface LoadedFile {
  path: string;
  kind: "explicit" | "user" | "project";
  data: Record<string, unknown>;
}

function configError(message: string): HarnessError {
  return new HarnessError(message, "CONFIG", EXIT_CODES.error);
}

/** The files to read, low to high precedence. An explicit path (`--config`
 *  or AGENTIC_CODING_HARNESS_CONFIG) replaces the default search. */
export function configCandidates(opts: { explicit?: string; env?: Env; cwd?: string; home?: string } = {}): Array<{ path: string; kind: LoadedFile["kind"] }> {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const explicit = opts.explicit ?? (isSet(env[CONFIG_ENV]) ? env[CONFIG_ENV] : undefined);
  if (explicit !== undefined) return [{ path: path.resolve(cwd, expandHome(explicit, opts.home)), kind: "explicit" }];
  return [
    { path: userConfigPath(opts.home), kind: "user" },
    { path: projectConfigPath(cwd), kind: "project" },
  ];
}

function expandHome(p: string, home: string = os.homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

/** Parse one file; null when it is absent and not required. */
export function readConfigFile(file: string, kind: LoadedFile["kind"], allowMissing = kind !== "explicit"): LoadedFile | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" && allowMissing) return null;
    throw configError(`config ${file}: cannot read: ${e instanceof Error ? e.message : String(e)}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw configError(`config ${file}: not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw configError(`config ${file}: must be a JSON object`);
  }
  return { path: file, kind, data: data as Record<string, unknown> };
}

export function loadConfigFiles(
  opts: { explicit?: string; env?: Env; cwd?: string; home?: string; allowMissing?: boolean } = {},
): LoadedFile[] {
  return configCandidates(opts)
    .map((c) => readConfigFile(c.path, c.kind, opts.allowMissing ?? c.kind !== "explicit"))
    .filter((f): f is LoadedFile => f !== null);
}

// ---------------------------------------------------------------- validation

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length]![b.length]!;
}

function suggest(key: string, candidates: string[]): string {
  const camel = flagToKey(key);
  if (camel !== key && candidates.includes(camel)) return ` (did you mean '${camel}'? keys are camelCase)`;
  let best: string | undefined;
  let bestD = Infinity;
  for (const c of candidates) {
    const dist = editDistance(key.toLowerCase(), c.toLowerCase());
    if (dist < bestD) {
      bestD = dist;
      best = c;
    }
  }
  return best !== undefined && bestD <= Math.max(2, Math.floor(key.length / 4)) ? ` (did you mean '${best}'?)` : "";
}

/** camelCase key -> long flag name, for one section's option table. */
export function sectionKeys(table: OptionTable): Map<string, string> {
  return new Map(Object.keys(table).map((flag) => [flagToKey(flag), flag]));
}

function typeName(v: unknown): string {
  return v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
}

/** Type-check one value against its option; undefined when it fits, else
 *  what the option expects. */
function valueProblem(spec: OptionSpec, v: unknown): string | undefined {
  const scalarOk = (x: unknown) =>
    spec.type === "boolean" ? typeof x === "boolean" : typeof x === "string" || (typeof x === "number" && Number.isFinite(x));
  const scalar = spec.type === "boolean" ? "a boolean" : "a string or number";
  if (spec.multiple) {
    if (scalarOk(v) || (Array.isArray(v) && v.every(scalarOk))) return undefined;
    return `${scalar}, or an array of them`;
  }
  return scalarOk(v) ? undefined : scalar;
}

/** Reject unknown sections, unknown keys and type mismatches, naming the
 *  file, the section and the key. Throws the first problem. */
export function validateConfig(file: LoadedFile, tables: SectionTables): void {
  const [first] = configProblems(file, tables);
  if (first !== undefined) throw configError(first);
}

/** Every problem in one file, as messages (empty = valid). */
export function configProblems(file: LoadedFile, tables: SectionTables): string[] {
  const problems: string[] = [];
  const topKeys = ["$schema", "stateDir", ...CONFIG_SECTIONS, PROFILES_KEY, MASK_KEY];
  for (const [section, body] of Object.entries(file.data)) {
    if (section === MASK_KEY) {
      problems.push(...maskProblems(file.path, body));
      continue;
    }
    if (section === PROFILES_KEY) {
      problems.push(...profileProblems(file.path, body, tables));
      continue;
    }
    if (section === "$schema" || section === "stateDir") {
      if (typeof body !== "string" || body === "") {
        problems.push(`config ${file.path}: '${section}' expects a non-empty string, got ${typeName(body)}`);
      }
      continue;
    }
    if (!(CONFIG_SECTIONS as readonly string[]).includes(section)) {
      problems.push(
        `config ${file.path}: unknown section '${section}'${suggest(section, topKeys)} (expected one of: ${topKeys.join(", ")})`,
      );
      continue;
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      problems.push(`config ${file.path}: section '${section}' must be an object, got ${typeName(body)}`);
      continue;
    }
    const table = tables[section as ConfigSection];
    const keys = sectionKeys(table);
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      const flag = keys.get(key);
      if (flag === undefined) {
        problems.push(
          `config ${file.path}: section '${section}' has unknown key '${key}' (${section}.${key})${suggest(key, [...keys.keys()])}; ` +
            `keys mirror \`ach ${section}\` long flags in camelCase`,
        );
        continue;
      }
      const problem = valueProblem(table[flag]!, value);
      if (problem !== undefined) {
        problems.push(
          `config ${file.path}: section '${section}' key '${key}' (${section}.${key}, flag --${flag}) expects ${problem}, got ${typeName(value)}`,
        );
      }
    }
  }
  return problems;
}

/** Problems in the top-level `mask` object of one file (#71). */
function maskProblems(file: string, body: unknown): string[] {
  if (!isObject(body)) return [`config ${file}: '${MASK_KEY}' must be an object, got ${typeName(body)}`];
  const r = MaskConfigSchema.safeParse(body);
  if (r.success) return [];
  const keys = Object.keys(MaskConfigSchema.shape);
  return r.error.issues.map((i) => {
    if (i.code === "unrecognized_keys") {
      return i.keys.map((k) => `config ${file}: '${MASK_KEY}' has unknown key '${k}' (${MASK_KEY}.${k})${suggest(k, keys)} (expected one of: ${keys.join(", ")})`).join("; ");
    }
    const at = [MASK_KEY, ...i.path.map(String)].join(".");
    return `config ${file}: '${at}' ${i.message}`;
  });
}

/** camelCase key -> long flag for a profile body: the `run` section's keys,
 *  minus `profile` itself (a profile cannot select another profile). */
export function profileKeys(tables: Pick<SectionTables, "run">): Map<string, string> {
  const keys = sectionKeys(tables[PROFILE_SECTION]);
  keys.delete(flagToKey(PROFILE_FLAG));
  return keys;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Problems in the top-level `profiles` object of one file. */
function profileProblems(file: string, body: unknown, tables: SectionTables): string[] {
  const problems: string[] = [];
  if (!isObject(body)) return [`config ${file}: '${PROFILES_KEY}' must be an object of named profiles, got ${typeName(body)}`];
  const keys = profileKeys(tables);
  for (const [name, prof] of Object.entries(body)) {
    const at = `${PROFILES_KEY}.${name}`;
    if (!PROFILE_NAME_RE.test(name)) {
      problems.push(`config ${file}: profile name '${name}' is invalid (letters, digits, '_' and '-'; no dots)`);
      continue;
    }
    if (!isObject(prof)) {
      problems.push(`config ${file}: profile '${name}' (${at}) must be an object, got ${typeName(prof)}`);
      continue;
    }
    for (const [key, value] of Object.entries(prof)) {
      if (key === "env") {
        if (!isObject(value)) {
          problems.push(`config ${file}: profile '${name}' key 'env' (${at}.env) expects an object of env var names to strings, got ${typeName(value)}`);
          continue;
        }
        for (const [k, v] of Object.entries(value)) {
          if (!ENV_NAME_RE.test(k)) problems.push(`config ${file}: profile '${name}' env key '${k}' (${at}.env.${k}) is not a valid env var name`);
          else if (typeof v !== "string") problems.push(`config ${file}: profile '${name}' env '${k}' (${at}.env.${k}) expects a string, got ${typeName(v)}`);
        }
        continue;
      }
      const flag = keys.get(key);
      if (flag === undefined) {
        const why = key === flagToKey(PROFILE_FLAG) ? " (a profile cannot select another profile)" : suggest(key, [...keys.keys(), "env"]);
        problems.push(
          `config ${file}: profile '${name}' has unknown key '${key}' (${at}.${key})${why}; ` +
            `keys mirror \`ach run\` long flags in camelCase, plus 'env'`,
        );
        continue;
      }
      const problem = valueProblem(tables[PROFILE_SECTION][flag]!, value);
      if (problem !== undefined) {
        problems.push(`config ${file}: profile '${name}' key '${key}' (${at}.${key}, flag --${flag}) expects ${problem}, got ${typeName(value)}`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------- resolution

export interface FileValue {
  value: unknown;
  file: string;
}

/** Merge files (later wins per key). Keys are `stateDir` and `<section>.<flag>`. */
export function mergeFiles(files: LoadedFile[], tables: SectionTables): Map<string, FileValue> {
  const out = new Map<string, FileValue>();
  for (const f of files) {
    for (const [section, body] of Object.entries(f.data)) {
      if (section === "$schema") continue;
      if (section === "stateDir") {
        if (typeof body === "string" && body !== "") out.set("stateDir", { value: resolveStateDir(body, f.path), file: f.path });
        continue;
      }
      // #71: `mask.<key>` entries, later file wins per key; invalid ones are validation's.
      if (section === MASK_KEY) {
        if (isObject(body) && MaskConfigSchema.safeParse(body).success) for (const [k, v] of Object.entries(body)) out.set(`${MASK_KEY}.${k}`, { value: v, file: f.path });
        continue;
      }
      // Invalid entries (unknown section/key, wrong shape) are reported by
      // validation; they never reach the merged values.
      if (!(CONFIG_SECTIONS as readonly string[]).includes(section)) continue;
      if (body === null || typeof body !== "object" || Array.isArray(body)) continue;
      const keys = sectionKeys(tables[section as ConfigSection]);
      for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
        const flag = keys.get(key);
        if (flag === undefined) continue;
        out.set(`${section}.${flag}`, { value: PATH_FLAGS.has(flag) ? resolvePathValue(value, f.path) : value, file: f.path });
      }
    }
  }
  return out;
}

/** One profile merged across the files: per key, the later file wins (the
 *  same rule as the sections), so a project file can tweak a user profile. */
export interface MergedProfile {
  flags: Map<string, FileValue>;
  env: Map<string, FileValue>;
  files: string[];
}

export function mergeProfiles(files: LoadedFile[], tables: SectionTables): Map<string, MergedProfile> {
  const out = new Map<string, MergedProfile>();
  const keys = profileKeys(tables);
  for (const f of files) {
    const body = f.data[PROFILES_KEY];
    if (!isObject(body)) continue;
    for (const [name, prof] of Object.entries(body)) {
      if (!PROFILE_NAME_RE.test(name) || !isObject(prof)) continue;
      const m: MergedProfile = out.get(name) ?? { flags: new Map(), env: new Map(), files: [] };
      if (!m.files.includes(f.path)) m.files.push(f.path);
      for (const [key, value] of Object.entries(prof)) {
        if (key === "env") {
          if (isObject(value)) for (const [k, v] of Object.entries(value)) if (typeof v === "string") m.env.set(k, { value: v, file: f.path });
          continue;
        }
        const flag = keys.get(key);
        if (flag === undefined) continue;
        m.flags.set(flag, { value: PATH_FLAGS.has(flag) ? resolvePathValue(value, f.path) : value, file: f.path });
      }
      out.set(name, m);
    }
  }
  return out;
}

/** The named profile, or a USAGE error listing the ones that exist. */
export function pickProfile(name: string, profiles: Map<string, MergedProfile>): MergedProfile {
  if (name === "") throw new HarnessError("--profile requires a profile name", "USAGE");
  const p = profiles.get(name);
  if (p !== undefined) return p;
  const names = [...profiles.keys()].sort();
  throw new HarnessError(
    names.length > 0
      ? `unknown profile '${name}'${suggest(name, names)} (available: ${names.join(", ")})`
      : `unknown profile '${name}' (no profiles are defined; add one with \`ach config --set profiles.${PROFILE_NAME_RE.test(name) ? name : "<name>"}.agent <agent>\`, see docs/CONFIG.md)`,
    "USAGE",
  );
}

/**
 * A profile's flags as `ach run` argv (`--flag=value`, `--flag` for on/off),
 * in the run option table's order. `--flag=value` keeps a value that starts
 * with `-` a value. This is what `ach profiles list` prints, and what the
 * save-time adapter check parses.
 */
export function profileArgv(flags: Map<string, FileValue> | Map<string, unknown>, table: OptionTable): string[] {
  const argv: string[] = [];
  for (const [flag, spec] of Object.entries(table)) {
    if (!flags.has(flag)) continue;
    const raw = flags.get(flag);
    const value = raw !== null && typeof raw === "object" && !Array.isArray(raw) && "file" in raw ? (raw as FileValue).value : raw;
    const v = toOptionValue(spec, value);
    if (spec.type === "boolean") {
      if (v === true) argv.push(`--${flag}`);
      continue;
    }
    for (const one of Array.isArray(v) ? v : [v]) argv.push(`--${flag}=${String(one)}`);
  }
  return argv;
}

/** Path-typed values (string or array of strings) resolve like `stateDir`;
 *  anything else is left for validation to report. */
function resolvePathValue(v: unknown, file: string): unknown {
  if (typeof v === "string" && v !== "") return resolveStateDir(v, file);
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" && x !== "" ? resolveStateDir(x, file) : x));
  return v;
}

/** `~` expands to HOME; a relative path is relative to the config file's dir. */
function resolveStateDir(raw: string, file: string): string {
  return path.resolve(path.dirname(file), expandHome(raw));
}

/**
 * The one entry point `main` calls before dispatch: load the config files
 * (none = nothing to do), validate every section, export `stateDir` as the
 * state-dir env var when that var is unset, and arm `parseArgs` for `cmd`
 * when it is a config section.
 */
export async function applyConfig(cmd: string, explicit: string | undefined, commands: SectionCommands): Promise<void> {
  armed = null;
  lastResolution = null;
  loadedMask = undefined;
  const files = loadConfigFiles({ explicit });
  // `run` is armed even with no file, so `--profile <name>` there is an
  // "unknown profile" error rather than silently ignored.
  if (files.length === 0) {
    if (cmd === PROFILE_SECTION) armed = { mode: "apply", section: PROFILE_SECTION, entries: [], profiles: new Map() };
    return;
  }
  const tables = await captureTables(commands);
  for (const f of files) validateConfig(f, tables);
  const merged = mergeFiles(files, tables);
  loadedMask = maskConfigFrom(merged);
  const sd = merged.get("stateDir");
  if (sd !== undefined && !isSet(process.env[STATE_DIR_ENV])) process.env[STATE_DIR_ENV] = sd.value as string;
  if (!(CONFIG_SECTIONS as readonly string[]).includes(cmd)) return;
  const section = cmd as ConfigSection;
  const prefix = `${cmd}.`;
  const entries = [...merged]
    .filter(([k]) => k.startsWith(prefix))
    .map(([k, v]) => {
      const flag = k.slice(prefix.length);
      return { flag, value: v.value, mirror: envMirror(cmd, flag), source: `file:${v.file}` };
    });
  const profiles = section === PROFILE_SECTION ? mergeProfiles(files, tables) : new Map<string, MergedProfile>();
  if (entries.length > 0 || section === PROFILE_SECTION) armed = { mode: "apply", section, entries, profiles };
}

let loadedMask: MaskConfig | undefined;

/** The merged `mask` object `applyConfig` loaded for this invocation (#71); undefined when no file sets one. */
export function loadedMaskConfig(): MaskConfig | undefined {
  return loadedMask;
}

/** The `mask.<key>` entries of merged config values, as one object. */
export function maskConfigFrom(merged: Map<string, FileValue>): MaskConfig | undefined {
  const out: Record<string, unknown> = {};
  for (const [k, v] of merged) if (k.startsWith(`${MASK_KEY}.`)) out[k.slice(MASK_KEY.length + 1)] = v.value;
  return Object.keys(out).length > 0 ? (out as MaskConfig) : undefined;
}

/** Peel a leading global `--config <path>` / `--config=<path>` off argv. */
export function takeConfigFlag(argv: string[]): { argv: string[]; config: string | undefined } {
  let config: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    if (a === "--config") {
      const v = argv[i + 1];
      if (v === undefined || v === "") throw new HarnessError("--config requires a path", "USAGE");
      config = v;
      i += 2;
    } else if (a.startsWith("--config=")) {
      config = a.slice("--config=".length);
      if (config === "") throw new HarnessError("--config requires a path", "USAGE");
      i += 1;
    } else break;
  }
  return { argv: argv.slice(i), config };
}

// ---------------------------------------------------------------- show

export interface ResolvedRow {
  key: string;
  flag?: string;
  value: unknown;
  source: string;
}

/** Every key with its winning value and source: flag, env:<NAME>,
 *  file:<path> or default. */
export function resolveRows(opts: {
  tables: SectionTables;
  merged: Map<string, FileValue>;
  env?: Env;
  sections?: readonly ConfigSection[];
  flags?: { section: ConfigSection; values: Record<string, unknown> };
  /** #77: the selected profile, a layer between env and the file's `run`. */
  profile?: { name: string; profile: MergedProfile };
}): ResolvedRow[] {
  const env = opts.env ?? process.env;
  const rows: ResolvedRow[] = [];
  const sd = opts.merged.get("stateDir");
  if (isSet(env[STATE_DIR_ENV])) rows.push({ key: "stateDir", value: env[STATE_DIR_ENV], source: `env:${STATE_DIR_ENV}` });
  else if (sd !== undefined) rows.push({ key: "stateDir", value: sd.value, source: `file:${sd.file}` });
  else rows.push({ key: "stateDir", value: path.join(os.homedir(), ".agentic-coding-harness"), source: "default" });
  for (const section of opts.sections ?? CONFIG_SECTIONS) {
    for (const [flag, spec] of Object.entries(opts.tables[section])) {
      const key = `${section}.${flagToKey(flag)}`;
      const flagVals = opts.flags?.section === section ? opts.flags.values : undefined;
      const mirror = envMirror(section, flag);
      const fileVal = opts.merged.get(`${section}.${flag}`);
      const profVal = section === PROFILE_SECTION ? opts.profile?.profile.flags.get(flag) : undefined;
      if (flagVals !== undefined && flagVals[flag] !== undefined) rows.push({ key, flag, value: flagVals[flag], source: "flag" });
      else if (mirror !== undefined && isSet(env[mirror])) rows.push({ key, flag, value: env[mirror], source: `env:${mirror}` });
      else if (profVal !== undefined) rows.push({ key, flag, value: profVal.value, source: `profile:${opts.profile!.name}` });
      else if (fileVal !== undefined) rows.push({ key, flag, value: fileVal.value, source: `file:${fileVal.file}` });
      else rows.push({ key, flag, value: spec.default ?? null, source: "default" });
    }
  }
  // #71: the export mask settings (mask.mode always; other mask keys when a file sets them).
  if (opts.sections === undefined) {
    const envMode = env[MASK_ENV];
    const fileMode = opts.merged.get(`${MASK_KEY}.mode`);
    if (isSet(envMode)) rows.push({ key: `${MASK_KEY}.mode`, value: envMode, source: `env:${MASK_ENV}` });
    else if (fileMode !== undefined) rows.push({ key: `${MASK_KEY}.mode`, value: fileMode.value, source: `file:${fileMode.file}` });
    else rows.push({ key: `${MASK_KEY}.mode`, value: DEFAULT_MASK_MODE, source: "default" });
    for (const [k, v] of opts.merged) {
      if (k.startsWith(`${MASK_KEY}.`) && k !== `${MASK_KEY}.mode`) rows.push({ key: k, value: v.value, source: `file:${v.file}` });
    }
  }
  return rows;
}

function fmtValue(v: unknown): string {
  return v === null || v === undefined ? "(unset)" : typeof v === "string" ? v : JSON.stringify(v);
}

function renderResolved(files: LoadedFile[], candidates: Array<{ path: string; kind: string }>, rows: ResolvedRow[], json: boolean): string {
  if (json) {
    return JSON.stringify(
      {
        files: candidates.map((c) => ({ path: c.path, kind: c.kind, loaded: files.some((f) => f.path === c.path) })),
        values: Object.fromEntries(rows.map((r) => [r.key, { value: r.value ?? null, source: r.source, ...(r.flag ? { flag: `--${r.flag}` } : {}) }])),
      },
      null,
      2,
    );
  }
  const out = candidates.map((c) => `config file (${c.kind}): ${c.path}${files.some((f) => f.path === c.path) ? "" : " (not found)"}`);
  const w = Math.max(...rows.map((r) => r.key.length));
  for (const r of rows) out.push(`${r.key.padEnd(w)}  ${fmtValue(r.value)}  [${r.source}]`);
  return out.join("\n");
}

// ---------------------------------------------------------------- schema

/** The config file's zod schema, derived from the captured option tables. */
export function configZodSchema(tables: SectionTables) {
  const scalarFor = (spec: OptionSpec) => (spec.type === "boolean" ? z.boolean() : z.union([z.string(), z.number()]));
  const sections: Record<string, z.ZodType> = {};
  let profilesSchema: z.ZodType | undefined;
  for (const section of CONFIG_SECTIONS) {
    const shape: Record<string, z.ZodType> = {};
    for (const [flag, spec] of Object.entries(tables[section])) {
      const scalar = scalarFor(spec);
      const t = spec.multiple ? z.union([scalar, z.array(scalar)]) : scalar;
      const mirror = envMirror(section, flag);
      shape[flagToKey(flag)] = t.optional().describe(`ach ${section} --${flag}${mirror ? ` (env ${mirror} wins over this)` : ""}`);
    }
    sections[section] = z.strictObject(shape).optional().describe(`defaults for \`ach ${section}\` flags`);
    if (section === PROFILE_SECTION) {
      const profShape: Record<string, z.ZodType> = {};
      for (const [flag, spec] of Object.entries(tables[section])) {
        if (flag === PROFILE_FLAG) continue;
        const scalar = scalarFor(spec);
        profShape[flagToKey(flag)] = (spec.multiple ? z.union([scalar, z.array(scalar)]) : scalar).optional().describe(`ach run --${flag}`);
      }
      profShape.env = z
        .record(z.string().regex(ENV_NAME_RE), z.string())
        .optional()
        .describe("env vars set on the agent process only (plaintext file: no secrets; the RunRecord keeps the names, never the values)");
      profilesSchema = z
        .record(z.string().regex(PROFILE_NAME_RE), z.strictObject(profShape))
        .optional()
        .describe("named agent profiles: `ach run --profile <name>` expands one; keys are `run` keys plus `env`");
    }
  }
  return z.strictObject({
    $schema: z.string().optional(),
    stateDir: z
      .string()
      .min(1)
      .optional()
      .describe(`state root for every command (env ${STATE_DIR_ENV} wins); relative to this file, ~ expands`),
    ...sections,
    ...(profilesSchema !== undefined ? { [PROFILES_KEY]: profilesSchema } : {}),
    [MASK_KEY]: MaskConfigSchema.optional(),
  });
}

/** The published form (docs/config.schema.json). */
export function configJsonSchema(tables: SectionTables): Record<string, unknown> {
  return {
    ...(z.toJSONSchema(configZodSchema(tables), { io: "input" }) as Record<string, unknown>),
    $id: CONFIG_SCHEMA_URL,
    title: "agentic-coding-harness config (.ach/config.json)",
  };
}

// ---------------------------------------------------------------- `ach config`

/** Coerce a `--set` CLI string to the JSON value stored in the file, by the
 *  target flag's type: booleans take true/false, NUMERIC_FLAGS parse as
 *  numbers (non-numbers rejected), every other string flag is kept verbatim. */
function coerceSetValue(spec: OptionSpec | undefined, flag: string | undefined, raw: string, label: string): unknown {
  if (spec === undefined || flag === undefined) {
    if (raw === "") throw new HarnessError(`config --set ${label}: expects a non-empty string`, "USAGE");
    return raw; // stateDir
  }
  if (spec.type === "boolean") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw new HarnessError(`config --set ${label}: expects true or false, got '${raw}'`, "USAGE");
  }
  if (spec.multiple && raw.trim().startsWith("[")) {
    try {
      return JSON.parse(raw) as unknown;
    } catch (e) {
      throw new HarnessError(`config --set ${label}: not a valid JSON array: ${e instanceof Error ? e.message : String(e)}`, "USAGE");
    }
  }
  if (NUMERIC_FLAGS.has(flag)) {
    const n = raw.trim() === "" ? NaN : Number(raw);
    if (!Number.isFinite(n)) throw new HarnessError(`config --set ${label}: expects a number, got '${raw}'`, "USAGE");
    return n;
  }
  return raw;
}

/** `<section>.<key>` or `stateDir` -> its section and option spec. */
function lookupKey(
  dotted: string,
  tables: SectionTables,
): { section?: ConfigSection; key: string; flag?: string; spec?: OptionSpec } {
  if (dotted === "stateDir") return { key: "stateDir" };
  const dot = dotted.indexOf(".");
  const section = dot === -1 ? dotted : dotted.slice(0, dot);
  const key = dot === -1 ? "" : dotted.slice(dot + 1);
  if (!(CONFIG_SECTIONS as readonly string[]).includes(section)) {
    throw new HarnessError(
      `config: unknown section '${section}' in '${dotted}' (expected stateDir or <${CONFIG_SECTIONS.join("|")}>.<key>)`,
      "CONFIG",
    );
  }
  const keys = sectionKeys(tables[section as ConfigSection]);
  const flag = keys.get(key);
  if (flag === undefined) {
    throw new HarnessError(`config: section '${section}' has unknown key '${key}' (${dotted})${suggest(key, [...keys.keys()])}`, "CONFIG");
  }
  return { section: section as ConfigSection, key, flag, spec: tables[section as ConfigSection][flag] };
}

/** True when `dotted` names a key the tables know (so lookupKey succeeds). */
function unsetKnownKey(dotted: string, tables: SectionTables): boolean {
  try {
    lookupKey(dotted, tables);
    return true;
  } catch {
    return false;
  }
}

/** Delete `dotted` (`<top>`, `<section>.<key>`, `profiles.<name>.env.<K>`,
 *  ...) from `doc` when it is there, dropping objects it leaves empty; false
 *  when the file does not hold that path. */
function deleteExistingPath(doc: Record<string, unknown>, dotted: string): boolean {
  const [head, ...tail] = dotted.split(".");
  if (!Object.hasOwn(doc, head!)) return false;
  if (tail.length === 0) {
    delete doc[head!];
    return true;
  }
  const body = doc[head!];
  if (!isObject(body)) return false;
  const copy = { ...body };
  if (!deleteExistingPath(copy, tail.join("."))) return false;
  if (Object.keys(copy).length === 0) delete doc[head!];
  else doc[head!] = copy;
  return true;
}

/** A `profiles.<name>[.<key>|.env[.<NAME>]]` path, checked against the run table. */
interface ProfilePath {
  name: string;
  /** camelCase key and its flag (a flag key). */
  key?: string;
  flag?: string;
  spec?: OptionSpec;
  /** `env` map (envKey undefined) or one env var. */
  env?: boolean;
  envKey?: string;
}

function parseProfilePath(dotted: string, tables: SectionTables): ProfilePath {
  const seg = dotted.split(".");
  const bad = (why: string) =>
    new HarnessError(`config: '${dotted}': ${why} (expected ${PROFILES_KEY}.<name>.<key> or ${PROFILES_KEY}.<name>.env.<NAME>)`, "CONFIG");
  const name = seg[1];
  if (name === undefined || name === "") throw bad("missing the profile name");
  if (!PROFILE_NAME_RE.test(name)) throw bad(`profile name '${name}' is invalid (letters, digits, '_' and '-'; no dots)`);
  if (seg.length === 2) return { name };
  if (seg[2] === "env") {
    if (seg.length === 3) return { name, env: true };
    if (seg.length > 4 || !ENV_NAME_RE.test(seg[3]!)) throw bad(`'${seg.slice(3).join(".")}' is not a valid env var name`);
    return { name, env: true, envKey: seg[3]! };
  }
  if (seg.length > 3) throw bad("too many parts");
  const key = seg[2]!;
  const keys = profileKeys(tables);
  const flag = keys.get(key);
  if (flag === undefined) {
    const why = key === flagToKey(PROFILE_FLAG) ? " (a profile cannot select another profile)" : suggest(key, [...keys.keys(), "env"]);
    throw new HarnessError(`config: profile '${name}' has unknown key '${key}' (${dotted})${why}; keys mirror \`ach run\` long flags in camelCase, plus 'env'`, "CONFIG");
  }
  return { name, key, flag, spec: tables[PROFILE_SECTION][flag] };
}

/** Apply one `--set` / `--unset` of a profiles path to `doc`. */
function editProfile(doc: Record<string, unknown>, dotted: string, raw: string | undefined, tables: SectionTables): string {
  const pp = parseProfilePath(dotted, tables);
  if (raw === undefined) {
    deleteExistingPath(doc, dotted);
    return pp.name;
  }
  if (pp.key === undefined && pp.envKey === undefined) {
    throw new HarnessError(
      `config --set ${dotted}: set one key at a time (${PROFILES_KEY}.${pp.name}.<key> <value> or ${PROFILES_KEY}.${pp.name}.env.<NAME> <value>)`,
      "USAGE",
    );
  }
  const all = isObject(doc[PROFILES_KEY]) ? { ...(doc[PROFILES_KEY] as Record<string, unknown>) } : {};
  const prof = isObject(all[pp.name]) ? { ...(all[pp.name] as Record<string, unknown>) } : {};
  if (pp.envKey !== undefined) {
    const env = isObject(prof.env) ? { ...prof.env } : {};
    env[pp.envKey] = raw;
    prof.env = env;
  } else {
    const value = coerceSetValue(pp.spec, pp.flag, raw, dotted);
    const problem = valueProblem(pp.spec!, value);
    if (problem !== undefined) throw new HarnessError(`config --set ${dotted}: expects ${problem}, got ${typeName(value)}`, "USAGE");
    prof[pp.key!] = value;
  }
  all[pp.name] = prof;
  doc[PROFILES_KEY] = all;
  return pp.name;
}

/** Apply one `--set` / `--unset` of `mask.<key>` (#71) to `doc`. */
function editMask(doc: Record<string, unknown>, dotted: string, raw: string | undefined): void {
  const key = dotted.slice(MASK_KEY.length + 1);
  const keys = Object.keys(MaskConfigSchema.shape);
  if (raw === undefined && (dotted === MASK_KEY || deleteExistingPath(doc, dotted))) {
    if (dotted === MASK_KEY) delete doc[MASK_KEY];
    return;
  }
  if (key === "" || key.includes(".") || !keys.includes(key)) {
    throw new HarnessError(`config: '${MASK_KEY}' has unknown key '${key}' (${dotted})${suggest(key, keys)} (expected one of: ${keys.join(", ")})`, "CONFIG");
  }
  if (raw === undefined) return;
  let value: unknown = raw;
  if (key === "entropy") {
    if (raw !== "true" && raw !== "false") throw new HarnessError(`config --set ${dotted}: expects true or false, got '${raw}'`, "USAGE");
    value = raw === "true";
  } else if (key === "patterns") {
    if (raw.trim().startsWith("[")) {
      try {
        value = JSON.parse(raw) as unknown;
      } catch (e) {
        throw new HarnessError(`config --set ${dotted}: not a valid JSON array: ${e instanceof Error ? e.message : String(e)}`, "USAGE");
      }
    } else value = [raw];
  }
  const body = { ...(isObject(doc[MASK_KEY]) ? (doc[MASK_KEY] as Record<string, unknown>) : {}), [key]: value };
  const r = MaskConfigSchema.safeParse(body);
  const issue = r.success ? undefined : r.error.issues.find((i) => i.path[0] === key);
  if (issue !== undefined) throw new HarnessError(`config --set ${dotted}: ${issue.message}`, "USAGE");
  doc[MASK_KEY] = body;
}

/** Hooks `ach config` / `ach profiles` get from ach.ts (which config.ts cannot import). */
export interface ConfigHooks {
  /**
   * Save-time adapter check (#77): build the RunSpec `ach run <argv>` would
   * build and run the agent's validateProfile on it, throwing the same
   * error the driver throws at run time.
   */
  checkProfile?: (argv: string[], table: OptionTable) => Promise<void>;
}

/**
 * Set (`raw` given) or unset (`raw` undefined) one key in `doc`, in place:
 * the shared write step of `ach config --set/--unset` and `ach init`. Only the
 * touched key/value is validated; the key is stateDir or <section>.<key>.
 */
export function setConfigKey(doc: Record<string, unknown>, dotted: string, raw: string | undefined, tables: SectionTables): void {
  if (raw === undefined && !unsetKnownKey(dotted, tables)) {
    // --unset accepts any key path the target file actually holds, known or
    // not (so a misspelled key can be removed); else the lookup error stands.
    if (!deleteExistingPath(doc, dotted)) lookupKey(dotted, tables);
  } else {
    const { section, key, flag, spec } = lookupKey(dotted, tables);
    if (section === undefined) {
      if (raw === undefined) delete doc.stateDir;
      else doc.stateDir = coerceSetValue(undefined, undefined, raw, dotted);
    } else {
      const body = { ...((doc[section] as Record<string, unknown> | undefined) ?? {}) };
      if (raw === undefined) delete body[key];
      else {
        // Only the new key/value is validated here; other problems in the
        // file are reported as warnings below, never a reason to refuse.
        const value = coerceSetValue(spec, flag, raw, dotted);
        const problem = valueProblem(spec!, value);
        if (problem !== undefined) throw new HarnessError(`config --set ${dotted}: expects ${problem}, got ${typeName(value)}`, "USAGE");
        body[key] = value;
      }
      if (Object.keys(body).length === 0) delete doc[section];
      else doc[section] = body;
    }
  }
}

export const CONFIG_USAGE = `  ach config --show [<section>] [--json] [-- <section flags>]
                (every resolved key with its value and source: flag, env:<NAME>,
                 file:<path> or default; flags after -- are parsed as that
                 section's command line, to preview what wins; docs/CONFIG.md)
  ach config --set <key> <value> [--dry-run] [--json]
  ach config --unset <key> [--dry-run] [--json]
                (key is stateDir or <run|stats|web|serve>.<camelCaseFlag>, e.g.
                 run.budgetUsd; writes ./.ach/config.json, or the --config file;
                 --dry-run prints the resolved config after the change, writes nothing)
                (also mask.<mode|style|entropy|patterns|atif|otel|langfuse|sft|report|scrub>:
                 export secret masking, docs/MASKING.md)
                (also profiles.<name>.<key> and profiles.<name>.env.<NAME>: agent
                 profiles for \`ach run --profile <name>\`; a profile the agent's
                 validation rejects is not saved. <key>=<value> works too)
  ach config --schema
                (prints the JSON schema published as docs/config.schema.json)`;

export async function cmdConfig(rest: string[], explicit: string | undefined, commands: SectionCommands, hooks: ConfigHooks = {}): Promise<number> {
  const dd = rest.indexOf("--");
  const own = dd === -1 ? rest : rest.slice(0, dd);
  const passFlags = dd === -1 ? undefined : rest.slice(dd + 1);
  const args = nodeParseArgs({
    args: own,
    options: {
      show: { type: "boolean", default: false },
      set: { type: "string" },
      unset: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      schema: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const v = args.values;
  const modes = [v.show, v.set !== undefined, v.unset !== undefined, v.schema].filter(Boolean).length;
  if (modes !== 1) throw new HarnessError("config requires exactly one of --show, --set <key> <value>, --unset <key>, --schema", "USAGE");
  const tables = await captureTables(commands);
  if (v.schema) {
    process.stdout.write(JSON.stringify(configJsonSchema(tables), null, 2) + "\n");
    return 0;
  }
  const candidates = configCandidates({ explicit });
  // --set/--unset may create the explicit file; --show requires it.
  const files = loadConfigFiles({ explicit, allowMissing: v.show ? undefined : true });

  if (v.show) {
    for (const f of files) validateConfig(f, tables);
    if (args.positionals.length > 1) throw new HarnessError("config --show takes at most one <section>", "USAGE");
    const section = args.positionals[0] as ConfigSection | undefined;
    if (section !== undefined && !(CONFIG_SECTIONS as readonly string[]).includes(section)) {
      throw new HarnessError(`config --show: unknown section '${section}' (expected one of: ${CONFIG_SECTIONS.join(", ")})`, "USAGE");
    }
    if (passFlags !== undefined && section === undefined) throw new HarnessError("config --show -- <flags> needs a <section> before --", "USAGE");
    let flags: { section: ConfigSection; values: Record<string, unknown> } | undefined;
    if (section !== undefined && passFlags !== undefined) {
      const parsed = nodeParseArgs({ args: passFlags, options: tables[section] as never, allowPositionals: true, tokens: true });
      const given = new Set(parsed.tokens.filter((t) => t.kind === "option").map((t) => t.name));
      flags = {
        section,
        values: Object.fromEntries(Object.entries(parsed.values).filter(([k]) => given.has(k))),
      };
    }
    const merged = mergeFiles(files, tables);
    // #77: `-- --profile <name>` (or the file's run.profile) adds the profile layer.
    const fileProfile = merged.get(`${PROFILE_SECTION}.${PROFILE_FLAG}`);
    const profName =
      flags?.section === PROFILE_SECTION && typeof flags.values[PROFILE_FLAG] === "string"
        ? (flags.values[PROFILE_FLAG] as string)
        : fileProfile !== undefined && (section === undefined || section === PROFILE_SECTION)
          ? String(fileProfile.value)
          : undefined;
    const profile = profName !== undefined ? { name: profName, profile: pickProfile(profName, mergeProfiles(files, tables)) } : undefined;
    const rows = resolveRows({ tables, merged, sections: section ? [section] : undefined, flags, ...(profile ? { profile } : {}) });
    process.stdout.write(renderResolved(files, candidates, rows, v.json) + "\n");
    return 0;
  }

  // --set / --unset
  if (passFlags !== undefined) throw new HarnessError("config --set/--unset take no -- <flags>", "USAGE");
  let dotted = (v.set ?? v.unset)!;
  const target = explicit !== undefined || isSet(process.env[CONFIG_ENV]) ? candidates[0]!.path : projectConfigPath();
  let raw: string | undefined;
  if (v.set !== undefined) {
    const eq = dotted.indexOf("=");
    if (eq > 0 && args.positionals.length === 0) {
      // `--set <key>=<value>`: no key contains '='.
      raw = dotted.slice(eq + 1);
      dotted = dotted.slice(0, eq);
    } else {
      if (args.positionals.length !== 1) throw new HarnessError(`config --set ${dotted} needs exactly one <value>`, "USAGE");
      raw = args.positionals[0]!;
    }
  } else if (args.positionals.length !== 0) {
    throw new HarnessError(`config --unset ${dotted} takes no value`, "USAGE");
  }
  const existing = files.find((f) => f.path === target) ?? readConfigFile(target, "project", true);
  const doc: Record<string, unknown> = existing ? structuredClone(existing.data) : { $schema: CONFIG_SCHEMA_URL };
  let editedProfile: string | undefined;
  if (dotted === MASK_KEY || dotted.startsWith(`${MASK_KEY}.`)) {
    editMask(doc, dotted, raw);
  } else if (dotted === PROFILES_KEY || dotted.startsWith(`${PROFILES_KEY}.`)) {
    if (dotted === PROFILES_KEY) {
      if (raw !== undefined) throw new HarnessError(`config --set ${dotted}: set one key at a time (${PROFILES_KEY}.<name>.<key> <value>)`, "USAGE");
      delete doc[PROFILES_KEY];
    } else if (raw === undefined && deleteExistingPath(doc, dotted)) {
      // --unset of a path the file holds, known key or not (like sections).
      editedProfile = dotted.split(".")[1];
    } else {
      editedProfile = editProfile(doc, dotted, raw, tables);
    }
  } else {
    setConfigKey(doc, dotted, raw, tables);
  }
  const kind = candidates.find((c) => c.path === target)?.kind ?? "project";
  const updated: LoadedFile = { path: target, kind, data: doc };
  const after = files.some((f) => f.path === target) ? files.map((f) => (f.path === target ? updated : f)) : [...files, updated];
  for (const f of after) for (const msg of configProblems(f, tables)) process.stderr.write(`config: warning: ${msg}\n`);
  // #77: the edited profile, merged across the files as `ach run --profile`
  // would see it, must pass the agent's own validation before it is saved.
  if (editedProfile !== undefined && hooks.checkProfile !== undefined) {
    const prof = mergeProfiles(after, tables).get(editedProfile);
    if (prof !== undefined && prof.flags.has("agent")) {
      try {
        await hooks.checkProfile(profileArgv(prof.flags, tables[PROFILE_SECTION]), tables[PROFILE_SECTION]);
      } catch (e) {
        if (!(e instanceof HarnessError)) throw e;
        throw new HarnessError(`config ${v.set !== undefined ? "--set" : "--unset"} ${dotted}: profile '${editedProfile}' not saved: ${e.message}`, e.code, EXIT_CODES.error);
      }
    }
  }
  if (v["dry-run"]) {
    process.stderr.write(`config: dry run, ${target} not written\n`);
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(doc, null, 2) + "\n");
    process.stderr.write(`config: wrote ${target}\n`);
  }
  const shownCandidates = candidates.some((c) => c.path === target) ? candidates : [...candidates, { path: target, kind }];
  const rows = resolveRows({ tables, merged: mergeFiles(after, tables) });
  process.stdout.write(renderResolved(after, shownCandidates, rows, v.json) + "\n");
  return 0;
}

// ---------------------------------------------------------------- `ach profiles`

export const PROFILES_USAGE = `  ach profiles list [--json]
                (every agent profile in the config files with its flag expansion: what
                 \`ach run --profile <name>\` adds to the command line; env values are
                 not printed, only their names. Define one with
                 \`ach config --set profiles.<name>.<key> <value>\`; docs/CONFIG.md)`;

/** Quote one argv word for display (POSIX shell). */
function shellWord(w: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, "'\\''")}'`;
}

export async function cmdProfiles(rest: string[], explicit: string | undefined, commands: SectionCommands): Promise<number> {
  const args = nodeParseArgs({ args: rest, options: { json: { type: "boolean", default: false } }, allowPositionals: true });
  const [sub = "list", ...extra] = args.positionals;
  if (sub !== "list" || extra.length > 0) throw new HarnessError(`profiles: unknown subcommand '${[sub, ...extra].join(" ")}' (expected: list)`, "USAGE");
  const tables = await captureTables(commands);
  const files = loadConfigFiles({ explicit });
  for (const f of files) validateConfig(f, tables);
  const profiles = [...mergeProfiles(files, tables)].sort(([a], [b]) => a.localeCompare(b));
  const rows = profiles.map(([name, p]) => ({
    name,
    flags: Object.fromEntries([...p.flags].map(([flag, fv]) => [flagToKey(flag), fv.value])),
    argv: profileArgv(p.flags, tables[PROFILE_SECTION]),
    envKeys: [...p.env.keys()],
    files: p.files,
  }));
  if (args.values.json) {
    process.stdout.write(JSON.stringify({ profiles: rows }, null, 2) + "\n");
    return 0;
  }
  if (rows.length === 0) {
    process.stdout.write("no profiles defined (add one: ach config --set profiles.<name>.agent <agent>; see docs/CONFIG.md)\n");
    return 0;
  }
  const w = Math.max(...rows.map((r) => r.name.length));
  const out: string[] = [];
  for (const r of rows) {
    out.push(`${r.name.padEnd(w)}  ach run ${r.argv.map(shellWord).join(" ")}`.trimEnd());
    if (r.envKeys.length > 0) out.push(`${" ".repeat(w)}  env (agent process only): ${r.envKeys.join(", ")}`);
  }
  process.stdout.write(out.join("\n") + "\n");
  return 0;
}
