// Issue #160: the Kiro IDE adapter reads the chat's model picker, selects --model in it and
// records the model that really ran. All against fake CDP with a stateful picker
// (tests/fake-cdp.ts FakeModelPicker); nothing here touches a real IDE.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { KIRO_IDE_MODEL_LABEL, KiroIdeAdapter } from "../src/adapters/kiro-ide.ts";
import { READ_MODEL_JS, normalizeModelName, pickModelOption } from "../src/adapters/kiro-ide-cdp.ts";
import { createDriver } from "../src/core/driver.ts";
import { listRunRecords } from "../src/core/registry.ts";
import type { AgentEvent, RunSpec } from "../src/core/types.ts";
import { FAKE_PICKER_MODELS, FakeModelPicker, startFakeCdp, type FakeCdp, type FakePickerOption } from "./fake-cdp.ts";

const PROMPT = "Read hello.txt and reply with its contents.";
const IDLE = "New Session\nLoading\nArtifacts\n0\nStarting cloud session\nLet's build\nAuto\nDefault\nAutopilot";
const DONE = `Read hello.txt
Loading
Artifacts
0
Starting cloud session
Checkpoint
Restore

${PROMPT}

Kiro
1 tool call
Read File
hello.txt

The contents are:

hello
Est. Credits Used: 0.18
Elapsed time: 3s




Auto
Default
Autopilot`;

const WORKBENCH_URL = "vscode-file://vscode-app/Applications/Kiro.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html";
const CHAT_URL = "vscode-webview://abc/index.html?id=1&extensionId=kiro.kiroAgent&purpose=webviewView";
const INPUT_METHODS = new Set(["Input.insertText", "Input.dispatchKeyEvent"]);

const open: FakeCdp[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

interface World {
  fake: FakeCdp;
  picker: FakeModelPicker;
  /** CDP calls that type or send text: must stay 0 on every failure before the prompt. */
  inputCalls: () => number;
}

async function world(opts: { label?: string; options?: FakePickerOption[]; configure?: (p: FakeModelPicker) => void } = {}): Promise<World> {
  const picker = new FakeModelPicker({ label: opts.label ?? "Auto", options: opts.options ?? FAKE_PICKER_MODELS });
  opts.configure?.(picker);
  let text = IDLE;
  const fake = await startFakeCdp({
    targets: [
      {
        id: "page1",
        type: "page",
        url: WORKBENCH_URL,
        title: "ws",
        contexts: [{ id: 1, name: "", origin: "vscode-file://vscode-app" }],
        handler: (method) => (method === "Runtime.evaluate" ? { result: { type: "string", value: "Kiro Free 0 / 50" } } : {}),
      },
      {
        id: "chat1",
        type: "iframe",
        url: CHAT_URL,
        contexts: [
          { id: 3, name: "", origin: "vscode-webview://abc" },
          { id: 4, name: "", origin: "vscode-webview://abc" },
        ],
        handler: (method, params, contextId) => {
          if (method === "Input.dispatchKeyEvent") {
            if (params.type === "keyDown" && params.key === "Enter") text = DONE;
            return {};
          }
          if (method !== "Runtime.evaluate") return {};
          const e: string = params.expression;
          const val = (v: unknown) => ({ result: { type: typeof v, value: v } });
          if (e.startsWith("!!document.querySelector")) return val(contextId === 3);
          if (contextId !== 3) return val(null);
          const p = picker.evaluate(e);
          if (p.handled) return val(p.value);
          if (e.includes("autopilot-toggle")) return val("on");
          if (e.includes("e.focus()")) return val(true);
          if (e.includes("session-manager-header")) return val(text);
          return val(null);
        },
      },
    ],
  });
  open.push(fake);
  return { fake, picker, inputCalls: () => fake.calls.filter((c) => INPUT_METHODS.has(c.method)).length };
}

const fast = { pollMs: 15, readyTimeoutMs: 3000, recoverMs: 100, modelSettleMs: 400 };

function specFor(fake: FakeCdp, extra: Partial<RunSpec> = {}): RunSpec {
  return { prompt: PROMPT, cwd: "/tmp/kiro-ide-model/ws", kiroIde: { cdp: fake.endpoint }, ...extra } as RunSpec;
}

async function runIt(w: World, extra: Partial<RunSpec> = {}) {
  const h = await new KiroIdeAdapter(fast).launch(specFor(w.fake, extra));
  const events: AgentEvent[] = [];
  for await (const e of h.attach()) events.push(e);
  const exit = await h.wait();
  const usage = events.find((e) => e.type === "usage") as any;
  const notes = events.filter((e: any) => e.type === "progress").map((e: any) => String(e.text));
  const error = (events.find((e) => e.type === "error") as any)?.message as string | undefined;
  return { events, exit, model: usage?.usage?.model as string | undefined, notes, error };
}

describe("kiro-ide model picker (issue #160)", () => {
  it("without --model: records the model the picker shows, and clicks nothing", async () => {
    const w = await world({ label: "Claude Sonnet 5.5" });
    const r = await runIt(w);
    assert.equal(r.exit, "success");
    assert.equal(r.model, "Claude Sonnet 5.5");
    assert.notEqual(r.model, KIRO_IDE_MODEL_LABEL);
    assert.equal(w.picker.toggles, 0, "reading must not open the popup");
    assert.deepEqual(w.picker.clicked, []);
    assert.ok(w.inputCalls() > 0, "the prompt was sent");
    // control: a different picker state gives a different record
    const w2 = await world({ label: "GPT 5.6 Sol" });
    assert.equal((await runIt(w2)).model, "GPT 5.6 Sol");
  });

  it("--model selects the option, reads it back, records it and sends the prompt afterwards", async () => {
    const w = await world({ label: "Auto" });
    const r = await runIt(w, { model: "claude-sonnet-5.5" });
    assert.equal(r.exit, "success", r.error);
    assert.deepEqual(w.picker.clicked, ["Claude Sonnet 5.5"]);
    assert.equal(w.picker.label, "Claude Sonnet 5.5");
    assert.equal(w.picker.open, false, "the popup is closed again");
    assert.equal(r.model, "Claude Sonnet 5.5");
    assert.ok(r.notes.some((n) => /selected model 'Claude Sonnet 5\.5' \(was 'Auto'\).*persists/.test(n)), r.notes.join("|"));
    // Ordering: the picker's last interaction precedes the first typed character.
    const calls = w.fake.calls.filter((c) => c.targetId === "chat1");
    const lastPicker = calls.map((c, i) => [c, i] as const).filter(([c]) => String(c.params?.expression ?? "").includes("model-selector")).at(-1)![1];
    const firstInput = calls.findIndex((c) => INPUT_METHODS.has(c.method));
    assert.ok(lastPicker >= 0 && firstInput > lastPicker, `picker call ${lastPicker} must precede first input ${firstInput}`);
  });

  it("no match: closes the popup, fails with the available list, sends no input", async () => {
    const w = await world();
    const r = await runIt(w, { model: "gemini-9" });
    assert.equal(r.exit, "error");
    assert.match(r.error!, /model 'gemini-9' is not in the Kiro IDE model picker/);
    for (const name of ["Auto", "Claude Opus 5.5", "Claude Opus 5", "Claude Sonnet 5.5", "GPT 5.6 Sol"]) assert.ok(r.error!.includes(name), `lists ${name}`);
    assert.match(r.error!, /prompt was not sent/);
    assert.equal(w.inputCalls(), 0);
    assert.equal(w.picker.open, false);
    assert.deepEqual(w.picker.clicked, []);
    assert.equal(w.picker.label, "Auto", "nothing was selected");
    assert.equal(r.model, undefined, "no usage record for a run that never started");
  });

  it("already selected: no click at all (not even opening the popup)", async () => {
    const w = await world({ label: "Claude Sonnet 5.5" });
    const r = await runIt(w, { model: "CLAUDE-SONNET-5.5" });
    assert.equal(r.exit, "success");
    assert.equal(w.picker.toggles, 0);
    assert.deepEqual(w.picker.clicked, []);
    assert.equal(r.model, "Claude Sonnet 5.5");
  });

  it("look-alike names: 'Claude Opus 5' picks exactly that option, never 'Claude Opus 5.5'", async () => {
    const w = await world({ label: "Auto" });
    const r = await runIt(w, { model: "Claude Opus 5" });
    assert.equal(r.exit, "success", r.error);
    assert.deepEqual(w.picker.clicked, ["Claude Opus 5"]);
    assert.equal(r.model, "Claude Opus 5");
    // And the reverse: only the longer name exists, so the shorter ask fails instead of substring-matching.
    const w2 = await world({ options: [{ name: "Auto" }, { name: "Claude Opus 5.5" }] });
    const r2 = await runIt(w2, { model: "Claude Opus 5" });
    assert.equal(r2.exit, "error");
    assert.match(r2.error!, /not in the Kiro IDE model picker/);
    assert.deepEqual(w2.picker.clicked, []);
    assert.equal(w2.inputCalls(), 0);
    // pure matcher: prefix, suffix and separators
    assert.equal(normalizeModelName("claude-sonnet-5.5"), normalizeModelName("Claude Sonnet 5.5"));
    assert.deepEqual(pickModelOption([{ name: "Claude Opus 5.5", disabled: false }], "claude opus"), { kind: "none" });
  });

  it("a disabled option is not selectable: fails with the list, sends nothing", async () => {
    const w = await world({ options: [{ name: "Auto" }, { name: "GPT 5.6 Sol", disabled: true }] });
    const r = await runIt(w, { model: "GPT 5.6 Sol" });
    assert.equal(r.exit, "error");
    assert.match(r.error!, /not selectable/);
    assert.match(r.error!, /GPT 5\.6 Sol \(unavailable\)/);
    assert.deepEqual(w.picker.clicked, []);
    assert.equal(w.inputCalls(), 0);
    assert.equal(w.picker.open, false);
  });

  it("read-back mismatch: the label never changes, the run fails before sending", async () => {
    const w = await world({ configure: (p) => (p.ignoreClicks = true) });
    const r = await runIt(w, { model: "Claude Sonnet 5.5" });
    assert.equal(r.exit, "error");
    assert.match(r.error!, /selected 'Claude Sonnet 5\.5' in the Kiro IDE model picker but it still shows 'Auto'/);
    assert.equal(w.inputCalls(), 0);
    assert.equal(w.picker.open, false, "the popup is closed on failure");
  });

  it("an empty popup fails with a clear message and sends nothing", async () => {
    const w = await world({ configure: (p) => (p.emptyPopup = true) });
    const r = await runIt(w, { model: "Claude Sonnet 5.5" });
    assert.equal(r.exit, "error");
    assert.match(r.error!, /listed no models/);
    assert.equal(w.inputCalls(), 0);
    assert.equal(w.picker.open, false);
  });

  it("missing trigger without --model: the run proceeds on the fallback label with a progress note", async () => {
    const w = await world({ configure: (p) => (p.present = false) });
    const r = await runIt(w);
    assert.equal(r.exit, "success");
    assert.equal(r.model, KIRO_IDE_MODEL_LABEL);
    assert.ok(r.notes.some((n) => /could not read the chat's model picker; recording the model as 'kiro-ide'/.test(n)), r.notes.join("|"));
    assert.ok(w.inputCalls() > 0);
  });

  it("missing trigger with --model: fails clearly and never sends the prompt", async () => {
    const w = await world({ configure: (p) => (p.present = false) });
    const r = await runIt(w, { model: "Claude Sonnet 5.5" });
    assert.equal(r.exit, "error");
    assert.match(r.error!, /could not select model 'Claude Sonnet 5\.5': the Kiro IDE chat's model picker was not found/);
    assert.equal(w.inputCalls(), 0);
  });
});

describe("kiro-ide model through the production driver", () => {
  it("the persisted run record names the model the picker showed or was set to, with no pricing warning", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-kiro-ide-model-"));
    const driver = createDriver({ adapters: { "kiro-ide": new KiroIdeAdapter(fast) }, stateDir, registry: { stateDir } });

    // --model: Auto -> Claude Sonnet 5.5, then read result.json the way a consumer of the run would.
    const w = await world({ label: "Auto" });
    const outputDir = path.join(stateDir, "out-pinned");
    const result = await driver.run("kiro-ide", specFor(w.fake, { model: "claude-sonnet-5.5", outputDir }));
    assert.equal(result.exitStatus, "success", JSON.stringify(result.warnings));
    assert.equal(result.tokens[0]?.model, "Claude Sonnet 5.5");
    const persisted = JSON.parse(await fs.readFile(path.join(outputDir, "result.json"), "utf8"));
    assert.equal(persisted.tokens[0].model, "Claude Sonnet 5.5");
    assert.deepEqual(persisted.warnings, [], "a real model label must not add a pricing warning");
    assert.equal(persisted.totalCost, 0, "credits only: no bogus USD figure");
    assert.equal(persisted.tokens[0].extra.credits, 0.18);
    const rec = listRunRecords(stateDir).find((r) => r.runId === result.runId);
    assert.equal(rec?.totals?.credits, 0.18);
    assert.equal(rec?.totals?.costUsd, 0);
    assert.equal(rec?.totals?.byModel, undefined);

    // no --model: whatever the picker shows
    const w2 = await world({ label: "Auto" });
    const outputDir2 = path.join(stateDir, "out-read");
    const r2 = await driver.run("kiro-ide", specFor(w2.fake, { outputDir: outputDir2 }));
    const persisted2 = JSON.parse(await fs.readFile(path.join(outputDir2, "result.json"), "utf8"));
    assert.equal(persisted2.tokens[0].model, "Auto");
    assert.deepEqual(persisted2.warnings, []);
    assert.equal(w2.picker.toggles, 0);
    assert.equal(r2.exitStatus, "success");
  });

  it("a bad --model is recorded as error, not unavailable, and the list rides in the warning-free result", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-kiro-ide-badmodel-"));
    const driver = createDriver({ adapters: { "kiro-ide": new KiroIdeAdapter(fast) }, stateDir, registry: { stateDir } });
    const w = await world({ label: "Auto" });
    const outputDir = path.join(stateDir, "out-bad");
    const result = await driver.run("kiro-ide", specFor(w.fake, { model: "gemini-9", outputDir }));
    assert.equal(result.exitStatus, "error", JSON.stringify(result.warnings));
    assert.ok(!result.warnings.some((x) => /unavailable/.test(x)), JSON.stringify(result.warnings));
    const rec = listRunRecords(stateDir).find((r) => r.runId === result.runId);
    assert.equal(rec?.status, "error");
    const events = (await fs.readFile(path.join(outputDir, "events.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.match(String(events.find((e: any) => e.type === "error")?.message), /available models: Auto, Claude Opus 5\.5/);
    assert.equal(w.inputCalls(), 0);

    // control: a missing picker with --model is selector drift (an outage-like failure), still unavailable
    const w2 = await world({ configure: (p) => (p.present = false) });
    const r2 = await driver.run("kiro-ide", specFor(w2.fake, { model: "Auto", outputDir: path.join(stateDir, "out-drift") }));
    assert.equal(r2.exitStatus, "unavailable");
  });

  it("a picker that renders just after the chat input is still read (bounded first-read settle)", async () => {
    const w = await world({
      label: "Claude Sonnet 5.5",
      configure: (p) => {
        const real = p.evaluate.bind(p);
        let reads = 0;
        p.evaluate = (expr: string) => {
          if (expr === READ_MODEL_JS && reads++ === 0) return { handled: true, value: { trigger: false, expanded: false, label: null } };
          return real(expr);
        };
      },
    });
    const r = await runIt(w);
    assert.equal(r.exit, "success");
    assert.equal(r.model, "Claude Sonnet 5.5");
    assert.ok(!r.notes.some((n) => /could not read the chat's model picker/.test(n)), r.notes.join("|"));

    const w2 = await world({
      label: "Claude Sonnet 5.5",
      configure: (p) => {
        const real = p.evaluate.bind(p);
        let reads = 0;
        p.evaluate = (expr: string) => {
          if (expr === READ_MODEL_JS && reads++ === 0) return { handled: true, value: { trigger: false, expanded: false, label: null } };
          return real(expr);
        };
      },
    });
    const r2 = await runIt(w2, { model: "Claude Sonnet 5.5" });
    assert.equal(r2.exit, "success", r2.error);
    assert.equal(r2.model, "Claude Sonnet 5.5");
  });
});
