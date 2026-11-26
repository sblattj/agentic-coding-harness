# Secret masking

Agent transcripts carry whatever the agent saw: API keys pasted into prompts, `.env` files a tool
read, connection strings, emails, home-directory paths. `ach` can redact those before an export
leaves the machine (capture time), and can scrub artifacts you already have before you share them
(share time) (#71).

Implementation: [`src/core/masking.ts`](../src/core/masking.ts) (pure detectors and the one export
chokepoint, `maskForExport`), [`src/cli/scrub.ts`](../src/cli/scrub.ts) (`ach scrub`).

## Modes

| Mode | What happens |
|---|---|
| `none` | Today's behavior: the export is written exactly as before, nothing is scanned. **The default.** |
| `preview` | Every finding is listed (location, detector, a starred sample, the replacement). Nothing is written, posted or sent. |
| `all` | Every finding is replaced, and a per-detector count goes to stderr. |

The built-in default is `none` (`DEFAULT_MASK_MODE`). Whether masking should be on by default is
pending an owner decision; until then turn it on with a flag, the env var or the config file.

Preview never prints a secret: a sample keeps at most a short prefix (`sk-ant-api...****`).

## Capture time: `--mask` on every export

```sh
ach emit --input run.json --format atif --mask all --out run.atif.json
ach emit --input run.json --format langfuse --mask all ...   # the POSTed body is masked
ach emit --input trials/ --format sft --mask preview          # list findings, write nothing
ach report trials/20260911-141210 --mask all                  # masked HTML report
```

Masking covers `ach emit` (`atif`, `otel`, `langfuse`, `sft`), `ach report`, the trial-suite
report, and the MCP tools `harness_emit` and `harness_report` (a `mask` argument). The input run is
masked once, before any emitter sees it, so message text, tool arguments, tool results and the
run's session id, agent and model are all covered. Values you type yourself (`--session-id`,
`--agent`, `--model`) are used as given.

Flags (`ach emit`, `ach report`, `ach scrub`):

- `--mask none|preview|all`
- `--mask-style replace|partial`: `replace` (default) writes `[REDACTED_API_KEY]`; `partial` keeps a
  short prefix, `sk-ant-api...****`. Emails and home paths are always fully replaced.
- `--mask-entropy`: also mask long random-looking strings (off by default, see below).
- `--mask-pattern <regex>` (repeatable): extra local shapes, replaced with `[REDACTED_CUSTOM]`. A
  named group `secret` limits the replaced span: `code=(?<secret>[A-Z]+-\d+)`.

Precedence: `--mask` > env `AGENTIC_CODING_HARNESS_MASK` > config `mask.<sink>` > config
`mask.mode` > the default. A config file can turn masking on for everything and leave one sink
alone:

```json
{ "mask": { "mode": "all", "style": "partial", "atif": "none", "patterns": ["ACME-\\d+"] } }
```

Sinks: `atif`, `otel`, `langfuse`, `sft`, `report`, `scrub`. See [CONFIG.md](CONFIG.md).

## Share time: `ach scrub`

```sh
ach scrub ./share --mask preview          # list every finding; touches no file
ach scrub ./share --mask all              # write report.masked.html, run.atif.masked.json, ...
ach scrub ./share --mask all --out-dir ./clean   # same tree under ./clean
ach scrub run.atif.json --mask preview --json    # machine-readable findings and totals
```

- Inputs are files or directories (walked recursively, in name order). Binary files are reported
  as skipped. Files that already carry `.masked.` in their name are not scanned again.
- `.json` files are parsed and masked leaf by leaf, so a finding's location is a JSON path
  (`$.steps[1].tool_calls[0].arguments.cwd`) and the copy is still valid JSON with the original
  indentation. `.jsonl` / `.ndjson` are masked per line (`line 3 $.messages[0].content`).
  Everything else (HTML, logs) is masked as text, located by `line:col`.
- Preview output is one tab-separated row per finding (`file  location  detector  sample ->
  replacement`), a per-file count line, and a total line ending `nothing written`.
- `all` never edits an original: it writes a copy to a distinct path and refuses to run if a copy
  path would equal an input. The total line ends `originals unchanged`.
- `ach scrub` with no `--mask` (mode `none`) is a usage error.

## Detectors

| Detector | Matches | Placeholder |
|---|---|---|
| `private-key` | PEM `-----BEGIN ... PRIVATE KEY-----` blocks | `[REDACTED_PRIVATE_KEY]` |
| `anthropic-key` | `sk-ant-...` | `[REDACTED_API_KEY]` |
| `openai-key` | `sk-...`, `sk-proj-...` | `[REDACTED_API_KEY]` |
| `github-token` | `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_` | `[REDACTED_GITHUB_TOKEN]` |
| `aws-access-key` | `AKIA...`, `ASIA...` (20 chars) | `[REDACTED_AWS_ACCESS_KEY]` |
| `aws-secret-key` | 40-char value after `aws_secret_access_key` | `[REDACTED_AWS_SECRET_KEY]` |
| `gcp-api-key` | `AIza...` | `[REDACTED_API_KEY]` |
| `slack-token` | `xoxb-`, `xoxp-`, ... | `[REDACTED_SLACK_TOKEN]` |
| `stripe-key` | `sk_live_`, `sk_test_`, `rk_...` | `[REDACTED_API_KEY]` |
| `jwt` | three-part `eyJ...` tokens | `[REDACTED_JWT]` |
| `bearer-token` | the token after `Bearer ` | `[REDACTED_BEARER_TOKEN]` |
| `url-credentials` | `user:password@` in a URL (connection strings) | `[REDACTED_CREDENTIALS]` |
| `credential-assignment` | the value in `PASSWORD=...`, `api_key: ...`, `SECRET_TOKEN=...` | `[REDACTED_SECRET]` |
| `email` | email addresses | `[REDACTED_EMAIL]` |
| `home-path` | `/Users/<name>`, `/home/<name>`, `C:\Users\<name>` (the rest of the path is kept) | `[REDACTED_HOME]` |
| `secret-field` | in JSON, the whole value of a key named `password`, `apiKey`, `authorization`, `secret`, ... | `[REDACTED_SECRET]` |
| `high-entropy` | opt-in, see below | `[REDACTED_HIGH_ENTROPY]` |
| `custom`, `custom-N` | `--mask-pattern` / `mask.patterns` | `[REDACTED_CUSTOM]` |

Only the secret part is replaced: `Authorization: Bearer [REDACTED_BEARER_TOKEN]`,
`postgres://[REDACTED_CREDENTIALS]@db.internal:5432/app`, `[REDACTED_HOME]/dev/app`. Masking is
idempotent: a masked file scanned again has zero findings.

JSON strings that hold JSON (tool-call `arguments` in SFT and ATIF) are masked in place and still
parse afterwards.

### High-entropy strings (opt-in)

`--mask-entropy` (or `"entropy": true`) masks tokens of 24 or more characters that mix upper case,
lower case and digits with a Shannon entropy of at least 4 bits per character. It is off by
default because transcripts are full of ids. Even when on it leaves alone: numbers, hex strings
(git SHAs, trace and span ids), UUIDs, prefixed ids such as `toolu_...`, `call_...`, `msg_...`,
and existing placeholders.

## What masking does not do

- It is pattern-based: a secret with no recognizable shape (a plain word used as a password, with
  no `password=` next to it) is not found. Use `--mask-pattern` for shapes local to your setup, or
  `--mask-entropy` for random tokens.
- OTel spans carry ids and names only (no message text), so in OTel output masking mostly matters
  for the session id and tool names.
