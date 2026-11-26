// ach export (#96): a complete, self-describing dump of harness data.
//
// Every fixture lives in temp dirs: a fake HOME (machine transcript dirs) and a
// fake state dir. Nothing touches the real ~/.claude or ~/.agentic-coding-harness.
// Secret-shaped fixtures are assembled at runtime so no literal token sits in the repo.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { csvField, exportData, statsBuckets, statsCsv, STATS_CSV_COLUMNS } from "../src/cli/export.ts";
import { VERSION } from "../src/version.ts";
import { scanOptionsForRoot } from "../src/monitors/transcripts.ts";

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;

function runCli(args: string[], env: Record<string, string>): { code: number; stdout: string; stderr: string } {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  const base = { ...process.env };
  delete base.AGENTIC_CODING_HARNESS_MASK; // the default must be raw: no inherited mask mode
  delete base.AGENTIC_CODING_HARNESS_CONFIG;
  const p = spawnSync(process.execPath, isBun ? [CLI, ...args] : ["--import", "tsx", CLI, ...args], {
    env: { ...base, ...env },
    encoding: "utf8",
  });
  return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function write(file: string, text: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

/** Every regular file under `dir`, as `/`-separated paths relative to it. */
function walk(dir: string, base = dir): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full, base) : [path.relative(base, full).split(path.sep).join("/")];
  }).sort();
}

const NOW = Date.now();
const DAY = 86_400_000;
const ODD_MODEL = 'odd,model "x"\nline2';

interface Fixture {
  home: string;
  state: string;
  env: Record<string, string>;
}

/** Two driver runs (record + event log), a watch usage file with a CSV-hostile model name, and an archive batch. */
function fixture(): Fixture {
  const home = tmp("ach-export-home-");
  const state = tmp("ach-export-state-");
  for (const [i, agent, model] of [[1, "claude", "claude-sonnet-4-5"], [2, "codex", "gpt-5"]] as const) {
    const raw = write(
      path.join(state, "raw", `${agent}-sess-${i}.jsonl`),
      JSON.stringify({ type: "message", text: "hello", timestamp: NOW - i * DAY }) + "\n" +
        JSON.stringify({ type: "usage", usage: { agent, model, inputTokens: 100 * i, outputTokens: 10 * i, cacheReadTokens: 5, cacheWriteTokens: 1, costUsd: 0.01 * i }, timestamp: NOW - i * DAY, ach_chain: { run: `run-${i}` } }) + "\n",
    );
    // Hand-formatted (not JSON.stringify(rec, null, 2)) so a re-serializing export would not be byte-identical.
    write(
      path.join(state, "runs", `run-${i}.json`),
      `{"runId":"run-${i}", "agent":"${agent}","sessionId":"sess-${i}","startedAt":${NOW - i * DAY},` +
        `"status":"success","exitStatus":"success","rawTranscript":${JSON.stringify(raw)},"extraUnknownField":true}\n`,
    );
  }
  write(
    path.join(state, "raw", "claude", "watch-sess.jsonl"),
    JSON.stringify({ ts: new Date(NOW - DAY).toISOString(), agent: "claude", sessionId: "watch-sess", model: ODD_MODEL, inputTokens: 7, outputTokens: 3 }) + "\n",
  );
  write(path.join(state, "warehouse", "2026-01-01T00-00-00.000Z", "manifest.jsonl"), "{}\n");
  write(path.join(state, "warehouse", "2026-01-01T00-00-00.000Z", "native", "claude", "p", "s.jsonl"), '{"type":"x"}\n');
  return { home, state, env: { AGENTIC_CODING_HARNESS_STATE_DIR: state, HOME: home } };
}

interface Manifest {
  format: string;
  achVersion: string;
  exportedAt: string;
  counts: Record<string, number>;
  files: Array<{ path: string; sha256: string; bytes: number; kind: string }>;
  machineDirs: Array<{ agent: string; dir: string; exists: boolean; files: number; copied: boolean }>;
  unreadableRunRecords: Array<{ file: string; reason: string }>;
}
const readManifest = (out: string) => JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8")) as Manifest;

/** The manifest lists exactly the dump's files (itself excluded), each with a matching sha256. */
function assertManifestVerifies(out: string): Manifest {
  const m = readManifest(out);
  const listed = m.files.map((f) => f.path).sort();
  assert.deepEqual(listed, walk(out).filter((p) => p !== "manifest.json"), "manifest file list = files on disk");
  for (const f of m.files) {
    assert.equal(sha256(path.join(out, f.path)), f.sha256, `sha256 of ${f.path}`);
    assert.equal(fs.statSync(path.join(out, f.path)).size, f.bytes, `bytes of ${f.path}`);
  }
  return m;
}

/** RFC 4180 parser (quoted fields, doubled quotes, embedded CR/LF). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') {
      assert.equal(field, "", "a quote only opens a field");
      q = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r" && text[i + 1] === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
    } else if (c === "\n") {
      assert.fail("bare LF outside a quoted field");
    } else field += c;
  }
  assert.equal(q, false, "no unterminated quote");
  assert.equal(field, "", "file ends with CRLF");
  assert.equal(row.length, 0);
  return rows;
}

describe("ach export (CLI)", () => {
  it("dumps runs/, events/, transcripts/, stats.csv, stats.json, manifest.json; RunRecords byte-identical", () => {
    const f = fixture();
    const out = path.join(tmp("ach-export-out-"), "dump");
    const r = runCli(["export", "--out", out], f.env);
    assert.equal(r.code, 0, r.stderr);
    for (const p of ["runs", "events", "transcripts", "stats.csv", "stats.json", "manifest.json"]) {
      assert.ok(fs.existsSync(path.join(out, p)), `${p} exists`);
    }
    for (const name of ["run-1.json", "run-2.json"]) {
      assert.ok(fs.readFileSync(path.join(out, "runs", name)).equals(fs.readFileSync(path.join(f.state, "runs", name))), `${name} byte-identical`);
    }
    for (const rel of walk(path.join(f.state, "raw"))) {
      assert.ok(fs.readFileSync(path.join(out, "events", rel)).equals(fs.readFileSync(path.join(f.state, "raw", rel))), `events/${rel} byte-identical`);
    }
    assert.deepEqual(walk(path.join(out, "transcripts", "warehouse")), walk(path.join(f.state, "warehouse")));
  });

  it("manifest lists every file with a matching sha256, record counts and the ach version", () => {
    const f = fixture();
    const out = path.join(tmp("ach-export-out-"), "dump");
    assert.equal(runCli(["export", "--out", out], f.env).code, 0);
    const m = assertManifestVerifies(out);
    assert.equal(m.format, "ach-export");
    assert.equal(m.achVersion, VERSION);
    assert.ok(!Number.isNaN(Date.parse(m.exportedAt)));
    assert.equal(m.counts.runRecords, 2);
    assert.equal(m.counts.eventFiles, 3);
    assert.equal(m.counts.eventLines, 5);
    assert.equal(m.counts.transcriptFiles, 2);
    assert.equal(m.counts.statsRecords, 3);
    assert.equal(m.counts.files, m.files.length);
  });

  it("re-running into the same dir rewrites nothing unchanged and the manifest still verifies", () => {
    const f = fixture();
    const out = path.join(tmp("ach-export-out-"), "dump");
    assert.equal(runCli(["export", "--out", out], f.env).code, 0);
    const before = new Map(walk(out).map((p) => [p, fs.statSync(path.join(out, p))]));
    const r = runCli(["export", "--out", out, "--json"], f.env);
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout) as { written: number; skipped: number; removed: number };
    // stats.json carries `pace.asOf` (the clock), so it is the one file a re-run rewrites.
    assert.deepEqual({ written: j.written, skipped: j.skipped, removed: j.removed }, { written: 1, skipped: before.size - 2, removed: 0 });
    assert.deepEqual(walk(out), [...before.keys()], "no duplicated files");
    for (const [p, st] of before) {
      if (p === "stats.json" || p === "manifest.json") continue;
      const now = fs.statSync(path.join(out, p));
      assert.equal(now.ino, st.ino, `${p} inode unchanged`);
      assert.equal(now.mtimeMs, st.mtimeMs, `${p} mtime unchanged`);
    }
    assertManifestVerifies(out);
  });

  it("a re-run drops files an earlier export wrote that are gone now, and keeps unknown files", () => {
    const f = fixture();
    const out = path.join(tmp("ach-export-out-"), "dump");
    assert.equal(runCli(["export", "--out", out], f.env).code, 0);
    write(path.join(out, "my-notes.txt"), "mine\n");
    write(path.join(out, "events", "claude-sess-1.jsonl.tmp-4242"), "half");
    fs.rmSync(path.join(f.state, "runs", "run-2.json"));
    const r = runCli(["export", "--out", out, "--no-transcripts", "--json"], f.env);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).removed, 3); // run-2.json + two warehouse files
    assert.ok(!fs.existsSync(path.join(out, "runs", "run-2.json")));
    assert.ok(!fs.existsSync(path.join(out, "transcripts")), "transcripts/ gone after a --no-transcripts re-run");
    assert.ok(!fs.existsSync(path.join(out, "events", "claude-sess-1.jsonl.tmp-4242")), "stale temp file swept");
    assert.equal(fs.readFileSync(path.join(out, "my-notes.txt"), "utf8"), "mine\n", "an unknown file is never deleted");
    const m = readManifest(out);
    assert.deepEqual(m.files.map((x) => x.path).sort(), walk(out).filter((p) => p !== "manifest.json" && p !== "my-notes.txt"));
    assert.equal(m.counts.runRecords, 1);
  });

  it("--no-transcripts omits transcripts/; machine dirs are reported, copied only with --include-machine-dirs", () => {
    const f = fixture();
    const claudeFile = write(path.join(f.home, ".claude", "projects", "-proj", "sess-m.jsonl"), '{"type":"user"}\n');
    const outA = path.join(tmp("ach-export-out-"), "a");
    assert.equal(runCli(["export", "--out", outA], f.env).code, 0);
    assert.ok(fs.existsSync(path.join(outA, "transcripts")), "transcripts/ present by default");
    const outB = path.join(tmp("ach-export-out-"), "b");
    assert.equal(runCli(["export", "--out", outB, "--no-transcripts"], f.env).code, 0);
    assert.ok(!fs.existsSync(path.join(outB, "transcripts")), "transcripts/ omitted");
    const mB = assertManifestVerifies(outB);
    assert.equal(mB.counts.transcriptFiles, 0);
    const claude = mB.machineDirs.find((d) => d.agent === "claude");
    assert.deepEqual(claude && { exists: claude.exists, files: claude.files, copied: claude.copied }, { exists: true, files: 1, copied: false });
    assert.ok(!walk(outA).some((p) => p.startsWith("transcripts/machine/")), "not copied without the flag");
    const outC = path.join(tmp("ach-export-out-"), "c");
    assert.equal(runCli(["export", "--out", outC, "--include-machine-dirs"], f.env).code, 0);
    const copied = path.join(outC, "transcripts", "machine", "claude", "-proj", "sess-m.jsonl");
    assert.ok(fs.readFileSync(copied).equals(fs.readFileSync(claudeFile)));
    assert.equal(assertManifestVerifies(outC).counts.machineTranscriptFiles, 1);
    const bad = runCli(["export", "--out", outC, "--no-transcripts", "--include-machine-dirs"], f.env);
    assert.equal(bad.code, 1, bad.stderr);
    assert.match(bad.stderr, /cannot be combined with --no-transcripts/);
  });

  it("stats.json equals `ach stats --json`; stats.csv is valid CSV with one row per bucket", () => {
    const f = fixture();
    const out = path.join(tmp("ach-export-out-"), "dump");
    assert.equal(runCli(["export", "--out", out], f.env).code, 0);
    const direct = runCli(["stats", "--json"], f.env);
    assert.equal(direct.code, 0, direct.stderr);
    const exported = fs.readFileSync(path.join(out, "stats.json"), "utf8");
    // pace.asOf is the clock at print time; every other byte must agree.
    const unclock = (s: string) => s.replace(/"asOf": "[^"]+"/, '"asOf": "<t>"');
    assert.equal(unclock(exported), unclock(direct.stdout));
    const stats = JSON.parse(exported) as Record<string, unknown>;

    const rows = parseCsv(fs.readFileSync(path.join(out, "stats.csv"), "utf8"));
    assert.deepEqual(rows[0], [...STATS_CSV_COLUMNS]);
    const body = rows.slice(1);
    for (const r of body) assert.equal(r.length, STATS_CSV_COLUMNS.length, `row width: ${JSON.stringify(r)}`);
    // Every bucket the stats JSON holds, enumerated by hand for this fixture.
    const expected: Array<[string, string, Record<string, unknown>]> = [["total", "", stats.total as Record<string, unknown>]];
    for (const section of ["byAgent", "byDay", "byModel"]) {
      for (const [k, b] of Object.entries(stats[section] as Record<string, Record<string, unknown>>)) expected.push([section, k, b]);
    }
    assert.equal(body.length, expected.length, "one row per bucket, no extras");
    for (const [section, key, b] of expected) {
      const row = body.find((r) => r[0] === section && r[1] === key);
      assert.ok(row, `row for ${section}/${key}`);
      for (const [i, col] of STATS_CSV_COLUMNS.entries()) {
        if (i < 3) continue;
        const v = b[col];
        assert.equal(row[i], v === null || v === undefined ? "" : String(v), `${section}/${key}.${col}`);
      }
    }
    assert.ok(body.some((r) => r[0] === "byModel" && r[1] === `claude/${ODD_MODEL}`), "comma, quote and newline round-trip");
    assert.equal(readManifest(out).counts.statsCsvRows, expected.length);
  });

  it("an empty state dir exports a manifest with zero records", () => {
    const state = tmp("ach-export-empty-");
    const env = { AGENTIC_CODING_HARNESS_STATE_DIR: state, HOME: tmp("ach-export-home-") };
    const out = path.join(tmp("ach-export-out-"), "dump");
    const r = runCli(["export", "--out", out], env);
    assert.equal(r.code, 0, r.stderr);
    const m = assertManifestVerifies(out);
    assert.equal(m.counts.runRecords, 0);
    assert.equal(m.counts.eventFiles, 0);
    assert.equal(m.counts.statsRecords, 0);
    assert.deepEqual(walk(path.join(out, "runs")), []);
    assert.ok(fs.statSync(path.join(out, "events")).isDirectory());
    assert.deepEqual(m.files.map((x) => x.path).sort(), ["stats.csv", "stats.json"]);
  });

  it("copies an unreadable run record as-is and counts it apart; skips in-flight registry temp files", () => {
    const f = fixture();
    write(path.join(f.state, "runs", "broken.json"), "{not json");
    write(path.join(f.state, "runs", "run-3.json.tmp-999"), "{}");
    const out = path.join(tmp("ach-export-out-"), "dump");
    assert.equal(runCli(["export", "--out", out], f.env).code, 0);
    assert.equal(fs.readFileSync(path.join(out, "runs", "broken.json"), "utf8"), "{not json");
    assert.ok(!fs.existsSync(path.join(out, "runs", "run-3.json.tmp-999")));
    const m = readManifest(out);
    assert.equal(m.counts.runRecords, 2);
    assert.equal(m.counts.unreadableRunRecords, 1);
    assert.equal(m.unreadableRunRecords[0]?.file, "broken.json");
  });

  it("refuses --out inside the state dir, and a missing --out", () => {
    const f = fixture();
    const r = runCli(["export", "--out", path.join(f.state, "dump")], f.env);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /outside the state dir/);
    const none = runCli(["export"], f.env);
    assert.equal(none.code, 1);
    assert.match(none.stderr, /export requires --out/);
  });

  it("--mask all masks secrets in the dump; the default stays raw", () => {
    const f = fixture();
    const secret = ["sk-", "ant-", "api03-", "A1b2C3d4E5f6G7h8J9k0".repeat(2)].join("");
    write(path.join(f.state, "raw", "claude-sess-1.jsonl"), JSON.stringify({ type: "message", text: `key ${secret}` }) + "\n");
    const raw = path.join(tmp("ach-export-out-"), "raw");
    assert.equal(runCli(["export", "--out", raw], f.env).code, 0);
    assert.ok(fs.readFileSync(path.join(raw, "events", "claude-sess-1.jsonl"), "utf8").includes(secret), "default export is raw");
    const masked = path.join(tmp("ach-export-out-"), "masked");
    const r = runCli(["export", "--out", masked, "--mask", "all"], f.env);
    assert.equal(r.code, 0, r.stderr);
    const text = fs.readFileSync(path.join(masked, "events", "claude-sess-1.jsonl"), "utf8");
    assert.ok(!text.includes(secret), "secret masked");
    assert.match(text, /REDACTED/);
    const m = assertManifestVerifies(masked);
    assert.equal((m as unknown as { options: { mask: string } }).options.mask, "all");
    const preview = path.join(tmp("ach-export-out-"), "preview");
    const p = runCli(["export", "--out", preview, "--mask", "preview"], f.env);
    assert.equal(p.code, 0, p.stderr);
    assert.ok(!fs.existsSync(preview), "preview writes nothing");
    assert.match(p.stdout, /claude-sess-1\.jsonl/);
  });

  it("is listed in the top-level usage and answers --help", () => {
    const f = fixture();
    const h = runCli(["export", "--help"], f.env);
    assert.equal(h.code, 0);
    assert.match(h.stdout, /ach export --out <dir>/);
    const top = runCli(["--help"], f.env);
    assert.equal(top.code, 0);
    assert.match(top.stdout, /^  ach export --out <dir>/m);
  });

  it("stats.json gets the config file's stats.* defaults, exactly as `ach stats --json` does", () => {
    const f = fixture();
    const cfg = write(path.join(tmp("ach-export-cfg-"), "config.json"), JSON.stringify({ stats: { by: ["model"] } }));
    const out = path.join(tmp("ach-export-out-"), "dump");
    assert.equal(runCli(["--config", cfg, "export", "--out", out], f.env).code, 0);
    const direct = runCli(["--config", cfg, "stats", "--json"], f.env);
    assert.equal(direct.code, 0, direct.stderr);
    const unclock = (s: string) => s.replace(/"asOf": "[^"]+"/, '"asOf": "<t>"');
    const exported = fs.readFileSync(path.join(out, "stats.json"), "utf8");
    assert.equal(unclock(exported), unclock(direct.stdout));
    assert.ok("byModelDay" in JSON.parse(exported), "the config default reached the nested stats call");
    assert.ok(!("byModelDay" in JSON.parse(runCli(["stats", "--json"], f.env).stdout)), "control: absent without the config");
    assert.ok(parseCsv(fs.readFileSync(path.join(out, "stats.csv"), "utf8")).some((r) => r[0] === "byModelDay" && r[2] !== ""));
  });

  it("an event log a run record keeps outside the state dir is reported, and copied only with --include-machine-dirs", () => {
    const f = fixture();
    const old = write(path.join(tmp("ach-export-oldstate-"), "raw", "claude-sess-9.jsonl"), '{"type":"message","text":"old"}\n');
    write(
      path.join(f.state, "runs", "run-9.json"),
      JSON.stringify({ runId: "run-9", agent: "claude", sessionId: "sess-9", startedAt: NOW - DAY, status: "success", rawTranscript: old }),
    );
    type Ext = { runId: string; path: string; copied: boolean };
    const outA = path.join(tmp("ach-export-out-"), "a");
    assert.equal(runCli(["export", "--out", outA], f.env).code, 0);
    const a = assertManifestVerifies(outA) as unknown as { externalEventFiles: Ext[] };
    assert.deepEqual(a.externalEventFiles, [{ runId: "run-9", path: old, copied: false }]);
    assert.ok(!fs.existsSync(path.join(outA, "events", "external")));
    const outB = path.join(tmp("ach-export-out-"), "b");
    assert.equal(runCli(["export", "--out", outB, "--include-machine-dirs"], f.env).code, 0);
    const b = assertManifestVerifies(outB) as unknown as { externalEventFiles: Ext[] };
    assert.deepEqual(b.externalEventFiles, [{ runId: "run-9", path: old, copied: true }]);
    assert.ok(fs.readFileSync(path.join(outB, "events", "external", "claude-sess-9.jsonl")).equals(fs.readFileSync(old)));
  });
});

describe("exportData (in-process)", () => {
  it("a write killed before its rename leaves no partial file under the final name", async () => {
    const f = fixture();
    const out = path.join(tmp("ach-export-out-"), "dump");
    const realRename = fs.renameSync;
    let calls = 0;
    fs.renameSync = ((a: fs.PathLike, b: fs.PathLike) => {
      if (++calls === 2) throw new Error("killed");
      return realRename(a, b);
    }) as typeof fs.renameSync;
    try {
      await assert.rejects(
        exportData({ stateDir: f.state, out, transcripts: true, includeMachineDirs: false, version: VERSION, statsJson: async () => "{}", scan: scanOptionsForRoot(f.home) }),
        /killed/,
      );
    } finally {
      fs.renameSync = realRename;
    }
    const files = walk(out);
    // The first file landed whole; the second exists only as its temp name; no manifest yet.
    assert.ok(files.includes("runs/run-1.json"));
    assert.ok(!files.includes("runs/run-2.json"), "no half-written file under its final name");
    assert.ok(files.some((p) => /^runs\/run-2\.json\.tmp-\d+$/.test(p)));
    assert.ok(!files.includes("manifest.json"));
    // The next export completes, sweeps the temp file and verifies.
    await exportData({ stateDir: f.state, out, transcripts: true, includeMachineDirs: false, version: VERSION, statsJson: async () => "{}", scan: scanOptionsForRoot(f.home) });
    assert.ok(!walk(out).some((p) => /\.tmp-\d+$/.test(p)));
    const m = assertManifestVerifies(out);
    assert.ok(m.machineDirs.length > 0);
    for (const d of m.machineDirs) assert.ok(d.dir.startsWith(f.home + path.sep), `machine dir re-rooted: ${d.dir}`);
  });

  it("a source file that cannot be read fails the export and leaves the earlier dump intact", async () => {
    if (process.getuid?.() === 0) return; // root reads mode-000 files
    const f = fixture();
    const out = path.join(tmp("ach-export-out-"), "dump");
    const opts = { stateDir: f.state, out, transcripts: true, includeMachineDirs: false, version: VERSION, statsJson: async () => "{}", scan: scanOptionsForRoot(f.home) };
    await exportData(opts);
    const before = fs.readFileSync(path.join(out, "manifest.json"), "utf8");
    const src = path.join(f.state, "runs", "run-2.json");
    fs.chmodSync(src, 0o000);
    try {
      await assert.rejects(exportData(opts), /cannot read .*run-2\.json/);
    } finally {
      fs.chmodSync(src, 0o644);
    }
    assert.equal(fs.readFileSync(path.join(out, "manifest.json"), "utf8"), before, "manifest untouched");
    assert.ok(fs.existsSync(path.join(out, "runs", "run-2.json")), "earlier copy not pruned");
  });

  it("statsBuckets reads byModelDay two levels deep and skips compare", () => {
    const b = { records: 1, inputTokens: 2, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: null };
    const got = statsBuckets({ total: b, byModelDay: { m: { "2026-01-01": b } }, compare: { current: b }, cacheHitRatio: { total: 0.5 } });
    assert.deepEqual(got.map(([s, k, sub]) => [s, k, sub]), [["total", "", ""], ["byModelDay", "m", "2026-01-01"]]);
    assert.equal(statsCsv({ total: b }).text.split("\r\n")[1], "total,,,1,2,3,0,0,0,,,");
  });

  it("csvField quotes commas, quotes, CR and LF", () => {
    assert.equal(csvField("plain"), "plain");
    assert.equal(csvField('a,"b"'), '"a,""b"""');
    assert.equal(csvField("x\ny"), '"x\ny"');
    assert.equal(csvField("x\ry"), '"x\ry"');
    assert.equal(csvField(null), "");
    assert.equal(csvField(0.5), "0.5");
  });
});
