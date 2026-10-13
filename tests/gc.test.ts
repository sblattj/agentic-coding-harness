// ach gc (#70): retention for <stateDir>/raw transcripts and <stateDir>/runs
// records. Every fixture lives in a temp state dir; nothing here touches the
// real ~/.agentic-coding-harness.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { applyGc, FRESH_GUARD_MS, planGc, type GcPolicy } from "../src/core/gc.ts";
import { GC_RUNS_TTL_ENV, GC_TRANSCRIPTS_TTL_ENV, parseBefore, resolveGcPolicy } from "../src/cli/gc.ts";
import { readRunRecord, resolveRawTranscript, scanRunRecords, writeRunRecord, type RunRecord } from "../src/core/registry.ts";

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;
const DAY = 86_400_000;
const NOW = Date.now();

function runCli(args: string[], env: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  const p = spawnSync(process.execPath, isBun ? [CLI, ...args] : ["--import", "tsx", CLI, ...args], {
    env: { ...process.env, [GC_TRANSCRIPTS_TTL_ENV]: "", [GC_RUNS_TTL_ENV]: "", ...env },
    encoding: "utf8",
  });
  return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

function tmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function write(file: string, text: string, mtimeMs?: number): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mtimeMs !== undefined) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

function age(file: string, mtimeMs: number): void {
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
}

/** A pid that is certainly gone: a child that has already exited. */
function deadPid(): number {
  const p = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  assert.ok(p.pid);
  return p.pid;
}

/** Seed a finished run (record + driver transcript) that ended `ageDays` ago. */
function seedRun(state: string, runId: string, ageDays: number, extra: Partial<RunRecord> = {}): { record: string; transcript: string } {
  const t = NOW - ageDays * DAY;
  const transcript = write(path.join(state, "raw", `claude-${runId}.jsonl`), `{"type":"usage","usage":{"inputTokens":1,"outputTokens":1}}\n`.repeat(4), t);
  const rec: RunRecord = {
    runId,
    agent: "claude",
    sessionId: runId,
    pid: deadPid(),
    startedAt: t - 60_000,
    updatedAt: t,
    endedAt: t,
    status: "success",
    rawTranscript: transcript,
    totals: { inputTokens: 4, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.12 },
    ...extra,
  };
  writeRunRecord(state, rec);
  const record = path.join(state, "runs", `${runId}.json`);
  age(record, t);
  return { record, transcript };
}

const exists = (f: string): boolean => {
  try {
    fs.lstatSync(f);
    return true;
  } catch {
    return false;
  }
};

/** Every file under `dir` with its size and content hash proxy (for "nothing changed"). */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(`${path.relative(dir, p)}:${e.isSymbolicLink() ? "link" : fs.statSync(p).size}`);
    }
  };
  walk(dir);
  return out.sort();
}

const ALL: GcPolicy = { transcriptsBefore: NOW - 10 * DAY, runsBefore: NOW - 10 * DAY };

describe("ach gc: TTL policy resolution", () => {
  it("defaults: transcripts 30d, run records kept forever", () => {
    const p = resolveGcPolicy({}, NOW, {});
    assert.equal(p.transcriptsBefore, NOW - 30 * DAY);
    assert.equal(p.runsBefore, null);
  });

  it("--before sets both classes; --keep-summaries keeps run records", () => {
    assert.deepEqual(resolveGcPolicy({ before: "2w" }, NOW, {}), { transcriptsBefore: NOW - 14 * DAY, runsBefore: NOW - 14 * DAY });
    assert.deepEqual(resolveGcPolicy({ before: "2w", keepSummaries: true }, NOW, {}), { transcriptsBefore: NOW - 14 * DAY, runsBefore: null });
  });

  it("per-class TTLs are separate: class flag > --before > env > default", () => {
    assert.deepEqual(resolveGcPolicy({ before: "30d", transcriptsTtl: "7d" }, NOW, {}), { transcriptsBefore: NOW - 7 * DAY, runsBefore: NOW - 30 * DAY });
    assert.deepEqual(resolveGcPolicy({ before: "30d", runsTtl: "never" }, NOW, {}), { transcriptsBefore: NOW - 30 * DAY, runsBefore: null });
    const env = { [GC_TRANSCRIPTS_TTL_ENV]: "3d", [GC_RUNS_TTL_ENV]: "90d" };
    assert.deepEqual(resolveGcPolicy({}, NOW, env), { transcriptsBefore: NOW - 3 * DAY, runsBefore: NOW - 90 * DAY });
    assert.deepEqual(resolveGcPolicy({ transcriptsTtl: "1d" }, NOW, env), { transcriptsBefore: NOW - 1 * DAY, runsBefore: NOW - 90 * DAY });
    assert.deepEqual(resolveGcPolicy({}, NOW, { [GC_TRANSCRIPTS_TTL_ENV]: "never" }).transcriptsBefore, null);
  });

  it("--keep-summaries with a finite --runs-ttl is a usage error; bad specs are rejected", () => {
    assert.throws(() => resolveGcPolicy({ keepSummaries: true, runsTtl: "7d" }, NOW, {}), /cannot be combined/);
    assert.throws(() => resolveGcPolicy({ transcriptsTtl: "soon" }, NOW, {}), /cannot parse/);
    assert.throws(() => resolveGcPolicy({ before: "garbage" }, NOW, {}), /cannot parse/);
  });

  it("--before accepts a date as well as a duration", () => {
    assert.equal(parseBefore("2026-01-02T00:00:00Z", NOW), Date.parse("2026-01-02T00:00:00Z"));
    assert.equal(parseBefore("7d ago", NOW), NOW - 7 * DAY);
  });
});

describe("ach gc: scanning and selective pruning", () => {
  it("prunes old transcripts and runs, keeps young ones", () => {
    const state = tmp("ach-gc-");
    const old = seedRun(state, "old-run", 40);
    const young = seedRun(state, "young-run", 2);
    const orphanOld = write(path.join(state, "raw", "opencode", "sess-a.jsonl"), "{}\n", NOW - 40 * DAY);
    const orphanYoung = write(path.join(state, "raw", "opencode", "sess-b.jsonl"), "{}\n", NOW - 2 * DAY);
    const plan = planGc({ stateDir: state, policy: ALL, now: NOW });
    assert.deepEqual(plan.victims.map((v) => v.file).sort(), [old.record, old.transcript, orphanOld].sort());
    assert.equal(plan.counts.run, 1);
    assert.equal(plan.counts.transcript, 2);
    assert.equal(plan.bytes, fs.statSync(old.record).size + fs.statSync(old.transcript).size + fs.statSync(orphanOld).size);
    const res = applyGc(plan);
    assert.equal(res.deleted.length, 3);
    assert.equal(res.bytes, plan.bytes);
    for (const f of [old.record, old.transcript, orphanOld]) assert.equal(exists(f), false, f);
    for (const f of [young.record, young.transcript, orphanYoung]) assert.equal(exists(f), true, f);
  });

  it("--keep-summaries truncates transcripts only: the run record (tokens, cost, status) survives", () => {
    const state = tmp("ach-gc-");
    const old = seedRun(state, "old-run", 40);
    const plan = planGc({ stateDir: state, policy: { transcriptsBefore: NOW - 10 * DAY, runsBefore: null }, now: NOW });
    assert.deepEqual(plan.victims.map((v) => v.class), ["transcript"]);
    applyGc(plan);
    assert.equal(exists(old.transcript), false);
    const rec = readRunRecord(state, "old-run");
    assert.ok(rec);
    assert.equal(rec.totals?.costUsd, 0.12);
    assert.equal(rec.status, "success");
  });

  it("a linked transcript ages with its run, and a still-growing file is judged by its mtime", () => {
    const state = tmp("ach-gc-");
    // Record ended long ago but the transcript was touched recently: keep.
    const r = seedRun(state, "r1", 40);
    age(r.transcript, NOW - 1 * DAY);
    const plan = planGc({ stateDir: state, policy: ALL, now: NOW });
    assert.equal(plan.victims.some((v) => v.file === r.transcript), false);
  });

  it("pruning does not corrupt registry scans: kept records parse, nothing is skipped", () => {
    const state = tmp("ach-gc-");
    seedRun(state, "a", 40);
    seedRun(state, "b", 40);
    seedRun(state, "c", 1);
    applyGc(planGc({ stateDir: state, policy: ALL, now: NOW }));
    const scan = scanRunRecords(state);
    assert.deepEqual(scan.records.map((r) => r.runId), ["c"]);
    assert.deepEqual(scan.skipped, []);
    // keep-summaries: the record remains and its now-missing transcript
    // resolves to the stored path (callers treat missing as empty).
    const s2 = tmp("ach-gc-");
    const k = seedRun(s2, "k", 40);
    applyGc(planGc({ stateDir: s2, policy: { transcriptsBefore: NOW - DAY, runsBefore: null }, now: NOW }));
    const scan2 = scanRunRecords(s2);
    assert.deepEqual(scan2.skipped, []);
    assert.equal(resolveRawTranscript(s2, scan2.records[0]!), k.transcript);
  });
});

describe("ach gc: SAFETY", () => {
  it("only raw/**/*.jsonl and runs/*.json are candidates; every other state file survives", () => {
    const state = tmp("ach-gc-");
    const old = NOW - 400 * DAY;
    const others = [
      write(path.join(state, "warehouse", "b1", "raw", "claude-x.jsonl"), "{}\n", old),
      write(path.join(state, "warehouse", "b1", "runs", "x.json"), "{}", old),
      write(path.join(state, "state", "thing.json"), "{}", old),
      write(path.join(state, "queues", "q.jsonl"), "{}\n", old),
      write(path.join(state, "quota", "q.json"), "{}", old),
      write(path.join(state, "offsets.json"), "{}", old),
      write(path.join(state, "alerts.json"), "{}", old),
      write(path.join(state, "raw", "notes.txt"), "x", old),
      write(path.join(state, "runs", "in-flight.json.tmp-123"), "{}", old),
      write(path.join(state, "runs", "corrupt.json"), "not json", old), // unparseable: left for `ach audit`
    ];
    seedRun(state, "gone", 400);
    const res = applyGc(planGc({ stateDir: state, policy: { transcriptsBefore: NOW, runsBefore: NOW }, now: NOW }));
    assert.equal(res.deleted.length, 2);
    for (const f of others) assert.equal(exists(f), true, f);
  });

  it("a symlinked transcript is refused and reported; its outside target survives; a real sibling is pruned", () => {
    const state = tmp("ach-gc-");
    const outside = tmp("ach-gc-outside-");
    const target = write(path.join(outside, "precious.jsonl"), "keep me\n", NOW - 400 * DAY);
    const link = path.join(state, "raw", "claude-link.jsonl");
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link);
    const sibling = write(path.join(state, "raw", "claude-real.jsonl"), "{}\n", NOW - 400 * DAY);
    const plan = planGc({ stateDir: state, policy: ALL, now: NOW });
    assert.ok(plan.refused.some((r) => r.file === link && /symlink/.test(r.reason)), JSON.stringify(plan.refused));
    assert.equal(plan.victims.some((v) => v.file === link || v.file === target), false);
    applyGc(plan);
    assert.equal(fs.readFileSync(target, "utf8"), "keep me\n");
    assert.equal(exists(link), true);
    assert.equal(exists(sibling), false);
  });

  it("a symlinked directory under raw/, or a raw/ that is itself a symlink, is refused and never walked", () => {
    const state = tmp("ach-gc-");
    const outside = tmp("ach-gc-outside-");
    const target = write(path.join(outside, "agent", "s.jsonl"), "keep\n", NOW - 400 * DAY);
    fs.mkdirSync(path.join(state, "raw"), { recursive: true });
    fs.symlinkSync(path.join(outside, "agent"), path.join(state, "raw", "agent"));
    let plan = planGc({ stateDir: state, policy: ALL, now: NOW });
    assert.ok(plan.refused.some((r) => r.file === path.join(state, "raw", "agent")));
    assert.equal(plan.victims.length, 0);
    applyGc(plan);
    assert.equal(exists(target), true);

    const s2 = tmp("ach-gc-");
    fs.symlinkSync(path.join(outside, "agent"), path.join(s2, "raw"));
    plan = planGc({ stateDir: s2, policy: ALL, now: NOW });
    assert.ok(plan.refused.some((r) => r.file === path.join(s2, "raw")));
    assert.equal(plan.victims.length, 0);
    applyGc(plan);
    assert.equal(exists(target), true);
  });

  it("applyGc re-checks containment: a victim outside the state dir is refused, not deleted", () => {
    const state = tmp("ach-gc-");
    const outside = tmp("ach-gc-outside-");
    const target = write(path.join(outside, "x.jsonl"), "keep\n");
    const plan = planGc({ stateDir: state, policy: ALL, now: NOW });
    plan.realStateDir = state;
    plan.victims.push({ file: target, class: "transcript", bytes: 5, at: 0 });
    const traversal = path.join(state, "raw", "..", "..", path.basename(outside), "x.jsonl");
    plan.victims.push({ file: traversal, class: "transcript", bytes: 5, at: 0 });
    const res = applyGc(plan);
    assert.equal(res.deleted.length, 0);
    assert.equal(res.failed.length, 2);
    assert.equal(exists(target), true);
  });

  it("applyGc refuses a victim swapped for a symlink after planning", () => {
    const state = tmp("ach-gc-");
    const outside = tmp("ach-gc-outside-");
    const target = write(path.join(outside, "x.jsonl"), "keep\n");
    const f = write(path.join(state, "raw", "claude-swap.jsonl"), "{}\n", NOW - 400 * DAY);
    const plan = planGc({ stateDir: state, policy: ALL, now: NOW });
    assert.equal(plan.victims.length, 1);
    fs.unlinkSync(f);
    fs.symlinkSync(target, f);
    const res = applyGc(plan);
    assert.equal(res.deleted.length, 0);
    assert.match(res.failed[0]!.reason, /symlink/);
    assert.equal(exists(target), true);
  });

  it("a live run (fresh heartbeat, pid alive) keeps its record and transcript under any cutoff", () => {
    const state = tmp("ach-gc-");
    const live = seedRun(state, "live", 40, { status: "running", pid: process.pid, endedAt: undefined, updatedAt: NOW });
    age(live.record, NOW - 40 * DAY);
    age(live.transcript, NOW - 40 * DAY);
    const plan = planGc({ stateDir: state, policy: { transcriptsBefore: NOW, runsBefore: NOW }, now: NOW });
    assert.equal(plan.victims.length, 0);
    assert.deepEqual(plan.protected.map((p) => `${p.class}:${p.reason}`).sort(), ["run:live-run", "transcript:live-run"]);
    applyGc(plan);
    assert.equal(exists(live.record), true);
    assert.equal(exists(live.transcript), true);
  });

  it("a hung run (stale heartbeat, pid still alive) is also protected", () => {
    const state = tmp("ach-gc-");
    const hung = seedRun(state, "hung", 40, { status: "running", pid: process.pid, endedAt: undefined });
    const plan = planGc({ stateDir: state, policy: { transcriptsBefore: NOW, runsBefore: NOW }, now: NOW });
    assert.equal(plan.victims.length, 0);
    applyGc(plan);
    assert.equal(exists(hung.record), true);
    assert.equal(exists(hung.transcript), true);
  });

  it("a 'running' record whose pid is gone (interrupted) is eligible", () => {
    const state = tmp("ach-gc-");
    const dead = seedRun(state, "dead", 40, { status: "running", pid: deadPid(), endedAt: undefined });
    const plan = planGc({ stateDir: state, policy: ALL, now: NOW });
    assert.deepEqual(plan.victims.map((v) => v.file).sort(), [dead.record, dead.transcript].sort());
  });

  it("files written in the last minute are never deleted, even with a zero TTL", () => {
    const state = tmp("ach-gc-");
    const fresh = write(path.join(state, "raw", "claude-new.jsonl"), "{}\n", NOW - FRESH_GUARD_MS / 2);
    const plan = planGc({ stateDir: state, policy: { transcriptsBefore: NOW + DAY, runsBefore: NOW + DAY }, now: NOW });
    assert.equal(plan.victims.length, 0);
    assert.deepEqual(plan.protected.map((p) => p.reason), ["fresh"]);
    applyGc(plan);
    assert.equal(exists(fresh), true);
  });

  it("a missing state dir is a no-op", () => {
    const plan = planGc({ stateDir: path.join(tmp("ach-gc-"), "nope"), policy: ALL, now: NOW });
    assert.equal(plan.victims.length, 0);
    assert.deepEqual(applyGc(plan), { deleted: [], failed: [], bytes: 0 });
  });
});

describe("ach gc: CLI", () => {
  it("--dry-run lists every victim with bytes and leaves the state dir byte-identical", () => {
    const state = tmp("ach-gc-");
    const old = seedRun(state, "old-run", 40);
    seedRun(state, "young-run", 2);
    const before = snapshot(state);
    const r = runCli(["gc", "--dry-run", "--before", "30d", "--state-dir", state]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /would delete\s+run\s+[\d,]+ B {2}runs\/old-run\.json/);
    assert.match(r.stdout, /would delete\s+transcript\s+[\d,]+ B {2}raw\/claude-old-run\.jsonl/);
    const bytes = fs.statSync(old.record).size + fs.statSync(old.transcript).size;
    assert.match(r.stdout, new RegExp(`dry run: would delete 2 files \\(1 transcripts, 1 runs\\), ${bytes.toLocaleString("en-US")} bytes`));
    assert.deepEqual(snapshot(state), before);
    assert.equal(exists(path.join(state, "gc-log.jsonl")), false);
  });

  it("--dry-run --json reports the plan; a real pass deletes the same set and logs it", () => {
    const state = tmp("ach-gc-");
    seedRun(state, "old-run", 40);
    seedRun(state, "young-run", 2);
    const dry = JSON.parse(runCli(["gc", "--dry-run", "--json", "--before", "30d", "--state-dir", state]).stdout);
    assert.equal(dry.dryRun, true);
    assert.equal(dry.result, null);
    const planned = (dry.victims as Array<{ file: string; bytes: number }>).map((v) => v.file).sort();
    assert.equal(planned.length, 2);
    const real = runCli(["gc", "--json", "--before", "30d", "--state-dir", state]);
    assert.equal(real.code, 0, real.stderr);
    const out = JSON.parse(real.stdout);
    assert.deepEqual((out.result.deleted as Array<{ file: string }>).map((v) => v.file).sort(), planned);
    for (const f of planned) assert.equal(exists(f), false);
    const log = fs.readFileSync(path.join(state, "gc-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(log.length, 1);
    assert.equal(log[0].deleted.length, 2);
    assert.equal(log[0].bytes, dry.bytes);
  });

  it("--keep-summaries prunes transcripts only; env TTLs apply when no flag is given", () => {
    const state = tmp("ach-gc-");
    const old = seedRun(state, "old-run", 40);
    const r = runCli(["gc", "--before", "30d", "--keep-summaries", "--state-dir", state]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(exists(old.record), true);
    assert.equal(exists(old.transcript), false);

    const s2 = tmp("ach-gc-");
    const o2 = seedRun(s2, "o2", 10);
    const r2 = runCli(["gc", "--state-dir", s2], { [GC_TRANSCRIPTS_TTL_ENV]: "7d", [GC_RUNS_TTL_ENV]: "5d" });
    assert.equal(r2.code, 0, r2.stderr);
    assert.equal(exists(o2.record), false);
    assert.equal(exists(o2.transcript), false);
  });

  it("bare `ach gc` keeps run records and 29-day-old transcripts (defaults: 30d / never)", () => {
    const state = tmp("ach-gc-");
    const old = seedRun(state, "old-run", 400);
    const recent = seedRun(state, "recent", 29);
    const r = runCli(["gc", "--state-dir", state]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(exists(old.record), true);
    assert.equal(exists(old.transcript), false);
    assert.equal(exists(recent.transcript), true);
  });

  it("usage errors exit non-zero and delete nothing", () => {
    const state = tmp("ach-gc-");
    seedRun(state, "old-run", 40);
    const before = snapshot(state);
    const r = runCli(["gc", "--keep-summaries", "--runs-ttl", "7d", "--state-dir", state]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /cannot be combined/);
    assert.deepEqual(snapshot(state), before);
  });

  it("`ach gc --help` prints the gc usage lines", () => {
    const r = runCli(["gc", "--help"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /ach gc \[--dry-run\]/);
    assert.match(r.stdout, /--keep-summaries/);
  });
});
