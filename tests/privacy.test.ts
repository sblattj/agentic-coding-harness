// #46: privacy modes (--privacy off|redact|anon) for shared reports and exports.
//
// The fixture plants home-rooted paths (cwd, rawTranscript, worktree and
// hermetic dirs, tool args), sentinel prompt text and run/session ids; each
// acceptance criterion scans the real CLI output for them.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { maskForExport, MASK_ENV, resolveMaskPolicy } from "../src/core/masking.ts";
import {
  anonId,
  applyPrivacy,
  DEFAULT_PRIVACY_MODE,
  PRIVACY_ENV,
  PROMPT_PLACEHOLDER,
} from "../src/core/privacy.ts";
import { AtifWriter } from "../src/emitters/atif.ts";
import { toOtlpJson } from "../src/emitters/otel.ts";
import { eventsToMessages, turnSamples, withPrompt } from "../src/emitters/sft.ts";
import { readVersion, renderReport } from "../src/report/html.ts";
import { loadReportModel } from "../src/cli/report.ts";
import { registerInspectTools } from "../src/mcp/tools-inspect.ts";
import type { McpServer, McpToolDef } from "../src/mcp/contract.ts";
import type { AgentEvent } from "../src/core/types.ts";

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;

// ---------------------------------------------------------------- fixture

const RUN_ID = "run-7f3a9c21d4e8";
const SESSION_ID = "sess-5b2e8d41-aa90-4c7e-9f13-0d6c2b7e1a44";
const PROMPT = "SENTINELPROMPT refactor the parser module";
const SYSTEM = "SENTINELSYSTEM you are a careful engineer";
const USER2 = "SENTINELUSERTWO also add tests";
const SENTINELS = ["SENTINELPROMPT", "SENTINELSYSTEM", "SENTINELUSERTWO"];
const OTHER_HOME = "/home/otherperson";
const T0 = 1790000000000;

let tmp: string;
let home: string;
let stateDir: string;
let runFile: string;
let trial: string;

function plantedRun(): Record<string, unknown> {
  const repo = path.join(home, "dev", "widget-repo");
  return {
    runId: RUN_ID,
    sessionId: SESSION_ID,
    agent: "claude",
    prompt: PROMPT,
    exitStatus: "success",
    totalCost: 0.4321,
    durationMs: 65432,
    warnings: [`transcript kept at ${path.join(home, ".ach", "raw", `claude-${SESSION_ID}.jsonl`)}`],
    cwd: repo,
    rawTranscript: path.join(home, ".ach", "raw", `claude-${SESSION_ID}.jsonl`),
    worktree: { path: path.join(home, ".wt", "widget-repo", "feat"), branch: "feat", baseSha: "abc1234", cleanup: { status: "kept" } },
    hermetic: { tempDir: path.join(home, "tmp", "herm-1"), source: repo, synced: { copied: 3, deleted: 0 } },
    ancestorInstructions: [path.join(home, "dev", "AGENTS.md")],
    kiro: { cliVersion: "1.0.0", transport: "acp", nativeSessionId: "native-9c4d2e7f1b", modelAck: "acknowledged", configHash: "cfg" },
    usage: { complete: false, coverage: "parent-only", childSessionIds: ["child-3e8a1f"], missingChildSessionIds: ["child-77b2c0"] },
    tokens: [
      { agent: "claude", model: "claude-sonnet", inputTokens: 1200, outputTokens: 340, cacheReadTokens: 900, cacheWriteTokens: 60, reasoningTokens: 12, costUsd: 0.4321 },
    ],
    events: [
      { type: "session", sessionId: SESSION_ID, cwd: repo, timestamp: T0 },
      { type: "message", source: "system", content: SYSTEM, timestamp: T0 + 10 },
      { type: "message", source: "user", content: `${PROMPT} in ${repo}/src/parse.ts`, timestamp: T0 + 20 },
      { type: "tool_call", toolCallId: "call_1", functionName: "bash", arguments: { cmd: `cat ${repo}/src/parse.ts`, other: `${OTHER_HOME}/notes.txt` }, timestamp: T0 + 30 },
      { type: "tool_result", toolCallId: "call_1", content: `read ${repo}/src/parse.ts`, timestamp: T0 + 40 },
      { type: "usage", usage: { agent: "claude", model: "claude-sonnet", inputTokens: 1200, outputTokens: 340, cacheReadTokens: 900, cacheWriteTokens: 60, reasoningTokens: 12, costUsd: 0.4321 }, timestamp: T0 + 50 },
      { type: "message", source: "user", content: USER2, timestamp: T0 + 60 },
      { type: "message", source: "assistant", content: "done, tests pass", timestamp: T0 + 65432 },
    ],
  };
}

function childEnv(env: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const e: Record<string, string | undefined> = { ...process.env, AGENTIC_CODING_HARNESS_STATE_DIR: stateDir, HOME: home };
  delete e[MASK_ENV];
  delete e[PRIVACY_ENV];
  delete e.AGENTIC_CODING_HARNESS_CONFIG;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete e[k];
    else e[k] = v;
  }
  return e as NodeJS.ProcessEnv;
}

function cli(args: string[], env: Record<string, string | undefined> = {}) {
  const p = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], { encoding: "utf8", env: childEnv(env) });
  return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

function cliAsync(args: string[], env: Record<string, string | undefined> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ["--import", "tsx", CLI, ...args], { env: childEnv(env) });
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** Every `$HOME`-rooted absolute path, plus any other user's home dir, in `text`. */
function homePaths(text: string): string[] {
  const hits: string[] = [];
  let at = text.indexOf(home);
  while (at >= 0) {
    hits.push(text.slice(at, at + home.length + 30));
    at = text.indexOf(home, at + 1);
  }
  for (const m of text.matchAll(/(?:\/Users\/|\/home\/)(?!Shared\b)[A-Za-z0-9._-]+/g)) hits.push(m[0]);
  return hits;
}

const sentinelHits = (text: string) => SENTINELS.filter((s) => text.includes(s));

/** Strip the per-call random ids so two renders of the same input compare. */
const stableIds = (s: string) => s.replace(/"(traceId|spanId|parentSpanId|trajectory_id)": "[^"]*"/g, '"$1": "X"');

/** The HTML footer carries the render time; nothing else in the page varies. */
const stableHtml = (s: string) => s.replace(/(<footer>generated by agentic-coding-harness [^·]*· )[^<]*/, "$1T");

before(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ach-privacy-")));
  home = path.join(tmp, "home", "devuser");
  stateDir = path.join(tmp, "state");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  runFile = path.join(home, "runs", "run.json");
  await fs.mkdir(path.dirname(runFile), { recursive: true });
  await fs.writeFile(runFile, JSON.stringify(plantedRun()));
  // The trials dir lives under $HOME too, so rootDir / trialDir are home-rooted.
  trial = path.join(home, "trials", "20260910-091011");
  await fs.mkdir(trial, { recursive: true });
  await fs.writeFile(path.join(trial, "claude.json"), JSON.stringify(plantedRun()));
  await fs.writeFile(path.join(trial, "claude.secs"), "65.4");
});
after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------- unit

describe("privacy: the transform", () => {
  test("off is the default and returns the same reference", () => {
    assert.equal(DEFAULT_PRIVACY_MODE, "off");
    const v = plantedRun();
    assert.equal(applyPrivacy(v), v);
    assert.equal(applyPrivacy(v, { mode: "off", home }), v);
    const gate = maskForExport(v, resolveMaskPolicy({ sink: "atif", env: {} }));
    assert.equal(gate.value, v);
    assert.equal(gate.privacy, "off");
  });

  test("redact: path keys become basenames, $HOME collapses to ~, other homes are masked, numbers stay", () => {
    const r = applyPrivacy(plantedRun(), { mode: "redact", home }, (s) => s.replace(/\/home\/[^/]+/g, "[REDACTED_HOME]")) as Record<string, unknown>;
    assert.equal(r.cwd, "widget-repo");
    assert.equal(r.rawTranscript, `claude-${SESSION_ID}.jsonl`);
    assert.deepEqual(r.ancestorInstructions, ["~/dev/AGENTS.md"]);
    assert.equal((r.worktree as { path: string }).path, "~/.wt/widget-repo/feat");
    assert.equal((r.hermetic as { tempDir: string }).tempDir, "herm-1");
    const ev = r.events as Record<string, unknown>[];
    assert.deepEqual((ev[3] as { arguments: unknown }).arguments, { cmd: "cat ~/dev/widget-repo/src/parse.ts", other: "[REDACTED_HOME]/notes.txt" });
    assert.equal(r.prompt, PROMPT, "redact keeps prompt text");
    assert.equal(r.sessionId, SESSION_ID, "redact keeps ids");
    assert.equal(r.durationMs, 65432);
    assert.deepEqual(r.tokens, plantedRun().tokens);
    assert.deepEqual(homePaths(JSON.stringify(r)), []);
  });

  test("anon: prompts and user/system messages dropped, ids hashed everywhere, repo name hashed, array shapes kept", () => {
    const src = plantedRun();
    const r = applyPrivacy(src, { mode: "anon", home }) as Record<string, unknown>;
    const text = JSON.stringify(r);
    assert.deepEqual(sentinelHits(text), []);
    assert.equal(r.prompt, PROMPT_PLACEHOLDER);
    assert.equal(r.runId, anonId(RUN_ID));
    assert.equal(r.sessionId, anonId(SESSION_ID));
    assert.ok(!text.includes(SESSION_ID) && !text.includes(RUN_ID), "no raw id survives, even inside file names");
    assert.equal(r.rawTranscript, `claude-${anonId(SESSION_ID)}.jsonl`);
    assert.equal(r.cwd, anonId("widget-repo"));
    assert.equal((r.kiro as { nativeSessionId: string }).nativeSessionId, anonId("native-9c4d2e7f1b"));
    assert.deepEqual((r.usage as { childSessionIds: string[] }).childSessionIds, [anonId("child-3e8a1f")]);
    assert.deepEqual((r.usage as { missingChildSessionIds: string[] }).missingChildSessionIds, [anonId("child-77b2c0")]);
    for (const raw of ["native-9c4d2e7f1b", "child-3e8a1f", "child-77b2c0"]) assert.ok(!text.includes(raw), raw);
    const ev = r.events as Record<string, unknown>[];
    assert.equal(ev.length, (src.events as unknown[]).length);
    assert.equal(ev[1]!.content, PROMPT_PLACEHOLDER);
    assert.equal(ev[2]!.content, PROMPT_PLACEHOLDER);
    assert.equal(ev[7]!.content, "done, tests pass", "assistant text is kept");
    assert.equal(ev[0]!.sessionId, anonId(SESSION_ID));
    assert.deepEqual(r.tokens, src.tokens);
    // SFT chat messages ({role, content}) are covered too.
    const sft = applyPrivacy({ messages: [{ role: "system", content: SYSTEM }, { role: "user", content: PROMPT }, { role: "assistant", content: "ok" }] }, { mode: "anon" });
    assert.deepEqual(sft.messages.map((m) => m.content), [PROMPT_PLACEHOLDER, PROMPT_PLACEHOLDER, "ok"]);
  });

  test("anonId is a stable unsalted short hash and idempotent", () => {
    assert.match(anonId(SESSION_ID), /^anon-[0-9a-f]{12}$/);
    assert.equal(anonId(SESSION_ID), anonId(SESSION_ID));
    assert.notEqual(anonId(SESSION_ID), anonId(RUN_ID));
    assert.equal(anonId(anonId(SESSION_ID)), anonId(SESSION_ID));
    // Pinned: sha256("sess-1") starts abe633f3a47a, so the hash is the same on every machine.
    assert.equal(anonId("sess-1"), "anon-abe633f3a47a");
  });

  test("precedence: --privacy > env > config mask.privacy > off; bad values are rejected", () => {
    const p = (flags: { privacy?: string }, env: Record<string, string>, config?: { privacy?: "off" | "redact" | "anon" }) =>
      resolveMaskPolicy({ sink: "report", flags, env, ...(config ? { config } : {}) }).privacy?.mode ?? "off";
    assert.equal(p({}, {}), "off");
    assert.equal(p({}, {}, { privacy: "redact" }), "redact");
    assert.equal(p({}, { [PRIVACY_ENV]: "anon" }, { privacy: "redact" }), "anon");
    assert.equal(p({ privacy: "off" }, { [PRIVACY_ENV]: "anon" }, { privacy: "redact" }), "off");
    assert.throws(() => p({ privacy: "hide" }, {}), /--privacy expects one of off\|redact\|anon/);
    assert.throws(() => p({}, { [PRIVACY_ENV]: "x" }), new RegExp(`${PRIVACY_ENV} expects one of`));
  });
});

// ---------------------------------------------------------------- acceptance 1: redact leaves no $HOME path

describe("ach report --privacy redact: no $HOME-rooted absolute path in the HTML or --json", () => {
  test("HTML and --json scanned; control: today's output carries them", async () => {
    const plainJson = cli(["report", trial, "--json"]);
    assert.equal(plainJson.code, 0, plainJson.stderr);
    assert.ok(homePaths(plainJson.stdout).length > 5, "control: the unsanitized --json carries home paths");
    const plainHtml = path.join(tmp, "plain.html");
    assert.equal(cli(["report", trial, "--out", plainHtml]).code, 0);
    assert.ok(homePaths(await fs.readFile(plainHtml, "utf8")).length > 0, "control: the unsanitized HTML carries a home path");

    const html = path.join(tmp, "redact.html");
    const r = cli(["report", trial, "--out", html, "--privacy", "redact"]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(homePaths(await fs.readFile(html, "utf8")), []);
    const j = cli(["report", trial, "--json", "--privacy", "redact"]);
    assert.equal(j.code, 0, j.stderr);
    assert.deepEqual(homePaths(j.stdout), []);
    const doc = JSON.parse(j.stdout);
    assert.equal(doc.rootDir, "20260910-091011");
    assert.equal(doc.runs[0].trialDir, "20260910-091011");
    assert.equal(doc.runs[0].result.cwd, "widget-repo");
    assert.equal(doc.runs[0].result.rawTranscript, `claude-${SESSION_ID}.jsonl`);
    // --json --out writes the same document to a file.
    const jf = path.join(tmp, "redact.json");
    const w = cli(["report", trial, "--json", "--out", jf, "--privacy", "redact"]);
    assert.equal(w.code, 0, w.stderr);
    assert.match(w.stdout, /^wrote /);
    assert.deepEqual(homePaths(await fs.readFile(jf, "utf8")), []);
  });
});

// ---------------------------------------------------------------- acceptance 2: anon drops prompts, ids stable

describe("--privacy anon: no prompt text in HTML/ATIF/OTel/Langfuse; ids are stable hashes", () => {
  test("report HTML and --json", async () => {
    const html = path.join(tmp, "anon.html");
    assert.ok(sentinelHits(await fs.readFile((cli(["report", trial, "--out", path.join(tmp, "c.html")]), path.join(tmp, "c.html")), "utf8")).length > 0, "control");
    const r = cli(["report", trial, "--out", html, "--privacy", "anon"]);
    assert.equal(r.code, 0, r.stderr);
    const page = await fs.readFile(html, "utf8");
    assert.deepEqual(sentinelHits(page), []);
    assert.deepEqual(homePaths(page), []);
    assert.ok(!page.includes(SESSION_ID));
    assert.ok(page.includes(anonId(SESSION_ID)));
    const j = cli(["report", trial, "--json", "--privacy", "anon"]);
    assert.equal(j.code, 0, j.stderr);
    assert.deepEqual(sentinelHits(j.stdout), []);
    assert.ok(!j.stdout.includes(SESSION_ID) && !j.stdout.includes(RUN_ID));
  });

  test("ATIF (stdout and --out), OTel, SFT", async () => {
    const control = cli(["emit", "--input", runFile, "--format", "atif"]);
    assert.ok(sentinelHits(control.stdout).length === 3, "control: today's ATIF carries all three prompts");
    const atif = cli(["emit", "--input", runFile, "--format", "atif", "--privacy", "anon"]);
    assert.equal(atif.code, 0, atif.stderr);
    assert.deepEqual(sentinelHits(atif.stdout), []);
    assert.equal(JSON.parse(atif.stdout).session_id, anonId(SESSION_ID));
    const out = path.join(tmp, "anon.atif.json");
    const f = cli(["emit", "--input", runFile, "--format", "atif", "--privacy", "anon", "--out", out]);
    assert.equal(f.code, 0, f.stderr);
    assert.deepEqual(sentinelHits(await fs.readFile(out, "utf8")), []);
    const otel = cli(["emit", "--input", runFile, "--format", "otel", "--privacy", "anon"]);
    assert.equal(otel.code, 0, otel.stderr);
    assert.deepEqual(sentinelHits(otel.stdout), []);
    assert.ok(!otel.stdout.includes(SESSION_ID));
    assert.ok(otel.stdout.includes(anonId(SESSION_ID)));
    const sft = cli(["emit", "--input", runFile, "--format", "sft", "--privacy", "anon"]);
    assert.equal(sft.code, 0, sft.stderr);
    assert.ok(sft.stdout.length > 0);
    assert.deepEqual(sentinelHits(sft.stdout), []);
  });

  test("Langfuse: the POSTed body carries no prompt and no raw session id", async () => {
    const bodies: string[] = [];
    const server = http.createServer((req, res) => {
      let b = "";
      req.on("data", (d) => (b += d));
      req.on("end", () => {
        bodies.push(b);
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as { port: number }).port;
      const lf = ["--langfuse-url", `http://127.0.0.1:${port}`, "--langfuse-public-key", "pk-test", "--langfuse-secret-key", "sk-test"];
      const plain = await cliAsync(["emit", "--input", runFile, "--format", "langfuse", ...lf]);
      assert.equal(plain.code, 0, plain.stderr);
      assert.ok(bodies[0]!.includes(SESSION_ID), "control: today's POST carries the session id");
      const anon = await cliAsync(["emit", "--input", runFile, "--format", "langfuse", "--privacy", "anon", ...lf]);
      assert.equal(anon.code, 0, anon.stderr);
      assert.equal(bodies.length, 2);
      assert.deepEqual(sentinelHits(bodies[1]!), []);
      assert.ok(!bodies[1]!.includes(SESSION_ID));
      assert.ok(bodies[1]!.includes(anonId(SESSION_ID)));
      assert.match(anon.stdout, /, privacy anon\n$/);
      const resAttrs = (body: string) => JSON.parse(body).resourceSpans[0].resource.attributes as { key: string; value: { stringValue: string } }[];
      assert.equal(resAttrs(bodies[1]!).find((a) => a.key === "ach.privacy")?.value.stringValue, "anon", "the POSTed body is stamped");
      assert.equal(resAttrs(bodies[0]!).find((a) => a.key === "ach.privacy"), undefined, "off posts no stamp");
      // Numbers: usage_details and cost_details are the same with and without privacy.
      const attrs = (b: string) =>
        (JSON.parse(b).resourceSpans[0].scopeSpans[0].spans as { attributes: { key: string; value: unknown }[] }[])
          .flatMap((s) => s.attributes.filter((a) => a.key.includes("usage") || a.key.includes("cost") || a.key.includes("tokens")));
      assert.deepEqual(attrs(bodies[1]!), attrs(bodies[0]!));
      assert.ok(attrs(bodies[0]!).length > 0);
    } finally {
      server.close();
    }
  });

  test("ids are the same hash across two runs, and across two copies of the input", async () => {
    const copy = path.join(tmp, "copy-of-run.json");
    await fs.copyFile(runFile, copy);
    const ids = (input: string) => {
      const a = JSON.parse(cli(["emit", "--input", input, "--format", "atif", "--privacy", "anon"]).stdout);
      const o = JSON.parse(cli(["emit", "--input", input, "--format", "otel", "--privacy", "anon"]).stdout);
      const conv = o.resourceSpans[0].scopeSpans[0].spans[0].attributes.find((x: { key: string }) => x.key === "gen_ai.conversation.id").value.stringValue;
      return { atif: a.session_id, otel: conv };
    };
    const first = ids(runFile);
    const second = ids(runFile);
    const third = ids(copy);
    assert.deepEqual(first, second);
    assert.deepEqual(first, third);
    assert.deepEqual(first, { atif: anonId(SESSION_ID), otel: anonId(SESSION_ID) });
    const r1 = JSON.parse(cli(["report", trial, "--json", "--privacy", "anon"]).stdout).runs[0].result;
    const r2 = JSON.parse(cli(["report", trial, "--json", "--privacy", "anon"]).stdout).runs[0].result;
    assert.equal(r1.runId, anonId(RUN_ID));
    assert.equal(r1.sessionId, anonId(SESSION_ID));
    assert.deepEqual([r1.runId, r1.sessionId], [r2.runId, r2.sessionId]);
  });
});

// ---------------------------------------------------------------- acceptance 3: numbers identical

describe("numbers (tokens, cost, duration) are identical with and without --privacy", () => {
  test("report --json, ATIF metrics, OTel usage attributes and span times", () => {
    const pick = (doc: { runs: Record<string, unknown>[] }) =>
      doc.runs.map((r) => {
        const res = r.result as Record<string, unknown>;
        return {
          inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens,
          cacheWriteTokens: r.cacheWriteTokens, reasoningTokens: r.reasoningTokens, costUsd: r.costUsd,
          credits: r.credits, wallSecs: r.wallSecs, durationMs: res.durationMs, totalCost: res.totalCost, tokens: res.tokens,
          usage: (res.events as Record<string, unknown>[]).filter((e) => e.type === "usage").map((e) => e.usage),
          times: (res.events as Record<string, unknown>[]).map((e) => e.timestamp),
        };
      });
    const base = pick(JSON.parse(cli(["report", trial, "--json"]).stdout));
    assert.equal(base[0]!.inputTokens, 1200);
    assert.equal(base[0]!.costUsd, 0.4321);
    assert.equal(base[0]!.durationMs, 65432);
    for (const mode of ["off", "redact", "anon"]) {
      const r = cli(["report", trial, "--json", "--privacy", mode]);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(pick(JSON.parse(r.stdout)), base, `report --json --privacy ${mode}`);
    }

    const atifNums = (s: string) => {
      const d = JSON.parse(s);
      return { final: d.final_metrics, steps: d.steps.map((x: { metrics: unknown; timestamp: string }) => [x.metrics, x.timestamp]) };
    };
    const atif0 = atifNums(cli(["emit", "--input", runFile, "--format", "atif"]).stdout);
    assert.equal(atif0.final.total_cost_usd, 0.4321);
    const otelNums = (s: string) =>
      (JSON.parse(s).resourceSpans[0].scopeSpans[0].spans as { startTimeUnixNano: string; endTimeUnixNano: string; attributes: { key: string; value: unknown }[] }[]).map((sp) => ({
        start: sp.startTimeUnixNano,
        end: sp.endTimeUnixNano,
        usage: sp.attributes.filter((a) => a.key.startsWith("gen_ai.usage.") || a.key.includes("cost")),
      }));
    const otel0 = otelNums(cli(["emit", "--input", runFile, "--format", "otel"]).stdout);
    assert.ok(otel0.some((s) => s.usage.length > 0));
    for (const mode of ["redact", "anon"]) {
      assert.deepEqual(atifNums(cli(["emit", "--input", runFile, "--format", "atif", "--privacy", mode]).stdout), atif0, `atif ${mode}`);
      assert.deepEqual(otelNums(cli(["emit", "--input", runFile, "--format", "otel", "--privacy", mode]).stdout), otel0, `otel ${mode}`);
    }
  });
});

// ---------------------------------------------------------------- acceptance 4: the mode is stamped

describe("every output stamps the active privacy mode", () => {
  test("report --json field, HTML meta + visible line, ATIF extra.privacy, OTel resource ach.privacy, SFT summary", async () => {
    for (const mode of ["redact", "anon"] as const) {
      assert.equal(JSON.parse(cli(["report", trial, "--json", "--privacy", mode]).stdout).privacy, mode);
      const html = path.join(tmp, `stamp-${mode}.html`);
      const r = cli(["report", trial, "--out", html, "--privacy", mode]);
      assert.match(r.stderr, new RegExp(`privacy ${mode}: `));
      const page = await fs.readFile(html, "utf8");
      assert.ok(page.includes(`<meta name="ach-privacy" content="${mode}">`));
      assert.match(page, new RegExp(`<p class="meta privacy" data-privacy="${mode}">privacy ${mode}: `));

      assert.equal(JSON.parse(cli(["emit", "--input", runFile, "--format", "atif", "--privacy", mode]).stdout).extra.privacy, mode);
      const out = path.join(tmp, `stamp-${mode}.atif.json`);
      assert.equal(cli(["emit", "--input", runFile, "--format", "atif", "--privacy", mode, "--out", out]).code, 0);
      assert.equal(JSON.parse(await fs.readFile(out, "utf8")).extra.privacy, mode);

      const otel = JSON.parse(cli(["emit", "--input", runFile, "--format", "otel", "--privacy", mode]).stdout);
      assert.deepEqual(otel.resourceSpans[0].resource.attributes[1], { key: "ach.privacy", value: { stringValue: mode } });

      const sft = cli(["emit", "--input", runFile, "--format", "sft", "--privacy", mode]);
      assert.match(sft.stderr, new RegExp(`samples from 1/1 runs, privacy ${mode}\\n$`));
      for (const line of sft.stdout.trim().split("\n")) assert.deepEqual(Object.keys(JSON.parse(line)), ["messages"], "SFT lines keep their shape");
    }
    assert.equal(JSON.parse(cli(["report", trial, "--json"]).stdout).privacy, "off", "--json always carries the field");
  });
});

// ---------------------------------------------------------------- off is today's output, byte for byte

describe("--privacy off (the default) is byte-identical to today's output", () => {
  test("report HTML, ATIF, OTel and SFT with no flag and with --privacy off equal the untouched builders", async () => {
    // #90: the CLI page carries the league table folded from the same state
    // dir, and stamps the newest run time (if any) instead of the wall clock.
    const prevState = process.env.AGENTIC_CODING_HARNESS_STATE_DIR;
    process.env.AGENTIC_CODING_HARNESS_STATE_DIR = stateDir;
    let model: Awaited<ReturnType<typeof loadReportModel>>;
    try {
      model = await loadReportModel([trial]);
    } finally {
      if (prevState === undefined) delete process.env.AGENTIC_CODING_HARNESS_STATE_DIR;
      else process.env.AGENTIC_CODING_HARNESS_STATE_DIR = prevState;
    }
    const asOf = model.leaderboard.dataAsOf;
    const want = stableHtml(renderReport(model, { version: await readVersion(), ...(asOf !== null ? { dataAsOf: new Date(asOf) } : {}) }));
    for (const extra of [[], ["--privacy", "off"]]) {
      const html = path.join(tmp, `off-${extra.length}.html`);
      const r = cli(["report", trial, "--out", html, ...extra]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stderr, "");
      const page = await fs.readFile(html, "utf8");
      assert.equal(stableHtml(page), want);
      assert.ok(!page.includes('<meta name="ach-privacy"') && !page.includes("data-privacy="), "off HTML carries no stamp");

      const run = plantedRun();
      const events = run.events as AgentEvent[];
      // --mask none: this pins privacy off, and otel masks secrets by default since the #71 owner decision.
      const otel = cli(["emit", "--input", runFile, "--format", "otel", "--mask", "none", ...extra]);
      assert.equal(otel.stderr, "");
      assert.equal(stableIds(otel.stdout), stableIds(JSON.stringify(toOtlpJson(events, { sessionId: SESSION_ID, agentName: "claude", model: "claude-sonnet" }), null, 2) + "\n"));
      assert.ok(!otel.stdout.includes('"ach.privacy"'), "off OTel carries no stamp");
      const atif = cli(["emit", "--input", runFile, "--format", "atif", ...extra]);
      assert.equal(atif.stderr, "");
      assert.equal(JSON.parse(atif.stdout).extra?.privacy, undefined, "off ATIF carries no stamp");
      const w = AtifWriter.fromEvents(events, { agent: "claude", version: JSON.parse(atif.stdout).agent.version, modelName: "claude-sonnet", sessionId: SESSION_ID });
      assert.equal(stableIds(atif.stdout), stableIds(JSON.stringify(w.toTrajectory(), null, 2) + "\n"));
      const sft = cli(["emit", "--input", runFile, "--format", "sft", ...extra]);
      assert.equal(sft.stdout, turnSamples(withPrompt(eventsToMessages(events), PROMPT)).map((s) => JSON.stringify(s)).join("\n") + "\n");
      assert.equal(sft.stderr, "sft: 2 samples from 1/1 runs\n");
    }
  });
});

// ---------------------------------------------------------------- config, env, flags, MCP

describe("config mask.privacy and env AGENTIC_CODING_HARNESS_PRIVACY", () => {
  test("the file sets the mode, env beats the file, --privacy beats env; --set/--show handle mask.privacy", async () => {
    const dir = await fs.mkdtemp(path.join(tmp, "cfg-"));
    const cfg = path.join(dir, "c.json");
    await fs.writeFile(cfg, JSON.stringify({ mask: { privacy: "anon" } }));
    const env = { AGENTIC_CODING_HARNESS_CONFIG: cfg };
    assert.equal(JSON.parse(cli(["emit", "--input", runFile, "--format", "atif"], env).stdout).extra.privacy, "anon");
    assert.equal(JSON.parse(cli(["report", trial, "--json"], env).stdout).privacy, "anon");
    assert.equal(JSON.parse(cli(["report", trial, "--json"], { ...env, [PRIVACY_ENV]: "redact" }).stdout).privacy, "redact");
    assert.equal(JSON.parse(cli(["report", trial, "--json", "--privacy", "off"], { ...env, [PRIVACY_ENV]: "redact" }).stdout).privacy, "off");

    await fs.writeFile(cfg, JSON.stringify({ mask: { privacy: "hidden" } }));
    const bad = cli(["emit", "--input", runFile, "--format", "otel"], env);
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr, /'mask\.privacy'/);
    assert.match(cli(["emit", "--input", runFile, "--format", "otel", "--privacy", "nope"]).stderr, /--privacy expects one of off\|redact\|anon/);

    await fs.writeFile(cfg, "{}");
    const set = cli(["config", "--set", "mask.privacy", "redact"], env);
    assert.equal(set.code, 0, set.stderr);
    assert.deepEqual(JSON.parse(await fs.readFile(cfg, "utf8")), { mask: { privacy: "redact" } });
    assert.match(set.stdout, /mask\.privacy\s+"?redact"?\s+\[file:/);
    assert.notEqual(cli(["config", "--set", "mask.privacy", "sometimes"], env).code, 0);
    const show = cli(["config", "--show"], { [PRIVACY_ENV]: "anon" });
    assert.match(show.stdout, new RegExp(`mask\\.privacy\\s+"?anon"?\\s+\\[env:${PRIVACY_ENV}\\]`));
  });
});

describe("MCP harness_report / harness_emit honor privacy", () => {
  test("privacy anon: no prompt, hashed ids, stamped file and result; default results unchanged", async () => {
    const tools = new Map<string, McpToolDef>();
    const server = { registerTool: (t: McpToolDef) => void tools.set(t.name, t) } as unknown as McpServer;
    const prev = process.env.AGENTIC_CODING_HARNESS_STATE_DIR;
    const prevPrivacy = process.env[PRIVACY_ENV];
    delete process.env[PRIVACY_ENV];
    try {
      registerInspectTools(server, { stateDir });
      const emit = tools.get("harness_emit")!;
      assert.ok((emit.inputSchema as { properties: Record<string, unknown> }).properties.privacy);
      const out = path.join(tmp, "mcp.atif.json");
      const res = (await emit.handler({ runFile, format: "atif", out, privacy: "anon" })) as Record<string, unknown>;
      assert.equal(res.privacy, "anon");
      const doc = await fs.readFile(out, "utf8");
      assert.deepEqual(sentinelHits(doc), []);
      assert.equal(JSON.parse(doc).extra.privacy, "anon");
      const otelOut = path.join(tmp, "mcp.otel.json");
      await emit.handler({ runFile, format: "otel", out: otelOut, privacy: "redact" });
      assert.equal(JSON.parse(await fs.readFile(otelOut, "utf8")).resourceSpans[0].resource.attributes[1].value.stringValue, "redact");
      const plain = (await emit.handler({ runFile, format: "otel", out: otelOut })) as Record<string, unknown>;
      assert.equal(plain.privacy, undefined);

      const report = tools.get("harness_report")!;
      const html = path.join(tmp, "mcp.html");
      const rr = (await report.handler({ dir: trial, out: html, privacy: "anon" })) as Record<string, unknown>;
      assert.equal(rr.privacy, "anon");
      const page = await fs.readFile(html, "utf8");
      assert.deepEqual(sentinelHits(page), []);
      assert.deepEqual(homePaths(page), []);
      assert.ok(page.includes('<meta name="ach-privacy" content="anon">'));
    } finally {
      if (prev === undefined) delete process.env.AGENTIC_CODING_HARNESS_STATE_DIR;
      else process.env.AGENTIC_CODING_HARNESS_STATE_DIR = prev;
      if (prevPrivacy !== undefined) process.env[PRIVACY_ENV] = prevPrivacy;
    }
  });
});
