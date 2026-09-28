# Provenance of displayed numbers

Every number ach shows falls into one of three classes. They matter most when
two figures disagree, because a measurement and a calculation fail in different
ways.

| class | meaning | marker |
|---|---|---|
| `reported` | Taken verbatim from the agent CLI or vendor: transcript token counts, a CLI-stated `costUSD`, kiro metering credits. | none |
| `computed` | Derived by ach from reported values. Cost is tokens × the bundled LiteLLM price extract, and any sum that mixes reported and computed parts counts as computed. | `*` |
| `estimated` | A heuristic, such as context-window occupancy derived from a percentage and a stated or assumed window size. | `≈` |

A lane the agent never reported gets **no label** and renders `n/a`, as it did
before. For example, kiro on 2.21.x reports no token counts, so its RunRecord's
`provenance` map carries no `inputTokens` entry. It never says `reported`
next to a zero.

The legend reads the same on every surface:

```
* computed by ach (tokens x bundled price)  ≈ estimated (heuristic)  unmarked = reported by the agent CLI  n/a = not reported
```

## Machine output: a sibling `provenance` map

The numbers stay where they were. A `provenance` object (field name → class)
sits next to them, so a consumer that parses today's JSON sees the same values
in the same fields.

- **RunRecord** (`<stateDir>/runs/*.json`, `ach dash --json`, the web UI feed):
  `totals.provenance`. The driver rewrites it on every registry write, and
  the final write sees the run's usage verdict. A record written before 0.11.0
  has no map, so the renderers derive one for **local** records only, because
  the driver has always priced `costUsd` itself. An `source: "external"` record
  with no map stays unlabelled; ach does not know where a producer's numbers
  came from.
- **`ach stats --json`**: every bucket (`total`, `byAgent.*`, `byDay.*`) has a
  `provenance` map.

## Every user-visible number

| surface | number | class | notes |
|---|---|---|---|
| RunRecord `totals` | `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens` | reported | Absent when `usage.tokens.available === false` (renders `n/a`). |
| RunRecord `totals` | `costUsd` | computed, or reported | `computed` is pricer math. `reported` applies only when every priced record was a multi-model record whose slices carried CLI-reported `costUsd` (`totals.costSource`). A blend of both is `computed`. Absent when `usage.usd.available === false`. |
| RunRecord `totals` | `credits` | reported | Vendor metering (kiro). |
| RunRecord `totals` | `contextTokens` | estimated | Derived occupancy, not billed tokens. |
| `ach dash` table | IN / OUT / CACHE | reported | CACHE is read + write. `n/a` when unavailable. |
| `ach dash` table | COST | per `totals.provenance.costUsd` | `*` when computed. |
| `ach dash` table | CTX | estimated | Always `≈`. |
| `ach dash` footer | `cost` | computed if any visible run's cost is computed | A sum with any computed part is computed. |
| `ach dash` table | CREDITS | reported | Unmarked. |
| web UI (`ach web`) | run-list cost, metastrip `cost` | per `totals.provenance.costUsd` | `*` when computed. |
| web UI | metastrip `ctx` | estimated | `≈N tok`. |
| web UI | sidebar aggregate cost | computed if any run's cost is computed | |
| web UI | metastrip `in` / `out` / `cache` / `credits` | reported | |
| `ach stats` | `input` / `output` / `cacheRead` / `cacheWrite` / `reasoning` | reported | Machine transcripts and harness state. A bucket whose records all stated `tokensAvailable: false` has no label. |
| `ach stats` | `cost` | per `--cost-mode` | `auto`: reported where the line carried a cost, else computed. `calculate`: computed. `display`: reported, or `n/a`. A mixed bucket is `computed` (the split is in `costBySource`). |
| `ach stats --json` | `costBySource.reported` / `.computed` | as named | |
| `ach stats --json` | `records`, `costDisagreements` | untagged | Counts of rows ach read, not measurements. |
| `ach report` HTML | input / output / cache / reasoning | reported | `n/a` when unavailable. |
| `ach report` HTML | cost USD | reported, or computed | `reported` when the RunResult's token records carry provider `costUsd`. `computed` (`*`) when it falls back to `totalCost` (pricer). |
| `ach report` HTML | context | estimated | `ctx ≈ N tok`. |
| `ach report` HTML | credits | reported | |
| everywhere | duration, elapsed, wall seconds | untagged | ach's own wall clock. It is not an agent-reported value and not a price calculation, so it gets no class. |

## Not yet labelled

`ach run` (the text summary and `--json` RunResult) and the `emit`
formats (ATIF, OTel, Langfuse) do not carry a provenance map in 0.11.0. The
RunRecord written for the same run does. The `ach run` summary prints its
`context` line as `ctx ~= …` so it reads as a derived value.

### Unknown USD in web views

A run with `usage.usd.available: false` or `metering: "none"` shows `n/a`
for cost, even if its compatibility totals contain zero. Explicitly known
zero remains `$0.00`. Main and grid aggregates show the known sum plus an
unpriced-run count; with no priced runs, the sum is `n/a`. Compare means are
`null` (`n/a`) whenever any member lacks a price, with `unpricedRuns` recording
how many members are missing.

The trio cumulative USD series sums canonical `costUsd` values. It does not
substitute one model's rates for another. Once a usage record lacks a cost,
the cumulative total is unknown. The run header can still show an explicitly
available registry total when one exists. Empty event streams do not prove
zero spend.
