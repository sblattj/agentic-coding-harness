# agent-harness

Headless-first orchestration and observability layer over coding-agent CLIs (Claude Code, Codex
CLI, OpenCode, Gemini CLI, Kiro): one normalized event model, cache-aware token accounting,
ATIF trajectory artifacts, OTel `gen_ai` spans, and per-agent state detection.

**Work in progress** — `src/` is being populated by parallel workstreams; see
`docs/ARCHITECTURE.md` §9 for the open interface merges.

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — adapter pattern (headless / ACP / tmux lanes),
  token taps, canonical token record, ATIF, OTel transport, state manifests, data-flow diagram.
- [`docs/TOKEN-COUNTING.md`](docs/TOKEN-COUNTING.md) — per-agent usage field reference,
  double-counting traps, cost formula.

## Quickstart

```sh
# one small task on every installed agent, side-by-side comparison table
examples/trial-all.sh

# live deltas: run `harness watch` in the background, fire a run, watch it land
examples/monitor-live.sh

# smallest end-to-end path: run an agent, emit an ATIF trajectory, validate it
bun examples/emit-atif.ts   # → trajectory.json
```

## CLI

`src/cli/harness.ts` (run it with `bun`):

```sh
bun src/cli/harness.ts run --agent claude [--model M] [--budget-usd N] [--max-turns N] [--json] "prompt"
bun src/cli/harness.ts watch [--dir ~/.claude/projects]   # live per-session token deltas
bun src/cli/harness.ts stats [--agent A] [--days N] [--json]
bun src/cli/harness.ts emit --input events.json --format atif|otel [--out path]
```

State lives under `~/.agent-harness` (override with `AGENT_HARNESS_STATE_DIR`).

## Examples

| Script | What it shows |
|---|---|
| [`examples/trial-all.sh`](examples/trial-all.sh) | trials every agent with both CLI and adapter installed; prints agent / tokens / cost / duration / status; skips the rest |
| [`examples/monitor-live.sh`](examples/monitor-live.sh) | `watch` in background + sample `run` + the delta lines appearing + `stats` |
| [`examples/emit-atif.ts`](examples/emit-atif.ts) | run → `AtifWriter.fromEvents` → `trajectory.json` → validate |

## Develop

```sh
npm run typecheck   # tsc --noEmit
npm test            # tsx --test (canonical runner)
bun test            # same suite under bun
```

Both runners execute the identical suite. `tests/` re-export shims are not
allowed: `node:test` counts an imported suite again while `bun test`
deduplicates it by qualified name, silently skewing the counts.
