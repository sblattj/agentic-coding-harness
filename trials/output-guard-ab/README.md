# output-guard-ab trial

Trial-only Claude Code output-guard PostToolUse hook (v2.1.268). Proves the hook can
replace Bash tool output with a disk-pointer notice. Nothing here touches
`~/.claude/settings.json`; both arms run via `--settings <file>` merges. No commits.

## Arm design

The hook script is present in BOTH arms (identical copy); interception is gated by the
`OUTPUT_GUARD` env var inside each arm's settings `env` block. Single-variable A/B:
- **Arm A** (`claude-arm-a/settings.json`): env `BASH_MAX_OUTPUT_LENGTH=1000000`, hook wired, **no `OUTPUT_GUARD`** → hook runs but exits silently (fail-open).
- **Arm B** (`claude-arm-b/settings.json`): same env **plus `OUTPUT_GUARD=1`** → hook intercepts Bash stdout > 20,000 bytes.

Both raise `BASH_MAX_OUTPUT_LENGTH` so the guard, not the harness cap, is the intended sole truncator.

## Files

- `claude-arm-{a,b}/hooks/output-guard` — executable python3 hook (fail-open on any error)
- `claude-arm-{a,b}/settings.json` — `--settings` merge files (hook + env)
- `evidence/armA-result.json`, `evidence/armB-result.json` — full `--output-format json` message streams.
  The `init` event is redacted: `skills` and `slash_commands` are placeholder lists, the MCP tool
  names and `mcp_servers` are collapsed to one example entry, and home-directory paths read
  `/path/to/`. Nothing the evidence below relies on was changed.

## Smoke-test commands

scratch cwd: `/var/folders/kb/swscs_t95mx777jtl7yqk7bw0000gn/T/opencode/og-smoke/{armA,armB}`

```sh
claude -p "Run this exact command with the Bash tool: seq 1 200000. Then report the last number it printed. Do not re-run the command; if output is large inspect it with Grep or Read." \
  --settings /path/to/projects/agent-harness/trials/output-guard-ab/claude-arm-B/settings.json \
  --allowedTools "Bash" "Read" "Grep" --output-format json > evidence/armB-result.json
# arm A identical with claude-arm-a/settings.json
```

## Evidence

Raw `seq 1 200000` output = 1,288,895 bytes.

**Arm B (guard fires):**
- Guard file: `~/.local/state/claude/output-guard/d20e86f47f8840d49902ecff107e1ab7.txt` (149,999 bytes)
- Model-visible tool_result begins: `[Output guard: 149999 bytes exceeds the 20,000-byte inline limit.] Full intercepted output saved to: ...` (in armB-result.json tool_result preview and twice in on-disk transcript `~/.claude/projects/-private-var-folders-...-og-smoke-armB/f05bd366-...jsonl`)
- Model's final answer explicitly cites the guard copy and that it was truncated at ~150KB.

**Arm A (no interception):**
- Guard-file count unchanged (1 before = 1 after; no new file).
- `grep -c "Output guard" armA-result.json` = 0. Model-visible tool_result preview starts with raw digits (`1\n2\n3...`).

## Friction / findings

1. **v2.1.268 has a built-in Bash output-persistence layer** that fired in BOTH arms: any large stdout is saved in full to `<project-slug>/<session>/tool-results/<id>.txt` and the model gets a `<persisted-output>` wrapper with a 2KB preview. In arm B the hook's replacement stdout flowed INTO that preview (notice visible), so both layers coexist; the model could (and did) also read the harness's own full persisted copy.
2. **The hook never saw the full 1.2MB**: guard file holds 149,999 bytes — something caps hook-visible Bash stdout at ~150k chars despite `BASH_MAX_OUTPUT_LENGTH=1000000` in the settings env block (value not honored, or a hard ~150k clamp upstream of hooks). For outputs in the 20KB–150KB range the guard is the sole truncator as intended; above ~150KB the harness cap binds first and the guard copy is itself truncated.
3. BASH_MAX_OUTPUT_LENGTH env-block value unverified in isolation (finding 2 confounds it); default-30k behavior not re-tested.
