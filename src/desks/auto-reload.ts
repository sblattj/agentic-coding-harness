// Automatic `desk reload` after an ach upgrade (#214 part 2).
//
// A desk host keeps the ach code it was started with. Every desk host (never a lane) polls the
// INSTALLED ach version: it runs `<achSelfArgv> --version`, which is the path the host itself was
// started from (an npm or Homebrew bin link, a compiled binary), so after an upgrade it answers the
// new version while this process still runs the old code. When the installed version is newer
// than the running one, the host waits until it is idle (no turn, nothing queued, no active goal),
// then spawns a detached `ach desk reload <name>` from that same path: the NEW ach stops this host
// and starts a fresh one on the same port and session, as a manual reload would. The host cannot
// reload itself in-process (the reload stops it), hence the detached child.
//
// Once per installed version: <stateDir>/desks/<stack>/auto-reload/<name>.json records
// {version, runId, attempts}. A fresh host that finds the record for the installed version with
// another runId was already reloaded for it and never triggers again for that version (no loop when
// the new host still reports an older version). The same host retrying (the reload was refused or
// failed) gives up after MAX_ATTEMPTS. Logs: the host log (stderr) and logs/<name>.auto-reload.log.
//
// Env: ACH_DESK_VERSION_POLL_MS (default 300000; 0 turns it off), ACH_DESK_VERSION_PROBE (a JSON
// argv printing the installed version; tests).
import { execFile, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deskPaths } from "./roster.ts";
import { achSelfArgv } from "./self.ts";
import type { HostSpec } from "./types.ts";

export const DEFAULT_VERSION_POLL_MS = 300_000;
/** A host whose own reload attempts did not replace it stops trying after this many. */
export const MAX_AUTO_RELOAD_ATTEMPTS = 3;
/** Idle must hold this long after a turn ends before the reload is spawned (a queued message usually lands first). */
const IDLE_SETTLE_MS = 1000;
/** A spawned reload normally replaces the host within seconds; only after this long is it tried again. */
const RETRY_AFTER_MS = 60_000;

/** -1, 0, 1 comparing dotted numeric versions (a pre-release tag after "-" is ignored). */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] => v.split("-")[0]!.split(".").map((x) => Number.parseInt(x, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** The poll interval from env (ms); 0 = off. */
export function versionPollMs(env: NodeJS.ProcessEnv): number {
  const raw = env.ACH_DESK_VERSION_POLL_MS;
  if (raw === undefined || raw === "") return DEFAULT_VERSION_POLL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_VERSION_POLL_MS;
}

/** The installed ach version (`<achSelfArgv> --version`, or ACH_DESK_VERSION_PROBE), or null when it cannot be read. */
export function probeInstalledVersion(env: NodeJS.ProcessEnv): Promise<string | null> {
  let argv: string[];
  try {
    const raw = env.ACH_DESK_VERSION_PROBE;
    argv = raw !== undefined && raw !== "" ? (JSON.parse(raw) as string[]) : [...achSelfArgv(env), "--version"];
  } catch {
    return Promise.resolve(null);
  }
  const [cmd, ...args] = argv;
  if (typeof cmd !== "string" || cmd === "") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf8", timeout: 20_000, env }, (err, stdout) => {
      const m = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(stdout ?? "");
      resolve(err || m === null ? null : (m[1] as string));
    });
  });
}

type Who = Pick<HostSpec, "stateDir" | "stack" | "name">;

export interface AutoReloadMark {
  /** Installed version the reload was for. */
  version: string;
  /** Host run that spawned it. */
  runId: string;
  attempts: number;
  at: number;
}

export function autoReloadMarkFile(w: Who): string {
  return join(deskPaths(w.stateDir, w.stack).root, "auto-reload", `${w.name}.json`);
}

export function readAutoReloadMark(w: Who): AutoReloadMark | null {
  try {
    const m = JSON.parse(readFileSync(autoReloadMarkFile(w), "utf8")) as Partial<AutoReloadMark>;
    return typeof m.version === "string" && typeof m.runId === "string" ? { version: m.version, runId: m.runId, attempts: Number(m.attempts) || 0, at: Number(m.at) || 0 } : null;
  } catch {
    return null;
  }
}

function writeAutoReloadMark(w: Who, m: AutoReloadMark): void {
  const f = autoReloadMarkFile(w);
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(m)}\n`);
  renameSync(tmp, f);
}

/** Spawn `ach desk reload <name> --stack <stack>` fully detached (it outlives this host, which it stops). Returns its pid. */
export function spawnAutoReload(spec: HostSpec, env: NodeJS.ProcessEnv): number | undefined {
  const [cmd, ...args] = [...achSelfArgv(env), "desk", "reload", spec.name, "--stack", spec.stack];
  const logFile = join(deskPaths(spec.stateDir, spec.stack).logs, `${spec.name}.auto-reload.log`);
  mkdirSync(dirname(logFile), { recursive: true });
  const childEnv: NodeJS.ProcessEnv = { ...env, AGENTIC_CODING_HARNESS_STATE_DIR: spec.stateDir };
  // The reload runs as the human would: never as this desk (a desk may not reload itself).
  delete childEnv.ACH_DESK_NAME;
  delete childEnv.ACH_DESK_STACK;
  const fd = openSync(logFile, "a");
  try {
    writeFileSync(fd, `${new Date().toISOString()} ${spec.name}: ${[cmd, ...args].join(" ")}\n`);
    const child = spawn(cmd as string, args, { detached: true, stdio: ["ignore", fd, fd], env: childEnv, cwd: spec.cwd });
    child.on("error", () => undefined);
    child.unref();
    return child.pid;
  } finally {
    closeSync(fd);
  }
}

export interface VersionWatcherOpts {
  spec: HostSpec;
  /** The ach version this process runs (VERSION). */
  running: string;
  pollMs: number;
  /** True when the desk may be reloaded now: idle, nothing queued, no active goal, not stopping. */
  isIdle: () => boolean;
  probe: () => Promise<string | null>;
  spawn: () => number | undefined;
  log: (line: string) => void;
  settleMs?: number;
  /** Wait this long after spawning a reload before trying again (default RETRY_AFTER_MS). */
  retryAfterMs?: number;
}

export interface VersionWatcher {
  /** The host went idle: starts the settle window every reload honors (a poll too); a waiting reload is tried once idle has held settleMs. */
  nudge(): void;
  stop(): void;
  /** One check now (tests). */
  tick(): Promise<void>;
}

/** Poll the installed version and reload this desk (once per installed version) when it is newer and the desk is idle. */
export function startVersionWatcher(o: VersionWatcherOpts): VersionWatcher {
  const settleMs = o.settleMs ?? IDLE_SETTLE_MS;
  const retryAfterMs = o.retryAfterMs ?? RETRY_AFTER_MS;
  let stopped = false;
  let running: Promise<void> | undefined;
  /** Installed version a reload is waiting for (the desk was busy). */
  let pending: string | undefined;
  /** Versions this host already logged a final word about (done or given up). */
  const settled = new Set<string>();
  let waitingLogged: string | undefined;
  let lastSpawnAt: number | undefined;
  let settleTimer: NodeJS.Timeout | undefined;
  /** When the desk last went idle (nudge); undefined = idle since this host started, no turn yet. */
  let idleSince: number | undefined;

  /** Try again once idle has held settleMs (re-armed by every nudge; a check that fires early re-arms). */
  const armSettle = (ms: number): void => {
    if (settleTimer !== undefined) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = undefined;
      if (o.isIdle()) void tick();
    }, Math.max(0, ms));
    settleTimer.unref();
  };

  const check = async (): Promise<void> => {
    const installed = pending ?? (await o.probe());
    if (stopped || installed === null) return;
    if (pending === undefined && compareVersions(installed, o.running) <= 0) return;
    if (settled.has(installed)) return;
    const mark = readAutoReloadMark(o.spec);
    if (mark !== null && mark.version === installed && mark.runId !== o.spec.runId) {
      settled.add(installed);
      pending = undefined;
      o.log(`auto-reload: already reloaded once for installed ach ${installed} (this host runs ${o.running}); not again`);
      return;
    }
    const attempts = mark !== null && mark.version === installed && mark.runId === o.spec.runId ? mark.attempts : 0;
    if (attempts >= MAX_AUTO_RELOAD_ATTEMPTS) {
      settled.add(installed);
      pending = undefined;
      o.log(`auto-reload: ${attempts} reloads for installed ach ${installed} did not replace this host; giving up (run \`ach desk reload ${o.spec.name}\`)`);
      return;
    }
    // A reload spawned earlier has not replaced this host yet: give it time before another try
    // (a refused or failed one is retried after retryAfterMs, up to MAX_AUTO_RELOAD_ATTEMPTS).
    if (lastSpawnAt !== undefined && Date.now() - lastSpawnAt < retryAfterMs) return;
    if (!o.isIdle()) {
      pending = installed;
      if (waitingLogged !== installed) {
        waitingLogged = installed;
        o.log(`auto-reload: installed ach ${installed} is newer than this host's ${o.running}; reloading once ${o.spec.name} is idle`);
      }
      return;
    }
    // Idle, but a turn ended less than settleMs ago (a poll can land right after it, before any
    // nudge timer fires): wait out the rest of the window, as nudge() does, so a message that lands
    // in it is served first.
    const wait = idleSince === undefined ? 0 : settleMs - (Date.now() - idleSince);
    if (wait > 0) {
      pending = installed;
      armSettle(wait);
      return;
    }
    pending = undefined;
    writeAutoReloadMark(o.spec, { version: installed, runId: o.spec.runId, attempts: attempts + 1, at: Date.now() });
    lastSpawnAt = Date.now();
    const pid = o.spawn();
    o.log(`auto-reload: installed ach ${installed} is newer than this host's ${o.running}; ${o.spec.name} is idle, spawned \`ach desk reload ${o.spec.name}\` (pid ${pid ?? "?"}, attempt ${attempts + 1})`);
  };

  const tick = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running !== undefined) return running;
    running = check()
      .catch((e: unknown) => o.log(`auto-reload: check failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => {
        running = undefined;
      });
    return running;
  };

  const interval = o.pollMs > 0 ? setInterval(() => void tick(), o.pollMs) : undefined;
  interval?.unref();

  return {
    nudge() {
      if (stopped) return;
      idleSince = Date.now();
      if (pending === undefined) return;
      armSettle(settleMs);
    },
    stop() {
      stopped = true;
      if (interval !== undefined) clearInterval(interval);
      if (settleTimer !== undefined) clearTimeout(settleTimer);
    },
    tick,
  };
}
