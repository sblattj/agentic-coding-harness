// `ach import` (#25): existing Claude Code transcripts become RunRecords with
// source "imported" — idempotent, deduped against native runs, windowed, and
// tolerant of corrupt files — without changing any `ach stats` total.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ccusageHintText, importedRunId, importSessions, parseStatsOrigin, probeJsonl } from "../src/cli/import.ts";
import { isLive, listRunRecords, registryDir, RunRecordSchema, writeRunRecord } from "../src/core/registry.ts";
import { provenanceOf } from "../src/core/provenance.ts";
import { scanOptionsForRoot } from "../src/monitors/transcripts.ts";
import { HarnessError } from "../src/core/types.ts";

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;
const DAY = 86_400_000;

function runCli(args: string[], env: Record<string, string>): { code: number; stdout: string; stderr: string } {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  const base: Record<string, string | undefined> = { ...process.env };
  delete base.AGENTIC_CODING_HARNESS_COST_MODE;
  const p = spawnSync(process.execPath, isBun ? [CLI, ...args] : ["--import", "tsx", CLI, ...args], {
    env: { ...base, AGENTIC_CODING_HARNESS_TZ: "UTC", ...env } as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 120_000,
  });
  return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

function writeJsonl(file: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function line(sessionId: string, ageMs: number, n: number, input: number, output: number, cwd = "/work/repo") {
  return {
    type: "assistant",
    timestamp: new Date(Date.now() - ageMs).toISOString(),
    sessionId,
    requestId: `req-${sessionId}-${n}`,
    cwd,
    message: {
      id: `msg-${sessionId}-${n}`,
      model: "claude-sonnet-4-5",
      usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 10 * n, cache_creation_input_tokens: 5 },
    },
  };
}

/** Home-shaped fixture root: two recent sessions (one with a subagent file),
 *  one native-owned session, one 45-day-old session, one corrupt file. */
function fixture(root: string): void {
  const proj = path.join(root, ".claude", "projects", "-work-repo");
  writeJsonl(path.join(proj, "sess-a.jsonl"), [line("sess-a", 3 * 3_600_000, 1, 100, 50), line("sess-a", 2 * 3_600_000, 2, 200, 70)]);
  writeJsonl(path.join(proj, "sess-a", "subagents", "agent-x1.jsonl"), [line("sess-a", 2 * 3_600_000, 3, 40, 20)]);
  writeJsonl(path.join(proj, "sess-b.jsonl"), [line("sess-b", 2 * DAY, 1, 300, 90)]);
  writeJsonl(path.join(proj, "sess-native.jsonl"), [line("sess-native", DAY, 1, 500, 100)]);
  writeJsonl(path.join(proj, "sess-old.jsonl"), [line("sess-old", 45 * DAY, 1, 700, 110)]);
  fs.writeFileSync(path.join(proj, "broken.jsonl"), "{not json\nstill not json\n");
}

function nativeRun(state: string): void {
  writeRunRecord(state, {
    runId: "native-run-1",
    agent: "claude",
    sessionId: "sess-native",
    startedAt: Date.now() - DAY,
    status: "success",
    source: "local",
  });
}

function registrySnapshot(state: string): Record<string, string> {
  const dir = registryDir(state);
  return Object.fromEntries(fs.readdirSync(dir).sort().map((n) => [n, fs.readFileSync(path.join(dir, n), "utf8")]));
}

describe("ach import (#25)", () => {
  const tmps: string[] = [];
  const mk = (p: string) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
    tmps.push(d);
    return d;
  };
  after(() => {
    for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });
  });

  it("imports sessions, is idempotent, skips native and out-of-window sessions, reports corrupt files", async () => {
    const root = mk("ach-import-root-");
    const state = mk("ach-import-state-");
    fixture(root);
    nativeRun(state);
    const scan = scanOptionsForRoot(root);

    const first = await importSessions({ agent: "claude", stateDir: state, scan, days: 30 });
    assert.equal(first.filesScanned, 6);
    assert.deepEqual(first.errors.map((e) => path.basename(e.file)), ["broken.jsonl"]);
    assert.match(first.errors[0]!.error, /corrupt/);
    const outcome = Object.fromEntries(first.sessions.map((s) => [s.sessionId, s.outcome]));
    assert.deepEqual(outcome, {
      "sess-a": "imported",
      "sess-b": "imported",
      "sess-native": "skipped-native",
      "sess-old": "skipped-outside-window",
    });
    assert.equal(first.sessions.find((s) => s.sessionId === "sess-native")!.ownerRunId, "native-run-1");
    assert.equal(first.summary.imported, 2);

    // The subagent file folds into its parent session; totals are the sum.
    const recs = listRunRecords(state);
    const a = recs.find((r) => r.sessionId === "sess-a")!;
    assert.equal(a.runId, importedRunId("claude", "sess-a"));
    assert.equal(a.source, "imported");
    assert.equal(a.cwd, "/work/repo");
    assert.equal(a.status, undefined, "an imported session carries no verdict");
    assert.deepEqual(
      [a.totals!.inputTokens, a.totals!.outputTokens, a.totals!.cacheReadTokens, a.totals!.cacheWriteTokens],
      [340, 140, 60, 15],
    );
    assert.ok(a.totals!.costUsd > 0);
    assert.equal((a.metadata!.transcripts as string[]).length, 2);
    assert.equal(isLive(a), false);
    assert.equal(provenanceOf(a).costUsd, "computed");
    assert.ok(RunRecordSchema.safeParse(JSON.parse(fs.readFileSync(path.join(registryDir(state), `${a.runId}.json`), "utf8"))).success);
    // The native run's session was not duplicated.
    assert.equal(recs.filter((r) => r.sessionId === "sess-native").length, 1);
    assert.equal(recs.length, 3);

    // Second import: identical registry state, every session unchanged.
    const before = registrySnapshot(state);
    const second = await importSessions({ agent: "claude", stateDir: state, scan, days: 30 });
    assert.deepEqual(registrySnapshot(state), before);
    assert.equal(second.summary.sessions, first.summary.sessions);
    assert.equal(second.summary.imported, 0);
    assert.equal(second.summary.unchanged, 2);
    assert.equal(second.summary["skipped-native"], 1);

    // A wider window picks up the old session.
    const wide = await importSessions({ agent: "claude", stateDir: state, scan, days: 60, dryRun: true });
    assert.equal(wide.sessions.find((s) => s.sessionId === "sess-old")!.outcome, "imported");
    assert.deepEqual(registrySnapshot(state), before, "--dry-run writes nothing");
  });

  it("a session that grew since the last import is updated in place", async () => {
    const root = mk("ach-import-grow-");
    const state = mk("ach-import-grow-state-");
    const file = path.join(root, ".claude", "projects", "p", "sess-g.jsonl");
    writeJsonl(file, [line("sess-g", 3_600_000, 1, 10, 5)]);
    const scan = scanOptionsForRoot(root);
    assert.equal((await importSessions({ agent: "claude", stateDir: state, scan })).summary.imported, 1);
    writeJsonl(file, [line("sess-g", 3_600_000, 1, 10, 5), line("sess-g", 60_000, 2, 20, 5)]);
    const res = await importSessions({ agent: "claude", stateDir: state, scan });
    assert.equal(res.summary.updated, 1);
    const recs = listRunRecords(state);
    assert.equal(recs.length, 1);
    assert.equal(recs[0]!.totals!.inputTokens, 30);
  });

  it("probeJsonl: unreadable/all-bad is an error, a partial tail is a warning", () => {
    const d = mk("ach-import-probe-");
    const bad = path.join(d, "bad.jsonl");
    fs.writeFileSync(bad, "nope\n");
    assert.match(probeJsonl(bad).error ?? "", /corrupt/);
    const tail = path.join(d, "tail.jsonl");
    fs.writeFileSync(tail, '{"a":1}\n{"b":');
    assert.deepEqual(probeJsonl(tail), { malformedLines: 1 });
    assert.match(probeJsonl(path.join(d, "missing.jsonl")).error ?? "", /unreadable/);
    assert.deepEqual(probeJsonl(path.join(d, "missing.jsonl")).malformedLines, 0);
  });

  it("rejects agents without an import lane and bad --origin values", async () => {
    await assert.rejects(importSessions({ agent: "codex", stateDir: mk("ach-import-x-") }), (e: unknown) => e instanceof HarnessError && e.code === "UNKNOWN_AGENT");
    assert.equal(parseStatsOrigin(undefined), "all");
    assert.equal(parseStatsOrigin("imported"), "imported");
    assert.throws(() => parseStatsOrigin("ach"), (e: unknown) => e instanceof HarnessError && e.code === "USAGE");
  });

  it("the ccusage hint mentions `ach import` before ccusage", () => {
    const text = ccusageHintText();
    const i = text.indexOf("ach import");
    assert.ok(i >= 0, text);
    assert.ok(i < text.indexOf("ccusage"), text);
  });

  it("CLI: stats totals are identical before and after import; --origin partitions them", () => {
    const root = mk("ach-import-cli-root-");
    const state = mk("ach-import-cli-state-");
    fixture(root);
    nativeRun(state);
    const env = { HOME: mk("ach-import-cli-home-"), AGENTIC_CODING_HARNESS_STATE_DIR: state };
    const statsArgs = ["stats", "--json", "--days", "60", "--transcript-dir", root];

    const pre = runCli(statsArgs, env);
    assert.equal(pre.code, 0, pre.stderr);
    const preJson = JSON.parse(pre.stdout);
    // sess-a (3 messages incl. subagent) + sess-b + sess-native + sess-old.
    assert.equal(preJson.total.records, 6);
    assert.equal(preJson.origins, undefined, "no imported sessions yet: output shape unchanged");

    const imp = runCli(["import", "--agent", "claude", "--days", "30", "--transcript-dir", root, "--state-dir", state], env);
    assert.equal(imp.code, 0, imp.stderr);
    assert.match(imp.stdout, /^error +\S*broken\.jsonl: corrupt/m);
    assert.match(imp.stdout, /skipped +claude session=sess-native \(already recorded by native run native-run-1\)/);
    assert.match(imp.stdout, /skipped +1 claude session\(s\) outside window/);
    assert.match(imp.stdout, /imported=2 updated=0 unchanged=0 skipped-native=1 skipped-outside-window=1 errors=1/);

    const post = runCli(statsArgs, env);
    assert.equal(post.code, 0, post.stderr);
    const postJson = JSON.parse(post.stdout);
    // The double-counting proof: import adds labels, never tokens.
    assert.deepEqual(postJson.total, preJson.total);
    assert.deepEqual(postJson.byAgent, preJson.byAgent);
    assert.deepEqual(postJson.byDay, preJson.byDay);
    assert.deepEqual(postJson.sources, preJson.sources);
    assert.equal(postJson.origin, "all");
    assert.equal(postJson.origins.imported.records, 4);
    assert.equal(postJson.origins.native.records, 1);
    assert.equal(postJson.origins.transcript.records, 1);
    // Imported runs never enter the outcome rollup (no verdict): only the native run.
    assert.equal(postJson.runOutcomes.total.runs, 1);

    // Importing again changes nothing in stats either.
    const again = runCli(["import", "--agent", "claude", "--transcript-dir", root, "--dir", state, "--json"], env);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(JSON.parse(again.stdout).summary.unchanged, 2);
    assert.deepEqual(JSON.parse(runCli(statsArgs, env).stdout).total, postJson.total);

    // --origin filters rows; each slice matches its origins bucket.
    for (const o of ["imported", "native", "transcript"] as const) {
      const r = runCli([...statsArgs, "--origin", o], env);
      assert.equal(r.code, 0, r.stderr);
      const j = JSON.parse(r.stdout);
      assert.equal(j.origin, o);
      assert.equal(j.total.records, postJson.origins[o].records, o);
      assert.equal(j.total.inputTokens, postJson.origins[o].inputTokens, o);
    }
    const onlyImported = JSON.parse(runCli([...statsArgs, "--origin", "imported"], env).stdout);
    assert.ok(onlyImported.runs.every((r: { runId: string }) => r.runId.startsWith("imported-claude-")));
    assert.equal(onlyImported.runs.length, 2);

    const text = runCli(["stats", "--days", "60", "--transcript-dir", root], env);
    assert.match(text.stdout, /^origin: imported +records=4 /m);

    // dash lists each session exactly once: imported rows replace the
    // read-only transcript projection (dash has no --transcript-dir: HOME=root).
    const dash = runCli(["dash", "--json", "--all", "--state-dir", state], { HOME: root, AGENTIC_CODING_HARNESS_STATE_DIR: state });
    assert.equal(dash.code, 0, dash.stderr);
    const rows = JSON.parse(dash.stdout) as { sessionId?: string; source: string; effectiveStatus: string | null }[];
    const bySession = (sid: string) => rows.filter((r) => r.sessionId === sid);
    for (const sid of ["sess-a", "sess-b"]) {
      assert.equal(bySession(sid).length, 1, sid);
      assert.equal(bySession(sid)[0]!.source, "imported");
      assert.equal(bySession(sid)[0]!.effectiveStatus, null);
    }
    assert.deepEqual(bySession("sess-native").map((r) => r.source), ["local"]);
    assert.deepEqual(bySession("sess-old").map((r) => r.source), ["transcript"]);
  });
});
