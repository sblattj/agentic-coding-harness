# HTTP event tap (`--event-webhook`)

`ach run` can POST its lifecycle to a URL you choose, so automation can react
without scraping a terminal: a CI trigger on failure, a Slack relay, an external
cost ledger (#64). The full event stream still lands on disk (`events.jsonl`,
the transcript); the tap posts only lifecycle events, never per-token chatter.

S-T: a webhook is a URL that something else runs; ach sends it a small JSON
message (an HTTP POST) each time something worth knowing happens, for example
"run 4f2c... finished with exitStatus error, cost $0.42".

Implementation: [`src/core/event-webhook.ts`](../src/core/event-webhook.ts)
(envelope, filter, signing, queue, retries), wired into the driver
([`src/core/driver.ts`](../src/core/driver.ts)) and `ach watch`.

## Turning it on

```sh
ach run --agent claude --event-webhook https://ci.example.com/hooks/ach "fix the flaky test"
ach run --agent claude --event-webhook https://ci.example.com/hooks/ach --webhook-events exit,budget "..."
AGENTIC_CODING_HARNESS_EVENT_WEBHOOK=https://ci.example.com/hooks/ach ach run --agent codex "..."
```

| Setting | Flag | Env | Config file | Default |
|---|---|---|---|---|
| URL | `--event-webhook URL` | `AGENTIC_CODING_HARNESS_EVENT_WEBHOOK` | `run.eventWebhook` | none (nothing is posted) |
| Event filter | `--webhook-events LIST` | none | `run.webhookEvents` | `start,exit,budget,usage` |
| Usage summary interval | `--webhook-usage-ms MS` | none | `run.webhookUsageMs` | `60000`; `0` turns the summary off |
| Signing key | none | `AGENTIC_CODING_HARNESS_EVENT_WEBHOOK_SECRET` | none | unset (no signature header) |

Precedence is the usual flag > env > config file > default
([CONFIG.md](CONFIG.md)). The signing key is env only, so it never lands in
argv, a config file or a RunRecord. The URL is treated as a secret too (a Slack
incoming-webhook URL carries its token in the path): log lines show only its
origin, and a profile's `event-webhook` value is recorded on the RunRecord as
`<origin>/<redacted>`.

`--webhook-events` takes a comma list of the types below, or `all`. An unknown
name is a usage error, so a typo cannot silently drop the exit event.
A bad URL (not absolute `http:` / `https:`) is a usage error before the run
starts.

## Envelope

Every POST body is one JSON object with exactly these five keys:

```json
{
  "schemaVersion": 1,
  "runId": "4f2c8f0e-5d1a-4b7e-9a51-0d6c3b2e9f10",
  "type": "exit",
  "timestamp": "2026-11-26T14:03:12.481Z",
  "payload": { "...": "type-specific, below" }
}
```

| Key | Type | Meaning |
|---|---|---|
| `schemaVersion` | number | `1`. Bumped only on a breaking change to the envelope or a payload field's meaning; new optional payload fields do not bump it. |
| `runId` | string | The run's id (the RunRecord's `runId`). For `ach watch`, a per-process `watch-<uuid>`. |
| `type` | string | `start`, `exit`, `budget` or `usage`. |
| `timestamp` | string | ISO 8601, when the event happened. |
| `payload` | object | The event's fields. |

Request headers:

| Header | Value |
|---|---|
| `content-type` | `application/json` |
| `x-ach-event` | the envelope `type` |
| `x-ach-delivery` | a uuid per event, the same on every retry (dedupe on it) |
| `x-ach-signature-256` | `sha256=<hex>`, only when the signing key is set (below) |

## Event types

Payloads hold run metadata only. The prompt and agent output are never posted.

### `start`

Posted once the agent process is launched (a launch that fails posts only
`exit`).

| Field | Meaning |
|---|---|
| `agent` | agent name (`claude`, `codex`, ...) |
| `sessionId` | the agent's session id, when known at launch |
| `model` | the requested `--model`, when set |
| `startedAt` | ISO 8601 |
| `captureMode` | the run's capture tier (`full`, `metadata`, `off`; [CAPTURE.md](CAPTURE.md)) |
| `budget` | `{usd, maxTurns, wallMs}`, the limits that are set |
| `parentRunId` | when the run has a parent (desk engines, lanes) |
| `trace` | `{traceId, spanId}` ([TRACE-CONTEXT.md](TRACE-CONTEXT.md)) |

### `exit`

Posted once, after the RunRecord and `status.json` are final.

| Field | Meaning |
|---|---|
| `agent`, `sessionId` | as above |
| `exitStatus` | the full verdict: `success`, `error`, `timeout`, `budget_exceeded`, `turn_limit`, `aborted`, `cancelled` or `unavailable` ([EXIT-CODES.md](EXIT-CODES.md)) |
| `unavailableReason` | why the run counts as an outage, when `exitStatus` is `unavailable` |
| `timeoutKind` | `wall` or `idle`, when ach's own timer stopped the run |
| `error` | the error message, when the run threw (no cost fields then) |
| `durationMs` | run wall time |
| `turns` | turns counted |
| `cost` | `{usd, usdAvailable, source?, byModel?, credits?}`: `usd` is the run's total, `usdAvailable` false means it is not a real price (for example kiro, which bills credits), `source` is `reported` or `computed` when one path priced it, `byModel` appears with two or more models |
| `tokens` | `{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}` |
| `warnings` | how many run warnings there were |

### `budget`

One per budget-alert crossing, the same crossings as the `budget.alert` events
([BUDGET-ALERTS.md](BUDGET-ALERTS.md)). Opt in with `--budget-alerts` /
`--warn-at`; with no thresholds set, nothing fires.

| Field | Meaning |
|---|---|
| `family` | `budget` (usd) or `near-limit` (turns, wall, context) |
| `metric` | `usd`, `turns`, `wall` or `context` |
| `threshold` | the fraction crossed (`0.8`) |
| `value`, `limit` | the observed value and its limit |
| `description` | the same human line stderr shows |

### `usage`

A periodic summary while the run is going: every `--webhook-usage-ms` (default
60s), time-clocked, so a chatty stream never posts more often than that. A run
shorter than the interval posts none.

| Field | Meaning |
|---|---|
| `agent`, `sessionId` | as above |
| `elapsedMs` | time since start |
| `turns` | turns so far |
| `costUsd` | cost so far |
| `tokens` | token totals so far |

### `ach watch`

`ach watch --event-webhook URL` posts one `usage` event per agent session per
poll that saw new tokens, with payload `{source: "watch", agent, sessionId,
root?, delta: {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens},
costUsd}` (`costUsd` is `null` when the delta could not be priced). Watch posts
nothing else: it tails other tools' transcripts and owns no run, so there is no
run start, exit status or budget to report (`cmdWatch` in
[`src/cli/ach.ts`](../src/cli/ach.ts) only ever prints per-poll deltas, and it
exits 0 on Ctrl-C). A filter without `usage` warns that watch will post
nothing. On Ctrl-C, queued posts get the same bounded flush before exit.
`--offline` with a non-loopback webhook URL is a usage error.

## Delivery, retries and the backoff budget

- Posts are queued in memory and sent one at a time, in order, in the
  background. The agent's event stream never waits for the network.
- A response other than 2xx, a network error, or no answer within **2s** is a
  failed attempt. Each event gets **4 attempts** (the first plus 3 retries),
  waiting **250ms, 500ms, then 1000ms** between them (exponential backoff,
  base 250ms, factor 2). The worst case for one event is 4 x 2s + 1.75s =
  9.75s.
- At run end the run waits for the queue to drain for at most **5s**
  (`DEFAULT_WEBHOOK_FLUSH_MS`). On that deadline the in-flight POST is
  aborted, pending backoff is cancelled, and anything still queued is
  dropped. **So the tap adds at most 5s to a run's end, whatever the
  receiver does** (a refused connection fails fast and adds far less).
- Every event that was not delivered prints one stderr line with a running
  per-run failure counter, and the run end prints the total:

  ```text
  [warn] webhook: exit event for run 4f2c8f0e not delivered to https://ci.example.com (HTTP 500); failures this run: 1
  [warn] webhook: 1 of 2 events for run 4f2c8f0e not delivered to https://ci.example.com; the run itself is unaffected
  ```

**Fail open.** A webhook failure never changes the run: the exit status, the
process exit code, the RunResult (`--json`), the RunRecord and every artifact
are the same as a run without `--event-webhook`. The failure lines go to
stderr only, not into the run's `warnings`.

## Signing (HMAC-SHA256)

With `AGENTIC_CODING_HARNESS_EVENT_WEBHOOK_SECRET` set, every POST carries

```text
x-ach-signature-256: sha256=<hex HMAC-SHA256 of the raw request body, keyed by the secret>
```

The signature covers the exact bytes of the body (it is the same on every
retry of one event). To verify: compute the HMAC over the raw body you
received, before any JSON parsing, prefix `sha256=`, and compare in constant
time (`crypto.timingSafeEqual`). Reject a missing or different header. The
body carries `timestamp`, so a receiver that wants replay protection can also
reject old events or remember `x-ach-delivery` ids.

## A receiver in ten lines

Ten lines. Save as `receiver.mjs` and run `SECRET=... PORT=8787 node receiver.mjs`. It
verifies the signature (when `SECRET` is set), prints each event and answers
204.

<!-- receiver:start -->
```js
import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
const secret = process.env.SECRET ?? "", sign = (b) => Buffer.from("sha256=" + createHmac("sha256", secret).update(b).digest("hex"));
createServer((req, res) => { const chunks = []; req.on("data", (c) => chunks.push(c)).on("end", () => {
  const body = Buffer.concat(chunks), sig = Buffer.from(String(req.headers["x-ach-signature-256"] ?? "")), want = sign(body);
  if (secret && (sig.length !== want.length || !timingSafeEqual(sig, want))) return res.writeHead(401).end();
  const e = JSON.parse(body.toString("utf8"));
  console.log(e.type, e.runId, JSON.stringify(e.payload));
  res.writeHead(204).end();
}); }).listen(Number(process.env.PORT ?? 8787), function () { console.log("listening on", this.address().port); });
```
<!-- receiver:end -->

Then point a run at it:

```sh
AGENTIC_CODING_HARNESS_EVENT_WEBHOOK_SECRET=... ach run --agent null --event-webhook http://127.0.0.1:8787/ "hello"
```

The test suite runs this exact block (`tests/event-webhook.test.ts`), so it
stays working.

## Slack

A Slack incoming webhook accepts only its own message shape, at minimum:

```json
{ "text": "ach run 4f2c8f0e: exit error, $0.4210, 12 turns" }
```

(optionally `blocks` for rich layout). ach's envelope has no `text` key, so a
Slack URL given straight to `--event-webhook` answers 400 and the tap logs
failures; the run is unaffected. Put a small relay in between that turns the
envelope into Slack's shape, for example inside the receiver above:

```js
// in the "end" handler, after verifying:
if (e.type === "exit") {
  const p = e.payload;
  const text = `ach run ${e.runId.slice(0, 8)}: exit ${p.exitStatus}, $${(p.cost?.usd ?? 0).toFixed(4)}, ${p.turns ?? 0} turns`;
  await fetch(process.env.SLACK_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
}
```

(make the handler `async` for the `await`). Keep the Slack URL in the relay's
environment: it is a credential.

## Masking and privacy

A webhook payload leaves the machine, so it goes through the same export gate
as every other export ([MASKING.md](MASKING.md)), as sink `webhook`:

```sh
ach run --agent claude --event-webhook URL "..."                  # secrets in payloads masked (default)
ach run --agent claude --event-webhook URL --mask none "..."      # raw payloads
ach run --agent claude --event-webhook URL --mask preview "..."   # list findings, POST nothing
ach run --agent claude --event-webhook URL --privacy anon "..."   # privacy mode on payloads
```

Config: `mask.webhook` beats `mask.mode`; env `AGENTIC_CODING_HARNESS_MASK` and
`--mask` beat both. The built-in default is `all`, like the other outbound sinks (otel,
langfuse); opt out with `ach config --set mask.webhook none`. On `ach run`,
`--mask` / `--privacy` apply only to the webhook payloads (the run's own
records follow the capture tier, [CAPTURE.md](CAPTURE.md)).
Privacy applies to the whole envelope: under `--privacy anon` the envelope
`runId` and every `sessionId` arrive as their `anon-<12 hex>` hashes, which
are stable, so a receiver can still group a run's events.
