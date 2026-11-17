// Desk tools on `ach mcp` (#204): desk_roster, desk_send, desk_inbox, lane_new,
// lane_status, lane_stop, lane_approve, decision_open, decision_list, decision_close.
// Identity comes from $ACH_DESK_NAME (+ $ACH_DESK_STACK), never from arguments.
// Filled by the CLI/MCP seat; registered for every transport by register-tools.ts.
import type { McpServer } from "./contract.ts";

export function registerDeskTools(_server: McpServer, _opts: { stateDir: string }): void {
  // Registered only when this process is a desk/lane session (ACH_DESK_NAME set) or ACH_DESK_TOOLS=1.
}
