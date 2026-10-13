// `ach gc` (#70): argument parsing, TTL resolution and output for the
// retention pass in src/core/gc.ts (which owns every safety rule).
import path from "node:path";
import { parseArgs } from "node:util";
import { HarnessError } from "../core/types.ts";
import { stateDir as defaultStateDir } from "../core/store.ts";
import { applyGc, DEFAULT_TRANSCRIPTS_TTL_MS, logGc, planGc, type GcPlan, type GcPolicy, type GcResult } from "../core/gc.ts";
import { fmtInt, resolveDirFlag } from "./lib.ts";
import { parseDuration, parseTimeSpec, resolveTimeZone, TZ_ENV } from "./time-window.ts";

export const GC_TRANSCRIPTS_TTL_ENV = "AGENTIC_CODING_HARNESS_GC_TRANSCRIPTS_TTL";
export const GC_RUNS_TTL_ENV = "AGENTIC_CODING_HARNESS_GC_RUNS_TTL";

export const GC_USAGE = `usage: ach gc [--dry-run] [--before <date|duration>] [--keep-summaries]
              [--transcripts-ttl <duration|never>] [--runs-ttl <duration|never>]
              [--state-dir <stateDir>] [--json]

  Deletes old artifacts from the ach state dir, and nothing else:
    transcripts  <stateDir>/raw/**/*.jsonl  (default TTL 30d)
    runs         <stateDir>/runs/*.json     (default: kept forever)
  --dry-run          list what would go (path, class, bytes) and delete nothing
  --before X         one cutoff for both classes: a duration (30d, 2w, 12h) or a
                     date (YYYY-MM-DD, RFC 3339, '7d ago')
  --keep-summaries   never delete run records (tokens, cost, status survive);
                     prune transcripts only
  --transcripts-ttl, --runs-ttl   per-class TTL, overriding --before for that class
  Precedence per class: class flag > --before > env (${GC_TRANSCRIPTS_TTL_ENV},
  ${GC_RUNS_TTL_ENV}) > default. Never deleted: runs whose process is still
  alive, files written in the last minute, symlinks (refused and reported), and
  anything outside raw/ and runs/ (warehouse/, state/, offsets.json, ...).
  Each real pass appends to <stateDir>/gc-log.jsonl. Pruned transcripts drop out
  of 'ach stats' history; run 'ach archive' first to keep a copy.`;

/** A TTL spec: a duration, or never/forever/off. Returns ms, or null for never. */
export function parseTtl(spec: string, flag: string): number | null {
  const s = spec.trim().toLowerCase();
  if (s === "never" || s === "forever" || s === "off") return null;
  const d = parseDuration(s);
  if (d === undefined) {
    throw new HarnessError(`${flag}: cannot parse '${spec}' (expected a duration like 30d, 2w, 12h, 90m, or 'never')`, "USAGE");
  }
  return d;
}

/** `--before`: a duration (now - d) or any `--since`-style date. */
export function parseBefore(spec: string, now: number, env: NodeJS.ProcessEnv = process.env): number {
  const d = parseDuration(spec);
  if (d !== undefined) return now - d;
  try {
    return parseTimeSpec(spec, { now, timeZone: resolveTimeZone(undefined, env[TZ_ENV]) }, "--before");
  } catch (e) {
    throw new HarnessError((e as Error).message, "USAGE");
  }
}

export interface GcFlags {
  before?: string;
  keepSummaries?: boolean;
  transcriptsTtl?: string;
  runsTtl?: string;
}

/** Resolve the per-class cutoffs (epoch ms, null = keep) from flags + env. */
export function resolveGcPolicy(flags: GcFlags, now: number, env: NodeJS.ProcessEnv = process.env): GcPolicy {
  if (flags.keepSummaries && flags.runsTtl !== undefined && parseTtl(flags.runsTtl, "--runs-ttl") !== null) {
    throw new HarnessError("--keep-summaries keeps every run record; it cannot be combined with --runs-ttl", "USAGE");
  }
  const before = flags.before !== undefined ? parseBefore(flags.before, now, env) : undefined;
  const cls = (flag: string | undefined, flagName: string, envName: string, dflt: number | null): number | null => {
    if (flag !== undefined) {
      const ttl = parseTtl(flag, flagName);
      return ttl === null ? null : now - ttl;
    }
    if (before !== undefined) return before;
    const e = env[envName];
    if (e !== undefined && e !== "") {
      const ttl = parseTtl(e, envName);
      return ttl === null ? null : now - ttl;
    }
    return dflt === null ? null : now - dflt;
  };
  const transcriptsBefore = cls(flags.transcriptsTtl, "--transcripts-ttl", GC_TRANSCRIPTS_TTL_ENV, DEFAULT_TRANSCRIPTS_TTL_MS);
  const runsBefore = flags.keepSummaries ? null : cls(flags.runsTtl, "--runs-ttl", GC_RUNS_TTL_ENV, null);
  return { transcriptsBefore, runsBefore };
}

function cutoffText(ms: number | null): string {
  return ms === null ? "keep all" : `before ${new Date(ms).toISOString()}`;
}

export function formatGcText(plan: GcPlan, result: GcResult | null): string {
  const lines: string[] = [];
  const root = plan.realStateDir ?? plan.stateDir;
  const rel = (f: string): string => (plan.realStateDir ? path.relative(plan.realStateDir, f) : f);
  const verb = result === null ? "would delete" : "deleted";
  lines.push(`state dir ${root}`);
  lines.push(`  transcripts: ${cutoffText(plan.policy.transcriptsBefore)}   runs: ${cutoffText(plan.policy.runsBefore)}`);
  const list = result === null ? plan.victims : result.deleted;
  for (const v of list) lines.push(`  ${verb.padEnd(12)} ${v.class.padEnd(10)} ${fmtInt(v.bytes).padStart(12)} B  ${rel(v.file)}`);
  for (const p of plan.protected) lines.push(`  kept         ${p.class.padEnd(10)} ${p.reason.padStart(14)}  ${rel(p.file)}`);
  for (const r of plan.refused) lines.push(`  REFUSED      ${r.file}  (${r.reason})`);
  if (result) for (const f of result.failed) lines.push(`  FAILED       ${f.file}  (${f.reason})`);
  const n = list.length;
  const bytes = result === null ? plan.bytes : result.bytes;
  const tc = list.filter((v) => v.class === "transcript").length;
  lines.push(
    `${result === null ? "dry run: would delete" : "deleted"} ${fmtInt(n)} files (${fmtInt(tc)} transcripts, ${fmtInt(n - tc)} runs), ` +
      `${fmtInt(bytes)} bytes; ${fmtInt(plan.protected.length)} kept (live/fresh), ${fmtInt(plan.refused.length)} refused`,
  );
  return lines.join("\n") + "\n";
}

export async function cmdGc(rest: string[], now: number = Date.now()): Promise<number> {
  const args = parseArgs({
    args: rest,
    options: {
      "dry-run": { type: "boolean", default: false },
      before: { type: "string" },
      "keep-summaries": { type: "boolean", default: false },
      "transcripts-ttl": { type: "string" },
      "runs-ttl": { type: "string" },
      dir: { type: "string" },
      "state-dir": { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });
  if (args.values.help) {
    process.stdout.write(GC_USAGE + "\n");
    return 0;
  }
  const state = resolveDirFlag(args.values, "state-dir") ?? defaultStateDir();
  const policy = resolveGcPolicy(
    {
      before: args.values.before,
      keepSummaries: args.values["keep-summaries"],
      transcriptsTtl: args.values["transcripts-ttl"],
      runsTtl: args.values["runs-ttl"],
    },
    now,
  );
  const plan = planGc({ stateDir: path.resolve(state), policy, now });
  const dry = args.values["dry-run"] === true;
  const result = dry ? null : applyGc(plan);
  if (result) logGc(plan, result, now);
  if (args.values.json) {
    process.stdout.write(JSON.stringify({ dryRun: dry, ...plan, result }, null, 2) + "\n");
  } else {
    process.stdout.write(formatGcText(plan, result));
  }
  return result && result.failed.length > 0 ? 1 : 0;
}
