// quota — provider-reported subscription headroom (issue #17). Logic lives in
// src/core/quota.ts; this file is argument parsing and I/O only.
//
//   ach quota [--json] [--agent A]      table (or JSON rows) from vendor sources
//   ach quota ingest claude             read Claude Code statusline JSON on stdin,
//                                       snapshot its rate_limits; silent, exit 0
//   ach quota wait [opts] [-- cmd ...]  block until the agent's vendor-reported
//                                       windows have headroom, then run cmd
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { HarnessError } from "../core/types.ts";
import { stateDir } from "../core/store.ts";
import {
  claudeSnapshotPath,
  collectQuota,
  fmtDuration,
  parseClaudeStatusline,
  quotaWaitDecision,
  renderQuotaTable,
  writeClaudeSnapshot,
} from "../core/quota.ts";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(typeof c === "string" ? Buffer.from(c) : (c as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Statusline hook: must never break the user's status line, so malformed or
 * rate_limits-free input is a silent no-op (the previous snapshot stays).
 */
async function ingest(rest: string[]): Promise<number> {
  const [agent] = rest;
  if (agent !== "claude") {
    throw new HarnessError(`quota ingest supports only 'claude' (got '${agent ?? ""}')`, "USAGE");
  }
  const text = await readStdin();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return 0;
  }
  const snap = parseClaudeStatusline(json, Date.now());
  if (snap) await writeClaudeSnapshot(claudeSnapshotPath(stateDir()), snap);
  return 0;
}

function positiveNumber(flag: string, v: string | undefined, dflt: number, allowZero = false): number {
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0)) {
    throw new HarnessError(`${flag} must be a ${allowZero ? "non-negative" : "positive"} number (got '${v}')`, "USAGE");
  }
  return n;
}

function runCommand(argv: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(argv[0] as string, argv.slice(1), { stdio: "inherit" });
    child.on("error", (e) => {
      process.stderr.write(`ach quota wait: cannot run ${argv[0]}: ${e.message}\n`);
      resolve(127);
    });
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}

/**
 * Block until the agent's vendor-reported windows are under --max-used (or
 * have reset), re-reading the snapshot every --poll-s. Every check compares
 * against the wall clock, so a laptop that sleeps through the reset starts
 * the job as soon as it wakes instead of finishing an interrupted timer.
 */
async function wait(rest: string[]): Promise<number> {
  const dd = rest.indexOf("--");
  const cmd = dd >= 0 ? rest.slice(dd + 1) : [];
  const args = parseArgs({
    args: dd >= 0 ? rest.slice(0, dd) : rest,
    options: {
      agent: { type: "string", default: "claude" },
      "max-used": { type: "string" },
      window: { type: "string" },
      "poll-s": { type: "string" },
      "grace-s": { type: "string" },
      "timeout-s": { type: "string" },
      "allow-unknown": { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  const v = args.values;
  if (dd >= 0 && cmd.length === 0) throw new HarnessError("nothing to run after --", "USAGE");
  const maxUsed = positiveNumber("--max-used", v["max-used"], 95);
  const pollMs = positiveNumber("--poll-s", v["poll-s"], 60) * 1000;
  const graceMs = positiveNumber("--grace-s", v["grace-s"], 60, true) * 1000;
  const timeoutMs = v["timeout-s"] === undefined ? undefined : positiveNumber("--timeout-s", v["timeout-s"], 0) * 1000;
  const windows = v.window?.split(",").map((s) => s.trim()).filter(Boolean);
  const started = Date.now();
  let readyAt: number | undefined;
  for (;;) {
    const now = Date.now();
    const rows = await collectQuota({ stateDir: stateDir(), now });
    const d = quotaWaitDecision(rows, { agent: v.agent as string, maxUsed, ...(windows ? { windows } : {}) });
    if (d.state === "unknown" && !v["allow-unknown"]) {
      throw new HarnessError(`ach quota wait: ${d.reason} (pass --allow-unknown to start anyway)`, "QUOTA_UNKNOWN");
    }
    if (d.state === "wait" && d.waitMs !== undefined) readyAt = now + d.waitMs + graceMs;
    const reached = d.state === "wait" && readyAt !== undefined && now >= readyAt;
    if (d.state !== "wait" || reached) {
      process.stderr.write(`ach quota wait: ready: ${reached ? "reset time passed" : d.reason}\n`);
      return cmd.length > 0 ? runCommand(cmd) : 0;
    }
    if (timeoutMs !== undefined && now - started >= timeoutMs) {
      process.stderr.write(`ach quota wait: timed out after ${fmtDuration(now - started)}: ${d.reason}\n`);
      return 1;
    }
    process.stderr.write(`ach quota wait: waiting: ${d.reason}\n`);
    let sleepMs = pollMs;
    if (readyAt !== undefined) sleepMs = Math.min(sleepMs, Math.max(0, readyAt - now));
    if (timeoutMs !== undefined) sleepMs = Math.min(sleepMs, Math.max(0, started + timeoutMs - now));
    await new Promise((r) => setTimeout(r, Math.max(sleepMs, 50)));
  }
}

export async function cmdQuota(rest: string[]): Promise<number> {
  if (rest[0] === "ingest") return ingest(rest.slice(1));
  if (rest[0] === "wait") return wait(rest.slice(1));
  const args = parseArgs({
    args: rest,
    options: {
      json: { type: "boolean", default: false },
      agent: { type: "string" },
    },
    allowPositionals: false,
  });
  const now = Date.now();
  let rows = await collectQuota({ stateDir: stateDir(), now });
  if (args.values.agent !== undefined) rows = rows.filter((r) => r.agent === args.values.agent);
  if (args.values.json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
  } else {
    process.stdout.write(renderQuotaTable(rows, now) + "\n");
  }
  return 0;
}
