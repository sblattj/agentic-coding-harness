// Desks and lanes contract (#204, #205). ALL desk seats code against THIS file.
// Change it only through the orchestrator: every other src/desks/* module,
// src/cli/desk.ts, src/mcp/tools-desks.ts, src/web/desks*.ts and the macOS
// app (apps/ach-desk) depend on these shapes.
//
// Architecture (one paragraph):
// Every desk and every lane is ONE detached "desk host" process
// (`ach desk host --spec <file>`, src/desks/host.ts) listening on
// 127.0.0.1:<port>. The host owns the agent engine (src/desks/engines/*),
// the optional feed (src/desks/feeds.ts), the message queue, the run's
// registry record + token records, and an append-only event log. Everything
// else (CLI, the `ach mcp` desk tools, `ach web`, the macOS app) talks to
// hosts ONLY through the Host HTTP API below and to the stack through
// src/desks/service.ts. The roster file is the single source of truth for
// who is alive and where.

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

/** Bumped on any breaking change to the Host API, the Web API, or the files below. */
export const DESKS_API_VERSION = "desks-api/1" as const;

/** A desk or lane host on port P runs its opencode engine (`opencode serve`) on P + ENGINE_PORT_OFFSET. */
export const ENGINE_PORT_OFFSET = 500;

// ---------------------------------------------------------------------------
// Layout (desks.yaml)
// ---------------------------------------------------------------------------

/** Where a desk's pane goes in the desks window. */
export type PaneSlot = "left" | "right-top" | "right-bottom" | "none";

/** A JSONL event source whose events become messages to its desk (section 7 of the guide). */
export interface FeedSpec {
  /** argv; stdout is JSONL, one event object per line, each with a string `type`. */
  command: string[];
  /** argv printing the full context so far (plain text); sent as ONE message on the first heartbeat when active. */
  fullContext?: string[];
  /** argv printing JSON with a boolean `active`; checked on the first heartbeat. */
  activeCheck?: string[];
  /** Batch window for non-immediate events. Default 10. */
  batchSeconds?: number;
  /** Event types that flush the batch and are delivered at once. */
  immediate?: string[];
  /** Event type that marks "backlog is over" (default "alive"). */
  heartbeatType?: string;
  /** Event type that ends a session of the source (default "call_ended"); triggers the closing message. */
  endType?: string;
}

/** An MCP server definition (Claude-style), used when the engine cannot read the user's own config by name. */
export interface McpServerDef {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface DeskSpec {
  /** Upper-case identifier, unique across the stack: /^[A-Z][A-Z0-9_-]{0,31}$/ */
  name: string;
  /** Role prompt name: resolves to <rolesDir>/<role>.md (user dir first, then the built-in roles/). */
  role: string;
  /** Agent CLI: "opencode" | "claude" | "codex" | "gemini" | ... (an ach adapter id). Default: layout.agent, else "opencode". */
  agent?: string;
  /** Engine model id, e.g. "ferry/super-flash" (opencode provider/model) or "claude-sonnet-5-5". Default: layout.model. */
  model?: string;
  /** MCP server NAMES this desk gets (the `ach` desk tools are always added). */
  mcps: string[];
  pane?: PaneSlot;
  feed?: FeedSpec;
  /** Working directory. Default: layout.cwd, else the dir `desk up` ran in. */
  cwd?: string;
}

export interface LanesSpec {
  /** MCP names a lane gets when lane_new passes none. */
  defaultMcps: string[];
  /** Port OFFSETS from portBase, inclusive: [10, 99]. */
  ports: [number, number];
  /** "decisions": lane_new from a desk other than DECISIONS/human waits for DECISIONS' approval. */
  approval?: "decisions" | "none";
  /** Prefixed to every lane objective, e.g. "--max-minutes 45". */
  defaultGoalFlags?: string;
  agent?: string;
  model?: string;
  /** Default per-lane budget (USD); feeds the existing budget alerts. */
  budgetUsd?: number;
}

export interface Layout {
  /** Desk i listens on portBase + 1 + i; lanes on portBase + lanes.ports[0..1]. Default 4800. */
  portBase: number;
  /** Stack id: names the state subdir. Default "default" when portBase is 4800, else "p<portBase>". */
  stack?: string;
  agent?: string;
  model?: string;
  cwd?: string;
  /** Extra roles directory searched before the built-in roles/. */
  rolesDir?: string;
  /** Definitions for MCP names, for engines that need them (driver engine). opencode resolves names from its own config. */
  mcpServers?: Record<string, McpServerDef>;
  desks: DeskSpec[];
  lanes: LanesSpec;
}

// ---------------------------------------------------------------------------
// Files under <stateDir>/desks/<stack>/   (see deskPaths in src/desks/roster.ts)
//   roster.json        Roster (atomic rewrite under a mkdir lock)
//   roster.lock/       the lock dir
//   messages.jsonl     DeskMessage per line
//   decisions.jsonl    DecisionEvent per line (open/answer/close), folded by readDecisions
//   pending-lanes.jsonl PendingLane per line (request/approve/reject)
//   specs/<name>.json  HostSpec handed to `ach desk host`
//   events/<runId>.jsonl HostEvent per line (the run's desk transcript)
//   logs/<name>.log    host stdout/stderr
//   layout.json        the resolved Layout `desk up` used
// ---------------------------------------------------------------------------

export type DeskKind = "desk" | "lane";
export type EngineKind = "opencode" | "driver";
export type TerminalKind = "tmux" | "ghostty" | "none";

export interface TerminalRef {
  kind: TerminalKind;
  /** tmux pane id ("%15") or ghostty terminal id; "" for none. */
  id: string;
  /**
   * tmux: the ownership token the driver put in the pane's @ach_run option when it opened it. close/alive/respawn
   * act only while the pane at `id` still carries this token (pane ids restart from %0 with every tmux server).
   * A tmux ref without one (written before tokens existed) is treated as not ours. Unused for ghostty.
   */
  token?: string;
}

export interface RosterEntry {
  name: string;
  kind: DeskKind;
  role: string;
  agent: string;
  engine: EngineKind;
  model?: string;
  mcps: string[];
  /** Host port and URL (http://127.0.0.1:<port>). */
  port: number;
  url: string;
  /** Host process pid. */
  pid: number;
  /** ach run id of this desk/lane (registry record <stateDir>/runs/<runId>.json). */
  runId: string;
  /** Lanes: runId of the desk that launched it. */
  parentRunId?: string;
  sessionId?: string;
  /** opencode engine: the opencode serve URL (attach target). */
  engineUrl?: string;
  cwd: string;
  startedAt: number;
  /** Lanes: first 400 chars of the objective. */
  goal?: string;
  /** Desks: the layout slot (DeskSpec.pane) when the layout sets one; lanes have none. */
  pane?: PaneSlot;
  /** Lanes: desk name (or "human") that launched it. */
  launchedBy?: string;
  feedPid?: number;
  terminal?: TerminalRef;
  budgetUsd?: number;
}

export interface Roster {
  version: typeof DESKS_API_VERSION;
  stack: string;
  portBase: number;
  layoutFile?: string;
  entries: Record<string, RosterEntry>;
  /** Lane names a laneNew/laneApprove holds while its host starts (keyed by name). Readers of `entries` ignore it. */
  starting?: Record<string, LaneReservation>;
}

/** A name held under the roster lock between the "taken" check and putEntry; stale after LANE_RESERVE_MS or when pid is gone. */
export interface LaneReservation {
  token: string;
  pid: number;
  at: number;
}

/** Who sent a message. "human" = typed by the user (CLI, web, app, or the pane itself). */
export type Sender = string; // a desk/lane name or "human"

export interface DeskMessage {
  id: string;
  from: Sender;
  to: string;
  text: string;
  at: number;
  /** "now": the target was idle and started a turn; "queued": it was busy. */
  delivered: "now" | "queued";
}

/** Header prepended to every peer message as delivered to the target engine. Human messages get none. */
export function peerHeader(from: Sender): string {
  return from === "human" ? "" : `[desk-msg from ${from}] `;
}

// --- Decisions (DECISIONS desk's queue of asks for the human; #205 cards) ---

export interface DecisionOption {
  label: string;
  /** Recommended options come first and carry a reason. */
  recommended?: boolean;
  reason?: string;
}

export interface Decision {
  id: string; // "D1", "D2", ... per stack
  question: string;
  options: DecisionOption[];
  /** Desk/lane that needs the answer (it receives the answer as a message). */
  askedBy: Sender;
  openedBy: Sender; // normally DECISIONS
  openedAt: number;
  state: "open" | "answered" | "closed";
  answer?: { text: string; by: Sender; at: number };
}

export type DecisionEvent =
  | { type: "open"; decision: Omit<Decision, "state" | "answer"> }
  | { type: "answer"; id: string; text: string; by: Sender; at: number }
  | { type: "close"; id: string; by: Sender; at: number; reason?: string };

// --- Pending lanes (approval: decisions) ---

export interface LaneRequest {
  name: string;
  goal: string;
  mcps?: string[];
  cwd?: string;
  agent?: string;
  model?: string;
  budgetUsd?: number;
  /** Silent context the lane sees before its goal (HostSpec.brief). */
  brief?: string;
  launchedBy: Sender;
}

export interface PendingLane {
  id: string; // "L1", ...
  request: LaneRequest;
  requestedAt: number;
  state: "pending" | "approving" | "approved" | "rejected"; // "approving": a laneApprove is starting it (decidedAt = when)
  decidedBy?: Sender;
  decidedAt?: number;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Host process: spec, events, HTTP API
// ---------------------------------------------------------------------------

/** Written to specs/<name>.json by service.ts, read by `ach desk host --spec <file>`. */
export interface HostSpec {
  stack: string;
  stateDir: string;
  name: string;
  kind: DeskKind;
  role: string;
  /** Absolute paths of the prompt files, in order: roles/common.md, roles/<role>.md. */
  roleFiles: string[];
  agent: string;
  engine: EngineKind;
  model?: string;
  mcps: string[];
  /** Resolved definitions for `mcps` when the engine needs them (driver engine). */
  mcpServers?: Record<string, McpServerDef>;
  port: number;
  /** opencode engine: port for `opencode serve` (port + ENGINE_PORT_OFFSET). */
  enginePort?: number;
  cwd: string;
  runId: string;
  parentRunId?: string;
  launchedBy?: Sender;
  /** Lanes: the silent brief, then the objective handed to setGoal. */
  brief?: string;
  goal?: string;
  feed?: FeedSpec;
  budgetUsd?: number;
  /**
   * `desk reload`: the agent session the engine should continue instead of starting a new one
   * (opencode: the session id on the shared opencode database; driver: the adapter's resume id).
   * An engine that cannot continue it starts fresh, and the reload result says so (resumed false).
   */
  resumeSessionId?: string;
  /**
   * Bearer token for the Host HTTP API (32 random bytes, hex), set by service.ts startHost.
   * Lives only in this spec file (mode 0600); never copied to the roster or any API answer.
   * A host whose spec has none refuses every route but GET /health.
   */
  token?: string;
}

export type HostState = "starting" | "idle" | "busy" | "stopping" | "error";

export type HostEventType =
  | "message_in" // a message delivered to this desk {message}
  | "message_out" // a message this desk sent {message}
  | "turn_start"
  | "turn_end"
  | "text" // assistant text {text}
  | "tool" // tool call {tool, summary}
  | "usage" // {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd}
  | "status" // {state: HostState}
  | "goal" // {goal: GoalStatus}
  | "feed" // feed lifecycle {note}
  | "boundary" // a desk acted outside its role (src/desks/boundaries.ts) {rule, detail, tool?}; a warning, nothing is blocked
  | "error"; // {error}

export interface HostEvent {
  seq: number; // 1-based, per host
  at: number;
  runId: string;
  name: string;
  type: HostEventType;
  data: Record<string, unknown>;
}

export interface GoalStatus {
  objective: string;
  state: "none" | "active" | "achieved" | "blocked" | "stopped";
  source: "opencode-plugin" | "ach-loop";
  evidence?: string;
  reason?: string;
  plan?: { verified: number; total: number };
  updatedAt: number;
}

export interface HostHealth {
  version: typeof DESKS_API_VERSION;
  name: string;
  kind: DeskKind;
  engine: EngineKind;
  agent: string;
  runId: string;
  sessionId?: string;
  engineUrl?: string;
  pid: number;
  state: HostState;
  queueDepth: number;
  goal?: GoalStatus;
  feedPid?: number;
  lastSeq: number;
}

/**
 * Host HTTP API (JSON bodies, 127.0.0.1 only). Every route but GET /health needs
 * `authorization: Bearer <HostSpec.token>` (else 401); every route refuses a Host header
 * other than 127.0.0.1:<port> or localhost:<port> (421) and an Origin other than
 * http://127.0.0.1:<port> or http://localhost:<port> (403); POSTs must be
 * application/json (415).
 *   GET  /health                     -> HostHealth
 *   POST /send   {from, text}         -> {id, delivered}   queues when busy; never blocks on the turn
 *   POST /note   {text}               -> {}                silent context, no turn
 *   POST /record {type, data}         -> {seq}             append an out-of-band event (message_out)
 *   GET  /goal                        -> GoalStatus
 *   POST /goal   {objective}          -> {}                returns once the goal is confirmed active (<= 40 s) or errors
 *   GET  /mcp                         -> Record<string, string>  engine-reported MCP status by name
 *   GET  /events?since=<seq>          -> {events: HostEvent[]}; with `Accept: text/event-stream`: SSE, one HostEvent per `data:`
 *   GET  /attach                      -> {argv: string[]}  what a terminal pane runs to show this session
 *   POST /stop                        -> {}                stops feed + engine, then the process exits
 */
export const HOST_ROUTES = ["/health", "/send", "/note", "/record", "/goal", "/mcp", "/events", "/attach", "/stop"] as const;

// ---------------------------------------------------------------------------
// Engine (inside the host)
// ---------------------------------------------------------------------------

export type EngineEvent = Omit<HostEvent, "seq" | "at" | "runId" | "name">;

export interface Engine {
  readonly kind: EngineKind;
  /** Start the agent session. Resolves when the session exists and can take a turn. */
  start(spec: HostSpec): Promise<{ sessionId?: string; engineUrl?: string; childPid?: number }>;
  /** Start a turn with `text` (already header-prefixed). Resolves once accepted, NOT when the turn ends. Caller guarantees idle. */
  send(text: string): Promise<void>;
  /** Add context without starting a turn. */
  note(text: string): Promise<void>;
  /** Engine-truth busy/idle. */
  state(): Promise<"busy" | "idle">;
  /** Begin pursuing `objective`; resolves once the goal is active. */
  setGoal(objective: string): Promise<void>;
  goalStatus(): Promise<GoalStatus>;
  mcpStatus(): Promise<Record<string, string>>;
  attachCommand(): string[];
  /** Normalized events: turn_start/turn_end/text/tool/usage/error. */
  onEvent(cb: (e: EngineEvent) => void): void;
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Terminal drivers (src/desks/term/*)
// ---------------------------------------------------------------------------

export type OpenMode = "window" | "right" | "down" | "tab";

export interface OpenRequest {
  mode: OpenMode;
  name: string;
  cwd: string;
  argv: string[];
  /** Pane id to split (right/down) or whose window/session a tab joins. */
  of?: string;
}

export interface TerminalDriver {
  readonly kind: Exclude<TerminalKind, "none">;
  /** Opens without stealing focus; returns the pane/terminal id. */
  open(req: OpenRequest): Promise<string>;
  /** Ownership token of a pane this driver instance opened (store it as TerminalRef.token); undefined when the driver has none. */
  tokenOf?(id: string): string | undefined;
  /** With `token`, acts only while the pane still carries that token. */
  close(id: string, token?: string): Promise<void>;
  /** With `token`, true only while the pane exists and still carries that token. */
  alive(id: string, token?: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Service views (src/desks/service.ts), shared by CLI --json, MCP, Web API, the app
// ---------------------------------------------------------------------------

export interface RosterRow extends RosterEntry {
  /** "stopped": a lane that ended (read from lanes.log by laneStatus <name>), no longer in the roster. */
  state: HostState | "dead" | "stopped";
  queueDepth: number;
  goalStatus?: GoalStatus;
  /** Stopped lanes: the final goal state recorded at stop (from the lane's last goal event), or "dead"/"none". */
  goalState?: GoalStatus["state"] | "dead";
  /** Cost of this run; for desks also the sum over its lane tree. */
  costUsd: number | null;
  treeCostUsd: number | null;
}

export interface RosterView {
  version: typeof DESKS_API_VERSION;
  stack: string;
  portBase: number;
  me?: string;
  /** Set by deskUp when the stack is up but its panes could not be opened (see `ach desk attach`). */
  note?: string;
  rows: RosterRow[];
  pendingLanes: PendingLane[];
  openDecisions: Decision[];
}

export interface DeskCostRow {
  name: string;
  kind: DeskKind;
  runId: string;
  parentRunId?: string;
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  /** Token records the host could not write (present only when > 0): the totals undercount. */
  tokenRecordFailures?: number;
  lanes: DeskCostRow[];
}

/**
 * Web API on `ach web` (JSON; SSE where noted). Stable contract for front ends (the macOS app).
 *   GET  /api/desks                         -> RosterView
 *   GET  /api/desks/messages?since=<ms>     -> {messages: DeskMessage[]}
 *   GET  /api/desks/stream                  -> SSE: {kind:"message", message} | {kind:"roster", view} | {kind:"event", event: HostEvent} | {kind:"decision", decision}
 *   GET  /api/desks/decisions               -> {decisions: Decision[]}
 *   POST /api/desks/decisions/:id/answer {text} -> Decision   (delivers the answer to askedBy and to DECISIONS)
 *   POST /api/desks/send {to, text}         -> DeskMessage   (from "human")
 *   POST /api/desks/up {layoutFile?}        -> RosterView
 *   POST /api/desks/down                    -> {stopped: string[]}
 *   POST /api/desks/lanes {name, goal, mcps?, cwd?, agent?, model?, budgetUsd?} -> RosterEntry | {pending: PendingLane}
 *   POST /api/desks/lanes/:name/stop        -> {}
 *   POST /api/desks/pending/:id/approve     -> RosterEntry ; /reject {reason?} -> PendingLane
 *   POST /api/desks/:name/engine {agent, model?} -> RosterEntry   (restart that desk on another engine; roster + history kept)
 *   GET  /api/desks/:name/events?since=<seq> -> {events: HostEvent[]}
 *   GET  /api/desks/:name/attach            -> {argv: string[]}   (the host's GET /attach; 404 for an unknown or dead name)
 *   GET  /api/desks/costs                   -> {rows: DeskCostRow[]}
 *   GET  /api/desks/engines                 -> {engines: {agent: string, found: boolean, path?: string, auth?: string}[]}
 *   GET  /api/desks/mcps                    -> {names: string[]}   MCP names available to desks
 */
export const WEB_API_PREFIX = "/api/desks" as const;
