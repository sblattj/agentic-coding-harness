# TODO: next releases

Two planned batches, ranked from the open P2 issues after 0.28.1. Build each
batch in its own release; tier 1 first unless sharing reports becomes urgent.
Each issue gets its own small PR (the sdlc-review gate fails on oversized
PRs), and the release follows the usual `chore(release): X` flow.

## Batch A: tier 1 conveniences

Small pieces that mostly build on code that already exists.

- [ ] #77 Agent profiles. Save a named setup and reuse it:
  `ach run --profile fast` instead of retyping `--agent claude --model sonnet --yolo`.
  Builds on the layered config file from 0.28 (#41, `docs/CONFIG.md`): add a
  `profiles.<name>` key and a `--profile` flag. Explicit flags still win.
- [ ] #80 `ach init` first-run wizard. Detect installed agent CLIs (reuse the
  `ach doctor` detection), ask a few questions, write `.ach/config.json` or the
  user file, print a quickstart. Must work non-interactively (`--yes`).
- [ ] #42 Period-over-period stats: `ach stats --compare prev:7d` shows this
  window next to the previous one (spend, tokens, runs) with the change. Reuse
  the existing time-window parsing; provenance markers carry through.
- [ ] #64 Event webhook: `--event-webhook <url>` POSTs each run event as it
  happens. Needs a timeout, bounded retries, and must never block or fail the
  run. Respects `--offline` (refuse non-loopback). Foundation for #74.
- [ ] #54 Cross-CLI effort: one `--effort low|medium|high` flag, mapped per
  agent (a CLI flag for some, a model-slug suffix for others). No such flag
  exists today. Unsupported agents warn instead of silently ignoring it.

## Batch B: privacy

Keeps secrets and personal details out of anything ach exports or shares.
Build these together: all three need one shared "mask before it leaves"
layer, so splitting them means writing it three times.

- [ ] #71 Redaction pipeline. Mask API keys, tokens and emails before any
  export or report is written (`sk-abc123...` becomes `sk-***`). One core
  module used by every export path: emit (ATIF, OTel, Langfuse, SFT),
  `ach report`, and the web API.
- [ ] #72 Content-capture policy. Choose how much is recorded at all:
  `off` (numbers only), `metadata` (tool names and timings, no content),
  `full` (today's behaviour). Global default with per-agent overrides,
  applied at record time, so nothing excluded ever reaches disk.
- [ ] #46 Privacy modes for shared reports. Hide cwd and paths, hash repo
  names, mask prompts in HTML, ATIF and OTel outputs, so a shared report shows
  "4 min, $0.12" without what was asked or where the code lives.

Acceptance for the batch: a fixture run containing a fake key, an email and
a home-directory path, exported in every format, shows none of the three in
any output file (grep each output, with a control run where masking is off
that does show them).

## Later (not scheduled)

Remaining P2s, roughly in order: #74 alert rules (after #64), #73 W3C trace
context, #50 LLM-judge scoring, #49 yield metric, then the large ones, each
its own release: #58 Docker sandbox, #52 Terminal-Bench import (needs #58),
#53 bring-your-own-repo trials, #76 pause/resume daemon, #39 Windows support.
The 12 open P3s stay parked.
