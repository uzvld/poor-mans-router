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
| calibrate: estimate missing coding/agentic from intelligence by regression | rejected: on the live snapshot coding fit (n=152, R² 0.87) extrapolates 5.5 to 0.998 against a maximum of 0.816 observed; agentic fit (n=108) has R² 0.017 |

## Fix boundary

- `openrouter-intel.ts`: fifth request `task_type=intelligence`, stored as `ModelIntel.intelligence`.
- `ranking.ts`: when a candidate set contains a route with no coding index but with an intelligence
  index, every route in the set is scored on `0.35 + 0.38 * intelligence + 0.10 * reliability`. A
  route with no index at all scores 0.01 below the weakest measured one, never a neutral prior (I7).
  taskFit and popularity are left out of this basis: their neutral 0.5 priors outweighed a real
  intelligence lead (opus-5.5, review finding). Otherwise unchanged.

## Differential replay (live 2026-10-11 snapshot, every class x preference)

Tier winners: only `balanced` changes (`sonnet-5` → `sonnet-5-5`). Production `free` (`value`) and
`small` (`speed`) winners are unchanged. Class-level orderings change in 8 of 16 classes
(the basis is switched for the whole candidate set whenever it holds an intelligence-only route):

| class (preference) | before | after | why |
|---|---|---|---|
| sonnet-sub | claude-sonnet-5 | claude-sonnet-5-5 | intended |
| opus-sub | claude-opus-5 | claude-opus-5-5 | intended (57.6 vs 50.8) |
| best-available | claude-opus-5 | claude-opus-5-5 | same model as opus-sub |
| luna-sub | gpt-5.6-luna | gpt-6-luna | newer model measured only on intelligence |
| opus-ish-sub | gpt-5.6-sol | gpt-6.1-sol | newer model measured only on intelligence |
| strong-chinese | openrouter/deepseek-v4-pro | openrouter/z-ai/glm-5.3 | set re-scored on intelligence |
| cheap-flash | openrouter/gemini-3.8-flash | kilo/z-ai/glm-5.3-flash | set re-scored on intelligence |
| best-free, healthy-free, healthy-free-fast (quality, speed) | kilo/qwen3.8-27b:free | kilo/deepseek-v4-flash:free | 12 intelligence-only routes switch the class; margin 0.002 |

The last four rows are side effects, not intent: a handful of intelligence-only routes move the
whole class off the coding basis, and a 0.002 intelligence margin then overrides a 0.05 coding lead.
A route that goes DRAINING or COOLDOWN removes its set from the basis decision, so the winner of a
class can change when a route that is never chosen changes health.

A first version kept the neutral prior for unmeasured routes and also flipped production `free`
to `tencent/hy3:free`; pinned by the I7 tests in `intelligence-fallback.test.ts`.

## Not fixed here

`claude-sonnet-4-6` and other 4.x ids do not match the snapshot's `claude-4.6-sonnet` word order, so
they carry no intel at all. Pre-existing, separate from this finding.

The fifth request raises a persistently failing refresh to 480 requests/day against the 500/day
account quota (384 before). The `intelligence` rows already carry `coding_index`/`agentic_index`,
so one response could feed all three normalisers; not verified that it is a superset of the
`coding` and `agentic` responses, hence not done.
