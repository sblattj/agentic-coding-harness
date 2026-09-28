// `ach report` outcome + repeat statistics (#29, #30): RunResult JSONs that
// carry a `verify` verdict (what `ach run --verify --json` writes) gain a
// verify column and a repeat-statistics table grouped like the comparison
// table (by variant when any run has one, else by agent). Trials without
// verdicts render exactly as before.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { renderReport } from "../src/report/html.ts";
import { loadTrials } from "../src/report/model.ts";

function resultJson(over: Record<string, unknown>): string {
  return JSON.stringify({
    runId: "r",
    sessionId: "s",
    events: [{ type: "session", timestamp: 1 }],
    tokens: [],
    totalCost: 0.001,
    durationMs: 1000,
    exitStatus: "success",
    warnings: [],
    ...over,
  });
}

const verdict = (status: string) => ({
  command: "npm test",
  exitCode: status === "pass" ? 0 : 1,
  status,
  durationMs: 5,
  timedOut: false,
});

let root: string;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ach-report-rep-"));
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function trial(dir: string, label: string, name: string, over: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.join(dir, label), { recursive: true });
  await fs.writeFile(path.join(dir, label, `${name}.json`), resultJson(over));
}

const opts = { version: "test", generatedAt: new Date(0) };

describe("report repeat statistics", () => {
  it("3 verified claude repeats (one flaky) + 1 verified codex → verify column and stats table", async () => {
    const dir = path.join(root, "scored");
    await trial(dir, "t1", "claude", { verify: verdict("pass") });
    await trial(dir, "t2", "claude", { verify: verdict("fail") });
    await trial(dir, "t3", "claude", { verify: verdict("pass") });
    await trial(dir, "t1", "codex", { verify: verdict("pass") });
    const set = await loadTrials(dir);
    assert.equal(set.runs.filter((r) => r.verify !== undefined).length, 4);
    const html = renderReport(set, opts);
    assert.ok(html.includes('<th data-k="verify" data-t="s">verify</th>'));
    assert.ok(html.includes('id="repeat-stats"'));
    // claude: k=3, 2 passes → pass@1 66.7%, Wilson [20.8%, 93.9%], pass^3 0.0%, any-pass@3 100.0%
    assert.match(html, /<td[^>]*>claude<\/td><td[^>]*>3<\/td><td[^>]*>2<\/td><td[^>]*>66\.7%<\/td><td[^>]*>20\.8% – 93\.9%<\/td><td[^>]*>0\.0%<\/td><td[^>]*>100\.0%<\/td>/);
    // codex: k=1 → no CI, no k-draw columns (n/a), never a degenerate interval
    assert.match(html, /<td[^>]*>codex<\/td><td[^>]*>1<\/td><td[^>]*>1<\/td><td[^>]*>100\.0%<\/td><td[^>]*>n\/a<\/td>/);
  });

  it("a run without a verdict renders n/a in the verify column, not fail", async () => {
    const dir = path.join(root, "mixed");
    await trial(dir, "t1", "claude", { verify: verdict("pass") });
    await trial(dir, "t1", "codex", {});
    const html = renderReport(await loadTrials(dir), opts);
    assert.match(html, /data-agent="codex"[^\n]*<td data-v="" class="na">n\/a<\/td><\/tr>/);
  });

  it("loads an `ach run --repeat N --json` envelope as N runs", async () => {
    const dir = path.join(root, "envelope");
    await fs.mkdir(path.join(dir, "t1"), { recursive: true });
    const child = (i: number, status: string) =>
      JSON.parse(resultJson({ runId: `r${i}`, repeat: { group: "g", index: i, count: 3 }, verify: verdict(status) }));
    await fs.writeFile(
      path.join(dir, "t1", "claude.json"),
      JSON.stringify({
        repeat: { group: "g", count: 3, attempted: 3, succeeded: 3 },
        runs: [child(0, "pass"), child(1, "fail"), child(2, "pass"), { repeat: { group: "g", index: 3 }, error: "launch failed" }],
      }),
    );
    const set = await loadTrials(dir);
    assert.equal(set.runs.length, 3);
    const html = renderReport(set, opts);
    assert.match(html, /<td[^>]*>claude<\/td><td[^>]*>3<\/td><td[^>]*>2<\/td><td[^>]*>66\.7%<\/td>/);
  });

  it("trials without any verdict render no verify column and no stats section", async () => {
    const dir = path.join(root, "plain");
    await trial(dir, "t1", "claude", {});
    const html = renderReport(await loadTrials(dir), opts);
    assert.equal(html.includes('data-k="verify"'), false);
    assert.equal(html.includes('id="repeat-stats"'), false);
  });
});
