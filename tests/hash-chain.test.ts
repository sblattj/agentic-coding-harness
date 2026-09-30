// Tamper-evident metering (#59): hash-chained event logs + terminal seal +
// `ach verify-run`.
//
// Fixtures come from the REAL driver (createDriver + a scripted adapter +
// registry), so "untouched" means exactly what `ach run` writes; tampering is
// then applied to the files on disk the way a person (or a bug) would.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { auditRuns } from "../src/cli/audit.ts";
import { verifyRunDir, verifyRunRecord } from "../src/cli/verify-run.ts";
import { createDriver } from "../src/core/driver.ts";
import {
  ChainWriter,
  genesisHash,
  linkHash,
  parseFramedLine,
  stripChain,
  totalsHash,
  verifyChainText,
} from "../src/core/hash-chain.ts";
import { readRunRecord, RunRecordSchema, writeRunRecord, type RunRecord } from "../src/core/registry.ts";
import type { AgentAdapter, AgentEvent, AgentHandle, RunResult } from "../src/core/types.ts";

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;

function runCli(args: string[], env: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  const p = spawnSync(process.execPath, isBun ? [CLI, ...args] : ["--import", "tsx", CLI, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

type Scripted = Record<string, unknown>;

class ScriptedHandle implements AgentHandle {
  constructor(
    readonly sessionId: string,
    private readonly events: Scripted[],
  ) {}
  async *attach(): AsyncIterable<AgentEvent> {
    for (const e of this.events) yield { ...e, sessionId: this.sessionId, timestamp: Date.now() } as AgentEvent;
  }
  abort(): void {}
  async wait(): Promise<"success"> {
    return "success";
  }
}

class ScriptedAdapter implements AgentAdapter {
  constructor(
    readonly name: string,
    private readonly events: Scripted[],
    private readonly sessionId: string,
  ) {}
  async launch(): Promise<AgentHandle> {
    return new ScriptedHandle(this.sessionId, this.events);
  }
}

const SONNET = "claude-sonnet-4-5-20250929";

function claudeUsage(
  raw: { input: number; output: number; cacheRead: number; cacheWrite: number },
  usageOverride: Record<string, number> = {},
): Scripted {
  const data = { ...raw, reasoning: 0, models: [{ model: SONNET, ...raw, reasoning: 0 }] };
  return {
    type: "usage",
    agent: "claude",
    usage: {
      agent: "claude",
      model: SONNET,
      inputTokens: raw.input,
      outputTokens: raw.output,
      cacheReadTokens: raw.cacheRead,
      cacheWriteTokens: raw.cacheWrite,
      ...usageOverride,
      extra: { totalTokens: null, durationMs: null, raw: data },
    },
    data,
  };
}

const EVENTS: Scripted[] = [
  { type: "step" },
  claudeUsage({ input: 1000, output: 500, cacheRead: 20000, cacheWrite: 3000 }),
  { type: "step" },
  claudeUsage({ input: 40, output: 90, cacheRead: 23000, cacheWrite: 0 }),
];

async function driverRun(
  stateDir: string,
  sessionId: string,
  events: Scripted[] = EVENTS,
  outputDir?: string,
): Promise<{ rec: RunRecord; result: RunResult }> {
  const driver = createDriver({
    adapters: { claude: new ScriptedAdapter("claude", events, sessionId) },
    stateDir,
    registry: { stateDir },
  });
  const result = await driver.run("claude", { prompt: `chain fixture ${sessionId}`, ...(outputDir ? { outputDir } : {}) });
  const rec = readRunRecord(stateDir, result.runId);
  assert.ok(rec, "driver wrote a RunRecord");
  return { rec, result };
}

function transcriptOf(rec: RunRecord): string {
  assert.ok(rec.rawTranscript);
  return rec.rawTranscript;
}

function readLines(file: string): string[] {
  return fs.readFileSync(file, "utf8").split("\n").slice(0, -1);
}

function writeLines(file: string, lines: string[]): void {
  fs.writeFileSync(file, lines.map((l) => `${l}\n`).join(""));
}

function patchRecord(stateDir: string, runId: string, patch: (doc: Record<string, unknown>) => void): void {
  const file = path.join(stateDir, "runs", `${runId}.json`);
  const doc = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  patch(doc);
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
}

describe("hash-chain format", () => {
  it("frames the exact event JSON and strips back to it byte for byte", () => {
    const w = new ChainWriter("run-1");
    const body = JSON.stringify({ type: "usage", n: 1, s: "a\"b\\c", z: { "2": 1, b: 2 } });
    const line = w.frame(body);
    assert.ok(line.startsWith('{"ach_chain":{"v":1,"run":"run-1","seq":0,"prev":"'));
    const parsed = parseFramedLine(line);
    assert.ok(parsed);
    assert.equal(parsed.body, body);
    assert.equal(stripChain(line), body);
    assert.equal(parsed.prev, genesisHash("run-1"));
    assert.equal(parsed.hash, linkHash("run-1", 0, parsed.prev, body));
    // the framed line is itself valid JSON carrying the event's fields
    const obj = JSON.parse(line) as Record<string, unknown>;
    assert.equal(obj.type, "usage");
    assert.equal((obj.ach_chain as { seq: number }).seq, 0);
    // an unchained line passes through stripChain untouched
    assert.equal(stripChain(body), body);
  });

  it("an empty-object body round-trips", () => {
    const w = new ChainWriter("r");
    const line = w.frame("{}");
    assert.equal(parseFramedLine(line)?.body, "{}");
    assert.deepEqual(Object.keys(JSON.parse(line) as object), ["ach_chain"]);
  });

  it("hashes exact bytes: re-serializing a record with reordered keys is an edit", () => {
    const w = new ChainWriter("r");
    const lines = [w.frame('{"type":"step","a":1,"b":2}')];
    const sealed = w.seal(5, null)!;
    lines.push(sealed.line);
    assert.equal(verifyChainText(lines.join("\n") + "\n", { runId: "r", anchor: sealed.seal }).status, "ok");
    lines[0] = lines[0]!.replace('"a":1,"b":2', '"b":2,"a":1');
    const v = verifyChainText(lines.join("\n") + "\n", { runId: "r", anchor: sealed.seal });
    assert.equal(v.status, "tampered");
    assert.equal(v.firstBad?.line, 1);
    assert.match(v.firstBad!.reason, /hash mismatch/);
  });

  it("seal() is idempotent and frame() after the seal throws", () => {
    const w = new ChainWriter("r");
    assert.ok(w.seal(1, null));
    assert.equal(w.seal(2, null), null);
    assert.throws(() => w.frame("{}"), /already sealed/);
  });
});

describe("driver writes a sealed chain (ach run path)", () => {
  it("every transcript line is chained, the run ends in a seal, and RunRecord.seal anchors it", async () => {
    const dir = tmp("ach-chain-");
    const { rec, result } = await driverRun(dir, "s-intact");
    const lines = readLines(transcriptOf(rec));
    assert.equal(lines.length, result.events.length + 1);
    lines.forEach((l, i) => {
      const f = parseFramedLine(l);
      assert.ok(f, `line ${i + 1} is chained`);
      assert.equal(f.run, rec.runId);
      assert.equal(f.seq, i);
    });
    const seal = JSON.parse(stripChain(lines.at(-1)!)) as Record<string, unknown>;
    assert.equal(seal.type, "ach.seal");
    assert.equal(seal.eventCount, result.events.length);
    assert.ok(rec.seal, "RunRecord.seal survives the schema round-trip");
    assert.equal(rec.seal.eventCount, result.events.length);
    assert.equal(rec.seal.sealHash, parseFramedLine(lines.at(-1)!)!.hash);
    assert.equal(rec.seal.totalsHash, totalsHash(rec.totals!));
    // the sealed totals are the recorded ones
    assert.deepEqual(seal.totals, {
      inputTokens: 1040,
      outputTokens: 590,
      cacheReadTokens: 43000,
      cacheWriteTokens: 3000,
      costUsd: rec.totals!.costUsd,
      credits: null,
    });

    const v = verifyRunRecord(dir, rec);
    assert.equal(v.status, "ok");
    assert.equal(v.records, result.events.length);
    assert.equal(v.totals?.status, "match");

    const cli = runCli(["verify-run", rec.runId, "--state-dir", dir]);
    assert.equal(cli.code, 0, cli.stderr);
    assert.match(cli.stdout, /records: 4 chained \+ seal/);
    assert.match(cli.stdout, new RegExp(`seal: +OK  sha256 ${rec.seal.sealHash}`));
    assert.match(cli.stdout, /verdict: OK/);

    const json = runCli(["verify-run", rec.runId, "--state-dir", dir, "--json", "--records"]);
    assert.equal(json.code, 0, json.stderr);
    const doc = JSON.parse(json.stdout) as { status: string; records: number; checks: unknown[]; sealHash: string };
    assert.equal(doc.status, "ok");
    assert.equal(doc.records, 4);
    assert.equal(doc.checks.length, 5); // 4 records + seal
    assert.equal(doc.sealHash, rec.seal.sealHash);
  });

  it("RunRecord.seal parses through the schema (contract)", async () => {
    const dir = tmp("ach-chain-");
    const { rec } = await driverRun(dir, "s-schema");
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "runs", `${rec.runId}.json`), "utf8")) as Record<string, unknown>;
    const parsed = RunRecordSchema.safeParse(onDisk);
    assert.ok(parsed.success);
    assert.deepEqual(parsed.data.seal, onDisk.seal);
  });
});

describe("tampering is detected (first bad record named)", () => {
  it("(a) editing one byte of a middle event (inflating a token count)", async () => {
    const dir = tmp("ach-chain-");
    const { rec } = await driverRun(dir, "s-edit");
    const file = transcriptOf(rec);
    const lines = readLines(file);
    assert.ok(lines[1]!.includes('"inputTokens":1000'));
    lines[1] = lines[1]!.replace('"inputTokens":1000', '"inputTokens":9000');
    writeLines(file, lines);
    const v = verifyRunRecord(dir, rec);
    assert.equal(v.status, "tampered");
    assert.equal(v.firstBad?.line, 2);
    assert.match(v.firstBad!.reason, /hash mismatch/);
    const cli = runCli(["verify-run", rec.runId, "--state-dir", dir]);
    assert.equal(cli.code, 2);
    assert.match(cli.stdout, /TAMPERED — first bad record at line 2 \(seq 1\)/);
  });

  it("editing the chain prefix of a line (e.g. its hash) is caught too", async () => {
    const dir = tmp("ach-chain-");
    const { rec } = await driverRun(dir, "s-prefix");
    const file = transcriptOf(rec);
    const lines = readLines(file);
    lines[2] = lines[2]!.replace(/"hash":"(.)/, (_m, c: string) => `"hash":"${c === "0" ? "1" : "0"}`);
    writeLines(file, lines);
    const v = verifyRunRecord(dir, rec);
    assert.equal(v.status, "tampered");
    assert.equal(v.firstBad?.line, 3);
  });

  it("(b) deleting a record from the middle", async () => {
    const dir = tmp("ach-chain-");
    const { rec } = await driverRun(dir, "s-delete");
    const file = transcriptOf(rec);
    const lines = readLines(file);
    lines.splice(1, 1);
    writeLines(file, lines);
    const v = verifyRunRecord(dir, rec);
    assert.equal(v.status, "tampered");
    assert.equal(v.firstBad?.line, 2);
    assert.match(v.firstBad!.reason, /sequence break: expected seq 1, found 2/);
    assert.equal(runCli(["verify-run", rec.runId, "--state-dir", dir]).code, 2);
  });

  it("(c) swapping two records", async () => {
    const dir = tmp("ach-chain-");
    const { rec } = await driverRun(dir, "s-swap");
    const file = transcriptOf(rec);
    const lines = readLines(file);
    [lines[1], lines[2]] = [lines[2]!, lines[1]!];
    writeLines(file, lines);
    const v = verifyRunRecord(dir, rec);
    assert.equal(v.status, "tampered");
    assert.equal(v.firstBad?.line, 2);
    assert.match(v.firstBad!.reason, /sequence break/);
  });

  it("(d) truncating the tail (seal line alone, or seal + last record)", async () => {
    const dir = tmp("ach-chain-");
    const { rec } = await driverRun(dir, "s-trunc");
    const file = transcriptOf(rec);
    const lines = readLines(file);
    writeLines(file, lines.slice(0, -1));
    let v = verifyRunRecord(dir, rec);
    assert.equal(v.status, "tampered");
    assert.equal(v.firstBad?.line, lines.length);
    assert.match(v.firstBad!.reason, /seal record missing/);
    writeLines(file, lines.slice(0, -2));
    v = verifyRunRecord(dir, rec);
    assert.equal(v.status, "tampered");
    assert.match(v.firstBad!.reason, /tail truncated/);
    assert.equal(runCli(["verify-run", rec.runId, "--state-dir", dir]).code, 2);
  });

  it("(e) editing totals.costUsd in the RunRecord", async () => {
    const dir = tmp("ach-chain-");
    const { rec } = await driverRun(dir, "s-cost");
    patchRecord(dir, rec.runId, (doc) => {
      (doc.totals as { costUsd: number }).costUsd = 0.000001;
    });
    const v = verifyRunRecord(dir, readRunRecord(dir, rec.runId)!);
    assert.equal(v.status, "tampered");
    assert.equal(v.totals?.status, "mismatch");
    assert.match(v.firstBad!.reason, /costUsd sealed=.* recorded=0\.000001/);
    const cli = runCli(["verify-run", rec.runId, "--state-dir", dir]);
    assert.equal(cli.code, 2);
    assert.match(cli.stdout, /totals: +DIFFER from the seal: costUsd/);
  });

  it("a planted unchained usage line inside the run", async () => {
    const dir = tmp("ach-chain-");
    const { rec } = await driverRun(dir, "s-plant");
    const file = transcriptOf(rec);
    const lines = readLines(file);
    const planted = stripChain(lines[1]!);
    lines.splice(2, 0, planted);
    writeLines(file, lines);
    const v = verifyRunRecord(dir, rec);
    assert.equal(v.status, "tampered");
    assert.equal(v.firstBad?.line, 3);
    assert.match(v.firstBad!.reason, /unchained or malformed line inside the run/);
  });

  it("editing RunRecord.seal itself disagrees with the log's seal", async () => {
    const dir = tmp("ach-chain-");
    const { rec } = await driverRun(dir, "s-anchor");
    patchRecord(dir, rec.runId, (doc) => {
      (doc.seal as { eventCount: number }).eventCount = 99;
    });
    const v = verifyRunRecord(dir, readRunRecord(dir, rec.runId)!);
    assert.equal(v.status, "tampered");
    assert.match(v.firstBad!.reason, /disagrees with its anchor/);
  });
});

describe("non-tampered states", () => {
  it("a pre-#59 (unhashed) log with a seal-less RunRecord verifies as unsealed, exit 3", () => {
    const dir = tmp("ach-chain-legacy-");
    fs.mkdirSync(path.join(dir, "raw"), { recursive: true });
    const transcript = path.join(dir, "raw", "claude-s-legacy.jsonl");
    writeLines(transcript, [
      JSON.stringify({ type: "step", sessionId: "s-legacy", timestamp: 1000 }),
      JSON.stringify({ type: "usage", sessionId: "s-legacy", timestamp: 1001, usage: { inputTokens: 1, outputTokens: 1 } }),
    ]);
    const rec: RunRecord = {
      runId: "legacy-run",
      agent: "claude",
      sessionId: "s-legacy",
      startedAt: 999,
      status: "success",
      totals: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
      rawTranscript: transcript,
    };
    writeRunRecord(dir, rec);
    const v = verifyRunRecord(dir, readRunRecord(dir, "legacy-run")!);
    assert.equal(v.status, "unsealed");
    const cli = runCli(["verify-run", "legacy-run", "--state-dir", dir]);
    assert.equal(cli.code, 3, cli.stderr);
    assert.match(cli.stdout, /UNSEALED \(legacy\)/);
  });

  it("a chained log with no seal and no anchor on a still-running record (crash) is open, exit 4", async () => {
    const dir = tmp("ach-chain-");
    const { rec } = await driverRun(dir, "s-open");
    const file = transcriptOf(rec);
    writeLines(file, readLines(file).slice(0, -1));
    // what a crash leaves: the driver never reached its seal nor its terminal write
    patchRecord(dir, rec.runId, (doc) => {
      delete doc.seal;
      doc.status = "running";
    });
    const v = verifyRunRecord(dir, readRunRecord(dir, rec.runId)!);
    assert.equal(v.status, "open");
    assert.equal(runCli(["verify-run", rec.runId, "--state-dir", dir]).code, 4);
  });

  it("the same unsealed log on a FINISHED record is tampered (seal line + anchor removed)", async () => {
    const dir = tmp("ach-chain-");
    const { rec } = await driverRun(dir, "s-open-done");
    const file = transcriptOf(rec);
    const lines = readLines(file);
    writeLines(file, lines.slice(0, -1));
    patchRecord(dir, rec.runId, (doc) => {
      delete doc.seal;
    });
    const after = readRunRecord(dir, rec.runId)!;
    assert.equal(after.status, "success");
    const v = verifyRunRecord(dir, after);
    assert.equal(v.status, "tampered");
    assert.equal(v.firstBad?.line, lines.length);
    assert.match(v.firstBad!.reason, /recorded as finished \(status "success"\) but its chain has no seal/);
    assert.equal(runCli(["verify-run", rec.runId, "--state-dir", dir]).code, 2);
  });

  it("an unknown run id is a lookup error (exit 1), not a verdict", () => {
    const dir = tmp("ach-chain-");
    const cli = runCli(["verify-run", "no-such-run", "--state-dir", dir]);
    assert.equal(cli.code, 1);
    assert.match(cli.stderr, /no run 'no-such-run'/);
  });

  it("two runs appended to one transcript (resumed session) each verify; a legacy prefix is ignored", async () => {
    const dir = tmp("ach-chain-append-");
    fs.mkdirSync(path.join(dir, "raw"), { recursive: true });
    const shared = path.join(dir, "raw", "claude-s-shared.jsonl");
    // pre-#59 history already in the file
    writeLines(shared, [JSON.stringify({ type: "step", sessionId: "s-shared", timestamp: 1 })]);
    const a = await driverRun(dir, "s-shared");
    const b = await driverRun(dir, "s-shared", [{ type: "step" }, claudeUsage({ input: 5, output: 6, cacheRead: 0, cacheWrite: 0 })]);
    assert.equal(a.rec.rawTranscript, b.rec.rawTranscript);
    const lines = readLines(shared);
    assert.equal(lines.length, 1 + (4 + 1) + (2 + 1));
    assert.equal(verifyRunRecord(dir, a.rec).status, "ok");
    assert.equal(verifyRunRecord(dir, b.rec).status, "ok");
    assert.equal(verifyRunRecord(dir, b.rec).records, 2);
    // tampering with the second run breaks only the second run
    lines[lines.length - 2] = lines[lines.length - 2]!.replace('"inputTokens":5', '"inputTokens":6');
    writeLines(shared, lines);
    assert.equal(verifyRunRecord(dir, a.rec).status, "ok");
    assert.equal(verifyRunRecord(dir, b.rec).status, "tampered");
  });

  it("`ach audit --fix` after the seal is disclosed, not tampering; audit rows carry the chain verdict", async () => {
    const dir = tmp("ach-chain-audit-");
    // adapter misparse: pre-normalized cacheRead doubles the raw payload's, so
    // the recorded (and sealed) totals drift from what audit re-derives.
    const { rec } = await driverRun(dir, "s-audit", [
      claudeUsage({ input: 10, output: 20, cacheRead: 8000, cacheWrite: 0 }, { cacheReadTokens: 16000 }),
    ]);
    const before = auditRuns({ stateDir: dir });
    assert.equal(before.rows[0]?.status, "drift");
    assert.equal(before.rows[0]?.chain, "ok");
    const fixed = auditRuns({ stateDir: dir, fix: true });
    assert.deepEqual(fixed.rows[0]?.fixed?.includes("cacheReadTokens"), true);
    const after = readRunRecord(dir, rec.runId)!;
    assert.equal(after.totals?.cacheReadTokens, 8000);
    const v = verifyRunRecord(dir, after);
    assert.equal(v.status, "ok");
    assert.equal(v.totals?.status, "match-after-corrections");
    const cli = runCli(["verify-run", rec.runId, "--state-dir", dir]);
    assert.equal(cli.code, 0, cli.stdout);
    assert.match(cli.stdout, /match the seal after undoing \d+ audit correction/);
    // audit on a tampered log says so in its row
    const file = transcriptOf(rec);
    const lines = readLines(file);
    lines[0] = lines[0]!.replace('"outputTokens":20', '"outputTokens":21');
    writeLines(file, lines);
    const tampered = auditRuns({ stateDir: dir });
    assert.equal(tampered.rows[0]?.chain, "tampered");
    assert.match(tampered.rows[0]?.chainBreak ?? "", /line 1/);
  });
});

describe("run-to-directory events.jsonl (outputDir) shares the chain", () => {
  it("events.jsonl ends in the same seal as the transcript; status.json anchors it; tampering is caught", async () => {
    const dir = tmp("ach-chain-");
    const out = path.join(dir, "out");
    const { rec } = await driverRun(dir, "s-dir", EVENTS, out);
    const events = readLines(path.join(out, "events.jsonl"));
    const transcript = readLines(transcriptOf(rec));
    assert.deepEqual(events, transcript, "both logs carry byte-identical chained lines");
    const status = JSON.parse(fs.readFileSync(path.join(out, "status.json"), "utf8")) as { seal?: { sealHash: string } };
    assert.equal(status.seal?.sealHash, rec.seal?.sealHash);
    assert.equal(verifyRunDir(out).status, "ok");
    const cli = runCli(["verify-run", out]);
    assert.equal(cli.code, 0, cli.stderr);
    events[1] = events[1]!.replace('"inputTokens":1000', '"inputTokens":1001');
    writeLines(path.join(out, "events.jsonl"), events);
    const v = verifyRunDir(out);
    assert.equal(v.status, "tampered");
    assert.equal(v.firstBad?.line, 2);
  });

  it("status.json anchors the tail: a truncated seal line, a damaged anchor, and a stripped anchor are all caught", async () => {
    const dir = tmp("ach-chain-");
    const out = path.join(dir, "out");
    await driverRun(dir, "s-dir-tail", EVENTS, out);
    const eventsFile = path.join(out, "events.jsonl");
    const statusFile = path.join(out, "status.json");
    const events = readLines(eventsFile);
    const statusText = fs.readFileSync(statusFile, "utf8");
    // control: intact and anchored (no "no external anchor" note)
    const ok = verifyRunDir(out);
    assert.equal(ok.status, "ok");
    assert.ok(!ok.notes.some((n) => /no external anchor/.test(n)));
    // truncated seal line: only the status.json anchor can see this
    writeLines(eventsFile, events.slice(0, -1));
    let v = verifyRunDir(out);
    assert.equal(v.status, "tampered");
    assert.match(v.firstBad!.reason, /seal record missing/);
    writeLines(eventsFile, events);
    // malformed anchor
    const doc = JSON.parse(statusText) as { seal: { sealHash: string }; status: string };
    fs.writeFileSync(statusFile, JSON.stringify({ ...doc, seal: { ...doc.seal, sealHash: "nope" } }));
    v = verifyRunDir(out);
    assert.equal(v.status, "tampered");
    assert.match(v.firstBad!.reason, /seal is malformed/);
    // unparseable status.json
    fs.writeFileSync(statusFile, "{not json");
    assert.equal(verifyRunDir(out).status, "tampered");
    // anchor stripped AND seal line truncated on a terminal status.json
    const { seal: _s, ...noSeal } = doc;
    void _s;
    fs.writeFileSync(statusFile, JSON.stringify(noSeal));
    writeLines(eventsFile, events.slice(0, -1));
    v = verifyRunDir(out);
    assert.equal(v.status, "tampered");
    assert.match(v.firstBad!.reason, /recorded as finished/);
    // same files with status "running" (a crash) read as open
    fs.writeFileSync(statusFile, JSON.stringify({ ...noSeal, status: "running" }));
    assert.equal(verifyRunDir(out).status, "open");
  });
});

describe("ach report shows the seal verdict per run", () => {
  it("renders ✓ sealed for an intact run and ✗ TAMPERED once its totals are edited", async () => {
    const dir = tmp("ach-chain-report-");
    const { rec, result } = await driverRun(dir, "s-report");
    const trial = path.join(dir, "trials", "t1");
    fs.mkdirSync(trial, { recursive: true });
    fs.writeFileSync(path.join(trial, "claude.json"), JSON.stringify(result));
    const outFile = path.join(dir, "r.html");
    const env = { AGENTIC_CODING_HARNESS_STATE_DIR: dir };
    let r = runCli(["report", trial, "--out", outFile], env);
    assert.equal(r.code, 0, r.stderr);
    let html = fs.readFileSync(outFile, "utf8");
    assert.match(html, /<th data-k="seal" data-t="s">seal<\/th>/);
    assert.match(html, /<td data-v="ok" title="sealed ✓ \(4 records\) · seal [0-9a-f]{64}">✓ sealed<\/td>/);
    patchRecord(dir, rec.runId, (doc) => {
      (doc.totals as { inputTokens: number }).inputTokens = 1;
    });
    r = runCli(["report", trial, "--out", outFile], env);
    assert.equal(r.code, 0, r.stderr);
    html = fs.readFileSync(outFile, "utf8");
    assert.match(html, /<td data-v="tampered" title="TAMPERED at line \d+: recorded totals differ[^"]*">✗ TAMPERED<\/td>/);
  });
});
