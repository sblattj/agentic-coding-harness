// Live-run registry (#195): how other processes find an interactive run's PTY.
//
// The PTY lives in the `ach run --interactive` process. It listens on a
// per-run Unix socket and drops <stateDir>/live/<runId>.json naming it;
// `ach web` and `ach attach` read that file to connect. The file is removed
// when the run ends; a crashed owner leaves one behind, which readers skip
// because its pid is gone.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface LiveRunInfo {
  runId: string;
  sessionId: string;
  agent: string;
  /** Owner (`ach run`) process id. */
  pid: number;
  /** Unix socket path of the PTY relay. */
  socket: string;
  cwd: string;
  startedAt: number;
  model?: string;
}

export function liveDir(stateDir: string): string {
  return path.join(stateDir, "live");
}

/**
 * Socket directory. Unix socket paths are capped near 104 bytes on macOS, and
 * a state dir under a long home or $TMPDIR can blow that, so sockets go in a
 * short per-user dir under /tmp (or AGENTIC_CODING_HARNESS_LIVE_SOCKET_DIR).
 */
export function liveSocketDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AGENTIC_CODING_HARNESS_LIVE_SOCKET_DIR;
  if (override !== undefined && override !== "") return override;
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const base = process.platform === "win32" ? os.tmpdir() : "/tmp";
  return path.join(base, `ach-live-${uid}`);
}

export function liveSocketPath(runId: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = liveSocketDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* not ours to fix */
  }
  const short = runId.replace(/[^A-Za-z0-9]/g, "").slice(0, 16) || "run";
  if (process.platform === "win32") return `\\\\.\\pipe\\ach-live-${short}`;
  return path.join(dir, `${short}.sock`);
}

export function writeLiveInfo(stateDir: string, info: LiveRunInfo): string {
  const dir = liveDir(stateDir);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${info.runId}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(info, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  return file;
}

export function removeLiveInfo(stateDir: string, runId: string): void {
  rmSync(path.join(liveDir(stateDir), `${runId}.json`), { force: true });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseInfo(file: string): LiveRunInfo | null {
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as Partial<LiveRunInfo>;
    if (typeof j.runId !== "string" || typeof j.socket !== "string" || typeof j.pid !== "number") return null;
    return j as LiveRunInfo;
  } catch {
    return null;
  }
}

/** The live entry for a run, or null when there is none or its owner is gone. */
export function readLiveInfo(stateDir: string, runId: string): LiveRunInfo | null {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) return null;
  const info = parseInfo(path.join(liveDir(stateDir), `${runId}.json`));
  if (info === null || !pidAlive(info.pid)) return null;
  if (process.platform !== "win32" && !existsSync(info.socket)) return null;
  return info;
}

/** Every live entry whose owner is still running, newest first. */
export function listLiveRuns(stateDir: string): LiveRunInfo[] {
  let names: string[];
  try {
    names = readdirSync(liveDir(stateDir)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out: LiveRunInfo[] = [];
  for (const n of names) {
    const info = readLiveInfo(stateDir, n.slice(0, -".json".length));
    if (info !== null) out.push(info);
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * Resolve a run id or unique prefix to a live entry. Throws a readable error
 * when nothing or several runs match.
 */
export function resolveLiveRun(stateDir: string, idOrPrefix: string): LiveRunInfo {
  const exact = readLiveInfo(stateDir, idOrPrefix);
  if (exact !== null) return exact;
  const live = listLiveRuns(stateDir);
  const hits = live.filter((r) => r.runId.startsWith(idOrPrefix) || r.sessionId.startsWith(idOrPrefix));
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) throw new Error(`'${idOrPrefix}' matches ${hits.length} live runs: ${hits.map((h) => h.runId).join(", ")}`);
  const known = live.length > 0 ? ` Live runs: ${live.map((r) => r.runId).join(", ")}` : " No interactive run is live.";
  throw new Error(`no live interactive run '${idOrPrefix}'.${known}`);
}
