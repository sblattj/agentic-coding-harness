// #71: secret masking before export and share-time scrubbing.
//
// Secret-shaped fixtures are assembled at runtime (string concatenation) so
// no literal token, key or PEM block sits in the repository.
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import {
  BUILTIN_DETECTORS,
  DEFAULT_MASK_MODE,
  ENTROPY_DETECTOR,
  MASK_ENV,
  maskForExport,
  maskText,
  maskValue,
  NO_MASK,
  resolveMaskPolicy,
  shannonEntropy,
  starPreview,
} from "../src/core/masking.ts";
import { toOtlpJson } from "../src/emitters/otel.ts";
import { AtifWriter } from "../src/emitters/atif.ts";
import { eventsToMessages, turnSamples } from "../src/emitters/sft.ts";
import { registerInspectTools } from "../src/mcp/tools-inspect.ts";
import type { McpServer, McpToolDef } from "../src/mcp/contract.ts";
import type { AgentEvent } from "../src/core/types.ts";
import { MaskConfigSchema } from "../src/core/masking.ts";

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;

// ---------------------------------------------------------------- fixtures (built at runtime)

const j = (...p: string[]) => p.join("");
const S = {
  anthropic: j("sk-", "ant-", "api03-", "A1b2C3d4E5f6G7h8J9k0".repeat(2)),
  openai: j("sk-", "proj-", "Qw3rTy9UiOp2AsDf5GhJk8Lz"),
  github: j("gh", "p_", "Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe9Dc8"),
  githubPat: j("github", "_pat_", "11ABCDEFG0", "abcdefghij1234567890ABCDEFGHIJ"),
  awsAccess: j("AK", "IA", "QWERTYUIOPASDFGH"),
  awsSecret: j("wJalrXUtnFEMI/K7MDENG/", "bPxRfiCYEXAMPLEKEY"),
  gcp: j("AI", "za", "Sy", "A1b2C3d4E5f6G7h8J9k0L1m2N3o4P5q6R"),
  slack: j("xo", "xb-", "1234567890-", "abcdefghijKLMN"),
  stripe: j("sk", "_live_", "a1B2c3D4e5F6g7H8i9J0"),
  jwt: j("ey", "JhbGciOiJIUzI1NiJ9", ".", "ey", "JzdWIiOiIxMjM0NTY3ODkwIn0", ".", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"),
  bearerTok: j("abcDEF123456", "ghiJKL789012", "mnoPQR"),
  pemBody: "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
  dbPass: j("S3cret", "Pass99"),
  email: j("dev.person", "@", "example.com"),
  homeUser: "someone",
  envSecret: j("hunter", "2-but-longer"),
};
const pem = () => j("-----BEGIN ", "PRIVATE KEY-----\n", S.pemBody, "\nAbCdEf==\n", "-----END ", "PRIVATE KEY-----");
const home = (rest = "") => j("/Users/", S.homeUser, rest);
const conn = () => j("postgres://admin:", S.dbPass, "@db.internal:5432/app");

/** Values that must never survive masking. */
const PLAINTEXT = [
  S.anthropic, S.openai, S.github, S.githubPat, S.awsAccess, S.awsSecret, S.gcp, S.slack, S.stripe, S.jwt,
  S.bearerTok, S.pemBody, S.dbPass, S.email, j("/Users/", S.homeUser), S.envSecret,
];

function leaks(text: string, values: readonly string[] = PLAINTEXT): string[] {
  return values.filter((v) => text.includes(v));
}

const T0 = 1790000000000;
function plantedEvents(): AgentEvent[] {
  return [
    { type: "message", source: "system", content: "sys", timestamp: T0 },
    { type: "message", source: "user", content: `use ${S.anthropic} and mail ${S.email}`, timestamp: T0 + 1 },
    { type: "tool_call", toolCallId: "c1", functionName: "bash", arguments: { cmd: `cat ${home("/proj/.env")}`, token: S.github }, timestamp: T0 + 2 },
    { type: "tool_result", toolCallId: "c1", content: `AWS=${S.awsAccess}\nDB=${conn()}\n${pem()}`, timestamp: T0 + 3 },
    { type: "message", source: "assistant", content: "done", timestamp: T0 + 4 },
  ] as unknown as AgentEvent[];
}
/** A RunResult whose identity fields (reaching OTel/Langfuse span attrs) carry PII too. */
function plantedRun(): Record<string, unknown> {
  return {
    runId: "r-1", sessionId: `sess-${S.email}`, agent: "claude", exitStatus: "success", tokens: [], totalCost: 0,
    durationMs: 1, warnings: [], score: 5, events: plantedEvents(),
  };
}
const PLANTED_IN_RUN = [S.anthropic, S.email, S.github, j("/Users/", S.homeUser), S.awsAccess, S.dbPass, S.pemBody];

function cli(args: string[], env: Record<string, string | undefined> = {}, cwd?: string) {
  const childEnv: Record<string, string | undefined> = { ...process.env, ...env };
  delete childEnv[MASK_ENV];
  if (env[MASK_ENV] !== undefined) childEnv[MASK_ENV] = env[MASK_ENV];
  if (env.AGENTIC_CODING_HARNESS_CONFIG === undefined) delete childEnv.AGENTIC_CODING_HARNESS_CONFIG;
  const p = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    encoding: "utf8",
    env: childEnv as NodeJS.ProcessEnv,
    ...(cwd !== undefined ? { cwd } : {}),
  });
  return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

/** Async CLI run, for tests that serve HTTP in this process meanwhile. */
function cliAsync(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const childEnv: Record<string, string | undefined> = { ...process.env, ...env };
    delete childEnv.AGENTIC_CODING_HARNESS_CONFIG;
    if (env[MASK_ENV] === undefined) delete childEnv[MASK_ENV];
    const c = spawn(process.execPath, ["--import", "tsx", CLI, ...args], { env: childEnv as NodeJS.ProcessEnv });
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** Strip the per-call random ids so two renders of the same input compare. */
const stableIds = (s: string) => s.replace(/"(traceId|spanId|parentSpanId|trajectory_id)": "[^"]*"/g, '"$1": "X"');

const sha = async (f: string) => createHash("sha256").update(await fs.readFile(f)).digest("hex");

let tmp: string;
let stateDir: string;
let runFile: string;
before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ach-mask-"));
  stateDir = path.join(tmp, "state");
  await fs.mkdir(stateDir);
  runFile = path.join(tmp, "run.json");
  await fs.writeFile(runFile, JSON.stringify(plantedRun()));
});
after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});
const baseEnv = () => ({ AGENTIC_CODING_HARNESS_STATE_DIR: stateDir, HOME: tmp });

// ---------------------------------------------------------------- unit: detectors

describe("masking: detectors (strings)", () => {
  const cases: Array<[string, string, string, string]> = [
    // [name, input, detector id, plaintext that must be gone]
    ["anthropic key", `key=${S.anthropic} ok`, "anthropic-key", S.anthropic],
    ["openai key", `use ${S.openai}`, "openai-key", S.openai],
    ["github token", `t ${S.github}`, "github-token", S.github],
    ["github fine-grained PAT", `t ${S.githubPat}`, "github-token", S.githubPat],
    ["aws access key", `id ${S.awsAccess}`, "aws-access-key", S.awsAccess],
    ["aws secret key", `aws_secret_access_key = ${S.awsSecret}`, "aws-secret-key", S.awsSecret],
    ["gcp api key", `k=${S.gcp}`, "gcp-api-key", S.gcp],
    ["slack token", `s ${S.slack}`, "slack-token", S.slack],
    ["stripe key", `s ${S.stripe}`, "stripe-key", S.stripe],
    ["jwt", `tok ${S.jwt}`, "jwt", S.jwt],
    ["bearer header", `Authorization: Bearer ${S.bearerTok}`, "bearer-token", S.bearerTok],
    ["private key block", `x\n${pem()}\ny`, "private-key", S.pemBody],
    ["connection string", `DB=${conn()}`, "url-credentials", S.dbPass],
    ["env assignment", `DB_PASSWORD=${S.envSecret}`, "credential-assignment", S.envSecret],
    ["email", `mail ${S.email} now`, "email", S.email],
    ["home path (macOS)", `cd ${home("/dev/app")}`, "home-path", j("/Users/", S.homeUser)],
    ["home path (linux)", j("cd /home/", S.homeUser, "/app"), "home-path", j("/home/", S.homeUser)],
    ["home path (windows)", j("C:\\Users\\", S.homeUser, "\\app"), "home-path", j("\\Users\\", S.homeUser)],
  ];
  for (const [name, input, id, secret] of cases) {
    test(`detects ${name} and leaves no plaintext`, () => {
      const r = maskText(input, {});
      assert.ok(r.findings.some((f) => f.detector === id), `${name}: ${JSON.stringify(r.findings)}`);
      assert.ok(!r.text.includes(secret), `${name} leaked: ${r.text}`);
      assert.match(r.text, /\[REDACTED_[A-Z_]+\]/);
    });
  }

  test("context around a secret is kept (only the secret span is replaced)", () => {
    assert.equal(maskText(`Authorization: Bearer ${S.bearerTok}`).text, "Authorization: Bearer [REDACTED_BEARER_TOKEN]");
    assert.equal(maskText(`DB=${conn()}`).text, "DB=postgres://[REDACTED_CREDENTIALS]@db.internal:5432/app");
    assert.equal(maskText(`cd ${home("/dev/app")}`).text, "cd [REDACTED_HOME]/dev/app");
  });

  test("ordinary text is left alone (no false positives on common shapes)", () => {
    const clean = [
      "fixed the bug in src/core/masking.ts at line 42",
      "version 1.2.3, package @types/node, scope foo@1.2.3",
      "trace 4bf92f3577b34da6a3ce929d0e0e4736 span 00f067aa0ba902b7",
      "commit 9fceb02d0ae598e95dc970b74767f19372d61af8",
      "id 123e4567-e89b-12d3-a456-426614174000 count 1234567890123456789012345",
      "/Users/Shared/cache and /tmp/x and ~/dev/app",
      "Basic setup steps follow",
      "the password field is required",
    ];
    for (const c of clean) assert.deepEqual(maskText(c).findings, [], c);
  });

  test("masking is idempotent and placeholders match no detector", () => {
    const input = PLAINTEXT.map((v) => `x ${v} y`).join("\n") + `\n${pem()}\n${conn()}\nAuthorization: Bearer ${S.bearerTok}`;
    for (const style of ["replace", "partial"] as const) {
      const once = maskText(input, { style });
      const twice = maskText(once.text, { style });
      assert.equal(twice.text, once.text, style);
      assert.deepEqual(twice.findings, [], style);
    }
    for (const d of BUILTIN_DETECTORS) {
      d.re.lastIndex = 0;
      assert.ok(!d.re.test(`[REDACTED_${d.label}]`), d.id);
      d.re.lastIndex = 0;
    }
  });

  test("partial style keeps a short prefix (sk-ant-api...****), never the whole secret", () => {
    const r = maskText(`k ${S.anthropic}`, { style: "partial" });
    assert.equal(r.text, "k sk-ant-api...****");
    assert.equal(starPreview("abcdefghijkl"), "abcd...****");
    // Emails and home paths never keep a prefix.
    assert.equal(maskText(S.email, { style: "partial" }).text, "[REDACTED_EMAIL]");
  });

  test("user patterns (--mask-pattern) mask local shapes, with an optional `secret` group", () => {
    const r = maskText("ticket ACME-1234 and code=XYZ-99", { patterns: [/ACME-\d+/g, /code=(?<secret>[A-Z]+-\d+)/g] });
    assert.equal(r.text, "ticket [REDACTED_CUSTOM] and code=[REDACTED_CUSTOM]");
    assert.deepEqual(r.findings.map((f) => f.detector), ["custom-1", "custom-2"]);
  });

  test("text findings carry line:col and a star sample, never plaintext", () => {
    const r = maskText(`a\nbb ${S.github}`);
    assert.equal(r.findings[0]!.location, "2:4");
    assert.ok(!r.findings[0]!.sample.includes(S.github));
  });
});

describe("masking: high-entropy detector (opt-in)", () => {
  const token = "Q7xK9mPz2LrT4vWn8YbC3dHs6FjA";
  test("off by default; on with entropy: true", () => {
    assert.deepEqual(maskText(`t ${token}`).findings, []);
    const r = maskText(`t ${token}`, { entropy: true });
    assert.equal(r.text, "t [REDACTED_HIGH_ENTROPY]");
    assert.ok(shannonEntropy(token) >= 4);
  });
  test("leaves numbers, UUIDs, hex SHAs, trace/span ids and tool-call ids alone", () => {
    const keep = [
      "12345678901234567890123456789012",
      "123e4567-e89b-12d3-a456-426614174000",
      "9fceb02d0ae598e95dc970b74767f19372d61af8",
      "4bf92f3577b34da6a3ce929d0e0e4736",
      "00f067aa0ba902b7",
      "toolu_01XFDUDYJgAACzvnptvVoYEL",
      "call_Ab12Cd34Ef56Gh78Ij90Kl12",
      "msg_01AbCdEfGhIjKlMnOpQrStUv",
      "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "ThisIsAVeryLongCamelCaseIdentifierName",
    ];
    for (const k of keep) {
      assert.deepEqual(maskText(`v ${k} v`, { entropy: true }).findings, [], k);
      ENTROPY_DETECTOR.re.lastIndex = 0;
    }
  });
});

describe("masking: JSON values", () => {
  test("deep-masks string leaves, keeps numbers/keys/structure, reports JSON paths", () => {
    const v = { a: 1, b: [true, null, `x ${S.email}`], c: { d: S.github, n: 42 } };
    const r = maskValue(v);
    assert.deepEqual(r.value, { a: 1, b: [true, null, "x [REDACTED_EMAIL]"], c: { d: "[REDACTED_GITHUB_TOKEN]", n: 42 } });
    assert.deepEqual(r.findings.map((f) => f.location), ["$.b[2]", "$.c.d"]);
    assert.equal(v.c.d, S.github, "input not mutated");
  });

  test("secret-named keys (password, apiKey, authorization) are masked whole", () => {
    const r = maskValue({ password: "plain-words", apiKey: "abc", Authorization: "x y", tokenizer: "cl100k", inputTokens: 5 });
    assert.deepEqual(r.value, { password: "[REDACTED_SECRET]", apiKey: "[REDACTED_SECRET]", Authorization: "[REDACTED_SECRET]", tokenizer: "cl100k", inputTokens: 5 });
  });

  test("a secret inside a JSON-encoded string leaf (tool args) is masked and the leaf still parses", () => {
    const args = JSON.stringify({ path: home("/a.txt"), headers: { auth: `Bearer ${S.bearerTok}` }, key: S.anthropic });
    const r = maskValue({ arguments: args });
    const inner = JSON.parse(r.value.arguments) as Record<string, unknown>;
    assert.deepEqual(inner, { path: "[REDACTED_HOME]/a.txt", headers: { auth: "Bearer [REDACTED_BEARER_TOKEN]" }, key: "[REDACTED_API_KEY]" });
  });

  test("standard fixture: no plaintext survives in replace or partial style", () => {
    // Shapes that are secrets on their own; the rest need their context (a header, a key name, a PEM block).
    const contextual = new Set([S.awsSecret, S.bearerTok, S.pemBody, S.dbPass, S.envSecret]);
    const all = PLAINTEXT.filter((v) => !contextual.has(v)).map((v, i) => ({ i, text: `value ${v} end` }));
    all.push({ i: 99, text: pem() }, { i: 100, text: conn() }, { i: 101, text: `aws_secret_access_key=${S.awsSecret}` }, { i: 102, text: `Bearer ${S.bearerTok}` }, { i: 103, text: `PASSWORD=${S.envSecret}` });
    for (const style of ["replace", "partial"] as const) {
      const out = JSON.stringify(maskValue(all, { style }).value);
      assert.deepEqual(leaks(out), [], style);
    }
  });
});

// ---------------------------------------------------------------- policy and default

describe("masking: policy and the pending default", () => {
  test("DEFAULT_MASK_MODE is none (today's behavior; pending an owner decision)", () => {
    assert.equal(DEFAULT_MASK_MODE, "none");
    assert.equal(NO_MASK.mode, "none");
    assert.equal(resolveMaskPolicy({ sink: "otel", env: {} }).mode, DEFAULT_MASK_MODE);
  });

  test("mode none returns the same reference without scanning", () => {
    const v = { s: S.github };
    const r = maskForExport(v);
    assert.equal(r.value, v);
    assert.deepEqual(r.findings, []);
  });

  test("preview returns the original plus findings; all returns a masked copy", () => {
    const v = { s: S.github };
    const p = maskForExport(v, { mode: "preview", options: {} });
    assert.equal(p.value, v);
    assert.equal(p.findings.length, 1);
    const a = maskForExport(v, { mode: "all", options: {} });
    assert.deepEqual(a.value, { s: "[REDACTED_GITHUB_TOKEN]" });
  });

  test("precedence: --mask > env > mask.<sink> > mask.mode > default", () => {
    const config = { mode: "all" as const, atif: "none" as const };
    assert.equal(resolveMaskPolicy({ sink: "otel", config, env: {} }).mode, "all");
    assert.equal(resolveMaskPolicy({ sink: "atif", config, env: {} }).mode, "none");
    assert.equal(resolveMaskPolicy({ sink: "atif", config, env: { [MASK_ENV]: "preview" } }).mode, "preview");
    assert.equal(resolveMaskPolicy({ sink: "atif", config, env: { [MASK_ENV]: "preview" }, flags: { mask: "all" } }).mode, "all");
  });

  test("bad values are rejected", () => {
    assert.throws(() => resolveMaskPolicy({ sink: "otel", flags: { mask: "some" }, env: {} }), /--mask expects one of none\|preview\|all/);
    assert.throws(() => resolveMaskPolicy({ sink: "otel", flags: { "mask-style": "stars" }, env: {} }), /--mask-style/);
    assert.throws(() => resolveMaskPolicy({ sink: "otel", flags: { "mask-pattern": ["("] }, env: {} }), /invalid --mask-pattern/);
    assert.ok(!MaskConfigSchema.safeParse({ patterns: ["("] }).success);
    assert.ok(!MaskConfigSchema.safeParse({ otel: "on" }).success);
  });
});

// ---------------------------------------------------------------- capture-time: emit

describe("ach emit: default output is byte-for-byte today's", () => {
  test("otel/atif/sft with no mask flag or config equal the untouched builders (secrets included)", () => {
    const run = plantedRun();
    const events = run.events as AgentEvent[];
    const otel = cli(["emit", "--input", runFile, "--format", "otel"], baseEnv());
    assert.equal(otel.code, 0, otel.stderr);
    const want = JSON.stringify(toOtlpJson(events, { sessionId: run.sessionId as string, agentName: "claude", model: "unknown-model" }), null, 2) + "\n";
    assert.equal(stableIds(otel.stdout), stableIds(want));
    assert.equal(otel.stderr, "");

    const atif = cli(["emit", "--input", runFile, "--format", "atif"], baseEnv());
    assert.equal(atif.code, 0, atif.stderr);
    const w = AtifWriter.fromEvents(events, { agent: "claude", version: JSON.parse(atif.stdout).agent.version, modelName: "unknown-model", sessionId: run.sessionId as string });
    assert.equal(stableIds(atif.stdout), stableIds(JSON.stringify(w.toTrajectory(), null, 2) + "\n"));
    assert.ok(atif.stdout.includes(S.anthropic), "default keeps today's (unmasked) content");

    const sft = cli(["emit", "--input", runFile, "--format", "sft"], baseEnv());
    assert.equal(sft.code, 0, sft.stderr);
    const samples = turnSamples(eventsToMessages(events)).map((s) => JSON.stringify(s)).join("\n") + "\n";
    assert.equal(sft.stdout, samples);
    assert.equal(sft.stderr, "sft: 2 samples from 1/1 runs\n");
  });
});

describe("ach emit --mask all: no planted secret reaches any sink", () => {
  test("atif --out file and stdout", async () => {
    const out = path.join(tmp, "m.atif.json");
    const r = cli(["emit", "--input", runFile, "--format", "atif", "--mask", "all", "--out", out], baseEnv());
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(leaks(await fs.readFile(out, "utf8"), PLANTED_IN_RUN), []);
    assert.match(r.stderr, /mask: .*masked 8 findings \(anthropic-key 1, aws-access-key 1, email 2, github-token 1, home-path 1, private-key 1, url-credentials 1\)/);
    const s = cli(["emit", "--input", runFile, "--format", "atif", "--mask", "all"], baseEnv());
    assert.deepEqual(leaks(s.stdout, PLANTED_IN_RUN), []);
    assert.match(s.stdout, /\[REDACTED_API_KEY\]/);
  });

  test("otel span attributes (session id) are masked", () => {
    const r = cli(["emit", "--input", runFile, "--format", "otel", "--mask", "all"], baseEnv());
    assert.equal(r.code, 0, r.stderr);
    assert.ok(cli(["emit", "--input", runFile, "--format", "otel"], baseEnv()).stdout.includes(S.email), "control: today's otel carries the email");
    assert.deepEqual(leaks(r.stdout, PLANTED_IN_RUN), []);
    assert.match(r.stdout, /"gen_ai\.conversation\.id",\s*"value": \{\s*"stringValue": "\[REDACTED_EMAIL\]"/);
  });

  test("sft JSONL is masked and every line still parses", async () => {
    const out = path.join(tmp, "m.sft.jsonl");
    const r = cli(["emit", "--input", runFile, "--format", "sft", "--mask", "all", "--out", out], baseEnv());
    assert.equal(r.code, 0, r.stderr);
    const text = await fs.readFile(out, "utf8");
    assert.deepEqual(leaks(text, PLANTED_IN_RUN), []);
    for (const line of text.trim().split("\n")) {
      const s = JSON.parse(line) as { messages: Array<{ tool_calls?: Array<{ function: { arguments: string } }> }> };
      for (const m of s.messages) for (const c of m.tool_calls ?? []) JSON.parse(c.function.arguments);
    }
    assert.match(r.stderr, /mask: .*masked \d+ findings/);
  });

  test("langfuse: the POSTed body carries no planted secret; preview sends nothing", async () => {
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
      const plain = await cliAsync(["emit", "--input", runFile, "--format", "langfuse", ...lf], baseEnv());
      assert.equal(plain.code, 0, plain.stderr);
      assert.equal(bodies.length, 1);
      assert.ok(bodies[0]!.includes(S.email), "control: today's POST carries the email");
      const masked = await cliAsync(["emit", "--input", runFile, "--format", "langfuse", "--mask", "all", ...lf], baseEnv());
      assert.equal(masked.code, 0, masked.stderr);
      assert.equal(bodies.length, 2);
      assert.deepEqual(leaks(bodies[1]!, PLANTED_IN_RUN), []);
      assert.ok(bodies[1]!.includes("[REDACTED_EMAIL]"));
      const prev = await cliAsync(["emit", "--input", runFile, "--format", "langfuse", "--mask", "preview", ...lf], baseEnv());
      assert.equal(prev.code, 0, prev.stderr);
      assert.equal(bodies.length, 2, "preview must not POST");
      assert.match(prev.stdout, /nothing written or sent/);
    } finally {
      server.close();
    }
  });

  test("--mask preview lists findings, writes no --out file and prints no plaintext", async () => {
    const out = path.join(tmp, "never.json");
    const r = cli(["emit", "--input", runFile, "--format", "atif", "--mask", "preview", "--out", out], baseEnv());
    assert.equal(r.code, 0, r.stderr);
    await assert.rejects(fs.stat(out));
    assert.deepEqual(leaks(r.stdout + r.stderr, PLANTED_IN_RUN), []);
    assert.match(r.stdout, /\$\.events\[1\]\.content\tanthropic-key\tsk-ant-api\.\.\.\*\*\*\* -> \[REDACTED_API_KEY\]/);
    assert.match(r.stdout, /mask preview: .*: 8 findings/);
  });

  test("bad --mask value is a usage error", () => {
    const r = cli(["emit", "--input", runFile, "--format", "otel", "--mask", "yes"], baseEnv());
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--mask expects one of none\|preview\|all/);
  });
});

describe("config file and env: global and per-emitter toggles", () => {
  test("mask.mode all masks every emitter; mask.<sink> none opts one out; env beats the file", async () => {
    const cfg = path.join(tmp, "mask-config.json");
    await fs.writeFile(cfg, JSON.stringify({ mask: { mode: "all", atif: "none" } }));
    const env = { ...baseEnv(), AGENTIC_CODING_HARNESS_CONFIG: cfg };
    const otel = cli(["emit", "--input", runFile, "--format", "otel"], env);
    assert.equal(otel.code, 0, otel.stderr);
    assert.deepEqual(leaks(otel.stdout, PLANTED_IN_RUN), []);
    const atif = cli(["emit", "--input", runFile, "--format", "atif"], env);
    assert.ok(atif.stdout.includes(S.anthropic), "mask.atif none keeps atif unmasked");
    const envAll = cli(["emit", "--input", runFile, "--format", "atif"], { ...env, [MASK_ENV]: "all" });
    assert.deepEqual(leaks(envAll.stdout, PLANTED_IN_RUN), []);
    const flagNone = cli(["emit", "--input", runFile, "--format", "otel", "--mask", "none"], env);
    assert.ok(flagNone.stdout.includes(S.email), "--mask none beats the file");
  });

  test("config validation names bad mask keys and values; --set/--show handle mask.*", async () => {
    const dir = await fs.mkdtemp(path.join(tmp, "cfg-"));
    const cfg = path.join(dir, "c.json");
    await fs.writeFile(cfg, JSON.stringify({ mask: { mod: "all" } }));
    const bad = cli(["emit", "--input", runFile, "--format", "otel"], { ...baseEnv(), AGENTIC_CODING_HARNESS_CONFIG: cfg });
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr, /'mask' has unknown key 'mod' \(mask\.mod\) \(did you mean 'mode'\?\)/);
    await fs.writeFile(cfg, JSON.stringify({ mask: { otel: "on" } }));
    assert.match(cli(["emit", "--input", runFile, "--format", "otel"], { ...baseEnv(), AGENTIC_CODING_HARNESS_CONFIG: cfg }).stderr, /'mask\.otel'/);
    await fs.writeFile(cfg, "{}");
    const set = cli(["config", "--set", "mask.langfuse", "all"], { ...baseEnv(), AGENTIC_CODING_HARNESS_CONFIG: cfg });
    assert.equal(set.code, 0, set.stderr);
    assert.deepEqual(JSON.parse(await fs.readFile(cfg, "utf8")), { mask: { langfuse: "all" } });
    assert.match(set.stdout, /mask\.mode\s+"?none"?\s+\[default\]/);
    assert.match(set.stdout, /mask\.langfuse\s+"?all"?\s+\[file:/);
    const pat = cli(["config", "--set", "mask.patterns", "ACME-\\d+"], { ...baseEnv(), AGENTIC_CODING_HARNESS_CONFIG: cfg });
    assert.equal(pat.code, 0, pat.stderr);
    assert.deepEqual(JSON.parse(await fs.readFile(cfg, "utf8")).mask.patterns, ["ACME-\\d+"]);
    const badSet = cli(["config", "--set", "mask.mode", "sometimes"], { ...baseEnv(), AGENTIC_CODING_HARNESS_CONFIG: cfg });
    assert.notEqual(badSet.code, 0);
    const unset = cli(["config", "--unset", "mask.langfuse"], { ...baseEnv(), AGENTIC_CODING_HARNESS_CONFIG: cfg });
    assert.equal(unset.code, 0, unset.stderr);
    assert.equal(JSON.parse(await fs.readFile(cfg, "utf8")).mask.langfuse, undefined);
  });
});

// ---------------------------------------------------------------- capture-time: report + MCP

async function trialDir(): Promise<string> {
  const d = path.join(await fs.mkdtemp(path.join(tmp, "trial-")), "20260910-000000");
  await fs.mkdir(d, { recursive: true });
  const run = plantedRun();
  run.task = `deploy with ${S.anthropic} for ${S.email}`;
  await fs.writeFile(path.join(d, "claude.json"), JSON.stringify(run));
  return d;
}

describe("ach report --mask", () => {
  test("all: the HTML carries no planted secret; default: unchanged; preview: nothing written", async () => {
    const d = await trialDir();
    const plain = path.join(d, "..", "plain.html");
    assert.equal(cli(["report", d, "--out", plain], baseEnv()).code, 0);
    assert.ok((await fs.readFile(plain, "utf8")).includes(S.anthropic), "control: today's report carries the key");
    const masked = path.join(d, "..", "masked.html");
    const r = cli(["report", d, "--out", masked, "--mask", "all"], baseEnv());
    assert.equal(r.code, 0, r.stderr);
    const html = await fs.readFile(masked, "utf8");
    assert.deepEqual(leaks(html, PLANTED_IN_RUN), []);
    assert.ok(html.includes("[REDACTED_API_KEY]"));
    assert.match(r.stderr, /mask: .*masked \d+ findings/);
    const prev = path.join(d, "..", "prev.html");
    const p = cli(["report", d, "--out", prev, "--mask", "preview"], baseEnv());
    assert.equal(p.code, 0, p.stderr);
    await assert.rejects(fs.stat(prev));
    assert.match(p.stdout, /\$\.runs\[0\]\.task\tanthropic-key/);
    assert.deepEqual(leaks(p.stdout, PLANTED_IN_RUN), []);
  });
});

describe("MCP harness_emit / harness_report honor mask", () => {
  test("mask all writes a masked file; preview writes nothing and returns findings", async () => {
    const tools = new Map<string, McpToolDef>();
    const server = { registerTool: (t: McpToolDef) => void tools.set(t.name, t) } as unknown as McpServer;
    const prev = process.env.AGENTIC_CODING_HARNESS_STATE_DIR;
    const prevMask = process.env[MASK_ENV];
    delete process.env[MASK_ENV];
    try {
      registerInspectTools(server, { stateDir });
      const emit = tools.get("harness_emit")!;
      assert.ok((emit.inputSchema as { properties: Record<string, unknown> }).properties.mask);
      const out = path.join(tmp, "mcp.otel.json");
      await emit.handler({ runFile, format: "otel", out, mask: "all" });
      assert.deepEqual(leaks(await fs.readFile(out, "utf8"), PLANTED_IN_RUN), []);
      const none = path.join(tmp, "mcp.none.json");
      const pr = (await emit.handler({ runFile, format: "atif", out: none, mask: "preview" })) as { written: boolean; counts: Record<string, number> };
      assert.equal(pr.written, false);
      assert.equal(pr.counts["anthropic-key"], 1);
      await assert.rejects(fs.stat(none));
      const report = tools.get("harness_report")!;
      const d = await trialDir();
      const html = path.join(tmp, "mcp.html");
      await report.handler({ dir: d, out: html, mask: "all" });
      assert.deepEqual(leaks(await fs.readFile(html, "utf8"), PLANTED_IN_RUN), []);
    } finally {
      if (prev === undefined) delete process.env.AGENTIC_CODING_HARNESS_STATE_DIR;
      else process.env.AGENTIC_CODING_HARNESS_STATE_DIR = prev;
      if (prevMask !== undefined) process.env[MASK_ENV] = prevMask;
    }
  });
});

// ---------------------------------------------------------------- share-time: ach scrub

describe("ach scrub: share-time preview and apply over an exported artifact set", () => {
  let set: string;
  const files = ["report.html", "run.atif.json", "run.otel.json"];
  before(async () => {
    set = await fs.mkdtemp(path.join(tmp, "artifacts-"));
    // An HTML report, an ATIF export and an OTel payload, each with a planted email, key and home path.
    await fs.writeFile(
      path.join(set, "report.html"),
      `<!doctype html><html><body>\n<p>owner ${S.email}</p>\n<pre>key ${S.anthropic}</pre>\n<td>${home("/dev/app")}</td>\n</body></html>\n`,
    );
    await fs.writeFile(
      path.join(set, "run.atif.json"),
      JSON.stringify({ steps: [{ message: `mail ${S.email}` }, { tool_calls: [{ arguments: { cwd: home("/x"), key: S.awsAccess } }] }] }, null, 2) + "\n",
    );
    await fs.writeFile(
      path.join(set, "run.otel.json"),
      JSON.stringify({ resourceSpans: [{ attributes: [{ key: "gen_ai.conversation.id", value: { stringValue: `s-${S.email}` } }, { key: "x", value: { stringValue: `${S.github} at ${home()}` } }] }] }),
    );
  });

  test("preview lists every planted email, key and home path (file, location, detector, change) and alters nothing", async () => {
    const before = await Promise.all(files.map((f) => sha(path.join(set, f))));
    const r = cli(["scrub", set, "--mask", "preview"], baseEnv());
    assert.equal(r.code, 0, r.stderr);
    const rows = r.stdout.split("\n").filter((l) => l.split("\t").length === 4).map((l) => l.split("\t"));
    const has = (file: string, loc: RegExp, det: string) =>
      assert.ok(rows.some(([f, l, d, change]) => f!.endsWith(file) && loc.test(l!) && d === det && / -> \[REDACTED_/.test(change!)), `${file} ${loc} ${det}\n${r.stdout}`);
    has("report.html", /^2:\d+$/, "email");
    has("report.html", /^3:\d+$/, "anthropic-key");
    has("report.html", /^4:\d+$/, "home-path");
    has("run.atif.json", /^\$\.steps\[0\]\.message$/, "email");
    has("run.atif.json", /^\$\.steps\[1\]\.tool_calls\[0\]\.arguments\.cwd$/, "home-path");
    has("run.atif.json", /^\$\.steps\[1\]\.tool_calls\[0\]\.arguments\.key$/, "aws-access-key");
    has("run.otel.json", /resourceSpans\[0\]\.attributes\[0\]\.value\.stringValue$/, "email");
    has("run.otel.json", /resourceSpans\[0\]\.attributes\[1\]\.value\.stringValue$/, "github-token");
    has("run.otel.json", /resourceSpans\[0\]\.attributes\[1\]\.value\.stringValue$/, "home-path");
    assert.equal(rows.length, 9);
    assert.match(r.stdout, /scrub preview: 3 files, 9 findings \(anthropic-key 1, aws-access-key 1, email 3, github-token 1, home-path 3\); nothing written/);
    assert.deepEqual(leaks(r.stdout), []);
    assert.deepEqual(await Promise.all(files.map((f) => sha(path.join(set, f)))), before, "preview must not alter any file");
    assert.deepEqual((await fs.readdir(set)).sort(), [...files].sort(), "preview creates no file");
  });

  test("a clean artifact set reports zero findings", async () => {
    const clean = await fs.mkdtemp(path.join(tmp, "clean-"));
    await fs.writeFile(path.join(clean, "report.html"), "<html><body><p>2 runs, $0.12, 1234 tokens</p></body></html>\n");
    await fs.writeFile(path.join(clean, "run.atif.json"), JSON.stringify({ steps: [{ message: "hello", n: 3 }] }));
    const r = cli(["scrub", clean, "--mask", "preview", "--json"], baseEnv());
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout) as { totals: { findings: number } };
    assert.equal(j.totals.findings, 0);
  });

  test("all writes scrubbed copies to distinct paths with per-detector counts; originals stay byte-identical", async () => {
    const before = await Promise.all(files.map((f) => sha(path.join(set, f))));
    const r = cli(["scrub", set, "--mask", "all"], baseEnv());
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(await Promise.all(files.map((f) => sha(path.join(set, f)))), before, "originals byte-identical");
    const copies = ["report.masked.html", "run.atif.masked.json", "run.otel.masked.json"];
    for (const c of copies) {
      const text = await fs.readFile(path.join(set, c), "utf8");
      assert.deepEqual(leaks(text), [], c);
      if (c.endsWith(".json")) JSON.parse(text);
    }
    // Formatting of the copy follows the original (2-space ATIF, compact OTel).
    assert.match(await fs.readFile(path.join(set, "run.atif.masked.json"), "utf8"), /^\{\n {2}"steps"/);
    assert.match(r.stdout, /report\.html: 3 findings \(anthropic-key 1, email 1, home-path 1\) -> wrote .*report\.masked\.html/);
    assert.match(r.stdout, /scrub all: 3 files, 9 findings \(anthropic-key 1, aws-access-key 1, email 3, github-token 1, home-path 3\); originals unchanged/);
    // A second scan skips the .masked copies, and --out-dir mirrors the tree.
    const outDir = path.join(tmp, "scrubbed-out");
    const again = cli(["scrub", set, "--mask", "all", "--out-dir", outDir, "--json"], baseEnv());
    assert.equal(again.code, 0, again.stderr);
    assert.equal((JSON.parse(again.stdout) as { files: unknown[] }).files.length, 3);
    assert.deepEqual((await fs.readdir(outDir)).sort(), [...files].sort());
    assert.deepEqual(await Promise.all(files.map((f) => sha(path.join(set, f)))), before);
  });

  test("over artifacts the CLI itself exported (report HTML, ATIF, OTel): preview finds each planted item, all leaks none", async () => {
    const real = await fs.mkdtemp(path.join(tmp, "real-set-"));
    const d = await trialDir();
    assert.equal(cli(["report", d, "--out", path.join(real, "report.html")], baseEnv()).code, 0);
    assert.equal(cli(["emit", "--input", runFile, "--format", "atif", "--out", path.join(real, "run.atif.json")], baseEnv()).code, 0);
    const otel = cli(["emit", "--input", runFile, "--format", "otel"], baseEnv());
    await fs.writeFile(path.join(real, "run.otel.json"), otel.stdout);
    const html = await fs.readFile(path.join(real, "report.html"), "utf8");
    const inHtml = PLANTED_IN_RUN.filter((v) => html.includes(v));
    assert.ok(inHtml.includes(S.anthropic) && inHtml.includes(S.email), "control: the unmasked report carries planted values");
    const names = ["report.html", "run.atif.json", "run.otel.json"];
    const before = await Promise.all(names.map((f) => sha(path.join(real, f))));
    const p = cli(["scrub", real, "--mask", "preview", "--json"], baseEnv());
    assert.equal(p.code, 0, p.stderr);
    const pj = JSON.parse(p.stdout) as { files: Array<{ file: string; counts: Record<string, number> }> };
    const counts = (f: string) => pj.files.find((x) => x.file.endsWith(f))!.counts;
    for (const det of ["anthropic-key", "email", "github-token", "aws-access-key", "home-path", "url-credentials", "private-key"]) {
      assert.ok((counts("run.atif.json")[det] ?? 0) > 0, `atif ${det}: ${JSON.stringify(counts("run.atif.json"))}`);
    }
    // The report shows the task and summaries (not tool args): each planted value it carries is found.
    const want: Record<string, string> = { [S.anthropic]: "anthropic-key", [S.email]: "email" };
    for (const v of inHtml) assert.ok((counts("report.html")[want[v] ?? "?"] ?? 0) > 0, `report.html ${want[v]}: ${JSON.stringify(counts("report.html"))}`);
    assert.ok((counts("run.otel.json").email ?? 0) > 0, "otel session id");
    assert.deepEqual(leaks(p.stdout, PLANTED_IN_RUN), []);
    const a = cli(["scrub", real, "--mask", "all"], baseEnv());
    assert.equal(a.code, 0, a.stderr);
    assert.deepEqual(await Promise.all(names.map((f) => sha(path.join(real, f)))), before, "originals byte-identical");
    for (const c of ["report.masked.html", "run.atif.masked.json", "run.otel.masked.json"]) {
      const t = await fs.readFile(path.join(real, c), "utf8");
      assert.deepEqual(leaks(t, PLANTED_IN_RUN), [], c);
      if (c.endsWith(".json")) JSON.parse(t);
    }
  });

  test("a real report and ATIF from a clean run scrub to zero findings", async () => {
    const clean = await fs.mkdtemp(path.join(tmp, "real-clean-"));
    const td = path.join(await fs.mkdtemp(path.join(tmp, "ctrial-")), "20260910-000000");
    await fs.mkdir(td, { recursive: true });
    const run = { ...plantedRun(), sessionId: "sess-1", task: "fix the failing test", events: [
      { type: "message", source: "user", content: "fix the failing test in src/app.ts", timestamp: T0 },
      { type: "tool_call", toolCallId: "toolu_01XFDUDYJgAACzvnptvVoYEL", functionName: "bash", arguments: { cmd: "npm test" }, timestamp: T0 + 1 },
      { type: "tool_result", toolCallId: "toolu_01XFDUDYJgAACzvnptvVoYEL", content: "3 passing", timestamp: T0 + 2 },
      { type: "message", source: "assistant", content: "done", timestamp: T0 + 3 },
    ] };
    await fs.writeFile(path.join(td, "claude.json"), JSON.stringify(run));
    assert.equal(cli(["report", td, "--out", path.join(clean, "report.html")], baseEnv()).code, 0);
    assert.equal(cli(["emit", "--input", path.join(td, "claude.json"), "--format", "atif", "--out", path.join(clean, "run.atif.json")], baseEnv()).code, 0);
    const r = cli(["scrub", clean, "--mask", "preview", "--json"], baseEnv());
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout) as { totals: { findings: number; counts: Record<string, number> } };
    assert.equal(j.totals.findings, 0, JSON.stringify(j.totals.counts));
  });

  test("refuses to overwrite an input, and mode none is a usage error", async () => {
    const r = cli(["scrub", set, "--mask", "all", "--out-dir", set], baseEnv());
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /refusing to overwrite an input/);
    const none = cli(["scrub", set], baseEnv());
    assert.notEqual(none.code, 0);
    assert.match(none.stderr, /mask mode is 'none'/);
  });
});
