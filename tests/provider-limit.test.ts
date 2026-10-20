// Provider-limit detection (src/core/provider-limit.ts): the regex set and
// the error-lane-only scan `ach trial --matrix` uses for skipped-provider-limit.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hitProviderLimit, isProviderLimitText, providerLimitReason } from "../src/core/provider-limit.ts";
import type { AgentEvent } from "../src/core/types.ts";

const T = 0;

describe("provider-limit regex", () => {
  it("matches usage, rate-limit, 429 and overload wording", () => {
    for (const text of [
      "You've hit your session limit · resets 3pm",
      "You've hit your weekly limit",
      "Claude AI usage limit reached|1760000000",
      "Your monthly usage limit has been reached",
      "We are temporarily limiting requests",
      "API Error: 429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\"}}",
      "Rate limit exceeded, retry after 30s",
      "rate-limited by upstream",
      "HTTP 429 Too Many Requests",
      "request failed with status code 429",
      "{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}",
    ]) {
      assert.ok(isProviderLimitText(text), text);
    }
  });

  it("leaves ordinary failures alone", () => {
    for (const text of [
      "Not logged in · Please run /login",
      "claude exited 1 without emitting a result",
      "TypeError: Cannot read properties of undefined (reading 'x')\n    at main (file.ts:4290:3)",
      "exit 1",
      "error: unknown option '--model'",
      "ENOENT: no such file or directory",
      "port 4290 in use",
      "",
    ]) {
      assert.equal(isProviderLimitText(text), false, text);
    }
    assert.equal(isProviderLimitText(undefined), false);
  });
});

describe("provider-limit scan", () => {
  it("reads error messages, their stderr tail, stderr progress lines and the adapter's provider_limit tag", () => {
    const viaMessage: AgentEvent[] = [{ type: "error", message: "codex exited with code 1: 429 Too Many Requests", timestamp: T }];
    const viaTail: AgentEvent[] = [{ type: "error", message: "claude exited 1", data: { stderrTail: "boot\nrate_limit_error\n" }, timestamp: T }];
    const viaProgress: AgentEvent[] = [{ type: "progress", text: "Error: You've hit your usage limit", timestamp: T }];
    const viaTag: AgentEvent[] = [{ type: "error", message: "claude hit a provider limit: x", data: { kind: "provider_limit" }, timestamp: T }];
    for (const events of [viaMessage, viaTail, viaProgress, viaTag]) assert.ok(hitProviderLimit(events));
    assert.equal(providerLimitReason(viaTail), "rate_limit_error");
  });

  it("never reads agent messages or tool output", () => {
    const events: AgentEvent[] = [
      { type: "message", source: "agent", content: "Added a rate limit (HTTP 429) to the handler", timestamp: T },
      { type: "tool_result", toolCallId: "t1", content: "Too Many Requests", timestamp: T } as AgentEvent,
      { type: "error", message: "claude exited 1 after emitting result", data: { stderrTail: "" }, timestamp: T },
    ];
    assert.equal(hitProviderLimit(events), false);
    assert.equal(providerLimitReason(events), null);
  });
});
