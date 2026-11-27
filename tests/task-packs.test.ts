// Versioned task packs (#91): `ach-pack.json`, `ach pack lock|add|list|show`
// and `ach trial --pack <path|name>@<version>`. Every run launches only the
// deterministic `null` adapter (no CLI, no network) against a temp state dir.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { readLedger } from "../src/cli/trial-matrix.ts";
import {
  checkPackLock,
  compareSemver,
  loadPack,
  packHash,
  resolvePackRef,
  writeLock,
} from "../src/cli/task-pack.ts";
import { scanRunRecords } from "../src/core/registry.ts";
import { maskForExport } from "../src/core/masking.ts";

const REPO = path.resolve(new URL("..", import.meta.url).pathname);
const CLI = path.join(REPO, "src", "cli", "ach.ts");

let root: string;
let seq = 0;
before(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ach-packs-")));
});
after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

interface Scratch {
  dir: string;
  state: string;
  home: string;
  packs: string;
  env: Record<string, string>;
}

function scratch(name: string): Scratch {
  const dir = path.join(root, `${name}-${seq++}`);
  const state = path.join(dir, "state");
  const home = path.join(dir, "home");
  const packs = path.join(dir, "registry");
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  return { dir, state, home, packs, env: { AGENTIC_CODING_HARNESS_STATE_DIR: state, HOME: home } };
}

function runCli(args: string[], env: Record<string, string>, cwd?: string): { code: number | null; stdout: string; stderr: string } {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  const base: NodeJS.ProcessEnv = { ...process.env };
  delete base.AGENTIC_CODING_HARNESS_NULL_EXIT;
  delete base.AGENTIC_CODING_HARNESS_PACKS_DIR;
  const p = spawnSync(process.execPath, isBun ? [CLI, ...args] : ["--import", import.meta.resolve("tsx"), CLI, ...args], {
    env: { ...base, ...env },
    encoding: "utf8",
    ...(cwd !== undefined ? { cwd } : {}),
  });
  return { code: p.status, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

/**
 * A pack directory: an inline task `inline-a`, a prompt-file task `file-b`
 * and a task directory `dir-c` (with a passing verify.sh), plus an UNLISTED
 * sibling task directory that must never run.
 */
function writePack(dir: string, version = "1.0.0", promptB = "Summarize the README.\n"): string {
  fs.mkdirSync(path.join(dir, "prompts"), { recursive: true });
  fs.mkdirSync(path.join(dir, "tasks", "dir-c"), { recursive: true });
  fs.mkdirSync(path.join(dir, "tasks", "unlisted"), { recursive: true });
  fs.writeFileSync(path.join(dir, "prompts", "b.md"), promptB);
  fs.writeFileSync(path.join(dir, "tasks", "dir-c", "task.md"), "Create hello.txt.\n");
  fs.writeFileSync(path.join(dir, "tasks", "dir-c", "verify.sh"), "exit 0\n");
  fs.writeFileSync(path.join(dir, "tasks", "unlisted", "task.md"), "This task is not in the manifest.\n");
  fs.writeFileSync(
    path.join(dir, "ach-pack.json"),
    JSON.stringify(
      {
        name: "mypack",
        version,
        description: "fixture pack",
        tasks: [
          { id: "inline-a", prompt: "Print the word ok.", verify: "true" },
          { id: "file-b", promptFile: "prompts/b.md" },
          { dir: "tasks/dir-c" },
        ],
      },
      null,
      2,
    ),
  );
  return dir;
}

function packsOf(state: string): { task: string; pack: Record<string, unknown> | undefined }[] {
  return scanRunRecords(state).records.map((r) => ({ task: String(r.cellId ?? "").split(":")[1] ?? "", pack: r.pack as Record<string, unknown> | undefined }));
}

describe("ach trial --pack: acceptance (#91)", () => {
  it("a pack with version 1.0.0 runs via --pack mypack@1.0.0 and only its listed tasks execute", () => {
    const s = scratch("listed");
    writePack(path.join(s.dir, "src-pack"));
    const add = runCli(["pack", "add", path.join(s.dir, "src-pack"), "--packs-dir", s.packs], s.env);
    assert.equal(add.code, 0, add.stderr);
    const r = runCli(["trial", "--pack", "mypack@1.0.0", "--packs-dir", s.packs, "--agent", "null", "--json"], s.env);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.experiment, "pack/mypack@1.0.0");
    assert.deepEqual(out.tasks, ["inline-a", "file-b", "dir-c"]);
    assert.equal(out.summary.total, 3);
    const rows = readLedger(out.ledger).rows;
    assert.deepEqual(rows.map((row) => row.task).sort(), ["dir-c", "file-b", "inline-a"]);
    const ran = packsOf(s.state).map((p) => p.task).sort();
    assert.deepEqual(ran, ["dir-c", "file-b", "inline-a"], "exactly the listed tasks ran; 'unlisted' never did");
    assert.ok(!ran.includes("unlisted"));
  });

  it("the run record includes pack name, version and content hash (and the task's own hash)", () => {
    const s = scratch("record");
    const dir = writePack(path.join(s.dir, "p"));
    const show = runCli(["pack", "show", dir, "--json"], s.env);
    assert.equal(show.code, 0, show.stderr);
    const shown = JSON.parse(show.stdout);
    const r = runCli(["trial", "--pack", dir, "--agent", "null"], s.env);
    assert.equal(r.code, 0, r.stderr);
    const recs = packsOf(s.state);
    assert.equal(recs.length, 3);
    for (const { task, pack } of recs) {
      assert.ok(pack !== undefined, `run for ${task} has a pack block`);
      assert.equal(pack.name, "mypack");
      assert.equal(pack.version, "1.0.0");
      assert.equal(pack.hash, shown.hash);
      assert.match(String(pack.hash), /^sha256:[0-9a-f]{64}$/);
      assert.equal(pack.taskHash, shown.tasks.find((t: { id: string }) => t.id === task).hash);
      assert.equal(pack.locked, false);
      assert.equal(pack.resolvedFrom, "path");
    }
    // The ach report artifacts and HTML cite pack@version + hash, never the manifest path.
    const html = fs.readFileSync(r.stdout.match(/report {5}(\S+)/)![1]!, "utf8");
    assert.match(html, /<h3>task packs<\/h3>/);
    assert.ok(html.includes("mypack@1.0.0") && html.includes(shown.hash), "report names pack@version and the hash");
    // The task packs table cites identity only (the verify column elsewhere
    // shows each task's verify command, as for --suite).
    const table = html.slice(html.indexOf("<h3>task packs</h3>"), html.indexOf("</table>", html.indexOf("<h3>task packs</h3>")));
    assert.ok(table.includes("mypack@1.0.0") && table.includes(shown.hash), "the table cites pack@version and the hash");
    assert.ok(!table.includes(dir), "the task packs table never names the pack's directory");
    assert.ok(!html.includes("ach-pack.json"), "the report never names the manifest file");
  });

  it("modifying a task file after `ach pack lock` refuses the next run with a hash mismatch naming the changed task", () => {
    const s = scratch("drift");
    const dir = writePack(path.join(s.dir, "p"));
    const lock = runCli(["pack", "lock", dir], s.env);
    assert.equal(lock.code, 0, lock.stderr);
    assert.ok(fs.existsSync(path.join(dir, "ach-pack.lock.json")));
    const clean = runCli(["trial", "--pack", dir, "--agent", "null", "--dry-run"], s.env);
    assert.equal(clean.code, 0, `a locked, unchanged pack runs: ${clean.stderr}`);
    fs.writeFileSync(path.join(dir, "tasks", "dir-c", "verify.sh"), "exit 1\n");
    const r = runCli(["trial", "--pack", dir, "--agent", "null"], s.env);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /hash mismatch/);
    assert.match(r.stderr, /task 'dir-c' changed/);
    assert.doesNotMatch(r.stderr, /task '(inline-a|file-b)' changed/, "only the changed task is named");
    assert.deepEqual(scanRunRecords(s.state).records, [], "no agent launched");
    assert.ok(!fs.existsSync(path.join(s.state, "packs-runs")), "no ledger written");
  });

  it("--allow-drift overrides the refusal with a visible warning and records the drift", () => {
    const s = scratch("allow");
    const dir = writePack(path.join(s.dir, "p"));
    assert.equal(runCli(["pack", "lock", dir], s.env).code, 0);
    fs.writeFileSync(path.join(dir, "prompts", "b.md"), "A different prompt.\n");
    const now = loadPack(path.join(dir, "ach-pack.json"), "path");
    const r = runCli(["trial", "--pack", dir, "--agent", "null", "--allow-drift", "--json"], s.env);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /\[warn\] DRIFT: pack mypack@1\.0\.0 does not match its lockfile \(--allow-drift\): task 'file-b' changed/);
    const recs = packsOf(s.state);
    assert.equal(recs.length, 3);
    for (const { pack } of recs) {
      assert.deepEqual(pack?.drift, ["file-b"]);
      assert.equal(pack?.hash, now.hash, "the record carries the content that ran, not the locked hash");
      assert.equal(pack?.locked, true);
    }
  });

  it("two packs with the same name and different versions coexist and both resolve", () => {
    const s = scratch("versions");
    writePack(path.join(s.dir, "v1"), "1.0.0", "Version one prompt.\n");
    writePack(path.join(s.dir, "v2"), "2.0.0", "Version two prompt.\n");
    for (const v of ["v1", "v2"]) assert.equal(runCli(["pack", "add", path.join(s.dir, v), "--packs-dir", s.packs], s.env).code, 0);
    assert.ok(fs.existsSync(path.join(s.packs, "mypack", "1.0.0", "ach-pack.json")));
    assert.ok(fs.existsSync(path.join(s.packs, "mypack", "2.0.0", "ach-pack.json")));
    const list = JSON.parse(runCli(["pack", "list", "--packs-dir", s.packs, "--json"], s.env).stdout);
    assert.deepEqual(list.packs.map((p: { ref: string }) => p.ref), ["mypack@1.0.0", "mypack@2.0.0"]);
    const one = resolvePackRef("mypack@1.0.0", { packsDir: s.packs });
    const two = resolvePackRef("mypack@2.0.0", { packsDir: s.packs });
    assert.equal(one.version, "1.0.0");
    assert.equal(two.version, "2.0.0");
    assert.notEqual(one.hash, two.hash);
    const ledgers = new Set<string>();
    for (const v of ["1.0.0", "2.0.0"]) {
      const r = runCli(["trial", "--pack", `mypack@${v}`, "--packs-dir", s.packs, "--agent", "null", "--json"], s.env);
      assert.equal(r.code, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.summary.ran, 3, `mypack@${v} ran all its cells (no verdicts borrowed from the other version)`);
      ledgers.add(out.ledger);
    }
    assert.equal(ledgers.size, 2, "each version has its own ledger");
    assert.deepEqual([...new Set(packsOf(s.state).map((p) => p.pack?.version))].sort(), ["1.0.0", "2.0.0"]);
    // Publishing different content under an existing version is refused.
    fs.writeFileSync(path.join(s.dir, "v1", "prompts", "b.md"), "Changed after publishing.\n");
    const again = runCli(["pack", "add", path.join(s.dir, "v1"), "--packs-dir", s.packs], s.env);
    assert.equal(again.code, 1);
    assert.match(again.stderr, /already in .* with different content/);
  });

  it("a pack referencing a missing task fails at resolution time, before any agent launches", () => {
    const s = scratch("missing");
    const cases: [string, unknown, RegExp][] = [
      ["prompt-file", { id: "ghost", promptFile: "prompts/ghost.md" }, /task 'ghost': prompt file prompts\/ghost\.md not found/],
      ["task-dir", { dir: "tasks/ghost-dir" }, /task 'tasks\/ghost-dir': task directory tasks\/ghost-dir not found/],
    ];
    for (const [label, entry, re] of cases) {
      const dir = writePack(path.join(s.dir, label));
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, "ach-pack.json"), "utf8"));
      manifest.tasks.push(entry);
      fs.writeFileSync(path.join(dir, "ach-pack.json"), JSON.stringify(manifest));
      // `kiro` is not installed in CI: the missing task must still be the error, so resolution runs first.
      for (const agent of ["null", "kiro"]) {
        const r = runCli(["trial", "--pack", dir, "--agent", agent], { ...s.env, PATH: "/usr/bin:/bin" });
        assert.equal(r.code, 1, `${label}/${agent}`);
        assert.match(r.stderr, re, `${label}/${agent}: ${r.stderr}`);
        assert.doesNotMatch(r.stderr, /no agent to run|running/);
      }
    }
    assert.deepEqual(scanRunRecords(s.state).records, [], "no agent launched");
    assert.ok(!fs.existsSync(path.join(s.state, "packs-runs")), "no ledger written");
  });
});

describe("pack references and flags", () => {
  it("name@version means the registry even when a same-named directory sits in the cwd; ./name@version is the path", () => {
    const s = scratch("cwd");
    writePack(path.join(s.dir, "mypack"), "1.0.0", "Local working copy.\n");
    writePack(path.join(s.dir, "pub"), "1.0.0", "Published copy.\n");
    assert.equal(runCli(["pack", "add", path.join(s.dir, "pub"), "--packs-dir", s.packs], s.env).code, 0);
    const reg = JSON.parse(runCli(["pack", "show", "mypack@1.0.0", "--packs-dir", s.packs, "--json"], s.env, s.dir).stdout);
    assert.equal(reg.resolvedFrom, "registry");
    const local = JSON.parse(runCli(["pack", "show", "./mypack@1.0.0", "--packs-dir", s.packs, "--json"], s.env, s.dir).stdout);
    assert.equal(local.resolvedFrom, "path");
    assert.notEqual(reg.hash, local.hash);
    const wrong = runCli(["pack", "show", "./mypack@9.9.9"], s.env, s.dir);
    assert.equal(wrong.code, 1);
    assert.match(wrong.stderr, /is version 1\.0\.0, not 9\.9\.9/);
  });

  it("a path containing @scope resolves as a path; AGENTIC_CODING_HARNESS_PACKS_DIR picks the registry", () => {
    const s = scratch("scope");
    const scoped = writePack(path.join(s.dir, "node_modules", "@scope", "pack"));
    const shown = runCli(["pack", "show", "./node_modules/@scope/pack", "--json"], s.env, s.dir);
    assert.equal(shown.code, 0, shown.stderr);
    assert.equal(JSON.parse(shown.stdout).resolvedFrom, "path");
    const envReg = path.join(s.dir, "env-registry");
    const env = { ...s.env, AGENTIC_CODING_HARNESS_PACKS_DIR: envReg };
    assert.equal(runCli(["pack", "add", scoped], env).code, 0);
    assert.ok(fs.existsSync(path.join(envReg, "mypack", "1.0.0", "ach-pack.json")), "add wrote into the env registry");
    const viaEnv = runCli(["pack", "show", "mypack@1.0.0", "--json"], env);
    assert.equal(viaEnv.code, 0, viaEnv.stderr);
    assert.equal(JSON.parse(viaEnv.stdout).resolvedFrom, "registry");
    assert.equal(runCli(["pack", "show", "mypack@1.0.0"], s.env).code, 1, "without the env var the default registry is empty");
  });

  it("refuses a bare registry name, an unknown version, a remote URL and a non-semver version", () => {
    const s = scratch("refs");
    writePack(path.join(s.dir, "pub"));
    assert.equal(runCli(["pack", "add", path.join(s.dir, "pub"), "--packs-dir", s.packs], s.env).code, 0);
    const cases: [string, RegExp][] = [
      ["mypack", /needs an explicit version.*mypack@1\.0\.0/],
      ["mypack@3.0.0", /not found in .*versions of mypack: 1\.0\.0/],
      ["https://example.com/pack.json", /remote pack URLs are not supported/],
      ["mypack@latest", /'latest' is not a semver version/],
    ];
    for (const [ref, re] of cases) {
      const r = runCli(["trial", "--pack", ref, "--packs-dir", s.packs, "--agent", "null", "--dry-run"], s.env, s.dir);
      assert.equal(r.code, 1, ref);
      assert.match(r.stderr, re, `${ref}: ${r.stderr}`);
    }
  });

  it("--pack excludes --matrix/--suite and --task; --allow-drift and --packs-dir need --pack", () => {
    const s = scratch("flags");
    const dir = writePack(path.join(s.dir, "p"));
    const cases: [string[], RegExp][] = [
      [["trial", "--pack", dir, "--suite", "core"], /--pack cannot be combined with --matrix or --suite/],
      [["trial", "--pack", dir, "--task", "inline-a"], /--task does not apply to --pack/],
      [["trial", "--suite", "core", "--allow-drift", "--dry-run"], /--allow-drift applies to --pack only/],
      [["trial", "--suite", "core", "--packs-dir", s.packs, "--dry-run"], /--packs-dir applies to --pack only/],
    ];
    for (const [args, re] of cases) {
      const r = runCli(args, s.env);
      assert.equal(r.code, 1, args.join(" "));
      assert.match(r.stderr, re, args.join(" "));
    }
    const help = runCli(["pack", "--help"], s.env);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /ach pack lock/);
  });
});

describe("task-pack hashing", () => {
  it("hashes are stable under key order and change with any task file, verify command or prompt", () => {
    const s = scratch("hash");
    const dir = writePack(path.join(s.dir, "p"));
    const file = path.join(dir, "ach-pack.json");
    const first = loadPack(file, "path");
    // Reorder keys: same hash.
    const m = JSON.parse(fs.readFileSync(file, "utf8"));
    m.tasks[0] = { verify: "true", prompt: "Print the word ok.", id: "inline-a" };
    fs.writeFileSync(file, JSON.stringify({ tasks: m.tasks, version: m.version, name: m.name, description: "changed text" }));
    const reordered = loadPack(file, "path");
    assert.equal(reordered.hash, first.hash, "key order and description do not change the hash");
    // A hidden file inside the task directory is content too.
    fs.mkdirSync(path.join(dir, "tasks", "dir-c", "hidden"));
    fs.writeFileSync(path.join(dir, "tasks", "dir-c", "hidden", "t.sh"), "exit 0\n");
    const withHidden = loadPack(file, "path");
    assert.notEqual(withHidden.tasks[2]!.hash, first.tasks[2]!.hash);
    assert.equal(withHidden.tasks[0]!.hash, first.tasks[0]!.hash, "other tasks keep their hash");
    // A changed verify command on an inline task.
    m.tasks[0] = { id: "inline-a", prompt: "Print the word ok.", verify: "false" };
    fs.writeFileSync(file, JSON.stringify(m));
    assert.notEqual(loadPack(file, "path").tasks[0]!.hash, first.tasks[0]!.hash);
    assert.equal(packHash("x", "1.0.0", [{ id: "a", hash: "h" }]), packHash("x", "1.0.0", [{ id: "a", hash: "h" }]));
    assert.notEqual(packHash("x", "1.0.0", []), packHash("x", "1.0.1", []));
  });

  it("reordering tasks after locking, or a hand-edited lockfile hash, is drift", () => {
    const s = scratch("order");
    const dir = writePack(path.join(s.dir, "p"));
    const file = path.join(dir, "ach-pack.json");
    const lockFile = writeLock(loadPack(file, "path"));
    const m = JSON.parse(fs.readFileSync(file, "utf8"));
    m.tasks = [m.tasks[2], m.tasks[0], m.tasks[1]];
    fs.writeFileSync(file, JSON.stringify(m));
    assert.throws(() => checkPackLock(loadPack(file, "path"), false), (e: Error) => {
      assert.match(e.message, /hash mismatch/);
      assert.match(e.message, /task order changed/);
      return true;
    });
    const r = runCli(["trial", "--pack", dir, "--agent", "null"], s.env);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stderr, /task order changed/);
    // Restore the order; tamper with the lockfile's pack hash instead.
    fs.writeFileSync(file, JSON.stringify({ ...m, tasks: [m.tasks[1], m.tasks[2], m.tasks[0]] }));
    assert.deepEqual(checkPackLock(loadPack(file, "path"), false).warnings, []);
    const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    lock.hash = "sha256:" + "0".repeat(64);
    fs.writeFileSync(lockFile, JSON.stringify(lock));
    assert.throws(() => checkPackLock(loadPack(file, "path"), false), /pack hash does not match the lockfile/);
  });

  it("checkPackLock names added and removed tasks, and an unlocked pack only warns", () => {
    const s = scratch("lockdiff");
    const dir = writePack(path.join(s.dir, "p"));
    const file = path.join(dir, "ach-pack.json");
    const unlocked = checkPackLock(loadPack(file, "path"), false);
    assert.equal(unlocked.locked, false);
    assert.match(unlocked.warnings[0]!, /not locked/);
    writeLock(loadPack(file, "path"));
    const m = JSON.parse(fs.readFileSync(file, "utf8"));
    m.tasks = [m.tasks[0], { id: "new-d", prompt: "A new task." }];
    fs.writeFileSync(file, JSON.stringify(m));
    assert.throws(() => checkPackLock(loadPack(file, "path"), false), (e: Error) => {
      assert.match(e.message, /task 'new-d' is not in the lockfile/);
      assert.match(e.message, /task 'file-b' is in the lockfile but not in the manifest/);
      assert.match(e.message, /task 'dir-c' is in the lockfile but not in the manifest/);
      return true;
    });
  });

  it("compareSemver orders by semver precedence", () => {
    const sorted = ["1.10.0", "1.2.0", "1.2.0-rc.1", "1.2.0-alpha", "0.9.9"].sort(compareSemver);
    assert.deepEqual(sorted, ["0.9.9", "1.2.0-alpha", "1.2.0-rc.1", "1.2.0", "1.10.0"]);
  });

  it("privacy redact shortens the recorded manifest path like other path fields", () => {
    const rec = { pack: { name: "mypack", version: "1.0.0", manifestPath: "/opt/packs/mypack/1.0.0/ach-pack.json" } };
    const out = maskForExport(rec, { mode: "none", options: {}, privacy: { mode: "redact" } }).value as typeof rec;
    assert.equal(out.pack.manifestPath, "ach-pack.json");
    assert.equal(out.pack.name, "mypack");
  });
});

describe("docs (#91)", () => {
  it("docs/TASK-PACKS.md covers authoring, locking and referencing suite@version in reports", () => {
    const doc = fs.readFileSync(path.join(REPO, "docs", "TASK-PACKS.md"), "utf8");
    assert.match(doc, /## Authoring a pack/);
    assert.match(doc, /## Locking/);
    assert.match(doc, /ach pack lock/);
    assert.match(doc, /--allow-drift/);
    assert.match(doc, /## Referencing `name@version` in reports/);
    assert.match(fs.readFileSync(path.join(REPO, "README.md"), "utf8"), /docs\/TASK-PACKS\.md/);
    assert.match(fs.readFileSync(path.join(REPO, "docs", "TRIALS.md"), "utf8"), /ach trial --pack/);
  });
});
