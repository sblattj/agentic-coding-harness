// `--isolate` from several processes at once in one repo. `git worktree add`
// enumerates every sibling entry under .git/worktrees/, so an unserialized add
// can read another add's half-written entry and die with
// "fatal: failed to read .git/worktrees/<id>/commondir". Removal (`worktree
// remove`, `prune`) enumerates the same entries. Each call here is its own
// process because prepareIsolation runs git synchronously.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const ISOLATE = new URL("../src/core/isolate.ts", import.meta.url).href;
const LOADER = import.meta.resolve("tsx");

/** prepareIsolation (+ finishIsolation when cleanup) once all processes reach `startAt`. Prints OK or FAIL <reason>. */
const WORKER = `
const [repo, stateDir, runId, startAt, cleanup] = process.argv.slice(1);
const { prepareIsolation, finishIsolation } = await import(${JSON.stringify(ISOLATE)});
while (Date.now() < Number(startAt)) {}
try {
  const ws = prepareIsolation(runId, repo, { stateDir, cleanup: cleanup === "1" });
  if (cleanup === "1") {
    const info = finishIsolation(ws);
    if (info.cleanup.status !== "removed") throw new Error("cleanup " + info.cleanup.status + ": " + info.cleanup.error);
  }
  process.stdout.write("OK");
} catch (e) {
  process.stdout.write("FAIL " + String(e && e.message));
}
`;

let root: string;
before(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ach-isolate-conc-")));
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

function freshRepo(): { repo: string; state: string } {
  const base = fs.mkdtempSync(path.join(root, "r-"));
  const repo = path.join(base, "repo");
  fs.mkdirSync(repo);
  const g = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "pipe" });
  g("init", "-q");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  g("add", ".");
  g("-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-qm", "init");
  return { repo, state: path.join(base, "state") };
}

function runOne(repo: string, state: string, runId: string, startAt: number, cleanup: boolean): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["--import", LOADER, "--input-type=module", "-e", WORKER, repo, state, runId, String(startAt), cleanup ? "1" : "0"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", () => resolve(`${runId}: ${out.trim()}`));
  });
}

async function round(k: number, cleanup: boolean): Promise<{ repo: string; ids: string[]; failed: string[] }> {
  const { repo, state } = freshRepo();
  const ids = Array.from({ length: k }, () => randomUUID());
  // Leave every process time to load the module, then start them all on the same tick.
  const startAt = Date.now() + 3000;
  const outs = await Promise.all(ids.map((id) => runOne(repo, state, id, startAt, cleanup)));
  return { repo, ids, failed: outs.filter((o) => !o.endsWith(": OK")) };
}

describe("--isolate with concurrent processes in one repo", () => {
  it("every concurrent prepareIsolation gets its own worktree", async () => {
    for (let r = 0; r < 3; r++) {
      const { repo, ids, failed } = await round(12, false);
      assert.deepEqual(failed, [], `round ${r}`);
      const branches = execFileSync("git", ["branch", "--list", "ach/*"], { cwd: repo, encoding: "utf8" });
      for (const id of ids) assert.ok(branches.includes(`ach/${id}`), `branch for ${id}`);
    }
  });

  it("concurrent prepare + cleanup runs all remove their worktrees", async () => {
    for (let r = 0; r < 2; r++) {
      const { repo, failed } = await round(12, true);
      assert.deepEqual(failed, [], `round ${r}`);
      const list = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" });
      assert.equal(list.includes("ach/"), false, list);
    }
  });
});
