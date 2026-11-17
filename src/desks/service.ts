// Stack service (#204): the ONE API the CLI (src/cli/desk.ts), the MCP desk
// tools (src/mcp/tools-desks.ts) and the Web API (src/web/desks-api.ts) call.
// Signatures are frozen by the orchestrator (wave 0); bodies are filled by the
// service seat. Every function takes an optional `stack` (default: the active
// stack, see resolveStack) and `stateDir` (default: core/store.ts stateDir()).

import type {
  DeskCostRow,
  DeskMessage,
  Decision,
  DecisionOption,
  HostEvent,
  LaneRequest,
  PendingLane,
  RosterEntry,
  RosterView,
  Sender,
  TerminalKind,
} from "./types.ts";

export interface StackOpts {
  stack?: string;
  stateDir?: string;
}

export interface UpOpts extends StackOpts {
  /** desks.yaml path; default: ./desks.yaml, else ~/.config/ach/desks.yaml, else the built-in default layout. */
  layoutFile?: string;
  /** Override layout.portBase (test stacks run beside the live one). */
  portBase?: number;
  term?: TerminalKind;
  /** tmux: session that gets the `desks` window and one window per lane. */
  tmuxSession?: string;
  /** tmux: `-L <socket>` server name (tests use a private server). */
  tmuxSocket?: string;
}

const NI = (fn: string): never => {
  throw new Error(`desks: ${fn} not implemented yet`);
};

/** Start every desk in the layout. Refuses when any desk of the stack is alive. */
export async function deskUp(_o: UpOpts = {}): Promise<RosterView> {
  return NI("deskUp");
}

/** Stop every lane, then every desk (feed, pane, host). Leaves an empty roster and no processes. */
export async function deskDown(_o: StackOpts = {}): Promise<{ stopped: string[] }> {
  return NI("deskDown");
}

/** Close every pane of the stack and reopen the layout on `term` (sessions unchanged). */
export async function deskAttach(_o: StackOpts & { term?: TerminalKind; tmuxSession?: string; tmuxSocket?: string } = {}): Promise<RosterView> {
  return NI("deskAttach");
}

/** Fire-and-forget delivery. Refuses self-send and unknown/dead targets (error lists known names). */
export async function deskSend(_o: StackOpts & { from: Sender; to: string; text: string }): Promise<DeskMessage> {
  return NI("deskSend");
}

/** Live roster; prunes dead entries when prune is true (default true). */
export async function deskRoster(_o: StackOpts & { me?: string; prune?: boolean } = {}): Promise<RosterView> {
  return NI("deskRoster");
}

/** Recent messages to or from `name` (all when omitted), newest last. */
export async function deskInbox(_o: StackOpts & { name?: string; limit?: number; sinceMs?: number } = {}): Promise<DeskMessage[]> {
  return NI("deskInbox");
}

/** Host events of one desk/lane. */
export async function deskEvents(_o: StackOpts & { name: string; since?: number }): Promise<HostEvent[]> {
  return NI("deskEvents");
}

/** Restart one desk on another engine/agent; keeps its roster slot, message history and decisions. */
export async function deskSwitchEngine(_o: StackOpts & { name: string; agent: string; model?: string }): Promise<RosterEntry> {
  return NI("deskSwitchEngine");
}

/** Start a lane; with lanes.approval="decisions" and a desk launcher (not DECISIONS, not human) returns {pending}. */
export async function laneNew(_o: StackOpts & LaneRequest): Promise<RosterEntry | { pending: PendingLane }> {
  return NI("laneNew");
}

export async function laneApprove(_o: StackOpts & { id: string; by: Sender }): Promise<RosterEntry> {
  return NI("laneApprove");
}

export async function laneReject(_o: StackOpts & { id: string; by: Sender; reason?: string }): Promise<PendingLane> {
  return NI("laneReject");
}

/** Refuses desk names. Closes the pane, stops the host, appends to lanes.log, removes from the roster. */
export async function laneStop(_o: StackOpts & { name: string; by?: Sender }): Promise<{ stopped: string }> {
  return NI("laneStop");
}

export async function laneStatus(_o: StackOpts & { name?: string } = {}): Promise<RosterView["rows"]> {
  return NI("laneStatus");
}

export async function decisionOpen(
  _o: StackOpts & { question: string; options: DecisionOption[]; askedBy: Sender; openedBy: Sender },
): Promise<Decision> {
  return NI("decisionOpen");
}

/** Records the answer and delivers it (from the answerer) to askedBy and, when different, to DECISIONS. */
export async function decisionAnswer(_o: StackOpts & { id: string; text: string; by: Sender }): Promise<Decision> {
  return NI("decisionAnswer");
}

export async function decisionClose(_o: StackOpts & { id: string; by: Sender; reason?: string }): Promise<Decision> {
  return NI("decisionClose");
}

export async function decisionList(_o: StackOpts & { state?: Decision["state"] } = {}): Promise<Decision[]> {
  return NI("decisionList");
}

/** Cost per desk and per lane tree, from the run registry. */
export async function deskCosts(_o: StackOpts = {}): Promise<DeskCostRow[]> {
  return NI("deskCosts");
}

/** The stack name to use: explicit, else $ACH_DESK_STACK, else <stateDir>/desks/active-stack, else "default". */
export function resolveStack(_o: StackOpts = {}): string {
  return NI("resolveStack");
}
