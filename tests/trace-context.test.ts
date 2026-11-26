// W3C trace-context propagation (#73): parse/validate TRACEPARENT, stamp the
// run's trace on RunRecord + RunResult, hand every agent child a TRACEPARENT
// naming the run's span, and make the OTel / Langfuse exports adopt the ids.
// Agent children are a FAKE CLI (a node script that echoes its env); no
// network, no real agent.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createContext, runInContext, runInNewContext } from "node:vm";
import { readFileSync } from "node:fs";

import { CUSTOM_AGENT, createCustomAdapter } from "../src/adapters/custom.ts";
import { createDriver } from "../src/core/driver.ts";
import { listRunRecords } from "../src/core/registry.ts";
import {
  childTraceEnv,
  formatTraceparent,
  parseTraceparent,
  readRunTraceContext,
  resolveRunTraceContext,
  withRunTrace,
  type RunTraceContext,
} from "../src/core/trace-context.ts";
import { createTracer, emitRun, toOtlpJson } from "../src/emitters/otel.ts";
import { emitToLangfuse, toLangfuseOtlpJson } from "../src/emitters/langfuse.ts";
import { runOnce } from "../src/cli/trials.ts";

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;
const NODE = process.execPath;

const UP_TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const UP_PARENT = "00f067aa0ba902b7";
const UPSTREAM = `00-${UP_TRACE}-${UP_PARENT}-01`;

/** Fake agent CLI: prints the trace env it was launched with as one JSON line. */
const FAKE_CLI = `
process.stdout.write(JSON.stringify({
  type: 'result',
  traceparent: process.env.TRACEPARENT ?? null,
  tracestate: process.env.TRACESTATE || null, // empty = none (W3C)
}) + '\\n');
`;

/** Fake checker: writes the TRACEPARENT it saw to the file named by argv. */
const FAKE_CHECKER = `require('node:fs').writeFileSync(process.argv[2], process.env.TRACEPARENT ?? 'none');`;

let tmp: string;
let fake: string;
let checker: string;
let workspace: string;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ach-trace-"));
  fake = path.join(tmp, "fake-cli.mjs");
  checker = path.join(tmp, "checker.cjs");
  await fs.writeFile(fake, FAKE_CLI);
  await fs.writeFile(checker, FAKE_CHECKER);
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ach-trace-ws-"));
});

after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.rm(workspace, { recursive: true, force: true });
});

function echoed(events: Array<Record<string, unknown>>): { traceparent: string | null; tracestate: string | null } {
  for (const e of [...events].reverse()) {
    if (e.type !== "message" || typeof e.content !== "string") continue;
    try {
      const o = JSON.parse(e.content) as { type?: string };
      if (o.type === "result") return o as { traceparent: string | null; tracestate: string | null };
    } catch {
      /* not the echo line */
    }
  }
  throw new Error(`no echo line among events: ${JSON.stringify(events)}`);
}

function runCli(args: string[], env: Record<string, string | undefined>, cwd?: string) {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  const merged: Record<string, string | undefined> = { ...process.env };
  delete merged.TRACEPARENT;
  delete merged.TRACESTATE;
  Object.assign(merged, env);
  const p = spawnSync(NODE, isBun ? [CLI, ...args] : ["--import", import.meta.resolve("tsx"), CLI, ...args], {
    env: merged as NodeJS.ProcessEnv,
    encoding: "utf8",
    ...(cwd !== undefined ? { cwd } : {}),
  });
  return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

function fakeDriver(stateDir: string) {
  const adapter = createCustomAdapter({ name: CUSTOM_AGENT, template: `'${NODE}' '${fake}' {prompt}` });
  return createDriver({ adapters: { custom: adapter }, stateDir, registry: { stateDir } });
}

function spansOf(doc: { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<Record<string, unknown>> }> }> }) {
  return doc.resourceSpans[0]!.scopeSpans[0]!.spans as Array<{ traceId: string; spanId: string; parentSpanId?: string; name: string }>;
}

describe("parseTraceparent (W3C Trace Context level 1)", () => {
  it("accepts the spec example and returns its fields", () => {
    assert.deepEqual(parseTraceparent(UPSTREAM), { version: "00", traceId: UP_TRACE, parentId: UP_PARENT, traceFlags: "01" });
    assert.equal(parseTraceparent(`00-${UP_TRACE}-${UP_PARENT}-00`)?.traceFlags, "00");
  });
  it("rejects malformed values", () => {
    const bad = [
      "",
      "garbage",
      `00-${UP_TRACE.toUpperCase()}-${UP_PARENT}-01`, // uppercase hex
      `00-${"0".repeat(32)}-${UP_PARENT}-01`, // all-zero trace id
      `00-${UP_TRACE}-${"0".repeat(16)}-01`, // all-zero parent id
      `ff-${UP_TRACE}-${UP_PARENT}-01`, // forbidden version
      `00-${UP_TRACE}-${UP_PARENT}-01-extra`, // version 00 must be exactly 55 chars
      `00-${UP_TRACE.slice(1)}-${UP_PARENT}-01`, // short trace id
      `00-${UP_TRACE}-${UP_PARENT}-1`, // short flags
      `00_${UP_TRACE}_${UP_PARENT}_01`, // wrong separator
    ];
    for (const b of bad) assert.equal(parseTraceparent(b), null, b);
  });
  it("a higher version is parsed by its first four fields (forward compatibility)", () => {
    assert.equal(parseTraceparent(`01-${UP_TRACE}-${UP_PARENT}-01-future`)?.traceId, UP_TRACE);
    assert.equal(parseTraceparent(`01-${UP_TRACE}-${UP_PARENT}-01x`), null);
  });
});

describe("resolveRunTraceContext", () => {
  it("adopts a valid incoming TRACEPARENT and TRACESTATE, with a new span id for the run", () => {
    const { trace, warning } = resolveRunTraceContext({ TRACEPARENT: UPSTREAM, TRACESTATE: "vendor=abc" });
    assert.equal(warning, undefined);
    assert.equal(trace.traceId, UP_TRACE);
    assert.equal(trace.parentSpanId, UP_PARENT);
    assert.match(trace.spanId, /^[0-9a-f]{16}$/);
    assert.notEqual(trace.spanId, UP_PARENT);
    assert.equal(trace.traceFlags, "01");
    assert.equal(trace.traceState, "vendor=abc");
    assert.equal(trace.source, "env");
    assert.deepEqual(childTraceEnv(trace), { TRACEPARENT: `00-${UP_TRACE}-${trace.spanId}-01`, TRACESTATE: "vendor=abc" });
  });
  it("no incoming context: generates a valid sampled trace with no parent", () => {
    const { trace, warning } = resolveRunTraceContext({});
    assert.equal(warning, undefined);
    assert.match(trace.traceId, /^[0-9a-f]{32}$/);
    assert.notEqual(trace.traceId, "0".repeat(32));
    assert.equal(trace.parentSpanId, undefined);
    assert.equal(trace.source, "generated");
    assert.ok(parseTraceparent(formatTraceparent(trace)), "the run's own traceparent is valid W3C");
  });
  it("invalid TRACEPARENT: fresh trace, one warning, TRACESTATE dropped", () => {
    const { trace, warning } = resolveRunTraceContext({ TRACEPARENT: "00-nope", TRACESTATE: "vendor=abc" });
    assert.match(warning ?? "", /invalid TRACEPARENT/);
    assert.notEqual(trace.traceId, UP_TRACE);
    assert.equal(trace.traceState, undefined);
    assert.equal(trace.source, "generated");
  });
  it("readRunTraceContext accepts a stored trace and ignores junk", () => {
    const { trace } = resolveRunTraceContext({ TRACEPARENT: UPSTREAM });
    assert.deepEqual(readRunTraceContext(JSON.parse(JSON.stringify(trace))), trace);
    assert.equal(readRunTraceContext(undefined), undefined);
    assert.equal(readRunTraceContext({ traceId: "x" }), undefined);
  });
  it("withRunTrace overrides an inherited TRACEPARENT and TRACESTATE", () => {
    const { trace } = resolveRunTraceContext({});
    const env = withRunTrace({ PATH: "/bin", TRACEPARENT: UPSTREAM, TRACESTATE: "old=1" }, trace);
    assert.equal(env.TRACEPARENT, formatTraceparent(trace));
    assert.equal(env.TRACESTATE, undefined);
    assert.equal(env.PATH, "/bin");
  });
});

describe("driver: adapter child processes get the run's TRACEPARENT", () => {
  it("incoming TRACEPARENT: the child sees the upstream trace id with the RUN's span as parent; record + result carry it", async () => {
    const stateDir = await fs.mkdtemp(path.join(tmp, "state-"));
    const res = await fakeDriver(stateDir).run("custom", {
      prompt: "hi",
      cwd: workspace,
      env: { TRACEPARENT: UPSTREAM, TRACESTATE: "vendor=abc" },
    });
    assert.equal(res.exitStatus, "success", res.warnings.join("\n"));
    const seen = echoed(res.events as Array<Record<string, unknown>>);
    const trace = res.trace!;
    assert.ok(trace, "RunResult.trace is set");
    assert.equal(trace.traceId, UP_TRACE);
    assert.equal(trace.parentSpanId, UP_PARENT);
    assert.equal(seen.traceparent, `00-${UP_TRACE}-${trace.spanId}-01`);
    assert.notEqual(seen.traceparent, UPSTREAM, "the child must not inherit the upstream value unchanged");
    assert.equal(seen.tracestate, "vendor=abc");
    const [rec] = listRunRecords(stateDir);
    assert.deepEqual(rec?.trace, trace, "RunRecord.trace matches RunResult.trace");
  });

  it("no incoming TRACEPARENT: the child sees the generated trace and run span", async () => {
    const stateDir = await fs.mkdtemp(path.join(tmp, "state-"));
    const res = await fakeDriver(stateDir).run("custom", { prompt: "hi", cwd: workspace, env: { TRACEPARENT: "" } });
    const seen = echoed(res.events as Array<Record<string, unknown>>);
    assert.equal(res.trace?.source, "generated");
    assert.equal(seen.traceparent, formatTraceparent(res.trace!));
    assert.equal(seen.tracestate, null);
  });

  it("scrubEnv: true still passes TRACEPARENT (it is not a credential)", async () => {
    const stateDir = await fs.mkdtemp(path.join(tmp, "state-"));
    const res = await fakeDriver(stateDir).run("custom", {
      prompt: "hi",
      cwd: workspace,
      env: { TRACEPARENT: UPSTREAM },
      sandbox: { scrubEnv: true },
    });
    assert.equal(echoed(res.events as Array<Record<string, unknown>>).traceparent, formatTraceparent(res.trace!));
  });

  it("invalid incoming TRACEPARENT: exactly one run warning and a fresh trace in the child", async () => {
    const stateDir = await fs.mkdtemp(path.join(tmp, "state-"));
    const res = await fakeDriver(stateDir).run("custom", {
      prompt: "hi",
      cwd: workspace,
      env: { TRACEPARENT: "00-not-a-trace-01", TRACESTATE: "vendor=abc" },
    });
    assert.equal(res.warnings.filter((w) => /TRACEPARENT/.test(w)).length, 1, res.warnings.join("\n"));
    const seen = echoed(res.events as Array<Record<string, unknown>>);
    assert.equal(seen.traceparent, formatTraceparent(res.trace!));
    assert.equal(seen.tracestate, null, "tracestate is dropped with an invalid traceparent");
  });

  it("the post-run --verify checker also gets the run's TRACEPARENT", async () => {
    const stateDir = await fs.mkdtemp(path.join(tmp, "state-"));
    const out = path.join(tmp, `checker-${Date.now()}.txt`);
    const outcome = await runOnce({
      driver: fakeDriver(stateDir),
      agent: "custom",
      spec: { prompt: "hi", cwd: workspace, env: { TRACEPARENT: UPSTREAM } },
      stateDir,
      verify: { command: `'${NODE}' '${checker}' '${out}'`, cwd: workspace, env: { ...process.env, TRACEPARENT: UPSTREAM } },
    } as never);
    assert.equal(await fs.readFile(out, "utf8"), formatTraceparent(outcome.result!.trace!));
  });
});

describe("exports adopt the stored ids", () => {
  const events = [
    { type: "usage", timestamp: 1000, usage: { agent: "claude", model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    { type: "tool_call", toolCallId: "c1", functionName: "Read", arguments: {}, timestamp: 2000 },
    { type: "tool_result", toolCallId: "c1", content: "ok", timestamp: 3000 },
  ] as never;
  const trace: RunTraceContext = { traceId: UP_TRACE, spanId: "b7ad6b7169203331", parentSpanId: UP_PARENT, traceFlags: "01", source: "env" };

  it("toOtlpJson: upstream trace id on every span, root = run span parented to upstream, children under root", () => {
    const spans = spansOf(toOtlpJson(events, { sessionId: "s", agentName: "claude", model: "m", trace }) as never);
    assert.ok(spans.length >= 3);
    for (const s of spans) assert.equal(s.traceId, UP_TRACE);
    assert.equal(spans[0]!.spanId, trace.spanId);
    assert.equal(spans[0]!.parentSpanId, UP_PARENT);
    for (const s of spans.slice(1)) assert.equal(s.parentSpanId, trace.spanId);
  });

  it("toOtlpJson: a generated (root) trace has no parent on the root span", () => {
    const own: RunTraceContext = { traceId: UP_TRACE, spanId: "b7ad6b7169203331", traceFlags: "01", source: "generated" };
    const spans = spansOf(toOtlpJson(events, { sessionId: "s", agentName: "claude", model: "m", trace: own }) as never);
    assert.equal(spans[0]!.spanId, own.spanId);
    assert.equal(spans[0]!.parentSpanId, undefined);
  });

  it("emitRun (live tracer): an upstream parent puts every span in the upstream trace; no parent = fresh ids as before", async () => {
    const { tracer, shutdown } = createTracer({ register: false, endpoint: "http://127.0.0.1:9/v1/traces" });
    const parentOf = (sp: unknown) => (sp as { parentSpanContext?: { spanId: string } }).parentSpanContext?.spanId;
    try {
      const linked = emitRun(tracer, { events, sessionId: "s", agentName: "claude", model: "m", trace });
      assert.equal(linked.root.spanContext().traceId, UP_TRACE);
      assert.equal(parentOf(linked.root), UP_PARENT);
      for (const sp of linked.spans) assert.equal(sp.spanContext().traceId, UP_TRACE);
      const own: RunTraceContext = { traceId: UP_TRACE, spanId: "b7ad6b7169203331", traceFlags: "01", source: "generated" };
      const fresh = emitRun(tracer, { events, sessionId: "s", agentName: "claude", model: "m", trace: own });
      assert.notEqual(fresh.root.spanContext().traceId, UP_TRACE);
      assert.equal(parentOf(fresh.root), undefined);
    } finally {
      await shutdown().catch(() => {});
    }
  });

  it("Langfuse payload and POST adopt the same ids", async () => {
    const spans = spansOf(toLangfuseOtlpJson(events, { sessionId: "s", agentName: "claude", model: "m", trace }) as never);
    for (const s of spans) assert.equal(s.traceId, UP_TRACE);
    assert.equal(spans[0]!.spanId, trace.spanId);
    assert.equal(spans[0]!.parentSpanId, UP_PARENT);
    let posted = "";
    const result = await emitToLangfuse(events, {
      baseUrl: "http://lf.invalid",
      publicKey: "pk",
      secretKey: "sk",
      sessionId: "s",
      agentName: "claude",
      model: "m",
      trace,
      fetchImpl: (async (_u: unknown, init: { body: string }) => {
        posted = init.body;
        return new Response("{}", { status: 200 });
      }) as never,
    });
    assert.equal(result.traceId, UP_TRACE);
    assert.match(posted, new RegExp(`"parentSpanId":"${UP_PARENT}"`));
  });
});

describe("CLI end to end: TRACEPARENT -> ach run -> ach emit", () => {
  it("run --json stamps the trace, the summary prints the traceparent, emit otel adopts it", async () => {
    const stateDir = await fs.mkdtemp(path.join(tmp, "cli-state-"));
    const env = { AGENTIC_CODING_HARNESS_STATE_DIR: stateDir, TRACEPARENT: UPSTREAM };
    const tmpl = `'${NODE}' '${fake}' {prompt}`;
    const run = runCli(["run", "--agent", "custom", "--template", tmpl, "--json", "hello"], env, workspace);
    assert.equal(run.code, 0, run.stderr);
    const result = JSON.parse(run.stdout) as { trace: RunTraceContext; events: Array<Record<string, unknown>> };
    assert.equal(result.trace.traceId, UP_TRACE);
    assert.equal(result.trace.parentSpanId, UP_PARENT);
    assert.equal(echoed(result.events).traceparent, `00-${UP_TRACE}-${result.trace.spanId}-01`);

    const file = path.join(tmp, "run.json");
    await fs.writeFile(file, run.stdout);
    const emit = runCli(["emit", "--format", "otel", "--input", file], { AGENTIC_CODING_HARNESS_STATE_DIR: stateDir });
    assert.equal(emit.code, 0, emit.stderr);
    const spans = spansOf(JSON.parse(emit.stdout));
    for (const s of spans) assert.equal(s.traceId, UP_TRACE);
    assert.equal(spans[0]!.spanId, result.trace.spanId);
    assert.equal(spans[0]!.parentSpanId, UP_PARENT);

    const human = runCli(["run", "--agent", "custom", "--template", tmpl, "again"], env, workspace);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, new RegExp(`^trace {6}00-${UP_TRACE}-[0-9a-f]{16}-01 \\(child of upstream span ${UP_PARENT}\\)$`, "m"));
    const recs = listRunRecords(stateDir);
    assert.equal(recs.length, 2);
    for (const r of recs) assert.equal(r.trace?.traceId, UP_TRACE);
  });

  it("an invalid TRACEPARENT prints exactly one stderr warning and still runs", async () => {
    const stateDir = await fs.mkdtemp(path.join(tmp, "cli-state-"));
    const run = runCli(
      ["run", "--agent", "custom", "--template", `'${NODE}' '${fake}' {prompt}`, "--json", "hello"],
      { AGENTIC_CODING_HARNESS_STATE_DIR: stateDir, TRACEPARENT: "zz-bad" },
      workspace,
    );
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.stderr.split("\n").filter((l) => /TRACEPARENT/.test(l)).length, 1, run.stderr);
    const result = JSON.parse(run.stdout) as { trace: RunTraceContext };
    assert.equal(result.trace.source, "generated");
  });

  it("an inherited TRACESTATE never reaches the child without a valid TRACEPARENT (process env, not spec env)", async () => {
    const stateDir = await fs.mkdtemp(path.join(tmp, "cli-state-"));
    const tmpl = `'${NODE}' '${fake}' {prompt}`;
    for (const extra of [{ TRACEPARENT: "zz-bad" }, {}]) {
      const run = runCli(["run", "--agent", "custom", "--template", tmpl, "--json", "hello"], { AGENTIC_CODING_HARNESS_STATE_DIR: stateDir, TRACESTATE: "vendor=abc", ...extra }, workspace);
      assert.equal(run.code, 0, run.stderr);
      const result = JSON.parse(run.stdout) as { trace: RunTraceContext; events: Array<Record<string, unknown>> };
      const seen = echoed(result.events);
      assert.equal(seen.tracestate, null, `TRACESTATE leaked with ${JSON.stringify(extra)}`);
      assert.equal(seen.traceparent, `00-${result.trace.traceId}-${result.trace.spanId}-01`);
    }
    // And a valid upstream keeps its tracestate on the same path.
    const ok = runCli(["run", "--agent", "custom", "--template", tmpl, "--json", "hello"], { AGENTIC_CODING_HARNESS_STATE_DIR: stateDir, TRACEPARENT: UPSTREAM, TRACESTATE: "vendor=abc" }, workspace);
    assert.equal(echoed((JSON.parse(ok.stdout) as { events: Array<Record<string, unknown>> }).events).tracestate, "vendor=abc");
  });

  it("ach dash --json and GET /api/runs (what ach web renders) carry the stored trace", async () => {
    const stateDir = await fs.mkdtemp(path.join(tmp, "cli-state-"));
    const run = runCli(["run", "--agent", "custom", "--template", `'${NODE}' '${fake}' {prompt}`, "--json", "hello"], { AGENTIC_CODING_HARNESS_STATE_DIR: stateDir, TRACEPARENT: UPSTREAM }, workspace);
    assert.equal(run.code, 0, run.stderr);
    const result = JSON.parse(run.stdout) as { runId: string; trace: RunTraceContext };

    const dash = runCli(["dash", "--json", "--state-only", "--state-dir", stateDir], {});
    assert.equal(dash.code, 0, dash.stderr);
    const dashRec = (JSON.parse(dash.stdout) as Array<{ runId: string; trace?: RunTraceContext }>).find((r) => r.runId === result.runId);
    assert.deepEqual(dashRec?.trace, result.trace);

    const isBun = (process.versions as { bun?: string }).bun !== undefined;
    const runner = new URL("./helpers/web-server-runner.ts", import.meta.url).pathname;
    const child = spawn(NODE, isBun ? [runner, stateDir, ""] : ["--import", import.meta.resolve("tsx"), runner, stateDir, ""], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      child.stdout!.setEncoding("utf8");
      let out = "";
      const port = await new Promise<number>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("server never ready")), 20_000);
        child.stdout!.on("data", (c: string) => {
          out += c;
          const m = /READY (\d+)\n/.exec(out);
          if (m) { clearTimeout(t); resolve(Number(m[1])); }
        });
        child.on("exit", (code) => reject(new Error(`server exited ${code}`)));
      });
      const body = (await (await fetch(`http://127.0.0.1:${port}/api/runs`)).json()) as { records: Array<{ runId: string; trace?: RunTraceContext }> };
      assert.deepEqual(body.records.find((r) => r.runId === result.runId)?.trace, result.trace);
    } finally {
      child.kill("SIGTERM");
    }
  });

  it("emit of an old RunResult without trace keeps generated ids (no parent on the root)", async () => {
    const file = path.join(tmp, "old.json");
    await fs.writeFile(file, JSON.stringify({ sessionId: "s", events: [{ type: "message", role: "user", content: "x", timestamp: 1 }] }));
    const emit = runCli(["emit", "--format", "otel", "--input", file], {});
    assert.equal(emit.code, 0, emit.stderr);
    const spans = spansOf(JSON.parse(emit.stdout));
    assert.match(spans[0]!.traceId, /^[0-9a-f]{32}$/);
    assert.notEqual(spans[0]!.traceId, UP_TRACE);
    assert.equal(spans[0]!.parentSpanId, undefined);
  });
});

describe("web UI shows the trace with a copyable traceparent (index.html)", () => {
  const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
  const block = /\/\* tracectx:begin \*\/([\s\S]*?)\/\* tracectx:end \*\//.exec(html);
  const ctx = createContext({});
  it("embeds the tracectx block", () => {
    assert.ok(block, "index.html must carry the tracectx block");
    runInContext(block![1]!, ctx);
  });
  it("formats the stored trace as a W3C traceparent; none for old records", () => {
    const r = { trace: { traceId: UP_TRACE, spanId: "b7ad6b7169203331", parentSpanId: UP_PARENT, traceFlags: "01", source: "env" } };
    assert.equal(ctx.traceparentOf(r), `00-${UP_TRACE}-b7ad6b7169203331-01`);
    assert.match(ctx.traceTitle(r) as string, new RegExp(UP_PARENT));
    assert.equal(ctx.traceparentOf({ runId: "old" }), "");
    assert.equal(ctx.traceparentOf(null), "");
    assert.equal(ctx.traceparentOf({ trace: { traceId: "x", spanId: "y" } }), "");
  });
  it("renderMeta shows a trace chip whose copy button copies the traceparent", async () => {
    // Same slice the other metadata-strip tests render (codex-usage, web-main-cache-history).
    const renderer = html.slice(html.indexOf("function renderMeta()"), html.indexOf("/* ===== feed pane ===== */"));
    interface El { tag: string; textContent: string; className: string; title: string; type?: string; children: El[]; handlers: Record<string, (ev: unknown) => void>; appendChild(e: El): void; addEventListener(t: string, f: (ev: unknown) => void): void }
    const el = (tag: string, cls: string, text = ""): El => ({
      tag, textContent: text, className: cls, title: "", children: [], handlers: {},
      appendChild(e) { this.children.push(e); },
      addEventListener(t, f) { this.handlers[t] = f; },
    });
    const text = (e: El): string => e.textContent + " " + e.children.map(text).join(" ");
    const find = (e: El, pred: (x: El) => boolean): El | undefined => (pred(e) ? e : e.children.map((c) => find(c, pred)).find(Boolean));
    let copied = "";
    const render = (r: Record<string, unknown>): El => {
      const box = el("div", "");
      runInNewContext(renderer + "\nrenderMeta();", {
        $: () => box, el, findRun: () => r, selectedId: "run", modelCache: {}, modelCachePending: { run: true },
        runCost: () => null, fmtTok: String, fmtCost: String, provMark: () => "", fmtCtx: () => "", fmtAgo: () => "", GLYPH: {},
        usageScopeText: () => null, modelProvText: () => "", modelChips: () => [],
        navigator: { clipboard: { writeText: (s: string) => { copied = s; return Promise.resolve(); } } },
      });
      return box;
    };
    const tp = `00-${UP_TRACE}-b7ad6b7169203331-01`;
    const box = render({ runId: "run", agent: "claude", trace: { traceId: UP_TRACE, spanId: "b7ad6b7169203331", parentSpanId: UP_PARENT, traceFlags: "01", source: "env" } });
    assert.match(text(box), new RegExp(`trace\\s+${tp}\\s+copy`));
    const btn = find(box, (x) => x.tag === "button" && x.className === "copy");
    assert.ok(btn, "a copy button sits next to the trace");
    btn!.handlers.click!({ stopPropagation() {} });
    await new Promise((r) => setImmediate(r));
    assert.equal(copied, tp);
    assert.equal(btn!.textContent, "copied");
    assert.doesNotMatch(text(render({ runId: "run", agent: "claude" })), /trace\s/, "old records show no trace chip");
  });
});
