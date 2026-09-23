# Output-guard A/B trial — FINAL (live installations)

Date: 2026-09-11. Harness: `bun src/cli/harness.ts` (agent-harness, main worktree, nothing committed).
Task: one Bash tool call with ~1.3 MB output (`seq 1 200000` = 1,288,895 bytes), then "last number
printed". 1 run per agent per arm (4 runs). Token fields are the canonical `CanonicalTokenRecord`
fields from `src/core/types.ts`: `inputTokens` (uncached), `outputTokens`, `cacheReadTokens`,
`cacheWriteTokens`, `costUsd`. `ctxLoaded = input + cacheRead + cacheWrite` (everything billed on
the prompt side).

Prompt (identical across all 4 runs; `evidence/PROMPT.txt`):

> You MUST actually call the Bash tool to run exactly this command, verbatim, with no pipes, no
> head, no tail, no redirection, and no other modification: seq 1 200000. Do not answer from
> memory; do not skip the tool call. After the command completes, tell me the last number printed.

(The "MUST call / no pipes" wording is load-bearing: a first opencode attempt answered "200000"
from memory without any tool call, and a historical run piped to `tail` — both false negatives.
All 4 final runs made exactly one verbatim `seq 1 200000` Bash call and answered correctly.)

## Headline table — arms x agents

| Agent (model) | Arm | inputTokens | outputTokens | cacheRead | cacheWrite | ctxLoaded | costUsd | dur | Guard evidence |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| opencode (ferry/heavy) | A — no guard | **604,606** | 72 | 108,800 | 0 | **713,406** | $0¹ | 111.1s | 0 markers; spill dir unchanged; model saw raw 1,288,895 B |
| opencode (ferry/heavy) | B — guard LIVE | **10,939** | 162 | 149,495 | 0 | **160,434** | $0¹ | 29.7s | 1 marker in tool part; spill `f9881551…txt` (1,288,895 B); model saw 308-B notice |
| claude (claude-opus-5[1m]) | A — no hook | 972 | 746 | 62,750 | 8,297 | 72,019 | $0.1025 | 16.0s | 0 markers; spill dir unchanged; model saw claude's own 2,306-B `<persisted-output>` wrapper |
| claude (claude-opus-5[1m]) | B — hook LIVE | 974 | 1,127 | 78,718 | 7,871 | 87,563 | $0.1175 | 20.3s | 2 markers in transcript; spill `2e614a15…txt` (30,000 B); model saw 573-B notice |

¹ opencode ran on the local `ferry/heavy` lane; both provider and harness report cost 0.0, so no
cost delta is computable — token deltas only.

## Delta table (B vs A, computed by `evidence/delta-computation.txt`, not prose arithmetic)

| Agent | metric | Arm A | Arm B | delta | % |
|---|---|---:|---:|---:|---:|
| opencode | inputTokens | 604,606 | 10,939 | **−593,667** | **−98.2%** |
| opencode | outputTokens | 72 | 162 | +90 | +125.0% |
| opencode | cacheReadTokens | 108,800 | 149,495 | +40,695 | +37.4% |
| opencode | ctxLoaded | 713,406 | 160,434 | **−552,972** | **−77.5%** |
| opencode | costUsd | 0.00 | 0.00 | n/a | n/a |
| claude | inputTokens | 972 | 974 | +2 | +0.2% |
| claude | outputTokens | 746 | 1,127 | +381 | +51.1% |
| claude | cacheReadTokens | 62,750 | 78,718 | +15,968 | +25.4% |
| claude | cacheWriteTokens | 8,297 | 7,871 | −426 | −5.1% |
| claude | ctxLoaded | 72,019 | 87,563 | **+15,544** | **+21.6%** |
| claude | costUsd | $0.1025 | $0.1175 | +$0.0150 | +14.6% |

## Verdict

- **opencode: the guard is transformative.** Without it, opencode injects the entire Bash output
  into the model context — the second model call carried **598,907 uncached input tokens** of `seq`
  digits. With the live guard, that call carried 0 new input tokens (the 308-byte notice was
  absorbed into cache); the model then ran `tail -n 1 <spill-file>` (the guard's designed recovery
  path) and answered correctly. Net: −98.2% input tokens, −77.5% ctxLoaded, and 3.7× faster
  (111.1s → 29.7s).
- **claude: the guard is marginal-to-negative on this task, by architecture.** Claude Code's
  headless Bash already persists large output itself and shows the model a ~2.3 KB
  `<persisted-output>` wrapper (arm A, no hook). The live hook only shrank that wrapper
  2,306 B → 573 B; in this single run the model then took a verification detour (a blocked `wc` on
  the spill file, a permitted `wc` on the persisted file, a tail `Read`) that cost more context
  than the guard saved: ctxLoaded +21.6%, cost +14.6%. The guard's claude value is not token
  savings here — it is the deterministic 20 KB ceiling and disk spill, which matter only when
  claude's own cap is raised (e.g. `BASH_MAX_OUTPUT_LENGTH`) or removed.

## Guard evidence per run (CEV)

| Run | Marker "[Output guard" | New spill file | Model-visible Bash output | Bash call made |
|---|---|---|---|---|
| opencode A | 0 (SQLite `part` scan) | no (4→4… baseline held at 5 after prior probe) | raw `1\n2\n3\n…` (1,288,895 B part; call-2 input = 598,907 tokens) | yes, verbatim |
| opencode B | 1 (in tool part JSON) | `~/.local/state/opencode/output-guard/f9881551-d7fb-44b5-af0b-5014e934cab8.txt`, 1,288,895 B (FULL output — guard sees pre-truncation bytes) | 308-char notice | yes, verbatim (plus guard-sanctioned `tail -n 1` on the spill) |
| claude A | 0 (transcript grep) | no (3→3) | 2,306-B `<persisted-output>` + 2-KB digit preview (claude's own layer) | yes, verbatim |
| claude B | 2 (transcript grep) | `~/.local/state/claude/output-guard/2e614a15590744f7af26b4b33369a086.txt`, 30,000 B | 573-B notice inside the persisted-output preview | yes, verbatim (plus wc/Read detour) |

Mechanism isolation was verified both directions: the opencode arm-A isolation probe (XDG copy,
`seq 1 5000` = 33.9 KB > threshold) produced 0 markers / no spill with the Bash call confirmed
made, while the live config fired on every non-isolated run. The live plugin symlink
`~/.config/opencode/plugins/output-guard.ts` was never touched (still a symlink to
`~/.dotai/adapters/opencode/plugins/output-guard.ts`), and `~/.claude/settings.json` was never
modified — claude arm A used the harness's per-run empty `CLAUDE_CONFIG_DIR` (no hooks by
construction), claude arm B added the identical live wiring via `--settings`.

## Exact run commands

```sh
T=trials/output-guard-ab/final-20260911-072341   # (absolute paths in the actual invocations)
PROMPT="$(cat $T/evidence/PROMPT.txt)"

# opencode ARM A (guard provably off: XDG_CONFIG_HOME -> full config copy minus output-guard.ts)
XDG_CONFIG_HOME=$T/xdg-noguard bun src/cli/harness.ts run --agent opencode --json "$PROMPT" \
  > $T/opencode-arm-a/result.json 2> $T/opencode-arm-a/stderr.log

# opencode ARM B (live guard: default ~/.config/opencode, plugin symlinked from ~/.dotai)
bun src/cli/harness.ts run --agent opencode --json "$PROMPT" \
  > $T/opencode-arm-b/result.json 2> $T/opencode-arm-b/stderr.log

# claude ARM A (no hook: harness claude adapter forces per-run CLAUDE_CONFIG_DIR, empty dir)
bun src/cli/harness.ts run --agent claude --json "$PROMPT" \
  > $T/claude-arm-a/result.json 2> $T/claude-arm-a/stderr.log

# claude ARM B (live hook wiring, verbatim from ~/.claude/settings.json, via --settings merge)
bun src/cli/harness.ts run --agent claude \
  "--extra-args=--settings $T/claude-arm-b/settings.json" --json "$PROMPT" \
  > $T/claude-arm-b/result.json 2> $T/claude-arm-b/stderr.log
```

`$T/claude-arm-b/settings.json` contains exactly the live `~/.claude/settings.json` PostToolUse
block: matcher `"Bash"`, command `~/.dotai/adapters/claude/hooks/output-guard`, timeout 10.
`$T/xdg-noguard/opencode` is a `cp -a` of `~/.config/opencode` with `plugins/output-guard.ts`
removed — single-variable isolation (all other config, agents, commands, and the opencode-loop
plugin intact). That copy is a snapshot of a personal local config, so it is not committed; to
reproduce, `cp -a` your own `~/.config/opencode` to `$T/xdg-noguard/opencode` and delete
`plugins/output-guard.ts` from the copy.

## Kiro (not re-trialed; cited evidence)

Per `trials/output-guard-ab/kiro-arm-b/README.md` (kiro-cli 2.21.2, 2026-09-10): a postToolUse
hook CAN spill oversized shell output to disk, but its notice **cannot reach the model** — hook
stdout is discarded in every direction that matters (proven three ways: not in model context, not
on terminal, not in session store), and kiro pre-truncates tool output to the **last 133,333
bytes** before the hook sees it. Net: **0 tokens saved; observability-only** on 2.x. Re-trial was
therefore skipped.

## Honest caveats

1. **Single run per cell.** Run-to-run variance is real and the claude sign can flip: the earlier
   attempt-1 pair (weaker prompt, both arms valid, bash call made) measured claude ctxLoaded
   72,040 → 69,074 (**−4.1%**, cost −8.4%), while the final pair measured **+21.6%**. The honest
   claude statement is "≈ no token savings on this task; sign within noise", not either direction.
2. **Prompt-cache asymmetry.** Arm B ran after arm A for each agent, so arm B could benefit from
   warm prompt-cache prefixes (claude arm A/B shared a session-independent cache prefix; opencode
   runs were separate sessions on the same local model). This inflates arm-B cacheRead slightly and
   understates arm-B input cost — the conservative direction for the opencode conclusion.
3. **Claude's own caps coexist with the guard.** The hook never sees the 1.2 MB: headless claude
   caps hook-visible Bash stdout at 30,000 bytes (spill file is exactly 30,000 B; the prior trial
   measured a 149,999-B hard clamp with `BASH_MAX_OUTPUT_LENGTH=1000000`), and claude's
   built-in `<persisted-output>` layer already shows the model only ~2.3 KB. On this stack the
   guard's claude token ceiling is bounded by layers below it.
4. **Opencode cost is unpriced** (local `ferry/heavy` lane, cost 0.0 in both the stream and the
   opencode session DB), so savings are reported in tokens only. Opencode token deltas are
   cross-checked against the session DB (`10939/162/149495` for arm B — exact match).
5. **`OPENCODE_CONFIG_DIR` does NOT disable opencode plugins** on 1.18.30 — a first isolation
   attempt using it still fired the guard (kept as
   `opencode-arm-a/result.attempt2-opencode-config-dir-did-not-isolate.json`); `XDG_CONFIG_HOME`
   isolation was verified live instead. `--pure` exists but the harness opencode adapter drops
   `extraArgs`, so it cannot flow through the harness.
6. **Models differ across agents** (ferry/heavy vs claude-opus-5[1m]); compare arms within an
   agent, not token counts across agents.
7. Nothing was committed; all artifacts live untracked under this directory. Two invalid early
   attempts are preserved with explanatory filenames.

## Artifacts

- `*/result.json` — full harness `RunResult` (tokens, events, cost, duration) per run
- `evidence/PROMPT.txt`, `evidence/delta-computation.txt`, `evidence/spill-baseline*.txt`
- `claude-arm-b/settings.json`, `claude-arm-*/config-dir.txt`; the `xdg-noguard/` arm-isolation
  config copy is not committed (see "Exact run commands")
- Raw transcripts: harness `~/.agent-harness/state/claude-runs/<uuid-in-config-dir.txt>/projects/…`
  and opencode SQLite (`part` table by session id above)
