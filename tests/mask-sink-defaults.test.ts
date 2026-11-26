// #71 owner decision: outbound sinks (otel, langfuse) mask by default; local
// sinks (atif, sft, report, scrub, export) stay raw. Pins the per-sink
// built-in table, the precedence chain over it, an end-to-end `ach emit` for
// both outbound formats with no flag set, the MCP harness_emit default, and
// byte-identical local outputs with and without an explicit `--mask none`.
//
// Every run uses temp dirs: a fake HOME, a fake state dir and an explicit
// config file, with the mask/privacy env vars removed, so the user's real
// config never leaks in. Secret-shaped fixtures are assembled at runtime so no
// literal token sits in the repo.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import {
  DEFAULT_MASK_MODE,
  MASK_ENV,
  MASK_SINKS,
  resolveMaskPolicy,
  SINK_DEFAULT_MASK_MODE,
  type MaskMode,
  type MaskSink,
} from "../src/core/masking.ts";
import { PRIVACY_ENV } from "../src/core/privacy.ts";
import { registerInspectTools } from "../src/mcp/tools-inspect.ts";
import type { McpServer, McpToolDef } from "../src/mcp/contract.ts";

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;

const j = (...p: string[]) => p.join("");
/** A fake Anthropic-shaped key and a fake email, built at runtime. */
const KEY = j("sk-", "ant-", "api03-", "Zy9Xw8Vu7Ts6Rq5Po4Nm".repeat(2));
const EMAIL = j("fixture.user", "@", "example.com");
const KEY_PLACEHOLDER = "[REDACTED_API_KEY]";
const EMAIL_PLACEHOLDER = "[REDACTED_EMAIL]";

const EXPECTED: Record<MaskSink, MaskMode> = {
  atif: "none",
  otel: "all",
  langfuse: "all",
  sft: "none",
  report: "none",
  scrub: "none",
  export: "none",
};

const T0 = 1790000000000;
function plantedRun(): Record<string, unknown> {
  return {
    runId: "r-defaults",
    // OTel and Langfuse span attributes carry the session id, not message text: plant the email there.
    sessionId: `sess-${EMAIL}`,
    agent: "claude",
    exitStatus: "success",
    tokens: [],
    totalCost: 0,
    durationMs: 1,
    warnings: [],
    score: 5,
    task: `deploy with ${KEY}`,
    events: [
      { type: "message", source: "system", content: "sys", timestamp: T0 },
      { type: "message", source: "user", content: `use ${KEY} and mail ${EMAIL}`, timestamp: T0 + 1 },
      { type: "tool_call", toolCallId: "c1", functionName: "bash", arguments: { cmd: "echo hi", token: KEY }, timestamp: T0 + 2 },
      { type: "tool_result", toolCallId: "c1", content: `KEY=${KEY}`, timestamp: T0 + 3 },
      { type: "message", source: "assistant", content: "done", timestamp: T0 + 4 },
    ],
  };
}

let tmp: string;
let home: string;
let stateDir: string;
let runFile: string;
let emptyConfig: string;
let trial: string;

before(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ach-mask-defaults-")));
  home = path.join(tmp, "home");
  stateDir = path.join(tmp, "state");
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  runFile = path.join(tmp, "run.json");
  await fs.writeFile(runFile, JSON.stringify(plantedRun()));
  emptyConfig = path.join(tmp, "empty-config.json");
  await fs.writeFile(emptyConfig, "{}\n");
  trial = path.join(tmp, "trials", "20260910-000000");
  await fs.mkdir(trial, { recursive: true });
  await fs.writeFile(path.join(trial, "claude.json"), JSON.stringify(plantedRun()));
  // A state dir with a run record and its raw transcript, both carrying the key (for ach export).
  const raw = path.join(stateDir, "raw", "claude-sess-defaults.jsonl");
  await fs.mkdir(path.dirname(raw), { recursive: true });
  await fs.writeFile(raw, JSON.stringify({ type: "message", text: `key ${KEY}`, timestamp: T0 }) + "\n");
  await fs.mkdir(path.join(stateDir, "runs"), { recursive: true });
  await fs.writeFile(
    path.join(stateDir, "runs", "r-defaults.json"),
    JSON.stringify({ runId: "r-defaults", agent: "claude", sessionId: "sess-defaults", startedAt: T0, status: "success", exitStatus: "success", rawTranscript: raw, note: `key ${KEY}` }) + "\n",
  );
});
after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

/** The child env: temp HOME/state/config, and no inherited mask, privacy or Langfuse settings. */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of [MASK_ENV, PRIVACY_ENV, "XDG_CONFIG_HOME", "LANGFUSE_URL", "LANGFUSE_HOST", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"]) delete env[k];
  Object.assign(env, { HOME: home, AGENTIC_CODING_HARNESS_STATE_DIR: stateDir, AGENTIC_CODING_HARNESS_CONFIG: emptyConfig }, extra);
  return env as NodeJS.ProcessEnv;
}

function cli(args: string[], extra: Record<string, string> = {}) {
  const p = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], { encoding: "utf8", env: childEnv(extra) });
  return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

/** Async CLI run, for the tests that serve HTTP in this process meanwhile. */
function cliAsync(args: string[], extra: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ["--import", "tsx", CLI, ...args], { env: childEnv(extra) });
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function writeConfig(name: string, cfg: unknown): Promise<string> {
  const f = path.join(tmp, name);
  await fs.writeFile(f, JSON.stringify(cfg));
  return f;
}

/** A port-0 collector that records every POSTed body. */
async function collector(): Promise<{ url: string; bodies: string[]; close: () => void }> {
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
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, bodies, close: () => void server.close() };
}

const lfFlags = (url: string) => ["--langfuse-url", url, "--langfuse-public-key", "pk-test", "--langfuse-secret-key", "sk-test"];

// ---------------------------------------------------------------- the built-in table

describe("mask built-in default per sink (#71 owner decision)", () => {
  test("the table covers exactly MASK_SINKS", () => {
    assert.deepEqual(Object.keys(SINK_DEFAULT_MASK_MODE).sort(), [...MASK_SINKS].sort());
    assert.equal(DEFAULT_MASK_MODE, "none", "the local-sink default stays none");
  });
  for (const sink of MASK_SINKS) {
    test(`sink ${sink} defaults to ${EXPECTED[sink]}`, () => {
      assert.equal(SINK_DEFAULT_MASK_MODE[sink], EXPECTED[sink], `SINK_DEFAULT_MASK_MODE.${sink}`);
      assert.equal(resolveMaskPolicy({ sink, env: {} }).mode, EXPECTED[sink], `resolveMaskPolicy(${sink}) with nothing set`);
      assert.equal(resolveMaskPolicy({ sink, env: {}, config: {} }).mode, EXPECTED[sink], `resolveMaskPolicy(${sink}) with an empty config`);
    });
  }
});

// ---------------------------------------------------------------- precedence over the built-in

describe("precedence: every setting beats the outbound built-in", () => {
  test("resolveMaskPolicy: mask.mode none, mask.otel none, env none and --mask none each beat otel's all", () => {
    for (const sink of ["otel", "langfuse"] as const) {
      assert.equal(resolveMaskPolicy({ sink, env: {}, config: { mode: "none" } }).mode, "none", `${sink}: mask.mode none`);
      assert.equal(resolveMaskPolicy({ sink, env: {}, config: { [sink]: "none" } }).mode, "none", `${sink}: mask.${sink} none`);
      assert.equal(resolveMaskPolicy({ sink, env: { [MASK_ENV]: "none" } }).mode, "none", `${sink}: env none`);
      assert.equal(resolveMaskPolicy({ sink, env: {}, flags: { mask: "none" } }).mode, "none", `${sink}: --mask none`);
      assert.equal(resolveMaskPolicy({ sink, env: {}, config: { mode: "preview" } }).mode, "preview", `${sink}: mask.mode preview`);
    }
    // The chain order itself is unchanged: --mask > env > mask.<sink> > mask.mode.
    assert.equal(resolveMaskPolicy({ sink: "otel", env: {}, config: { mode: "none", otel: "all" } }).mode, "all", "mask.otel beats mask.mode");
    assert.equal(resolveMaskPolicy({ sink: "otel", env: { [MASK_ENV]: "all" }, config: { otel: "none" } }).mode, "all", "env beats mask.otel");
    assert.equal(resolveMaskPolicy({ sink: "otel", env: { [MASK_ENV]: "all" }, flags: { mask: "none" } }).mode, "none", "--mask beats env");
    // A global mask.mode turns the local sinks on too.
    assert.equal(resolveMaskPolicy({ sink: "atif", env: {}, config: { mode: "all" } }).mode, "all", "mask.mode all reaches atif");
  });

  test("ach emit otel: mask.mode none, mask.otel none, env none and --mask none each emit the raw key", async () => {
    const modeNone = await writeConfig("mode-none.json", { mask: { mode: "none" } });
    const otelNone = await writeConfig("otel-none.json", { mask: { otel: "none" } });
    const cases: Array<[string, string[], Record<string, string>]> = [
      ["config mask.mode none", [], { AGENTIC_CODING_HARNESS_CONFIG: modeNone }],
      ["config mask.otel none", [], { AGENTIC_CODING_HARNESS_CONFIG: otelNone }],
      [`env ${MASK_ENV}=none`, [], { [MASK_ENV]: "none" }],
      ["--mask none", ["--mask", "none"], {}],
    ];
    for (const [label, flags, extra] of cases) {
      const r = cli(["emit", "--input", runFile, "--format", "otel", ...flags], extra);
      assert.equal(r.code, 0, `${label}: ${r.stderr}`);
      assert.ok(r.stdout.includes(EMAIL), `${label}: the raw email (session id) is exported`);
      assert.ok(!r.stdout.includes(EMAIL_PLACEHOLDER), `${label}: nothing masked`);
      assert.equal(r.stderr, "", `${label}: no mask note`);
    }
  });

  test("ach config --set mask.otel none writes the opt-out key, and show reports the built-in otherwise", async () => {
    const cfg = await writeConfig("set-otel.json", {});
    const shownDefault = cli(["config", "--show"], { AGENTIC_CODING_HARNESS_CONFIG: cfg });
    assert.equal(shownDefault.code, 0, shownDefault.stderr);
    assert.match(shownDefault.stdout, /mask\.otel\s+"?all"?\s+\[default\]/, "show: otel built-in");
    assert.match(shownDefault.stdout, /mask\.langfuse\s+"?all"?\s+\[default\]/, "show: langfuse built-in");
    const set = cli(["config", "--set", "mask.otel", "none"], { AGENTIC_CODING_HARNESS_CONFIG: cfg });
    assert.equal(set.code, 0, set.stderr);
    assert.deepEqual(JSON.parse(await fs.readFile(cfg, "utf8")), { mask: { otel: "none" } });
    assert.match(set.stdout, /mask\.otel\s+"?none"?\s+\[file:/);
    const r = cli(["emit", "--input", runFile, "--format", "otel"], { AGENTIC_CODING_HARNESS_CONFIG: cfg });
    assert.ok(r.stdout.includes(EMAIL), "mask.otel none from --set: raw export");
    const modeNone = await writeConfig("show-mode-none.json", { mask: { mode: "none" } });
    const shown = cli(["config", "--show"], { AGENTIC_CODING_HARNESS_CONFIG: modeNone });
    assert.doesNotMatch(shown.stdout, /mask\.otel\s+"?all"?\s+\[default\]/, "a file mask.mode hides the per-sink default row");
  });
});

// ---------------------------------------------------------------- end to end: outbound masks with no flag

describe("ach emit: outbound formats mask with no flag set", () => {
  test("otel --out file and stdout carry no raw email (session id); the mask note is on stderr", async () => {
    const out = path.join(tmp, "default.otel.json");
    const r = cli(["emit", "--input", runFile, "--format", "otel", "--out", out]);
    assert.equal(r.code, 0, r.stderr);
    const file = await fs.readFile(out, "utf8");
    assert.ok(!file.includes(EMAIL), "otel file: raw email absent");
    assert.ok(file.includes(EMAIL_PLACEHOLDER), "otel file: placeholder present");
    assert.match(r.stderr, /mask: .*masked \d+ findings \(.*anthropic-key \d+/);
    const s = cli(["emit", "--input", runFile, "--format", "otel"]);
    assert.equal(s.code, 0, s.stderr);
    assert.ok(!s.stdout.includes(EMAIL) && s.stdout.includes(EMAIL_PLACEHOLDER), "otel stdout masked");
    // Control: --mask none on the same input exports the raw email, so the test can fail.
    assert.ok(cli(["emit", "--input", runFile, "--format", "otel", "--mask", "none"]).stdout.includes(EMAIL), "control: --mask none is raw");
  });

  test("langfuse: the POSTed body and the --out payload carry no raw email (session id)", async () => {
    const c = await collector();
    try {
      const out = path.join(tmp, "default.langfuse.json");
      const r = await cliAsync(["emit", "--input", runFile, "--format", "langfuse", "--out", out, ...lfFlags(c.url)]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(c.bodies.length, 1);
      assert.ok(!c.bodies[0]!.includes(EMAIL), "POSTed body: raw email absent");
      assert.ok(c.bodies[0]!.includes(EMAIL_PLACEHOLDER), "POSTed body: placeholder present");
      const file = await fs.readFile(out, "utf8");
      assert.ok(!file.includes(EMAIL) && file.includes(EMAIL_PLACEHOLDER), "langfuse --out payload masked");
      assert.match(r.stderr, /mask: .*masked \d+ findings/);
      // Control: the same command with --mask none sends the raw key, so the test can fail.
      const raw = await cliAsync(["emit", "--input", runFile, "--format", "langfuse", "--mask", "none", ...lfFlags(c.url)]);
      assert.equal(raw.code, 0, raw.stderr);
      assert.ok(c.bodies[1]!.includes(EMAIL), "control: --mask none POSTs the raw email");
    } finally {
      c.close();
    }
  });

  test("MCP harness_emit: otel and langfuse mask with no mask argument; atif stays raw", async () => {
    const tools = new Map<string, McpToolDef>();
    const server = { registerTool: (t: McpToolDef) => void tools.set(t.name, t) } as unknown as McpServer;
    const saved: Record<string, string | undefined> = {};
    for (const k of [MASK_ENV, PRIVACY_ENV, "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"]) saved[k] = process.env[k];
    delete process.env[MASK_ENV];
    delete process.env[PRIVACY_ENV];
    process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-test";
    const c = await collector();
    try {
      registerInspectTools(server, { stateDir });
      const emit = tools.get("harness_emit")!;
      // harness_emit names the session `unknown-session`, so the span attribute it copies from the run
      // is the tool call id: plant the email there.
      const mcpRun = path.join(tmp, "mcp-run.json");
      const run = plantedRun();
      (run.events as Array<Record<string, unknown>>).forEach((e) => {
        if (e.toolCallId !== undefined) e.toolCallId = `call-${EMAIL}`;
      });
      await fs.writeFile(mcpRun, JSON.stringify(run));
      const otelOut = path.join(tmp, "mcp.otel.json");
      await emit.handler({ runFile: mcpRun, format: "otel", out: otelOut });
      const otel = await fs.readFile(otelOut, "utf8");
      assert.ok(!otel.includes(EMAIL) && otel.includes(EMAIL_PLACEHOLDER), "MCP otel masked by default");
      await emit.handler({ runFile: mcpRun, format: "langfuse", endpoint: c.url });
      assert.equal(c.bodies.length, 1);
      assert.ok(!c.bodies[0]!.includes(EMAIL) && c.bodies[0]!.includes(EMAIL_PLACEHOLDER), "MCP langfuse masked by default");
      const atifOut = path.join(tmp, "mcp.atif.json");
      await emit.handler({ runFile: mcpRun, format: "atif", out: atifOut });
      assert.ok((await fs.readFile(atifOut, "utf8")).includes(KEY), "MCP atif stays raw by default");
      const rawOut = path.join(tmp, "mcp.otel.none.json");
      await emit.handler({ runFile: mcpRun, format: "otel", out: rawOut, mask: "none" });
      assert.ok((await fs.readFile(rawOut, "utf8")).includes(EMAIL), "MCP otel mask none opts out");
    } finally {
      c.close();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

// ---------------------------------------------------------------- local sinks: byte-identical

/** Every regular file under `dir`, relative, sorted. */
async function walk(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full, base)));
    else out.push(path.relative(base, full));
  }
  return out.sort();
}

describe("local sinks: no mask settings is byte-identical to an explicit --mask none", () => {
  test("atif --out: identical bytes, raw key present", async () => {
    const a = path.join(tmp, "local-default.atif.json");
    const b = path.join(tmp, "local-none.atif.json");
    const ra = cli(["emit", "--input", runFile, "--format", "atif", "--out", a]);
    const rb = cli(["emit", "--input", runFile, "--format", "atif", "--out", b, "--mask", "none"]);
    assert.equal(ra.code, 0, ra.stderr);
    assert.equal(rb.code, 0, rb.stderr);
    const ta = await fs.readFile(a, "utf8");
    // ATIF carries a random trajectory id per render; that one field is normalized.
    const stable = (s: string) => s.replace(/"trajectory_id": "[^"]*"/g, '"trajectory_id": "X"');
    assert.equal(stable(ta), stable(await fs.readFile(b, "utf8")), "atif: default == --mask none");
    assert.ok(ta.includes(KEY), "atif: raw key present");
    assert.equal(ra.stderr, rb.stderr, "atif: same stderr");
  });

  test("sft: identical stdout and stderr, raw key present", () => {
    const ra = cli(["emit", "--input", runFile, "--format", "sft"]);
    const rb = cli(["emit", "--input", runFile, "--format", "sft", "--mask", "none"]);
    assert.equal(ra.code, 0, ra.stderr);
    assert.equal(ra.stdout, rb.stdout, "sft: default == --mask none");
    assert.equal(ra.stderr, rb.stderr, "sft: same stderr");
    assert.ok(ra.stdout.includes(KEY), "sft: raw key present");
  });

  test("report HTML and --json: identical, raw key present", async () => {
    const a = path.join(tmp, "local-default.html");
    const b = path.join(tmp, "local-none.html");
    const ra = cli(["report", trial, "--out", a]);
    const rb = cli(["report", trial, "--out", b, "--mask", "none"]);
    assert.equal(ra.code, 0, ra.stderr);
    assert.equal(rb.code, 0, rb.stderr);
    // The footer carries the render time; that one field is normalized.
    const stable = (s: string) => s.replace(/(<footer>generated by agentic-coding-harness [^·]*· )[^<]*/, "$1T");
    const ha = await fs.readFile(a, "utf8");
    assert.equal(stable(ha), stable(await fs.readFile(b, "utf8")), "report HTML: default == --mask none");
    assert.ok(ha.includes(KEY), "report HTML: raw key present");
    const ja = cli(["report", trial, "--json"]);
    const jb = cli(["report", trial, "--json", "--mask", "none"]);
    assert.equal(ja.code, 0, ja.stderr);
    assert.equal(ja.stdout, jb.stdout, "report --json: default == --mask none");
    assert.ok(ja.stdout.includes(KEY), "report --json: raw key present");
  });

  test("export: every dumped file identical, raw key present", async () => {
    const a = path.join(tmp, "export-default");
    const b = path.join(tmp, "export-none");
    const ra = cli(["export", "--out", a]);
    const rb = cli(["export", "--out", b, "--mask", "none"]);
    assert.equal(ra.code, 0, ra.stderr);
    assert.equal(rb.code, 0, rb.stderr);
    const fa = await walk(a);
    assert.deepEqual(fa, await walk(b), "export: same file list");
    assert.ok(fa.length > 1, "export: the dump holds files");
    let sawKey = false;
    for (const f of fa) {
      let ta = await fs.readFile(path.join(a, f), "utf8");
      let tb = await fs.readFile(path.join(b, f), "utf8");
      // Wall-clock fields are normalized: stats.json's `asOf`, the manifest's `exportedAt`, and the
      // manifest's sha256 of stats.json (which differs only by that `asOf`). Every other byte must match.
      const t = (s: string) =>
        s
          .replace(/"asOf": "[^"]*"/g, '"asOf": "T"')
          .replace(/"exportedAt": "[^"]*"/, '"exportedAt": "T"')
          .replace(/("path": "stats\.json",\s*"kind": "stats",\s*"sha256": ")[0-9a-f]+/, "$1X");
      ta = t(ta);
      tb = t(tb);
      assert.equal(ta, tb, `export ${f}: default == --mask none`);
      if (ta.includes(KEY)) sawKey = true;
    }
    assert.ok(sawKey, "export: the raw key is present in the dump");
  });

  test("scrub: no mask setting behaves exactly as --mask none (the same usage error, no file written)", async () => {
    const target = path.join(tmp, "scrub-input.json");
    await fs.writeFile(target, JSON.stringify({ note: `key ${KEY}` }));
    const ra = cli(["scrub", target]);
    const rb = cli(["scrub", target, "--mask", "none"]);
    assert.notEqual(ra.code, 0);
    assert.equal(ra.code, rb.code, "scrub: same exit code");
    assert.equal(ra.stdout, rb.stdout, "scrub: same stdout");
    assert.equal(ra.stderr, rb.stderr, "scrub: same stderr");
    assert.match(ra.stderr, /mask mode is 'none'/);
    assert.deepEqual((await fs.readdir(tmp)).filter((n) => n.startsWith("scrub-input.masked")), [], "scrub: no copy written");
    // Control: the listing exists once a mode is chosen, and it finds the raw key.
    const p = cli(["scrub", target, "--mask", "preview", "--json"]);
    assert.equal(p.code, 0, p.stderr);
    assert.ok(((JSON.parse(p.stdout) as { totals: { counts: Record<string, number> } }).totals.counts["anthropic-key"] ?? 0) > 0);
  });
});
