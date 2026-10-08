# Skill-trigger A/B pipeline

Measures whether a skill-visibility change (for example moving skills to `name-only` in `skillOverrides`) still lets the model pick the right skill, using **real prompts mined from your own session logs**. Part of the context-diet kit (see [docs/CONTEXT-DIET.md](../../docs/CONTEXT-DIET.md), issue #118). Python 3.9+, standard library only.

```
transcripts --mine.py--> candidates.jsonl --filter.py--> cases.jsonl --run.py--> results.jsonl --report.py--> tables
                                      skills dir --make_arms.py--> arms/*.json ----^
```

## Billing: unset `ANTHROPIC_API_KEY`

Every model call is `claude -p ...` in a subprocess. With `ANTHROPIC_API_KEY` set, Claude Code bills that API key; without it, your subscription login is used. `filter.py`, `run.py` and `quick_ab.py` **strip the key from the child environment by default**; `--keep-api-key` disables that. Every call has a hard wall-clock `--deadline` (the whole process group is killed) and bounded output (captured stdout is capped; `filter.py` also sets `CLAUDE_CODE_MAX_OUTPUT_TOKENS`).

## Walkthrough

```sh
cd context-diet/ab

# 1. Mine. Pass your transcript dir as an argument (nothing is hardcoded).
python3 mine.py "$HOME/.claude/projects" --out work/candidates.jsonl --days 30 --max-negatives 150
```
A user prompt whose turn called `Skill(x)` is a positive labelled `x` (several skills in one turn: any is accepted). Short prompts whose turn called no skill are negatives. Positives that literally name the skill get `explicit: true`. Typed slash commands, tool results, meta/caveat messages and subagent (sidechain) turns are skipped; prompts are de-duplicated.

```sh
# 2. Filter with a cheap judge (batches of 25; keeps prompts understandable without prior context)
python3 filter.py work/candidates.jsonl --out work/cases.jsonl --model haiku
```
Add synthetic positives by appending lines like `{"id":"syn1","prompt":"...","label":"positive","skills":["name"],"explicit":false}` to `cases.jsonl`. Mined negatives are noisy (some no-skill turns *should* have used a skill): relabel by hand before trusting the negative fire rate.

```sh
# 3. Arms: complete skillOverrides maps; each arm pins every skill explicitly. First --arm = baseline.
python3 make_arms.py --skills-dir "$HOME/.claude/skills" --out work/arms \
    --arm before --arm after --set 'after:jira-*=name-only' --set 'after:rarely-used=name-only'
# states: on | name-only | user-invocable-only | off. --set is ARM:GLOB=STATE, applied in order.

# 4. Run (resumable; re-run the same command after an interruption)
python3 run.py --cases work/cases.jsonl --arms work/arms --out work/results.jsonl --reps 2 --workers 3
tail -f work/results.jsonl.progress     # in another terminal
```
Each run is `claude -p <prompt> --settings <arm>.json --tools Skill Read Grep Glob --strict-mcp-config --mcp-config '{"mcpServers":{}}' --max-turns 2 --output-format stream-json --verbose` in an empty temp directory (read-only tools, no MCP: side-effect free). It records the `Skill` tool_use names and the first assistant turn's `usage` (input + cache creation + cache read = start tokens). Results are append-only; keys are `arm|case|rep`; finished keys are skipped, errored keys are retried. Positives whose expected skills are all `user-invocable-only`/`off` in an arm are excluded by design (recorded, no call made). Skills are installed where Claude Code finds them (your user skills dir, or `.claude/skills` under `--cwd`).

```sh
# 5. Report
python3 report.py work/results.jsonl
```
Per arm: recall (all / implicit), wrong-skill rate, fire rate on negatives, median start tokens, each with a Wilson 95% CI. For every non-baseline arm: an exact two-sided McNemar test (binomial on discordant pairs) over per-case majority outcomes across reps, plus per-skill regressions. `--json` for machine output, `--baseline NAME` to change the baseline.

## Quick version

`quick_ab.py` is the single-file check for hand-written prompts (`skill<TAB>prompt` per line) and two settings files:
```sh
python3 quick_ab.py --prompts prompts.tsv --a work/arms/before.json --b work/arms/after.json --reps 3
```

## Cost notes

Runs = cases x arms x reps. The issue's reference run (98 cases, 2 arms, 2 reps) was 448 runs per round on Sonnet. A run is about 1 to 2 model turns with a start context of roughly 17k to 36k tokens depending on your setup, so budget accordingly; try `--limit 10 --reps 1` first. Filtering is 1 haiku call per 25 candidates. Use `--model` to pick the run model and keep `--workers` low enough to stay under rate limits.

## Tests

```sh
python3 -m unittest discover -s context-diet/ab/tests
```
Synthetic transcripts and a fake `claude` binary on `PATH`; no network or credits.
