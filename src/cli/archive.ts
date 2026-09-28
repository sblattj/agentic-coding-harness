// `ach archive` (#79): snapshot raw transcripts + registry records into the
// warehouse, or restore a batch. Logic lives in src/core/warehouse.ts; this
// module is argument parsing, output formatting, and the `ach stats
// --with-warehouse` / `--dir` source helpers.
import path from "node:path";
import { parseArgs } from "node:util";
import { AGENTS, HarnessError, isKnownAgent } from "../core/types.ts";
import { readRecordFiles, stateDir as defaultStateDir, type ReadRecordsOptions, type StatRecord } from "../core/store.ts";
import { archiveTranscripts, restoreBatch, scanWarehouse, warehouseRawFiles, type ArchiveResult } from "../core/warehouse.ts";
import { warehouseDir } from "../core/warehouse-index.ts";
import { scanAll, scanOptionsForRoot, transcriptAgentNames, type CanonicalTokenRecord, type ScanOptions } from "../monitors/transcripts.ts";
import { drainTranscriptWarnings } from "../monitors/transcript-warnings.ts";
import { isTranscriptOnlyAgent } from "../monitors/transcript-sources.ts";
import { fmtInt, resolveDirFlag } from "./lib.ts";

export const ARCHIVE_USAGE = `usage: ach archive [--agent A] [--days N] [--out DIR] [--state-dir <stateDir>] [--json]
       ach archive --restore <batch|latest|all> [--to DIR] [--out DIR] [--json]

  Copies machine transcripts (~/.claude/projects, ~/.codex/sessions,
  ~/.gemini/tmp, and the read-only amp/goose/qwen/cursor stores; SQLite
  stores are snapshotted), harness raw transcripts (<stateDir>/raw) and registry
  records (<stateDir>/runs) into DIR (default <stateDir>/warehouse/<batch>/)
  with a manifest.jsonl (sourcePath, sha256, runId). Unchanged files are never
  re-copied and nothing is ever deleted. --days N keeps files modified in the
  last N days. --restore rebuilds a home-shaped tree under --to (default
  ./ach-restore-<batch>) that 'ach stats --transcript-dir' reads. Here --dir is
  an alias of --state-dir (for 'ach stats' it is the transcript root). See
  docs/ARCHIVE.md.`;

function optNum(v: string | undefined, flag: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) {
    throw new HarnessError(`${flag} expects a non-negative number, got '${v}'`, "USAGE");
  }
  return n;
}

export function formatArchiveText(r: ArchiveResult): string {
  const k = r.byKind;
  const head =
    r.batch === null
      ? `archived 0 files (nothing new; ${fmtInt(r.unchanged)} unchanged) — warehouse ${r.warehouseDir}`
      : `archived ${fmtInt(r.archived)} files (native ${k.native}, raw ${k.raw}, record ${k.record}; ${fmtInt(r.bytes)} bytes; ${fmtInt(r.unchanged)} unchanged) into ${path.join(r.warehouseDir, r.batch)}`;
  return head + "\n";
}

export async function cmdArchive(rest: string[]): Promise<number> {
  const args = parseArgs({
    args: rest,
    options: {
      agent: { type: "string" },
      days: { type: "string" },
      out: { type: "string" },
      dir: { type: "string" },
      "state-dir": { type: "string" },
      restore: { type: "string" },
      to: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });
  if (args.values.help) {
    process.stdout.write(ARCHIVE_USAGE + "\n");
    return 0;
  }
  const state = resolveDirFlag(args.values, "state-dir") ?? defaultStateDir();
  const wh = args.values.out ?? warehouseDir(state);

  if (args.values.restore !== undefined) {
    const batch = args.values.restore;
    const to = args.values.to ?? path.resolve(`ach-restore-${batch}`);
    let res;
    try {
      res = await restoreBatch({ warehouseDir: wh, batch, to });
    } catch (e) {
      throw new HarnessError((e as Error).message, "USAGE");
    }
    process.stdout.write(
      args.values.json
        ? JSON.stringify(res, null, 2) + "\n"
        : `restored ${fmtInt(res.restored)} files from ${res.batch} into ${res.to}\n` +
            `  read with: ach stats --transcript-dir ${res.to}   (state dir: ${res.stateDir})\n`,
    );
    return 0;
  }

  const agent = args.values.agent;
  if (agent && !isKnownAgent(agent) && !isTranscriptOnlyAgent(agent)) {
    throw new HarnessError(`unknown agent '${agent}' (expected one of: ${[...new Set([...AGENTS, ...transcriptAgentNames()])].join(", ")})`, "UNKNOWN_AGENT");
  }
  const days = optNum(args.values.days, "--days");
  const res = await archiveTranscripts({
    stateDir: state,
    warehouseDir: wh,
    ...(agent ? { agent } : {}),
    ...(days !== undefined ? { sinceMs: Date.now() - days * 86_400_000 } : {}),
  });
  for (const warning of drainTranscriptWarnings()) process.stderr.write(`[warn] ${warning}\n`);
  process.stdout.write(args.values.json ? JSON.stringify(res, null, 2) + "\n" : formatArchiveText(res));
  return 0;
}

// ---------------------------------------------------------------- ach stats glue

/** ScanOptions for `ach stats --dir <root>` (a home-shaped root, e.g. a restore). */
export function statsScanOptions(dir: string | undefined): ScanOptions {
  return dir ? scanOptionsForRoot(path.resolve(dir)) : {};
}

/** Machine transcript records: live scanAll, then (opt-in) archived copies whose live file is gone. */
export async function* statsMachineRecords(opts: {
  scan: ScanOptions;
  withWarehouse: boolean;
  stateDir: string;
}): AsyncGenerator<CanonicalTokenRecord> {
  yield* scanAll(opts.scan);
  if (opts.withWarehouse) yield* scanWarehouse({ warehouseDir: warehouseDir(opts.stateDir), live: opts.scan });
}

/** State records from archived <stateDir>/raw files whose live copy is gone. */
export async function warehouseStateRecords(state: string, opts: ReadRecordsOptions): Promise<StatRecord[]> {
  const files = warehouseRawFiles({ warehouseDir: warehouseDir(state), stateDir: state });
  return readRecordFiles(files.map((f) => ({ file: f, root: path.dirname(f) })), opts);
}
