// Multi-directory data sources for `ach stats` / `ach watch` (#99).
//
//  - Several state dirs (`stats --state-dir A --state-dir B`): run records
//    merge by runId, usage files (<stateDir>/raw/**.jsonl, one file per
//    session/run) merge by their path under raw/.
//  - Several transcript roots (`--dir A --dir B`): machine transcript records
//    merge by agent + session id.
//  - Merge rule, the same everywhere: identical copies collapse silently; a
//    conflicting duplicate (same id, different content) writes ONE warning
//    naming every file path and keeps the copy with the newest mtime (ties:
//    the smallest path string), so the pick never depends on flag order.
//  - `--rewrite <from>=<to>`: path rules applied when reading, to the
//    path-bearing OUTPUT fields only (stats: byProject keys; watch: source
//    dirs). Zero rules = zero mutation.
//
// One state dir and at most one transcript root take the historical code path
// unchanged (openStatsSources below), so default output stays byte-identical.
import fs from "node:fs";
import path from "node:path";

import { registryDir, parseRunRecordDetailed, scanRunRecords, skippedRunRecordsWarning, type RunRecord, type SkippedRunRecord } from "../core/registry.ts";
import { listJsonlFiles, readRecordFiles, readStateDirRecords, sanitizeSession, type ReadRecordsOptions, type StatRecord } from "../core/store.ts";
import { HarnessError } from "../core/types.ts";
import { scanWarehouse } from "../core/warehouse.ts";
import { warehouseDir } from "../core/warehouse-index.ts";
import { readCursorDashboardStore } from "../monitors/cursor-dashboard.ts";
import { scanAll, type CanonicalTokenRecord } from "../monitors/transcripts.ts";
import { statsMachineRecords, statsScanOptions, warehouseStateRecords } from "./archive.ts";

// ---------------------------------------------------------------- --rewrite

export interface RewriteRule {
  from: string;
  to: string;
}

/**
 * Parse `--rewrite <from>=<to>` values. The FIRST `=` splits the pair (a
 * Windows target never needs one in `from`). A trailing separator on `from`
 * is dropped so `/mnt/c/` and `/mnt/c` are the same rule.
 */
export function parseRewriteRules(values: readonly string[] | undefined): RewriteRule[] {
  const out: RewriteRule[] = [];
  for (const v of values ?? []) {
    const eq = v.indexOf("=");
    if (eq <= 0 || eq === v.length - 1) {
      throw new HarnessError(`--rewrite expects <from>=<to>, e.g. /mnt/c=C: (got '${v}')`, "USAGE");
    }
    let from = v.slice(0, eq);
    while (from.length > 1 && (from.endsWith("/") || from.endsWith("\\"))) from = from.slice(0, -1);
    out.push({ from, to: v.slice(eq + 1) });
  }
  return out;
}

/** A drive-letter target (`C:` or `C:\`): the rewritten rest uses backslashes. */
const DRIVE_TARGET = /^[A-Za-z]:\\?$/;

/**
 * Rewrite one path by the rule whose `from` is the LONGEST prefix that ends
 * on a path-segment boundary (`/mnt/c` matches `/mnt/c/x`, never
 * `/mnt/cache`); equal lengths go to the rule given first. No match (or no
 * rules) returns the input unchanged. A drive-letter target flips the rest's
 * separators: `/mnt/c/Users/x/proj` with `/mnt/c=C:` -> `C:\Users\x\proj`.
 */
export function rewritePath(p: string, rules: readonly RewriteRule[]): string {
  let best: RewriteRule | undefined;
  for (const r of rules) {
    const hit = p === r.from || p.startsWith(r.from === "/" ? "/" : r.from + "/") || p.startsWith(r.from + "\\");
    if (hit && (best === undefined || r.from.length > best.from.length)) best = r;
  }
  if (best === undefined) return p;
  let rest = best.from === "/" ? p.slice(1) : p.slice(best.from.length);
  if (DRIVE_TARGET.test(best.to)) {
    const drive = best.to.slice(0, 2);
    rest = rest.replace(/^[/\\]+/, "").replace(/\//g, "\\");
    return `${drive}\\${rest}`;
  }
  if (best.from === "/") rest = "/" + rest;
  const to = best.to.length > 1 ? best.to.replace(/[/\\]+$/, "") : best.to;
  return rest === "" ? best.to : to + rest;
}

/** Output fields `--rewrite` maps, named in docs and in the text echo line. */
export const STATS_REWRITE_FIELDS = "byProject keys";
export const WATCH_REWRITE_FIELDS = "watch source dirs";

/** The `rewrites` array `--json` echoes (absent entirely when no rule is given). */
export function rewritesJson(rules: readonly RewriteRule[]): Array<{ from: string; to: string }> {
  return rules.map((r) => ({ from: r.from, to: r.to }));
}

/** The one text line that echoes the applied rules, or null with no rules. */
export function rewritesTextLine(rules: readonly RewriteRule[], fields: string): string | null {
  if (rules.length === 0) return null;
  return `${"rewrite".padEnd(9)} ${rules.map((r) => `${r.from}=${r.to}`).join(" ")} (applied to: ${fields})`;
}

// ---------------------------------------------------------------- merge rule

interface Copy<T> {
  /** File path named in the conflict warning and used as the tie-break. */
  file: string;
  mtimeMs: number;
  /** Canonical content compared for "identical" (raw bytes or a parsed JSON). */
  content: string;
  value: T;
}

function mtimeOf(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Pick one copy of a duplicated id. Copies whose content equals the first are
 * identical and collapse silently (the first wins). Otherwise the newest
 * mtime wins, ties broken by the smallest path string, and one warning line
 * names every path.
 */
function pickCopy<T>(label: string, copies: readonly Copy<T>[], warn: (line: string) => void, also?: string): Copy<T> {
  if (copies.length === 1 || copies.every((c) => c.content === copies[0]!.content)) return copies[0]!;
  const winner = [...copies].sort((a, b) => b.mtimeMs - a.mtimeMs || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))[0]!;
  warn(
    `[warn] multi-dir: conflicting duplicate ${label}: ${copies.map((c) => c.file).join(" vs ")}; keeping ${winner.file}${also ? ` ${also}` : ""} (newest mtime)`,
  );
  return winner;
}

// ---------------------------------------------------------------- state dirs

export interface RegistryScan {
  records: RunRecord[];
  skipped: SkippedRunRecord[];
}

/**
 * Run records of several state dirs, merged by runId (newest startedAt first,
 * like scanRunRecords). `owners` maps each runId whose copies CONFLICTED to
 * the index of the dir whose copy won, so that run's usage file follows it.
 */
export function mergeRunRecords(
  dirs: readonly string[],
  warn: (line: string) => void,
): { scan: RegistryScan; skippedByDir: Map<string, SkippedRunRecord[]>; owners: Map<string, { dir: number; rec: RunRecord }> } {
  const byId = new Map<string, Copy<{ rec: RunRecord; dir: number }>[]>();
  const order: string[] = [];
  const skippedByDir = new Map<string, SkippedRunRecord[]>();
  for (let i = 0; i < dirs.length; i++) {
    const dir = dirs[i]!;
    const reg = registryDir(dir);
    let names: string[];
    try {
      names = fs.readdirSync(reg).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(reg, name);
      let text: string;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const r = parseRunRecordDetailed(text);
      if (!r.ok) {
        const list = skippedByDir.get(dir) ?? [];
        list.push({ file: name, reason: r.reason });
        skippedByDir.set(dir, list);
        continue;
      }
      const id = r.record.runId;
      if (!byId.has(id)) {
        byId.set(id, []);
        order.push(id);
      }
      byId.get(id)!.push({ file, mtimeMs: mtimeOf(file), content: JSON.stringify(r.record), value: { rec: r.record, dir: i } });
    }
  }
  const owners = new Map<string, { dir: number; rec: RunRecord }>();
  const records = order.map((id) => {
    const copies = byId.get(id)!;
    const won = pickCopy(`run ${id}`, copies, warn, "and its usage file").value;
    if (!copies.every((c) => c.content === copies[0]!.content)) owners.set(id, won);
    return won.rec;
  });
  records.sort((a, b) => b.startedAt - a.startedAt);
  const skipped = [...skippedByDir.values()].flat();
  return { scan: { records, skipped }, skippedByDir, owners };
}

/** True when `rel` (a path under raw/) is the usage file of `rec`: either layout store.ts writes. */
function isUsageFileOf(rel: string, rec: RunRecord): boolean {
  const base = path.basename(rel, ".jsonl");
  const parent = path.dirname(rel);
  if (rec.rawTranscript !== undefined && path.basename(rec.rawTranscript) === path.basename(rel)) return true;
  if (rec.sessionId === undefined) return false;
  const sid = sanitizeSession(rec.sessionId);
  return (parent === rec.agent && base === sid) || (parent === "." && base === `${rec.agent}-${sid}`);
}

/**
 * Usage files of several state dirs, merged by their path under each dir's
 * `raw/` (one file per session or run, so the same run copied to two dirs
 * keeps one file). The usage file of a run whose record conflicted follows
 * the winning record's dir, with no second warning, so one run never mixes
 * one dir's record with another dir's tokens. Returned dir by dir, in the
 * order given.
 */
export async function mergeRawFiles(
  dirs: readonly string[],
  warn: (line: string) => void,
  owners: ReadonlyMap<string, { dir: number; rec: RunRecord }> = new Map(),
): Promise<Array<{ file: string; root: string }>> {
  const byRel = new Map<string, Copy<{ file: string; root: string; dir: number }>[]>();
  const order: string[] = [];
  const perDir: Array<Array<{ file: string; root: string }>> = [];
  for (let i = 0; i < dirs.length; i++) {
    const root = path.join(dirs[i]!, "raw");
    const mine: Array<{ file: string; root: string }> = [];
    perDir.push(mine);
    for (const file of await listJsonlFiles(root)) {
      const rel = path.relative(root, file);
      let content: string;
      try {
        content = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (!byRel.has(rel)) {
        byRel.set(rel, []);
        order.push(rel);
      }
      mine.push({ file, root });
      byRel.get(rel)!.push({ file, mtimeMs: mtimeOf(file), content, value: { file, root, dir: i } });
    }
  }
  const picked = new Set<string>();
  for (const rel of order) {
    const copies = byRel.get(rel)!;
    const owner = copies.length > 1 ? [...owners.values()].find((o) => isUsageFileOf(rel, o.rec)) : undefined;
    const owned = owner !== undefined ? copies.find((c) => c.value.dir === owner.dir) : undefined;
    picked.add((owned ?? pickCopy(`usage file raw/${rel}`, copies, warn)).value.file);
  }
  // Keep the historical read order: dir by dir, each dir's files as listed.
  return perDir.flatMap((files) => files.filter((f) => picked.has(f.file)));
}

/**
 * Rows from several dirs, merged as a multiset: a row a dir holds N times is
 * kept max(N over dirs) times, so a copy present in two or more dirs counts
 * once per real occurrence. Exported for tests.
 */
export function dropCrossDirCopies<T>(perDir: readonly T[][]): T[] {
  const most = new Map<string, number>();
  const out: T[] = [];
  for (const rows of perDir) {
    const seen = new Map<string, number>();
    for (const row of rows) {
      const k = JSON.stringify(row);
      const n = (seen.get(k) ?? 0) + 1;
      seen.set(k, n);
      if (n > (most.get(k) ?? 0)) out.push(row);
    }
    for (const [k, n] of seen) if (n > (most.get(k) ?? 0)) most.set(k, n);
  }
  return out;
}

// ---------------------------------------------------------------- transcript roots

/**
 * Machine transcript records from several home-shaped roots, merged by
 * agent + session id. A session present under two roots with the same
 * records counts once; with different records the newest file wins.
 * Records with no session id cannot be matched and pass through (the stats
 * dedupe key still collapses exact copies).
 */
export async function* mergedTranscriptRecords(roots: readonly string[], warn: (line: string) => void): AsyncGenerator<CanonicalTokenRecord> {
  type Group = { root: number; records: CanonicalTokenRecord[] };
  const perRoot: CanonicalTokenRecord[][] = [];
  const groups = new Map<string, Group[]>();
  const keyOf = (r: CanonicalTokenRecord) => (r.sessionId ? `${r.agent}\0${r.sessionId}` : null);
  for (let i = 0; i < roots.length; i++) {
    const rows: CanonicalTokenRecord[] = [];
    for await (const rec of scanAll(statsScanOptions(roots[i]))) rows.push(rec);
    perRoot.push(rows);
    for (const rec of rows) {
      const k = keyOf(rec);
      if (k === null) continue;
      const list = groups.get(k) ?? [];
      let g = list.find((x) => x.root === i);
      if (!g) {
        g = { root: i, records: [] };
        list.push(g);
        groups.set(k, list);
      }
      g.records.push(rec);
    }
  }
  const winner = new Map<string, number>();
  for (const [k, list] of groups) {
    if (list.length === 1) continue;
    const copies: Copy<number>[] = list.map((g) => {
      const files = [...new Set(g.records.map((r) => String((r as { sourcePath?: unknown }).sourcePath ?? "")))].sort();
      const content = g.records
        .map((r) => {
          const { sourcePath: _sp, ...rest } = r as CanonicalTokenRecord & { sourcePath?: unknown };
          return JSON.stringify(rest);
        })
        .sort()
        .join("\n");
      return { file: files.join(", "), mtimeMs: Math.max(0, ...files.map(mtimeOf)), content, value: g.root };
    });
    const [agent, session] = k.split("\0");
    winner.set(k, pickCopy(`session ${agent}/${session}`, copies, warn).value);
  }
  for (let i = 0; i < perRoot.length; i++) {
    for (const rec of perRoot[i]!) {
      const k = keyOf(rec);
      if (k !== null && winner.has(k) && winner.get(k) !== i) continue;
      yield rec;
    }
  }
}

/**
 * Archived transcript copies in one state dir's warehouse whose live file is
 * gone under EVERY given root (`--with-warehouse`): scanWarehouse checks one
 * root at a time, so only copies it yields for all roots are kept.
 */
async function* archivedTranscripts(stateDir: string, roots: readonly string[]): AsyncGenerator<CanonicalTokenRecord> {
  const whDir = warehouseDir(stateDir);
  const perRoot: CanonicalTokenRecord[][] = [];
  for (const root of roots.length > 0 ? roots : [undefined]) {
    const rows: CanonicalTokenRecord[] = [];
    for await (const rec of scanWarehouse({ warehouseDir: whDir, live: statsScanOptions(root) })) rows.push(rec);
    perRoot.push(rows);
  }
  const src = (r: CanonicalTokenRecord) => String((r as { sourcePath?: unknown }).sourcePath ?? "");
  const everywhere = perRoot.slice(1).reduce((acc, rows) => {
    const here = new Set(rows.map(src));
    return new Set([...acc].filter((f) => here.has(f)));
  }, new Set(perRoot[0]!.map(src)));
  for (const rec of perRoot[0]!) if (everywhere.has(src(rec))) yield rec;
}

// ---------------------------------------------------------------- stats sources

export interface StatsSources {
  /** The first state dir: the one single-dir helpers (unmetered runs) read. */
  primaryStateDir: string;
  /** <stateDir>/raw usage records (+ warehouse copies with --with-warehouse), unfiltered by window. */
  stateRecords: StatRecord[];
  registryScan: RegistryScan;
  /** stderr lines for unreadable run records, one per state dir that has any. */
  skippedWarnings: string[];
  cursorDashboard: () => CanonicalTokenRecord[];
  machineRecords: () => AsyncGenerator<CanonicalTokenRecord>;
}

/**
 * Everything `ach stats` reads from disk. One state dir and at most one
 * transcript root call exactly the helpers `ach stats` always called.
 */
export async function openStatsSources(opts: {
  stateDirs: readonly string[];
  transcriptDirs: readonly string[];
  withWarehouse: boolean;
  read: ReadRecordsOptions;
  warn: (line: string) => void;
}): Promise<StatsSources> {
  const { stateDirs, transcriptDirs, withWarehouse, read, warn } = opts;
  const primary = stateDirs[0]!;
  const multiState = stateDirs.length > 1;

  let stateRecords: StatRecord[];
  let registryScan: RegistryScan;
  let skippedWarnings: string[];
  if (!multiState) {
    stateRecords = [...(await readStateDirRecords(primary, read)), ...(withWarehouse ? await warehouseStateRecords(primary, read) : [])];
    registryScan = scanRunRecords(primary);
    const w = skippedRunRecordsWarning(primary, registryScan.skipped);
    skippedWarnings = w ? [w] : [];
  } else {
    const merged = mergeRunRecords(stateDirs, warn);
    const live = await readRecordFiles(await mergeRawFiles(stateDirs, warn, merged.owners), read);
    const archived = withWarehouse ? dropCrossDirCopies(await Promise.all(stateDirs.map((d) => warehouseStateRecords(d, read)))) : [];
    stateRecords = [...live, ...archived];
    registryScan = merged.scan;
    skippedWarnings = stateDirs.flatMap((d) => {
      const w = skippedRunRecordsWarning(d, merged.skippedByDir.get(d) ?? []);
      return w ? [w] : [];
    });
  }

  const cursorDashboard = (): CanonicalTokenRecord[] =>
    multiState ? dropCrossDirCopies(stateDirs.map((d) => readCursorDashboardStore(d))) : readCursorDashboardStore(primary);

  async function* machineRecords(): AsyncGenerator<CanonicalTokenRecord> {
    if (transcriptDirs.length <= 1) {
      yield* statsMachineRecords({ scan: statsScanOptions(transcriptDirs[0]), withWarehouse, stateDir: primary });
      for (const d of withWarehouse ? stateDirs.slice(1) : []) yield* archivedTranscripts(d, transcriptDirs);
      return;
    }
    yield* mergedTranscriptRecords(transcriptDirs, warn);
    for (const d of withWarehouse ? stateDirs : []) yield* archivedTranscripts(d, transcriptDirs);
  }

  return { primaryStateDir: primary, stateRecords, registryScan, skippedWarnings, cursorDashboard, machineRecords };
}

