// `ach desk` / `ach lane` (#204, Claude-native take): thin CLI over src/desks/claude-native.ts.
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { HarnessError } from "../core/types.ts";
import { stateDir } from "../core/store.ts";
import {
  checkName, defaultDeps, isEmptySpare, launchAfter, launchLane, laneStatus, listSessions, readLane, sendTo,
  stopSession, type LaunchOptions, type PeerDeps,
} from "../desks/claude-native.ts";

export const DESK_USAGE = `usage: ach desk roster [--json]
       ach desk send <to> <text...> [--from <name>]

  roster  every live Claude session by name, from 'claude agents --json' joined with
          ~/.claude/sessions; marks empty bg spares and exit handoffs
  send    post <text> to the named session's inbox socket; Claude queues it until
          the current turn ends. Fails when 0 or 2+ live sessions hold the name.`;

export const LANE_USAGE = `usage: ach lane new <name> (--goal <text> | --goal-file <path>) [--cwd <dir>] [--model <m>]
                [--report-to <name>] [--no-bypass] [--after <name>] [--after-timeout <min>] [--json]
       ach lane status [<name>] [--json]
       ach lane stop <name>

  new     start a Claude background session (claude --bg) named <name> whose first prompt
          is the goal; refuses a name a live session holds, stops an empty spare holding it,
          waits for it to register and records it under <stateDir>/lanes/<name>.json.
          --after <name>: return at once and launch from a detached waiter (no terminal)
          once no live session holds <name>; log in <stateDir>/lanes/<name>.after.log.
  status  lane records with live/exited and tokens read from the lane's transcript
  stop    claude stop + SIGTERM for the live session recorded for <name>`;

const lanesDir = () => path.join(stateDir(), "lanes");

export async function cmdDesk(rest: string[], deps: PeerDeps = defaultDeps(), out: (s: string) => void = console.log): Promise<number> {
  const [sub, ...args] = rest;
  if (sub === "roster") {
    const a = parseArgs({ args, options: { json: { type: "boolean", default: false } } });
    const sessions = await listSessions(deps);
    if (a.values.json) { out(JSON.stringify(sessions, null, 2)); return 0; }
    for (const s of sessions) {
      const tag = isEmptySpare(s) ? " (empty spare)" : s.handoff ? ` (exit handoff, shells ${s.handoff.liveShellPids.join(",") || "none"})` : "";
      out(`${(s.name ?? "-").padEnd(28)} ${String(s.pid).padEnd(7)} ${s.kind.padEnd(12)} ${s.status.padEnd(7)} ${s.sessionId.slice(0, 8)}${s.socket ? "" : " no-inbox"}${tag}`);
    }
    return 0;
  }
  if (sub === "send") {
    const a = parseArgs({ args, allowPositionals: true, options: { from: { type: "string", default: "human" } } });
    const [to, ...words] = a.positionals;
    if (!to || words.length === 0) throw new HarnessError(DESK_USAGE, "USAGE");
    const t = await sendTo(deps, to, a.values.from!, words.join(" "));
    out(`sent to ${to} (pid ${t.pid}); it lands when the current turn ends`);
    return 0;
  }
  throw new HarnessError(DESK_USAGE, "USAGE");
}

export async function cmdLane(rest: string[], deps: PeerDeps = defaultDeps(), out: (s: string) => void = console.log): Promise<number> {
  const [sub, ...args] = rest;
  if (sub === "new") {
    const a = parseArgs({
      args, allowPositionals: true,
      options: {
        goal: { type: "string" }, "goal-file": { type: "string" }, cwd: { type: "string" }, model: { type: "string", default: "opus" },
        "report-to": { type: "string" }, "no-bypass": { type: "boolean", default: false }, after: { type: "string" },
        "after-timeout": { type: "string", default: "60" }, "wait-for": { type: "string" }, json: { type: "boolean", default: false },
      },
    });
    const name = checkName(a.positionals[0] ?? "");
    const v = a.values;
    if (!v.goal === !v["goal-file"]) throw new HarnessError("lane new: pass exactly one of --goal or --goal-file", "USAGE");
    const goal = v.goal ?? `Read ${path.resolve(v["goal-file"]!)} and meet the goal it describes; the file wins over anything else.`;
    const o: LaunchOptions = {
      name, goal, cwd: path.resolve(v.cwd ?? process.cwd()), model: v.model!, bypass: !v["no-bypass"],
      disallowedTools: ["AskUserQuestion"], ...(v["report-to"] ? { reportTo: checkName(v["report-to"]) } : {}),
    };
    const timeoutMs = Number(v["after-timeout"]) * 60_000;
    if (!(timeoutMs > 0)) throw new HarnessError("--after-timeout must be minutes > 0", "USAGE");
    if (v["wait-for"]) {
      // the detached waiter itself
      const rec = await launchAfter(deps, checkName(v["wait-for"]), o, lanesDir(), timeoutMs, (s) => out(`${new Date().toISOString()} ${s}`));
      out(JSON.stringify(rec));
      return 0;
    }
    if (v.after) {
      checkName(v.after);
      mkdirSync(lanesDir(), { recursive: true });
      const log = path.join(lanesDir(), `${name}.after.log`);
      const fd = openSync(log, "a");
      const self = [...process.execArgv, process.argv[1]!, "lane", "new", ...args.filter((x, i) => x !== "--after" && args[i - 1] !== "--after"), "--wait-for", v.after];
      const child = spawn(process.execPath, self, { detached: true, stdio: ["ignore", fd, fd], cwd: o.cwd });
      child.unref();
      closeSync(fd);
      out(`armed: '${name}' launches once '${v.after}' exits (waiter pid ${child.pid}, max ${v["after-timeout"]} min); log ${log}`);
      return 0;
    }
    const rec = await launchLane(deps, o, lanesDir());
    out(v.json ? JSON.stringify(rec, null, 2) : `launched lane ${name}: pid ${rec.pid}, session ${rec.sessionId}, job ${rec.jobId ?? "-"}`);
    return 0;
  }
  if (sub === "status") {
    const a = parseArgs({ args, allowPositionals: true, options: { json: { type: "boolean", default: false } } });
    const names = a.positionals.length > 0 ? a.positionals : await listLaneNames();
    const rows = [];
    for (const n of names) rows.push(await laneStatus(deps, lanesDir(), n));
    if (a.values.json) { out(JSON.stringify(rows, null, 2)); return 0; }
    for (const r of rows) {
      const t = r.tokens;
      out(`${r.record.name.padEnd(28)} ${(r.live ? r.status : "exited").padEnd(7)} turns ${t.turns}  in ${t.input}  out ${t.output}  cache r/w ${t.cacheRead}/${t.cacheWrite}`);
    }
    return 0;
  }
  if (sub === "stop") {
    const name = checkName(args[0] ?? "");
    const rec = await readLane(lanesDir(), name);
    const s = (await listSessions(deps)).find((x) => x.sessionId === rec.sessionId);
    if (!s) { out(`${name} is not running`); return 0; }
    await stopSession(deps, s);
    out(`stopped ${name} (pid ${s.pid})`);
    return 0;
  }
  throw new HarnessError(LANE_USAGE, "USAGE");
}

async function listLaneNames(): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  try { return (await readdir(lanesDir())).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort(); }
  catch { return []; }
}

