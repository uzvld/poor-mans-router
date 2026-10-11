# Finding: new models publish only the Intelligence Index, so `balanced` stayed on the older sibling

Date: 2026-10-11. Layer: telemetry (intel fetch) → in-class comparator.

## Symptom

`pmr/balanced` selected `anthropic/claude-sonnet-5` although `claude-sonnet-5-5` was `AVAILABLE` in
the same class (`sonnet-sub`), cost the same (subscription = 0), and had more measured requests
with 0 errors.

## Root cause (one)

Artificial Analysis publishes the overall Intelligence Index for a new model first; `coding_index`
and `agentic_index` follow later. Live 2026-10-11 `GET /benchmarks?source=artificial-analysis&task_type=intelligence`:

| model | intelligence | coding | agentic |
|---|---|---|---|
| opus-5.5 | 57.6 | null | null |
| sonnet-5.5 | 56.0 | null | null |
| haiku-5.5 | 43.4 | null | null |
| sonnet-5 | 38.2 | 71.5 | 43.6 |

The router requested only `task_type=coding` and `task_type=agentic`, which return only rows with a
non-null index, so the 5.5 family was absent. `qualityFromIntel` then scored it with neutral
0.5 coding/agentic: quality 0.753 vs 0.794 for sonnet-5. `qualityScore` is the first key of
`bestComparator`; price, generation and affinity were never reached.

## Hypotheses

| hypothesis | verdict |
|---|---|
| reliability history favours sonnet-5 | disproved: 1304 req / 0 errors for 5.5 vs 1093 / 0 |
| price decides | disproved: both 0 effective cost on the subscription; price is 4th key |
| slug matching drops 5.5 (`5.5` vs `5-5`) | disproved: `intelAliases` bridges it; the row is not in the response |
| API has no 5.5 rows | disproved for `intelligence`; true for `coding`/`agentic` |
| normalisation loses the row | disproved: raw response dumped with the account key, no row |

## Fix boundary

- `openrouter-intel.ts`: fifth request `task_type=intelligence`, stored as `ModelIntel.intelligence`.
- `ranking.ts`: when a candidate set contains a route with no coding index but with an intelligence
  index, every route in the set is scored on the intelligence basis. A route with no index at all
  gets the set's lowest score, never a neutral prior (I7). Otherwise unchanged.

Differential replay on the live snapshot (all four tiers): only `balanced` changes
(`sonnet-5` → `sonnet-5-5`). A first version that kept the neutral prior for unmeasured routes
also flipped `free` (`qwen3.8-27b:free` → `tencent/hy3:free`); that regression is pinned by the
I7 test in `intelligence-fallback.test.ts`.

## Not fixed here

`claude-sonnet-4-6` and other 4.x ids do not match the snapshot's `claude-4.6-sonnet` word order, so
they carry no intel at all. Pre-existing, separate from this finding.
