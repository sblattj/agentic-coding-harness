// `ach desk ...` and `ach lane ...` (#204). Filled by the CLI/MCP seat.
//   ach desk up [--layout F] [--port-base N] [--term tmux|ghostty|none] [--tmux-session S] [--stack S]
//   ach desk down | attach [--term ...] | send <to> <text> | roster [--json] | inbox [name] [--json]
//   ach desk answer <Dn> <text> | decisions [--json] | engine <name> <agent> [--model M]
//   ach desk reload <name>|--all [--force]   (new host, same port, engine and agent session)
//   ach desk on|off|toggle|status <name> | auto <name> [--stop]   (desk power, issue 1)
//   ach desk host --spec <file>        (internal: the per-desk host process)
//   ach desk watch <name> ...          (internal: the auto watcher)
//   ach listener on|off|toggle|status|auto   (the same, for the LISTENER desk)
//   ach desk chat <name>               (attach REPL for engines without a native TUI)
//   ach lane new <name> --goal "<objective>" [--agent A] [--model M] [--mcps a,b] [--cwd D] [--budget-usd N]
//   ach lane status [name] [--json] | stop <name> | approve <Ln> | reject <Ln> [--reason R]
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import type { Readable } from "node:stream";
import type { Decision, DeskMessage, HostEvent, RosterRow, RosterView, TerminalKind } from "../desks/types.ts";
import type { HostSpec } from "../desks/types.ts";
import type * as ServiceModule from "../desks/service.ts";
import type * as HostClientModule from "../desks/host-client.ts";
import type { HostTarget } from "../desks/host-client.ts";
import { fmtInt, fmtUsd } from "./lib.ts";

/** `ach desk host --spec <file>`: the per-desk host process (src/desks/host.ts). */
async function cmdDeskHost(args: string[]): Promise<number> {
  let specFile: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--spec") specFile = args[++i];
    else if (a.startsWith("--spec=")) specFile = a.slice("--spec=".length);
    else {
      process.stderr.write(`ach desk host: unexpected argument ${JSON.stringify(a)}\nusage: ach desk host --spec <file>\n`);
      return 2;
    }
  }
  if (specFile === undefined || specFile === "") {
    process.stderr.write("usage: ach desk host --spec <file>\n");
    return 2;
  }
  let spec: HostSpec;
  try {
    spec = JSON.parse(readFileSync(specFile, "utf8")) as HostSpec;
  } catch (e) {
    process.stderr.write(`ach desk host: cannot read spec ${specFile}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  const { runHost } = await import("../desks/host.ts");
  return runHost(spec);
}

// ---------------------------------------------------------------- injection

export type DeskService = typeof ServiceModule;
export type DeskHostClient = Pick<typeof HostClientModule, "hostEvents" | "hostSubscribe">;

/** Everything the CLI touches outside its own process: tests inject fakes. */
export interface DeskDeps {
  service: DeskService;
  host: DeskHostClient;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  stdin: Readable;
  env: NodeJS.ProcessEnv;
  now: () => number;
  /** Ends `events --follow` and `chat` (default: SIGINT). */
  abort?: AbortSignal;
}

async function resolveDeps(d: Partial<DeskDeps> | undefined): Promise<DeskDeps> {
  return {
    service: d?.service ?? (await import("../desks/service.ts")),
    host: d?.host ?? (await import("../desks/host-client.ts")),
    stdout: d?.stdout ?? ((s) => void process.stdout.write(s)),
    stderr: d?.stderr ?? ((s) => void process.stderr.write(s)),
    stdin: d?.stdin ?? process.stdin,
    env: d?.env ?? process.env,
    now: d?.now ?? Date.now,
    abort: d?.abort,
  };
}

class UsageError extends Error {}
const usage = (msg: string): never => {
  throw new UsageError(msg);
};

// ---------------------------------------------------------------- help

export const DESK_USAGE = `usage:
  ach desk up [--layout F] [--port-base N] [--term tmux|ghostty|none] [--tmux-session S] [--tmux-socket S] [--stack S] [--json]
  ach desk down [--stack S]
  ach desk attach [--term tmux|ghostty|none] [--tmux-session S] [--tmux-socket S] [--stack S]
  ach desk send <to> <text...> [--from NAME]      ('-' as the text reads it from stdin)
  ach desk roster [--json] [--no-prune]
  ach desk inbox [name] [--limit N] [--since <epoch-ms|10m|2h|1d>] [--json]
  ach desk events <name> [--since SEQ] [--json] [--follow]
  ach desk answer <Dn> <text...> [--from NAME]
  ach desk decisions [--state open|answered|closed] [--json]
  ach desk close <Dn> [--reason R] [--from NAME]
  ach desk engine <name> <agent> [--model M]
  ach desk reload <name>|--all [--force] [--json] (restart a desk's host: same port, engine and session; lanes never)
  ach desk reload --stale [--json]                (reload idle desks whose host runs an older ach than this one)
  ach desk status <name> [--json]                 (on/off, feed pid, pane, call live, auto watcher)
  ach desk on <name> [--resume] [--json]          (start an off desk: same port, fresh session; --resume keeps the old one)
  ach desk off <name> [--force] [--from NAME]     (stop host, feed and pane; refused while a call is live unless --force)
  ach desk toggle <name> [--force] [--resume]
  ach desk auto <name> [--poll S] [--grace S] | auto <name> --stop
                                                  (on when the feed's activeCheck sees a call, off --grace S after it ends;
                                                   defaults poll 30 s, grace 300 s)
  ach desk costs [--json]
  ach desk chat <name>                            (attach REPL for engines without a native TUI)
  ach desk host --spec <file>                     (internal: the per-desk host process)
  ach listener on|off|toggle|status|auto ...      (shorthand for the LISTENER desk)
  every subcommand takes [--stack S]; --json prints the service result as JSON
  --from defaults to $ACH_DESK_NAME, else "human"`;

export const LANE_USAGE = `usage:
  ach lane new <name> --goal "<objective>" [--agent A] [--model M] [--mcps a,b] [--cwd D] [--budget-usd N] [--brief TEXT] [--from NAME]
  ach lane status [name] [--json]
  ach lane stop <name> [--now] [--from NAME]
  ach lane approve <Ln> [--from NAME]
  ach lane reject <Ln> [--reason R] [--from NAME]
  every subcommand takes [--stack S]; --from defaults to $ACH_DESK_NAME, else "human"`;

// ---------------------------------------------------------------- pure helpers

type Opt = { type: "string" | "boolean"; multiple?: boolean };

function parse(args: string[], options: Record<string, Opt>, what: string): { values: Record<string, string | boolean | undefined>; positionals: string[] } {
  try {
    const r = parseArgs({ args, options: { stack: { type: "string" }, ...options }, allowPositionals: true, strict: true });
    return { values: r.values as Record<string, string | boolean | undefined>, positionals: r.positionals };
  } catch (e) {
    return usage(`${what}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Drop undefined keys so call-arg objects stay minimal (and test expectations exact). */
function compact<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

function intFlag(v: unknown, flag: string, min = 0): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) return usage(`${flag} expects an integer >= ${min}, got '${String(v)}'`);
  return n;
}

function oneOf<T extends string>(v: unknown, flag: string, allowed: readonly T[]): T | undefined {
  if (v === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(v as string)) return usage(`${flag} expects ${allowed.join("|")}, got '${String(v)}'`);
  return v as T;
}

const DURATION_UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `--since`: a bare number is an epoch-ms timestamp; `10m`/`2h`/`1d`/`30s` mean "that long ago". */
export function parseSince(v: string, now: number): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(v.trim());
  if (m !== null) return Math.round(now - Number(m[1]) * (DURATION_UNITS[m[2] as string] as number));
  if (/^\d+$/.test(v.trim())) return Number(v);
  return usage(`--since expects epoch milliseconds or a duration like 10m, got '${v}'`);
}

function pad(rows: string[][]): string {
  const widths: number[] = [];
  for (const r of rows) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, c.length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i] as number))).join("  ").trimEnd()).join("\n") + "\n";
}

const clip = (s: string, n: number): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

const goalCell = (r: RosterRow): string => {
  const g = r.goalStatus;
  if (g === undefined) return r.goalState ?? "-";
  return g.plan !== undefined ? `${g.state} ${g.plan.verified}/${g.plan.total}` : g.state;
};

export function formatRoster(view: RosterView): string {
  const rows: string[][] = [["NAME", "KIND", "STATE", "AGENT", "MODEL", "PORT", "QUEUE", "GOAL", "COST"]];
  for (const r of view.rows) {
    rows.push([
      r.name, r.kind, r.state, r.agent, r.model ?? "-", String(r.port), String(r.queueDepth), goalCell(r),
      (r.kind === "desk" ? r.treeCostUsd : r.costUsd) === null ? "-" : fmtUsd((r.kind === "desk" ? r.treeCostUsd : r.costUsd) as number),
    ]);
  }
  let out = view.rows.length === 0 ? `stack ${view.stack}: no desks running\n` : pad(rows);
  if (view.pendingLanes.length > 0) {
    out += "\npending lanes:\n";
    for (const p of view.pendingLanes) out += `  ${p.id}  ${p.request.name}  by ${p.request.launchedBy}  ${clip(p.request.goal, 80)}\n`;
  }
  if (view.openDecisions.length > 0) {
    out += "\nopen decisions:\n";
    for (const d of view.openDecisions) out += `  ${d.id}  from ${d.askedBy}  ${clip(d.question, 80)}\n`;
  }
  return out;
}

/** `ach desk status`: `LISTENER on feed=<pid> pane=<id>`, then `call: ...` and `auto: ...` lines. */
export function formatPowerStatus(st: ServiceModule.DeskPowerStatus): string {
  const head =
    st.state === "on"
      ? `${st.name} on feed=${st.feedPid ?? "-"} pane=${st.pane?.id ?? "-"}`
      : st.state === "off"
        ? `${st.name} off${st.off !== undefined ? ` (by ${st.off.by} at ${new Date(st.off.at).toISOString()})` : ""}`
        : `${st.name} dead (in the roster, its host does not answer)`;
  const call = st.callLive === true ? "call: live" : st.callLive === false ? "call: none" : `call: unknown${st.callNote !== undefined ? ` (${st.callNote})` : ""}`;
  const a = st.auto;
  const auto = a.running ? `auto: on (pid ${a.pid ?? "?"}, poll ${(a.pollMs ?? 0) / 1000}s, grace ${(a.graceMs ?? 0) / 1000}s)` : "auto: off";
  return `${head}\n${call}\n${auto}`;
}

export function formatLaneStatus(rows: RosterRow[]): string {
  if (rows.length === 0) return "no lanes\n";
  const t: string[][] = [["NAME", "STATE", "AGENT", "MODEL", "PORT", "QUEUE", "GOAL", "COST", "BY"]];
  for (const r of rows) {
    t.push([r.name, r.state, r.agent, r.model ?? "-", String(r.port), String(r.queueDepth), goalCell(r), r.costUsd === null ? "-" : fmtUsd(r.costUsd), r.launchedBy ?? "-"]);
  }
  return pad(t);
}

function formatMessages(ms: DeskMessage[]): string {
  if (ms.length === 0) return "no messages\n";
  return ms.map((m) => `${new Date(m.at).toISOString()}  ${m.from} -> ${m.to}  [${m.delivered}]  ${clip(m.text, 200)}`).join("\n") + "\n";
}

function formatDecisions(ds: Decision[]): string {
  if (ds.length === 0) return "no decisions\n";
  let out = "";
  for (const d of ds) {
    out += `${d.id}  ${d.state}  from ${d.askedBy}  ${clip(d.question, 120)}\n`;
    for (const o of d.options) out += `    ${o.recommended === true ? "*" : "-"} ${o.label}${o.reason !== undefined ? `  (${clip(o.reason, 80)})` : ""}\n`;
    if (d.answer !== undefined) out += `    answer by ${d.answer.by}: ${clip(d.answer.text, 120)}\n`;
  }
  return out;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** One event line for `desk events` (null: nothing worth a line). */
export function formatEventLine(e: HostEvent): string {
  const d = e.data;
  const msg = (d.message ?? {}) as { from?: string; to?: string; text?: string };
  let body: string;
  switch (e.type) {
    case "text": body = clip(str(d.text), 300); break;
    case "tool": body = `${str(d.tool)} ${clip(str(d.summary), 200)}`; break;
    case "status": body = str(d.state); break;
    case "error": body = clip(str(d.error), 300); break;
    case "boundary": body = `${str(d.rule)}  ${clip(str(d.detail), 300)}`; break;
    case "message_in": body = `from ${str(msg.from)}: ${clip(str(msg.text), 300)}`; break;
    case "message_out": body = `to ${str(msg.to)}: ${clip(str(msg.text), 300)}`; break;
    case "feed": body = clip(str(d.note), 200); break;
    case "goal": body = clip(JSON.stringify(d.goal ?? {}), 200); break;
    case "usage": body = clip(JSON.stringify(d), 200); break;
    default: body = "";
  }
  return `${String(e.seq).padStart(5)}  ${new Date(e.at).toISOString().slice(11, 19)}  ${e.type}${body === "" ? "" : `  ${body}`}`;
}

/**
 * `desk chat` rendering: one HostEvent to one terminal line, or null when it
 * is not worth showing (turn bookkeeping, usage, goal, feed). `echoHuman`
 * shows human messages too (backlog only: live ones were typed right here).
 */
export function formatChatEvent(e: HostEvent, opts: { echoHuman?: boolean } = {}): string | null {
  const d = e.data;
  switch (e.type) {
    case "text": {
      const t = str(d.text).trim();
      return t === "" ? null : t;
    }
    case "tool": {
      const s = clip(str(d.summary), 160);
      return `  [tool] ${str(d.tool)}${s === "" ? "" : ` ${s}`}`;
    }
    case "status":
      return `  [status] ${str(d.state)}`;
    case "error":
      return `  [error] ${clip(str(d.error), 300)}`;
    case "boundary":
      return `  [boundary] ${clip(str(d.detail), 300)}`;
    case "message_in": {
      const m = (d.message ?? {}) as { from?: string; text?: string };
      if (m.from === "human") return opts.echoHuman === true ? `you> ${clip(str(m.text), 300)}` : null;
      return `  [from ${str(m.from)}] ${clip(str(m.text), 300)}`;
    }
    case "message_out": {
      const m = (d.message ?? {}) as { to?: string; text?: string };
      return `  [to ${str(m.to)}] ${clip(str(m.text), 300)}`;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------- commands

type Ctx = { d: DeskDeps; stack: string | undefined; json: boolean };

/** Sender identity. Inside a desk/lane session ($ACH_DESK_NAME set) --from must be absent or equal to it. */
const fromName = (v: unknown, env: NodeJS.ProcessEnv): string => {
  const e = env.ACH_DESK_NAME;
  const me = e !== undefined && e !== "" ? e : undefined;
  if (typeof v === "string" && v !== "") {
    if (me !== undefined && v !== me) return usage(`--from ${v} refused: this session is ${me} ($ACH_DESK_NAME); a desk cannot act as another sender`);
    return v;
  }
  return me ?? "human";
};

function emitJson(c: Ctx, v: unknown): void {
  c.d.stdout(`${JSON.stringify(v, null, 2)}\n`);
}

async function readAll(s: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const ch of s) chunks.push(Buffer.isBuffer(ch) ? ch : Buffer.from(ch as string));
  return Buffer.concat(chunks).toString("utf8");
}

/** Text from the remaining args; a lone `-` reads stdin. */
async function textArg(words: string[], d: DeskDeps, what: string): Promise<string> {
  if (words.length === 1 && words[0] === "-") {
    const t = (await readAll(d.stdin)).replace(/\n+$/, "");
    if (t === "") usage(`${what}: stdin was empty`);
    return t;
  }
  const t = words.join(" ");
  if (t.trim() === "") usage(`${what}: missing text`);
  return t;
}

const need = (cond: boolean, msg: string): void => {
  if (!cond) usage(msg);
};

/** The entry a chat/follow attaches to: its live row, or a clear error. */
/** The live host of `name`: its url plus the bearer token from its spec (the host refuses calls without it). */
async function entryUrl(c: Ctx, name: string): Promise<HostTarget> {
  const view = await c.d.service.deskRoster(compact({ stack: c.stack, prune: false }));
  const row = view.rows.find((r) => r.name === name);
  if (row === undefined) throw new Error(`unknown desk or lane '${name}' (known: ${view.rows.map((r) => r.name).join(", ") || "none"})`);
  if (row.state === "dead") throw new Error(`'${name}' is dead (its host is not running)`);
  if (row.state === "off") throw new Error(`'${name}' is off; turn it on first (ach desk on ${name})`);
  // Injected test services may not provide deskHostTarget; then the bare url is used.
  if (typeof c.d.service.deskHostTarget !== "function") return row.url;
  return c.d.service.deskHostTarget(compact({ stack: c.stack, name, url: row.url, runId: row.runId }));
}

function untilAbort(c: Ctx, extra?: (finish: () => void) => void): Promise<void> {
  return new Promise<void>((resolve) => {
    const onSig = (): void => finish();
    const finish = (): void => {
      process.off("SIGINT", onSig);
      c.d.abort?.removeEventListener("abort", finish);
      resolve();
    };
    if (c.d.abort === undefined) process.on("SIGINT", onSig);
    else if (c.d.abort.aborted) return finish();
    else c.d.abort.addEventListener("abort", finish);
    extra?.(finish);
  });
}

async function deskEventsCmd(c: Ctx, name: string, since: number | undefined, follow: boolean): Promise<void> {
  const events = await c.d.service.deskEvents(compact({ stack: c.stack, name, since }));
  if (!follow) {
    if (c.json) emitJson(c, events);
    else c.d.stdout(events.length === 0 ? "no events\n" : `${events.map(formatEventLine).join("\n")}\n`);
    return;
  }
  const print = (e: HostEvent): void => c.d.stdout(`${c.json ? JSON.stringify(e) : formatEventLine(e)}\n`);
  events.forEach(print);
  const last = events.reduce((m, e) => Math.max(m, e.seq), since ?? 0);
  await entryUrl(c, name); // fail fast on an unknown or dead name
  // Re-resolved on every reconnect, so an engine switch (new host token and run) keeps streaming.
  const stop = c.d.host.hostSubscribe(() => entryUrl(c, name), last, print);
  await untilAbort(c);
  stop();
}

/** `ach desk chat <name>`: backlog, live stream, and stdin lines sent as `from` (the same sender guard as `desk send`). */
async function deskChatCmd(c: Ctx, name: string, from: string): Promise<void> {
  const url = await entryUrl(c, name);
  const backlog = await c.d.host.hostEvents(url, 0);
  const shown: string[] = [];
  for (const e of backlog) {
    const l = formatChatEvent(e, { echoHuman: true });
    if (l !== null) shown.push(l);
  }
  const tail = shown.slice(-50);
  c.d.stdout(`-- ${name}: last ${tail.length} lines; type a message and press Enter, Ctrl-D to leave --\n`);
  for (const l of tail) c.d.stdout(`${l}\n`);
  const last = backlog.reduce((m, e) => Math.max(m, e.seq), 0);
  const stop = c.d.host.hostSubscribe(() => entryUrl(c, name).catch(() => url), last, (e) => {
    const l = formatChatEvent(e);
    if (l !== null) c.d.stdout(`${l}\n`);
  });
  const rl = createInterface({ input: c.d.stdin, terminal: false });
  const send = async (text: string): Promise<void> => {
    try {
      await c.d.service.deskSend(compact({ stack: c.stack, from, to: name, text }));
    } catch (e) {
      c.d.stderr(`ach desk chat: send failed: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  };
  let inflight: Promise<void> = Promise.resolve();
  rl.on("line", (line) => {
    const t = line.trim();
    if (t !== "") inflight = inflight.then(() => send(t));
  });
  await untilAbort(c, (finish) => rl.once("close", finish));
  rl.close();
  stop();
  await inflight;
}

async function runDesk(sub: string, args: string[], d: DeskDeps): Promise<void> {
  const svc = d.service;
  const o = (opts: Record<string, Opt>): ReturnType<typeof parse> => parse(args, { json: { type: "boolean" }, ...opts }, `ach desk ${sub}`);
  const ctxOf = (p: ReturnType<typeof parse>): Ctx => ({ d, stack: p.values.stack as string | undefined, json: p.values.json === true });
  const term = (v: unknown): TerminalKind | undefined => oneOf(v, "--term", ["tmux", "ghostty", "none"] as const);

  switch (sub) {
    case "up": {
      const p = o({ layout: { type: "string" }, "port-base": { type: "string" }, term: { type: "string" }, "tmux-session": { type: "string" }, "tmux-socket": { type: "string" } });
      need(p.positionals.length === 0, "ach desk up: unexpected argument");
      const c = ctxOf(p);
      const view = await svc.deskUp(compact({
        stack: c.stack, layoutFile: p.values.layout as string | undefined, portBase: intFlag(p.values["port-base"], "--port-base", 1),
        term: term(p.values.term), tmuxSession: p.values["tmux-session"] as string | undefined, tmuxSocket: p.values["tmux-socket"] as string | undefined,
      }));
      if (c.json) emitJson(c, view);
      else d.stdout(formatRoster(view));
      return;
    }
    case "down": {
      const p = o({});
      need(p.positionals.length === 0, "ach desk down: unexpected argument");
      const c = ctxOf(p);
      const r = await svc.deskDown(compact({ stack: c.stack }));
      if (c.json) emitJson(c, r);
      else d.stdout(r.stopped.length === 0 ? "nothing was running\n" : `stopped: ${r.stopped.join(", ")}\n`);
      return;
    }
    case "attach": {
      const p = o({ term: { type: "string" }, "tmux-session": { type: "string" }, "tmux-socket": { type: "string" } });
      need(p.positionals.length === 0, "ach desk attach: unexpected argument");
      const c = ctxOf(p);
      const view = await svc.deskAttach(compact({ stack: c.stack, term: term(p.values.term), tmuxSession: p.values["tmux-session"] as string | undefined, tmuxSocket: p.values["tmux-socket"] as string | undefined }));
      if (c.json) emitJson(c, view);
      else d.stdout(formatRoster(view));
      return;
    }
    case "send": {
      const p = o({ from: { type: "string" } });
      const [to, ...words] = p.positionals;
      need(to !== undefined && words.length > 0, "usage: ach desk send <to> <text...> [--from NAME]");
      const c = ctxOf(p);
      const text = await textArg(words, d, "ach desk send");
      const m = await svc.deskSend(compact({ stack: c.stack, from: fromName(p.values.from, d.env), to: to as string, text }));
      if (c.json) emitJson(c, m);
      else d.stdout(`sent ${m.id} to ${m.to} (${m.delivered})\n`);
      return;
    }
    case "roster": {
      const p = o({ "no-prune": { type: "boolean" } });
      need(p.positionals.length === 0, "ach desk roster: unexpected argument");
      const c = ctxOf(p);
      const me = d.env.ACH_DESK_NAME;
      const view = await svc.deskRoster(compact({ stack: c.stack, me: me !== undefined && me !== "" ? me : undefined, prune: p.values["no-prune"] === true ? false : undefined }));
      if (c.json) emitJson(c, view);
      else d.stdout(formatRoster(view));
      return;
    }
    case "inbox": {
      const p = o({ limit: { type: "string" }, since: { type: "string" } });
      need(p.positionals.length <= 1, "usage: ach desk inbox [name] [--limit N] [--since <ms|10m>] [--json]");
      const c = ctxOf(p);
      const since = p.values.since as string | undefined;
      const ms = await svc.deskInbox(compact({ stack: c.stack, name: p.positionals[0], limit: intFlag(p.values.limit, "--limit", 1), sinceMs: since === undefined ? undefined : parseSince(since, d.now()) }));
      if (c.json) emitJson(c, ms);
      else d.stdout(formatMessages(ms));
      return;
    }
    case "events": {
      const p = o({ since: { type: "string" }, follow: { type: "boolean" } });
      need(p.positionals.length === 1, "usage: ach desk events <name> [--since SEQ] [--json] [--follow]");
      await deskEventsCmd(ctxOf(p), p.positionals[0] as string, intFlag(p.values.since, "--since", 0), p.values.follow === true);
      return;
    }
    case "answer": {
      const p = o({ from: { type: "string" } });
      const [id, ...words] = p.positionals;
      need(id !== undefined && words.length > 0, "usage: ach desk answer <Dn> <text...> [--from NAME]");
      const c = ctxOf(p);
      const text = await textArg(words, d, "ach desk answer");
      const r = await svc.decisionAnswer(compact({ stack: c.stack, id: id as string, text, by: fromName(p.values.from, d.env) }));
      if (c.json) emitJson(c, r);
      else d.stdout(`answered ${r.id}\n`);
      return;
    }
    case "decisions": {
      const p = o({ state: { type: "string" } });
      need(p.positionals.length === 0, "ach desk decisions: unexpected argument");
      const c = ctxOf(p);
      const r = await svc.decisionList(compact({ stack: c.stack, state: oneOf(p.values.state, "--state", ["open", "answered", "closed"] as const) }));
      if (c.json) emitJson(c, r);
      else d.stdout(formatDecisions(r));
      return;
    }
    case "close": {
      const p = o({ reason: { type: "string" }, from: { type: "string" } });
      need(p.positionals.length === 1, "usage: ach desk close <Dn> [--reason R] [--from NAME]");
      const c = ctxOf(p);
      const r = await svc.decisionClose(compact({ stack: c.stack, id: p.positionals[0] as string, by: fromName(p.values.from, d.env), reason: p.values.reason as string | undefined }));
      if (c.json) emitJson(c, r);
      else d.stdout(`closed ${r.id}\n`);
      return;
    }
    case "engine": {
      const p = o({ model: { type: "string" } });
      need(p.positionals.length === 2, "usage: ach desk engine <name> <agent> [--model M]");
      const c = ctxOf(p);
      const r = await svc.deskSwitchEngine(compact({ stack: c.stack, name: p.positionals[0] as string, agent: p.positionals[1] as string, model: p.values.model as string | undefined }));
      if (c.json) emitJson(c, r);
      else d.stdout(`${r.name} now runs ${r.agent}${r.model !== undefined ? ` (${r.model})` : ""} on ${r.engine}\n`);
      return;
    }
    case "reload": {
      const p = o({ all: { type: "boolean" }, force: { type: "boolean" }, stale: { type: "boolean" } });
      const all = p.values.all === true;
      const stale = p.values.stale === true;
      need(stale ? p.positionals.length === 0 && !all && p.values.force !== true : all ? p.positionals.length === 0 : p.positionals.length === 1, "usage: ach desk reload <name>|--all [--force] | --stale");
      const c = ctxOf(p);
      const me = d.env.ACH_DESK_NAME;
      const rs = stale ? await svc.deskReloadStale(compact({ stack: c.stack, by: me !== undefined && me !== "" ? me : "human" })) : await svc.deskReload(compact({
        stack: c.stack, name: all ? undefined : (p.positionals[0] as string), all: all ? true : undefined,
        force: p.values.force === true ? true : undefined, by: me !== undefined && me !== "" ? me : "human",
      }));
      if (c.json) emitJson(c, rs);
      else {
        for (const r of rs) {
          if (r.skipped !== undefined) d.stdout(`${r.name}: skipped: ${r.skipped}\n`);
          else if (!r.ok) d.stdout(`${r.name}: not reloaded: ${r.error ?? "unknown error"}\n`);
          else d.stdout(`${r.name}: reloaded on port ${r.entry?.port ?? "?"}, ${r.resumed ? `session ${r.sessionId} kept` : "NEW session"}${r.note !== undefined ? ` (${r.note})` : ""}\n`);
        }
        if (rs.length === 0) d.stdout(stale ? "no stale desks (every desk that is on runs this ach or a newer one)\n" : "no desks to reload\n");
      }
      const failed = rs.filter((r) => !r.ok && r.skipped === undefined).map((r) => r.name);
      if (failed.length > 0) throw new Error(`desks: not reloaded: ${failed.join(", ")}`);
      return;
    }
    case "costs": {
      const p = o({});
      need(p.positionals.length === 0, "ach desk costs: unexpected argument");
      const c = ctxOf(p);
      const rows = await svc.deskCosts(compact({ stack: c.stack }));
      if (c.json) {
        emitJson(c, rows);
        return;
      }
      const t: string[][] = [["NAME", "KIND", "INPUT", "OUTPUT", "COST", "LOST"]];
      let lost = 0;
      const walk = (r: (typeof rows)[number], depth: number): void => {
        lost += r.tokenRecordFailures ?? 0;
        t.push([
          `${"  ".repeat(depth)}${r.name}`,
          r.kind,
          fmtInt(r.inputTokens),
          fmtInt(r.outputTokens),
          r.costUsd === null ? "-" : fmtUsd(r.costUsd),
          r.tokenRecordFailures ? fmtInt(r.tokenRecordFailures) : "",
        ]);
        r.lanes.forEach((l) => walk(l, depth + 1));
      };
      rows.forEach((r) => walk(r, 0));
      d.stdout(rows.length === 0 ? "no costs yet\n" : pad(t));
      if (lost > 0) d.stdout(`warning: ${lost} token record(s) could not be written; these totals undercount\n`);
      return;
    }
    case "status":
    case "on":
    case "off":
    case "toggle": {
      const p = o({ force: { type: "boolean" }, resume: { type: "boolean" }, from: { type: "string" }, "delay-ms": { type: "string" } });
      need(p.positionals.length === 1, `usage: ach desk ${sub} <name>${sub === "status" ? "" : sub === "on" ? " [--resume]" : sub === "off" ? " [--force]" : " [--force] [--resume]"}`);
      need(p.values.force !== true || sub === "off" || sub === "toggle", `ach desk ${sub}: --force only applies to off and toggle`);
      need(p.values.resume !== true || sub === "on" || sub === "toggle", `ach desk ${sub}: --resume only applies to on and toggle`);
      const c = ctxOf(p);
      const r = await svc.deskPower(compact({
        stack: c.stack, name: p.positionals[0] as string, action: sub, by: fromName(p.values.from, d.env),
        force: p.values.force === true ? true : undefined, resume: p.values.resume === true ? true : undefined,
        delayMs: intFlag(p.values["delay-ms"], "--delay-ms", 0),
      }));
      if (c.json) emitJson(c, r);
      else d.stdout(sub === "status" ? `${formatPowerStatus(r.status)}\n` : `${r.message}\n${formatPowerStatus(r.status)}\n`);
      return;
    }
    case "auto": {
      const p = o({ stop: { type: "boolean" }, poll: { type: "string" }, grace: { type: "string" }, from: { type: "string" } });
      need(p.positionals.length === 1, "usage: ach desk auto <name> [--poll S] [--grace S] | --stop");
      const stop = p.values.stop === true;
      need(!stop || (p.values.poll === undefined && p.values.grace === undefined), "ach desk auto: --stop takes no --poll/--grace");
      const c = ctxOf(p);
      const poll = intFlag(p.values.poll, "--poll", 1);
      const grace = intFlag(p.values.grace, "--grace", 0);
      const r = await svc.deskAuto(compact({
        stack: c.stack, name: p.positionals[0] as string, by: fromName(p.values.from, d.env), stop: stop ? true : undefined,
        pollMs: poll === undefined ? undefined : poll * 1000, graceMs: grace === undefined ? undefined : grace * 1000,
      }));
      if (c.json) emitJson(c, r);
      else d.stdout(`${r.message}\n${formatPowerStatus(r.status)}\n`);
      return;
    }
    case "watch": {
      const p = o({ "poll-ms": { type: "string" }, "grace-ms": { type: "string" }, token: { type: "string" } });
      need(p.positionals.length === 1, "usage: ach desk watch <name> --poll-ms N --grace-ms N (internal: run by ach desk auto)");
      const c = ctxOf(p);
      const ac = new AbortController();
      const onSig = (): void => ac.abort();
      process.on("SIGTERM", onSig);
      process.on("SIGINT", onSig);
      try {
        await svc.runDeskWatcher(compact({
          stack: c.stack, name: p.positionals[0] as string, signal: ac.signal, log: (l: string) => d.stdout(`${l}\n`), token: p.values.token as string | undefined,
          pollMs: intFlag(p.values["poll-ms"], "--poll-ms", 100) ?? 30_000, graceMs: intFlag(p.values["grace-ms"], "--grace-ms", 0) ?? 300_000,
        }));
      } finally {
        process.off("SIGTERM", onSig);
        process.off("SIGINT", onSig);
      }
      return;
    }
    case "chat": {
      const p = o({ from: { type: "string" } });
      need(p.positionals.length === 1, "usage: ach desk chat <name>");
      const from = fromName(p.values.from, d.env); // before any I/O: a refused sender never opens the REPL
      await deskChatCmd(ctxOf(p), p.positionals[0] as string, from);
      return;
    }
    default:
      usage(`ach desk: unknown subcommand '${sub}'`);
  }
}

async function runLane(sub: string, args: string[], d: DeskDeps): Promise<void> {
  const svc = d.service;
  const o = (opts: Record<string, Opt>): ReturnType<typeof parse> => parse(args, { json: { type: "boolean" }, ...opts }, `ach lane ${sub}`);
  const ctxOf = (p: ReturnType<typeof parse>): Ctx => ({ d, stack: p.values.stack as string | undefined, json: p.values.json === true });

  switch (sub) {
    case "new": {
      const p = o({ goal: { type: "string" }, agent: { type: "string" }, model: { type: "string" }, mcps: { type: "string" }, cwd: { type: "string" }, "budget-usd": { type: "string" }, brief: { type: "string" }, from: { type: "string" } });
      need(p.positionals.length === 1, 'usage: ach lane new <name> --goal "<objective>" [--agent A] [--model M] [--mcps a,b] [--cwd D] [--budget-usd N]');
      const goal = p.values.goal as string | undefined;
      need(goal !== undefined && goal.trim() !== "", "ach lane new: --goal is required");
      const budget = p.values["budget-usd"] === undefined ? undefined : Number(p.values["budget-usd"]);
      if (budget !== undefined && !(Number.isFinite(budget) && budget > 0)) usage(`--budget-usd expects a positive number, got '${String(p.values["budget-usd"])}'`);
      const mcpsRaw = p.values.mcps as string | undefined;
      const c = ctxOf(p);
      const r = await svc.laneNew(compact({
        stack: c.stack, name: p.positionals[0] as string, goal: goal as string,
        mcps: mcpsRaw === undefined ? undefined : mcpsRaw.split(",").map((s) => s.trim()).filter((s) => s !== ""),
        cwd: p.values.cwd as string | undefined, agent: p.values.agent as string | undefined, model: p.values.model as string | undefined,
        budgetUsd: budget, launchedBy: fromName(p.values.from, d.env),
        brief: p.values.brief as string | undefined,
      }));
      if (c.json) emitJson(c, r);
      else if ("pending" in r) d.stdout(`pending ${r.pending.id}: waiting for DECISIONS approval\n`);
      else d.stdout(`lane ${r.name} started on port ${r.port} (${r.agent}${r.model !== undefined ? `, ${r.model}` : ""})\n`);
      return;
    }
    case "status": {
      const p = o({});
      need(p.positionals.length <= 1, "usage: ach lane status [name] [--json]");
      const c = ctxOf(p);
      const rows = await svc.laneStatus(compact({ stack: c.stack, name: p.positionals[0] }));
      if (c.json) emitJson(c, rows);
      else d.stdout(formatLaneStatus(rows));
      return;
    }
    case "stop": {
      const p = o({ from: { type: "string" }, now: { type: "boolean" } });
      need(p.positionals.length === 1, "usage: ach lane stop <name> [--now]");
      const c = ctxOf(p);
      const r = await svc.laneStop(compact({ stack: c.stack, name: p.positionals[0] as string, by: fromName(p.values.from, d.env), now: p.values.now === true ? true : undefined }));
      if (c.json) emitJson(c, r);
      else d.stdout(`stopped ${r.stopped}\n`);
      return;
    }
    case "approve": {
      const p = o({ from: { type: "string" } });
      need(p.positionals.length === 1, "usage: ach lane approve <Ln>");
      const c = ctxOf(p);
      const r = await svc.laneApprove(compact({ stack: c.stack, id: p.positionals[0] as string, by: fromName(p.values.from, d.env) }));
      if (c.json) emitJson(c, r);
      else d.stdout(`approved: lane ${r.name} started on port ${r.port}\n`);
      return;
    }
    case "reject": {
      const p = o({ reason: { type: "string" }, from: { type: "string" } });
      need(p.positionals.length === 1, "usage: ach lane reject <Ln> [--reason R]");
      const c = ctxOf(p);
      const r = await svc.laneReject(compact({ stack: c.stack, id: p.positionals[0] as string, by: fromName(p.values.from, d.env), reason: p.values.reason as string | undefined }));
      if (c.json) emitJson(c, r);
      else d.stdout(`rejected ${r.id}${r.reason !== undefined ? `: ${r.reason}` : ""}\n`);
      return;
    }
    default:
      usage(`ach lane: unknown subcommand '${sub}'`);
  }
}

async function dispatch(which: "desk" | "lane", rest: string[], depsIn: Partial<DeskDeps> | undefined): Promise<number> {
  const [sub, ...args] = rest;
  const helpText = which === "desk" ? DESK_USAGE : LANE_USAGE;
  const errOut = depsIn?.stderr ?? ((s: string) => void process.stderr.write(s));
  const outOut = depsIn?.stdout ?? ((s: string) => void process.stdout.write(s));
  const isHelp = (a: string | undefined): boolean => a === "-h" || a === "--help";
  if (isHelp(sub) || (sub !== undefined && isHelp(args[0]))) {
    outOut(`${helpText}\n`);
    return 0;
  }
  if (sub === undefined) {
    errOut(`${helpText}\n`);
    return 2;
  }
  try {
    const d = await resolveDeps(depsIn);
    if (which === "desk") await runDesk(sub, args, d);
    else await runLane(sub, args, d);
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof UsageError) {
      errOut(`${msg.startsWith("usage:") || msg.startsWith("ach ") ? msg : `ach ${which} ${sub}: ${msg}`}\n${which === "desk" ? "run `ach desk --help` for usage" : "run `ach lane --help` for usage"}\n`);
      return 2;
    }
    errOut(`ach ${which}: ${msg}\n`);
    return 1;
  }
}

export async function cmdDesk(rest: string[], deps?: Partial<DeskDeps>): Promise<number> {
  if (rest[0] === "host") return cmdDeskHost(rest.slice(1));
  return dispatch("desk", rest, deps);
}

/** `ach listener <on|off|toggle|status|auto> [flags]`: `ach desk <sub> LISTENER [flags]`. */
export async function cmdListener(rest: string[], deps?: Partial<DeskDeps>): Promise<number> {
  const [sub, ...args] = rest;
  const errOut = deps?.stderr ?? ((s: string) => void process.stderr.write(s));
  const outOut = deps?.stdout ?? ((s: string) => void process.stdout.write(s));
  const subs = ["on", "off", "toggle", "status", "auto"];
  if (sub === "-h" || sub === "--help") {
    outOut(`${LISTENER_USAGE}\n`);
    return 0;
  }
  if (sub === undefined || !subs.includes(sub)) {
    errOut(`${LISTENER_USAGE}\n`);
    return 2;
  }
  return dispatch("desk", [sub, "LISTENER", ...args], deps);
}

export const LISTENER_USAGE = `usage:
  ach listener status | on [--resume] | off [--force] | toggle | auto [--poll S] [--grace S] | auto --stop   [--stack S] [--json]
  (the LISTENER desk; same as ach desk <sub> LISTENER)`;

export async function cmdLane(rest: string[], deps?: Partial<DeskDeps>): Promise<number> {
  return dispatch("lane", rest, deps);
}
