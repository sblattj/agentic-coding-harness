// Content-capture policy (#72): off | metadata | full, applied at RECORD time.
//
// Fixtures come from the REAL driver (createDriver + a scripted adapter +
// registry + outputDir) and the real CLI (`ach run --agent null`), so "on
// disk" means exactly what ach writes. The metadata/off proofs plant one
// unique canary in the prompt, tool args, tool result, assistant text,
// reasoning, progress, an error message, a step payload, a usage sibling and
// an unknown key, then grep EVERY file under the state dir and outputDir.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { auditRuns } from "../src/cli/audit.ts";
import { configJsonSchema, configProblems, capturePolicyFromFiles, setConfigKey, type SectionTables } from "../src/cli/config.ts";
import { frame } from "../src/cli/dash.ts";
import { verifyRunDir, verifyRunRecord } from "../src/cli/verify-run.ts";
import {
  captureEvent,
  CAPTURE_MODE_ENV,
  resolveCaptureMode,
  STRIPPED,
  type CaptureMode,
  type CapturePolicy,
} from "../src/core/capture.ts";
import { createDriver } from "../src/core/driver.ts";
import { stripChain } from "../src/core/hash-chain.ts";
import { readRunRecord, type RunRecord } from "../src/core/registry.ts";
import type { AgentAdapter, AgentEvent, AgentHandle, RunResult, RunSpec } from "../src/core/types.ts";
import { toOtlpJson } from "../src/emitters/otel.ts";
import { eventsToAsciicast } from "../src/web/asciicast.ts";
import { deriveLogs, deriveMetrics, deriveSpans } from "../src/web/derive.ts";
import { matchesSummaryQuery } from "../src/web/run-filter.ts";
import { slimRunRecord, windowRuns } from "../src/web/run-window.ts";

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;
const CANARY = "CANARY-7f3e9b2c-capture";

function runCli(args: string[], env: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  const base = { ...process.env };
  delete base[CAPTURE_MODE_ENV];
  const p = spawnSync(process.execPath, isBun ? [CLI, ...args] : ["--import", "tsx", CLI, ...args], {
    env: { ...base, ...env },
    encoding: "utf8",
  });
  return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Every regular file under `dir` whose bytes contain `needle`. */
function filesContaining(dir: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (d: string): void => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && fs.readFileSync(p).includes(needle)) hits.push(p);
    }
  };
  walk(dir);
  return hits;
}

function fileCount(dir: string): number {
  let n = 0;
  const walk = (d: string): void => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (ent.isDirectory()) walk(path.join(d, ent.name));
      else if (ent.isFile()) n++;
    }
  };
  walk(dir);
  return n;
}

type Scripted = Record<string, unknown>;

class ScriptedHandle implements AgentHandle {
  constructor(
    readonly sessionId: string,
    private readonly events: Scripted[],
    private readonly onOutput?: (chunk: string) => void,
  ) {}
  async *attach(): AsyncIterable<AgentEvent> {
    this.onOutput?.(`raw stdout ${CANARY}\n`);
    for (const e of this.events) yield { ...e, sessionId: this.sessionId, timestamp: Date.now() } as AgentEvent;
  }
  abort(): void {}
  async wait(): Promise<"success"> {
    return "success";
  }
}

class ScriptedAdapter implements AgentAdapter {
  launched: RunSpec[] = [];
  constructor(
    readonly name: string,
    private readonly events: Scripted[],
  ) {}
  async launch(spec: RunSpec): Promise<AgentHandle> {
    this.launched.push(spec);
    return new ScriptedHandle(`sess-${this.launched.length}-${Date.now()}`, this.events, (spec as { onOutput?: (c: string) => void }).onOutput);
  }
}

const SONNET = "claude-sonnet-4-5-20250929";

/** A usage event shaped like the claude adapter's (it is what audit re-derives). */
function claudeUsage(input: number, output: number): Scripted {
  const raw = { input, output, cacheRead: 0, cacheWrite: 0 };
  const data = { ...raw, reasoning: 0, models: [{ model: SONNET, ...raw, reasoning: 0 }] };
  return {
    type: "usage",
    agent: "claude",
    usage: {
      agent: "claude",
      model: SONNET,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      extra: { totalTokens: null, durationMs: null, raw: data, note: `usage sibling ${CANARY}` },
    },
    data,
  };
}

/** One canary in every content-bearing place an event can carry text. */
const CANARY_EVENTS: Scripted[] = [
  { type: "session_start", agent: "claude", model: SONNET },
  { type: "step", payload: { countsAsTurn: true, note: `step payload ${CANARY}` } },
  { type: "message", source: "agent", content: `assistant text ${CANARY}` },
  // Structural key NAMES inside content (args, output, content blocks), a
  // canary as an object key in tool output, and a number in tool output.
  {
    type: "tool_call",
    toolName: "lookup",
    callId: "call-2",
    args: { name: CANARY, id: CANARY, type: CANARY, nested: { status: CANARY, model: CANARY } },
  },
  { type: "tool_result", toolName: "lookup", callId: "call-2", output: { status: CANARY, source: CANARY, [CANARY]: 3, balance: 7_311_402 } },
  { type: "message", source: "agent", content: [{ type: "text", name: CANARY, text: CANARY }, { type: CANARY }] },
  { type: "reasoning", text: `thinking about ${CANARY}` },
  { type: "tool_call", toolName: "Bash", callId: "call-1", args: { command: `echo ${CANARY}` } },
  { type: "tool_result", toolName: "Bash", callId: "call-1", output: `${CANARY}\n`, isError: false },
  { type: "progress", text: `progress ${CANARY}` },
  { type: "custom_thing", whatever: { deep: [`unknown key ${CANARY}`] } },
  claudeUsage(1200, 340),
  { type: "error", message: `boom ${CANARY}` },
  { type: "session_end" },
];

async function driverRun(opts: {
  mode?: CaptureMode;
  policy?: CapturePolicy;
  specMode?: CaptureMode;
  events?: Scripted[];
  outputDir?: boolean;
  env?: string;
}): Promise<{ stateDir: string; outputDir?: string; rec: RunRecord; result: RunResult; adapter: ScriptedAdapter; live: AgentEvent[] }> {
  const stateDir = tmp("ach-capture-");
  const outputDir = opts.outputDir === false ? undefined : path.join(stateDir, "outdir");
  const adapter = new ScriptedAdapter("claude", opts.events ?? CANARY_EVENTS);
  const live: AgentEvent[] = [];
  const prevEnv = process.env[CAPTURE_MODE_ENV];
  if (opts.env === undefined) delete process.env[CAPTURE_MODE_ENV];
  else process.env[CAPTURE_MODE_ENV] = opts.env;
  try {
    const driver = createDriver({
      adapters: { claude: adapter },
      stateDir,
      registry: { stateDir },
      onEvent: (e) => live.push(e),
      ...(opts.mode !== undefined || opts.policy !== undefined
        ? { capture: { ...(opts.mode !== undefined ? { mode: opts.mode, modeSource: "flag" } : {}), ...(opts.policy ? { policy: opts.policy } : {}) } }
        : {}),
    });
    const result = await driver.run("claude", {
      prompt: `please handle ${CANARY} now`,
      ...(outputDir !== undefined ? { outputDir } : {}),
      ...(opts.specMode !== undefined ? { captureMode: opts.specMode } : {}),
    });
    const rec = readRunRecord(stateDir, result.runId);
    assert.ok(rec, "driver wrote a RunRecord");
    return { stateDir, ...(outputDir !== undefined ? { outputDir } : {}), rec, result, adapter, live };
  } finally {
    if (prevEnv === undefined) delete process.env[CAPTURE_MODE_ENV];
    else process.env[CAPTURE_MODE_ENV] = prevEnv;
  }
}

function transcriptEvents(rec: RunRecord): Array<Record<string, unknown>> {
  assert.ok(rec.rawTranscript, "rawTranscript recorded");
  return fs
    .readFileSync(rec.rawTranscript, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(stripChain(l)) as Record<string, unknown>)
    .filter((o) => o.type !== "ach.seal");
}

// ---------------------------------------------------------------- resolver

describe("resolveCaptureMode precedence (#72)", () => {
  it("default is full when nothing is set", () => {
    assert.deepEqual(resolveCaptureMode({ agent: "claude", env: {} }), { mode: "full", source: "default" });
  });

  it("ACH_CAPTURE_MODE sets the global tier and beats the config default", () => {
    assert.deepEqual(resolveCaptureMode({ agent: "claude", env: { ACH_CAPTURE_MODE: "metadata" }, policy: { default: "off" } }), {
      mode: "metadata",
      source: "env:ACH_CAPTURE_MODE",
    });
    assert.equal(resolveCaptureMode({ agent: "claude", env: {}, policy: { default: "off" } }).mode, "off");
  });

  it("--capture-mode beats ACH_CAPTURE_MODE, in both directions", () => {
    assert.equal(resolveCaptureMode({ agent: "claude", explicit: "full", explicitSource: "flag", env: { ACH_CAPTURE_MODE: "off" } }).mode, "full");
    assert.equal(resolveCaptureMode({ agent: "claude", explicit: "off", explicitSource: "flag", env: { ACH_CAPTURE_MODE: "full" } }).mode, "off");
  });

  it("a per-agent entry beats the flag and env, stricter AND looser", () => {
    const policy: CapturePolicy = { default: "metadata", agents: { codex: "off", claude: "full" } };
    const stricter = resolveCaptureMode({ agent: "codex", explicit: "full", explicitSource: "flag", env: { ACH_CAPTURE_MODE: "full" }, policy });
    assert.deepEqual(stricter, { mode: "off", source: "agent:codex" });
    const looser = resolveCaptureMode({ agent: "claude", explicit: "off", explicitSource: "flag", env: { ACH_CAPTURE_MODE: "off" }, policy });
    assert.deepEqual(looser, { mode: "full", source: "agent:claude" });
    // An agent without an entry falls through to the global tier.
    assert.equal(resolveCaptureMode({ agent: "gemini", env: {}, policy }).mode, "metadata");
  });

  it("a bad env value is a usage error, not a silent full", () => {
    assert.throws(() => resolveCaptureMode({ agent: "claude", env: { ACH_CAPTURE_MODE: "partial" } }), /ACH_CAPTURE_MODE must be one of off, metadata, full/);
  });
});

// ---------------------------------------------------------------- config

describe("contentCapture config (#72)", () => {
  const T = { run: {}, stats: {}, web: {}, serve: {} } as SectionTables;
  const file = (data: Record<string, unknown>) => ({ path: "/x/config.json", kind: "explicit" as const, data });

  it("accepts a bare tier and { default, agents }", () => {
    assert.deepEqual(configProblems(file({ contentCapture: "metadata" }), T), []);
    assert.deepEqual(configProblems(file({ contentCapture: { default: "off", agents: { claude: "full" } } }), T), []);
  });

  it("rejects bad tiers and unknown keys with a pointed message", () => {
    const bad = configProblems(file({ contentCapture: { default: "some", agents: { codex: "secret" }, extra: 1 } }), T);
    assert.equal(bad.length, 3, bad.join("\n"));
    assert.match(bad.join("\n"), /contentCapture\.default expects one of off, metadata, full/);
    assert.match(bad.join("\n"), /contentCapture\.agents\.codex expects/);
    assert.match(bad.join("\n"), /unknown key 'extra'/);
    assert.match(configProblems(file({ contentCapture: 3 }), T).join("\n"), /must be a tier/);
  });

  it("merges files: a later file wins per key", () => {
    const p = capturePolicyFromFiles([
      file({ contentCapture: { default: "off", agents: { claude: "metadata", codex: "off" } } }),
      file({ contentCapture: { agents: { claude: "full" } } }),
    ]);
    assert.deepEqual(p, { default: "off", agents: { claude: "full", codex: "off" } });
  });

  it("the JSON schema carries contentCapture and run.captureMode", () => {
    const schema = configJsonSchema(T) as { properties: Record<string, unknown> };
    const cc = JSON.stringify(schema.properties.contentCapture);
    assert.match(cc, /"off"/);
    assert.match(cc, /"metadata"/);
    assert.match(cc, /agents/);
    const committed = JSON.parse(fs.readFileSync(new URL("../docs/config.schema.json", import.meta.url), "utf8")) as {
      properties: Record<string, { properties?: Record<string, unknown> }>;
    };
    assert.ok(committed.properties.contentCapture, "docs/config.schema.json has contentCapture");
    assert.ok(committed.properties.run?.properties?.captureMode, "docs/config.schema.json has run.captureMode");
  });

  it("config --set contentCapture.default / .agents.<agent> builds the object", () => {
    const doc: Record<string, unknown> = { contentCapture: "metadata" };
    setConfigKey(doc, "contentCapture.agents.codex", "off", T);
    assert.deepEqual(doc.contentCapture, { default: "metadata", agents: { codex: "off" } });
    setConfigKey(doc, "contentCapture.default", "full", T);
    assert.deepEqual(doc.contentCapture, { default: "full", agents: { codex: "off" } });
    setConfigKey(doc, "contentCapture.agents.codex", undefined, T);
    assert.throws(() => setConfigKey(doc, "contentCapture.agents.codex", "partial", T), /expects one of off, metadata, full/);
    assert.throws(() => setConfigKey(doc, "contentCapture.nope", "full", T), /expected contentCapture/);
  });
});

// ---------------------------------------------------------------- driver: metadata

describe("metadata tier: 0 bytes of prompt or tool output on disk (#72)", () => {
  it("control: full mode writes the canary (the grep can fail)", async () => {
    const { stateDir } = await driverRun({});
    assert.ok(filesContaining(stateDir, CANARY).length >= 3, "full run must put the canary in transcript, events.jsonl, invocation.json");
  });

  it("no file under the state dir or outputDir holds the canary; tokens and timings survive", async () => {
    const { stateDir, outputDir, rec, result } = await driverRun({ mode: "metadata" });
    assert.ok(outputDir !== undefined && fs.existsSync(path.join(outputDir, "events.jsonl")), "outputDir was written");
    assert.ok(fileCount(stateDir) >= 6, "transcript, run record and outputDir files exist");
    assert.deepEqual(filesContaining(stateDir, CANARY), [], "canary found on disk under metadata");
    // Tokens kept, on the record and in the transcript.
    assert.equal(rec.totals?.inputTokens, 1200);
    assert.equal(rec.totals?.outputTokens, 340);
    const lines = transcriptEvents(rec);
    const usage = lines.find((l) => l.type === "usage") as { usage: { inputTokens: number; model: string } };
    assert.equal(usage.usage.inputTokens, 1200);
    assert.equal(usage.usage.model, SONNET);
    // Timings and structure kept.
    assert.ok(lines.every((l) => typeof l.timestamp === "number"), "every event keeps its timestamp");
    const byCall = (type: string, callId: string) => lines.find((l) => l.type === type && l.callId === callId) as Record<string, unknown>;
    const tool = byCall("tool_call", "call-1");
    assert.equal(tool.toolName, "Bash");
    assert.deepEqual(tool.args, { command: STRIPPED });
    assert.equal(byCall("tool_result", "call-1").output, STRIPPED);
    // Inside content, structural key names do not pass: argument and field
    // NAMES stay, every value goes, numbers included; a non-identifier key goes too.
    assert.deepEqual(byCall("tool_call", "call-2").args, { name: STRIPPED, id: STRIPPED, type: STRIPPED, nested: { status: STRIPPED, model: STRIPPED } });
    assert.equal(byCall("tool_call", "call-2").toolName, "lookup", "the event's own tool name is kept");
    assert.deepEqual(byCall("tool_result", "call-2").output, { status: STRIPPED, source: STRIPPED, [`${STRIPPED}#2`]: STRIPPED, balance: STRIPPED });
    const blocks = lines.find((l) => Array.isArray(l.content))?.content;
    assert.deepEqual(blocks, [{ type: "text", name: STRIPPED, text: STRIPPED }, { type: STRIPPED }], "block types from the closed set stay, others go");
    assert.equal(lines.length, CANARY_EVENTS.length, "metadata keeps every event (stripped)");
    assert.equal(typeof result.durationMs, "number");
    assert.ok(result.eventSummary?.latency !== undefined || result.eventSummary !== undefined, "eventSummary carried");
    // RunResult does not carry the prompt (trial cell artifacts persist it).
    assert.equal(result.prompt, undefined);
    assert.equal(result.captureMode, "metadata");
    assert.equal(JSON.stringify(result).includes(CANARY), false, "RunResult holds no content");
  });

  it("the RunRecord records the tier and its source", async () => {
    const { rec } = await driverRun({ mode: "metadata" });
    assert.equal(rec.captureMode, "metadata");
    assert.equal(rec.captureSource, "flag");
    assert.equal(rec.promptPreview, undefined);
    const full = await driverRun({});
    assert.equal(full.rec.captureMode, "full");
    assert.equal(full.rec.captureSource, "default");
  });

  it("the live onEvent tap gets the stripped form (a CLI feed can land in a log)", async () => {
    const { live } = await driverRun({ mode: "metadata" });
    assert.ok(live.length > 0);
    assert.equal(JSON.stringify(live).includes(CANARY), false);
  });

  it("the adapter sees the tier below full (the interactive .cast reads it) and not at full", async () => {
    const meta = await driverRun({ mode: "metadata" });
    assert.equal(meta.adapter.launched[0]?.captureMode, "metadata");
    const full = await driverRun({});
    assert.equal(full.adapter.launched[0]?.captureMode, undefined);
  });

  it("metadata runs still pass the seal (#59): verify-run on the record and on the outputDir", async () => {
    const { stateDir, outputDir, rec } = await driverRun({ mode: "metadata" });
    const v = verifyRunRecord(stateDir, rec);
    assert.equal(v.status, "ok", JSON.stringify(v));
    assert.equal(v.sealed, true);
    assert.equal(v.totals?.status, "match", "sealed totals match the record");
    const d = verifyRunDir(outputDir!);
    assert.equal(d.status, "ok", JSON.stringify(d));
    const audit = auditRuns({ stateDir, tolerancePct: 0 });
    assert.equal(audit.rows[0]?.status, "ok", JSON.stringify(audit.rows[0]));
  });

  it("RunSpec.captureMode beats the driver option; a per-agent policy beats both", async () => {
    const a = await driverRun({ mode: "full", specMode: "metadata" });
    assert.equal(a.rec.captureMode, "metadata");
    assert.equal(a.rec.captureSource, "spec");
    const b = await driverRun({ mode: "full", specMode: "full", policy: { agents: { claude: "off" } } });
    assert.equal(b.rec.captureMode, "off");
    assert.equal(b.rec.captureSource, "agent:claude");
    assert.deepEqual(filesContaining(b.stateDir, CANARY), []);
  });
});

// ---------------------------------------------------------------- driver: off

describe("off tier: lifecycle and token totals only (#72)", () => {
  it("transcript holds lifecycle and token lines only, the record keeps totals, nothing holds the canary", async () => {
    const { stateDir, rec } = await driverRun({ mode: "off" });
    assert.deepEqual(filesContaining(stateDir, CANARY), []);
    const lines = transcriptEvents(rec);
    assert.deepEqual(lines.map((l) => l.type), ["session_start", "usage", "error", "session_end"]);
    const usage = lines.find((l) => l.type === "usage") as { usage: { inputTokens: number; extra: { note: string } } };
    assert.equal(usage.usage.inputTokens, 1200, "the token line keeps its numbers");
    assert.equal(usage.usage.extra.note, STRIPPED, "and loses its text");
    assert.equal(rec.totals?.inputTokens, 1200, "aggregate totals kept on the RunRecord");
    assert.equal(rec.totals?.outputTokens, 340);
    assert.equal(rec.captureMode, "off");
    assert.equal(rec.lastEvent, "session_end");
  });

  it("an off run still seals, verifies and audits clean", async () => {
    const { stateDir, outputDir, rec } = await driverRun({ mode: "off" });
    const v = verifyRunRecord(stateDir, rec);
    assert.equal(v.status, "ok", JSON.stringify(v));
    assert.equal(v.sealed, true);
    assert.equal(verifyRunDir(outputDir!).status, "ok");
    const audit = auditRuns({ stateDir, tolerancePct: 0 });
    assert.equal(audit.rows[0]?.status, "ok", JSON.stringify(audit.rows[0]));
  });

  it("ach stats reports the same totals for a full, a metadata and an off run", async () => {
    const totals = [];
    for (const mode of ["full", "metadata", "off"] as const) {
      const { stateDir } = await driverRun({ mode });
      const r = runCli(["stats", "--state-only", "--json", "--offline"], { AGENTIC_CODING_HARNESS_STATE_DIR: stateDir });
      assert.equal(r.code, 0, r.stderr);
      const t = (JSON.parse(r.stdout) as { total: { records: number; inputTokens: number; outputTokens: number } }).total;
      totals.push({ records: t.records, inputTokens: t.inputTokens, outputTokens: t.outputTokens });
    }
    assert.deepEqual(totals[0], { records: 1, inputTokens: 1200, outputTokens: 340 });
    assert.deepEqual(totals[1], totals[0], "metadata");
    assert.deepEqual(totals[2], totals[0], "off");
  });

  it("captureEvent: off drops content events and strips lifecycle text", () => {
    for (const type of ["message", "reasoning", "tool_call", "tool_result", "progress", "step"]) {
      assert.equal(captureEvent("off", { type, content: CANARY } as AgentEvent), null, type);
    }
    const err = captureEvent("off", { type: "error", message: CANARY } as AgentEvent) as Record<string, unknown>;
    assert.equal(err.message, STRIPPED);
  });
});

// ---------------------------------------------------------------- default regression

describe("default stays full, byte for byte (#72)", () => {
  it("no tier set: transcript events equal the adapter's events; prompt and preview kept", async () => {
    const { rec, result, stateDir } = await driverRun({});
    const lines = transcriptEvents(rec);
    assert.equal(lines.length, CANARY_EVENTS.length);
    for (const [i, src] of CANARY_EVENTS.entries()) {
      const { sessionId: _s, timestamp: _t, ...got } = lines[i] as Record<string, unknown>;
      assert.deepEqual(got, src, `event ${i} recorded unchanged`);
    }
    assert.equal(rec.promptPreview, `please handle ${CANARY} now`);
    assert.equal(result.prompt, `please handle ${CANARY} now`);
    assert.equal(result.captureMode, undefined, "RunResult shape unchanged at full");
    assert.equal(result.eventSummary, undefined, "no eventSummary added at full");
    const out = path.join(stateDir, "outdir");
    assert.match(fs.readFileSync(path.join(out, "stdout.txt"), "utf8"), new RegExp(CANARY));
    const inv = JSON.parse(fs.readFileSync(path.join(out, "invocation.json"), "utf8")) as { prompt: string };
    assert.equal(inv.prompt, `please handle ${CANARY} now`);
  });

  it("captureEvent(full) returns the very same object", () => {
    const e = { type: "message", content: CANARY } as AgentEvent;
    assert.equal(captureEvent("full", e), e);
  });
});

// ---------------------------------------------------------------- CLI

describe("ach run --capture-mode / ACH_CAPTURE_MODE (#72)", () => {
  const prompt = `say ${CANARY}`;

  it("control: a default run puts the canary on disk", () => {
    const state = tmp("ach-capture-cli-");
    const r = runCli(["run", "--agent", "null", prompt], { AGENTIC_CODING_HARNESS_STATE_DIR: state });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(filesContaining(state, CANARY).length > 0);
  });

  for (const [label, args, env] of [
    ["--capture-mode metadata", ["--capture-mode", "metadata"], {}],
    ["ACH_CAPTURE_MODE=metadata", [], { ACH_CAPTURE_MODE: "metadata" }],
    ["ACH_CAPTURE_MODE=off", [], { ACH_CAPTURE_MODE: "off" }],
  ] as const) {
    it(`${label}: no canary under the state dir, stderr feed stripped, tier on the RunRecord`, () => {
      const state = tmp("ach-capture-cli-");
      const r = runCli(["run", "--agent", "null", ...args, prompt], { AGENTIC_CODING_HARNESS_STATE_DIR: state, ...env });
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(filesContaining(state, CANARY), []);
      assert.equal(r.stderr.includes(CANARY), false, "stderr feed carries no content");
      const [id] = fs.readdirSync(path.join(state, "runs")).filter((f) => f.endsWith(".json"));
      const rec = JSON.parse(fs.readFileSync(path.join(state, "runs", id!), "utf8")) as RunRecord;
      const want = args.length > 0 ? "metadata" : env.ACH_CAPTURE_MODE;
      assert.equal(rec.captureMode, want);
      assert.equal(rec.captureSource, args.length > 0 ? "flag" : "env:ACH_CAPTURE_MODE");
      assert.ok((rec.totals?.inputTokens ?? 0) > 0, "totals kept");
    });
  }

  it("the flag beats the env var, both directions", () => {
    for (const [flag, env] of [
      ["full", "off"],
      ["off", "full"],
    ] as const) {
      const state = tmp("ach-capture-cli-");
      const r = runCli(["run", "--agent", "null", "--capture-mode", flag, prompt], { AGENTIC_CODING_HARNESS_STATE_DIR: state, ACH_CAPTURE_MODE: env });
      assert.equal(r.code, 0, r.stderr);
      const [id] = fs.readdirSync(path.join(state, "runs"));
      const rec = JSON.parse(fs.readFileSync(path.join(state, "runs", id!), "utf8")) as RunRecord;
      assert.equal(rec.captureMode, flag, `--capture-mode ${flag} vs ACH_CAPTURE_MODE=${env}`);
    }
  });

  it("the env var beats the config file's run.captureMode and contentCapture.default", () => {
    const state = tmp("ach-capture-cli-");
    const cfg = path.join(state, "cfg.json");
    fs.writeFileSync(cfg, JSON.stringify({ run: { captureMode: "off" }, contentCapture: { default: "off" } }));
    const r = runCli(["--config", cfg, "run", "--agent", "null", prompt], { AGENTIC_CODING_HARNESS_STATE_DIR: state, ACH_CAPTURE_MODE: "full" });
    assert.equal(r.code, 0, r.stderr);
    const [id] = fs.readdirSync(path.join(state, "runs"));
    assert.equal((JSON.parse(fs.readFileSync(path.join(state, "runs", id!), "utf8")) as RunRecord).captureMode, "full");
  });

  it("a config per-agent entry beats --capture-mode for that agent", () => {
    const state = tmp("ach-capture-cli-");
    const cfg = path.join(state, "cfg.json");
    fs.writeFileSync(cfg, JSON.stringify({ contentCapture: { default: "full", agents: { null: "metadata" } } }));
    const r = runCli(["--config", cfg, "run", "--agent", "null", "--capture-mode", "full", prompt], { AGENTIC_CODING_HARNESS_STATE_DIR: state });
    assert.equal(r.code, 0, r.stderr);
    const runs = path.join(state, "runs");
    const rec = JSON.parse(fs.readFileSync(path.join(runs, fs.readdirSync(runs)[0]!), "utf8")) as RunRecord;
    assert.equal(rec.captureMode, "metadata");
    assert.equal(rec.captureSource, "agent:null");
    assert.deepEqual(filesContaining(state, CANARY).filter((f) => f !== cfg), []);
  });

  it("a bad --capture-mode is a usage error", () => {
    const state = tmp("ach-capture-cli-");
    const r = runCli(["run", "--agent", "null", "--capture-mode", "partial", prompt], { AGENTIC_CODING_HARNESS_STATE_DIR: state });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--capture-mode must be one of off, metadata, full/);
  });

  it("emit --format otel stamps ach.capture_mode from a metadata RunResult, and not from a full one", async () => {
    const meta = await driverRun({ mode: "metadata" });
    const doc = toOtlpJson(meta.result.events, { sessionId: "s", agentName: "claude", model: SONNET, captureMode: meta.result.captureMode! });
    const attrs = doc.resourceSpans[0]!.resource.attributes;
    assert.deepEqual(attrs.find((a) => a.key === "ach.capture_mode")?.value, { stringValue: "metadata" });
    const state = tmp("ach-capture-emit-");
    const input = path.join(state, "result.json");
    fs.writeFileSync(input, JSON.stringify(meta.result));
    const r = runCli(["emit", "--input", input, "--format", "otel"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /"ach\.capture_mode"/);
    const full = await driverRun({});
    fs.writeFileSync(input, JSON.stringify(full.result));
    const f = runCli(["emit", "--input", input, "--format", "otel"]);
    assert.equal(f.code, 0, f.stderr);
    assert.doesNotMatch(f.stdout, /ach\.capture_mode/, "a full export is unchanged");
  });
});

// ---------------------------------------------------------------- views

describe("web and dash views handle metadata-only and off runs (#72)", () => {
  it("dash frame, web list/window/filter and the event derivations render without throwing", async () => {
    const meta = await driverRun({ mode: "metadata" });
    const off = await driverRun({ mode: "off" });
    const recs = [meta.rec, off.rec];
    const screen = frame(recs, meta.stateDir, true, 160, false);
    assert.match(screen, /claude/);
    assert.equal(screen.includes(CANARY), false);
    for (const r of recs) {
      const slim = slimRunRecord(r);
      assert.equal(slim.runId, r.runId);
      assert.equal(matchesSummaryQuery(r, "anything"), false);
    }
    assert.equal(windowRuns(recs, { pageSize: 10 }).total, 2);
    for (const run of [meta, off]) {
      const events = transcriptEvents(run.rec) as unknown as AgentEvent[];
      assert.ok(Array.isArray(deriveSpans(events)));
      assert.ok(Array.isArray(deriveMetrics(events)));
      assert.ok(Array.isArray(deriveLogs(events)));
      assert.equal(typeof eventsToAsciicast(events), "string");
    }
  });
});

// ---------------------------------------------------------------- desks

describe("desk host events file follows the desk agent's tier (#72)", () => {
  /**
   * One in-process desk host. `viaService` sends through deskSend (a roster
   * entry and spec point at the host, as `ach desk up` writes them), so the
   * stack's messages.jsonl is written too.
   */
  async function deskRun(mode: CaptureMode | undefined, viaService = false): Promise<{ file: string; live: string; stateDir: string; messages: string }> {
    const { EchoEngine, nullMeter, runHost } = await import("../src/desks/host.ts");
    const { hostEvents, hostHealth, hostSend, hostStop } = await import("../src/desks/host-client.ts");
    const { deskPaths } = await import("../src/desks/roster.ts");
    const stateDir = tmp("ach-capture-desk-");
    const token = "c".repeat(64);
    const prev = process.env[CAPTURE_MODE_ENV];
    if (mode === undefined) delete process.env[CAPTURE_MODE_ENV];
    else process.env[CAPTURE_MODE_ENV] = mode;
    let url = "";
    const done = runHost(
      {
        stack: "cap", stateDir, name: "ALPHA", kind: "desk", role: "orchestrator", roleFiles: [], agent: "claude",
        engine: "driver", mcps: [], port: 0, cwd: stateDir, runId: "run_cap_1", token,
      },
      { createEngine: async () => new EchoEngine(10), createHostMeter: () => nullMeter(), installSignals: false, onReady: (i) => (url = i.url) },
    );
    if (prev === undefined) delete process.env[CAPTURE_MODE_ENV];
    else process.env[CAPTURE_MODE_ENV] = prev;
    const t = { url: "", token };
    const deadline = Date.now() + 5000;
    try {
      while (!(url !== "" && (await hostHealth(url))?.state === "idle")) {
        if (Date.now() > deadline) throw new Error("desk host never idle");
        await new Promise((r) => setTimeout(r, 15));
      }
      t.url = url;
      if (viaService) {
        const { deskSend } = await import("../src/desks/service.ts");
        const p = deskPaths(stateDir, "cap");
        fs.mkdirSync(p.specs, { recursive: true });
        fs.writeFileSync(path.join(p.specs, "ALPHA.json"), JSON.stringify({ runId: "run_cap_1", token }));
        const entry = {
          name: "ALPHA", kind: "desk", role: "orchestrator", agent: "claude", engine: "driver", mcps: [],
          port: Number(new URL(url).port), url, pid: process.pid, runId: "run_cap_1", startedAt: Date.now(),
        };
        fs.writeFileSync(p.roster, JSON.stringify({ version: 1, stack: "cap", portBase: 4800, entries: { ALPHA: entry } }));
        if (mode === undefined) delete process.env[CAPTURE_MODE_ENV];
        else process.env[CAPTURE_MODE_ENV] = mode;
        try {
          const m = await deskSend({ stateDir, stack: "cap", from: "human", to: "ALPHA", text: `hello ${CANARY}` });
          assert.equal(m.text, `hello ${CANARY}`, "the caller still gets its own message back");
        } finally {
          if (prev === undefined) delete process.env[CAPTURE_MODE_ENV];
          else process.env[CAPTURE_MODE_ENV] = prev;
        }
      } else {
        await hostSend(t, "human", `hello ${CANARY}`);
      }
      while (!(await hostEvents(t, 0)).some((e) => e.type === "turn_end")) {
        if (Date.now() > deadline) throw new Error("no turn_end");
        await new Promise((r) => setTimeout(r, 15));
      }
      const live = JSON.stringify(await hostEvents(t, 0));
      const msgs = deskPaths(stateDir, "cap").messages;
      return {
        file: fs.readFileSync(path.join(deskPaths(stateDir, "cap").events, "run_cap_1.jsonl"), "utf8"),
        live,
        stateDir,
        messages: fs.existsSync(msgs) ? fs.readFileSync(msgs, "utf8") : "",
      };
    } finally {
      if (t.url !== "") await hostStop(t);
      assert.equal(await done, 0);
    }
  }

  it("full (control): the events file holds the message text", async () => {
    const { file } = await deskRun(undefined);
    assert.match(file, new RegExp(CANARY));
  });

  it("metadata: the events file holds no text, the live feed still does", async () => {
    const { file, live } = await deskRun("metadata");
    assert.equal(file.includes(CANARY), false, "desk events file leaked content");
    assert.match(file, /"type":"turn_end"/);
    assert.match(live, new RegExp(CANARY), "the live desk conversation keeps its text");
  });

  it("deskSend: messages.jsonl follows the recipient's tier; nothing under the desks state dir holds the text", async () => {
    const full = await deskRun(undefined, true);
    assert.match(full.messages, new RegExp(CANARY), "control: a full desk logs the message text");
    const meta = await deskRun("metadata", true);
    const line = JSON.parse(meta.messages.trim()) as { from: string; to: string; text: string; id: string };
    assert.deepEqual([line.from, line.to, line.text], ["human", "ALPHA", STRIPPED]);
    assert.ok(line.id !== "", "routing fields kept");
    assert.deepEqual(filesContaining(meta.stateDir, CANARY), [], "no desk file holds the text");
    assert.match(meta.live, new RegExp(CANARY), "the live conversation keeps it");
  });

  it("a spawned `ach desk host` reads contentCapture.agents from the config file (process level)", async () => {
    const { spawn } = await import("node:child_process");
    const net = await import("node:net");
    const { hostEvents, hostHealth, hostSend, hostStop } = await import("../src/desks/host-client.ts");
    const { deskPaths } = await import("../src/desks/roster.ts");
    const freePort = () =>
      new Promise<number>((res) => {
        const srv = net.createServer().listen(0, "127.0.0.1", () => {
          const p = (srv.address() as { port: number }).port;
          srv.close(() => res(p));
        });
      });
    const hostRun = async (withConfig: boolean): Promise<string> => {
      const stateDir = tmp("ach-capture-deskproc-");
      const token = "d".repeat(64);
      const port = await freePort();
      const specFile = path.join(stateDir, "spec.json");
      fs.writeFileSync(specFile, JSON.stringify({
        stack: "cap", stateDir, name: "ALPHA", kind: "desk", role: "orchestrator", roleFiles: [], agent: "claude",
        engine: "driver", mcps: [], port, cwd: stateDir, runId: "run_cap_p", token,
      }));
      const cfg = path.join(stateDir, "cfg.json");
      fs.writeFileSync(cfg, JSON.stringify({ contentCapture: { agents: { claude: "metadata" } } }));
      const isBun = (process.versions as { bun?: string }).bun !== undefined;
      const argv = [...(withConfig ? ["--config", cfg] : []), "desk", "host", "--spec", specFile];
      const env: Record<string, string | undefined> = { ...process.env, ACH_DESK_FAKE_ENGINE: "1", AGENTIC_CODING_HARNESS_STATE_DIR: stateDir };
      delete env[CAPTURE_MODE_ENV];
      delete env.AGENTIC_CODING_HARNESS_CONFIG;
      // cwd is the scratch dir (as `ach desk up` would give it), so tsx must be an absolute import.
      const child = spawn(process.execPath, isBun ? [CLI, ...argv] : ["--import", import.meta.resolve("tsx"), CLI, ...argv], { env, cwd: stateDir, stdio: "ignore" });
      const t = { url: `http://127.0.0.1:${port}`, token };
      try {
        const deadline = Date.now() + 15000;
        while ((await hostHealth(t.url).catch(() => null))?.state !== "idle") {
          if (Date.now() > deadline) throw new Error("spawned desk host never idle");
          await new Promise((r) => setTimeout(r, 50));
        }
        await hostSend(t, "human", `hello ${CANARY}`);
        while (!(await hostEvents(t, 0)).some((e) => e.type === "turn_end")) {
          if (Date.now() > deadline) throw new Error("no turn_end");
          await new Promise((r) => setTimeout(r, 30));
        }
        await hostStop(t);
        await new Promise<void>((r) => (child.exitCode !== null ? r() : child.once("exit", () => r())));
        return fs.readFileSync(path.join(deskPaths(stateDir, "cap").events, "run_cap_p.jsonl"), "utf8");
      } finally {
        if (child.exitCode === null) child.kill();
      }
    };
    assert.match(await hostRun(false), new RegExp(CANARY), "control: no config, the events file holds the text");
    const file = await hostRun(true);
    assert.equal(file.includes(CANARY), false, "the config's per-agent tier reached the spawned host");
    assert.match(file, /"type":"turn_end"/);
  });

  it("off: the events file holds lifecycle types only", async () => {
    const { file } = await deskRun("off");
    assert.equal(file.includes(CANARY), false);
    const types = new Set(file.trim().split("\n").map((l) => (JSON.parse(l) as { type: string }).type));
    for (const t of types) assert.ok(["status", "error", "turn_start", "turn_end", "usage"].includes(t), `unexpected ${t}`);
  });
});

// ---------------------------------------------------------------- trial

describe("ach trial --capture-mode (#72)", () => {
  it("createMatrixDriver applies the tier to every cell's run", async () => {
    const { createMatrixDriver } = await import("../src/cli/trial-matrix.ts");
    const stateDir = tmp("ach-capture-trial-");
    const driver = await createMatrixDriver(["null"], stateDir, { mode: "metadata", modeSource: "flag" });
    const result = await driver.run("null", { prompt: `cell ${CANARY}` });
    assert.equal(readRunRecord(stateDir, result.runId)?.captureMode, "metadata");
    assert.deepEqual(filesContaining(stateDir, CANARY), []);
  });

  it("a provider limit below full still classifies the cell skipped-provider-limit (the text is stripped, the verdict is not)", async () => {
    const { expandMatrix, parseMatrixPlan, readLedger, runMatrix } = await import("../src/cli/trial-matrix.ts");
    const limitEvents: Scripted[] = [
      { type: "session_start", agent: "claude", model: SONNET },
      { type: "error", message: "claude exited 1", data: { stderrTail: `API Error: 429 rate_limit_error: You have hit your session limit ${CANARY}` } },
      { type: "session_end" },
    ];
    const full = await driverRun({ events: limitEvents });
    assert.equal(full.result.providerLimit, undefined, "full RunResult shape unchanged");
    const meta = await driverRun({ mode: "metadata", events: limitEvents });
    assert.equal(meta.result.providerLimit, true);
    assert.equal(JSON.stringify(meta.result).includes(CANARY), false, "the verdict carries no text");
    const dir = tmp("ach-capture-limit-");
    const cells = expandMatrix(parseMatrixPlan({ experiment: "e", agents: ["claude"], tasks: [{ id: "a", prompt: "p" }] }), dir);
    const ledgerPath = path.join(dir, "plan.ledger.jsonl");
    const s = await runMatrix({ cells, ledgerPath, driver: { run: async () => ({ ...meta.result, exitStatus: "error" }) }, stateDir: meta.stateDir });
    assert.equal(s.providerLimited, 1);
    const row = readLedger(ledgerPath).rows[0]!;
    assert.equal(row.status, "skipped-provider-limit");
    assert.match(row.error ?? "", /^provider limit: .*capture mode metadata/);
  });

  it("ach --config <file> trial --matrix: the file's per-agent tier reaches every cell (process level)", () => {
    const state = tmp("ach-capture-trialcli-");
    const plan = path.join(state, "plan.json");
    fs.writeFileSync(plan, JSON.stringify({ experiment: "cap", agents: ["null"], tasks: [{ id: "a", prompt: `cell ${CANARY}` }] }));
    const cfg = path.join(state, "cfg.json");
    fs.writeFileSync(cfg, JSON.stringify({ contentCapture: { agents: { null: "off" } } }));
    const r = runCli(["--config", cfg, "trial", "--matrix", plan], { AGENTIC_CODING_HARNESS_STATE_DIR: state });
    assert.equal(r.code, 0, r.stderr);
    const runs = path.join(state, "runs");
    const recs = fs.readdirSync(runs).map((f) => JSON.parse(fs.readFileSync(path.join(runs, f), "utf8")) as RunRecord);
    assert.equal(recs.length, 1);
    assert.deepEqual([recs[0]!.captureMode, recs[0]!.captureSource], ["off", "agent:null"]);
    assert.ok(fs.readdirSync(runs).length > 0 && fileCount(state) > 3, "the trial wrote records and a ledger");
    assert.deepEqual(filesContaining(state, CANARY).filter((f) => f !== plan), [], "only the plan (an input) holds the prompt");
  });

  it("a bad --capture-mode is a usage error before any cell runs", () => {
    const r = runCli(["trial", "--matrix", "/nonexistent/plan.json", "--capture-mode", "partial"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--capture-mode must be one of off, metadata, full/);
  });
});
