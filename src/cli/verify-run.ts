// verify-run — prove a run's event log is untouched (issue #59).
//
// `ach audit` re-derives RunRecord totals FROM the event log; `ach verify-run`
// proves the log itself (and the sealed totals) were not edited after the run.
// The chain format and threat model live in src/core/hash-chain.ts.
//
// Targets:
//   <runId>  RunRecord <stateDir>/runs/<runId>.json + its raw transcript
//            (<stateDir>/raw/<agent>-<session>.jsonl), anchored by
//            RunRecord.seal; recorded totals are checked against the seal.
//   <dir>    a run-to-directory output dir (#6): events.jsonl anchored by
//            status.json's seal.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { HarnessError } from "../core/types.ts";
import { stateDir as defaultStateDir } from "../core/store.ts";
import { registryDir, resolveRawTranscript, RunRecordSchema, type RunRecord } from "../core/registry.ts";
import { verifyChainText, type ChainStatus, type ChainVerification, type RunSeal } from "../core/hash-chain.ts";
import { resolveDirFlag } from "./lib.ts";

/** Exit codes: ok 0 · tampered 2 · unsealed (legacy) 3 · open (unsealed chain) 4 · usage/lookup errors 1. */
export const VERIFY_RUN_EXIT: Record<ChainStatus, number> = { ok: 0, tampered: 2, unsealed: 3, open: 4 };

export interface RunVerification extends ChainVerification {
  target: "run-record" | "run-dir";
  /** The event log that was verified. */
  file?: string;
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function bare(runId: string, status: ChainStatus, note: string): ChainVerification {
  return { status, runId, records: 0, sealed: false, notes: [note], checks: [] };
}

/**
 * The driver seals BEFORE it writes a terminal status (RunRecord and
 * status.json alike), so a chain that is intact but unsealed and unanchored
 * while its run is recorded as finished can only come from an edit (seal line
 * truncated and anchor deleted). A genuinely crashed run stays "running".
 */
function closeOpen(v: ChainVerification, runStatus: unknown): ChainVerification {
  if (v.status !== "open" || typeof runStatus !== "string" || runStatus === "running") return v;
  const last = v.checks.at(-1)?.line ?? 0;
  return {
    ...v,
    status: "tampered",
    firstBad: {
      line: last + 1,
      seq: v.records,
      reason: `run is recorded as finished (status "${runStatus}") but its chain has no seal (seal record and anchor removed?)`,
    },
    notes: v.notes.filter((n) => !n.startsWith("open:")),
  };
}

/** Verify one RunRecord's raw transcript chain + sealed totals. */
export function verifyRunRecord(stateDir: string, rec: RunRecord): RunVerification {
  const file = resolveRawTranscript(stateDir, rec);
  if (!file) {
    const v = rec.seal
      ? { ...bare(rec.runId, "tampered", "record is sealed but carries no transcript path"), firstBad: { line: 0, reason: "rawTranscript removed from a sealed RunRecord" } }
      : bare(rec.runId, "unsealed", "unsealed (legacy): no raw transcript path (external record)");
    return { ...v, target: "run-record" };
  }
  const text = readText(file);
  if (text === null) {
    const v = rec.seal
      ? { ...bare(rec.runId, "tampered", "sealed transcript is missing"), firstBad: { line: 0, reason: `transcript ${file} is missing` } }
      : bare(rec.runId, "unsealed", "unsealed (legacy): raw transcript missing");
    return { ...v, target: "run-record", file };
  }
  const v = verifyChainText(text, {
    runId: rec.runId,
    ...(rec.seal ? { anchor: rec.seal } : {}),
    ...(rec.totals ? { totals: rec.totals } : {}),
    ...(rec.corrections ? { corrections: rec.corrections } : {}),
  });
  return { ...closeOpen(v, rec.status), target: "run-record", file };
}

/** Verify a run-to-directory output dir's events.jsonl against status.json's seal. */
export function verifyRunDir(dir: string): RunVerification {
  const file = path.join(dir, "events.jsonl");
  const statusText = readText(path.join(dir, "status.json"));
  let status: { runId?: unknown; seal?: unknown; status?: unknown } = {};
  // An anchor that exists but no longer parses is a break, not an absence.
  let brokenAnchor: string | null = null;
  try {
    if (statusText !== null) status = JSON.parse(statusText) as typeof status;
  } catch (e) {
    brokenAnchor = `status.json is unreadable (${e instanceof Error ? e.message : String(e)})`;
  }
  let runId = typeof status.runId === "string" ? status.runId : undefined;
  if (runId === undefined) {
    try {
      const inv = JSON.parse(fs.readFileSync(path.join(dir, "invocation.json"), "utf8")) as { runId?: unknown };
      if (typeof inv.runId === "string") runId = inv.runId;
    } catch {
      /* no invocation.json */
    }
  }
  if (runId === undefined) {
    throw new HarnessError(`verify-run: ${dir} has no status.json/invocation.json naming a runId`, "USAGE");
  }
  let anchor: RunSeal | undefined;
  if (status.seal !== undefined) {
    const parsed = RunRecordSchema.shape.seal.safeParse(status.seal);
    if (parsed.success) anchor = parsed.data as RunSeal;
    else brokenAnchor = "status.json seal is malformed";
  }
  if (brokenAnchor !== null) {
    return { ...bare(runId, "tampered", "the run's seal anchor is damaged"), firstBad: { line: 0, reason: brokenAnchor }, target: "run-dir", file };
  }
  const text = readText(file);
  if (text === null) {
    const v = anchor
      ? { ...bare(runId, "tampered", "sealed events.jsonl is missing"), firstBad: { line: 0, reason: `${file} is missing` } }
      : bare(runId, "unsealed", "unsealed (legacy): events.jsonl missing");
    return { ...v, target: "run-dir", file };
  }
  const v = closeOpen(verifyChainText(text, { runId, ...(anchor ? { anchor } : {}) }), status.status);
  if (v.sealed) {
    v.notes.push("run-dir mode: status.json carries no totals, so sealed totals are shown, not compared");
  }
  return { ...v, target: "run-dir", file };
}

export type RecordLookup = { ok: true; record: RunRecord } | { ok: false; reason: string } | { ok: false; missing: true };

/** Read a RunRecord, distinguishing "no such run" from "record exists but no longer parses". */
export function lookupRunRecord(stateDir: string, runId: string): RecordLookup {
  const text = readText(path.join(registryDir(stateDir), `${runId}.json`));
  if (text === null) return { ok: false, missing: true };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  const parsed = RunRecordSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: `schema: ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "invalid"}` };
  }
  return { ok: true, record: parsed.data as RunRecord };
}

/** One-word verdict + short detail, for audit/report cells. */
export function verdictLabel(v: ChainVerification): string {
  switch (v.status) {
    case "ok":
      return `sealed ✓ (${v.records} records)`;
    case "tampered":
      return `TAMPERED at line ${v.firstBad?.line ?? "?"}: ${v.firstBad?.reason ?? "chain broken"}`;
    case "unsealed":
      return "unsealed (legacy)";
    case "open":
      return `open (${v.records} records, no seal)`;
  }
}

export function formatVerifyText(v: RunVerification, showRecords: boolean): string {
  const out: string[] = [];
  out.push(`run ${v.runId}${v.file ? `  (${v.target === "run-dir" ? "events.jsonl" : "transcript"} ${v.file})` : ""}`);
  if (showRecords) {
    for (const c of v.checks) out.push(`  line ${String(c.line).padStart(5)}  seq ${String(c.seq).padStart(5)}  ${c.type.padEnd(14)} ${c.hash.slice(0, 16)}  ok`);
    if (v.firstBad) out.push(`  line ${String(v.firstBad.line).padStart(5)}  ${v.firstBad.seq !== undefined ? `seq ${String(v.firstBad.seq).padStart(5)}  ` : ""}BROKEN`);
  }
  out.push(`  records: ${v.records} chained${v.sealed ? " + seal" : ""}`);
  if (v.sealed) out.push(`  seal:    ${v.status === "tampered" ? "present" : "OK"}  sha256 ${v.sealHash}`);
  if (v.totals) {
    const t = v.totals;
    const text =
      t.status === "match"
        ? "match the seal"
        : t.status === "match-after-corrections"
          ? `match the seal after undoing ${t.corrections} audit correction(s)`
          : t.status === "mismatch"
            ? `DIFFER from the seal: ${t.fields.map((f) => `${f.field} sealed=${f.sealed} recorded=${f.recorded}`).join(", ")}`
            : `not checked (${t.reason})`;
    out.push(`  totals:  ${text}`);
  }
  for (const n of v.notes) out.push(`  note:    ${n}`);
  const verdict =
    v.status === "ok"
      ? "OK — chain intact and sealed"
      : v.status === "tampered"
        ? `TAMPERED — first bad record at line ${v.firstBad?.line}${v.firstBad?.seq !== undefined ? ` (seq ${v.firstBad.seq})` : ""}: ${v.firstBad?.reason}`
        : v.status === "unsealed"
          ? "UNSEALED (legacy) — no hash chain to verify"
          : "OPEN — chain intact but not sealed";
  out.push(`verdict: ${verdict}`);
  return out.join("\n") + "\n";
}

export const VERIFY_RUN_USAGE = `ach verify-run <runId|runDir> [--json] [--records] [--state-dir <stateDir>]
  (--dir is an alias of --state-dir.)
  Recomputes the run's sha256 hash chain (#59) over its raw transcript
  (<stateDir>/raw/<agent>-<session>.jsonl) and checks the terminal seal against
  RunRecord.seal and the recorded totals (audit --fix corrections are undone
  and reported, not failed). A directory argument verifies a run-to-directory
  events.jsonl against status.json's seal. Tamper-EVIDENT, not tamper-proof:
  a consistent rewrite of chain + seal + RunRecord is not detected; store the
  printed seal hash elsewhere to anchor a run.
  --records  print every verified record (line, seq, type, hash)
  exit 0: intact · 2: tampered (names the first bad line) · 3: unsealed
  (legacy, pre-chain log) · 4: open (chained, never sealed) · 1: unknown run`;

export async function cmdVerifyRun(rest: string[]): Promise<number> {
  const args = parseArgs({
    args: rest,
    options: {
      json: { type: "boolean", default: false },
      records: { type: "boolean", default: false },
      dir: { type: "string" },
      "state-dir": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });
  if (args.values.help) {
    process.stdout.write(VERIFY_RUN_USAGE + "\n");
    return 0;
  }
  const [target, ...extra] = args.positionals;
  if (target === undefined || extra.length > 0) {
    throw new HarnessError("verify-run expects exactly one <runId> or run directory", "USAGE");
  }
  const stateDir = resolveDirFlag(args.values, "state-dir") ?? defaultStateDir();

  let v: RunVerification;
  let isDir = false;
  try {
    isDir = fs.statSync(target).isDirectory();
  } catch {
    /* not a path: a run id */
  }
  if (isDir) {
    v = verifyRunDir(target);
  } else {
    const found = lookupRunRecord(stateDir, target);
    if (!found.ok) {
      if ("missing" in found) {
        throw new HarnessError(`verify-run: no run '${target}' under ${registryDir(stateDir)}`, "NOT_FOUND");
      }
      v = {
        ...bare(target, "tampered", "RunRecord no longer parses"),
        firstBad: { line: 0, reason: `RunRecord ${target}.json is unreadable (${found.reason})` },
        target: "run-record",
      };
    } else {
      v = verifyRunRecord(stateDir, found.record);
    }
  }
  if (args.values.json) {
    const { checks, ...summary } = v;
    process.stdout.write(JSON.stringify(args.values.records ? v : summary, null, 2) + "\n");
    void checks;
  } else {
    process.stdout.write(formatVerifyText(v, args.values.records));
  }
  return VERIFY_RUN_EXIT[v.status];
}
