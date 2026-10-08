// Shared SandboxPolicy surface logic (#13): input validation, the per-agent
// dropped-field table, warning text and the redacted display form. Used by
// every surface that builds a TaskSpec sandbox: `ach run` flags
// (src/cli/run-sandbox.ts), `ach trial --matrix` plans (src/cli/trial-matrix.ts)
// and the MCP `harness_run` tool (src/mcp/tools-run.ts). Lives in core so cli
// and mcp both import it without a cli -> mcp cycle.
import { z } from "zod";
import type { SandboxPolicy } from "./types.ts";
import { SandboxPolicySchema } from "./types.ts";

export type PolicyField = "permissionMode" | "allowedTools" | "disallowedTools" | "mcpConfig";

/** The four fields a user can set from a plan or a tool call (scrubEnv is not exposed). */
export const SANDBOX_INPUT_FIELDS: readonly PolicyField[] = ["permissionMode", "allowedTools", "disallowedTools", "mcpConfig"];

/** Problems in a raw sandbox object, or the normalized policy. Never throws. */
export function checkSandboxInput(v: z.output<typeof SandboxShapeSchema>): { policy: SandboxPolicy } | { issues: string[] } {
  const issues: string[] = [];
  const policy: SandboxPolicy = {};
  if (v.permissionMode !== undefined) {
    const mode = v.permissionMode.trim();
    if (mode === "") issues.push("permissionMode needs a value");
    else policy.permissionMode = mode;
  }
  for (const key of ["allowedTools", "disallowedTools"] as const) {
    const list = v[key];
    if (list === undefined) continue;
    const items = list.map((s) => s.trim()).filter((s) => s !== "");
    if (items.length === 0) issues.push(`${key} needs at least one tool name`);
    else policy[key] = items;
  }
  if (v.mcpConfig !== undefined) {
    if (typeof v.mcpConfig === "string") {
      const raw = v.mcpConfig.trim();
      if (raw === "") issues.push("mcpConfig needs a file path or inline JSON");
      else if (raw.startsWith("{")) {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) issues.push("mcpConfig inline JSON must be an object");
          else policy.mcpConfig = parsed as Record<string, unknown>;
        } catch (err) {
          issues.push(`mcpConfig looks like inline JSON but does not parse: ${(err as Error).message}`);
        }
      } else policy.mcpConfig = raw;
    } else policy.mcpConfig = v.mcpConfig;
  }
  return issues.length > 0 ? { issues } : { policy };
}

const SandboxShapeSchema = SandboxPolicySchema.omit({ scrubEnv: true });

/**
 * Zod schema for a user-supplied sandbox object (plan file, MCP tool args):
 * SandboxPolicySchema minus scrubEnv (strict: unknown keys are rejected),
 * then normalized (trimmed, empty values rejected, a string mcpConfig that
 * starts with `{` parsed as inline JSON, as the CLI flag does). Output is a
 * SandboxPolicy.
 */
export const SandboxInputSchema = SandboxShapeSchema.transform((v, ctx): SandboxPolicy => {
  const r = checkSandboxInput(v);
  if ("issues" in r) {
    for (const message of r.issues) ctx.addIssue({ code: "custom", message });
    return z.NEVER;
  }
  return r.policy;
});

/**
 * Which CLI-exposed policy fields each launchable agent honors (read from the
 * adapters, see SandboxPolicy doc in src/core/types.ts):
 * claude, gemini + copilot all four (claudeSandboxArgs, geminiSandboxArgs); codex
 * permissionMode only (codexSandboxArgs); kiro allowedTools only, folded into
 * kiro.tools (applySandboxToKiroSpec); prime allowedTools only (primeSandboxArgs;
 * prime also warns for the rest itself through validateProfile, so it is
 * skipped here to avoid a duplicate line); opencode, kiro-ide, null and
 * custom/agents.d agents honor none of the four (only scrubEnv, which these
 * surfaces do not set).
 */
const HONORED: Record<string, readonly PolicyField[]> = {
  claude: ["permissionMode", "allowedTools", "disallowedTools", "mcpConfig"],
  gemini: ["permissionMode", "allowedTools", "disallowedTools", "mcpConfig"],
  codex: ["permissionMode"],
  kiro: ["allowedTools"],
  // copilotSandboxArgs maps all four; its own copilotUnsupportedSandbox warns
  // about permissionMode values it cannot express.
  copilot: ["permissionMode", "allowedTools", "disallowedTools", "mcpConfig"],
};

/** Policy fields set on `policy` that `agent` will silently drop. */
export function sandboxDroppedFields(agent: string, policy: SandboxPolicy, opts: { kiroToolsSet?: boolean } = {}): PolicyField[] {
  // prime and cursor: the adapter's own validateProfile warns (cursor honours
  // permissionMode only; cursorUnsupportedSandbox names each dropped field).
  if (agent === "prime" || agent === "cursor") return [];
  const honored = new Set<PolicyField>(HONORED[agent] ?? []);
  if (agent === "kiro" && opts.kiroToolsSet) honored.delete("allowedTools"); // native --kiro-tools wins
  const set: PolicyField[] = [];
  if (policy.permissionMode !== undefined) set.push("permissionMode");
  if (policy.allowedTools?.length) set.push("allowedTools");
  if (policy.disallowedTools?.length) set.push("disallowedTools");
  if (policy.mcpConfig !== undefined) set.push("mcpConfig");
  return set.filter((f) => !honored.has(f));
}

function flagFor(f: PolicyField): string {
  return f === "permissionMode" ? "permission-mode" : f === "allowedTools" ? "allowed-tools" : f === "disallowedTools" ? "disallowed-tools" : "mcp-config";
}

/**
 * One warning per dropped field, naming the field and the agent. style "flag"
 * (default, `ach run`) names the CLI flag; style "field" (matrix plans, MCP)
 * names the `sandbox.<field>` key.
 */
export function sandboxDropWarnings(
  agent: string,
  policy: SandboxPolicy,
  opts: { kiroToolsSet?: boolean; style?: "flag" | "field" } = {},
): string[] {
  return sandboxDroppedFields(agent, policy, opts).map((f) =>
    opts.style === "field"
      ? `sandbox.${f} is not supported by agent '${agent}' and was dropped (it has no effect; use extraArgs for the agent's native flag)`
      : `--${flagFor(f)} is not supported by agent '${agent}' and was dropped (sandbox.${f} has no effect; use --extra-arg for the agent's native flag)`,
  );
}

/**
 * Display/commit-safe form of a policy: inline MCP JSON may carry tokens in
 * server env/headers, so it is replaced by a size marker; a path stays.
 */
export function describeSandbox(policy: SandboxPolicy): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (policy.permissionMode !== undefined) out.permissionMode = policy.permissionMode;
  if (policy.allowedTools !== undefined) out.allowedTools = policy.allowedTools;
  if (policy.disallowedTools !== undefined) out.disallowedTools = policy.disallowedTools;
  if (policy.mcpConfig !== undefined) {
    out.mcpConfig = typeof policy.mcpConfig === "string" ? policy.mcpConfig : `<inline JSON, ${JSON.stringify(policy.mcpConfig).length} bytes>`;
  }
  if (policy.scrubEnv !== undefined) out.scrubEnv = policy.scrubEnv;
  return out;
}

/** Run-header line, e.g. `[sandbox] permissionMode=bypassPermissions allowedTools=Bash,Read`. */
export function formatSandboxHeader(policy: SandboxPolicy): string {
  const d = describeSandbox(policy);
  const parts = Object.entries(d).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : String(v)}`);
  return `[sandbox] ${parts.join(" ")}`;
}

/** Field-wise merge: keys set on `over` replace those on `base`. Undefined when both are. */
export function mergeSandbox(base: SandboxPolicy | undefined, over: SandboxPolicy | undefined): SandboxPolicy | undefined {
  if (base === undefined) return over;
  if (over === undefined) return base;
  return { ...base, ...over };
}
