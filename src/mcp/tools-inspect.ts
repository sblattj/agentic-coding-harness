// MCP inspection tools: report rendering, interchange emission, and usage
// stats — thin wrappers over the same functions the `harness` CLI uses.
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
import type { McpServer } from "./contract.ts";

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

async function harnessReport(args: Record<string, unknown>): Promise<unknown> {
  const a = parseArgs(ReportSchema, args);
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

async function harnessEmit(args: Record<string, unknown>): Promise<unknown> {
  const a = parseArgs(EmitSchema, args);
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
  credits?: number;
}

function rowWithCredits(
  bucket: ReturnType<typeof aggregate>["totals"],
  credits: number | undefined,
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
  if (credits !== undefined && credits > 0) row.credits = Math.round(credits * 100) / 100;
  return row;
}

function statCredits(records: Array<{ agent: string; extra?: Record<string, unknown> }>): {
  byAgent: Map<string, number>;
  total: number | undefined;
} {
  const byAgent = new Map<string, number>();
  let total: number | undefined;
  for (const r of records) {
    const credits = r.extra?.credits;
    if (typeof credits !== "number" || !Number.isFinite(credits)) continue;
    byAgent.set(r.agent, (byAgent.get(r.agent) ?? 0) + credits);
    total = (total ?? 0) + credits;
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

export function registerInspectTools(server: McpServer, opts: { stateDir: string }): void {
  if (opts.stateDir) process.env.AGENT_HARNESS_STATE_DIR = opts.stateDir;
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
    handler: harnessReport,
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
    handler: harnessEmit,
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
