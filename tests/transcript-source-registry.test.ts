// One registry of machine transcript sources (claude/codex/gemini plus the
// read-only sources in src/monitors/transcript-sources.ts). Every consumer —
// scanAll, `ach watch --dir`, `ach archive`, and the `--agent` validation of
// `ach stats` / `ach archive` — must cover every entry, so a future source
// cannot be missed by one of them. Each assertion iterates the registry.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, isAbsolute } from "node:path";
import { test } from "node:test";
import { archiveTranscripts } from "../src/core/warehouse.ts";
import { TRANSCRIPT_SOURCES } from "../src/monitors/transcript-sources.ts";
import { scanOptionsForRoot, transcriptAgentNames, transcriptSources } from "../src/monitors/transcripts.ts";

const cli = new URL("../src/cli/ach.ts", import.meta.url).pathname;
const loaderArgs = process.versions.bun ? [] : ["--import", import.meta.resolve("tsx")];

// A path (relative to the source's root dir) that the source's keep() accepts.
// A new registry entry without a row here fails loudly below.
const SAMPLE_FILE: Record<string, string> = {
  claude: "proj/session.jsonl",
  codex: "2026/09/28/rollout-x.jsonl",
  gemini: "hash/chats/session.json",
  amp: "thread.json",
  goose: "sessions.db",
  qwen: "proj/chats/session.jsonl",
  cursor: "state.vscdb",
};

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ach-source-registry-"));
  const state = join(home, "state");
  mkdirSync(state);
  const env = { ...process.env, HOME: home, AGENTIC_CODING_HARNESS_STATE_DIR: state };
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [...loaderArgs, cli, ...args], { cwd: home, env, encoding: "utf8", timeout: 15000 });
  return { home, state, run };
}

function isUnder(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

test("registry names are the native three plus every read-only source, without duplicates", () => {
  const names = transcriptAgentNames();
  assert.equal(new Set(names).size, names.length);
  for (const n of ["claude", "codex", "gemini", ...TRANSCRIPT_SOURCES.map((s) => s.agent)]) {
    assert.ok(names.includes(n), `registry missing '${n}'`);
  }
  // scanAll / archive / watch all walk transcriptSources(); it must cover the registry exactly.
  assert.deepEqual([...new Set(transcriptSources().map((s) => s.agent))].sort(), [...names].sort());
});

test("watch --dir root resolution re-roots every registry source under the supplied root", () => {
  const root = mkdtempSync(join(tmpdir(), "ach-source-root-"));
  try {
    const sources = transcriptSources(scanOptionsForRoot(root));
    for (const name of transcriptAgentNames()) {
      const dirs = sources.filter((s) => s.agent === name).map((s) => s.dir);
      assert.ok(dirs.length > 0, `watch --dir resolves no root for '${name}'`);
      for (const d of dirs) assert.ok(isUnder(root, d), `'${name}' root ${d} escapes --dir ${root}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("archive snapshots a transcript from every registry source", async () => {
  const f = fixture();
  try {
    const scan = scanOptionsForRoot(f.home);
    const sources = transcriptSources(scan);
    for (const name of transcriptAgentNames()) {
      const sample = SAMPLE_FILE[name];
      assert.ok(sample, `add a SAMPLE_FILE path for new transcript source '${name}'`);
      const src = sources.find((s) => s.agent === name)!;
      const file = join(src.dir, sample);
      assert.ok(src.keep(file), `SAMPLE_FILE for '${name}' is not accepted by its keep()`);
      mkdirSync(dirname(file), { recursive: true });
      if (/\.(db|vscdb)$/.test(file)) {
        const made = spawnSync("sqlite3", [file, "CREATE TABLE t(x);"], { encoding: "utf8" });
        assert.equal(made.status, 0, made.stderr);
      } else {
        writeFileSync(file, "{}\n");
      }
    }
    const res = await archiveTranscripts({ stateDir: f.state, scan });
    for (const name of transcriptAgentNames()) {
      assert.ok(res.entries.some((e) => e.agent === name && e.kind === "native"), `archive missed '${name}'`);
    }
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("stats and archive --agent accept every registry source and list all of them when rejecting", () => {
  const f = fixture();
  try {
    for (const cmd of ["stats", "archive"]) {
      const bad = f.run(cmd, "--agent", "no-such-agent");
      assert.notEqual(bad.status, 0);
      const listed = /expected one of: ([^)]*)\)/.exec(bad.stderr);
      assert.ok(listed, `${cmd}: ${bad.stderr}`);
      const names = listed[1]!.split(", ");
      assert.equal(new Set(names).size, names.length, `${cmd} lists a name twice: ${listed[1]}`);
      for (const name of transcriptAgentNames()) {
        assert.ok(names.includes(name), `${cmd} --agent error omits '${name}': ${bad.stderr}`);
        const ok = f.run(cmd, "--agent", name, "--json");
        assert.equal(ok.status, 0, `${cmd} --agent ${name}: ${ok.stderr}`);
      }
    }
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});
