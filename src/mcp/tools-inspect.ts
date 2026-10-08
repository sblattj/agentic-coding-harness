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
import { emitToLangfuse } from "../emitters/langfuse.ts";
import { loadTrials } from "../report/model.ts";
import { readVersion, renderReport } from "../report/html.ts";
import { aggregate, type AggregatableRecord } from "../cli/lib.ts";
import { checkArtifactPath, type GatewayConfig } from "../serve/gateway.ts";
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
  const html = renderReport(
    { rootDir: root, labels: [...labels].sort(), runs },
    { version: await readVersion(), generatedAt: new Date() },
  );
  await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await fs.writeFile(out, html);
  if (a.open && process.platform === "darwin") {
    spawnSync("open", [out], { stdio: "ignore" });
  }
  return { out, runs: runs.length, bytes: await fileBytes(out) };
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
  const stream = EventStreamSchema.safeParse(parsed);
  if (!stream.success) {
    throw new Error(`runFile: '${a.runFile}' must be an event array or {events: [...]}`);
  }
  const events = stream.data as unknown as AgentEvent[];

  if (a.format === "atif") {
    const writer = AtifWriter.fromEvents(events, {
      agent: "unknown-agent",
      version: "0.2.0",
      modelName: "unknown-model",
    });
    if (a.out) {
      writer.finalize(a.out);
      const { ok, errors } = AtifWriter.validate(path.resolve(a.out));
      if (!ok) {
        throw new Error(`out: ATIF validation failed for '${a.out}':\n${errors.join("\n")}`);
      }
      return { format: a.format, out: a.out, detail: "validated" };
    }
    return { format: a.format, detail: JSON.stringify(writer.toTrajectory()).length + " bytes rendered" };
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
        sessionId: "unknown-session",
        agentName: "unknown-agent",
        model: "unknown-model",
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
      detail: `posted ${result.spanCount} spans to ${result.url} — trace ${result.traceId} (HTTP ${result.status})`,
    };
  }

  const doc = toOtlpJson(events, {
    sessionId: "unknown-session",
    agentName: "unknown-agent",
    model: "unknown-model",
  });
  const body = JSON.stringify(doc, null, 2) + "\n";
  if (a.out) {
    await fs.mkdir(path.dirname(path.resolve(a.out)), { recursive: true });
    await fs.writeFile(a.out, body);
    return { format: a.format, out: a.out, detail: "wrote" };
  }
  return { format: a.format, detail: body.length + " bytes rendered" };
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
