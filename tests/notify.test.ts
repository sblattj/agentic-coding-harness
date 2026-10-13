// Run lifecycle desktop notifications (issue #63).
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createDriver } from "../src/core/driver.ts";
import { NullAdapter } from "../src/adapters/null.ts";
import { HarnessError, type AgentAdapter } from "../src/core/types.ts";
import {
  NOTIFY_ENV,
  NOTIFY_SOUND_ENV,
  defaultNotifyExec,
  eventForExit,
  formatRunNotice,
  notifyRunEnd,
  parseNotifyConfig,
  sendNotification,
} from "../src/core/notify.ts";
import type { ExitStatus } from "../src/core/types.ts";

type Call = { file: string; args: string[] };

async function runNull(forceExit: string, env: NodeJS.ProcessEnv, prompt = "build the widget"): Promise<{ calls: Call[]; exit: string }> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-notify-"));
  const calls: Call[] = [];
  const driver = createDriver({
    adapters: { null: new NullAdapter({ forceExit }) },
    stateDir,
    registry: { stateDir },
    notify: { env, platform: "darwin", exec: (file, args) => void calls.push({ file, args }) },
  });
  const result = await driver.run("null", { prompt });
  return { calls, exit: result.exitStatus };
}

describe("notify: driver lifecycle (acceptance)", () => {
  it("a completed run raises a notification with task name and exit status", async () => {
    const { calls, exit } = await runNull("success", { [NOTIFY_ENV]: "finish" });
    assert.equal(exit, "success");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.file, "osascript");
    const script = calls[0]!.args.join(" ");
    assert.match(script, /build the widget/);
    assert.match(script, /status: success/);
    assert.match(script, /with title "ach: run finished"/);
  });

  it("a budget_exceeded run raises the budget notification; a plain success run does not", async () => {
    const over = await runNull("budget_exceeded", { [NOTIFY_ENV]: "budget" });
    assert.equal(over.exit, "budget_exceeded");
    assert.equal(over.calls.length, 1);
    assert.match(over.calls[0]!.args.join(" "), /ach: run hit its budget/);
    const ok = await runNull("success", { [NOTIFY_ENV]: "budget" });
    assert.equal(ok.calls.length, 0);
  });

  it("per-event toggles: disabling finish silences only finish", async () => {
    const env = { [NOTIFY_ENV]: "fail,budget" };
    assert.equal((await runNull("success", env)).calls.length, 0);
    assert.equal((await runNull("error", env)).calls.length, 1);
    assert.equal((await runNull("budget_exceeded", env)).calls.length, 1);
  });

  it("default config (env unset) sends nothing for any exit", async () => {
    for (const f of ["success", "error", "timeout", "budget_exceeded"]) {
      assert.equal((await runNull(f, {})).calls.length, 0, f);
    }
  });

  it("sound: true adds the platform alert sound (and is absent by default)", async () => {
    const on = await runNull("success", { [NOTIFY_ENV]: "finish", [NOTIFY_SOUND_ENV]: "1" });
    assert.match(on.calls[0]!.args.join(" "), /sound name "default"/);
    const off = await runNull("success", { [NOTIFY_ENV]: "finish" });
    assert.doesNotMatch(off.calls[0]!.args.join(" "), /sound name/);
  });

  it("body comes from run metadata only: neither agent output nor later prompt lines leak", async () => {
    const { calls } = await runNull("success", { [NOTIFY_ENV]: "finish" }, "short task\nsecret-token-sk-12345");
    const script = calls[0]!.args.join(" ");
    assert.doesNotMatch(script, /deterministic reply/); // the agent's transcript message
    assert.doesNotMatch(script, /secret-token-sk-12345/); // transcript-only prompt tail
    assert.match(script, /short task/);
  });
});

describe("notify: launch-unavailable path", () => {
  it("a launch() that throws spawn ENOENT notifies once with status: unavailable (event fail)", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-notify-"));
    const calls: Call[] = [];
    const adapter: AgentAdapter = {
      name: "mock",
      launch: async () => {
        throw Object.assign(new Error("spawn kiro-cli ENOENT"), { code: "ENOENT" });
      },
    };
    const driver = createDriver({
      adapters: { mock: adapter },
      stateDir,
      notify: { env: { [NOTIFY_ENV]: "fail" }, platform: "darwin", exec: (file, args) => void calls.push({ file, args }) },
    });
    await assert.rejects(driver.run("mock", { prompt: "do the thing" }), (err: unknown) => err instanceof HarnessError && err.code === "UNAVAILABLE");
    assert.equal(calls.length, 1);
    const script = calls[0]!.args.join(" ");
    assert.match(script, /status: unavailable/);
    assert.match(script, /ach: run failed/);
  });
});

describe("notify: unit", () => {
  it("missing binary is a silent no-op (ENOENT reaches neither stderr nor the caller)", async () => {
    let stderr = "";
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (c: unknown) => boolean }).write = (c) => ((stderr += String(c)), true);
    try {
      assert.doesNotThrow(() => defaultNotifyExec("definitely-not-a-real-binary-ach63", ["x"]));
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      process.stderr.write = orig;
    }
    assert.equal(stderr, "");
  });

  it("a throwing exec never propagates; unsupported platforms do nothing", () => {
    assert.doesNotThrow(() =>
      sendNotification("t", "m", { platform: "linux", exec: () => { throw new Error("boom"); } }),
    );
    const calls: Call[] = [];
    sendNotification("t", "m", { platform: "win32", exec: (file, args) => void calls.push({ file, args }) });
    assert.equal(calls.length, 0);
  });

  it("linux uses notify-send; macOS escapes quotes", () => {
    const calls: Call[] = [];
    const exec = (file: string, args: string[]) => void calls.push({ file, args });
    sendNotification("T", "M", { platform: "linux", exec, sound: true });
    assert.equal(calls[0]!.file, "notify-send");
    assert.deepEqual(calls[0]!.args.slice(-2), ["T", "M"]);
    sendNotification('a"b', 'c"d', { platform: "darwin", exec });
    assert.equal(calls[1]!.args[1], 'display notification "c\\"d" with title "a\\"b"');
  });

  it("status -> event mapping", () => {
    const m: Record<ExitStatus, string | null> = {
      success: "finish",
      error: "fail",
      unavailable: "fail",
      budget_exceeded: "budget",
      turn_limit: "budget",
      timeout: "budget",
      aborted: null,
      cancelled: null,
    };
    for (const [k, v] of Object.entries(m)) assert.equal(eventForExit(k as ExitStatus), v, k);
  });

  it("config parsing: unset = none, all, unknown tokens ignored", () => {
    assert.equal(parseNotifyConfig({}).events.size, 0);
    assert.equal(parseNotifyConfig({ [NOTIFY_ENV]: "all" }).events.size, 3);
    assert.deepEqual([...parseNotifyConfig({ [NOTIFY_ENV]: " Finish, bogus " }).events], ["finish"]);
  });

  it("formatRunNotice ignores any non-metadata field smuggled in", () => {
    const n = { runId: "abcdef123456", agent: "claude", prompt: "do x", exitStatus: "success", costUsd: 0.5, events: [{ content: "LEAK" }], transcript: "LEAK" } as never;
    const { title, body } = formatRunNotice("finish", n);
    assert.doesNotMatch(title + body, /LEAK/);
    assert.match(body, /cost: \$0\.5000/);
  });

  it("notifyRunEnd returns null and sends nothing when disabled", () => {
    const calls: Call[] = [];
    const r = notifyRunEnd({ runId: "r", agent: "a", exitStatus: "success" }, { env: {}, exec: (f, a) => void calls.push({ file: f, args: a }) });
    assert.equal(r, null);
    assert.equal(calls.length, 0);
  });
});
