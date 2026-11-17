// Stack service (#204): the ONE API the CLI (src/cli/desk.ts), the MCP desk
// tools (src/mcp/tools-desks.ts) and the Web API (src/web/desks-api.ts) call.
// Signatures are frozen by the orchestrator (wave 0); bodies are filled by the
// service seat. Every function takes an optional `stack` (default: the active
// stack, see resolveStack) and `stateDir` (default: core/store.ts stateDir()).
//
// Service-owned files in the stack dir (besides the ones listed in types.ts):
//   terminal.json  {kind, tmuxSession?, tmuxSocket?}: the terminal the panes live on,
//                  so lane windows, engine switches and `desk down` (other processes,
//                  no term options) reach the same tmux server. Absent = no panes.
//   lanes.log      one JSON line per lane start/stop.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { listRunRecords, type RunRecord } from "../core/registry.ts";
import { stateDir as defaultStateDir } from "../core/store.ts";
import { loadLayout, deskPort, roleFiles } from "./config.ts";
import { engineKindFor } from "./engines/index.ts";
import { hostAttach, hostEvents, hostHealth, hostRecord, hostSend, hostStop } from "./host-client.ts";
import { spawnHost } from "./host.ts";
import {
  appendDecisionEvent,
  appendMessage,
  appendPendingLane,
  deskPaths,
  isEntryAlive,
  nextDecisionId,
  nextPendingLaneId,
  putEntry,
  readDecisions,
  readMessages,
  readPendingLanes,
  readRoster,
  removeEntry,
  updateRoster,
  validName,
} from "./roster.ts";
import { paneCommand } from "./term/tmux.ts";
import { terminalDriver } from "./term/index.ts";
import { DESKS_API_VERSION } from "./types.ts";
import type {
  DeskCostRow,
  DeskMessage,
  DeskSpec,
  Decision,
  DecisionOption,
  HostEvent,
  HostHealth,
  HostSpec,
  LaneRequest,
  Layout,
  PaneSlot,
  PendingLane,
  RosterEntry,
  GoalStatus,
  RosterRow,
  RosterView,
  Sender,
  TerminalDriver,
  TerminalKind,
  TerminalRef,
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

/** Persisted terminal settings of a stack (terminal.json). */
export interface StackTerminal {
  kind: TerminalKind;
  tmuxSession?: string;
  tmuxSocket?: string;
}

/** How long a fresh host may take to report idle. */
// Must stay well below the 60 s request timeout of an MCP client calling lane_new: if startHost
// outlived it, the client would see "Request timed out" while the host was killed behind its back.
export const HOST_START_TIMEOUT_MS = 45_000;
/** How long a stopping host may take to exit before SIGTERM, then SIGKILL. */
export const HOST_STOP_TIMEOUT_MS = 10_000;
/** How long laneStop waits for a busy lane to finish its turn before stopping it anyway. */
export const LANE_STOP_GRACE_MS = 15_000;
/** After a busy lane goes idle, how long laneStop waits for the goal plugin's final verdict. */
export const LANE_STOP_GOAL_SETTLE_MS = 2_000;
/** Name of the DECISIONS desk when the layout has no desk with role "decisions". */
export const DECISIONS_DESK = "DECISIONS";
/** How long a deskSwitchEngine marker shields its entry from roster pruning. */
const SWITCH_GRACE_MS = 120_000;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function ctx(o: StackOpts): { stateDir: string; stack: string } {
  const sd = o.stateDir ?? defaultStateDir();
  return { stateDir: sd, stack: resolveStack({ ...o, stateDir: sd }) };
}

function activeStackFile(stateDir: string): string {
  return join(stateDir, "desks", "active-stack");
}

function terminalFile(stateDir: string, stack: string): string {
  return join(deskPaths(stateDir, stack).root, "terminal.json");
}

export function readStackTerminal(stateDir: string, stack: string): StackTerminal | null {
  const f = terminalFile(stateDir, stack);
  if (!existsSync(f)) return null;
  try {
    const v = JSON.parse(readFileSync(f, "utf8")) as StackTerminal;
    return v && typeof v.kind === "string" ? v : null;
  } catch {
    return null;
  }
}

function writeStackTerminal(stateDir: string, stack: string, t: StackTerminal): void {
  const f = terminalFile(stateDir, stack);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, `${JSON.stringify(t, null, 2)}\n`);
}

function pidAlive(pid: number | undefined): boolean {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function kill(pid: number | undefined, sig: NodeJS.Signals): void {
  if (pid === undefined || pid <= 0) return;
  try {
    process.kill(pid, sig);
  } catch {
    /* already gone */
  }
}

async function waitUntil(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (pred()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
}

/** True when nothing listens on 127.0.0.1:port (we could bind it). */
export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

function logTail(file: string, lines = 15): string {
  try {
    return readFileSync(file, "utf8").trim().split("\n").slice(-lines).join("\n");
  } catch {
    return "(no log)";
  }
}

function appendLanesLog(stateDir: string, stack: string, v: Record<string, unknown>): void {
  const f = deskPaths(stateDir, stack).lanesLog;
  mkdirSync(dirname(f), { recursive: true });
  appendFileSync(f, `${JSON.stringify({ at: Date.now(), ...v })}\n`);
}

/** State of the last `goal` event in a run's events file, or null when none (or no file). */
function lastGoalState(stateDir: string, stack: string, runId: string): GoalStatus["state"] | null {
  let text: string;
  try {
    text = readFileSync(join(deskPaths(stateDir, stack).events, `${runId}.jsonl`), "utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i] as string;
    if (l === "") continue;
    try {
      const ev = JSON.parse(l) as { type?: string; data?: { goal?: { state?: GoalStatus["state"] } } };
      if (ev.type === "goal" && typeof ev.data?.goal?.state === "string") return ev.data.goal.state;
    } catch {
      /* torn line */
    }
  }
  return null;
}

function readLanesLog(stateDir: string, stack: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(deskPaths(stateDir, stack).lanesLog, "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/** The stack's resolved layout: layout.json written by deskUp, else the searched layout. */
function stackLayout(stateDir: string, stack: string): Layout {
  const f = deskPaths(stateDir, stack).layout;
  if (existsSync(f)) {
    try {
      return JSON.parse(readFileSync(f, "utf8")) as Layout;
    } catch (e) {
      throw new Error(`desks: corrupt layout ${f}: ${errText(e)}`);
    }
  }
  const { layout } = loadLayout();
  const r = readRoster(stateDir, stack);
  return { ...layout, portBase: r.portBase ?? layout.portBase, stack };
}

/** Name of the DECISIONS desk: the desk with role "decisions", else "DECISIONS". */
function decisionsName(stateDir: string, stack: string): string {
  try {
    return stackLayout(stateDir, stack).desks.find((d) => d.role === "decisions")?.name ?? DECISIONS_DESK;
  } catch {
    return DECISIONS_DESK;
  }
}

// ---------------------------------------------------------------------------
// Host lifecycle
// ---------------------------------------------------------------------------

interface Started {
  spec: HostSpec;
  health: HostHealth;
  /** pid spawnHost returned (a launcher such as tsx when ACH_SELF_ARGV wraps the host). */
  spawnPid: number;
}

/** Write the spec, spawn the host, wait until /health says idle or busy for THIS runId. Throws with the log tail. */
async function startHost(stateDir: string, stack: string, spec: HostSpec): Promise<Started> {
  const p = deskPaths(stateDir, stack);
  mkdirSync(p.specs, { recursive: true });
  const specFile = join(p.specs, `${spec.name}.json`);
  writeFileSync(specFile, `${JSON.stringify(spec, null, 2)}\n`);
  const logFile = join(p.logs, `${spec.name}.log`);
  const spawnPid = spawnHost(specFile, logFile);
  const url = `http://127.0.0.1:${spec.port}`;
  const deadline = Date.now() + HOST_START_TIMEOUT_MS;
  let last: HostHealth | null = null;
  for (;;) {
    last = await hostHealth(url, 1000);
    if (last !== null && last.runId === spec.runId) {
      // busy counts: a lane with a goal goes starting -> idle -> busy within ~60 ms, so a poll can miss idle.
      if (last.state === "idle" || last.state === "busy") return { spec, health: last, spawnPid };
      if (last.state === "error") break;
    }
    const gone = !pidAlive(spawnPid) && (last === null || last.runId !== spec.runId);
    if (gone || Date.now() >= deadline) break;
    await sleep(150);
  }
  // failed: make sure nothing is left behind
  if (last !== null && last.runId === spec.runId) {
    await stopPids(url, [last.pid, spawnPid], last.feedPid);
  } else {
    kill(spawnPid, "SIGKILL");
  }
  const why = last === null || last.runId !== spec.runId ? "no health answer" : `state ${last.state}`;
  throw new Error(`desks: host ${spec.name} did not become idle on port ${spec.port} (${why}); log ${logFile}:\n${logTail(logFile)}`);
}

/** POST /stop, wait for every pid to exit (10 s), then SIGTERM, then SIGKILL. */
async function stopPids(url: string, pids: number[], _rosterFeedPid?: number): Promise<void> {
  // The feed restarts on its own, so the roster's feedPid goes stale: ask the live host (/health) now,
  // before /stop. A host that does not answer has no trustworthy feed pid, so none is SIGKILLed.
  const feedPid = (await hostHealth(url, 1000))?.feedPid;
  try {
    await hostStop(url);
  } catch {
    /* dead or unreachable: fall through to signals */
  }
  const all = () => pids.every((p) => !pidAlive(p));
  if (await waitUntil(all, HOST_STOP_TIMEOUT_MS)) return;
  for (const p of pids) kill(p, "SIGTERM");
  if (await waitUntil(all, 3000)) return;
  for (const p of pids) kill(p, "SIGKILL");
  kill(feedPid, "SIGKILL");
  if (feedPid !== undefined && feedPid > 0) {
    try {
      process.kill(-feedPid, "SIGKILL"); // the feed leads its own process group
    } catch {
      /* gone */
    }
  }
  await waitUntil(all, 2000);
}

/** Pids recorded for an entry: the host pid, plus the launcher pid kept beside the spec. */
function entryPids(stateDir: string, stack: string, e: RosterEntry): number[] {
  const pids = [e.pid];
  const f = join(deskPaths(stateDir, stack).specs, `${e.name}.pid`);
  try {
    const n = Number.parseInt(readFileSync(f, "utf8").trim(), 10);
    if (Number.isInteger(n) && n > 0 && n !== e.pid) pids.push(n);
  } catch {
    /* none */
  }
  return pids;
}

function writeSpawnPid(stateDir: string, stack: string, name: string, pid: number): void {
  const f = join(deskPaths(stateDir, stack).specs, `${name}.pid`);
  writeFileSync(f, `${pid}\n`);
}

async function stopEntry(stateDir: string, stack: string, e: RosterEntry): Promise<void> {
  await stopPids(e.url, entryPids(stateDir, stack, e), e.feedPid);
  rmSync(join(deskPaths(stateDir, stack).specs, `${e.name}.pid`), { force: true });
}

function entryFrom(s: Started, extra: Partial<RosterEntry>): RosterEntry {
  const { spec, health } = s;
  const e: RosterEntry = {
    name: spec.name,
    kind: spec.kind,
    role: spec.role,
    agent: spec.agent,
    engine: spec.engine,
    ...(spec.model !== undefined ? { model: spec.model } : {}),
    mcps: spec.mcps,
    port: spec.port,
    url: `http://127.0.0.1:${spec.port}`,
    pid: health.pid,
    runId: spec.runId,
    ...(spec.parentRunId !== undefined ? { parentRunId: spec.parentRunId } : {}),
    ...(health.sessionId !== undefined ? { sessionId: health.sessionId } : {}),
    ...(health.engineUrl !== undefined ? { engineUrl: health.engineUrl } : {}),
    cwd: spec.cwd,
    startedAt: Date.now(),
    ...(spec.goal !== undefined ? { goal: spec.goal.slice(0, 400) } : {}),
    ...(spec.launchedBy !== undefined ? { launchedBy: spec.launchedBy } : {}),
    ...(health.feedPid !== undefined ? { feedPid: health.feedPid } : {}),
    ...(spec.budgetUsd !== undefined ? { budgetUsd: spec.budgetUsd } : {}),
    ...extra,
  };
  return e;
}

function pickServers(layout: Layout, mcps: string[]): HostSpec["mcpServers"] {
  if (!layout.mcpServers) return undefined;
  const out: NonNullable<HostSpec["mcpServers"]> = {};
  for (const m of mcps) if (layout.mcpServers[m]) out[m] = layout.mcpServers[m]!;
  return Object.keys(out).length > 0 ? out : undefined;
}

function deskHostSpec(stateDir: string, stack: string, layout: Layout, d: DeskSpec, port: number, agent?: string, model?: string): HostSpec {
  const ag = agent ?? d.agent ?? layout.agent ?? "opencode";
  const engine = engineKindFor(ag);
  const md = model ?? (agent === undefined ? d.model ?? layout.model : undefined);
  const servers = pickServers(layout, d.mcps);
  return {
    stack,
    stateDir,
    name: d.name,
    kind: "desk",
    role: d.role,
    roleFiles: roleFiles(layout, d.role),
    agent: ag,
    engine,
    ...(md !== undefined ? { model: md } : {}),
    mcps: [...d.mcps],
    ...(servers ? { mcpServers: servers } : {}),
    port,
    ...(engine === "opencode" ? { enginePort: port + 500 } : {}),
    cwd: d.cwd ?? layout.cwd ?? process.cwd(),
    runId: randomUUID(),
    ...(d.feed ? { feed: d.feed } : {}),
  };
}

// ---------------------------------------------------------------------------
// Terminals
// ---------------------------------------------------------------------------

async function driverFor(t: StackTerminal | null, kind?: TerminalKind): Promise<TerminalDriver | null> {
  const k = kind ?? t?.kind;
  if (!k || k === "none") return null;
  return terminalDriver(k, { tmuxSession: t?.tmuxSession, tmuxSocket: t?.tmuxSocket });
}

function tmuxRaw(socket: string | undefined, args: string[]): Promise<string> {
  const full = socket ? ["-L", socket, ...args] : args;
  return new Promise((resolve, reject) => {
    execFile("tmux", full, { encoding: "utf8", timeout: 15_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`tmux ${args[0]} failed: ${(stderr || err.message).trim()}`));
      else resolve(stdout);
    });
  });
}

async function closePane(t: StackTerminal | null, ref: TerminalRef | undefined): Promise<void> {
  if (!ref || ref.kind === "none" || ref.id === "") return;
  try {
    const drv = await driverFor(t?.kind === ref.kind ? t : { kind: ref.kind }, ref.kind);
    await drv?.close(ref.id);
  } catch {
    /* already gone */
  }
}

async function attachArgv(e: RosterEntry): Promise<string[]> {
  try {
    return await hostAttach(e.url);
  } catch {
    return ["echo", `desk ${e.name}: host not reachable at ${e.url}`];
  }
}

/** Effective pane slot of desk i (unset = by index: left, right-top, right-bottom, then extra right panes). */
function slotOf(d: DeskSpec, i: number): PaneSlot | "extra" {
  if (d.pane) return d.pane;
  return (["left", "right-top", "right-bottom"] as const)[i] ?? "extra";
}

/** Opens the `desks` window (desk panes by slot) and one window per lane. Returns name -> ref. */
async function openLayout(t: StackTerminal, layout: Layout, entries: RosterEntry[]): Promise<Record<string, TerminalRef>> {
  const out: Record<string, TerminalRef> = {};
  const drv = await driverFor(t);
  if (!drv) return out;
  const byName = new Map(entries.map((e) => [e.name, e]));
  const order: PaneSlot[] = ["left", "right-top", "right-bottom"];
  const desks = layout.desks
    .map((d, i) => ({ d, slot: slotOf(d, i), e: byName.get(d.name) }))
    .filter((x) => x.e !== undefined && x.e.kind === "desk" && x.slot !== "none")
    .sort((a, b) => {
      const ia = a.slot === "extra" ? 9 : order.indexOf(a.slot as PaneSlot);
      const ib = b.slot === "extra" ? 9 : order.indexOf(b.slot as PaneSlot);
      return ia - ib;
    });
  let left: string | undefined;
  let rightTop: string | undefined;
  let lastRight: string | undefined;
  let first: string | undefined;
  for (const { slot, e } of desks) {
    const entry = e as RosterEntry;
    const argv = await attachArgv(entry);
    const base = { name: entry.name, cwd: entry.cwd, argv };
    let id: string;
    if (first === undefined) {
      id = await drv.open({ ...base, mode: "window", name: "desks" });
    } else if (slot === "right-top" || (slot === "right-bottom" && lastRight === undefined) || (slot === "extra" && lastRight === undefined)) {
      id = await drv.open({ ...base, mode: "right", of: left ?? first });
    } else if (slot === "left") {
      id = await drv.open({ ...base, mode: "right", of: first });
    } else {
      id = await drv.open({ ...base, mode: "down", of: lastRight ?? rightTop ?? first });
    }
    if (first === undefined) first = id;
    if (slot === "left") left = id;
    else {
      if (slot === "right-top") rightTop = id;
      lastRight = id;
    }
    out[entry.name] = { kind: drv.kind, id };
  }
  for (const e of entries.filter((x) => x.kind === "lane")) {
    out[e.name] = { kind: drv.kind, id: await openLaneWindow(drv, first, e) };
  }
  return out;
}

async function openLaneWindow(drv: TerminalDriver, anyPane: string | undefined, e: RosterEntry): Promise<string> {
  const argv = await attachArgv(e);
  if (anyPane !== undefined && (await drv.alive(anyPane))) {
    return drv.open({ mode: "tab", name: e.name, cwd: e.cwd, argv, of: anyPane });
  }
  return drv.open({ mode: "window", name: e.name, cwd: e.cwd, argv });
}

function anyDeskPane(entries: RosterEntry[], kind: TerminalKind): string | undefined {
  return entries.find((e) => e.kind === "desk" && e.terminal?.kind === kind && e.terminal.id !== "")?.terminal?.id;
}

// ---------------------------------------------------------------------------
// Stack lifecycle
// ---------------------------------------------------------------------------

/** Start every desk in the layout. Refuses when any desk of the stack is alive. */
export async function deskUp(o: UpOpts = {}): Promise<RosterView> {
  const stateDir = o.stateDir ?? defaultStateDir();
  const loaded = loadLayout(o.layoutFile);
  const layout: Layout = { ...loaded.layout };
  if (o.portBase !== undefined && o.portBase !== layout.portBase) {
    const derived = layout.portBase === 4800 ? "default" : `p${layout.portBase}`;
    if (layout.stack === undefined || layout.stack === derived) layout.stack = o.portBase === 4800 ? "default" : `p${o.portBase}`;
    layout.portBase = o.portBase;
  }
  const stack = o.stack ?? layout.stack ?? "default";
  layout.stack = stack;
  if (layout.desks.length === 0) throw new Error("desks: the layout has no desks");

  const cur = readRoster(stateDir, stack);
  const alive = await Promise.all(Object.values(cur.entries).map(async (e) => ((await isEntryAlive(e)) ? e.name : null)));
  const live = alive.filter((n): n is string => n !== null);
  if (live.length > 0) throw new Error(`desks: stack "${stack}" is already up (alive: ${live.join(", ")}); run \`ach desk down\` first`);

  const ports = layout.desks.map((_, i) => deskPort(layout, i));
  const busy: number[] = [];
  for (const p of ports) if (!(await portFree(p))) busy.push(p);
  if (busy.length > 0) throw new Error(`desks: port(s) ${busy.join(", ")} already in use; pick another portBase (--port-base)`);

  // Resolve every spec (role files etc.) before starting anything, so a bad layout starts nothing.
  const specs = layout.desks.map((d, i) => deskHostSpec(stateDir, stack, layout, d, ports[i]!));

  const p = deskPaths(stateDir, stack);
  mkdirSync(p.root, { recursive: true });
  writeFileSync(p.layout, `${JSON.stringify(layout, null, 2)}\n`);
  await updateRoster(stateDir, stack, (r) => {
    r.entries = {};
    r.portBase = layout.portBase;
    if (loaded.file !== null) r.layoutFile = loaded.file;
    else delete r.layoutFile;
  });
  rmSync(terminalFile(stateDir, stack), { force: true });

  const results = await Promise.allSettled(specs.map((s) => startHost(stateDir, stack, s)));
  const ok = results.filter((r): r is PromiseFulfilledResult<Started> => r.status === "fulfilled").map((r) => r.value);
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed.length > 0) {
    await Promise.all(ok.map((s) => stopPids(`http://127.0.0.1:${s.spec.port}`, [s.health.pid, s.spawnPid], s.health.feedPid)));
    throw new Error(failed.map((f) => errText(f.reason)).join("\n"));
  }
  for (const s of ok) {
    writeSpawnPid(stateDir, stack, s.spec.name, s.spawnPid);
    const pane = layout.desks.find((d) => d.name === s.spec.name)?.pane;
    await putEntry(stateDir, stack, entryFrom(s, pane !== undefined ? { pane } : {}));
  }

  mkdirSync(dirname(activeStackFile(stateDir)), { recursive: true });
  writeFileSync(activeStackFile(stateDir), `${stack}\n`);

  const term: TerminalKind = o.term ?? "tmux";
  const t: StackTerminal = { kind: term, ...(o.tmuxSession ? { tmuxSession: o.tmuxSession } : {}), ...(o.tmuxSocket ? { tmuxSocket: o.tmuxSocket } : {}) };
  writeStackTerminal(stateDir, stack, t);
  if (term !== "none") {
    const entries = Object.values(readRoster(stateDir, stack).entries);
    const refs = await openLayout(t, layout, entries);
    await updateRoster(stateDir, stack, (r) => {
      for (const [name, ref] of Object.entries(refs)) if (r.entries[name]) r.entries[name]!.terminal = ref;
    });
  }
  return deskRoster({ stack, stateDir });
}

/** Stop every lane, then every desk (feed, pane, host). Leaves an empty roster and no processes. */
export async function deskDown(o: StackOpts = {}): Promise<{ stopped: string[] }> {
  const { stateDir, stack } = ctx(o);
  const t = readStackTerminal(stateDir, stack);
  const stopped: string[] = [];
  const entries = Object.values(readRoster(stateDir, stack).entries);
  for (const l of entries.filter((e) => e.kind === "lane")) {
    await laneStop({ stack, stateDir, name: l.name, by: "human", now: true });
    stopped.push(l.name);
  }
  const desks = entries.filter((e) => e.kind === "desk");
  await Promise.all(
    desks.map(async (d) => {
      await closePane(t, d.terminal);
      await stopEntry(stateDir, stack, d);
      await removeEntry(stateDir, stack, d.name);
      stopped.push(d.name);
    }),
  );
  await updateRoster(stateDir, stack, (r) => {
    r.entries = {};
  });
  rmSync(terminalFile(stateDir, stack), { force: true });
  try {
    if (readFileSync(activeStackFile(stateDir), "utf8").trim() === stack) rmSync(activeStackFile(stateDir), { force: true });
  } catch {
    /* no active-stack */
  }
  return { stopped };
}

/** Close every pane of the stack and reopen the layout on `term` (sessions unchanged). */
export async function deskAttach(o: StackOpts & { term?: TerminalKind; tmuxSession?: string; tmuxSocket?: string } = {}): Promise<RosterView> {
  const { stateDir, stack } = ctx(o);
  const old = readStackTerminal(stateDir, stack);
  const entries = Object.values((await deskRoster({ stack, stateDir })).rows).filter((r) => r.state !== "dead");
  for (const e of entries) await closePane(old, e.terminal);
  const kind: TerminalKind = o.term ?? old?.kind ?? "tmux";
  const sameKind = old?.kind === kind;
  const t: StackTerminal = {
    kind,
    ...((o.tmuxSession ?? (sameKind ? old?.tmuxSession : undefined)) ? { tmuxSession: o.tmuxSession ?? old?.tmuxSession } : {}),
    ...((o.tmuxSocket ?? (sameKind ? old?.tmuxSocket : undefined)) ? { tmuxSocket: o.tmuxSocket ?? old?.tmuxSocket } : {}),
  };
  writeStackTerminal(stateDir, stack, t);
  const refs = kind === "none" ? {} : await openLayout(t, stackLayout(stateDir, stack), entries);
  await updateRoster(stateDir, stack, (r) => {
    for (const e of Object.values(r.entries)) {
      const ref = refs[e.name];
      if (ref) e.terminal = ref;
      else delete e.terminal;
    }
  });
  return deskRoster({ stack, stateDir });
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Fire-and-forget delivery. Refuses self-send and unknown/dead targets (error lists known names). */
export async function deskSend(o: StackOpts & { from: Sender; to: string; text: string }): Promise<DeskMessage> {
  const { stateDir, stack } = ctx(o);
  if (o.from === o.to) throw new Error(`desks: ${o.from} cannot send to yourself`);
  if (typeof o.text !== "string" || o.text.trim() === "") throw new Error("desks: message text must not be empty");
  const roster = readRoster(stateDir, stack);
  const entries = Object.values(roster.entries);
  const aliveFlags = await Promise.all(entries.map((e) => isEntryAlive(e)));
  const live = entries.filter((_, i) => aliveFlags[i]).map((e) => e.name);
  const target = roster.entries[o.to];
  const known = live.length > 0 ? live.join(", ") : "(none)";
  if (!target) throw new Error(`desks: unknown desk or lane "${o.to}" in stack "${stack}"; live: ${known}`);
  if (!live.includes(o.to)) throw new Error(`desks: ${o.to} is not running (dead) in stack "${stack}"; live: ${known}`);
  const r = await hostSend(target.url, o.from, o.text);
  const message: DeskMessage = { id: r.id, from: o.from, to: o.to, text: o.text, at: Date.now(), delivered: r.delivered };
  appendMessage(stateDir, stack, message);
  const sender = roster.entries[o.from];
  if (sender && live.includes(o.from)) {
    try {
      await hostRecord(sender.url, "message_out", { message });
    } catch {
      /* the sender's transcript is best effort */
    }
  }
  return message;
}

/** Best-effort delivery: never throws (dead, unknown, human or self targets are skipped). */
async function tryDeliver(o: { stack: string; stateDir: string; from: Sender; to: Sender; text: string }): Promise<DeskMessage | null> {
  if (o.to === "human" || o.to === o.from) return null;
  try {
    return await deskSend(o);
  } catch {
    return null;
  }
}

async function rowsFor(stateDir: string, stack: string, entries: RosterEntry[], costs: DeskCostRow[]): Promise<RosterRow[]> {
  const flat = new Map<string, DeskCostRow>();
  const walk = (rs: DeskCostRow[]) => {
    for (const r of rs) {
      flat.set(r.runId, r);
      walk(r.lanes);
    }
  };
  walk(costs);
  return Promise.all(
    entries.map(async (e): Promise<RosterRow> => {
      const h = await hostHealth(e.url, 1500);
      const ok = h !== null && h.runId === e.runId;
      const c = flat.get(e.runId);
      return {
        ...e,
        ...(ok && h.sessionId !== undefined ? { sessionId: h.sessionId } : {}),
        ...(ok && h.feedPid !== undefined ? { feedPid: h.feedPid } : {}),
        state: ok ? h.state : "dead",
        queueDepth: ok ? h.queueDepth : 0,
        ...(ok && h.goal !== undefined ? { goalStatus: h.goal } : {}),
        costUsd: c?.costUsd ?? null,
        treeCostUsd: c ? treeCost(c) : null,
      };
    }),
  );
}

/** Live roster; prunes dead entries when prune is true (default true). */
export async function deskRoster(o: StackOpts & { me?: string; prune?: boolean } = {}): Promise<RosterView> {
  const { stateDir, stack } = ctx(o);
  let roster = readRoster(stateDir, stack);
  if (o.prune !== false) {
    const entries = Object.values(roster.entries);
    const flags = await Promise.all(entries.map((e) => isEntryAlive(e)));
    const dead = entries.filter((e, i) => !flags[i] && !isSwitching(stateDir, stack, e.name));
    if (dead.length > 0) {
      const t = readStackTerminal(stateDir, stack);
      for (const d of dead) await closePane(t, d.terminal);
      roster = await updateRoster(stateDir, stack, (r) => {
        for (const d of dead) if (r.entries[d.name]?.runId === d.runId) delete r.entries[d.name];
      });
    }
  }
  const entries = Object.values(roster.entries);
  const costs = await deskCosts({ stack, stateDir });
  const rows = await rowsFor(stateDir, stack, entries, costs);
  rows.sort((a, b) => (a.kind === b.kind ? a.port - b.port : a.kind === "desk" ? -1 : 1));
  return {
    version: DESKS_API_VERSION,
    stack,
    portBase: roster.portBase,
    ...(o.me !== undefined ? { me: o.me } : {}),
    rows,
    pendingLanes: readPendingLanes(stateDir, stack).filter((p) => p.state === "pending"),
    openDecisions: readDecisions(stateDir, stack).filter((d) => d.state === "open"),
  };
}

/**
 * Recent messages to or from `name` (all when omitted), newest last.
 * `sinceMs` is an ABSOLUTE epoch-ms timestamp (keeps messages with at >= sinceMs), not a duration.
 * `limit` keeps the newest N after filtering.
 */
export async function deskInbox(o: StackOpts & { name?: string; limit?: number; sinceMs?: number } = {}): Promise<DeskMessage[]> {
  const { stateDir, stack } = ctx(o);
  return readMessages(stateDir, stack, {
    ...(o.name !== undefined ? { name: o.name } : {}),
    ...(o.limit !== undefined ? { limit: o.limit } : {}),
    ...(o.sinceMs !== undefined ? { sinceMs: o.sinceMs } : {}),
  });
}

function readEventsFile(file: string, since: number): HostEvent[] {
  if (!existsSync(file)) return [];
  const out: HostEvent[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as HostEvent;
      if (typeof ev.seq === "number" && ev.seq > since) out.push(ev);
    } catch {
      /* torn line */
    }
  }
  return out;
}

/** Host events of one desk/lane. */
export async function deskEvents(o: StackOpts & { name: string; since?: number }): Promise<HostEvent[]> {
  const { stateDir, stack } = ctx(o);
  const since = o.since ?? 0;
  const p = deskPaths(stateDir, stack);
  const e = readRoster(stateDir, stack).entries[o.name];
  if (e) {
    if (await isEntryAlive(e)) {
      try {
        return await hostEvents(e.url, since);
      } catch {
        /* fall back to the file */
      }
    }
    return readEventsFile(join(p.events, `${e.runId}.jsonl`), since);
  }
  // Not in the roster (stopped): the last spec names its run.
  const specFile = join(p.specs, `${o.name}.json`);
  if (existsSync(specFile)) {
    try {
      const spec = JSON.parse(readFileSync(specFile, "utf8")) as HostSpec;
      return readEventsFile(join(p.events, `${spec.runId}.jsonl`), since);
    } catch {
      /* corrupt spec */
    }
  }
  throw new Error(`desks: unknown desk or lane "${o.name}" in stack "${stack}"`);
}

// ---------------------------------------------------------------------------
// Engine switch
// ---------------------------------------------------------------------------

/** Restart one desk on another engine/agent; keeps its roster slot, message history and decisions. */
export async function deskSwitchEngine(o: StackOpts & { name: string; agent: string; model?: string }): Promise<RosterEntry> {
  const { stateDir, stack } = ctx(o);
  // While the old host is down and the new one not yet in the roster, a concurrent
  // deskRoster() (MCP desk_roster, a web poll) must not prune the entry and kill its pane.
  const marker = switchingMarker(stateDir, stack, o.name);
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, `${process.pid}\n`);
  try {
    return await switchEngine({ ...o, stack, stateDir });
  } finally {
    rmSync(marker, { force: true });
  }
}

/** specs/<name>.switching: present while deskSwitchEngine restarts that desk. */
function switchingMarker(stateDir: string, stack: string, name: string): string {
  return join(deskPaths(stateDir, stack).specs, `${name}.switching`);
}

/** A fresh (< 2 min) switching marker protects an entry from pruning. */
function isSwitching(stateDir: string, stack: string, name: string): boolean {
  try {
    return Date.now() - statSync(switchingMarker(stateDir, stack, name)).mtimeMs < SWITCH_GRACE_MS;
  } catch {
    return false;
  }
}

async function switchEngine(o: StackOpts & { name: string; agent: string; model?: string }): Promise<RosterEntry> {
  const { stateDir, stack } = ctx(o);
  const old = readRoster(stateDir, stack).entries[o.name];
  if (!old) throw new Error(`desks: unknown desk "${o.name}" in stack "${stack}"`);
  if (old.kind !== "desk") throw new Error(`desks: ${o.name} is a lane; only desks switch engines`);
  if (typeof o.agent !== "string" || o.agent.trim() === "") throw new Error("desks: agent must be a non-empty string");
  const layout = stackLayout(stateDir, stack);
  const specFile = join(deskPaths(stateDir, stack).specs, `${o.name}.json`);
  let base: HostSpec | null = null;
  try {
    base = JSON.parse(readFileSync(specFile, "utf8")) as HostSpec;
  } catch {
    base = null;
  }
  const d = layout.desks.find((x) => x.name === o.name);
  if (!base && !d) throw new Error(`desks: no spec or layout entry for ${o.name}`);
  const engine = engineKindFor(o.agent);
  const model = o.model ?? (o.agent === old.agent ? old.model : undefined);
  const spec: HostSpec = base
    ? {
        ...base,
        agent: o.agent,
        engine,
        runId: randomUUID(),
        port: old.port,
      }
    : deskHostSpec(stateDir, stack, layout, d!, old.port, o.agent, model);
  if (model !== undefined) spec.model = model;
  else delete spec.model;
  if (engine === "opencode") spec.enginePort = old.port + 500;
  else delete spec.enginePort;

  await stopEntry(stateDir, stack, old);
  if (!(await waitPortFree(old.port, 5000))) {
    throw new Error(`desks: port ${old.port} still busy after stopping ${o.name}`);
  }
  const s = await startHost(stateDir, stack, spec);
  writeSpawnPid(stateDir, stack, spec.name, s.spawnPid);
  const entry = entryFrom(s, { ...(old.terminal ? { terminal: old.terminal } : {}), ...(old.pane !== undefined ? { pane: old.pane } : {}) });
  await putEntry(stateDir, stack, entry);

  // Pane: keep the slot.
  const t = readStackTerminal(stateDir, stack);
  if (old.terminal && old.terminal.kind !== "none" && old.terminal.id !== "") {
    const argv = await attachArgv(entry);
    if (old.terminal.kind === "tmux") {
      try {
        await tmuxRaw(t?.tmuxSocket, ["respawn-pane", "-k", "-t", old.terminal.id, "-c", entry.cwd, paneCommand(argv)]);
        return entry;
      } catch {
        /* pane gone: reopen below */
      }
    }
    const drv = await driverFor(t, old.terminal.kind);
    if (drv) {
      await closePane(t, old.terminal);
      const others = Object.values(readRoster(stateDir, stack).entries).filter((e) => e.name !== entry.name);
      const id = await openLaneWindow(drv, anyDeskPane(others, drv.kind), entry);
      entry.terminal = { kind: drv.kind, id };
      await putEntry(stateDir, stack, entry);
    }
  }
  return entry;
}

async function waitPortFree(port: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await portFree(port)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
}

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

async function freeLanePort(layout: Layout, roster: RosterEntry[], skip: Set<number>): Promise<number> {
  const used = new Set(roster.map((e) => e.port));
  const [lo, hi] = layout.lanes.ports;
  for (let off = lo; off <= hi; off++) {
    const port = layout.portBase + off;
    if (used.has(port) || skip.has(port)) continue;
    if (await portFree(port)) return port;
  }
  throw new Error(`desks: no free lane port in ${layout.portBase + lo}..${layout.portBase + hi}`);
}

function laneGoal(layout: Layout, goal: string): string {
  const g = goal.trim();
  const flags = layout.lanes.defaultGoalFlags?.trim();
  if (!flags || g.startsWith("--")) return g;
  return `${flags} ${g}`;
}

/** LaneRequest plus the optional silent brief (types.ts gains `brief?` on feat/desks-and-lanes 278a00d). */
type LaneReq = LaneRequest & { brief?: string };

async function startLane(stateDir: string, stack: string, req: LaneReq): Promise<RosterEntry> {
  const layout = stackLayout(stateDir, stack);
  const roster = readRoster(stateDir, stack);
  if (roster.entries[req.name]) throw new Error(`desks: name "${req.name}" is already in use in stack "${stack}"`);
  const launcher = roster.entries[req.launchedBy];
  const agent = req.agent ?? layout.lanes.agent ?? layout.agent ?? "opencode";
  const engine = engineKindFor(agent);
  const model = req.model ?? (req.agent === undefined ? layout.lanes.model ?? layout.model : undefined);
  const mcps = req.mcps ?? layout.lanes.defaultMcps ?? [];
  const budgetUsd = req.budgetUsd ?? layout.lanes.budgetUsd;
  const reportTo = launcher ? req.launchedBy : layout.desks.find((d) => d.role === "orchestrator")?.name ?? "ORCHESTRATOR";
  const goal = laneGoal(layout, req.goal);
  const tried = new Set<number>();
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = await freeLanePort(layout, Object.values(readRoster(stateDir, stack).entries), tried);
    tried.add(port);
    const servers = pickServers(layout, mcps);
    const spec: HostSpec = {
      stack,
      stateDir,
      name: req.name,
      kind: "lane",
      role: "lane",
      roleFiles: roleFiles(layout, "lane"),
      agent,
      engine,
      ...(model !== undefined ? { model } : {}),
      mcps: [...mcps],
      ...(servers ? { mcpServers: servers } : {}),
      port,
      ...(engine === "opencode" ? { enginePort: port + 500 } : {}),
      cwd: req.cwd ?? layout.cwd ?? launcher?.cwd ?? process.cwd(),
      runId: randomUUID(),
      ...(launcher ? { parentRunId: launcher.runId } : {}),
      launchedBy: req.launchedBy,
      brief:
        `You are lane ${req.name}. Report to ${reportTo} when done or blocked.` +
        (req.brief && req.brief.trim() !== "" ? `\n\n${req.brief.trim()}\n\n` : " ") +
        "Your goal follows.",
      goal,
      ...(budgetUsd !== undefined ? { budgetUsd } : {}),
    };
    let s: Started;
    try {
      s = await startHost(stateDir, stack, spec);
    } catch (e) {
      lastErr = e;
      if (/already in use/.test(errText(e))) continue; // raced another lane for the port
      throw e;
    }
    writeSpawnPid(stateDir, stack, spec.name, s.spawnPid);
    const entry = entryFrom(s, {});
    await putEntry(stateDir, stack, entry);
    appendLanesLog(stateDir, stack, { event: "start", name: req.name, by: req.launchedBy, goal, runId: spec.runId, port });
    const t = readStackTerminal(stateDir, stack);
    const drv = await driverFor(t);
    if (drv) {
      try {
        const id = await openLaneWindow(drv, anyDeskPane(Object.values(readRoster(stateDir, stack).entries), drv.kind), entry);
        entry.terminal = { kind: drv.kind, id };
        await putEntry(stateDir, stack, entry);
      } catch {
        /* a missing pane never fails the lane; `desk attach` reopens it */
      }
    }
    return entry;
  }
  throw lastErr instanceof Error ? lastErr : new Error(`desks: could not start lane ${req.name}`);
}

/** Start a lane; with lanes.approval="decisions" and a desk launcher (not DECISIONS, not human) returns {pending}. */
export async function laneNew(o: StackOpts & LaneRequest & { brief?: string }): Promise<RosterEntry | { pending: PendingLane }> {
  const { stateDir, stack } = ctx(o);
  if (!validName(o.name, "lane")) throw new Error(`desks: invalid lane name "${o.name}" (want /^[a-z0-9][a-z0-9_-]{0,47}$/i)`);
  if (typeof o.goal !== "string" || o.goal.trim() === "") throw new Error("desks: lane goal must not be empty");
  const launchedBy = o.launchedBy || "human";
  const roster = readRoster(stateDir, stack);
  if (roster.entries[o.name]) throw new Error(`desks: name "${o.name}" is already in use in stack "${stack}"`);
  const pendingSame = readPendingLanes(stateDir, stack).find((p) => p.state === "pending" && p.request.name === o.name);
  if (pendingSame) throw new Error(`desks: lane "${o.name}" is already pending approval (${pendingSame.id})`);
  const req: LaneReq = {
    name: o.name,
    goal: o.goal,
    ...(o.brief !== undefined ? { brief: o.brief } : {}),
    ...(o.mcps !== undefined ? { mcps: o.mcps } : {}),
    ...(o.cwd !== undefined ? { cwd: o.cwd } : {}),
    ...(o.agent !== undefined ? { agent: o.agent } : {}),
    ...(o.model !== undefined ? { model: o.model } : {}),
    ...(o.budgetUsd !== undefined ? { budgetUsd: o.budgetUsd } : {}),
    launchedBy,
  };
  const layout = stackLayout(stateDir, stack);
  const dec = decisionsName(stateDir, stack);
  if (layout.lanes.approval === "decisions" && launchedBy !== "human" && launchedBy !== dec) {
    const pending: PendingLane = { id: nextPendingLaneId(stateDir, stack), request: req, requestedAt: Date.now(), state: "pending" };
    appendPendingLane(stateDir, stack, pending);
    await tryDeliver({
      stack,
      stateDir,
      from: launchedBy,
      to: dec,
      text: `Lane request ${pending.id}: ${req.name} goal: ${req.goal.slice(0, 400)}. Approve with lane_approve ${pending.id} or reject it.`,
    });
    return { pending };
  }
  return startLane(stateDir, stack, req);
}

function findPending(stateDir: string, stack: string, id: string): PendingLane {
  const p = readPendingLanes(stateDir, stack).find((x) => x.id === id);
  if (!p) throw new Error(`desks: no pending lane ${id} in stack "${stack}"`);
  if (p.state !== "pending") throw new Error(`desks: lane request ${id} is already ${p.state}`);
  return p;
}

export async function laneApprove(o: StackOpts & { id: string; by: Sender }): Promise<RosterEntry> {
  const { stateDir, stack } = ctx(o);
  const p = findPending(stateDir, stack, o.id);
  const entry = await startLane(stateDir, stack, p.request);
  appendPendingLane(stateDir, stack, { ...p, state: "approved", decidedBy: o.by, decidedAt: Date.now() });
  await tryDeliver({ stack, stateDir, from: o.by, to: p.request.launchedBy, text: `Lane request ${p.id} (${p.request.name}) approved; the lane is running.` });
  return entry;
}

export async function laneReject(o: StackOpts & { id: string; by: Sender; reason?: string }): Promise<PendingLane> {
  const { stateDir, stack } = ctx(o);
  const p = findPending(stateDir, stack, o.id);
  const next: PendingLane = { ...p, state: "rejected", decidedBy: o.by, decidedAt: Date.now(), ...(o.reason !== undefined ? { reason: o.reason } : {}) };
  appendPendingLane(stateDir, stack, next);
  await tryDeliver({
    stack,
    stateDir,
    from: o.by,
    to: p.request.launchedBy,
    text: `Lane request ${p.id} (${p.request.name}) rejected${o.reason ? `: ${o.reason}` : ""}.`,
  });
  return next;
}

/**
 * Refuses desk names. Closes the pane, stops the host, appends to lanes.log, removes from the roster.
 * A busy lane is first given `graceMs` (default LANE_STOP_GRACE_MS) to finish its turn, then
 * `settleMs` (default LANE_STOP_GOAL_SETTLE_MS) for the goal verdict to land, so a lane that just
 * sent DONE is not killed before its goal is judged. `now: true` skips both waits.
 */
export async function laneStop(o: StackOpts & { name: string; by?: Sender; now?: boolean; graceMs?: number; settleMs?: number }): Promise<{ stopped: string }> {
  const { stateDir, stack } = ctx(o);
  const e = readRoster(stateDir, stack).entries[o.name];
  if (!e) throw new Error(`desks: unknown lane "${o.name}" in stack "${stack}"`);
  if (e.kind !== "lane") throw new Error(`desks: ${o.name} is a desk, not a lane; lane_stop refuses desk names`);
  let h = await hostHealth(e.url, 1500);
  if (o.now !== true && h !== null && h.runId === e.runId && h.state === "busy") {
    const graceMs = o.graceMs ?? LANE_STOP_GRACE_MS;
    const deadline = Date.now() + graceMs;
    let idle = false;
    while (Date.now() < deadline) {
      await sleep(Math.min(250, Math.max(10, deadline - Date.now())));
      const n = await hostHealth(e.url, 1500);
      if (n === null || n.runId !== e.runId) break;
      h = n;
      if (n.state !== "busy") {
        idle = true;
        break;
      }
    }
    if (idle) {
      const isFinal = () => {
        const g = lastGoalState(stateDir, stack, e.runId);
        return g !== null && g !== "active" && g !== "none";
      };
      await waitUntil(isFinal, o.settleMs ?? LANE_STOP_GOAL_SETTLE_MS);
      h = (await hostHealth(e.url, 1500)) ?? h;
    }
  }
  const preStop = h !== null && h.runId === e.runId ? h.goal?.state ?? "none" : "dead";
  await closePane(readStackTerminal(stateDir, stack), e.terminal);
  await stopEntry(stateDir, stack, e);
  // The goal plugin can report its verdict while the host is stopping (after the /health read above):
  // the host's events file is complete, so its last goal event is the final state.
  const goalState = lastGoalState(stateDir, stack, e.runId) ?? preStop;
  appendLanesLog(stateDir, stack, { event: "stop", name: o.name, by: o.by ?? "human", goalState, runId: e.runId, entry: e });
  await removeEntry(stateDir, stack, o.name);
  return { stopped: o.name };
}

/** A row for a lane that was stopped (lanes.log has a stop entry, the roster no longer has it). */
function stoppedLaneRow(stateDir: string, stack: string, name: string): RosterRow | null {
  const log = readLanesLog(stateDir, stack).filter((l) => l.name === name);
  const stop = [...log].reverse().find((l) => l.event === "stop");
  if (!stop) return null;
  const start = [...log].reverse().find((l) => l.event === "start" && l.runId === stop.runId);
  const snap = stop.entry as RosterEntry | undefined;
  const runId = String(stop.runId ?? "");
  const base: RosterEntry = snap ?? {
    name,
    kind: "lane",
    role: "lane",
    agent: "-",
    engine: "opencode",
    mcps: [],
    port: typeof start?.port === "number" ? start.port : 0,
    url: "",
    pid: 0,
    runId,
    cwd: "",
    startedAt: typeof start?.at === "number" ? start.at : 0,
    ...(typeof start?.goal === "string" ? { goal: start.goal.slice(0, 400) } : {}),
    ...(typeof start?.by === "string" ? { launchedBy: start.by } : {}),
  };
  let costUsd: number | null = null;
  try {
    const rec = listRunRecords(stateDir).find((r) => r.runId === runId);
    if (rec) costUsd = recordCost(rec);
  } catch {
    /* no registry */
  }
  // The events file wins over a log entry written before laneStop read it after the stop.
  return { ...base, state: "stopped", queueDepth: 0, goalState: lastGoalState(stateDir, stack, runId) ?? (stop.goalState as RosterRow["goalState"]), costUsd, treeCostUsd: costUsd };
}

export async function laneStatus(o: StackOpts & { name?: string } = {}): Promise<RosterView["rows"]> {
  const v = await deskRoster(o);
  const lanes = v.rows.filter((r) => r.kind === "lane");
  if (o.name === undefined) return lanes;
  const one = lanes.filter((r) => r.name === o.name);
  if (one.length === 0) {
    if (v.rows.some((r) => r.name === o.name)) throw new Error(`desks: ${o.name} is a desk, not a lane`);
    const ended = stoppedLaneRow(ctx(o).stateDir, v.stack, o.name);
    if (ended) return [ended];
    throw new Error(`desks: unknown lane "${o.name}" in stack "${v.stack}"`);
  }
  return one;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

function getDecision(stateDir: string, stack: string, id: string): Decision {
  const d = readDecisions(stateDir, stack).find((x) => x.id === id);
  if (!d) throw new Error(`desks: no decision ${id} in stack "${stack}"`);
  return d;
}

export async function decisionOpen(
  o: StackOpts & { question: string; options: DecisionOption[]; askedBy: Sender; openedBy: Sender },
): Promise<Decision> {
  const { stateDir, stack } = ctx(o);
  if (typeof o.question !== "string" || o.question.trim() === "") throw new Error("desks: decision question must not be empty");
  if (!Array.isArray(o.options)) throw new Error("desks: decision options must be an array");
  for (const op of o.options) if (!op || typeof op.label !== "string" || op.label === "") throw new Error("desks: every decision option needs a label");
  // Recommended options first (stable).
  const options = [...o.options.filter((x) => x.recommended), ...o.options.filter((x) => !x.recommended)];
  const decision = {
    id: nextDecisionId(stateDir, stack),
    question: o.question,
    options,
    askedBy: o.askedBy,
    openedBy: o.openedBy,
    openedAt: Date.now(),
  };
  appendDecisionEvent(stateDir, stack, { type: "open", decision });
  // DECISIONS owns the list (guide section 6): a decision opened by anyone else is relayed to it.
  const dec = decisionsName(stateDir, stack);
  if (o.openedBy !== dec) {
    await tryDeliver({ stack, stateDir, from: o.openedBy, to: dec, text: `Decision ${decision.id} opened (asked by ${o.askedBy}): ${o.question}` });
  }
  return getDecision(stateDir, stack, decision.id);
}

/** Records the answer and delivers it (from the answerer) to askedBy and, when different, to DECISIONS. */
export async function decisionAnswer(o: StackOpts & { id: string; text: string; by: Sender }): Promise<Decision> {
  const { stateDir, stack } = ctx(o);
  const d = getDecision(stateDir, stack, o.id);
  if (d.state === "closed") throw new Error(`desks: decision ${o.id} is closed`);
  if (typeof o.text !== "string" || o.text.trim() === "") throw new Error("desks: answer text must not be empty");
  appendDecisionEvent(stateDir, stack, { type: "answer", id: o.id, text: o.text, by: o.by, at: Date.now() });
  const text = `Answer to ${d.id} (${d.question.slice(0, 200)}): ${o.text}`;
  await tryDeliver({ stack, stateDir, from: o.by, to: d.askedBy, text });
  const dec = decisionsName(stateDir, stack);
  if (dec !== d.askedBy) await tryDeliver({ stack, stateDir, from: o.by, to: dec, text });
  return getDecision(stateDir, stack, o.id);
}

export async function decisionClose(o: StackOpts & { id: string; by: Sender; reason?: string }): Promise<Decision> {
  const { stateDir, stack } = ctx(o);
  const d = getDecision(stateDir, stack, o.id);
  if (d.state === "closed") return d;
  appendDecisionEvent(stateDir, stack, { type: "close", id: o.id, by: o.by, at: Date.now(), ...(o.reason !== undefined ? { reason: o.reason } : {}) });
  return getDecision(stateDir, stack, o.id);
}

export async function decisionList(o: StackOpts & { state?: Decision["state"] } = {}): Promise<Decision[]> {
  const { stateDir, stack } = ctx(o);
  const all = readDecisions(stateDir, stack);
  return o.state === undefined ? all : all.filter((d) => d.state === o.state);
}

// ---------------------------------------------------------------------------
// Costs
// ---------------------------------------------------------------------------

/** Own cost + every lane below it. null when nothing in the tree has a record. */
function treeCost(r: DeskCostRow): number | null {
  if (r.costUsd === null) return null;
  let sum = r.costUsd;
  for (const l of r.lanes) {
    const c = treeCost(l);
    if (c === null) return null; // any unknown part makes the tree total unknown, never a partial sum
    sum += c;
  }
  return sum;
}

/**
 * A record's own cost, or null when it is unknown. The meter writes 0 for usage it could not price
 * (RunRecord.totals.costUsd is a required number): costUnpriced marks those; records written before
 * the flag (desk host, tokens seen, 0 cost, no costSource) are treated the same.
 */
function recordCost(rec: RunRecord): number | null {
  const t = rec.totals;
  if (!t) return null;
  if (t.costUnpriced === true) return null;
  const tokens = t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;
  if (t.costUsd === 0 && tokens > 0 && t.costSource === undefined && rec.producer === "ach-desk-host") return null;
  return t.costUsd;
}

/** Cost per desk and per lane tree, from the run registry. */
export async function deskCosts(o: StackOpts = {}): Promise<DeskCostRow[]> {
  const { stateDir, stack } = ctx(o);
  // Cost rule (orchestrator, 92f0746 on feat/desks-and-lanes): a desk/lane's OWN cost is its
  // own RunRecord totals only. The host meter already adds each driver-engine turn's usage
  // into the desk's totals, so child runs with desk.kind "turn" are NEVER added (that would
  // count the same spend twice). A launcher's tree total = its own totals plus the lane runs
  // (desk.kind "lane") whose parentRunId chain points at it (treeCost over `lanes`).
  let records: RunRecord[] = [];
  try {
    records = listRunRecords(stateDir).filter((r) => r.desk?.stack === stack);
  } catch {
    records = [];
  }
  const byId = new Map(records.map((r) => [r.runId, r]));
  const lanesByParent = new Map<string, RunRecord[]>();
  for (const r of records) {
    if (r.desk?.kind !== "lane" || !r.parentRunId) continue;
    const list = lanesByParent.get(r.parentRunId) ?? [];
    list.push(r);
    lanesByParent.set(r.parentRunId, list);
  }
  const roster = readRoster(stateDir, stack);
  const live = Object.values(roster.entries);
  const liveIds = new Set(live.map((e) => e.runId));

  const row = (runId: string, name: string, kind: RosterEntry["kind"], parentRunId: string | undefined, seen: Set<string>): DeskCostRow => {
    seen.add(runId);
    const rec = byId.get(runId);
    const lanes = (lanesByParent.get(runId) ?? [])
      .filter((l) => !seen.has(l.runId))
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((l) => row(l.runId, l.desk?.name ?? l.runId, "lane", runId, seen));
    // Live lanes launched by this run but without a record yet (fake engine / not metered).
    for (const e of live) {
      if (e.kind === "lane" && e.parentRunId === runId && !seen.has(e.runId)) lanes.push(row(e.runId, e.name, "lane", runId, seen));
    }
    return {
      name,
      kind,
      runId,
      ...(parentRunId !== undefined ? { parentRunId } : {}),
      costUsd: rec ? recordCost(rec) : null,
      inputTokens: rec?.totals?.inputTokens ?? 0,
      outputTokens: rec?.totals?.outputTokens ?? 0,
      lanes,
    };
  };

  const seen = new Set<string>();
  const out: DeskCostRow[] = [];
  // Desks first, then lanes whose launcher is not a live roster entry (human-launched or orphaned).
  for (const e of live.filter((x) => x.kind === "desk").sort((a, b) => a.port - b.port)) out.push(row(e.runId, e.name, "desk", undefined, seen));
  for (const e of live.filter((x) => x.kind === "lane").sort((a, b) => a.port - b.port)) {
    if (seen.has(e.runId)) continue;
    if (e.parentRunId && liveIds.has(e.parentRunId)) continue; // nested above
    out.push(row(e.runId, e.name, "lane", e.parentRunId, seen));
  }
  // Stopped lanes (gone from the roster) keep their spend: top-level unless a launcher row above already holds them.
  const laneRecs = records.filter((r) => r.desk?.kind === "lane").sort((a, b) => a.startedAt - b.startedAt);
  for (const r of laneRecs) {
    if (seen.has(r.runId)) continue;
    const parent = r.parentRunId ? byId.get(r.parentRunId) : undefined;
    if (parent?.desk?.kind === "lane" && !seen.has(parent.runId)) continue; // nested when its parent lane is emitted
    out.push(row(r.runId, r.desk?.name ?? r.runId, "lane", r.parentRunId, seen));
  }
  return out;
}

/** The stack name to use: explicit, else $ACH_DESK_STACK, else <stateDir>/desks/active-stack, else "default". */
export function resolveStack(o: StackOpts = {}): string {
  if (o.stack) return o.stack;
  const env = process.env.ACH_DESK_STACK;
  if (env) return env;
  const f = activeStackFile(o.stateDir ?? defaultStateDir());
  try {
    const s = readFileSync(f, "utf8").trim();
    if (s) return s;
  } catch {
    /* none */
  }
  return "default";
}
