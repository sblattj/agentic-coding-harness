// #99: multi-directory data sources for `ach stats` / `ach watch`.
//
//  - `stats --state-dir <dir>` (repeatable) reads custom state dirs; `--dir` /
//    `--transcript-dir` (repeatable) read several transcript roots.
//  - Duplicates merge: identical copies count once; a conflicting copy warns
//    once naming both files and the newest mtime wins (ties: path order).
//  - `--rewrite <from>=<to>` maps path-bearing output fields and is echoed.
//  - `watch --dir A --dir B` tails both roots, each line tagged with its root.
//  - No --rewrite and one dir: output byte-identical to the pre-#99 snapshot
//    (tests/fixtures/multi-dir/golden, captured at 1f756fd on this fixture).
//
// Fixtures: tests/fixtures/multi-dir/{state-a,state-b,home-a,home-b}, copied
// into a fresh mktemp dir per test so mtimes can be set.
//
// Recapturing the goldens (only when default stats/watch output changes on
// purpose): with AGENTIC_CODING_HARNESS_STATE_DIR = a mktemp copy of state-a,
// HOME = an empty mktemp dir and AGENTIC_CODING_HARNESS_TZ=UTC, run
//   ach stats [--json] --dir <fixture>/home-a --since 2026-01-01 --until 2026-02-01 --by project
//     > golden/stats-base.{txt,json}
//   ach watch --dir <fixture>/home-a --since 2026-01-01 > golden/watch-base.txt
//     (kill it once <state>/offsets.json exists)
// exactly as the `byte-identical` tests below spawn them.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { resolveDirFlags } from "../src/cli/lib.ts";
import { dropCrossDirCopies, parseRewriteRules, rewritePath } from "../src/cli/multi-source.ts";
import { HarnessError } from "../src/core/types.ts";

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;
const FIXTURE = new URL("./fixtures/multi-dir/", import.meta.url).pathname;
const WINDOW = ["--since", "2026-01-01", "--until", "2026-02-01"];

type Run = { code: number; stdout: string; stderr: string };

function runCli(args: string[], env: Record<string, string>): Run {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  const base: Record<string, string | undefined> = { ...process.env };
  delete base.AGENTIC_CODING_HARNESS_COST_MODE;
  delete base.AGENTIC_CODING_HARNESS_CONFIG;
  const p = spawnSync(process.execPath, isBun ? [CLI, ...args] : ["--import", "tsx", CLI, ...args], {
    env: { ...base, AGENTIC_CODING_HARNESS_TZ: "UTC", ...env } as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

const tmps: string[] = [];
after(() => {
  for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });
});

/** A fresh sandbox: copies of the fixture dirs, an empty HOME and an empty default state dir. */
function sandbox(): { a: string; b: string; homeA: string; homeB: string; env: Record<string, string>; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ach-multi-dir-"));
  tmps.push(root);
  // `a` sorts before `b`: the equal-mtime tie-break must pick a.
  const a = path.join(root, "a-state");
  const b = path.join(root, "b-state");
  const homeA = path.join(root, "a-home");
  const homeB = path.join(root, "b-home");
  fs.cpSync(path.join(FIXTURE, "state-a"), a, { recursive: true });
  fs.cpSync(path.join(FIXTURE, "state-b"), b, { recursive: true });
  fs.cpSync(path.join(FIXTURE, "home-a"), homeA, { recursive: true });
  fs.cpSync(path.join(FIXTURE, "home-b"), homeB, { recursive: true });
  const home = path.join(root, "home");
  const def = path.join(root, "default-state");
  fs.mkdirSync(home);
  fs.mkdirSync(def);
  return { a, b, homeA, homeB, root, env: { HOME: home, AGENTIC_CODING_HARNESS_STATE_DIR: def } };
}

function json(r: Run): Record<string, any> {
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout) as Record<string, any>;
}

function setMtime(file: string, epochSec: number): void {
  fs.utimesSync(file, epochSec, epochSec);
}

describe("#99 resolveDirFlags / --rewrite parsing (units)", () => {
  it("resolveDirFlags: lists, same dir once, alias spellings must agree", () => {
    assert.deepEqual(resolveDirFlags({}, "transcript-dir"), []);
    assert.deepEqual(resolveDirFlags({ dir: ["/a", "/b"] }, "transcript-dir"), ["/a", "/b"]);
    assert.deepEqual(resolveDirFlags({ dir: "/a" }, "transcript-dir"), ["/a"]);
    assert.deepEqual(resolveDirFlags({ "transcript-dir": ["/a", "/a/", "/b"] }, "transcript-dir"), ["/a", "/b"]);
    assert.deepEqual(resolveDirFlags({ dir: ["/b", "/a"], "transcript-dir": ["/a", "/b"] }, "transcript-dir"), ["/a", "/b"]);
    assert.throws(
      () => resolveDirFlags({ dir: ["/a"], "transcript-dir": ["/b"] }, "transcript-dir"),
      (e: unknown) => e instanceof HarnessError && e.code === "USAGE" && /--transcript-dir/.test(e.message),
    );
  });

  it("rewritePath: drive targets flip separators, segment boundary, longest prefix wins", () => {
    const rules = parseRewriteRules(["/mnt/c=C:"]);
    assert.equal(rewritePath("/mnt/c/Users/x/proj", rules), "C:\\Users\\x\\proj");
    assert.equal(rewritePath("/mnt/c", rules), "C:\\");
    assert.equal(rewritePath("/mnt/cache/x", rules), "/mnt/cache/x", "not on a segment boundary");
    assert.equal(rewritePath("/home/x/proj", rules), "/home/x/proj");
    assert.equal(rewritePath("/mnt/c/x", parseRewriteRules(["/mnt/c/=C:\\"])), "C:\\x");
    const two = parseRewriteRules(["/mnt=/remote", "/mnt/c=C:"]);
    assert.equal(rewritePath("/mnt/c/x", two), "C:\\x", "longest from wins regardless of order");
    assert.equal(rewritePath("/mnt/d/x", two), "/remote/d/x");
    assert.equal(rewritePath("/srv/data/p", parseRewriteRules(["/srv/data=/Volumes/data/"])), "/Volumes/data/p");
    assert.deepEqual(rewritePath("/x", []), "/x");
    for (const bad of ["nofrom", "=C:", "/mnt/c="]) {
      assert.throws(() => parseRewriteRules([bad]), (e: unknown) => e instanceof HarnessError && e.code === "USAGE" && /--rewrite/.test(e.message));
    }
  });
});

describe("#99 ach stats --state-dir (criterion 1)", () => {
  it("reads a custom state dir; the default state dir is not read", () => {
    const s = sandbox();
    const viaFlag = json(runCli(["stats", "--json", "--state-only", "--state-dir", s.a, ...WINDOW], s.env));
    assert.equal(viaFlag.total.records, 2);
    assert.equal(viaFlag.total.inputTokens, 300);
    assert.equal(viaFlag.runs.length, 2);
    const control = json(runCli(["stats", "--json", "--state-only", ...WINDOW], s.env));
    assert.equal(control.total.records, 0, "control: the empty default state dir must read differently");
  });

  it("--state-only still skips transcripts when --state-dir and --dir are both given", () => {
    const s = sandbox();
    const both = json(runCli(["stats", "--json", "--state-dir", s.a, "--dir", s.homeA, ...WINDOW], s.env));
    assert.equal(both.total.inputTokens, 300 + 3000, "control: without --state-only the transcripts count");
    const stateOnly = json(runCli(["stats", "--json", "--state-only", "--state-dir", s.a, "--dir", s.homeA, ...WINDOW], s.env));
    assert.equal(stateOnly.total.inputTokens, 300);
    assert.equal(stateOnly.sources, undefined, "no transcript source with --state-only");
  });

  it("config stats.stateDir is kept when the command line passes --dir (a transcript root)", () => {
    const s = sandbox();
    const cfg = path.join(s.root, "config.json");
    fs.writeFileSync(cfg, JSON.stringify({ stats: { stateDir: s.a } }));
    const r = json(runCli(["stats", "--json", "--dir", s.homeA, ...WINDOW], { ...s.env, AGENTIC_CODING_HARNESS_CONFIG: cfg }));
    assert.equal(r.total.inputTokens, 300 + 3000, "state from the config file plus the --dir transcripts");
  });
});

describe("#99 several dirs merge, shared runs count once (criterion 2)", () => {
  it("--state-dir A --state-dir B: totals = A + B - the run present in both", () => {
    const s = sandbox();
    const a = json(runCli(["stats", "--json", "--state-only", "--state-dir", s.a, ...WINDOW], s.env)).total;
    const b = json(runCli(["stats", "--json", "--state-only", "--state-dir", s.b, ...WINDOW], s.env)).total;
    const r = runCli(["stats", "--json", "--state-only", "--state-dir", s.a, "--state-dir", s.b, ...WINDOW], s.env);
    const ab = json(r);
    assert.equal(a.inputTokens, 300);
    assert.equal(b.inputTokens, 500);
    assert.equal(ab.total.inputTokens, a.inputTokens + b.inputTokens - 100, "run-shared (100 input) counted once");
    assert.equal(ab.total.outputTokens, 70);
    assert.equal(ab.total.records, 3);
    assert.deepEqual(ab.runs.map((x: { runId: string }) => x.runId).sort(), ["run-a", "run-b", "run-shared"]);
    assert.equal(ab.runOutcomes.total.runs, 3);
    assert.doesNotMatch(r.stderr, /conflicting duplicate/, "identical copies collapse silently");
  });

  it("--dir A --dir B: transcript totals = A + B - the session present in both", () => {
    const s = sandbox();
    const r = runCli(["stats", "--json", "--dir", s.homeA, "--dir", s.homeB, ...WINDOW], s.env);
    const ab = json(r);
    assert.equal(ab.total.inputTokens, 1000 + 2000 + 4000);
    assert.equal(ab.total.records, 3);
    assert.doesNotMatch(r.stderr, /conflicting duplicate/);
    const single = json(runCli(["stats", "--json", "--dir", s.homeA, ...WINDOW], s.env));
    assert.equal(single.total.inputTokens, 3000, "control: one root reads only its own sessions");
  });
});

describe("#99 row copies across dirs (cursor dashboard, --with-warehouse)", () => {
  it("keeps a row max(count per dir) times, for any number of dirs", () => {
    const x = { id: "x" };
    const y = { id: "y" };
    assert.deepEqual(dropCrossDirCopies([[x], [x, x], [x, x]]), [x, x]);
    assert.deepEqual(dropCrossDirCopies([[x, y], [y], [x]]), [x, y]);
    assert.deepEqual(dropCrossDirCopies([[], [y, y], [x, y, y, y]]), [y, y, x, y]);
  });
});

describe("#99 conflicting duplicates (criterion 3)", () => {
  /** B's copy of run-shared differs: an error status and 150 input tokens instead of 100. */
  function conflicted() {
    const s = sandbox();
    const run = path.join(s.b, "runs", "run-shared.json");
    fs.writeFileSync(run, fs.readFileSync(run, "utf8").replace('"status":"success"', '"status":"error"'));
    const raw = path.join(s.b, "raw", "claude", "sess-shared.jsonl");
    fs.writeFileSync(raw, fs.readFileSync(raw, "utf8").replace('"inputTokens":100', '"inputTokens":150'));
    const files = {
      runA: path.join(s.a, "runs", "run-shared.json"),
      runB: run,
      rawA: path.join(s.a, "raw", "claude", "sess-shared.jsonl"),
      rawB: raw,
    };
    return { ...s, files };
  }
  const stats = (s: ReturnType<typeof conflicted>, order: "ab" | "ba") =>
    runCli(["stats", "--json", "--state-only", ...(order === "ab" ? ["--state-dir", s.a, "--state-dir", s.b] : ["--state-dir", s.b, "--state-dir", s.a]), ...WINDOW], s.env);
  const warnings = (stderr: string, id: string) => stderr.split("\n").filter((l) => l.includes(`conflicting duplicate ${id}`));

  it("newest mtime wins in both flag orders; one warning names both paths", () => {
    const s = conflicted();
    for (const f of [s.files.runA, s.files.rawA]) setMtime(f, 1_800_000_000);
    for (const f of [s.files.runB, s.files.rawB]) setMtime(f, 1_800_000_100);
    for (const order of ["ab", "ba"] as const) {
      const r = stats(s, order);
      const out = json(r);
      assert.equal(out.total.inputTokens, 150 + 200 + 400, `${order}: B's newer usage file wins`);
      assert.equal(out.runOutcomes.total.runs, 3);
      assert.equal(out.runOutcomes.total.success, 2, `${order}: B's newer run record (status error) wins`);
      const runWarn = warnings(r.stderr, "run run-shared");
      assert.equal(runWarn.length, 1, r.stderr);
      assert.ok(runWarn[0]!.includes(s.files.runA) && runWarn[0]!.includes(s.files.runB), runWarn[0]);
      assert.ok(runWarn[0]!.includes(`keeping ${s.files.runB} and its usage file`), runWarn[0]);
      assert.equal(r.stderr.split("\n").filter((l) => l.includes("conflicting duplicate")).length, 1, `${order}: ONE warning for the run: ${r.stderr}`);
    }
  });

  it("a conflicting run's usage file follows the winning record even when the usage file mtimes disagree", () => {
    const s = conflicted();
    setMtime(s.files.runA, 1_800_000_000);
    setMtime(s.files.runB, 1_800_000_100); // B's record is newer...
    setMtime(s.files.rawA, 1_800_000_100);
    setMtime(s.files.rawB, 1_800_000_000); // ...but A's usage file is newer
    for (const order of ["ab", "ba"] as const) {
      const r = stats(s, order);
      const out = json(r);
      assert.equal(out.runOutcomes.total.success, 2, `${order}: B's record wins`);
      assert.equal(out.total.inputTokens, 150 + 200 + 400, `${order}: B's tokens go with B's record`);
      assert.equal(r.stderr.split("\n").filter((l) => l.includes("conflicting duplicate")).length, 1, r.stderr);
    }
  });

  it("identical run records with conflicting usage files: the usage file warns on its own", () => {
    const s = conflicted();
    fs.copyFileSync(s.files.runA, s.files.runB);
    setMtime(s.files.rawA, 1_800_000_000);
    setMtime(s.files.rawB, 1_800_000_100);
    const r = stats(s, "ba");
    assert.equal(json(r).total.inputTokens, 150 + 200 + 400);
    const w = warnings(r.stderr, "usage file raw/claude/sess-shared.jsonl");
    assert.equal(w.length, 1, r.stderr);
    assert.ok(w[0]!.includes(s.files.rawA) && w[0]!.includes(s.files.rawB), w[0]);
    assert.equal(warnings(r.stderr, "run run-shared").length, 0);
  });

  it("an older conflicting copy loses; equal mtimes break the tie on path order", () => {
    const s = conflicted();
    for (const f of [s.files.runB, s.files.rawB]) setMtime(f, 1_800_000_000);
    for (const f of [s.files.runA, s.files.rawA]) setMtime(f, 1_800_000_100);
    for (const order of ["ab", "ba"] as const) {
      const out = json(stats(s, order));
      assert.equal(out.total.inputTokens, 100 + 200 + 400, `${order}: A is newer now`);
      assert.equal(out.runOutcomes.total.success, 3, `${order}: A's run record (status success) wins`);
    }
    for (const f of Object.values(s.files)) setMtime(f, 1_800_000_000);
    assert.ok(s.files.rawA < s.files.rawB, "fixture: A's path sorts first");
    for (const order of ["ab", "ba"] as const) {
      const r = stats(s, order);
      assert.equal(json(r).total.inputTokens, 100 + 200 + 400, `${order}: tie goes to the smaller path (A)`);
      assert.equal(warnings(r.stderr, "run run-shared").length, 1);
    }
  });

  it("a session in two transcript roots with different content: newest file wins, one warning", () => {
    const s = sandbox();
    const fa = path.join(s.homeA, ".claude", "projects", "proj", "tsess-shared.jsonl");
    const fb = path.join(s.homeB, ".claude", "projects", "proj", "tsess-shared.jsonl");
    fs.writeFileSync(fb, fs.readFileSync(fb, "utf8").replace('"input_tokens":1000', '"input_tokens":1500'));
    setMtime(fa, 1_800_000_000);
    setMtime(fb, 1_800_000_100);
    for (const roots of [[s.homeA, s.homeB], [s.homeB, s.homeA]]) {
      const r = runCli(["stats", "--json", ...roots.flatMap((d) => ["--dir", d]), ...WINDOW], s.env);
      assert.equal(json(r).total.inputTokens, 1500 + 2000 + 4000);
      const w = warnings(r.stderr, "session claude/tsess-shared");
      assert.equal(w.length, 1, r.stderr);
      assert.ok(w[0]!.includes(fa) && w[0]!.includes(fb), w[0]);
    }
  });
});

describe("#99 --rewrite (criterion 4)", () => {
  it("/mnt/c=C: maps the byProject key and is echoed in --json and once in text", () => {
    const s = sandbox();
    const args = ["stats", "--state-only", "--state-dir", s.a, "--by", "project", "--rewrite", "/mnt/c=C:", ...WINDOW];
    const out = json(runCli([...args, "--json"], s.env));
    assert.deepEqual(Object.keys(out.byProject), ["C:\\Users\\x\\proj"]);
    assert.equal(out.byProject["C:\\Users\\x\\proj"].inputTokens, 300);
    assert.deepEqual(out.rewrites, [{ from: "/mnt/c", to: "C:" }]);
    const text = runCli(args, s.env);
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /^C:\\Users\\x\\proj records=2 /m);
    assert.doesNotMatch(text.stdout, /\/mnt\/c\/Users/);
    assert.equal(text.stdout.split("\n").filter((l) => l.startsWith("rewrite ")).length, 1);
    assert.match(text.stdout, /^rewrite\s+\/mnt\/c=C: \(applied to: byProject keys\)$/m);
  });

  it("--project accepts the rewritten spelling; unmatched paths stay as stored", () => {
    const s = sandbox();
    const out = json(runCli(["stats", "--json", "--state-dir", s.a, "--state-dir", s.b, "--state-only", "--by", "project", "--rewrite", "/mnt/c=C:", "--project", "C:\\Users\\x\\proj", ...WINDOW], s.env));
    assert.equal(out.total.inputTokens, 300, "only the /mnt/c project's records");
    const all = json(runCli(["stats", "--json", "--state-dir", s.a, "--state-dir", s.b, "--state-only", "--by", "project", "--rewrite", "/mnt/c=C:", ...WINDOW], s.env));
    assert.deepEqual(Object.keys(all.byProject).sort(), ["/mnt/d/work/other", "C:\\Users\\x\\proj"]);
  });
});

/** Run `ach watch` until its first tick has saved offsets, then kill it. */
async function watchOnce(args: string[], env: Record<string, string>): Promise<{ stdout: string; stderr: string; ticked: boolean }> {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  const argv = ["watch", ...args];
  const child = spawn(process.execPath, isBun ? [CLI, ...argv] : ["--import", "tsx", CLI, ...argv], {
    env: { ...process.env, AGENTIC_CODING_HARNESS_TZ: "UTC", ...env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += String(d)));
  child.stderr.on("data", (d) => (stderr += String(d)));
  const offsets = path.join(env.AGENTIC_CODING_HARNESS_STATE_DIR!, "offsets.json");
  let ticked = false;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && child.exitCode === null) {
    if (fs.existsSync(offsets)) {
      ticked = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  // The tick writes stdout before offsets: give the pipe a moment to drain.
  await new Promise((r) => setTimeout(r, 300));
  const exited = new Promise((r) => child.once("close", r));
  child.kill("SIGKILL");
  await exited;
  return { stdout, stderr, ticked };
}

describe("#99 ach watch --dir A --dir B (criterion 5)", () => {
  it("one stream with events from both roots, each tagged with its root", async () => {
    const s = sandbox();
    const r = await watchOnce(["--dir", s.homeA, "--dir", s.homeB, "--since", "2026-01-01"], s.env);
    assert.equal(r.ticked, true, r.stderr);
    const lines = r.stdout.split("\n").filter(Boolean);
    const tagged = (sid: string, root: string) => lines.filter((l) => l.includes(` ${sid} `) && l.endsWith(`source: transcript dir: ${root}`));
    assert.equal(tagged("tsess-a", s.homeA).length, 1, r.stdout);
    assert.equal(tagged("tsess-b", s.homeB).length, 1, r.stdout);
    assert.equal(tagged("tsess-shared", s.homeA).length, 1, r.stdout);
    assert.equal(tagged("tsess-shared", s.homeB).length, 1, r.stdout);
    assert.equal(lines.length, 4, r.stdout);
  });

  it("--rewrite maps the root tag and is echoed once", async () => {
    const s = sandbox();
    const r = await watchOnce(["--dir", s.homeA, "--dir", s.homeB, "--since", "2026-01-01", "--rewrite", `${s.homeA}=/remote/a`], s.env);
    assert.equal(r.ticked, true, r.stderr);
    assert.match(r.stdout, /tsess-a .* dir: \/remote\/a$/m);
    assert.ok(r.stdout.includes(`dir: ${s.homeB}`), r.stdout);
    assert.equal(r.stdout.split("\n").filter((l) => l.startsWith("rewrite ")).length, 1, r.stdout);
  });
});

describe("#99 zero --rewrite flags = zero mutation (criterion 6)", () => {
  /** The pre-#99 snapshot setup: state-a as the default state dir, --dir home-a. */
  function golden() {
    const s = sandbox();
    return { ...s, env: { ...s.env, AGENTIC_CODING_HARNESS_STATE_DIR: s.a } };
  }
  // Volatile fields only: the pace clock and the pricing snapshot's age.
  const normalize = (t: string) =>
    t.replace(/"asOf": "[^"]*"/g, '"asOf": "<now>"').replace(/"pricing": \{[^}]*\}/, '"pricing": <pricing>');

  it("stats text output is byte-identical to the pre-#99 snapshot", () => {
    const s = golden();
    const r = runCli(["stats", "--dir", s.homeA, ...WINDOW, "--by", "project"], s.env);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, fs.readFileSync(path.join(FIXTURE, "golden", "stats-base.txt"), "utf8"));
    assert.match(r.stdout, /^\/mnt\/c\/Users\/x\/proj records=4 /m, "the stored path is shown as stored");
  });

  it("stats --json is byte-identical to the snapshot (volatile clock/pricing fields aside) and has no rewrites key", () => {
    const s = golden();
    const r = runCli(["stats", "--json", "--dir", s.homeA, ...WINDOW, "--by", "project"], s.env);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(normalize(r.stdout), normalize(fs.readFileSync(path.join(FIXTURE, "golden", "stats-base.json"), "utf8")));
    assert.equal(JSON.parse(r.stdout).rewrites, undefined);
    // A rule that matches nothing changes no field: only the echo is added.
    const noop = json(runCli(["stats", "--json", "--dir", s.homeA, ...WINDOW, "--by", "project", "--rewrite", "/nowhere=Z:"], s.env));
    assert.deepEqual(noop.rewrites, [{ from: "/nowhere", to: "Z:" }]);
    delete noop.rewrites;
    assert.equal(normalize(JSON.stringify(noop, null, 2) + "\n"), normalize(r.stdout));
  });

  it("single-root watch output is byte-identical to the snapshot (no root tag)", async () => {
    const s = sandbox();
    const r = await watchOnce(["--dir", s.homeA, "--since", "2026-01-01"], s.env);
    assert.equal(r.ticked, true, r.stderr);
    assert.equal(r.stdout, fs.readFileSync(path.join(FIXTURE, "golden", "watch-base.txt"), "utf8"));
  });
});
