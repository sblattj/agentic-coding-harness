// harness MCP preflight tools: harness_kiro_preflight — prove a Kiro run's
// configuration (binary, auth, native agent, model + set_model ack, MCP
// notices, extraArgs allowlist) WITHOUT sending a prompt, i.e. without
// spending a token. Contract: src/adapters/kiro-preflight.ts.
import { z } from "zod";
import type { McpServer } from "./contract.ts";
import { KiroConfigSchema } from "../core/types.ts";
import { kiroPreflight } from "../adapters/kiro-preflight.ts";
import { KIRO_INPUT_SCHEMA } from "./tools-run.ts";
import { checkCwd, filterExtraArgs, type GatewayConfig } from "../serve/gateway.ts";

export const PreflightArgsSchema = z.object({
  cwd: z.string().optional(),
  model: z.string().optional(),
  kiro: KiroConfigSchema.optional(),
  extraArgs: z.array(z.string()).optional(),
});

export function registerPreflightTools(
  server: McpServer,
  opts: { gateway?: GatewayConfig } = {},
): void {
  server.registerTool({
    name: "harness_kiro_preflight",
    description:
      "Preflight a Kiro run: verify the kiro-cli binary, auth, the native agent, that the model is offered and that session/set_model is acknowledged, plus MCP startup notices — over a real ACP handshake that sends NO prompt (no tokens spent). Returns a receipt of verified/failed/unproven checks.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Working directory for the kiro-cli subprocess" },
        model: { type: "string", description: "Model whose availability and set_model ack to verify" },
        kiro: KIRO_INPUT_SCHEMA,
        extraArgs: { type: "array", items: { type: "string" }, description: "Extra CLI args appended verbatim" },
      },
    },
    handler: async (args) => {
      const parsed = PreflightArgsSchema.safeParse(args);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        if (!issue) throw new Error("invalid harness_kiro_preflight arguments");
        throw new Error(
          `invalid harness_kiro_preflight arguments: bad field '${issue.path.join(".") || "(root)"}': ${issue.message}`,
        );
      }
      const a = parsed.data;
      // Same containment as harness_run (tools-run.ts): cwd must resolve under
      // the gateway root, and extraArgs are filtered to the allowlist.
      if (opts.gateway) {
        const cwdCheck = checkCwd(opts.gateway, a.cwd);
        if (!cwdCheck.ok) throw new Error(cwdCheck.error);
      }
      const extra = filterExtraArgs(opts.gateway, a.extraArgs);
      const result = await kiroPreflight({
        cwd: a.cwd ?? process.cwd(),
        ...(a.model !== undefined ? { model: a.model } : {}),
        ...(a.kiro !== undefined ? { kiro: a.kiro } : {}),
        ...(a.extraArgs !== undefined ? { extraArgs: extra.allowed } : {}),
        ...(opts.gateway?.enabled ? { gatewayAllowExtraArgs: opts.gateway.allowExtraArgs } : {}),
      });
      if (extra.stripped.length === 0) return result;
      return {
        ...result,
        warnings: [
          `gateway: stripped extraArgs not in allowlist: ${extra.stripped.map((s) => `'${s}'`).join(", ")}`,
        ],
      };
    },
  });
}
