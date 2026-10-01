// Read-only Prime Agent (prime-agent CLI) session parser.
//
// Where (observed on prime-agent 0.9.8):
//   root sessions   ~/.prime/agent/sessions/<uuid>.jsonl
//   child sessions  ~/.prime/agent/session-artifacts/<parent-uuid>/sub-<hex>/<uuid>.jsonl
// Other JSONL under ~/.prime/agent (rlm-ledger/*.jsonl, logs/agent.jsonl and
// the sub-*/semantic-edges.jsonl beside child sessions) is NOT a transcript;
// isPrimeSessionFile keeps them out of the walk.
//
// Record shapes: line 1 is {type:"session", id, cwd, timestamp, ...}; token
// usage lives only on {type:"message", message:{role:"assistant", provider,
// model, usage:{input, output, cacheRead, cacheWrite, totalTokens}}} lines.
//
// Accounting:
//  - one record per assistant message.
//  - `child_usage_attributed` lines in a parent are IGNORED: a child's usage is
//    counted from the child's own file (the parent's childUsage.totalTokens
//    equals the sum of the child file's assistant totalTokens), so reading
//    both would double-count.
//  - input/cacheRead/cacheWrite map straight across. ASSUMPTION (pi
//    convention, unverified: the fixtures have cacheRead 0): `usage.input` is
//    the uncached prompt portion, i.e. it excludes cacheRead.
//  - no reasoning split is reported (0). model = the requested id
//    (`message.model`); provider/responseModel are not carried (the record type
//    has no slot). A child is not linked to its parent (no slot either).

import { readFile } from "node:fs/promises";
import { basename, dirname, extname } from "node:path";
import type { CanonicalTokenRecord } from "./transcripts.ts";
import { warnTranscript, type WarnFn } from "./transcript-warnings.ts";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

const UUID_JSONL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

/**
 * A Prime Agent session transcript: <uuid>.jsonl directly in a `sessions` dir,
 * or in a `sub-*` dir under `session-artifacts/<parent-uuid>/`. Path-shape
 * only, so it works for the real ~/.prime/agent and any override root.
 */
export function isPrimeSessionFile(filePath: string): boolean {
  if (!UUID_JSONL_RE.test(basename(filePath))) return false;
  const parent = dirname(filePath);
  if (basename(parent) === "sessions") return true;
  return basename(parent).startsWith("sub-") && basename(dirname(dirname(parent))) === "session-artifacts";
}

export async function parsePrimeSession(
  path: string,
  warn: WarnFn = warnTranscript,
): Promise<CanonicalTokenRecord[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    warn(`prime: skipped unreadable session file ${path}: ${(err as Error).message}`);
    return [];
  }
  const out: CanonicalTokenRecord[] = [];
  let sessionId: string = basename(path, extname(path));
  let cwd: string | undefined;
  text
    .replace(/^﻿/, "")
    .split("\n")
    .forEach((line, i) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let rec: unknown;
      try {
        rec = JSON.parse(trimmed);
      } catch {
        warn(`prime: ${path}: skipped line ${i + 1} (invalid JSON)`);
        return;
      }
      if (!isObj(rec)) return;
      if (rec.type === "session") {
        sessionId = str(rec.id) ?? sessionId;
        cwd = str(rec.cwd) ?? undefined;
        return;
      }
      if (rec.type !== "message" || !isObj(rec.message)) return;
      const m = rec.message;
      if (m.role !== "assistant" || !isObj(m.usage)) return;
      const u = m.usage;
      const input = num(u.input);
      const output = num(u.output);
      const cacheRead = num(u.cacheRead);
      const cacheWrite = num(u.cacheWrite);
      if (input + output + cacheRead + cacheWrite === 0) return;
      const ms = typeof m.timestamp === "number" && Number.isFinite(m.timestamp) ? new Date(m.timestamp) : null;
      out.push({
        agent: "prime",
        sessionId,
        timestamp: str(rec.timestamp) ?? (ms && !Number.isNaN(ms.getTime()) ? ms.toISOString() : null),
        model: str(m.model),
        input,
        output,
        cacheRead,
        cacheWrite,
        reasoning: 0,
        ...(cwd !== undefined ? { cwd } : {}),
      });
    });
  return out;
}
