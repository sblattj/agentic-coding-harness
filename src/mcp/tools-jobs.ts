// MCP async job tools: harness_run_async (fire-and-forget a driver run),
// harness_run_status / harness_run_events / harness_run_cancel.
// Contract: src/serve/PLAN.md section B. The driver's registry heartbeats own
// lifecycle bookkeeping; the in-flight map here only keeps promises alive and
// provides in-process cancel handles.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "./contract.ts";
import { KIRO_INPUT_SCHEMA, RunArgsSchema } from "./tools-run.ts";
import type { RunSpec as CoreRunSpec } from "../core/types.ts";
import { createDriver, defaultAdapters } from "../core/driver.ts";
import { createPricer } from "../core/pricing.ts";
import {
  effectiveStatus,
  listRunRecords,
  readRunRecord,
  registryDir,
  resolveRawTranscript,
} from "../core/registry.ts";
import {
  checkCwd,
  countLiveJobs,
  filterExtraArgs,
  type GatewayConfig,
} from "../serve/gateway.ts";

type RunArgs = z.infer<typeof RunArgsSchema>;

interface InFlightJob {
  promise: Promise<unknown>;
  /** Abort the run via driver.abort(runId); true when an active run matched. */
  abort: () => boolean;
}

/** Module-level so jobs survive across registrations and the process holds
 *  every in-flight run promise (never garbage-collected mid-run). */
const inFlight = new Map<string, InFlightJob>();

function parseArgs<T extends z.ZodTypeAny>(
  schema: T,
  args: Record<string, unknown>,
  toolName: string,
): z.infer<T> {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (!issue) throw new Error(`invalid ${toolName} arguments`);
    const field = issue.path.join(".") || "(root)";
    throw new Error(`invalid ${toolName} arguments: bad field '${field}': ${issue.message}`);
  }
  return parsed.data;
}

/** Build the driver RunSpec from validated tool args (mirrors tools-run.ts).
 *  extraArgsOverride carries the gateway-filtered allowlist (undefined →
 *  pass through untouched). */
export function toSpec(a: RunArgs, runId: string, extraArgsOverride?: string[]): CoreRunSpec {
  const budget: CoreRunSpec["budget"] = {
    ...(a.budgetUsd !== undefined ? { usd: a.budgetUsd } : {}),
    ...(a.maxTurns !== undefined ? { maxTurns: a.maxTurns } : {}),
    ...(a.wallMs !== undefined ? { wallMs: a.wallMs } : {}),
    ...(a.idleMs !== undefined ? { idleMs: a.idleMs } : {}),
  };
  const extraArgs =
    extraArgsOverride !== undefined ? extraArgsOverride : a.extraArgs;
  return {
    prompt: a.prompt,
    runId,
    ...(a.model !== undefined ? { model: a.model } : {}),
    ...(a.cwd !== undefined ? { cwd: a.cwd } : {}),
    ...(budget.usd !== undefined ||
    budget.maxTurns !== undefined ||
    budget.wallMs !== undefined ||
    budget.idleMs !== undefined
      ? { budget }
      : {}),
    ...(extraArgs !== undefined ? { extraArgs } : {}),
    ...(a.kiro !== undefined ? { kiro: a.kiro } : {}),
  };
}

function statusPayload(rec: NonNullable<ReturnType<typeof readRunRecord>>): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    found: true,
    runId: rec.runId,
    status: effectiveStatus(rec),
    sessionId: rec.sessionId ?? null,
    totals: rec.totals,
    lastEvent: rec.lastEvent ?? null,
    startedAt: rec.startedAt,
    updatedAt: rec.updatedAt,
    elapsedMs: Math.max(0, Date.now() - rec.startedAt),
  };
  if (rec.exitStatus !== undefined) payload.exitStatus = rec.exitStatus;
  return payload;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // Only ESRCH proves dead; EPERM etc. still means the process exists.
    return !(typeof e === "object" && e !== null && "code" in e && (e as NodeJS.ErrnoException).code === "ESRCH");
  }
}

export function registerJobTools(
  server: McpServer,
  opts: { stateDir: string; gateway?: GatewayConfig },
): void {
  server.registerTool({
    name: "harness_run_async",
    description:
      "Start a harness agent run (claude|opencode|kiro|codex|gemini) WITHOUT waiting for completion; returns { runId, sessionId: null, started, transcriptPath } promptly. Poll harness_run_status, page harness_run_events, or harness_run_cancel with the runId.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", enum: ["claude", "opencode", "kiro", "codex", "gemini"], description: "Agent to run" },
        prompt: { type: "string", description: "Prompt sent to the agent" },
        model: { type: "string", description: "Model override" },
        cwd: { type: "string", description: "Working directory for the agent subprocess" },
        budgetUsd: { type: "number", description: "Abort the run once cumulative cost exceeds this USD amount" },
        maxTurns: { type: "integer", description: "Abort the run after this many agent turns" },
        wallMs: { type: "number", description: "Abort the run if it exceeds this wall-clock duration in milliseconds from launch" },
        idleMs: { type: "number", description: "Abort the run if no agent events arrive for this many milliseconds" },
        extraArgs: { type: "array", items: { type: "string" }, description: "Extra CLI args appended verbatim" },
        kiro: KIRO_INPUT_SCHEMA,
      },
      required: ["agent", "prompt"],
    },
    handler: async (args) => {
      const a = parseArgs(RunArgsSchema, args, "harness_run_async");
      const gw = opts.gateway;
      if (gw) {
        const cwdCheck = checkCwd(gw, a.cwd);
        if (!cwdCheck.ok) throw new Error(cwdCheck.error);
        if (gw.enabled && countLiveJobs(listRunRecords(opts.stateDir)) >= gw.maxJobs) {
          throw new Error("max concurrent jobs reached");
        }
      }
      const extra = filterExtraArgs(gw, a.extraArgs);
      const strippedWarning =
        extra.stripped.length > 0
          ? `gateway: stripped extraArgs not in allowlist: ${extra.stripped.map((s) => `'${s}'`).join(", ")}`
          : undefined;
      const runId = randomUUID();
      const driver = createDriver({
        adapters: await defaultAdapters(),
        stateDir: opts.stateDir,
        pricer: createPricer(),
        registry: { stateDir: opts.stateDir },
      });
      // Fire-and-forget: the registry record (heartbeats + final status) is
      // written by the driver; this promise is only kept alive and drained so
      // a rejection can never surface as an unhandled rejection.
      const promise = driver.run(a.agent, toSpec(a, runId, extra.allowed));
      inFlight.set(runId, { promise, abort: () => driver.abort(runId) });
      promise
        .catch((err) => {
          process.stderr.write(
            `harness_run_async: run ${runId} failed — ${err instanceof Error ? err.message : String(err)}\n`,
          );
        })
        .finally(() => {
          inFlight.delete(runId);
        });
      // The agent's raw transcript path (<stateDir>/raw/<agent>-<session>.jsonl)
      // is unknown until the session id arrives; return the registry record
      // path, which exists as soon as the run starts.
      return {
        runId,
        sessionId: null,
        started: true,
        transcriptPath: path.join(registryDir(opts.stateDir), `${runId}.json`),
        ...(strippedWarning !== undefined ? { warnings: [strippedWarning] } : {}),
      };
    },
  });

  server.registerTool({
    name: "harness_run_status",
    description:
      "Report the status of an async harness run: effectiveStatus (running/interrupted/success/error/aborted), sessionId, token/cost totals, last event, timestamps, and elapsed time.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Run id returned by harness_run_async" },
      },
      required: ["runId"],
    },
    handler: async (args) => {
      const a = parseArgs(z.object({ runId: z.string().min(1) }), args, "harness_run_status");
      const rec = readRunRecord(opts.stateDir, a.runId);
      if (!rec) return { found: false, runId: a.runId };
      return statusPayload(rec);
    },
  });

  server.registerTool({
    name: "harness_run_events",
    description:
      "Page through the raw transcript events of an async harness run. cursor is a line offset (default 0); limit is events per page (default 100, max 1000). Returns { events, nextCursor, total, truncated }.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Run id returned by harness_run_async" },
        cursor: { type: "integer", description: "Line offset into the transcript (default 0)" },
        limit: { type: "integer", description: "Max events per page (default 100, max 1000)" },
      },
      required: ["runId"],
    },
    handler: async (args) => {
      const a = parseArgs(
        z.object({
          runId: z.string().min(1),
          cursor: z.number().int().nonnegative().optional(),
          limit: z.number().int().positive().max(1000).optional(),
        }),
        args,
        "harness_run_events",
      );
      const rec = readRunRecord(opts.stateDir, a.runId);
      if (!rec) return { found: false, runId: a.runId };
      let text: string;
      try {
        text = await fs.readFile(resolveRawTranscript(opts.stateDir, rec), "utf8");
      } catch {
        return { found: false, runId: a.runId };
      }
      const lines = text.split("\n").filter((line) => line.trim().length > 0);
      const cursor = a.cursor ?? 0;
      let limit = a.limit ?? 100;
      const maxBytes = opts.gateway?.enabled ? opts.gateway.maxOutputBytes : undefined;
      if (maxBytes !== undefined) {
        let bytes = 0;
        let fit = 0;
        for (const line of lines.slice(cursor, cursor + limit)) {
          bytes += line.length + 1;
          if (bytes > maxBytes) break;
          fit++;
        }
        limit = Math.min(limit, fit);
      }
      const slice = lines.slice(cursor, cursor + limit);
      const events: unknown[] = [];
      for (const line of slice) {
        try {
          events.push(JSON.parse(line));
        } catch {
          // Partial line from a concurrent write: skip, cursor still advances.
        }
      }
      return {
        found: true,
        events,
        nextCursor: cursor + slice.length,
        total: lines.length,
        truncated: cursor + slice.length < lines.length,
      };
    },
  });

  server.registerTool({
    name: "harness_run_cancel",
    description:
      "Cancel an async harness run: aborts in-process when this server owns it, else SIGTERMs the recorded pid while it is alive; reports cancelled:false for already-finished or interrupted runs.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Run id returned by harness_run_async" },
      },
      required: ["runId"],
    },
    handler: async (args) => {
      const a = parseArgs(z.object({ runId: z.string().min(1) }), args, "harness_run_cancel");
      const rec = readRunRecord(opts.stateDir, a.runId);
      const status: string | null = rec ? effectiveStatus(rec) : null;
      const job = inFlight.get(a.runId);
      if (job) {
        job.abort();
        return { cancelled: true, status: status ?? "aborted" };
      }
      if (!rec) return { cancelled: false, status };
      if (rec.status === "running") {
        if (rec.pid !== undefined && pidAlive(rec.pid)) {
          try {
            process.kill(rec.pid, "SIGTERM");
          } catch {
            // Raced dead between the liveness probe and the signal; fall through
            // to the interrupted verdict on the next status poll.
          }
          return { cancelled: true, status };
        }
        return { cancelled: false, reason: "interrupted", status };
      }
      return { cancelled: false, status };
    },
  });
}
