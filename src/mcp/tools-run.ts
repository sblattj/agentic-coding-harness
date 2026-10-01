// harness MCP run tools: harness_run (drive one agent to completion) and
// harness_agents (list known agents with CLI availability and capabilities).
// Contracts: src/mcp/contract.ts, src/core/driver.ts, src/core/types.ts.
import { spawnSync } from "node:child_process";
import { z } from "zod";
import type { McpServer } from "./contract.ts";
import {
  AGENTS,
  KiroConfigSchema,
  type AdapterCapabilities,
  type RunSpec as CoreRunSpec,
} from "../core/types.ts";
import { createDriver, defaultAdapters } from "../core/driver.ts";
import { createPricer } from "../core/pricing.ts";
import { capabilities as claudeCapabilities } from "../adapters/claude.ts";
import { OPENCODE_CAPABILITIES } from "../adapters/opencode.ts";
import { KIRO_CAPABILITIES } from "../adapters/kiro.ts";
import { CODEX_CAPABILITIES } from "../adapters/codex.ts";
import { GEMINI_CAPABILITIES } from "../adapters/gemini.ts";
import { PRIME_CAPABILITIES } from "../adapters/prime.ts";
import { NULL_CAPABILITIES } from "../adapters/null.ts";
import { checkCwd, filterExtraArgs, type GatewayConfig } from "../serve/gateway.ts";
import { runHermetic } from "../core/hermetic.ts";

/** One-line MCP warning for ancestor instruction files (#106). */
export function ancestorWarningLine(agent: string, files: readonly string[]): string {
  return `ancestor instructions: ${agent} loaded ${files.length} instruction file(s) from ancestor directories of cwd: ${files.join(", ")} — pass hermetic: true for an isolated run (#106)`;
}

// Shared with tools-jobs.ts (harness_run_async mirrors harness_run args).
export const RunArgsSchema = z.object({
  agent: z
    .string()
    .refine((v) => (AGENTS as readonly string[]).includes(v), {
      message: "unknown agent (expected one of: " + AGENTS.join(", ") + ")",
    }),
  prompt: z.string().min(1),
  model: z.string().optional(),
  cwd: z.string().optional(),
  budgetUsd: z.number().positive().optional(),
  maxTurns: z.number().int().positive().optional(),
  wallMs: z.number().positive().optional(),
  idleMs: z.number().positive().optional(),
  extraArgs: z.array(z.string()).optional(),
  kiro: KiroConfigSchema.optional(),
  /** #106: run in a hermetic temp copy of cwd (src/core/hermetic.ts). */
  hermetic: z.boolean().optional(),
});

/** JSON Schema for the `kiro` tool param — shared by harness_run and
 *  harness_run_async so the two tool contracts cannot drift. */
export const KIRO_INPUT_SCHEMA = {
  type: "object",
  description: "Kiro-specific run configuration (ignored by other agents)",
  additionalProperties: false,
  properties: {
    transport: {
      type: "string",
      enum: ["headless", "acp"],
      description: "Transport: headless CLI chat (default) or the ACP JSON-RPC protocol",
    },
    agent: { type: "string", description: "Native Kiro agent / ACP mode id" },
    engine: {
      type: "string",
      enum: ["v1", "v2", "v3"],
      description: "Agent engine version (default v2)",
    },
    effort: {
      type: "string",
      enum: ["low", "medium", "high", "xhigh", "max"],
      description: "Reasoning effort passed to the CLI",
    },
    tools: {
      description: "Tool trust policy; omit to leave the native agent config in charge",
      oneOf: [
        { type: "string", enum: ["all"], description: "Trust every tool" },
        { type: "string", enum: ["none"], description: "Trust no tool" },
        { type: "array", items: { type: "string" }, description: "Trust exactly these tool names" },
      ],
    },
    requireMcpStartup: {
      type: "boolean",
      description: "Fail the run unless every configured MCP server starts before the prompt",
    },
    mcpServers: {
      type: "array",
      description: "ACP only: MCP servers forwarded to session/new",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", description: "Server name reported to the agent" },
          command: { type: "string", description: "Executable launched for the server" },
          args: { type: "array", items: { type: "string" }, description: "Arguments passed to the command" },
          env: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "Environment variables layered over the server process env",
          },
        },
        required: ["name", "command"],
      },
    },
    startupMs: {
      type: "number",
      description: "Milliseconds allowed for CLI startup/handshake before failing (default 60000)",
    },
    requireModelAck: {
      type: "boolean",
      description: "ACP: fail before prompting if the model request is not acknowledged",
    },
  },
} as const;

// Mirrors each concrete adapter's own command resolution (e.g. kiro.ts reads
// $KIRO_CLI_BIN or 'kiro-cli'); the driver-registry wrappers returned by
// defaultAdapters() carry only name/launch, not capabilities. `command: null`
// (null adapter only, issue #55) means "no backing CLI binary at all" — the
// harness_agents handler below treats that as always-available rather than
// probing PATH for a binary that was never meant to exist.
function agentInfo(name: string): { command: string | null; capabilities?: AdapterCapabilities } {
  switch (name) {
    case "claude":
      return { command: "claude", capabilities: claudeCapabilities() };
    case "opencode":
      return { command: "opencode", capabilities: OPENCODE_CAPABILITIES };
    case "kiro":
      return { command: process.env.KIRO_CLI_BIN ?? "kiro-cli", capabilities: KIRO_CAPABILITIES };
    case "codex":
      return { command: "codex", capabilities: CODEX_CAPABILITIES };
    case "gemini":
      return { command: "gemini", capabilities: GEMINI_CAPABILITIES };
    case "prime":
      return { command: "prime-agent", capabilities: PRIME_CAPABILITIES };
    case "null":
      return { command: null, capabilities: NULL_CAPABILITIES };
    default:
      return { command: name };
  }
}

/** Build the driver RunSpec from validated harness_run args. extraArgsAllowed
 *  is the gateway-filtered allowlist (only used when the caller sent any). */
export function toRunSpec(
  a: z.infer<typeof RunArgsSchema>,
  extraArgsAllowed: string[],
): CoreRunSpec {
  const budget: CoreRunSpec["budget"] = {
    ...(a.budgetUsd !== undefined ? { usd: a.budgetUsd } : {}),
    ...(a.maxTurns !== undefined ? { maxTurns: a.maxTurns } : {}),
    ...(a.wallMs !== undefined ? { wallMs: a.wallMs } : {}),
    ...(a.idleMs !== undefined ? { idleMs: a.idleMs } : {}),
  };
  return {
    prompt: a.prompt,
    ...(a.model !== undefined ? { model: a.model } : {}),
    ...(a.cwd !== undefined ? { cwd: a.cwd } : {}),
    ...(budget.usd !== undefined ||
    budget.maxTurns !== undefined ||
    budget.wallMs !== undefined ||
    budget.idleMs !== undefined
      ? { budget }
      : {}),
    ...(a.extraArgs !== undefined ? { extraArgs: extraArgsAllowed } : {}),
    ...(a.kiro !== undefined ? { kiro: a.kiro } : {}),
  };
}

function isOnPath(command: string): boolean {
  return spawnSync("which", [command], { stdio: "ignore" }).status === 0;
}

/**
 * Is a built-in agent's backing CLI resolvable? The same probe
 * `harness_agents` reports; `ach trial --suite` (#51) uses it to skip
 * agents whose CLI is absent. `command: null` (null adapter) is always
 * available.
 */
export function agentCliAvailability(name: string): { command: string | null; available: boolean } {
  const { command } = agentInfo(name);
  return { command, available: command === null ? true : isOnPath(command) };
}

export function registerRunTools(
  server: McpServer,
  opts: { stateDir: string; gateway?: GatewayConfig },
): void {
  server.registerTool({
    name: "harness_run",
    description:
      "Run one harness agent (claude|opencode|kiro|codex|gemini|prime) with a prompt and optional model/cwd/budget/turn limits; resolves with the full RunResult (sessionId, events, tokens, totalCost, durationMs, exitStatus, warnings).",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", enum: [...AGENTS], description: "Agent to run" },
        prompt: { type: "string", description: "Prompt sent to the agent" },
        model: { type: "string", description: "Model override" },
        cwd: { type: "string", description: "Working directory for the agent subprocess" },
        budgetUsd: { type: "number", description: "Abort the run once cumulative cost exceeds this USD amount" },
        maxTurns: { type: "integer", description: "Abort the run after this many agent turns" },
        wallMs: { type: "number", description: "Abort the run if it exceeds this wall-clock duration in milliseconds from launch" },
        idleMs: { type: "number", description: "Abort the run if no agent events arrive for this many milliseconds" },
        extraArgs: { type: "array", items: { type: "string" }, description: "Extra CLI args appended verbatim" },
        kiro: KIRO_INPUT_SCHEMA,
        hermetic: {
          type: "boolean",
          description:
            "Run in a fresh temp copy of cwd whose ancestor directories hold no CLAUDE.md/AGENTS.md/GEMINI.md, then sync the edits (and deletions) back; fails if the temp root is not clean (#106)",
        },
      },
      required: ["agent", "prompt"],
    },
    handler: async (args) => {
      const parsed = RunArgsSchema.safeParse(args);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        if (!issue) throw new Error("invalid harness_run arguments");
        const field = issue.path.join(".") || "(root)";
        const received = field === "agent" ? ` (received '${String(args.agent)}')` : "";
        throw new Error(`invalid harness_run arguments: bad field '${field}': ${issue.message}${received}`);
      }
      const a = parsed.data;
      if (opts.gateway) {
        const cwdCheck = checkCwd(opts.gateway, a.cwd);
        if (!cwdCheck.ok) throw new Error(cwdCheck.error);
      }
      const extra = filterExtraArgs(opts.gateway, a.extraArgs);
      const spec = toRunSpec(a, extra.allowed);
      const strippedWarning =
        extra.stripped.length > 0
          ? `gateway: stripped extraArgs not in allowlist: ${extra.stripped.map((s) => `'${s}'`).join(", ")}`
          : undefined;
      const driver = createDriver({
        adapters: await defaultAdapters(),
        stateDir: opts.stateDir,
        registry: { stateDir: opts.stateDir },
        pricer: createPricer(),
      });
      // #106: hermetic runs copy cwd to a clean temp dir and sync back; the
      // temp path is harness-minted, so the gateway cwd check above (on the
      // caller's cwd) is the one that matters.
      const result =
        a.hermetic === true
          ? await runHermetic(driver, a.agent, spec, { stateDir: opts.stateDir })
          : await driver.run(a.agent, spec);
      const extraWarnings = [
        ...(result.ancestorInstructions !== undefined && result.ancestorInstructions.length > 0
          ? [ancestorWarningLine(a.agent, result.ancestorInstructions)]
          : []),
        ...(strippedWarning !== undefined ? [strippedWarning] : []),
      ];
      return extraWarnings.length === 0 ? result : { ...result, warnings: [...result.warnings, ...extraWarnings] };
    },
  });

  server.registerTool({
    name: "harness_agents",
    description:
      "List known harness agents with their backing CLI command, whether the binary is resolvable on PATH, and the adapter's capability flags.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const adapters = await defaultAdapters();
      return {
        agents: Object.keys(adapters).map((name) => {
          const info = agentInfo(name);
          return {
            name,
            ...agentCliAvailability(name),
            capabilities: info.capabilities,
          };
        }),
      };
    },
  });
}
