# Update check (`ach update --check`)

Version awareness, never self-update. `ach` is a measurement harness whose runs must be
reproducible, so nothing here downloads, replaces or modifies the running binary. The command
only reports whether a newer release exists.

Default installs make no network calls: the automatic check is off unless you opt in.

## Explicit: `ach update --check [--json] [--offline]`

One GET of the release feed, then:

```text
$ ach update --check
new version 0.33.0 available: https://github.com/sblattj/agentic-coding-harness/releases/tag/v0.33.0 (you have 0.32.1)
$ ach update --check
up to date (0.32.1)
$ ach update --check --json
{"current":"0.32.1","latest":"0.33.0","url":"https://github.com/...","updateAvailable":true,"checkedAt":"2026-01-01T00:00:00.000Z"}
```

- Exit 0 whether or not a newer release exists. An unreachable or malformed feed prints
  `harness: update check failed: ...` to stderr and exits 1 (explicit mode never fails silently).
- Always hits the network (no cache short-circuit) and refreshes the cache on success.
- `--offline` installs the usual offline guard: a non-loopback feed is refused with
  `OfflineViolation`, a loopback feed (a local stub) is allowed.
- `ach update` without `--check` prints the usage and exits 1.
- Versions are compared semver-style against the running version (`ach --version`); a leading
  `v` on the tag is stripped, a release outranks its own prereleases.

## Automatic: once per 24h, opt-in

```sh
export AGENTIC_CODING_HARNESS_UPDATE_CHECK=1
```

When set (`1` or `true`), any command except `update`, `mcp`, `statusline`, `--version` and help
makes at most one request per 24h (timeout 2.5s) and, if a newer release exists, prints one line
to stderr (never stdout, so `--json` output stays clean):

```text
ach: new version 0.33.0 available: https://... (you have 0.32.1; silence with AGENTIC_CODING_HARNESS_UPDATE_CHECK=0)
```

Offline or failed attempts are silent. The attempt time is still cached, so an offline machine
does not retry on every command. Commands run with `--offline` skip the automatic check. There is
no config-file key for this: the opt-in is the environment variable only.

## What it talks to

| Item | Value |
|---|---|
| Feed | `GET https://api.github.com/repos/sblattj/agentic-coding-harness/releases/latest` |
| Override | `AGENTIC_CODING_HARNESS_UPDATE_FEED_URL` (tests point it at a local stub) |
| Headers | `accept: application/vnd.github+json`, `user-agent: agentic-coding-harness/<version>` |
| Fields read | `tag_name` (version, leading `v` stripped) and `html_url` (release page) |
| Sent | nothing else: no identifiers, no usage data |

## What it writes

Only `<state dir>/update-check.json` (`AGENTIC_CODING_HARNESS_STATE_DIR`, default
`~/.agentic-coding-harness`):

```json
{ "checkedAt": 1767225600000, "latest": "0.33.0", "url": "https://github.com/..." }
```

`checkedAt` is epoch milliseconds. Delete the file to force the next automatic check.
