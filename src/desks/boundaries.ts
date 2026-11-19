// Desk role boundaries: a pure classifier the host runs on every engine `tool`
// event. When a desk acts outside its role (roles/common.md "Division of
// labor"), the host records one `boundary` warning event. Nothing is blocked.
//
// Rules (built-in roles only; lanes and custom roles get no warnings):
//   decisions-does-work     DECISIONS calls a work tool (edit/write/shell style) or lane_new
//   listener-does-work      LISTENER calls a work tool (edit/write/shell style) or lane_new
//   orchestrator-asks-human ORCHESTRATOR calls decision_open, or desk_send with `"to": "human"`
import type { DeskKind } from "./types.ts";

/** The heading every built-in role file opens with (right after its `# Role:` title). */
export const ROLE_BLOCK_HEADING = "## Your role, and only this";
/** The roles/common.md section that states the division of labor. */
export const DIVISION_HEADING = "## Division of labor";

export type BoundaryRule = "decisions-does-work" | "listener-does-work" | "orchestrator-asks-human";

/** Payload of a `boundary` HostEvent. */
export interface BoundaryWarning {
  rule: BoundaryRule;
  detail: string;
  tool?: string;
}

/**
 * Tools that change files or run commands, by base name (lowercased, after any
 * `mcp__<server>__` prefix), across the engines desks run on: opencode (bash,
 * edit, write, patch, multiedit), Claude Code (Bash, Edit, Write, MultiEdit,
 * NotebookEdit), Codex (shell, local_shell, exec_command, apply_patch) and
 * Gemini (run_shell_command, write_file, replace). Read-only tools (read, grep,
 * webfetch, MCP search tools) are not work tools: LISTENER may use them.
 */
export const WORK_TOOLS: ReadonlySet<string> = new Set([
  "bash",
  "shell",
  "local_shell",
  "shell_command",
  "exec_command",
  "run_shell_command",
  "edit",
  "multiedit",
  "write",
  "patch",
  "apply_patch",
  "notebookedit",
  "notebook_edit",
  "str_replace_editor",
  "str_replace_based_edit_tool",
  "replace",
  "write_file",
  "edit_file",
  "create_file",
]);

/** Lowercased tool name without a Claude-style `mcp__<server>__` prefix. */
export function toolBaseName(tool: string): string {
  const t = tool.trim().toLowerCase();
  if (t.startsWith("mcp__")) {
    const i = t.lastIndexOf("__");
    return t.slice(i + 2);
  }
  return t;
}

/**
 * True when `tool` is the `ach mcp` desk tool `name`, however the engine
 * prefixes MCP tools: `desk_send`, `desks_desk_send` (opencode `<server>_<tool>`),
 * `mcp__desks__desk_send` (Claude Code).
 */
export function isDeskTool(tool: string, name: string): boolean {
  const b = toolBaseName(tool);
  return b === name || b.endsWith(`_${name}`);
}

export function isWorkTool(tool: string): boolean {
  return WORK_TOOLS.has(toolBaseName(tool));
}

/**
 * The top-level `to` string of a (possibly clipped) JSON object summary, or null.
 * Walks the tokens instead of matching a regex, so a `"to": "human"` quoted inside
 * another value (the message text, a nested object) never counts as the recipient.
 */
export function summaryRecipient(summary: string): string | null {
  const s = summary.trimStart();
  if (!s.startsWith("{")) return null;
  let i = 0;
  let depth = 0;
  let state: "key" | "colon" | "value" | "comma" = "key";
  let key = "";
  const readString = (): string | null => {
    let out = "";
    i++;
    while (i < s.length) {
      const c = s[i];
      if (c === "\\") { out += s[i + 1] ?? ""; i += 2; continue; }
      if (c === '"') { i++; return out; }
      out += c;
      i++;
    }
    return null; // clipped inside a string
  };
  while (i < s.length) {
    const c = s.charAt(i);
    if (c === '"') {
      const top = depth === 1;
      const str = readString();
      if (str === null) return null;
      if (!top) continue;
      if (state === "key") { key = str; state = "colon"; }
      else if (state === "value") { if (key === "to") return str; state = "comma"; }
      continue;
    }
    if (c === "{" || c === "[") { depth++; i++; continue; }
    if (c === "}" || c === "]") { depth--; if (depth === 1) state = "comma"; if (depth <= 0) return null; i++; continue; }
    if (depth === 1 && c === ":" && state === "colon") state = "value";
    else if (depth === 1 && c === ",") state = "key";
    else if (depth === 1 && state === "value" && !/\s/.test(c)) state = "comma"; // number, true, null...
    i++;
  }
  return null;
}

/**
 * The boundary warning for one tool call by a desk, or null when the call is
 * inside the desk's role. `desk.role` is the layout role name (spec.role); a
 * lane (`kind: "lane"`) is never classified.
 */
export function boundaryForTool(desk: { kind: DeskKind; role: string }, tool: string, summary = ""): BoundaryWarning | null {
  if (desk.kind !== "desk") return null;
  const role = desk.role.trim().toLowerCase();
  if (role === "decisions" || role === "listener") {
    const who = role.toUpperCase();
    const rule: BoundaryRule = role === "decisions" ? "decisions-does-work" : "listener-does-work";
    const sendTo = role === "decisions" ? "work goes to ORCHESTRATOR" : "LISTENER is read-only; work goes to ORCHESTRATOR";
    if (isWorkTool(tool)) return { rule, tool, detail: `${who} called the work tool ${tool}: ${sendTo}` };
    if (isDeskTool(tool, "lane_new")) return { rule, tool, detail: `${who} launched a lane with ${tool}: ${sendTo}` };
    return null;
  }
  if (role === "orchestrator") {
    if (isDeskTool(tool, "decision_open")) {
      return { rule: "orchestrator-asks-human", tool, detail: `ORCHESTRATOR opened a question for the human with ${tool}: forward the call to DECISIONS (open: <call> | context | asked by)` };
    }
    if (isDeskTool(tool, "desk_send") && summaryRecipient(summary)?.trim().toLowerCase() === "human") {
      return { rule: "orchestrator-asks-human", tool, detail: `ORCHESTRATOR addressed the human with ${tool}: forward the call to DECISIONS (open: <call> | context | asked by)` };
    }
  }
  return null;
}
