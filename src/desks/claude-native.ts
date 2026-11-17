// Claude-native peers (#204, alternative take; see docs/DESKS-CLAUDE-NATIVE.md).
//
// Launches named Claude Code background sessions, finds them through Claude's own
// roster, messages them through their inbox socket and meters them from their transcript.
// No ach-owned host process or bus: Claude Code already queues inbox messages until the
// current turn ends, keeps background sessions alive without a terminal, and records
// every session as a transcript whose path follows from its id.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { HarnessError } from "../core/types.ts";
import { parseClaudeSession } from "../monitors/transcripts.ts";

export interface ExecResult { code: number; stdout: string; stderr: string }

/** Everything that touches the machine, injectable for tests. */
export interface PeerDeps {
  exec(file: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<ExecResult>;
  /** ~/.claude, or CLAUDE_CONFIG_DIR. */
  claudeHome: string;
  alive(pid: number): boolean;
  kill(pid: number): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  post(socketPath: string, line: string): Promise<void>;
}

export interface PeerSession {
  pid: number;
  sessionId: string;
  name: string | null;
  kind: string;
  status: string;
  cwd: string | null;
  jobId: string | null;
  socket: string | null;
  /** Absolute transcript path, or null when Claude has not written one yet. */
  transcript: string | null;
  /** Set when this bg job is Claude's exit handoff of an older session (jobs/<id>/adopt.json, origin "exit"). */
  handoff: { liveShellPids: number[] } | null;
}

export interface LaneRecord {
  name: string;
  sessionId: string;
  jobId: string | null;
  pid: number;
  cwd: string;
  model: string;
  goal: string;
  startedAt: string;
  after?: string;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function checkName(name: string): string {
  if (!NAME_RE.test(name)) throw new HarnessError(`invalid peer name '${name}' (letters, digits, . _ -; max 64)`, "USAGE");
  return name;
}

export function defaultDeps(): PeerDeps {
  return {
    exec: (file, args, opts) =>
      new Promise((resolve) => {
        const child = spawn(file, args, { cwd: opts?.cwd, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "", stderr = "";
        const t = setTimeout(() => child.kill("SIGTERM"), opts?.timeoutMs ?? 60_000);
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("error", (e) => { clearTimeout(t); resolve({ code: 127, stdout, stderr: stderr + String(e) }); });
        child.on("close", (code) => { clearTimeout(t); resolve({ code: code ?? 1, stdout, stderr }); });
      }),
    claudeHome: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
    alive: (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } },
    kill: (pid) => { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    post: postLine,
  };
}

/** Write one JSON line to a Unix socket and close. Claude closes idle connections after 30 s. */
export function postLine(socketPath: string, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(socketPath);
    const t = setTimeout(() => { s.destroy(); reject(new HarnessError(`inbox ${socketPath}: timed out`, "PEER_SEND")); }, 10_000);
    s.on("error", (e) => { clearTimeout(t); reject(new HarnessError(`inbox ${socketPath}: ${e.message}`, "PEER_SEND")); });
    s.on("connect", () => s.end(line.endsWith("\n") ? line : line + "\n"));
    s.on("close", () => { clearTimeout(t); resolve(); });
  });
}

function findTranscript(claudeHome: string, sessionId: string): string | null {
  const root = path.join(claudeHome, "projects");
  let dirs: string[];
  try { dirs = readdirSync(root); } catch { return null; }
  for (const d of dirs) {
    const p = path.join(root, d, `${sessionId}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
}

function normalizeKind(k: string | null): string {
  if (k === null) return "unknown";
  return k === "background" ? "bg" : k;
}

/** Holders that are exit handoffs still running adopted shells, for error messages. */
export function describeHandoffs(ss: PeerSession[]): string {
  return ss.filter((s) => s.handoff && s.handoff.liveShellPids.length > 0)
    .map((s) => `exit handoff job ${s.jobId ?? s.sessionId.slice(0, 8)} (pid ${s.pid}) still runs shell pid(s) ${s.handoff!.liveShellPids.join(", ")}`)
    .join("; ");
}

/**
 * Claude's exit handoff: when a session exits with background shells still running, Claude moves it into a bg job
 * that keeps the session's name and adopts those shells (jobs/<id>/adopt.json). It looks like an empty spare
 * (kind bg, status shell, no transcript of its own) but may carry live work, such as a watch loop.
 */
function readHandoff(deps: PeerDeps, jobId: string): PeerSession["handoff"] {
  try {
    const a = JSON.parse(readFileSync(path.join(deps.claudeHome, "jobs", jobId, "adopt.json"), "utf8"));
    if (a?.origin !== "exit") return null;
    const pids = Array.isArray(a.shells) ? a.shells.map((x: { pid?: unknown }) => x?.pid).filter((x: unknown): x is number => typeof x === "number") : [];
    return { liveShellPids: pids.filter((x: number) => deps.alive(x)) };
  } catch { return null; }
}

/**
 * Every live Claude session: `claude agents --json` (the supported roster) joined by pid
 * with ~/.claude/sessions/<pid>.json, which adds the socket and job id. A session file
 * whose pid is gone is ignored; a roster row without a file still counts.
 */
export async function listSessions(deps: PeerDeps): Promise<PeerSession[]> {
  const files = new Map<number, Record<string, unknown>>();
  const dir = path.join(deps.claudeHome, "sessions");
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { /* no sessions dir yet */ }
  for (const f of names) {
    const m = /^(\d+)\.json$/.exec(f);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!deps.alive(pid)) continue;
    try { files.set(pid, JSON.parse(readFileSync(path.join(dir, f), "utf8"))); } catch { /* half-written */ }
  }
  const r = await deps.exec("claude", ["agents", "--json"], { timeoutMs: 20_000 });
  let rows: Record<string, unknown>[] = [];
  if (r.code === 0) {
    try { rows = JSON.parse(r.stdout); } catch { rows = []; }
  }
  const byPid = new Map<number, Record<string, unknown>>();
  for (const row of rows) if (typeof row.pid === "number") byPid.set(row.pid, row);
  for (const [pid, f] of files) if (!byPid.has(pid)) byPid.set(pid, f);
  const out: PeerSession[] = [];
  for (const [pid, row] of byPid) {
    const f = files.get(pid) ?? {};
    const sessionId = String(row.sessionId ?? f.sessionId ?? "");
    if (!sessionId) continue;
    const str = (k: string) => (typeof (row[k] ?? f[k]) === "string" ? String(row[k] ?? f[k]) : null);
    // kind and status come from the session file first: the roster says "background" where the file says "bg",
    // and reports "busy" for a session whose file says "shell" (the spare signature lives only in the file).
    const fileFirst = (k: string) => (typeof f[k] === "string" ? String(f[k]) : str(k));
    out.push({
      pid,
      sessionId,
      name: str("name"),
      kind: normalizeKind(fileFirst("kind")),
      status: fileFirst("status") ?? "unknown",
      cwd: str("cwd"),
      jobId: typeof f.jobId === "string" ? f.jobId : null,
      socket: typeof f.messagingSocketPath === "string" ? f.messagingSocketPath : null,
      transcript: findTranscript(deps.claudeHome, sessionId),
      handoff: typeof f.jobId === "string" ? readHandoff(deps, f.jobId) : null,
    });
  }
  return out.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "") || a.pid - b.pid);
}

/**
 * A background session holding a name but doing no work. Seen for real: a desk exited with a
 * watch loop running, Claude's exit handoff moved it into a bg job under the same name, and
 * that job blocked the relaunch (duplicate name) and fooled a wait-for-exit loop. It is only
 * "empty" when none of the shells it adopted are still running; otherwise stopping it would
 * kill live work, so it still counts as live.
 */
export function isEmptySpare(s: PeerSession): boolean {
  if (s.kind !== "bg" || s.status !== "shell" || s.transcript !== null) return false;
  return !s.handoff || s.handoff.liveShellPids.length === 0;
}

export function holders(sessions: PeerSession[], name: string): { live: PeerSession[]; spares: PeerSession[] } {
  const named = sessions.filter((s) => s.name === name);
  return { live: named.filter((s) => !isEmptySpare(s)), spares: named.filter(isEmptySpare) };
}

export async function stopSession(deps: PeerDeps, s: PeerSession): Promise<void> {
  if (s.jobId) await deps.exec("claude", ["stop", s.jobId], { timeoutMs: 20_000 });
  if (deps.alive(s.pid)) deps.kill(s.pid);
}

/** The text a peer reads. The prefix tells it who wrote, since Claude labels socket posts only as "another session". */
export function envelope(from: string, text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: `[peer-msg from ${from}] ${text}` } });
}

export async function sendTo(deps: PeerDeps, to: string, from: string, text: string): Promise<PeerSession> {
  const { live } = holders(await listSessions(deps), to);
  if (live.length === 0) throw new HarnessError(`no live Claude session named '${to}'`, "PEER_SEND");
  if (live.length > 1) throw new HarnessError(`${live.length} live sessions are named '${to}' (pids ${live.map((s) => s.pid).join(", ")}); stop one first`, "PEER_SEND");
  const target = live[0]!;
  if (!target.socket) throw new HarnessError(`'${to}' (pid ${target.pid}) has no inbox socket; cross-session messaging is off there`, "PEER_SEND");
  await deps.post(target.socket, envelope(from, text));
  return target;
}

export interface LaunchOptions {
  name: string;
  goal: string;
  cwd: string;
  model: string;
  /** Pass --dangerously-skip-permissions. */
  bypass: boolean;
  disallowedTools: string[];
  reportTo?: string;
  /** How long to wait for the session to register. */
  registerTimeoutMs?: number;
}

/** The first prompt: the goal plus the reporting contract. */
export function lanePrompt(o: Pick<LaunchOptions, "name" | "goal" | "reportTo">): string {
  const report = o.reportTo
    ? `\n\nWhen the goal is met, blocked or stopped, send one short report to the session named ${o.reportTo} with SendMessage: done/blocked/stopped, the evidence, and anything that needs a decision.`
    : "";
  return `You are ${o.name}, a lane with one goal. Work until it is met or you are blocked.\n\nGoal:\n${o.goal}${report}`;
}

export function launchArgs(o: LaunchOptions): string[] {
  const args = ["--bg", "-n", o.name, "--model", o.model];
  if (o.bypass) args.push("--dangerously-skip-permissions");
  if (o.disallowedTools.length > 0) args.push(`--disallowed-tools=${o.disallowedTools.join(",")}`);
  // A bypass session holds messages it can't classify; accept them so ach's own posts land.
  args.push("--settings", JSON.stringify({ crossSessionInbound: "accept" }));
  args.push(lanePrompt(o));
  return args;
}

/**
 * Start a lane as a Claude background session, then prove it registered under the name.
 * `--bg` ignores --session-id, so the id is read back from the roster, not chosen.
 */
export async function launchLane(deps: PeerDeps, o: LaunchOptions, lanesDir: string, after?: string): Promise<LaneRecord> {
  checkName(o.name);
  const before = holders(await listSessions(deps), o.name);
  for (const s of before.spares) await stopSession(deps, s);
  if (before.live.length > 0) {
    const ho = describeHandoffs(before.live);
    throw new HarnessError(`a Claude session named '${o.name}' is already live (pid ${before.live.map((s) => s.pid).join(", ")})${ho ? `: ${ho}; stop or move those shells, then retry` : "; stop it or pick another name"}`, "PEER_DUPLICATE");
  }
  const r = await deps.exec("claude", launchArgs(o), { cwd: o.cwd, timeoutMs: 90_000 });
  if (r.code !== 0) throw new HarnessError(`claude --bg failed (${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 400)}`, "PEER_LAUNCH");
  const jobId = /claude stop (\S+)/.exec(r.stdout)?.[1] ?? null;
  const deadline = deps.now() + (o.registerTimeoutMs ?? 45_000);
  let found: PeerSession | undefined;
  while (deps.now() < deadline) {
    const live = holders(await listSessions(deps), o.name).live;
    found = live.find((s) => (jobId ? s.jobId === jobId || s.sessionId.startsWith(jobId) : s.kind === "bg"));
    if (found) break;
    await deps.sleep(1500);
  }
  if (!found) throw new HarnessError(`'${o.name}' did not register as a live session within ${(o.registerTimeoutMs ?? 45_000) / 1000}s (job ${jobId ?? "?"})`, "PEER_LAUNCH");
  const rec: LaneRecord = {
    name: o.name, sessionId: found.sessionId, jobId: found.jobId ?? jobId, pid: found.pid, cwd: o.cwd,
    model: o.model, goal: o.goal, startedAt: new Date(deps.now()).toISOString(), ...(after ? { after } : {}),
  };
  await fs.mkdir(lanesDir, { recursive: true });
  await fs.writeFile(path.join(lanesDir, `${o.name}.json`), JSON.stringify(rec, null, 2) + "\n");
  return rec;
}

/**
 * Wait until no live (non-spare) session holds `target`, then launch. Meant to run in a
 * detached process armed before the predecessor exits, so no tab cleanup can close it.
 */
export async function launchAfter(
  deps: PeerDeps, target: string, o: LaunchOptions, lanesDir: string, timeoutMs: number, log: (s: string) => void,
): Promise<LaneRecord> {
  const deadline = deps.now() + timeoutMs;
  log(`waiting for '${target}' to exit (max ${Math.round(timeoutMs / 60_000)} min)`);
  for (;;) {
    const h = holders(await listSessions(deps), target);
    if (h.live.length === 0) break;
    // The predecessor's conversation is over once only exit handoffs hold its name; they carry its leftover
    // bg shells, not the session itself. Launch, and say what is still running.
    if (h.live.every((s) => s.handoff !== null)) {
      log(`'${target}' exited into an exit handoff: ${describeHandoffs(h.live) || "no live shells"}`);
      break;
    }
    if (deps.now() >= deadline) throw new HarnessError(`'${target}' still live after ${Math.round(timeoutMs / 60_000)} min`, "PEER_AFTER");
    await deps.sleep(5000);
  }
  log(`'${target}' is gone; launching '${o.name}'`);
  const rec = await launchLane(deps, o, lanesDir, target);
  log(`launched '${o.name}' pid ${rec.pid} session ${rec.sessionId}`);
  return rec;
}

export interface LaneStatus {
  record: LaneRecord;
  live: boolean;
  status: string;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; turns: number };
}

export async function readLane(lanesDir: string, name: string): Promise<LaneRecord> {
  try { return JSON.parse(await fs.readFile(path.join(lanesDir, `${checkName(name)}.json`), "utf8")); }
  catch { throw new HarnessError(`no lane record for '${name}' in ${lanesDir}`, "PEER_UNKNOWN"); }
}

export async function laneStatus(deps: PeerDeps, lanesDir: string, name: string): Promise<LaneStatus> {
  const record = await readLane(lanesDir, name);
  const s = (await listSessions(deps)).find((x) => x.sessionId === record.sessionId);
  const t = findTranscript(deps.claudeHome, record.sessionId);
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };
  if (t) {
    for (const r of await parseClaudeSession(path.dirname(t), record.sessionId)) {
      tokens.input += r.input; tokens.output += r.output; tokens.cacheRead += r.cacheRead; tokens.cacheWrite += r.cacheWrite; tokens.turns++;
    }
  }
  return { record, live: s !== undefined, status: s?.status ?? "exited", tokens };
}
