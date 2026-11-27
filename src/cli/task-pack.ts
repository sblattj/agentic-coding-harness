// Versioned task packs (#91): `ach-pack.json` manifests, content hashes,
// lockfiles and `name@version` resolution.
//
// A pack is a directory holding an `ach-pack.json` manifest:
//
//   { "name": "mypack", "version": "1.0.0",
//     "tasks": [ { "id": "a", "prompt": "..." },
//                { "id": "b", "promptFile": "prompts/b.md", "verify": "sh check.sh" },
//                { "dir": "tasks/c" } ] }
//
// Task entries are the matrix plan's task shapes (src/cli/trial-matrix.ts:
// inline and task-directory) plus `promptFile`, an inline task whose prompt
// lives in a file. Every task gets a content hash over everything that decides
// its result (prompt bytes, setup/verify commands, and every file of a task
// directory); the pack hash covers the name, the version and the task hashes.
//
// `ach pack lock` writes `ach-pack.lock.json` next to the manifest with those
// hashes. A run against a locked pack recomputes them first and refuses to
// start on any mismatch (`--allow-drift` downgrades that to a warning).
//
// Resolution: a reference that names an existing path is that pack (an
// optional `@version` must then match the manifest); anything else is
// `name@version` looked up in the local registry, laid out as
// `<packs dir>/<name>/<version>/ach-pack.json`, so versions coexist.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import { stateDir as defaultStateDir } from "../core/store.ts";
import { HarnessError } from "../core/types.ts";
import type { PackRunInfo } from "../core/registry.ts";
import { DirTaskSchema, InlineTaskSchema, loadTaskDir, type MatrixTaskInput } from "./trial-matrix.ts";

export const PACK_MANIFEST = "ach-pack.json";
export const PACK_LOCKFILE = "ach-pack.lock.json";
/** Env var naming the local pack registry (beaten by `--packs-dir`). */
export const PACKS_DIR_ENV = "AGENTIC_CODING_HARNESS_PACKS_DIR";

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Semver 2.0.0 (the official regex, without the named groups). */
export const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** An inline task whose prompt is read from a file (relative to the manifest's directory). */
export const PromptFileTaskSchema = InlineTaskSchema.omit({ prompt: true }).extend({ promptFile: z.string().min(1) }).strict();

export const PackTaskSchema = z.union([InlineTaskSchema, PromptFileTaskSchema, DirTaskSchema]);

export const PackManifestSchema = z
  .object({
    $schema: z.string().optional(),
    name: z.string().regex(NAME_RE, { error: "name must match [A-Za-z0-9][A-Za-z0-9._-]* (no '@' or '/')" }),
    version: z.string().regex(SEMVER_RE, { error: "version must be semver (e.g. 1.0.0)" }),
    description: z.string().optional(),
    tasks: z.array(PackTaskSchema).min(1),
  })
  .strict();

export type PackManifest = z.output<typeof PackManifestSchema>;
type PackTask = z.output<typeof PackTaskSchema>;

const HASH_RE = /^sha256:[0-9a-f]{64}$/;

export const PackLockSchema = z
  .object({
    lockfileVersion: z.literal(1),
    name: z.string().min(1),
    version: z.string().min(1),
    hash: z.string().regex(HASH_RE),
    tasks: z.array(z.object({ id: z.string().min(1), hash: z.string().regex(HASH_RE) }).strict()),
  })
  .strict();
export type PackLock = z.output<typeof PackLockSchema>;

/** One pack task after resolution: its id, its content hash and the matrix task it becomes. */
export interface ResolvedPackTask {
  id: string;
  hash: string;
  /** A matrix plan task (src/cli/trial-matrix.ts), relative to the manifest's directory. */
  task: MatrixTaskInput;
}

export interface ResolvedPack {
  name: string;
  version: string;
  /** `name@version`. */
  ref: string;
  hash: string;
  /** Absolute manifest path and its directory. */
  manifestPath: string;
  dir: string;
  resolvedFrom: "path" | "registry";
  tasks: ResolvedPackTask[];
}

// ------------------------------------------------------------------ hashing

const sha = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

/** JSON with sorted object keys, so a hash never depends on key order. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/**
 * Every entry under `dir` (sorted relative paths, `/`-separated): regular
 * files by content hash, symlinks by their target text. Directories count
 * only through what they hold.
 */
function treeDigest(dir: string): string {
  const lines: string[] = [];
  const walk = (rel: string): void => {
    const abs = path.join(dir, rel);
    for (const e of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const childRel = rel === "" ? e.name : `${rel}/${e.name}`;
      const childAbs = path.join(dir, childRel);
      if (e.isSymbolicLink()) lines.push(`l ${childRel} ${fs.readlinkSync(childAbs)}`);
      else if (e.isDirectory()) walk(childRel);
      else if (e.isFile()) lines.push(`f ${childRel} ${sha(fs.readFileSync(childAbs))}`);
    }
  };
  walk("");
  return sha(lines.join("\n"));
}

/** The pack hash: name, version and the ordered (id, hash) list. */
export function packHash(name: string, version: string, tasks: readonly { id: string; hash: string }[]): string {
  return `sha256:${sha(stableJson({ name, version, tasks: tasks.map((t) => ({ id: t.id, hash: t.hash })) }))}`;
}

// ------------------------------------------------------------------ manifest

function readJsonFile(file: string, what: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    throw new HarnessError(`cannot read ${what} ${file}: ${e instanceof Error ? e.message : String(e)}`, "USAGE");
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new HarnessError(`${what} ${file} is not JSON: ${e instanceof Error ? e.message : String(e)}`, "USAGE");
  }
}

export function loadPackManifest(file: string): PackManifest {
  const parsed = PackManifestSchema.safeParse(readJsonFile(file, "pack manifest"));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new HarnessError(`invalid pack manifest ${file}: ${issues}`, "USAGE");
  }
  return parsed.data;
}

function entryLabel(t: PackTask, i: number): string {
  if ("dir" in t) return t.id ?? t.dir;
  return t.id ?? `#${i + 1}`;
}

/**
 * Resolve every task of a manifest: read prompt files and task directories,
 * compute the hashes. Throws a USAGE error naming the task when anything it
 * references is missing, so a bad pack fails before any agent launches.
 */
export function resolvePackTasks(manifest: PackManifest, dir: string): ResolvedPackTask[] {
  const where = `pack ${manifest.name}@${manifest.version}`;
  const out: ResolvedPackTask[] = [];
  const seen = new Set<string>();
  manifest.tasks.forEach((t, i) => {
    let resolved: ResolvedPackTask;
    if ("dir" in t) {
      const abs = path.resolve(dir, t.dir);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
        throw new HarnessError(`${where}: task '${entryLabel(t, i)}': task directory ${t.dir} not found (${abs})`, "USAGE");
      }
      let id: string;
      try {
        id = loadTaskDir(abs, t.id !== undefined ? { id: t.id } : {}).id;
      } catch (e) {
        throw new HarnessError(`${where}: task '${entryLabel(t, i)}': ${e instanceof Error ? e.message : String(e)}`, "USAGE");
      }
      const { dir: _rel, ...rest } = t;
      resolved = { id, hash: `sha256:${sha(stableJson({ kind: "dir", entry: rest, tree: treeDigest(abs) }))}`, task: { ...t } };
    } else if ("promptFile" in t) {
      const abs = path.resolve(dir, t.promptFile);
      let prompt: Buffer;
      try {
        prompt = fs.readFileSync(abs);
      } catch {
        throw new HarnessError(`${where}: task '${t.id}': prompt file ${t.promptFile} not found (${abs})`, "USAGE");
      }
      const text = prompt.toString("utf8").trim();
      if (text === "") throw new HarnessError(`${where}: task '${t.id}': prompt file ${t.promptFile} is empty`, "USAGE");
      const { promptFile: _pf, ...rest } = t;
      const task = { ...rest, prompt: text, workspace: t.workspace ?? "fresh" } as const;
      resolved = { id: t.id, hash: `sha256:${sha(stableJson({ kind: "inline", entry: task }))}`, task };
    } else {
      const task = { ...t, workspace: t.workspace ?? "fresh" } as const;
      resolved = { id: t.id, hash: `sha256:${sha(stableJson({ kind: "inline", entry: task }))}`, task };
    }
    if (seen.has(resolved.id)) throw new HarnessError(`${where}: duplicate task id '${resolved.id}'`, "USAGE");
    seen.add(resolved.id);
    out.push(resolved);
  });
  return out;
}

/** Load a manifest file and resolve it completely. */
export function loadPack(manifestPath: string, resolvedFrom: ResolvedPack["resolvedFrom"]): ResolvedPack {
  const abs = path.resolve(manifestPath);
  const manifest = loadPackManifest(abs);
  const dir = path.dirname(abs);
  const tasks = resolvePackTasks(manifest, dir);
  return {
    name: manifest.name,
    version: manifest.version,
    ref: `${manifest.name}@${manifest.version}`,
    hash: packHash(manifest.name, manifest.version, tasks),
    manifestPath: abs,
    dir,
    resolvedFrom,
    tasks,
  };
}

// ------------------------------------------------------------------ registry + references

/** The local registry: `--packs-dir`, else the env var, else `<stateDir>/packs`. */
export function packsDir(override?: string, stateDir: string = defaultStateDir()): string {
  if (override !== undefined && override.trim() !== "") return path.resolve(override);
  const env = process.env[PACKS_DIR_ENV];
  if (env !== undefined && env.trim() !== "") return path.resolve(env);
  return path.join(stateDir, "packs");
}

/** Every `name@version` in a registry dir, sorted by name then version. */
export function listRegistry(root: string): { name: string; version: string; manifestPath: string }[] {
  const out: { name: string; version: string; manifestPath: string }[] = [];
  if (!fs.existsSync(root)) return out;
  for (const n of fs.readdirSync(root, { withFileTypes: true })) {
    if (!n.isDirectory()) continue;
    for (const v of fs.readdirSync(path.join(root, n.name), { withFileTypes: true })) {
      const manifestPath = path.join(root, n.name, v.name, PACK_MANIFEST);
      if (v.isDirectory() && fs.existsSync(manifestPath)) out.push({ name: n.name, version: v.name, manifestPath });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || compareSemver(a.version, b.version));
}

/** Semver precedence (prerelease < release; build metadata ignored); non-semver sorts as text. */
export function compareSemver(a: string, b: string): number {
  const ma = SEMVER_RE.exec(a);
  const mb = SEMVER_RE.exec(b);
  if (ma === null || mb === null) return a.localeCompare(b);
  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i]);
    if (d !== 0) return d;
  }
  const pa = ma[4];
  const pb = mb[4];
  if (pa === undefined || pb === undefined) return pa === pb ? 0 : pa === undefined ? 1 : -1;
  const xa = pa.split(".");
  const xb = pb.split(".");
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    const s = xa[i];
    const t = xb[i];
    if (s === undefined) return -1;
    if (t === undefined) return 1;
    const ns = /^\d+$/.test(s);
    const nt = /^\d+$/.test(t);
    if (ns && nt) {
      const d = Number(s) - Number(t);
      if (d !== 0) return d;
    } else if (ns !== nt) return ns ? -1 : 1;
    else if (s !== t) return s < t ? -1 : 1;
  }
  return 0;
}

function manifestAt(p: string): string | null {
  if (!fs.existsSync(p)) return null;
  return fs.statSync(p).isDirectory() ? path.join(p, PACK_MANIFEST) : p;
}

/**
 * Resolve a pack reference: an existing path (a pack dir or a manifest file,
 * optionally followed by `@<version>` which must match), else `name@version`
 * in the registry. A bare registry name is refused: a reproducible trial
 * names its version. Remote URLs are not fetched.
 */
export function resolvePackRef(ref: string, opts: { packsDir?: string; stateDir?: string } = {}): ResolvedPack {
  const raw = ref.trim();
  if (raw === "") throw new HarnessError("--pack needs a reference: <path> or <name>@<version>", "USAGE");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    throw new HarnessError(`--pack ${raw}: remote pack URLs are not supported; download the pack and pass its path`, "USAGE");
  }
  // An `@` followed by a path segment (`./node_modules/@scope/pack`) is part
  // of the path, not a version.
  const at = raw.lastIndexOf("@");
  const tail = at > 0 ? raw.slice(at + 1) : undefined;
  const hasVersion = tail !== undefined && !tail.includes("/") && !tail.includes(path.sep);
  const head = hasVersion ? raw.slice(0, at) : raw;
  const version = hasVersion ? tail : undefined;
  // 1. Explicit path: the whole reference, then the part before `@version`
  // when it is spelled as a path (`./mypack@1.0.0`, `packs/mypack@1.0.0`), so
  // a bare `mypack@1.0.0` always means the registry entry even when a
  // `mypack/` directory happens to sit in the cwd.
  const looksLikePath = (p: string): boolean => p.includes("/") || p.includes(path.sep) || p.startsWith(".") || p.endsWith(".json");
  const direct = looksLikePath(raw) || version === undefined ? manifestAt(path.resolve(raw)) : null;
  if (direct === null && version !== undefined && !SEMVER_RE.test(version)) {
    throw new HarnessError(`--pack ${raw}: '${version}' is not a semver version (e.g. 1.0.0)`, "USAGE");
  }
  const pathManifest = direct ?? (version !== undefined && looksLikePath(head) ? manifestAt(path.resolve(head)) : null);
  if (pathManifest !== null) {
    if (!fs.existsSync(pathManifest)) throw new HarnessError(`--pack ${raw}: no ${PACK_MANIFEST} in ${path.dirname(pathManifest)}`, "USAGE");
    const pack = loadPack(pathManifest, "path");
    if (direct === null && version !== undefined && pack.version !== version) {
      throw new HarnessError(`--pack ${raw}: ${pathManifest} is version ${pack.version}, not ${version}`, "USAGE");
    }
    return pack;
  }
  // 2. The local registry.
  const root = packsDir(opts.packsDir, opts.stateDir);
  if (!NAME_RE.test(head)) throw new HarnessError(`--pack ${raw}: no such path, and not a <name>@<version> reference`, "USAGE");
  const versions = listRegistry(root).filter((e) => e.name === head);
  if (version === undefined) {
    throw new HarnessError(
      `--pack ${raw}: a registry pack needs an explicit version (${head}@<version>); available: ${versions.map((v) => `${head}@${v.version}`).join(", ") || "none"} in ${root}`,
      "USAGE",
    );
  }
  const hit = versions.find((v) => v.version === version);
  if (hit === undefined) {
    throw new HarnessError(
      `--pack ${raw}: not found in ${root} (versions of ${head}: ${versions.map((v) => v.version).join(", ") || "none"})`,
      "USAGE",
    );
  }
  const pack = loadPack(hit.manifestPath, "registry");
  if (pack.name !== head || pack.version !== version) {
    throw new HarnessError(`--pack ${raw}: ${hit.manifestPath} declares ${pack.ref}; the registry path and manifest disagree`, "USAGE");
  }
  return pack;
}

// ------------------------------------------------------------------ lockfile

export function lockfilePath(pack: Pick<ResolvedPack, "dir">): string {
  return path.join(pack.dir, PACK_LOCKFILE);
}

export function lockOf(pack: ResolvedPack): PackLock {
  return { lockfileVersion: 1, name: pack.name, version: pack.version, hash: pack.hash, tasks: pack.tasks.map((t) => ({ id: t.id, hash: t.hash })) };
}

/** Write `ach-pack.lock.json` next to the manifest; returns its path. */
export function writeLock(pack: ResolvedPack): string {
  const file = lockfilePath(pack);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(lockOf(pack), null, 2) + "\n");
  fs.renameSync(tmp, file);
  return file;
}

/** The pack's lockfile, or null when it has none. */
export function readLock(pack: Pick<ResolvedPack, "dir">): PackLock | null {
  const file = lockfilePath(pack);
  if (!fs.existsSync(file)) return null;
  const parsed = PackLockSchema.safeParse(readJsonFile(file, "pack lockfile"));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new HarnessError(`invalid pack lockfile ${file}: ${issues}`, "USAGE");
  }
  return parsed.data;
}

export interface PackDrift {
  /** A task id, or `(pack)` for a name/version change. */
  id: string;
  kind: "changed" | "added" | "removed" | "identity" | "hash";
  locked?: string;
  now?: string;
  /** kind "hash": the task order differs from the lockfile's. */
  order?: boolean;
}

/** Every difference between the pack as it is now and its lockfile. Empty = in sync. */
export function diffLock(pack: ResolvedPack, lock: PackLock): PackDrift[] {
  const drift: PackDrift[] = [];
  if (lock.name !== pack.name || lock.version !== pack.version) {
    drift.push({ id: "(pack)", kind: "identity", locked: `${lock.name}@${lock.version}`, now: pack.ref });
  }
  const locked = new Map(lock.tasks.map((t) => [t.id, t.hash]));
  for (const t of pack.tasks) {
    const h = locked.get(t.id);
    if (h === undefined) drift.push({ id: t.id, kind: "added", now: t.hash });
    else if (h !== t.hash) drift.push({ id: t.id, kind: "changed", locked: h, now: t.hash });
  }
  const now = new Set(pack.tasks.map((t) => t.id));
  for (const t of lock.tasks) if (!now.has(t.id)) drift.push({ id: t.id, kind: "removed", locked: t.hash });
  // The pack hash also covers task order, and catches a hand-edited lockfile
  // hash: every per-task hash can match while the pack hash does not.
  if (drift.length === 0 && lock.hash !== pack.hash) {
    const order = lock.tasks.map((t) => t.id).join(",") !== pack.tasks.map((t) => t.id).join(",");
    drift.push({ id: "(pack)", kind: "hash", locked: lock.hash, now: pack.hash, ...(order ? { order: true } : {}) });
  }
  return drift;
}

const short = (h: string | undefined): string => (h === undefined ? "none" : h.slice(0, "sha256:".length + 12));

export function formatDrift(d: PackDrift): string {
  switch (d.kind) {
    case "changed":
      return `task '${d.id}' changed (locked ${short(d.locked)}, now ${short(d.now)})`;
    case "added":
      return `task '${d.id}' is not in the lockfile`;
    case "removed":
      return `task '${d.id}' is in the lockfile but not in the manifest`;
    case "identity":
      return `the lockfile pins ${d.locked}, the manifest is ${d.now}`;
    case "hash":
      return d.order === true
        ? `the task order changed (locked pack hash ${short(d.locked)}, now ${short(d.now)})`
        : `the pack hash does not match the lockfile (locked ${short(d.locked)}, now ${short(d.now)})`;
  }
}

export interface PackCheck {
  locked: boolean;
  drift: PackDrift[];
  /** Warning lines to print (drift under --allow-drift, or an unlocked pack). */
  warnings: string[];
}

/**
 * The pre-launch check: verify the pack against its lockfile. Mismatch
 * without `allowDrift` throws a USAGE error naming every changed task; with
 * it, the same detail comes back as warnings.
 */
export function checkPackLock(pack: ResolvedPack, allowDrift: boolean): PackCheck {
  const lock = readLock(pack);
  if (lock === null) {
    return { locked: false, drift: [], warnings: [`pack ${pack.ref} is not locked (no ${PACK_LOCKFILE}); \`ach pack lock\` pins its content hashes`] };
  }
  const drift = diffLock(pack, lock);
  if (drift.length === 0) return { locked: true, drift, warnings: [] };
  const detail = drift.map(formatDrift).join("; ");
  if (!allowDrift) {
    throw new HarnessError(
      `pack ${pack.ref}: hash mismatch against ${lockfilePath(pack)}: ${detail}. ` +
        "Nothing was launched. Re-lock with `ach pack lock` if the change is intended, or pass --allow-drift to run anyway.",
      "PACK_DRIFT",
    );
  }
  return {
    locked: true,
    drift,
    warnings: [`DRIFT: pack ${pack.ref} does not match its lockfile (--allow-drift): ${detail}; the run records the current hash ${short(pack.hash)}`],
  };
}

/** The RunRecord `pack` block (without the per-task hash). */
export function packRunInfo(pack: ResolvedPack, check: PackCheck): Omit<PackRunInfo, "taskHash"> {
  return {
    name: pack.name,
    version: pack.version,
    hash: pack.hash,
    resolvedFrom: pack.resolvedFrom,
    manifestPath: pack.manifestPath,
    locked: check.locked,
    ...(check.drift.length > 0 ? { drift: check.drift.map((d) => d.id) } : {}),
  };
}

// ------------------------------------------------------------------ registry install

/**
 * Copy a pack directory into the registry at `<root>/<name>/<version>/`.
 * Every task must live inside the pack directory (a copy cannot carry
 * `../` references). An existing entry with the same hash is a no-op; a
 * different one is refused, because a published version must not change.
 */
export function addToRegistry(pack: ResolvedPack, root: string): { dest: string; status: "added" | "unchanged" } {
  const manifest = loadPackManifest(pack.manifestPath);
  manifest.tasks.forEach((t, i) => {
    const ref = "dir" in t ? t.dir : "promptFile" in t ? t.promptFile : undefined;
    if (ref === undefined) return;
    const rel = path.relative(pack.dir, path.resolve(pack.dir, ref));
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new HarnessError(
        `pack ${pack.ref}: task '${pack.tasks[i]?.id ?? entryLabel(t, i)}' references ${ref}, outside the pack directory; move it inside before adding`,
        "USAGE",
      );
    }
  });
  const dest = path.join(root, pack.name, pack.version);
  if (fs.existsSync(path.join(dest, PACK_MANIFEST))) {
    const existing = loadPack(path.join(dest, PACK_MANIFEST), "registry");
    if (existing.hash === pack.hash) return { dest, status: "unchanged" };
    throw new HarnessError(
      `pack ${pack.ref} is already in ${root} with different content (${short(existing.hash)} vs ${short(pack.hash)}); bump the version instead`,
      "USAGE",
    );
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.cpSync(pack.dir, tmp, { recursive: true, verbatimSymlinks: true });
  fs.renameSync(tmp, dest);
  return { dest, status: "added" };
}
