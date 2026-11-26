# League tables: a shareable leaderboard from your runs

`ach report` folds runs into a league table: one row per `experiment` ×
`variant`, with runs, success rate, mean and median cost, tokens and wall
time, and the run ids each row aggregates. The table is part of the
single-file HTML report (sortable, zero external resources), and the same rows
are written to a machine-readable `leaderboard.json` next to it, so a script,
a bot or another site can read the leaderboard without scraping HTML (#90).

## Walkthrough: run → leaderboard → share

### 1. Run a matrix

Declare the grid once and let the harness label every run
([docs/TRIALS.md](TRIALS.md#ach-trial---matrix-resumable-trial-grids)):

```sh
ach trial --matrix examples/trial-matrix.json
```

Each cell becomes one run whose RunRecord carries `experiment` (the plan's)
and `variant` (default `{agent}:{model}`). `ach run --experiment E --variant V`
labels one-off runs the same way.

### 2. Check the rollup live (optional)

`ach web` serves `GET /api/compare`, the experiment × variant rollup over the
run registry. The league table is built from the same function
(`computeCompareGroups` in `src/web/compare.ts`), so its `runs`,
`successRate`, `avgCostUsd`, `avgTotalTokens` and `avgDurationMs` equal the
`/api/compare` row for the same run set.

### 3. Build the leaderboard

From the run registry (`<stateDir>/runs/`), no paths to type:

```sh
ach report --registry --out site/index.html
# wrote site/index.html (9 runs · 1 trial)
# wrote site/leaderboard.json (9 league rows)
```

`--limit N` keeps the newest N runs. From trial directories instead:

```sh
ach report trials/20260911-141210
# writes trials/20260911-141210/report.html and trials/20260911-141210/leaderboard.json
```

A trial run that has a RunRecord (joined by run id) rolls up from that record,
so its `experiment` and `variant` labels apply. A trial run with no record
(copied from another machine, or older than the registry) rolls up from its
RunResult, grouped by agent like an unlabeled `/api/compare` row; its member
`runId` is the RunResult's `runId`, else `<trial>/<agent>`.

`--registry` and trial paths are two run sources: giving both is a usage
error. `--json` prints the report model, which now includes the same
`leaderboard` document.

### 4. Share

The HTML is one file with inline CSS and JS; the JSON is one file. Send them,
attach them to a PR, or publish the directory as a static site.

Before sharing outside your machine, sanitize at export time. The league table
goes through the same export gate as the rest of the report:

```sh
ach report --registry --privacy anon --mask all --out site/index.html
```

`--privacy anon` hashes every run id (league members and per-run rows get the
same hash) and drops prompt text; `--privacy redact` shortens paths; `--mask`
scrubs secrets. See [docs/MASKING.md](MASKING.md).

## Determinism

Regenerating from unchanged runs gives byte-identical HTML and JSON:

- runs fold newest first with run id breaking ties (the order `/api/compare`
  reads the registry in, so float sums and the display `agent` match it), and
  each row's `members` list oldest first, so registry file order never leaks
  in;
- rows keep the `/api/compare` order (experiment, then variant, ascending);
- there is no wall-clock "generated at" time. The only timestamp is
  `dataAsOf`, the newest run end in the set, shown in the page footer as
  "data as of". It is `null` (and the footer shows none) when no run carries a
  real time (a trial run with no RunRecord carries none).

A run still marked `running` reports `running` while its process is alive
and `interrupted` after, exactly as in `/api/compare`, so its row can change
between two reports.

## `leaderboard.json` schema

Top-level fields:

| field | type | meaning |
|---|---|---|
| `schema` | string | always `ach.leaderboard` |
| `schemaVersion` | number | `1`; bumped on any breaking change to these fields |
| `groupBy` | string[] | always `["experiment", "variant"]` |
| `dataAsOf` | string or null | ISO time of the newest run end in the set |
| `runs` | number | runs folded into the table |
| `rows` | object[] | one per experiment × variant, in table order |

Row fields (every row has every field; `null` means not known, never omitted):

| field | type | meaning |
|---|---|---|
| `experiment` | string | the run's `experiment`, else its agent (the `/api/compare` fallback) |
| `variant` | string or null | the run's `variant` |
| `agent` | string | the first run's agent (display convenience, as in `/api/compare`) |
| `runs` | number | runs in the row |
| `successRate` | number or null | successes / runs with a verdict (success, error, aborted); outages, interrupted and running runs are out of the denominator; `null` when none had a verdict |
| `avgCostUsd` | number or null | mean USD per run; `null` when any run in the row is unpriced |
| `medianCostUsd` | number or null | median USD per run; `null` under the same rule |
| `unpricedRuns` | number | runs with no trustworthy USD value |
| `avgTotalTokens` | number | mean input + output tokens per run |
| `medianTotalTokens` | number | median input + output tokens per run |
| `avgDurationMs` | number | mean wall time (end minus start), ms |
| `medianDurationMs` | number | median wall time, ms |
| `unavailable` | number | runs whose agent CLI or service was unavailable (#60) |
| `noVerdict` | number | interrupted, running or status-less runs |
| `passRate` | number or null | share of verified runs whose checker passed (#29); `null` when none was verified |
| `members` | object[] | the runs this row aggregates, oldest first |

Member fields:

| field | type | meaning |
|---|---|---|
| `runId` | string | the run id (hashed under `--privacy anon`) |
| `agent` | string | the run's agent |
| `verdict` | string | `success`, `failure`, `unavailable` or `none`: what the run added to `successRate` |
| `seal` | string or null | `ach verify-run` verdict of the run's transcript seal (#59): `ok`, `tampered`, `unsealed` or `open`; `null` when the run has no RunRecord |

The HTML league table renders the same rows: each cell's `data-v` attribute
holds the raw JSON value (empty for `null`) and `data-f` names the field, so
the page and the JSON can be checked against each other.
