// Read side of the transcript warehouse (#79): manifest parsing and the
// archived-copy lookup that resolveRawTranscript falls back to.
//
// Layout (written by src/core/warehouse.ts):
//   <warehouse>/<batch>/manifest.jsonl          one ManifestLine per copied file
//   <warehouse>/<batch>/native/<agent>/<rel>    machine CLI transcripts (scanAll sources)
//   <warehouse>/<batch>/raw/<basename>          harness raw transcripts (<stateDir>/raw)
//   <warehouse>/<batch>/runs/<runId>.json       registry RunRecords
// <batch> is a date-led, filesystem-safe ISO timestamp, so lexical order is
// chronological order.
//
// This module deliberately imports nothing from registry.ts: registry.ts
// imports it (resolveRawTranscript fallback), and warehouse.ts imports both.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

export const WAREHOUSE_DIRNAME = "warehouse";
export const MANIFEST_NAME = "manifest.jsonl";

/** Default warehouse root: <stateDir>/warehouse. */
export function warehouseDir(stateDir: string): string {
  return path.join(stateDir, WAREHOUSE_DIRNAME);
}

export const ManifestLineSchema = z.object({
  v: z.literal(1),
  batch: z.string(),
  /** native = machine CLI transcript; raw = <stateDir>/raw file; record = RunRecord JSON. */
  kind: z.enum(["native", "raw", "record"]),
  agent: z.string(),
  /** Absolute path the file was copied from. */
  sourcePath: z.string(),
  /** Path relative to its source root (the CLI's transcript dir, <stateDir>/raw, or <stateDir>/runs). */
  relPath: z.string(),
  /** Path of the copy, relative to the warehouse root. */
  archivePath: z.string(),
  sha256: z.string(),
  size: z.number(),
  mtimeMs: z.number(),
  /** null when the file name does not expose one (never guessed). */
  sessionId: z.string().nullable(),
  /** null when no registry record links to this file (never guessed). */
  runId: z.string().nullable(),
  /** Every registry record sharing the file (resumed sessions share one raw transcript). */
  runIds: z.array(z.string()).optional(),
  archivedAt: z.string(),
});
export type ManifestLine = z.infer<typeof ManifestLineSchema>;

const BATCH_RE = /^\d{4}-\d{2}-\d{2}T/;

/** Batch ids under a warehouse root, oldest first. */
export function listBatches(whDir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(whDir);
  } catch {
    return [];
  }
  return names.filter((n) => BATCH_RE.test(n) && fs.existsSync(path.join(whDir, n, MANIFEST_NAME))).sort();
}

/** One batch's manifest lines; malformed lines are skipped, never thrown. */
export function readBatchManifest(whDir: string, batch: string): ManifestLine[] {
  let text: string;
  try {
    text = fs.readFileSync(path.join(whDir, batch, MANIFEST_NAME), "utf8");
  } catch {
    return [];
  }
  const out: ManifestLine[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const parsed = ManifestLineSchema.safeParse(JSON.parse(t));
      if (parsed.success) out.push(parsed.data);
    } catch {
      // partial line from an interrupted write: skip
    }
  }
  return out;
}

/** Every manifest line across all batches, oldest batch first. */
export function readManifest(whDir: string): ManifestLine[] {
  return listBatches(whDir).flatMap((b) => readBatchManifest(whDir, b));
}

/** Identity of one source file across batches. */
export function entryKey(l: Pick<ManifestLine, "kind" | "agent" | "relPath">): string {
  return `${l.kind}\u0000${l.agent}\u0000${l.relPath}`;
}

/** Newest archived copy per source file (later batches win). */
export function latestEntries(lines: ManifestLine[]): Map<string, ManifestLine> {
  const out = new Map<string, ManifestLine>();
  for (const l of lines) {
    const prev = out.get(entryKey(l));
    if (!prev || prev.batch <= l.batch) out.set(entryKey(l), l);
  }
  return out;
}

// Per-process cache of the raw-transcript index, keyed by warehouse root and
// invalidated whenever the batch list changes (one readdir per lookup).
const rawIndexCache = new Map<string, { batches: string; byBase: Map<string, string> }>();

/**
 * Absolute path of the newest archived copy of the harness raw transcript
 * `<basename>` under <stateDir>/warehouse, or null when none exists on disk.
 */
export function findArchivedRaw(stateDir: string, basename: string): string | null {
  const wh = warehouseDir(stateDir);
  const batches = listBatches(wh);
  if (batches.length === 0) return null;
  const sig = batches.join("\n");
  let cached = rawIndexCache.get(wh);
  if (!cached || cached.batches !== sig) {
    const byBase = new Map<string, string>();
    for (const l of latestEntries(readManifest(wh)).values()) {
      if (l.kind === "raw") byBase.set(path.basename(l.relPath), path.join(wh, l.archivePath));
    }
    cached = { batches: sig, byBase };
    rawIndexCache.set(wh, cached);
  }
  const hit = cached.byBase.get(basename);
  return hit !== undefined && fs.existsSync(hit) ? hit : null;
}
