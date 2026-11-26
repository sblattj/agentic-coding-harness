// MCP inspection tools: report rendering, interchange emission, and usage
// stats — thin wrappers over the same functions the `harness` CLI uses.
import { creditUnitOfAgent } from "../core/credit-units.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import type { AgentEvent } from "../core/types.ts";
import { readAllRecords } from "../core/store.ts";
import { AtifWriter } from "../emitters/atif.ts";
import { toOtlpJson } from "../emitters/otel.ts";
import { readRunTraceContext } from "../core/trace-context.ts";
import { emitToLangfuse } from "../emitters/langfuse.ts";
import { sanitizeEnrichAttributes } from "../emitters/enrich.ts";
import { loadTrials } from "../report/model.ts";
import { readVersion, renderReport } from "../report/html.ts";
import { aggregate, type AggregatableRecord } from "../cli/lib.ts";
import { checkArtifactPath, type GatewayConfig } from "../serve/gateway.ts";
import { countByDetector, MASK_MODES, maskForExport, resolveMaskPolicy, type Finding, type MaskSink } from "../core/masking.ts";
import { loadedMaskConfig } from "../cli/config.ts";
import { PRIVACY_MODES, privacyId, type PrivacyMode } from "../core/privacy.ts";
import type { McpServer } from "./contract.ts";

/** Opts shared by every register* function: state dir plus the optional
 *  gateway profile (present only under `harness serve --gateway`). */
interface ToolOpts {
  stateDir: string;
  gateway?: GatewayConfig;
}

function parseArgs<T extends z.ZodTypeAny>(schema: T, args: Record<string, unknown>): z.infer<T> {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const field = issue.path.join(".") || "(root)";
    throw new Error(`${field}: ${issue.message}`);
  }
  return parsed.data;
}

/** #71: the mask policy for one MCP export (arg `mask` > env > config file > the sink's
 *  built-in default, SINK_DEFAULT_MASK_MODE: otel and langfuse `all`, atif and report `none`);
 *  #46: the same for arg `privacy`. */
function mcpMaskPolicy(sink: MaskSink, mask: string | undefined, privacy?: string) {
  return resolveMaskPolicy({ sink, flags: { mask, privacy }, config: loadedMaskConfig() });
}

/** #46: the privacy field of a tool result (absent when off, so results stay today's). */
const privacyField = (mode: PrivacyMode) => (mode !== "off" ? { privacy: mode } : {});

/** A `mask: "preview"` result: findings (star samples only) and counts; nothing written or sent. */
function previewResult(findings: Finding[], extra: Record<string, unknown>): unknown {
  return { ...extra, mask: "preview", written: false, findings, counts: countByDetector(findings) };
}

async function fileBytes(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).size;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------- report

const ReportSchema = z.object({
  dir: z.string().min(1),
  out: z.string().min(1).optional(),
  open: z.boolean().default(false),
  mask: z.enum(MASK_MODES).optional(),
  privacy: z.enum(PRIVACY_MODES).optional(),
});

async function harnessReport(args: Record<string, unknown>, opts: ToolOpts): Promise<unknown> {
  const a = parseArgs(ReportSchema, args);
  if (opts.gateway) {
    const artifact = checkArtifactPath(opts.stateDir, a.out, opts.gateway);
    if (!artifact.ok) throw new Error(artifact.error);
  }
  let rootDir: string | null = null;
  let runs: Awaited<ReturnType<typeof loadTrials>>["runs"] = [];
  const labels = new Set<string>();
  const trialSet = await loadTrials(a.dir);
  rootDir = trialSet.rootDir;
  runs = trialSet.runs;
  for (const l of trialSet.labels) labels.add(l);
  const root = rootDir ?? path.resolve(a.dir);
  const out = a.out ?? path.join(root, "report.html");
  const gate = maskForExport({ rootDir: root, labels: [...labels].sort(), runs }, mcpMaskPolicy("report", a.mask, a.privacy));
  if (gate.mode === "preview") return previewResult(gate.findings, { out });
  const html = renderReport(gate.value, {
    version: await readVersion(),
    generatedAt: new Date(),
    ...(gate.privacy !== "off" ? { privacy: gate.privacy } : {}),
  });
  await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await fs.writeFile(out, html);
  if (a.open && process.platform === "darwin") {
    spawnSync("open", [out], { stdio: "ignore" });
  }
  return { out, runs: runs.length, bytes: await fileBytes(out), ...privacyField(gate.privacy) };
}

// ---------------------------------------------------------------- emit

const EventStreamSchema = z.union([
  z.array(z.unknown()),
  z.object({ events: z.array(z.unknown()) }).transform((o) => o.events),
]);

const EmitSchema = z.object({
  runFile: z.string().min(1),
  format: z.enum(["atif", "otel", "langfuse"]),
  out: z.string().min(1).optional(),
  endpoint: z.string().min(1).optional(),
  mask: z.enum(MASK_MODES).optional(),
  privacy: z.enum(PRIVACY_MODES).optional(),
  // #95: static enricher attributes only. No env mapping here: a client-chosen
  // env var name plus a client-chosen out/endpoint would let any MCP client
  // read the server's environment.
  attributes: z.unknown().optional(),
  // #95: a user enricher module runs local code, so it is CLI/config only;
  // over MCP it is ignored with a warning.
  enricher: z.unknown().optional(),
});

async function harnessEmit(args: Record<string, unknown>, opts: ToolOpts): Promise<unknown> {
  const a = parseArgs(EmitSchema, args);
  if (opts.gateway) {
    if (opts.gateway.enabled && a.format === "langfuse") {
      throw new Error("disabled in gateway mode");
    }
    const artifact = checkArtifactPath(opts.stateDir, a.out, opts.gateway);
    if (!artifact.ok) throw new Error(artifact.error);
  }
  let raw: string;
  try {
    raw = await fs.readFile(a.runFile, "utf8");
  } catch (e) {
    throw new Error(`runFile: cannot read '${a.runFile}': ${e instanceof Error ? e.message : e}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`runFile: '${a.runFile}' is not valid JSON: ${e instanceof Error ? e.message : e}`);
  }
  // #71: the export chokepoint (mode none passes the input through untouched).
  const gate = maskForExport(parsed, mcpMaskPolicy(a.format, a.mask, a.privacy));
  if (gate.mode === "preview") return previewResult(gate.findings, { format: a.format });
  parsed = gate.value;
  // #46: stamps (none when off) and the session id the sinks share.
  const privacy = gate.privacy;
  const stamp = privacyField(privacy);
  const resourceAttributes = privacy !== "off" ? { resourceAttributes: { "ach.privacy": privacy } } : {};
  const sessionId = privacyId("unknown-session", privacy);
  const stream = EventStreamSchema.safeParse(parsed);
  if (!stream.success) {
    throw new Error(`runFile: '${a.runFile}' must be an event array or {events: [...]}`);
  }
  const events = stream.data as unknown as AgentEvent[];
  const enrich = sanitizeEnrichAttributes(a.attributes);
  if (a.enricher !== undefined) {
    enrich.warnings.push("enricher is not accepted over MCP (it would run local code); ignored. Use `ach emit --enricher` instead");
  }
  for (const w of enrich.warnings) process.stderr.write(`harness_emit: warning: ${w}\n`);
  const attributes = Object.keys(enrich.attributes).length > 0 ? enrich.attributes : undefined;
  const warn = enrich.warnings.length > 0 ? { warnings: enrich.warnings } : {};
  // #73: a RunResult file carries the run's W3C ids; otel/langfuse adopt them.
  const runTrace = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? readRunTraceContext((parsed as { trace?: unknown }).trace)
    : undefined;
  const traceOpt = runTrace !== undefined ? { trace: runTrace } : {};

  if (a.format === "atif") {
    const writer = AtifWriter.fromEvents(events, {
      agent: "unknown-agent",
      version: "0.2.0",
      modelName: "unknown-model",
      ...(privacy !== "off" ? { extra: { privacy } } : {}),
      attributes,
    });
    if (a.out) {
      writer.finalize(a.out);
      const { ok, errors } = AtifWriter.validate(path.resolve(a.out));
      if (!ok) {
        throw new Error(`out: ATIF validation failed for '${a.out}':\n${errors.join("\n")}`);
      }
      return { format: a.format, out: a.out, detail: "validated", ...stamp, ...warn };
    }
    return { format: a.format, detail: JSON.stringify(writer.toTrajectory()).length + " bytes rendered", ...stamp, ...warn };
  }

  if (a.format === "langfuse") {
    const baseUrl = a.endpoint ?? process.env.LANGFUSE_URL ?? process.env.LANGFUSE_HOST ?? "http://localhost:3000";
    const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
    const secretKey = process.env.LANGFUSE_SECRET_KEY;
    if (!publicKey || !secretKey) {
      throw new Error(
        "langfuse requires env LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY",
      );
    }
    let result;
    try {
      result = await emitToLangfuse(events, {
        baseUrl,
        publicKey,
        secretKey,
        sessionId,
        agentName: "unknown-agent",
        model: "unknown-model",
        ...resourceAttributes,
        attributes,
        ...traceOpt,
      });
    } catch (e) {
      throw new Error(`endpoint: langfuse ingest to '${baseUrl}' failed: ${e instanceof Error ? e.message : e}`);
    }
    if (!result.ok) {
      throw new Error(
        `endpoint: langfuse ingest failed (HTTP ${result.status}) at ${result.url}: ${result.body.slice(0, 500)}`,
      );
    }
    if (a.out) {
      await fs.writeFile(a.out, JSON.stringify(result.payload, null, 2) + "\n");
    }
    return {
      format: a.format,
      out: a.out,
      sent: true,
      ...stamp,
      detail: `posted ${result.spanCount} spans to ${result.url} — trace ${result.traceId} (HTTP ${result.status})`,
      ...warn,
    };
  }

  const doc = toOtlpJson(events, {
    sessionId,
    agentName: "unknown-agent",
    model: "unknown-model",
    ...resourceAttributes,
    attributes,
    ...traceOpt,
  });
  const body = JSON.stringify(doc, null, 2) + "\n";
  if (a.out) {
    await fs.mkdir(path.dirname(path.resolve(a.out)), { recursive: true });
    await fs.writeFile(a.out, body);
    return { format: a.format, out: a.out, detail: "wrote", ...stamp, ...warn };
  }
  return { format: a.format, detail: body.length + " bytes rendered", ...stamp, ...warn };
}

// ---------------------------------------------------------------- stats

const StatsSchema = z.object({
  sinceDays: z.number().int().nonnegative().default(7),
  agent: z.string().min(1).optional(),
});

interface StatRow {
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number;
  /** Kiro metering credits (only kiro-unit records; copilot AIU is in `aiu`). */
  credits?: number;
  /** GitHub Copilot AIU ("AI credits", 1 AIU = US$0.01): a different unit from `credits`, never added to it. */
  aiu?: number;
}

/** Per-unit credit figures for one stats row. */
interface UnitCredits {
  credits?: number;
  aiu?: number;
}

function rowWithCredits(
  bucket: ReturnType<typeof aggregate>["totals"],
  units: UnitCredits | undefined,
): StatRow {
  const row: StatRow = {
    runs: bucket.records,
    inputTokens: bucket.inputTokens,
    outputTokens: bucket.outputTokens,
    cacheReadTokens: bucket.cacheReadTokens,
    cacheWriteTokens: bucket.cacheWriteTokens,
    reasoningTokens: bucket.reasoningTokens,
    costUsd: bucket.costUsd,
  };
  if (units?.credits !== undefined && units.credits > 0) row.credits = Math.round(units.credits * 100) / 100;
  if (units?.aiu !== undefined && units.aiu > 0) row.aiu = Math.round(units.aiu * 100) / 100;
  return row;
}

export function statCredits(records: Array<{ agent: string; extra?: Record<string, unknown> }>): {
  byAgent: Map<string, UnitCredits>;
  total: UnitCredits;
} {
  const byAgent = new Map<string, UnitCredits>();
  const total: UnitCredits = {};
  const bump = (o: UnitCredits, key: "credits" | "aiu", v: number): void => {
    o[key] = (o[key] ?? 0) + v;
  };
  for (const r of records) {
    const credits = r.extra?.credits;
    if (typeof credits !== "number" || !Number.isFinite(credits)) continue;
    // Units stay apart (#23): kiro credits and copilot AIU are never one sum.
    const key = creditUnitOfAgent(r.agent) === "copilot" ? "aiu" : "credits";
    const row = byAgent.get(r.agent) ?? {};
    bump(row, key, credits);
    byAgent.set(r.agent, row);
    bump(total, key, credits);
  }
  return { byAgent, total };
}

async function harnessStats(args: Record<string, unknown>): Promise<unknown> {
  const a = parseArgs(StatsSchema, args);
  const sinceTs = Date.now() - a.sinceDays * 86_400_000;
  const records = await readAllRecords({ agent: a.agent, sinceTs });
  const rows: AggregatableRecord[] = records.map((r) => ({
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
  const agg = aggregate(rows);
  const credits = statCredits(records);
  const byAgent: Record<string, StatRow> = {};
  for (const [agent, bucket] of Object.entries(agg.byAgent)) {
    byAgent[agent] = rowWithCredits(bucket, credits.byAgent.get(agent));
  }
  return {
    sinceDays: a.sinceDays,
    ...(a.agent ? { agent: a.agent } : {}),
    total: rowWithCredits(agg.totals, credits.total),
    byAgent,
  };
}

// ---------------------------------------------------------------- registration

export function registerInspectTools(server: McpServer, opts: ToolOpts): void {
  if (opts.stateDir) process.env.AGENTIC_CODING_HARNESS_STATE_DIR = opts.stateDir;
  server.registerTool({
    name: "harness_report",
    description:
      "Render a self-contained HTML comparison report for a trial directory (same as `harness report`).",
    inputSchema: {
      type: "object",
      properties: {
        dir: { type: "string", description: "Trial directory to report on" },
        out: { type: "string", description: "Output path (default <dir>/report.html)" },
        open: { type: "boolean", description: "Open the file with `open` on macOS" },
        mask: { type: "string", enum: [...MASK_MODES], description: "Secret masking: none | preview (list findings, write nothing) | all (mask before writing); default from config/env, else none" },
        privacy: { type: "string", enum: [...PRIVACY_MODES], description: "Privacy mode (docs/MASKING.md): off | redact (paths to basenames, $HOME to ~) | anon (also drops prompt text, hashes run/session ids); default from config/env, else off" },
      },
      required: ["dir"],
    },
    handler: (args) => harnessReport(args, opts),
  });
  server.registerTool({
    name: "harness_emit",
    description:
      "Emit a saved run JSON to a sink: atif/otel JSON file, or POST to a Langfuse OTLP endpoint (same as `harness emit`).",
    inputSchema: {
      type: "object",
      properties: {
        runFile: { type: "string", description: "Path to a saved RunResult JSON" },
        format: { type: "string", enum: ["atif", "otel", "langfuse"] },
        out: { type: "string", description: "Output file for atif/otel (and langfuse payload dump)" },
        endpoint: { type: "string", description: "Langfuse OTLP base URL override" },
        mask: { type: "string", enum: [...MASK_MODES], description: "Secret masking: none | preview (list findings, write and send nothing) | all (mask before export); default from config/env, else all for otel and langfuse, none for atif" },
        privacy: { type: "string", enum: [...PRIVACY_MODES], description: "Privacy mode (docs/MASKING.md): off | redact (paths to basenames, $HOME to ~) | anon (also drops prompt text, hashes run/session ids); default from config/env, else off" },
        attributes: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Custom attributes stamped on every OTel/Langfuse span and the OTLP resource, or ATIF extra.attributes (#95)",
        },
      },
      required: ["runFile", "format"],
    },
    handler: (args) => harnessEmit(args, opts),
  });
  server.registerTool({
    name: "harness_stats",
    description:
      "Aggregate token/cost stats from the harness state store (same aggregation as `harness stats`).",
    inputSchema: {
      type: "object",
      properties: {
        sinceDays: { type: "integer", description: "Lookback window in days (default 7)" },
        agent: { type: "string", description: "Filter to one agent" },
      },
    },
    handler: harnessStats,
  });
}
