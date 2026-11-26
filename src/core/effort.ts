// Cross-CLI effort normalization (#54).
//
// ONE table maps a portable reasoning-effort level (`ach run --effort`,
// `ach trial --effort`, the `effort` param of harness_run) onto each agent's
// native mechanism. Every adapter that consumes effort goes through it:
//
//   - argv agents (claude, codex, agy, copilot, opencode): the driver
//     prepends the fragment to the run's extraArgs (driver.ts applyEffort);
//   - kiro: the driver sets kiro.effort, the same field `--kiro-effort` fills,
//     so both kiro lanes (headless `kiro-cli chat`, `kiro-cli acp`) emit
//     exactly the argv they always have (v3 ACP sets it over the handshake);
//   - cursor: effort rides the model slug (`<model>[effort=<level>]`, per
//     `cursor-agent --help`), applied by the cursor adapter to its `--model`
//     argv only, via effortModelArg() below;
//   - everything else (gemini, prime, kiro-ide, null, custom, agents.d
//     descriptors): no native control. The run still completes, records
//     `applied: false, mechanism: "none"`, and carries a warning naming the
//     agent.
//
// Native mechanisms were read from the installed CLIs' `--help` (see
// docs/EFFORT.md for the table and the help line each row relies on).
//
// `applied` means the harness passed the level to the CLI natively. Whether
// the model actually ran at that level is what `usage.model.observedEffort` /
// `effortMismatch` report where the agent records it (codex rollout, #140).
import { requestedCodexEffort } from "./codex-native.ts";
import { EFFORT_LEVELS, HarnessError, type EffortLevel, type EffortProvenance, type KiroConfig } from "./types.ts";

export { EFFORT_LEVELS, type EffortLevel, type EffortProvenance };

export function isEffortLevel(v: unknown): v is EffortLevel {
  return typeof v === "string" && (EFFORT_LEVELS as readonly string[]).includes(v);
}

/** How one agent applies a level. */
type EffortRule =
  | { kind: "argv"; flag: string; build: (level: EffortLevel) => string[]; mechanism: (level: EffortLevel) => string; levels: readonly EffortLevel[] }
  | { kind: "kiro" }
  | { kind: "model-suffix"; levels: readonly EffortLevel[] };

const ALL: readonly EffortLevel[] = EFFORT_LEVELS;

/**
 * THE mapping table. Agents absent here have no native effort control
 * (mechanism `none`). `levels` = what the CLI accepts; a level outside it maps
 * to the nearest supported one (no clamp fires today: claude, codex, agy, copilot and kiro list all five; opencode and cursor pass the level verbatim, so acceptance depends on the model or provider).
 */
export const EFFORT_TABLE: Readonly<Record<string, EffortRule>> = {
  // claude 2.1.x: `--effort <level>  Effort level for the current session (low, medium, high, xhigh, max)`
  claude: { kind: "argv", flag: "--effort", build: (l) => ["--effort", l], mechanism: () => "--effort", levels: ALL },
  // codex exec: `-c, --config <key=value>`; model_reasoning_effort levels per `codex debug models`: low..max (+ultra)
  codex: {
    kind: "argv",
    flag: "model_reasoning_effort",
    build: (l) => ["-c", `model_reasoning_effort=${l}`],
    mechanism: (l) => `-c model_reasoning_effort=${l}`,
    levels: ALL,
  },
  // agy 1.5.x: `--effort  Reasoning effort for the current CLI session (low|medium|high|xhigh|max)`
  agy: { kind: "argv", flag: "--effort", build: (l) => ["--effort", l], mechanism: () => "--effort", levels: ALL },
  // copilot 1.0.x: `--reasoning-effort <level>  [possible values: none, minimal, low, medium, high, xhigh, max]`
  copilot: { kind: "argv", flag: "--reasoning-effort", build: (l) => ["--reasoning-effort", l], mechanism: () => "--reasoning-effort", levels: ALL },
  // opencode run: `--variant  model variant (provider-specific reasoning effort, e.g., high, max, minimal)`; passed through verbatim
  opencode: { kind: "argv", flag: "--variant", build: (l) => ["--variant", l], mechanism: () => "--variant", levels: ALL },
  // kiro-cli chat / acp: `--effort <EFFORT>  Initial effort level (e.g. low, medium, high, xhigh, max)`
  kiro: { kind: "kiro" },
  // cursor-agent: `--model <model> ... Parameterized models accept quoted bracket overrides, e.g. 'claude-opus-4-8[context=1m,effort=high,fast=false]'`
  cursor: { kind: "model-suffix", levels: ALL },
};

/** Nearest supported level (by position in EFFORT_LEVELS; ties go to the higher level). */
export function nearestEffort(level: EffortLevel, supported: readonly EffortLevel[]): EffortLevel {
  if (supported.includes(level)) return level;
  const at = EFFORT_LEVELS.indexOf(level);
  let best: EffortLevel = supported[0] ?? level;
  let bestDist = Infinity;
  for (const s of supported) {
    const d = Math.abs(EFFORT_LEVELS.indexOf(s) - at);
    if (d < bestDist || (d === bestDist && EFFORT_LEVELS.indexOf(s) > EFFORT_LEVELS.indexOf(best))) {
      best = s;
      bestDist = d;
    }
  }
  return best;
}

/** True when `args` already set the rule's native flag (an explicit extraArg wins; --effort is then not applied). */
function extraArgsSetFlag(agent: string, flag: string, args: readonly string[]): boolean {
  if (agent === "codex") return requestedCodexEffort(args) !== undefined;
  return args.some((a) => a === flag || a.startsWith(`${flag}=`));
}

/** The spec fields resolveEffort reads. */
export interface EffortSpecView {
  model?: string;
  extraArgs?: string[];
  kiro?: KiroConfig;
  preferServer?: unknown;
}

export interface EffortResolution {
  provenance: EffortProvenance;
  /** argv fragment the driver prepends to extraArgs. */
  extraArgs?: string[];
  /** kiro.effort the driver sets. */
  kiroEffort?: EffortLevel;
  /** Run warnings (unmapped agent, clamped level, overridden by an explicit flag). */
  warnings: string[];
}

/**
 * Resolve `level` for `agent` through EFFORT_TABLE. Pure. Throws USAGE when a
 * kiro spec carries a different kiro.effort (`--kiro-effort`) than `--effort`.
 */
export function resolveEffort(agent: string, level: EffortLevel, spec: EffortSpecView = {}): EffortResolution {
  const rule = EFFORT_TABLE[agent];
  const none = (why: string): EffortResolution => ({
    provenance: { requested: level, applied: false, mechanism: "none" },
    warnings: [`effort: ${agent} ${why}; --effort ${level} was not applied (recorded applied:false, mechanism none)`],
  });
  if (rule === undefined) return none("has no native effort control");
  if (rule.kind === "kiro") {
    const existing = spec.kiro?.effort;
    if (existing !== undefined && existing !== level) {
      throw new HarnessError(`--effort ${level} conflicts with kiro.effort (--kiro-effort) ${existing}; pass one`, "USAGE");
    }
    const v3Acp = spec.kiro?.transport === "acp" && spec.kiro.engine === "v3";
    return {
      provenance: { requested: level, applied: true, mechanism: v3Acp ? "acp:effortLevel" : "--effort" },
      kiroEffort: level,
      warnings: [],
    };
  }
  const sent = nearestEffort(level, rule.levels);
  const clampWarn = sent !== level ? [`effort: ${agent} does not accept '${level}'; sent the nearest supported level '${sent}'`] : [];
  const withLevel = (p: Omit<EffortProvenance, "requested">): EffortProvenance => ({
    requested: level,
    ...p,
    ...(sent !== level ? { level: sent } : {}),
  });
  if (rule.kind === "model-suffix") {
    if (spec.model === undefined || spec.model === "") return none("encodes effort in the model slug and the run has no --model");
    if (/[[,]effort=/.test(spec.model)) return none(`model '${spec.model}' already sets effort in its slug`);
    return { provenance: withLevel({ applied: true, mechanism: "model-suffix" }), warnings: clampWarn };
  }
  if (agent === "opencode" && spec.preferServer === true) return none("serve path (preferServer) takes no extra argv");
  if (extraArgsSetFlag(agent, rule.flag, spec.extraArgs ?? [])) {
    return none(`extraArgs already set ${rule.flag}, which wins`);
  }
  return {
    provenance: withLevel({ applied: true, mechanism: rule.mechanism(sent) }),
    extraArgs: rule.build(sent),
    warnings: clampWarn,
  };
}

/**
 * The `--model` argv value for a model-suffix agent (cursor): `<model>[effort=<level>]`,
 * or `<model>` with `effort=<level>` added inside an existing bracket. Returns
 * `model` unchanged when there is no effort or the slug already names one
 * (resolveEffort recorded that as applied:false). Only the argv changes: the
 * spec's model (pricing, usage.model.requested) stays what the caller asked.
 */
export function effortModelArg(agent: string, model: string | undefined, effort: unknown): string | undefined {
  if (model === undefined || model === "" || !isEffortLevel(effort)) return model;
  const rule = EFFORT_TABLE[agent];
  if (rule?.kind !== "model-suffix") return model;
  if (/[[,]effort=/.test(model)) return model;
  const sent = nearestEffort(effort, rule.levels);
  if (model.endsWith("]") && model.includes("[")) {
    const inner = model.slice(model.lastIndexOf("[") + 1, -1);
    return `${model.slice(0, -1)}${inner === "" ? "" : ","}effort=${sent}]`;
  }
  return `${model}[effort=${sent}]`;
}

/**
 * The spec the adapter launches with: the resolution's argv fragment ahead of
 * the caller's extraArgs (so an explicit native flag would come later), and
 * kiro.effort for kiro. Returns `spec` itself when nothing changes.
 */
export function applyEffortToSpec<T extends EffortSpecView>(spec: T, res: EffortResolution): T {
  if (res.extraArgs === undefined && res.kiroEffort === undefined) return spec;
  return {
    ...spec,
    ...(res.extraArgs !== undefined ? { extraArgs: [...res.extraArgs, ...(spec.extraArgs ?? [])] } : {}),
    ...(res.kiroEffort !== undefined ? { kiro: { ...(spec.kiro ?? {}), effort: res.kiroEffort } } : {}),
  };
}
