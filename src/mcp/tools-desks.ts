// Desk tools on `ach mcp` (#204): desk_roster, desk_send, desk_inbox, desk_reload, desk_power, lane_new,
// lane_status, lane_stop, lane_approve, lane_reject, decision_open, decision_list,
// decision_close.
// Identity comes from $ACH_DESK_NAME (+ $ACH_DESK_STACK), never from arguments.
// Registered for every transport by register-tools.ts, but only when this process
// is a desk/lane session (ACH_DESK_NAME set) or ACH_DESK_TOOLS=1 (then me = "human").
import type { McpServer } from "./contract.ts";
import * as realService from "../desks/service.ts";
import type { DecisionOption, Decision } from "../desks/types.ts";

/** The slice of src/desks/service.ts these tools use; tests inject a fake. */
export type DeskToolService = Pick<
  typeof realService,
  | "deskRoster"
  | "deskSend"
  | "deskInbox"
  | "deskReload"
  | "deskReloadStale"
  | "deskPower"
  | "deskAuto"
  | "laneNew"
  | "laneStatus"
  | "laneStop"
  | "isApprover"
  | "laneApprove"
  | "laneReject"
  | "decisionOpen"
  | "decisionList"
  | "decisionClose"
>;

export interface DeskToolDeps {
  service?: DeskToolService;
  /** Defaults to process.env, read at registration time. */
  env?: Record<string, string | undefined>;
}

function str(args: Record<string, unknown>, key: string, required = true): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) {
    if (required) throw new Error(`${key} is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new Error(`${key} must be a string`);
  if (required && v.trim() === "") throw new Error(`${key} must not be empty`);
  return v;
}

function num(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${key} must be a number`);
  return v;
}

function strList(args: Record<string, unknown>, key: string): string[] | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`${key} must be an array of strings`);
  return v as string[];
}

function parseOptions(v: unknown): DecisionOption[] {
  if (!Array.isArray(v) || v.length === 0) throw new Error("options must be a non-empty array of {label, recommended?, reason?}");
  return v.map((o, i) => {
    if (!o || typeof o !== "object") throw new Error(`options[${i}] must be an object`);
    const r = o as Record<string, unknown>;
    if (typeof r.label !== "string" || r.label.trim() === "") throw new Error(`options[${i}].label is required`);
    if (r.recommended !== undefined && typeof r.recommended !== "boolean") throw new Error(`options[${i}].recommended must be a boolean`);
    if (r.reason !== undefined && typeof r.reason !== "string") throw new Error(`options[${i}].reason must be a string`);
    return {
      label: r.label,
      ...(r.recommended !== undefined ? { recommended: r.recommended } : {}),
      ...(r.reason !== undefined ? { reason: r.reason } : {}),
    };
  });
}

export function registerDeskTools(
  server: McpServer,
  opts: { stateDir: string },
  deps: DeskToolDeps = {},
): void {
  const env = deps.env ?? process.env;
  const deskName = env.ACH_DESK_NAME?.trim();
  if (!deskName && env.ACH_DESK_TOOLS !== "1") return;
  const me = deskName || "human";
  const stack = env.ACH_DESK_STACK?.trim() || undefined;
  const svc: DeskToolService = deps.service ?? realService;
  const base = { ...(opts.stateDir ? { stateDir: opts.stateDir } : {}), ...(stack ? { stack } : {}) };

  const requireApprover = (tool: string): void => {
    if (!svc.isApprover({ ...base, name: me })) {
      throw new Error(`${tool}: only the human or the decisions desk may decide pending lanes (you are ${me})`);
    }
  };

  server.registerTool({
    name: "desk_roster",
    description:
      "Who is alive in the desk stack: each desk/lane with role, busy/idle/dead, MCP tools, goal, plus pending lane requests and open decisions. `me` is your own name.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => svc.deskRoster({ ...base, me }),
  });

  server.registerTool({
    name: "desk_send",
    description:
      "Send a message to another desk or lane. Fire and forget: it returns at once; the reply arrives later as a new turn. Do not wait, poll desk_roster/desk_inbox for an answer, or send ack-only messages (\"ok\", \"thanks\", \"got it\"). Refuses yourself and unknown names.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Target desk or lane name (see desk_roster)" },
        text: { type: "string", description: "Message text; make it stand alone" },
      },
      required: ["to", "text"],
    },
    handler: async (args) => {
      const to = str(args, "to") as string;
      const text = str(args, "text") as string;
      if (to === me) throw new Error("desk_send: cannot send a message to yourself");
      return svc.deskSend({ ...base, from: me, to, text });
    },
  });

  server.registerTool({
    name: "desk_inbox",
    description:
      "Recent messages to or from you, newest last. Use it to catch up after your context was compacted, not to wait for a reply.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "Max messages (most recent)" },
        since_minutes: { type: "number", description: "Only messages from the last N minutes" },
      },
    },
    handler: async (args) => {
      const limit = num(args, "limit");
      const mins = num(args, "since_minutes");
      return svc.deskInbox({
        ...base,
        name: me,
        ...(limit !== undefined ? { limit } : {}),
        ...(mins !== undefined ? { sinceMs: Date.now() - mins * 60_000 } : {}),
      });
    },
  });

  server.registerTool({
    name: "desk_reload",
    description:
      "Restart a desk's host on the same port, engine and agent session (history kept), so it picks up a newer ach build and new desk tools. Give `name`, or `all: true` for every desk (lanes are never reloaded), or `stale: true` for the idle desks whose host runs an older ach than the installed one (busy ones and ones with a live call are skipped, newer ones never touched). A busy desk or one whose feed reports a live call is refused unless `force: true` (force cuts its turn and drops its queued messages, or the call; under `stale` it overrides only the live-call skip). Off desks are skipped (they start on fresh code when turned on). You cannot reload yourself; under `all`/`stale` you are skipped. Each result says whether the session was resumed.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Desk to reload (see desk_roster)" },
        all: { type: "boolean", description: "Reload every desk except you; lanes never" },
        force: { type: "boolean", description: "Reload even when the desk is busy or a call is live on its feed" },
        stale: { type: "boolean", description: "Reload the idle desks running an older ach build than the installed one" },
      },
    },
    handler: async (args) => {
      const name = str(args, "name", false);
      const all = args.all;
      const force = args.force;
      if (args.stale !== undefined && typeof args.stale !== "boolean") throw new Error("stale must be a boolean");
      if (args.stale === true) {
        if ((name !== undefined && name !== "") || all === true) throw new Error("desk_reload: stale takes no name or all");
        if (force !== undefined && typeof force !== "boolean") throw new Error("force must be a boolean");
        return { results: await svc.deskReloadStale({ ...base, by: me, ...(force === true ? { force: true } : {}) }) };
      }
      if (all !== undefined && typeof all !== "boolean") throw new Error("all must be a boolean");
      if (force !== undefined && typeof force !== "boolean") throw new Error("force must be a boolean");
      if ((name === undefined || name === "") === (all !== true)) throw new Error("desk_reload: give either name or all: true");
      if (name === me) throw new Error(`desk_reload: you cannot reload yourself (your own host runs this call); ask another desk or the human`);
      if (all === true) return { results: await svc.deskReload({ ...base, all: true, by: me, ...(force === true ? { force: true } : {}) }) };
      return { results: await svc.deskReload({ ...base, name: name as string, by: me, ...(force === true ? { force: true } : {}) }) };
    },
  });

  server.registerTool({
    name: "desk_power",
    description:
      "Switch a desk on or off. `status`: on/off, feed pid, pane, whether a call is live (from the desk feed's activeCheck), auto watcher. `off`: stops the desk's host, feed and pane; the roster keeps it as `off` and desk_send to it fails with `desk_off:` (do not retry; turn it on or start a lane). Off is refused while a call is live. `on`: same port, fresh session and feed. `toggle`: off if on, else on. `auto`: a watcher turns the desk on when a call starts and off `graceSeconds` (default 300) after it ends, polling every `pollSeconds` (default 30); `auto_stop` ends it. A desk may turn itself off: the answer comes first, its host stops a few seconds later.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Desk to switch (see desk_roster), e.g. LISTENER" },
        action: { type: "string", enum: ["status", "on", "off", "toggle", "auto", "auto_stop"] },
        resume: { type: "boolean", description: "on/toggle: continue the session saved when it was turned off" },
        pollSeconds: { type: "number", description: "auto: activeCheck interval (default 30)" },
        graceSeconds: { type: "number", description: "auto: stay on this long after a call ends (default 300)" },
      },
      required: ["name", "action"],
    },
    handler: async (args) => {
      const name = str(args, "name") as string;
      const action = str(args, "action") as string;
      if (args.resume !== undefined && typeof args.resume !== "boolean") throw new Error("resume must be a boolean");
      const poll = num(args, "pollSeconds");
      const grace = num(args, "graceSeconds");
      if (action === "auto" || action === "auto_stop") {
        if (action === "auto_stop" && (poll !== undefined || grace !== undefined)) throw new Error("desk_power: auto_stop takes no pollSeconds/graceSeconds");
        return svc.deskAuto({
          ...base, name, by: me,
          ...(action === "auto_stop" ? { stop: true } : {}),
          ...(poll !== undefined ? { pollMs: Math.round(poll * 1000) } : {}),
          ...(grace !== undefined ? { graceMs: Math.round(grace * 1000) } : {}),
        });
      }
      if (!["status", "on", "off", "toggle"].includes(action)) throw new Error(`desk_power: action must be status, on, off, toggle, auto or auto_stop (got "${action}")`);
      if (poll !== undefined || grace !== undefined) throw new Error("desk_power: pollSeconds/graceSeconds only apply to auto");
      // never force from a desk: a live call is only cut by the human (`ach desk off --force`)
      return svc.deskPower({ ...base, name, action: action as realService.DeskPowerAction, by: me, ...(args.resume === true ? { resume: true } : {}) });
    },
  });

  server.registerTool({
    name: "lane_new",
    description:
      "Start a lane: a short-lived session that works one goal and stops. Returns the new lane, or `pending L<n>` when the stack needs DECISIONS' approval first (the lane starts after lane_approve).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Lane name, named after the work (e.g. fix-login-timeout)" },
        goal: { type: "string", description: "Standalone objective for the lane" },
        mcps: { type: "array", items: { type: "string" }, description: "MCP server names (default: the stack's lane defaults)" },
        cwd: { type: "string", description: "Working directory" },
        agent: { type: "string", description: "Agent CLI (default from layout)" },
        model: { type: "string", description: "Model id (default from layout)" },
        budget_usd: { type: "number", description: "Budget for this lane in USD" },
        brief: { type: "string", description: "Silent context shown to the lane before the goal" },
      },
      required: ["name", "goal"],
    },
    handler: async (args) => {
      const name = str(args, "name") as string;
      const goal = str(args, "goal") as string;
      const mcps = strList(args, "mcps");
      const cwd = str(args, "cwd", false);
      const agent = str(args, "agent", false);
      const model = str(args, "model", false);
      const budgetUsd = num(args, "budget_usd");
      const brief = str(args, "brief", false);
      const r = await svc.laneNew({
        ...base,
        name,
        goal,
        launchedBy: me,
        ...(mcps ? { mcps } : {}),
        ...(cwd ? { cwd } : {}),
        ...(agent ? { agent } : {}),
        ...(model ? { model } : {}),
        ...(budgetUsd !== undefined ? { budgetUsd } : {}),
        ...(brief ? { brief } : {}),
      } as Parameters<DeskToolService["laneNew"]>[0]);
      if ("pending" in r) {
        return {
          status: "pending",
          text: `pending ${r.pending.id}: lane "${name}" waits for DECISIONS to approve it (lane_approve {id: "${r.pending.id}"})`,
          pending: r.pending,
        };
      }
      return { status: "started", lane: r };
    },
  });

  server.registerTool({
    name: "lane_status",
    description: "Status of one lane, or of every lane when no name is given (desks are not listed; use desk_roster): state, goal state, verified plan actions, evidence, cost.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Lane or desk name (omit for all)" } },
    },
    handler: async (args) => {
      const name = str(args, "name", false);
      return svc.laneStatus({ ...base, ...(name ? { name } : {}) });
    },
  });

  server.registerTool({
    name: "lane_stop",
    description:
      "Stop a lane (refuses desk names). Check the lane's evidence first. A busy lane is given up to 15 s to finish its turn (so its goal gets judged) unless now is true.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Lane name" },
        now: { type: "boolean", description: "Stop at once without waiting for a busy lane to finish its turn (emergency stops only)" },
      },
      required: ["name"],
    },
    handler: async (args) => {
      if (args.now !== undefined && typeof args.now !== "boolean") throw new Error("now must be a boolean");
      return svc.laneStop({ ...base, name: str(args, "name") as string, by: me, ...(args.now === true ? { now: true } : {}) });
    },
  });

  server.registerTool({
    name: "lane_approve",
    description: "Approve a pending lane request (e.g. L3) so it starts. Only the decisions desk or the human may approve.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Pending lane id, e.g. L3" } },
      required: ["id"],
    },
    handler: async (args) => {
      requireApprover("lane_approve");
      return svc.laneApprove({ ...base, id: str(args, "id") as string, by: me });
    },
  });

  server.registerTool({
    name: "lane_reject",
    description: "Reject a pending lane request. Only the decisions desk or the human may reject.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Pending lane id, e.g. L3" },
        reason: { type: "string", description: "Why it was rejected" },
      },
      required: ["id"],
    },
    handler: async (args) => {
      requireApprover("lane_reject");
      const reason = str(args, "reason", false);
      return svc.laneReject({ ...base, id: str(args, "id") as string, by: me, ...(reason ? { reason } : {}) });
    },
  });

  server.registerTool({
    name: "decision_open",
    description:
      "Open a question for the human in the decision queue. Put recommended options first, each with a reason. The answer is delivered as a message to the asker.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question, standing alone" },
        options: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              recommended: { type: "boolean" },
              reason: { type: "string" },
            },
            required: ["label"],
          },
          description: "Choices, recommended first",
        },
        asked_by: { type: "string", description: "Desk or lane that needs the answer (default: you)" },
      },
      required: ["question", "options"],
    },
    handler: async (args) => {
      const question = str(args, "question") as string;
      const options = parseOptions(args.options);
      // Roles/docs also name this argument `askedBy`; accept both spellings.
      const askedBy = str(args, "asked_by", false) ?? str(args, "askedBy", false) ?? me;
      return svc.decisionOpen({ ...base, question, options, askedBy, openedBy: me });
    },
  });

  server.registerTool({
    name: "decision_list",
    description: "List decisions in the queue (all states, or one of open/answered/closed).",
    inputSchema: {
      type: "object",
      properties: { state: { type: "string", enum: ["open", "answered", "closed"] } },
    },
    handler: async (args) => {
      const state = str(args, "state", false);
      if (state && !["open", "answered", "closed"].includes(state)) {
        throw new Error("state must be open, answered or closed");
      }
      return svc.decisionList({ ...base, ...(state ? { state: state as Decision["state"] } : {}) });
    },
  });

  server.registerTool({
    name: "decision_close",
    description: "Close a decision that is moot or a duplicate.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Decision id, e.g. D4" },
        reason: { type: "string" },
      },
      required: ["id"],
    },
    handler: async (args) => {
      const reason = str(args, "reason", false);
      return svc.decisionClose({ ...base, id: str(args, "id") as string, by: me, ...(reason ? { reason } : {}) });
    },
  });
}
