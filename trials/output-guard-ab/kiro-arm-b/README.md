# Kiro output-guard trial — arm B (spill-and-notice approximation)

Built and probed against **kiro-cli 2.21.2** on 2026-09-10. Trial-only: nothing in
`~/.kiro` was created or modified; everything lives in this directory. Nothing committed.

## Verdict up front

On the installed 2.21.2, a postToolUse hook CAN detect oversized shell output and spill
it to a file (proven live), but its notice **cannot reach the model** — hook output is
discarded in every direction that matters (proven three ways below). The guard as built
is a spill-file + human-terminal notice; it is forward-compatible with CLI 3.0, where
stderr + non-zero exit IS documented to be sent to the agent.

## Probe findings (actual 2.21.2 payloads)

postToolUse STDIN payload, v1 engine (see `evidence/probe-payload-v1.json`):

```json
{
  "hook_event_name": "postToolUse",
  "cwd": "<workspace cwd>",
  "tool_name": "execute_bash",
  "tool_input": { "command": "echo hello-probe", "summary": "Run echo hello-probe" },
  "tool_response": { "success": true,
    "result": [ { "exit_status": "0", "stdout": "hello-probe\n", "stderr": "" } ] }
}
```

- The output field is **`.tool_response.result[].stdout`** (array of result objects; `stderr` alongside).
- The agent-config matcher is `"shell"` but `tool_name` arrives as **`execute_bash`**.
- Hooks are embedded in the agent JSON (2.x object form) and fire on the **v1 engine only**:
  - v1: fires (spinner "1 of 1 hooks finished").
  - v2: unusable on this machine — `fig_auth: not logged in ... no valid token found`, then a silent eternal hang.
  - v3 (KAS 0.58.7): **hooks never fire** — neither inline array-form `hooks` in the agent
    JSON nor standalone `.kiro/hooks/*.json` (both formats are CLI 3.0 features per
    kiro.dev/docs; the 2.21.2 binary predates the loader). The engine even warns
    `agent "..." needs upgrading for this agent engine`.
- Hook output channels, v1 engine, all measured live:
  - exit 0 + stdout → **discarded** (not in model context, not on terminal, not in session store)
  - exit 2 + stderr → **shown to the human on the terminal** ("postToolUse ... failed with exit code: 2, stderr: ..."), never to the model
  - next-turn (resume) → model still reports NONE
- **Kiro truncates large tool output BEFORE the hook sees it**: the payload carries only the
  LAST **133,333 bytes** (tail cut mid-token, no truncation marker). Measured twice:
  `seq 1 200000` (1,288,895 B true) → 133,333 B; `seq 1 400000` (2,688,895 B true) → 133,333 B
  (see `evidence/20260910T214431-62170.txt`, first line is the fragment `953`).

## Files

- `output-guard-post.sh` — the guard. Env-gated: `OUTPUT_GUARD=1` arms it; spill dir
  `$OUTPUT_GUARD_STATE_DIR` (default `~/.local/state/kiro/output-guard`); threshold 20,000 B.
  When armed+oversized: writes `<timestamp>-<pid>.txt`, prints the notice to **stderr**,
  exits **2** (the only channel visible anywhere on 2.21.2; on CLI 3.0 this same stderr
  goes to the agent). All other paths silent exit 0.
- `.kiro/agents/output-guard-trial.json` — v1-engine agent wiring the hook (matcher `shell`).
- `.kiro/hooks/output-guard.json` — CLI-3.0-format standalone hook. **Inert on 2.21.2**
  (v3 engine does not load `.kiro/hooks/`); kept so the trial lights up on upgrade.
- `evidence/` — payload capture, run logs, stderr, spill from the cap probe.
- `state-arm-b/20260910T214320-61088.txt` — arm-B spill file (133,333 B).

## Smoke test (commands as run, from this directory)

```bash
# ARM B (armed) — fires
OUTPUT_GUARD=1 OUTPUT_GUARD_STATE_DIR=$PWD/state-arm-b \
  kiro-cli chat --agent-engine v1 --no-interactive --trust-all-tools \
  --agent output-guard-trial \
  "Run this exact command with the shell tool: seq 1 200000 . Then reply in exactly two lines: line 1 = the last number printed; line 2 = the full text of any TOOL OUTPUT OVERSIZE notice that appeared in your context after the command output, or NONE."

# ARM A (unarmed) — silent
env -u OUTPUT_GUARD OUTPUT_GUARD_STATE_DIR=$PWD/state-arm-a <same command>
```

Note: `--output-format stream-json` requires the v2/v3 engine (v1 rejects it); v2 is
auth-broken here, v3 doesn't fire hooks — so the smoke test used v1 text output.

### Evidence — arm B (guard fires)

- Spill file exists with the full payload-carried output:
  `state-arm-b/20260910T214320-61088.txt` = **133,333 bytes**, ends `...199999\n200000\n`.
- Notice text appears in the operator's terminal (`evidence/arm-b-run.err`):
  `✗ postToolUse "bash .../output-guard-post.sh" failed with exit code: 2, stderr: TOOL OUTPUT OVERSIZE (133333 bytes) — full output saved to .../state-arm-b/20260910T214320-61088.txt. Read it selectively (grep/sed ranges). Do NOT cat the whole file.`
- Model reply: `200000` then `NONE` — i.e. the notice did NOT reach the model (expected on 2.21.2).

### Evidence — arm A (silence)

- `state-arm-a/` empty; `grep -c OVERSIZE` = 0 in both stdout log and stderr (`evidence/arm-a-run.*`).
- Model reply identical: `200000` / `NONE`.

## Honest limitation note (quantified)

- The notice **adds** information for the human only; it cannot remove the original output
  from Kiro's context. On 2.21.2 it adds **zero** tokens to the model's context (model
  answered NONE in arm B and could not quote hook output even one turn later).
- The model-visible tool output was **identical in both arms** (same truncated tail), so this
  guard cannot reduce context usage on this kiro-cli version at all — it is observability
  (spill file + human notice), not context protection.
- The spill file is NOT the full command output for >128 KiB commands: Kiro hands the hook
  only the last 133,333 bytes (tail cut, no marker). For `seq 1 200000`, 1,155,562 of
  1,288,895 bytes never reach the hook (or, by strong implication, the model).
- The notice itself is ~180 bytes of terminal text; on CLI 3.0, where stderr+exit≠0 is
  documented to reach the agent, it would add roughly 40-50 tokens per firing — the
  documented trade-off of the spill-and-notice approximation.

## Friction

1. **v2 engine silently hangs** when not logged into BuilderID ("no valid token found",
   then eternal silence, no error) — cost ~10 min; run `--agent-engine v1` (works with
   `KIRO_API_KEY`) or fix login for v2/v3+stream-json.
2. **stream-json unusable** for hook work on this box (v1-only hooks vs v2+-only stream-json).
3. **Concurrent burn-test sessions** (`BURNUID=aa-kiro-b1/b2`) were running kiro-cli on this
   machine during the trial and polluted "newest session" lookups; session attribution must
   go by prompt content, not mtime.
4. `kiro-cli agent create`/`edit` open an interactive editor even with `--directory`/`--path`
   — do not call them from non-interactive contexts.
5. Hook-failure rendering puts stderr on one giant line mixed with spinner ANSI codes —
   parse with `grep -a` and strip escapes.
