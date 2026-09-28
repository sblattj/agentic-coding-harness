// quota — provider-reported subscription headroom (issue #17). Logic lives in
// src/core/quota.ts; this file is argument parsing and I/O only.
//
//   ach quota [--json] [--agent A]      table (or JSON rows) from vendor sources
//   ach quota ingest claude             read Claude Code statusline JSON on stdin,
//                                       snapshot its rate_limits; silent, exit 0
import { parseArgs } from "node:util";
import { HarnessError } from "../core/types.ts";
import { stateDir } from "../core/store.ts";
import {
  claudeSnapshotPath,
  collectQuota,
  parseClaudeStatusline,
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

export async function cmdQuota(rest: string[]): Promise<number> {
  if (rest[0] === "ingest") return ingest(rest.slice(1));
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
