// emit-atif.ts — run an agent on a tiny task, convert its event stream to ATIF, validate, write trajectory.json.
// Uses the real emitters (src/emitters/atif.ts) and the real CLI (src/cli/harness.ts).
import { $ } from "bun";
import { AtifWriter } from "../src/emitters/atif.ts";
import { VERSION } from "../src/version.ts";

const cli = new URL("../src/cli/harness.ts", import.meta.url).pathname;
const proc = await $`bun ${cli} run --agent claude --json Say hello and exit`.quiet();
const run = JSON.parse(proc.stdout.toString());

const writer = AtifWriter.fromEvents(run.events ?? [], {
  agent: "claude",
  version: VERSION,
  modelName: run.model ?? "unknown-model",
  sessionId: run.sessionId,
});
if (!run.events) {
  // RunResult without a captured event stream: one summary step from the token totals.
  const t = run.tokens ?? {};
  writer.addStep({
    source: "agent",
    message: run.resultText ?? "",
    llmCallCount: 1,
    metrics: { prompt_tokens: t.input ?? 0, completion_tokens: t.output ?? 0,
      cached_tokens: (t.cacheRead ?? 0) + (t.cacheWrite ?? 0), cost_usd: run.costUsd ?? 0 },
  });
}
writer.finalize("trajectory.json");

const { ok, errors } = AtifWriter.validate("trajectory.json");
if (!ok) throw new Error(`ATIF validation failed:\n${errors.join("\n")}`);
console.log("wrote trajectory.json (validated)");
