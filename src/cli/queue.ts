// `ach queue` (issue #115 part A): a plan-file run queue that keeps at most N
// `ach run` processes live machine-wide. See docs/QUEUE.md. Scheduling lives in
// src/core/queue-engine.ts; the state-file contract in src/core/queue-state.ts.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";
import { HarnessError } from "../core/types.ts";
import { stateDir as defaultStateDir } from "../core/store.ts";
import { isLive, scanRunRecords } from "../core/registry.ts";
import { parsePlan, type PlanSlice } from "../core/queue-plan.ts";
import {
  listQueueStates,
  queueLogPath,
  readQueueState,
  sliceCounts,
  sliceLogPath,
  writeQueueState,
  type QueueState,
  type SliceState,
} from "../core/queue-state.ts";
import { exitCodeFor, runQueue, QUEUE_EXIT, type EngineDeps, type HookKind } from "../core/queue-engine.ts";
import { resolveDirFlag } from "./lib.ts";

export const QUEUE_USAGE = `  ach queue run <plan-file> [--max-concurrent N=2] [--max-hours H=24] [--poll-s S=5]
              [--dry-run] [--notify] [--state-dir <stateDir>] [--count-dir D ...]
              [--hook-timeout-s S=1800] [--quiet]
  ach queue run --resume <queueId> [same flags]
  ach queue status [<queueId>] [--all] [--json] [--state-dir <stateDir>]
                (plan line: <label> <cwd> <agent> <model|-> <prompt-file> [--pre "<cmd>"]
                 [--post "<cmd>"] [ach run flags...]. Keeps <= N live 'ach run' processes
                 machine-wide, other sessions included; runs are detached, so stopping
                 the queue never kills them. Exit 0 drained ok, 1 a slice failed,
                 40 --max-hours expired, 130 interrupted. State: <stateDir>/queues/<id>.json,
                 logs: <id>.log + <id>/<label>.log. See docs/QUEUE.md)`;

/** Prompts travel as one argv element; stay well under macOS ARG_MAX (1 MiB total). */
const MAX_PROMPT_BYTES = 200_000;

function numFlag(v: string | undefined, flag: string, dflt: number, opts: { int?: boolean; min?: number } = {}): number {
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || n < (opts.min ?? 0) || (opts.int && !Number.isInteger(n))) {
    throw new HarnessError(`${flag} expects ${opts.int ? "an integer" : "a number"} >= ${opts.min ?? 0}, got '${v}'`, "USAGE");
  }
  return n;
}

export function newQueueId(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `q-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Distinct pids of live run records in every registry given. */
export function liveRunPidsIn(dirs: readonly string[], now = Date.now()): Set<number> {
  const pids = new Set<number>();
  for (const d of dirs) {
    for (const r of scanRunRecords(d).records) if (isLive(r, now) && r.pid !== undefined) pids.add(r.pid);
  }
  return pids;
}

/** argv that re-enters this same `ach` program with `args` (works under
 *  `tsx`/`bun run src/cli/ach.ts`, `node dist/cli/ach.js` and compiled binaries). */
export function selfArgv(args: string[]): { cmd: string; args: string[] } {
  const script = process.argv[1];
  const compiled = script === undefined || script.startsWith("/$bunfs/") || script.startsWith("B:/~BUN/");
  return { cmd: process.execPath, args: compiled ? args : [...absoluteExecArgv(process.execArgv), script, ...args] };
}

const MODULE_FLAGS = new Set(["--import", "--loader", "--experimental-loader", "--require", "-r"]);
const isBare = (spec: string): boolean => !/^(\.{1,2}\/|\/|[A-Za-z]:[\\/]|file:|data:|node:)/.test(spec);

/** execArgv with bare module specifiers (`--import tsx`) made absolute. Node resolves
 *  them from the process cwd, and a slice runs in its own cwd, where `tsx` is usually
 *  not installed. `--require` resolves from `cwd` (what Node did for the queue itself);
 *  ESM flags resolve from this module, since a parent URL for import.meta.resolve needs
 *  an experimental flag. A specifier that cannot be resolved is left as is. */
export function absoluteExecArgv(execArgv: readonly string[], cwd: string = process.cwd()): string[] {
  const resolve = (flag: string, spec: string): string => {
    if (!isBare(spec)) return spec;
    try {
      if (flag === "--require" || flag === "-r") return createRequire(path.join(cwd, "noop.js")).resolve(spec);
      return import.meta.resolve(spec);
    } catch {
      return spec;
    }
  };
  const out: string[] = [];
  for (let i = 0; i < execArgv.length; i++) {
    const a = execArgv[i]!;
    const eq = a.indexOf("=");
    const flag = eq > 0 ? a.slice(0, eq) : a;
    if (MODULE_FLAGS.has(flag) && eq > 0) out.push(`${flag}=${resolve(flag, a.slice(eq + 1))}`);
    else if (MODULE_FLAGS.has(a) && i + 1 < execArgv.length) out.push(a, resolve(a, execArgv[++i]!));
    else out.push(a);
  }
  return out;
}

/** The `ach run` argument vector for a slice, prompt included. */
export function runArgvFor(s: Pick<SliceState, "agent" | "model" | "runArgs">, prompt: string): string[] {
  return ["run", "--agent", s.agent, ...(s.model !== undefined ? ["--model", s.model] : []), ...s.runArgs, prompt];
}

function hookEnv(queue: QueueState, s: SliceState): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AGENTIC_CODING_HARNESS_STATE_DIR: queue.stateDir,
    ACH_QUEUE_ID: queue.id,
    ACH_SLICE_LABEL: s.label,
    ACH_SLICE_CWD: s.cwd,
    ACH_SLICE_LOG: s.log,
    ACH_SLICE_STATUS: s.status,
    ACH_SLICE_EXIT: s.runExit === undefined || s.runExit === null ? "" : String(s.runExit),
    ACH_SLICE_PID: s.pid === undefined ? "" : String(s.pid),
    ACH_SLICE_RUN_IDS: s.runIds.join(","),
  };
}

function appendLog(file: string, line: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, line.endsWith("\n") ? line : line + "\n");
}

export function realDeps(queue: QueueState, opts: { hookTimeoutMs: number; quiet: boolean }): EngineDeps {
  const dirs = [queue.stateDir, ...queue.countDirs];
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    liveRunPids: () => liveRunPidsIn(dirs),
    runInfoForPid(pid, since) {
      const recs = scanRunRecords(queue.stateDir).records.filter((r) => r.pid === pid && r.startedAt >= since);
      return { runIds: recs.map((r) => r.runId).reverse(), statuses: recs.map((r) => (r.status === "running" ? "interrupted" : (r.status ?? "interrupted"))) };
    },
    isPidAlive: pidAlive,
    launch(s) {
      const size = fs.statSync(s.promptFile).size;
      if (size > MAX_PROMPT_BYTES) throw new Error(`prompt file ${s.promptFile} is ${size} bytes (> ${MAX_PROMPT_BYTES})`);
      const prompt = fs.readFileSync(s.promptFile, "utf8");
      const { cmd, args } = selfArgv(runArgvFor(s, prompt));
      fs.mkdirSync(path.dirname(s.log), { recursive: true });
      const fd = fs.openSync(s.log, "a");
      try {
        fs.writeSync(fd, `--- ${new Date().toISOString()} launch: ach run --agent ${s.agent}${s.model ? ` --model ${s.model}` : ""} ${s.runArgs.join(" ")} <prompt ${s.promptFile}>\n`);
        const child = spawn(cmd, args, {
          cwd: s.cwd,
          detached: true,
          stdio: ["ignore", fd, fd],
          env: { ...process.env, AGENTIC_CODING_HARNESS_STATE_DIR: queue.stateDir, ACH_QUEUE_ID: queue.id, ACH_SLICE_LABEL: s.label },
        });
        if (child.pid === undefined) throw new Error("spawn returned no pid");
        const pid = child.pid;
        let cb: ((code: number | null) => void) | undefined;
        let exited: { code: number | null } | undefined;
        child.once("error", (e) => appendLog(s.log, `spawn error: ${e.message}`));
        child.once("exit", (code) => {
          exited = { code };
          cb?.(code);
        });
        child.unref();
        return {
          pid,
          onExit(f) {
            cb = f;
            if (exited) f(exited.code);
          },
        };
      } finally {
        fs.closeSync(fd);
      }
    },
    runHook(kind: HookKind, s: SliceState) {
      const cmd = kind === "pre" ? s.preCmd! : s.postCmd!;
      return new Promise<number | null>((resolve) => {
        fs.mkdirSync(path.dirname(s.log), { recursive: true });
        const fd = fs.openSync(s.log, "a");
        fs.writeSync(fd, `--- ${new Date().toISOString()} ${kind}: ${cmd}\n`);
        const child = spawn("/bin/sh", ["-c", cmd], { cwd: s.cwd, stdio: ["ignore", fd, fd], env: hookEnv(queue, s) });
        const timer = setTimeout(() => child.kill("SIGKILL"), opts.hookTimeoutMs);
        let done = false;
        const end = (code: number | null) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          fs.closeSync(fd);
          resolve(code);
        };
        child.once("error", (e) => {
          appendLog(s.log, `${kind} spawn error: ${e.message}`);
          end(127);
        });
        child.once("close", (code) => end(code));
      });
    },
    save: (q) => writeQueueState(q),
    log(line) {
      const l = `${new Date().toISOString()} ${line}`;
      appendLog(queue.log, l);
      if (!opts.quiet) process.stdout.write(l + "\n");
    },
  };
}

function newState(id: string, planPath: string, slices: PlanSlice[], o: { stateDir: string; countDirs: string[]; maxConcurrent: number; maxHours: number }): QueueState {
  const now = Date.now();
  return {
    v: 1,
    id,
    planPath,
    stateDir: o.stateDir,
    countDirs: o.countDirs,
    startedAt: now,
    updatedAt: now,
    maxConcurrent: o.maxConcurrent,
    maxHours: o.maxHours,
    deadlineAt: now + o.maxHours * 3_600_000,
    queuePid: process.pid,
    phase: "running",
    log: queueLogPath(o.stateDir, id),
    slices: slices.map((s) => ({
      label: s.label,
      cwd: s.cwd,
      agent: s.agent,
      ...(s.model !== undefined ? { model: s.model } : {}),
      promptFile: s.promptFile,
      runArgs: s.runArgs,
      ...(s.preCmd !== undefined ? { preCmd: s.preCmd } : {}),
      ...(s.postCmd !== undefined ? { postCmd: s.postCmd } : {}),
      status: "queued" as const,
      runIds: [],
      log: sliceLogPath(o.stateDir, id, s.label),
    })),
  };
}

/** Plan-level checks that do not need a launch: every cwd is a directory, every prompt file exists. */
export function validatePlan(slices: PlanSlice[]): string[] {
  const problems: string[] = [];
  for (const s of slices) {
    try {
      if (!fs.statSync(s.cwd).isDirectory()) problems.push(`plan line ${s.line} (${s.label}): cwd ${s.cwd} is not a directory`);
    } catch {
      problems.push(`plan line ${s.line} (${s.label}): cwd ${s.cwd} does not exist`);
    }
    try {
      if (!fs.statSync(s.promptFile).isFile()) problems.push(`plan line ${s.line} (${s.label}): prompt file ${s.promptFile} is not a file`);
    } catch {
      problems.push(`plan line ${s.line} (${s.label}): prompt file ${s.promptFile} does not exist`);
    }
  }
  return problems;
}

function notify(title: string, message: string): void {
  if (process.platform !== "darwin") return;
  const esc = (x: string) => x.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  execFile("osascript", ["-e", `display notification "${esc(message)}" with title "${esc(title)}"`], () => {});
}

export function formatStatusTable(q: QueueState, now = Date.now()): string {
  const c = sliceCounts(q);
  const alive = q.phase === "running" && pidAlive(q.queuePid);
  const head =
    `queue ${q.id}  phase=${q.phase}${q.phase === "running" && !alive ? " (queue process gone; --resume to continue)" : ""}  ` +
    `queued=${c.queued} running=${c.running} done=${c.done} failed=${c.failed} pre-failed=${c["pre-failed"]}  ` +
    `max-concurrent=${q.maxConcurrent}\nplan ${q.planPath}\nlog  ${q.log}`;
  const rows = q.slices.map((s) => {
    const end = s.finishedAt ?? now;
    const dur = s.launchedAt !== undefined ? `${Math.round((end - s.launchedAt) / 1000)}s` : "-";
    const post = s.postCmd === undefined ? "-" : s.postExit === undefined ? (s.postStartedAt ? "running" : "pending") : s.postExit === 0 ? "ok" : `exit ${s.postExit}`;
    return [s.label, s.status, s.agent, s.model ?? "-", s.pid === undefined ? "-" : String(s.pid), String(s.runIds.length), dur, post, s.error ?? ""];
  });
  const table = [["LABEL", "STATUS", "AGENT", "MODEL", "PID", "RUNS", "TIME", "POST", "NOTE"], ...rows];
  const w = table[0]!.map((_, i) => Math.max(...table.map((r) => r[i]!.length)));
  return head + "\n" + table.map((r) => r.map((x, i) => (i === r.length - 1 ? x : x.padEnd(w[i]!))).join("  ").trimEnd()).join("\n") + "\n";
}

async function cmdQueueRun(rest: string[]): Promise<number> {
  const args = parseArgs({
    args: rest,
    options: {
      "max-concurrent": { type: "string" },
      "max-hours": { type: "string" },
      "poll-s": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      notify: { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
      "state-dir": { type: "string" },
      dir: { type: "string" },
      "count-dir": { type: "string", multiple: true },
      "hook-timeout-s": { type: "string" },
      resume: { type: "string" },
    },
    allowPositionals: true,
  });
  const v = args.values;
  const sd = path.resolve(resolveDirFlag(v, "state-dir") ?? defaultStateDir());
  const pollMs = Math.round(numFlag(v["poll-s"], "--poll-s", 5, { min: 0.05 }) * 1000);
  const hookTimeoutMs = Math.round(numFlag(v["hook-timeout-s"], "--hook-timeout-s", 1800, { min: 1 }) * 1000);
  const cap = numFlag(v["max-concurrent"], "--max-concurrent", 2, { int: true, min: 1 });
  const hours = numFlag(v["max-hours"], "--max-hours", 24, { min: 0.0001 });
  const countDirs = (v["count-dir"] ?? []).map((d) => path.resolve(d));

  let state: QueueState;
  if (v.resume !== undefined) {
    if (args.positionals.length > 0) throw new HarnessError("queue run --resume takes no plan file", "USAGE");
    const prev = readQueueState(sd, v.resume);
    if (!prev) throw new HarnessError(`no readable queue '${v.resume}' in ${sd}/queues`, "USAGE");
    if (prev.queuePid !== process.pid && pidAlive(prev.queuePid) && prev.phase === "running") {
      throw new HarnessError(`queue ${prev.id} is still driven by pid ${prev.queuePid}`, "USAGE");
    }
    state = {
      ...prev,
      queuePid: process.pid,
      deadlineAt: Date.now() + hours * 3_600_000,
      maxHours: v["max-hours"] !== undefined ? hours : prev.maxHours,
      maxConcurrent: v["max-concurrent"] !== undefined ? cap : prev.maxConcurrent,
      countDirs: countDirs.length > 0 ? countDirs : prev.countDirs,
    };
    if (v["max-hours"] === undefined) state.deadlineAt = Date.now() + prev.maxHours * 3_600_000;
  } else {
    const planArg = args.positionals[0];
    if (!planArg || args.positionals.length > 1) throw new HarnessError("queue run requires exactly one <plan-file>", "USAGE");
    const planPath = path.resolve(planArg);
    let text: string;
    try {
      text = fs.readFileSync(planPath, "utf8");
    } catch {
      throw new HarnessError(`cannot read plan file ${planPath}`, "USAGE");
    }
    const slices = parsePlan(text, path.dirname(planPath));
    const problems = validatePlan(slices);
    if (v["dry-run"]) {
      const dirs = [sd, ...countDirs];
      const live = liveRunPidsIn(dirs);
      const free = Math.max(0, cap - live.size);
      const out: string[] = [
        `plan ${planPath}: ${slices.length} slice(s)`,
        `live ach runs now: ${live.size} (counted in ${dirs.join(", ")}); max-concurrent ${cap}; would launch ${Math.min(free, slices.length)} immediately (after pre hooks)`,
        "",
      ];
      slices.forEach((s, i) => {
        out.push(`${String(i + 1).padStart(2)}. ${s.label}  [${i < free ? "launch now" : "wait for a free slot"}]`);
        out.push(`      cwd ${s.cwd}`);
        out.push(`      ach ${["run", "--agent", s.agent, ...(s.model ? ["--model", s.model] : []), ...s.runArgs].join(" ")} <prompt-file ${s.promptFile}>`);
        if (s.preCmd) out.push(`      pre  ${s.preCmd}`);
        if (s.postCmd) out.push(`      post ${s.postCmd}`);
      });
      for (const p of problems) out.push(`PROBLEM: ${p}`);
      process.stdout.write(out.join("\n") + "\n");
      return problems.length > 0 ? 1 : 0;
    }
    if (problems.length > 0) throw new HarnessError(problems.join("\n"), "USAGE");
    state = newState(newQueueId(), planPath, slices, { stateDir: sd, countDirs, maxConcurrent: cap, maxHours: hours });
  }
  if (v["dry-run"]) throw new HarnessError("--dry-run applies to a plan file, not --resume", "USAGE");

  const deps = realDeps(state, { hookTimeoutMs, quiet: v.quiet === true });
  let stop = false;
  const onSig = () => {
    stop = true;
  };
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);
  deps.log(`queue ${state.id}: ${state.slices.length} slice(s), max-concurrent ${state.maxConcurrent}, max-hours ${state.maxHours}, state ${path.join(state.stateDir, "queues", state.id + ".json")}`);
  const final = await runQueue(state, deps, { pollMs, shouldStop: () => stop });
  process.off("SIGINT", onSig);
  process.off("SIGTERM", onSig);
  const c = sliceCounts(final);
  const summary = `queue ${final.id} ${final.phase}: done=${c.done} failed=${c.failed} pre-failed=${c["pre-failed"]} running=${c.running} queued=${c.queued}`;
  deps.log(summary);
  if (v.notify) notify("ach queue", summary);
  return exitCodeFor(final);
}

function cmdQueueStatus(rest: string[]): number {
  const args = parseArgs({
    args: rest,
    options: { json: { type: "boolean", default: false }, all: { type: "boolean", default: false }, "state-dir": { type: "string" }, dir: { type: "string" } },
    allowPositionals: true,
  });
  const sd = path.resolve(resolveDirFlag(args.values, "state-dir") ?? defaultStateDir());
  const id = args.positionals[0];
  if (id !== undefined) {
    const q = readQueueState(sd, id);
    if (!q) throw new HarnessError(`no readable queue '${id}' in ${sd}/queues`, "USAGE");
    process.stdout.write(args.values.json ? JSON.stringify(q, null, 2) + "\n" : formatStatusTable(q));
    return 0;
  }
  const all = listQueueStates(sd);
  if (all.length === 0) {
    process.stdout.write(args.values.json ? "[]\n" : `no queues in ${sd}/queues\n`);
    return QUEUE_EXIT.drained;
  }
  if (args.values.json) {
    process.stdout.write(JSON.stringify(args.values.all ? all : [all[0]], null, 2) + "\n");
  } else if (args.values.all) {
    for (const q of all) {
      const c = sliceCounts(q);
      process.stdout.write(`${q.id}  ${q.phase}  queued=${c.queued} running=${c.running} done=${c.done} failed=${c.failed} pre-failed=${c["pre-failed"]}  ${q.planPath}\n`);
    }
  } else {
    process.stdout.write(formatStatusTable(all[0]!));
  }
  return 0;
}

export async function cmdQueue(rest: string[]): Promise<number> {
  const [sub, ...tail] = rest;
  switch (sub) {
    case "run":
      return cmdQueueRun(tail);
    case "status":
      return cmdQueueStatus(tail);
    default:
      throw new HarnessError(`queue: expected 'run' or 'status'\n${QUEUE_USAGE}`, "USAGE");
  }
}

