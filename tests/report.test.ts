import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, before, describe, test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { esc, renderReport } from "../src/report/html.ts";
import { loadTrials } from "../src/report/model.ts";
import type { LoadedRun } from "../src/report/model.ts";

const CLI = new URL("../src/cli/harness.ts", import.meta.url).pathname;
const FIXTURES = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures", "trials");

function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
  // bun runs .ts natively; node needs the tsx loader.
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  const p = spawnSync(process.execPath, isBun ? [CLI, ...args] : ["--import", "tsx", CLI, ...args], {
    encoding: "utf8",
  });
  return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

/** Minimal LoadedRun for pure-render tests (no disk access). */
function fakeRun(over: Partial<LoadedRun>): LoadedRun {
  return {
    agent: "x",
    trialDir: "/tmp/x",
    trialLabel: "20260910-000000",
    result: {
      sessionId: "s1",
      events: [{ type: "session", timestamp: 1 } as never],
      tokens: [],
      totalCost: 0,
      durationMs: 1000,
      exitStatus: "success",
      warnings: [],
    },
    wallSecs: null,
    hasStderr: false,
    model: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: undefined,
    credits: null,
    task: null,
    ...over,
  };
}

describe("harness report", () => {
  let tmp: string;
  let out: string;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-report-"));
    out = path.join(tmp, "report.html");
  });
  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("scans a trials root into one multi-trial HTML report", async () => {
    const r = runCli(["report", FIXTURES, "--out", out]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /wrote .*report\.html/);
    const html = await fs.readFile(out, "utf8");
    assert.ok(html.length > 1000);
    assert.ok(html.startsWith("<!doctype html>"));
    // self-contained: no external stylesheet/script/font references
    assert.doesNotMatch(html, /<link/i);
    assert.doesNotMatch(html, /src="(?!data:)[^"]*"/i);
    assert.match(html, /<style>/);
    assert.match(html, /<script>/);
  });

  test("contains every agent name and both trial labels", async () => {
    const html = await fs.readFile(out, "utf8");
    for (const a of ["alpha", "kiri", "gamma"]) assert.ok(html.includes(`>${a}<`), a);
    assert.ok(html.includes("20260910-000001"));
    assert.ok(html.includes("20260910-000002"));
  });

  test("escapes <script>/<img> payloads planted in message content", async () => {
    const html = await fs.readFile(out, "utf8");
    assert.ok(html.includes("&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;"));
    assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
    // the payload must never appear live in markup or in an attribute
    assert.ok(!/<script>alert/.test(html));
    assert.ok(!/<img src=x/.test(html));
  });

  test("sortable table JS is embedded and headers are wired", async () => {
    const html = await fs.readFile(out, "utf8");
    assert.match(html, /addEventListener\("click"/);
    assert.match(html, /classList\.add\(asc \? "sorted-asc"/);
    assert.match(html, /data-k="cost"/);
    assert.ok((html.match(/data-k=/g) ?? []).length >= 10);
  });

  test("credits column appears only when some run carries credits", async () => {
    const html = await fs.readFile(out, "utf8");
    assert.match(html, /data-k="credits"/);
    assert.ok(html.includes("25.5") || html.includes("30"), "credits summed somewhere"); // 25.5 + 4.5
    // pure-render control: no credits anywhere → no credits column
    const noCredits = renderReport(
      {
        rootDir: "/tmp",
        labels: ["20260910-000000"],
        runs: [fakeRun({ agent: "solo", costUsd: 0.01 })],
      },
      { version: "0.0.0-test", generatedAt: new Date(0) },
    );
    assert.doesNotMatch(noCredits, /data-k="credits"/);
    assert.ok(!noCredits.includes(">credits<"), "no credits header");
  });

  test("undefined cost renders as n/a, defined cost renders with $", async () => {
    const html = await fs.readFile(out, "utf8");
    // gamma + kiri have no defined costUsd (kiri: tokens without costUsd but
    // totalCost 0 counts as defined $0; gamma has none at all)
    assert.match(html, /class="num na">n\/a</);
    assert.ok(html.includes("$0.0123"), "alpha provider cost");
    assert.ok(html.includes("$0.0000"), "kiri zero totalCost");
  });

  test("charts render inline SVG and skip zero-token agents gracefully", async () => {
    const html = await fs.readFile(out, "utf8");
    assert.ok((html.match(/<svg/g) ?? []).length >= 2);
    assert.match(html, /aria-label="tokens by class per agent"/);
    assert.match(html, /aria-label="cost in USD per agent"/);
    // gamma (no tokens) must not appear as a token bar group label in the SVG
    const tokenChart = html.slice(html.indexOf('aria-label="tokens by class per agent"'));
    assert.ok(!tokenChart.slice(0, 4000).includes(">gamma</text>"));
  });

  test("error run shows error badge and final message cap adds show-more", async () => {
    const html = await fs.readFile(out, "utf8");
    assert.match(html, /class="badge st-error">error</);
    assert.match(html, /show-more/);
    assert.match(html, /data-label-less="show less"/);
  });

  test("footer carries generator version and timestamp", async () => {
    const html = await fs.readFile(out, "utf8");
    assert.match(html, /generated by agent-harness [\d.]+ · \d{4}-\d{2}-\d{2}T/);
  });

  test("single trial dir also reports (no subdir scan) and default --out lands beside it", async () => {
    const one = path.join(tmp, "copy-of-trial");
    await fs.cp(path.join(FIXTURES, "20260910-000002"), one, { recursive: true });
    const r = runCli(["report", one]);
    assert.equal(r.code, 0, r.stderr);
    const written = path.join(one, "report.html");
    const html = await fs.readFile(written, "utf8");
    assert.ok(html.includes(">gamma<"));
    assert.doesNotMatch(html, /data-k="credits"/); // gamma alone: no credits column
  });

  test("missing dir fails cleanly", () => {
    const r = runCli(["report", path.join(tmp, "nope")]);
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes("harness:"), r.stderr);
    assert.doesNotMatch(r.stderr, /\n\s+at /);
  });

  test("no positionals fails cleanly", () => {
    const r = runCli(["report"]);
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes("trials directory"), r.stderr);
  });

  test("loadTrials pairs .secs and detects .stderr; model skips 'unknown'", async () => {
    const set = await loadTrials(FIXTURES);
    assert.equal(set.runs.length, 3);
    const alpha = set.runs.find((r) => r.agent === "alpha");
    assert.ok(alpha);
    assert.equal(alpha.wallSecs, 9);
    assert.equal(alpha.hasStderr, true);
    assert.equal(alpha.model, "test-model-1");
    assert.equal(alpha.task, "List the files and summarize");
    const kiri = set.runs.find((r) => r.agent === "kiri");
    assert.ok(kiri);
    assert.equal(kiri.credits, 30); // 25.5 + 4.5 summed
    assert.equal(kiri.inputTokens, 100);
    const gamma = set.runs.find((r) => r.agent === "gamma");
    assert.ok(gamma);
    assert.equal(gamma.costUsd, undefined);
    assert.equal(gamma.wallSecs, null);
    assert.equal(gamma.hasStderr, false);
  });

  test("esc() neutralizes attribute-breaking quotes", () => {
    assert.equal(esc(`<a href="x" class='y'>&amp;`), "&lt;a href=&quot;x&quot; class=&#39;y&#39;&gt;&amp;amp;");
  });
});
