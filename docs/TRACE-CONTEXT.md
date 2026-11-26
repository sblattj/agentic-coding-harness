# W3C trace context (`TRACEPARENT`)

Every `ach run` (and every library `driver.run`) belongs to a
[W3C Trace Context](https://www.w3.org/TR/trace-context/) trace. A run started
inside a traced CI job or service joins that trace; the agent it launches, and
the `--verify` checker after it, join under the run. The OTel and Langfuse
exports use the same ids, so one trace view shows the whole chain.

S-T: a trace id is one shared 32-hex label for a whole job; each step gets its
own 16-hex span id and names its parent's span id. `TRACEPARENT` is the env var
that carries "trace id + my span id" from a parent process to its children.

## At run start

The run reads `TRACEPARENT` (and `TRACESTATE`) from its environment. A
`RunSpec.env` / profile `env` value wins over the process env.

| Incoming `TRACEPARENT` | Result |
|---|---|
| valid (`00-<32 hex>-<16 hex>-<2 hex>`, lowercase, ids not all zeros) | the run adopts the trace id and flags; the incoming span becomes the run's `parentSpanId`; `TRACESTATE` is kept as is |
| absent or empty | a fresh trace (sampled, flags `01`), no parent |
| invalid | a fresh trace, `TRACESTATE` dropped, and one warning: `[warn] trace: ignoring invalid TRACEPARENT ...` on stderr |

A higher version than `00` is parsed by its first four fields, per the spec's
forward-compatibility rule; version `ff` is invalid. The run always gets its
own new span id.

The ids are stored on the run as `trace` (RunRecord in the registry, and the
RunResult that `ach run --json` prints):

```json
"trace": {
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "spanId": "b7ad6b7169203331",
  "parentSpanId": "00f067aa0ba902b7",
  "traceFlags": "01",
  "traceState": "vendor=abc",
  "source": "env"
}
```

`source` is `env` when the run joined an incoming trace, `generated` when it
started one. Records written before this field existed simply have no `trace`.

## Child processes

Each agent child process is launched with

```
TRACEPARENT=00-<traceId>-<run spanId>-<traceFlags>
TRACESTATE=<incoming tracestate>    # empty when there was none, or the TRACEPARENT was invalid
```

so anything the agent (or its tools) traces nests under the run instead of
under the run's own parent. The driver sets these on the launched spec's env
(src/core/driver.ts, per run, never on `process.env`, so concurrent runs do not
race), and every adapter merges that env into its child: claude, codex,
gemini, agy, prime, copilot, cursor, opencode (CLI mode), kiro (headless and
ACP), and custom agents (`--template` / agents.d descriptors). `scrubEnv` does
not remove them (they are not credentials); an explicit `scrubEnv` array that
names `TRACEPARENT` does.

The post-run `--verify` checker (and `ach regrade`) also gets the run's
`TRACEPARENT`.

Not covered, and why (these inherit whatever `TRACEPARENT` the caller had, or
none):

- `kiro-ide` drives a desktop IDE over CDP. When it is not running yet, launch
  mode starts it detached and leaves it running for later runs
  (src/adapters/kiro-ide.ts, `spawnChild`), so it is a shared app, not a
  per-run child; it gets no per-run env (the same reason profile `env` is
  ignored for it, `ENV_IGNORING_AGENTS` in src/cli/ach.ts).
- `null` starts no process.
- opencode in server mode talks HTTP to a server that is already running; no
  child is spawned per run.
- `--isolate` / trial `setup` commands (src/core/isolate.ts) run before the run
  starts, so there is no run span yet.
- The end-of-run desktop notification (`osascript` / `notify-send`,
  src/core/notify.ts) is not a traced step.
- Processes outside a single run: `ach queue` pre/post hooks and the `ach run`
  children it launches (each of those runs joins the queue's own
  `TRACEPARENT`), `ach web` terminals and desks sessions.

## Exports

`ach emit --format otel|langfuse --input run.json` (and the MCP `emit` tool)
read `trace` from a RunResult input:

- every span carries the run's `traceId`;
- the root `invoke_agent` span's `spanId` is the run's `spanId`, and its
  `parentSpanId` is the upstream span (absent when the run started the trace);
- chat and tool spans are children of the root, as before.

An input without `trace` (a bare event array, or a RunResult from an older
`ach`) exports exactly the ids it did before: generated ids, no parent on the
root (every span's trace id, span id, parent and times are compared to a golden
rendered from the pre-trace-context emitters; tests/trace-context-legacy-ids.test.ts).

The live `emitRun(tracer, ...)` library helper, given a `trace` with an
upstream `parentSpanId`, puts every span in the upstream trace with the root
parented to the upstream span (a remote parent context). The OTel tracer API
mints span ids itself, so its root span id is not the stored run span id, and a
run that started its own trace (no upstream parent) gets fresh ids as before.
`toOtlpJson` (what `ach emit` uses) pins all three ids in both cases.

## Where you see it

- `ach run` summary: `trace      00-<traceId>-<spanId>-01 (child of upstream span <id>)`
  or `(new trace)`. Paste it into a tracing UI search, or export it as
  `TRACEPARENT` to put a downstream step under this run.
- `ach web`: the selected run's metadata strip shows `trace` with the same
  value and a `copy` button; the tooltip has the trace id and upstream span.
- `ach run --json` / `ach dash --json` / `/api/runs`: the `trace` object.

## Example

```sh
export TRACEPARENT=00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
ach run --agent claude --json "fix the failing test" > run.json
ach emit --format otel --input run.json --out spans.json
```
