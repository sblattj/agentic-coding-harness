// `ach pack <lock|add|list|show>` (#91): manage versioned task packs.
// The format, hashing and resolution live in src/cli/task-pack.ts; running a
// pack is `ach trial --pack` (src/cli/trial-pack.ts).
import { parseArgs } from "node:util";
import { HarnessError } from "../core/types.ts";
import {
  addToRegistry,
  diffLock,
  formatDrift,
  listRegistry,
  loadPack,
  lockfilePath,
  packsDir,
  readLock,
  resolvePackRef,
  writeLock,
} from "./task-pack.ts";

const PACK_USAGE = "usage: ach pack lock <path|name@version> | add <path> | list | show <path|name@version>  [--packs-dir DIR] [--json]";

export async function cmdPack(rest: string[]): Promise<number> {
  const args = parseArgs({
    args: rest,
    options: {
      "packs-dir": { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const [sub, ref, ...extra] = args.positionals;
  const json = args.values.json === true;
  const dirOpt = args.values["packs-dir"] !== undefined ? { packsDir: args.values["packs-dir"] } : {};
  const out = (v: unknown, text: string): void => {
    process.stdout.write(json ? JSON.stringify(v, null, 2) + "\n" : text + "\n");
  };
  if (extra.length > 0) throw new HarnessError(`pack: unexpected argument '${extra[0]}'. ${PACK_USAGE}`, "USAGE");
  switch (sub) {
    case "lock": {
      if (ref === undefined) throw new HarnessError(`pack lock needs a pack. ${PACK_USAGE}`, "USAGE");
      const pack = resolvePackRef(ref, dirOpt);
      const file = writeLock(pack);
      out(
        { locked: pack.ref, hash: pack.hash, lockfile: file, tasks: pack.tasks.map((t) => ({ id: t.id, hash: t.hash })) },
        `locked     ${pack.ref} ${pack.hash} (${pack.tasks.length} task${pack.tasks.length === 1 ? "" : "s"}) -> ${file}`,
      );
      return 0;
    }
    case "add": {
      if (ref === undefined) throw new HarnessError(`pack add needs a pack directory or manifest path. ${PACK_USAGE}`, "USAGE");
      const pack = resolvePackRef(ref, dirOpt);
      if (pack.resolvedFrom !== "path") throw new HarnessError(`pack add takes a path, not a registry reference (${ref})`, "USAGE");
      const root = packsDir(args.values["packs-dir"]);
      const r = addToRegistry(pack, root);
      out(
        { pack: pack.ref, hash: pack.hash, dest: r.dest, status: r.status },
        `${r.status === "added" ? "added     " : "unchanged "} ${pack.ref} ${pack.hash} -> ${r.dest}`,
      );
      return 0;
    }
    case "list": {
      if (ref !== undefined) throw new HarnessError(`pack list takes no argument. ${PACK_USAGE}`, "USAGE");
      const root = packsDir(args.values["packs-dir"]);
      const entries = listRegistry(root).map((e) => {
        try {
          const pack = loadPack(e.manifestPath, "registry");
          const lock = readLock(pack);
          return { ref: `${e.name}@${e.version}`, hash: pack.hash, tasks: pack.tasks.length, locked: lock !== null, path: e.manifestPath };
        } catch (err) {
          return { ref: `${e.name}@${e.version}`, error: err instanceof Error ? err.message : String(err), path: e.manifestPath };
        }
      });
      const text =
        entries.length === 0
          ? `no packs in ${root}`
          : entries
              .map((e) => ("error" in e ? `${e.ref}  INVALID: ${e.error}` : `${e.ref}  ${e.hash}  ${e.tasks} task(s)  ${e.locked ? "locked" : "unlocked"}`))
              .join("\n");
      out({ packsDir: root, packs: entries }, text);
      return 0;
    }
    case "show": {
      if (ref === undefined) throw new HarnessError(`pack show needs a pack. ${PACK_USAGE}`, "USAGE");
      const pack = resolvePackRef(ref, dirOpt);
      const lock = readLock(pack);
      const drift = lock === null ? [] : diffLock(pack, lock);
      const status = lock === null ? "unlocked" : drift.length === 0 ? "locked, in sync" : "locked, DRIFTED";
      out(
        {
          ref: pack.ref,
          hash: pack.hash,
          resolvedFrom: pack.resolvedFrom,
          manifestPath: pack.manifestPath,
          lockfile: lock === null ? null : lockfilePath(pack),
          locked: lock !== null,
          drift,
          tasks: pack.tasks.map((t) => ({ id: t.id, hash: t.hash })),
        },
        [
          `pack       ${pack.ref} ${pack.hash} (${status})`,
          `manifest   ${pack.manifestPath} (${pack.resolvedFrom})`,
          ...pack.tasks.map((t) => `task       ${t.id}  ${t.hash}`),
          ...drift.map((d) => `drift      ${formatDrift(d)}`),
        ].join("\n"),
      );
      return 0;
    }
    default:
      throw new HarnessError(sub === undefined ? PACK_USAGE : `pack: unknown subcommand '${sub}'. ${PACK_USAGE}`, "USAGE");
  }
}
