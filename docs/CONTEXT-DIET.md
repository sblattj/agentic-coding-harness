# Context diet kit

Every Claude Code session and subagent pays a startup cost before it does any work: the system prompt, tool schemas, the skills listing, MCP tool schemas, and instructions files (`CLAUDE.md`). In a heavily customized setup that was about 43k tokens per subagent, so a 52-agent fan-out burned roughly 2.3M tokens of pure baseline. This kit measures that cost, finds skills that do not earn their listing, and ships a lean subagent template. It needs only `bash`, `python3` and the `claude` CLI; nothing here touches the TypeScript build.

| Tool | Answers |
|---|---|
| `context-diet/ablate.sh` | How many tokens does each component (skills, MCP, instructions, tool set) add to startup? |
| `context-diet/skill-usage.py` | Which skills are actually used, and which can be hidden or trimmed? |
| `context-diet/skill-lint.py` | Which skills have a `description` + `when_to_use` over the 600-character cap? |
| `agents/lean.md` | A subagent with a 6-tool allowlist and nothing else loaded. |

## Measure startup context: `ablate.sh`

```bash
context-diet/ablate.sh                       # all variants, one prompt, one rep
context-diet/ablate.sh -v baseline,floor -n 3 -e OK -o out/
context-diet/ablate.sh -f prompts.txt --max-turns 4   # one prompt per line
context-diet/ablate.sh --list
```

Each run is `claude -p <prompt> --output-format json` plus the variant's flags. Output is `<out>/<variant>.jsonl`, one row per (prompt, rep):

| Field | Meaning |
|---|---|
| `start_tokens` | input + cache write + cache read: everything the model was given. The headline metric. |
| `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` | Raw usage fields. |
| `cost_usd`, `turns`, `duration_ms` | From the CLI result. |
| `wall_ms` | Wall time measured around the process. |
| `is_error`, `pass` | `pass` appears only with `--expect STR` and means the reply contains `STR`. |

Variants: `baseline`, `no-skills` (`--disable-slash-commands`), `no-mcp` (strict empty MCP config), `no-instructions` (`CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`), `six-tools` (`--tools Bash Read Edit Write Grep Glob`), `six-tools-no-mcp`, and `floor` (six tools, no MCP, no instructions files).

Reading the results:

- Compare each variant to `baseline`; the difference is that component's cost.
- `floor` is the cheapest a session can start with your Claude Code version and system prompt.
- Cache effects: the first run of a variant writes the cache, later runs read it. `start_tokens` sums both so the metric is stable, but `cost_usd` differs between a cold and a warm run. Use `-n 3` and compare medians.

Caveats:

- A small `--tools` allowlist that omits `ToolSearch` makes MCP tool schemas load in full instead of deferred, so `six-tools` can come out higher than `baseline`. Pair it with `no-mcp`, as `six-tools-no-mcp` does.
- Leaving `Skill` out of a subagent's tools also removes the skills listing from its prompt.
- Each run makes a real model call. Without `ANTHROPIC_API_KEY` set it bills your subscription; the script unsets the key for the run so a key without credits is not used. Set `ABLATE_KEEP_API_KEY=1` to keep it.
- `no-instructions` relies on `CLAUDE_CODE_DISABLE_CLAUDE_MDS`; check that your CLI version honors it (the `start_tokens` drop should be visible).
- Works with macOS `bash` 3.2. Override the binary with `CLAUDE_BIN`.

## Find skills to hide: `skill-usage.py`

```bash
context-diet/skill-usage.py                          # ~/.claude/projects, ~/.claude/skills
context-diet/skill-usage.py /path/to/projects --skills-dir /path/to/skills -o usage.csv
```

It scans transcript `.jsonl` files for `Skill` tool calls (model invocations) and `<command-name>` markers (typed slash commands), joins them with the `SKILL.md` files on disk, and writes CSV: `skill, model_invocations, typed_invocations, invocations, last_used, description_length, suggested_tier`. `--window-days` (default 30) and `--cap` (default 600) tune the tiers.

| Tier | Rule | Suggested override |
|---|---|---|
| `keep` | Used in the window, listing within the cap | none |
| `trim` | Used in the window, `description` + `when_to_use` over the cap | shorten; move triggers to `## More triggers` |
| `user-invocable-only` | Used in the window but only ever typed as `/name` | `skillOverrides: user-invocable-only` |
| `name-only` | Unused in the window, or never used | `skillOverrides: name-only` |

Caveats: the tier is a suggestion from usage counts alone. `user-invocable-only` stops model invocation entirely, so apply it only to skills you always type. `name-only` listings give the model only a name to go on; in a trigger A/B, skills that were `name-only` fired less often than fully listed ones. Transcripts you have deleted or never kept undercount usage. Skills shipped by plugins are only included if you pass their directory with `--skills-dir`.

## Cap skill descriptions: `skill-lint.py`

```bash
context-diet/skill-lint.py ~/.claude/skills            # scans every SKILL.md below
context-diet/skill-lint.py path/to/SKILL.md --cap 400
```

Exits 0 when clean, 1 when any skill's `description` + `when_to_use` exceeds the cap (default 600 characters), 2 on usage errors. For each violation it prints the lengths and suggests keeping the core sentence in the description and moving extra trigger phrases to a `## More triggers` section in the body, which loads only after the skill fires. In a trigger check, trimmed descriptions with the overflow moved there still fired 9 of 9 times. The linter reports only; it does not rewrite files.

## Lean subagent: `agents/lean.md`

A subagent definition with the tools `Bash, Read, Edit, Write, Grep, Glob` and a short prompt. Copy it to `.claude/agents/lean.md` (project) or `~/.claude/agents/lean.md` (user) and use it as the default agent type for workflow fan-out. A custom subagent with a six-tool allowlist started at about 9.6k tokens against roughly 43k for the default. It has no `Skill` tool, so it gets no skills listing, and no MCP tools. Do not use it for tasks that need either.

## Tests

```bash
python3 -m unittest discover -s context-diet/tests
```

The tests use synthetic transcripts and skills generated in a temp directory and a fake `claude` executable; they make no model calls. They are not part of `npm test`, which runs only the TypeScript suites.
