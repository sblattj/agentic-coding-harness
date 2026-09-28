// Post-run outcome verifier (#29).
//
// `ach run --verify '<cmd>'` records whether a run WORKED, not just whether
// it finished: after the agent exits, the checker runs through /bin/sh (cmd.exe
// on Windows) in the
// run's cwd with the run's env, and its verdict lands on the RunRecord as an
// additive optional `verify` object. The agent's own exitStatus is never
// touched; a verifier that cannot run or exceeds its timeout records
// status "error" (never "pass", never a thrown run).
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { z } from "zod";
import { shellCommand, system32Exe } from "./platform.ts";

export const DEFAULT_VERIFY_TIMEOUT_MS = 120_000;
export const DEFAULT_VERIFY_TAIL_BYTES = 4_000;

export type VerifyStatus = "pass" | "fail" | "error";

export interface VerifyResult {
  /** The checker command line, verbatim (run via /bin/sh -c; cmd.exe /d /s /c on Windows). */
  command: string;
  /** Process exit code; null when it never exited normally (timeout, signal, spawn failure). */
  exitCode: number | null;
  /** pass = exit 0; fail = non-zero exit; error = timeout / signal / could not run. */
  status: VerifyStatus;
  durationMs: number;
  timedOut: boolean;
  /** Last `tailBytes` characters (UTF-16 units, not bytes) of combined stdout+stderr. */
  outputTail?: string;
  /** Terminating signal when the checker died by one. */
  signal?: string;
  /** Why the checker could not run (spawn/cwd failure). */
  error?: string;
  /** ms epoch the verdict was recorded. */
  at?: number;
}

export const VerifyResultSchema = z.object({
  command: z.string(),
  exitCode: z.number().int().nullable(),
  status: z.enum(["pass", "fail", "error"]),
  durationMs: z.number(),
  timedOut: z.boolean(),
  outputTail: z.string().optional(),
  signal: z.string().optional(),
  error: z.string().optional(),
  at: z.number().optional(),
});

export interface RunVerifierOptions {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  tailBytes?: number;
}

/** Only an explicit pass counts as a pass; fail AND error count against. */
export function isVerifyPass(v: VerifyResult | undefined): boolean {
  return v?.status === "pass";
}

export function runVerifier(opts: RunVerifierOptions): Promise<VerifyResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
  const tailBytes = opts.tailBytes ?? DEFAULT_VERIFY_TAIL_BYTES;
  const start = Date.now();
  const base = { command: opts.command };

  // A missing cwd makes spawn fail with a misleading ENOENT naming /bin/sh;
  // say what actually went wrong.
  if (!fs.existsSync(opts.cwd)) {
    return Promise.resolve({
      ...base,
      exitCode: null,
      status: "error",
      durationMs: 0,
      timedOut: false,
      error: `verify cwd does not exist: ${opts.cwd}`,
      at: Date.now(),
    });
  }

  return new Promise<VerifyResult>((resolve) => {
    let tail = "";
    const keep = (chunk: Buffer): void => {
      tail += chunk.toString("utf8");
      if (tail.length > tailBytes) tail = tail.slice(tail.length - tailBytes);
    };
    let timedOut = false;
    let settled = false;
    const finish = (r: Omit<VerifyResult, "command" | "durationMs" | "timedOut" | "at">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ...base,
        ...r,
        durationMs: Date.now() - start,
        timedOut,
        ...(tail !== "" ? { outputTail: tail } : {}),
        at: Date.now(),
      });
    };

    // detached: the checker leads its own process group so a timeout can
    // kill the whole tree (npm test → node → workers), not just the shell.
    // Windows has no process groups (detached there means "new console"), so
    // the tree is killed with taskkill /T instead.
    const win = process.platform === "win32";
    const sh = shellCommand(opts.command, { env: opts.env ?? process.env });
    const child = spawn(sh.command, sh.args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: !win,
      ...(sh.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      ...(win ? { windowsHide: true } : {}),
    });
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid === undefined) throw new Error("no pid");
        if (win) spawnSync(system32Exe("taskkill.exe"), ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    child.on("error", (err) => {
      finish({ exitCode: null, status: "error", error: err.message });
    });
    child.on("close", (code, signal) => {
      if (timedOut) {
        finish({ exitCode: null, status: "error", ...(signal ? { signal } : {}) });
      } else if (code === null) {
        finish({ exitCode: null, status: "error", ...(signal ? { signal } : {}) });
      } else {
        finish({ exitCode: code, status: code === 0 ? "pass" : "fail" });
      }
    });
  });
}
