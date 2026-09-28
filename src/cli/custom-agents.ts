// CLI glue for custom agents (#37 `--agent custom --template ...`) and agents.d
// descriptors (#38). Kept out of ach.ts so the dispatch file only gains a few
// wiring lines.
import { selectCost, type CostMode } from "./cost-mode.ts";
import { parseArgs } from "node:util";
import { AGENTS, HarnessError, isKnownAgent, type AgentAdapter } from "../core/types.ts";
import { CUSTOM_AGENT, createCustomAdapter } from "../adapters/custom.ts";
import {
  builtinAgentNames,
  descriptorDirs,
  descriptorToCustomConfig,
  formatDescriptorIssue,
  loadAgentDescriptors,
  readDescriptorTap,
  type DescriptorLoad,
  type LoadedDescriptor,
  type TapUsageRow,
} from "../core/agent-descriptors.ts";
import { withPricingHints } from "../core/pricing-hints.ts";
import type { Pricer } from "../core/pricing.ts";
import { listRunRecords } from "../core/registry.ts";
import { stateDir } from "../core/store.ts";

/** Descriptors visible from the current cwd + state dir. */
export function loadCatalog(): DescriptorLoad {
  return loadAgentDescriptors({ dirs: descriptorDirs({ cwd: process.cwd(), stateDir: stateDir() }) });
}

/** Print descriptor warnings/errors once, as `[warn]` lines (never fatal). */
export function reportCatalogIssues(load: DescriptorLoad, write: (s: string) => void = (s) => process.stderr.write(s)): void {
  for (const w of load.warnings) write(`[warn] ${w}\n`);
  for (const e of load.errors) write(`[warn] ${formatDescriptorIssue(e)} (descriptor skipped)\n`);
}

export function findDescriptor(load: DescriptorLoad, name: string): LoadedDescriptor | undefined {
  return load.descriptors.find((d) => d.descriptor.name === name);
}

/** Every `--agent` value that resolves: built-ins, `custom`, loaded descriptors. */
export function runnableAgentNames(load: DescriptorLoad): string[] {
  return [...builtinAgentNames(), ...load.descriptors.map((d) => d.descriptor.name)];
}

export function unknownAgentError(agent: string, load: DescriptorLoad): HarnessError {
  return new HarnessError(`unknown agent '${agent}' (expected one of: ${runnableAgentNames(load).join(", ")})`, "UNKNOWN_AGENT");
}

export interface CustomRunFlags {
  template?: string;
  "prompt-stdin"?: boolean;
  "template-shell"?: boolean;
}

export interface ResolvedRunAgent {
  /** Extra adapter to register for this run (absent for built-ins). */
  adapter?: AgentAdapter;
  /** Wrap the run's pricer (descriptor pricingHints). */
  wrapPricer?: (p: Pricer) => Pricer;
}

/**
 * Resolve `--agent` for `ach run`: a built-in passes through; `custom` builds a
 * one-off template adapter; anything else must be a loaded descriptor with a
 * launch block. Template flags on a non-custom agent are a usage error.
 */
export function resolveRunAgent(agent: string, flags: CustomRunFlags, load: DescriptorLoad): ResolvedRunAgent {
  const templateFlags = flags.template !== undefined || flags["prompt-stdin"] === true || flags["template-shell"] === true;
  if (agent === CUSTOM_AGENT) {
    if (flags.template === undefined || flags.template.trim() === "") {
      throw new HarnessError(
        "run --agent custom requires --template '<cmd with {prompt}>' (placeholders: {prompt} {model} {workspace})",
        "USAGE",
      );
    }
    return {
      adapter: createCustomAdapter({
        name: CUSTOM_AGENT,
        template: flags.template,
        promptVia: flags["prompt-stdin"] === true ? "stdin" : "argv",
        shell: flags["template-shell"] === true,
      }),
    };
  }
  if (templateFlags) {
    throw new HarnessError("--template/--prompt-stdin/--template-shell only apply to --agent custom", "USAGE");
  }
  if (isKnownAgent(agent)) return {};
  const found = findDescriptor(load, agent);
  if (!found) throw unknownAgentError(agent, load);
  const config = descriptorToCustomConfig(found);
  if (!config) {
    throw new HarnessError(
      `agent '${agent}' (${found.file}) is meter-only (launch: null): it can be read by stats but not run`,
      "USAGE",
    );
  }
  const hints = found.descriptor.pricingHints;
  return {
    adapter: createCustomAdapter(config),
    ...(hints !== undefined && Object.keys(hints).length > 0
      ? { wrapPricer: (p: Pricer) => withPricingHints(p, hints, found.file) }
      : {}),
  };
}

// -------------------------------------------------------------------- stats

export interface UnmeteredGroup {
  runs: number;
  byAgent: Record<string, { runs: number }>;
}

/**
 * Runs recorded with `metering: "none"` (custom agents with no usage source).
 * They carry no token records at all, so they are counted as RUNS in their own
 * group — never folded into the metered totals as fabricated zeros.
 */
export function unmeteredRuns(dir: string, opts: { agent?: string; sinceTs?: number; records?: ReturnType<typeof listRunRecords> } = {}): UnmeteredGroup {
  const group: UnmeteredGroup = { runs: 0, byAgent: {} };
  for (const rec of opts.records ?? listRunRecords(dir)) {
    if (rec.metering !== "none") continue;
    if (opts.agent && rec.agent !== opts.agent) continue;
    if (opts.sinceTs !== undefined && rec.startedAt < opts.sinceTs) continue;
    group.runs += 1;
    (group.byAgent[rec.agent] ??= { runs: 0 }).runs += 1;
  }
  return group;
}

/**
 * Usage rows from every meter-capable descriptor's transcript tap, priced
 * with the descriptor's pricingHints over `pricer` (a reported costUsd wins).
 */
export async function descriptorTapRows(
  load: DescriptorLoad,
  pricer: Pricer,
  opts: { agent?: string; sinceTs?: number; costMode?: CostMode } = {},
): Promise<{ rows: (TapUsageRow & { costSource?: "reported" | "computed" })[]; warnings: string[] }> {
  const out: (TapUsageRow & { costSource?: "reported" | "computed" })[] = [];
  const warnings: string[] = [];
  for (const d of load.descriptors) {
    if (!d.descriptor.usageTap) continue;
    if (opts.agent && d.descriptor.name !== opts.agent) continue;
    const hints = d.descriptor.pricingHints;
    const p = hints ? withPricingHints(pricer, hints, d.file) : pricer;
    for (const row of await readDescriptorTap(d)) {
      if (opts.sinceTs !== undefined) {
        const ms = row.ts ? Date.parse(row.ts) : NaN;
        if (!Number.isFinite(ms) || ms < opts.sinceTs) continue;
      }
      let computed: number | undefined;
      if (row.model && (row.costUsd === undefined || opts.costMode === "calculate")) {
        const c = p.price({
          model: row.model,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          cacheReadTokens: row.cacheReadTokens,
          cacheWriteTokens: row.cacheWriteTokens,
        });
        if (!Number.isNaN(c)) computed = c;
      }
      const { costUsd: reported, ...rest } = row;
      out.push({ ...rest, ...selectCost(opts.costMode ?? "auto", reported, computed) });
    }
    // A hint-priced model is announced, never silent (drains base warnings too).
    if (p !== pricer) warnings.push(...p.drainWarnings());
  }
  return { rows: out, warnings };
}

// ------------------------------------------------------------------- agents

/** `ach agents [--json]`: built-ins, loaded descriptors, and descriptor problems. */
export async function cmdAgents(rest: string[]): Promise<number> {
  const args = parseArgs({ args: rest, options: { json: { type: "boolean", default: false } }, allowPositionals: false });
  const load = loadCatalog();
  reportCatalogIssues(load);
  const descriptors = load.descriptors.map((d) => ({
    name: d.descriptor.name,
    file: d.file,
    ...(d.descriptor.description !== undefined ? { description: d.descriptor.description } : {}),
    launch: d.descriptor.launch ? true : false,
    usageTap: d.descriptor.usageTap ? true : false,
    pricingHints: Object.keys(d.descriptor.pricingHints ?? {}),
  }));
  if (args.values.json) {
    process.stdout.write(
      JSON.stringify({ builtins: [...AGENTS, CUSTOM_AGENT], descriptors, errors: load.errors, warnings: load.warnings }, null, 2) + "\n",
    );
    return 0;
  }
  process.stdout.write(`built-in   ${[...AGENTS, CUSTOM_AGENT].join(", ")}\n`);
  for (const d of descriptors) {
    const caps = [d.launch ? "run" : null, d.usageTap ? "meter" : null].filter(Boolean).join("+");
    process.stdout.write(`agents.d   ${d.name.padEnd(16)} ${caps.padEnd(9)} ${d.file}\n`);
  }
  return 0;
}
