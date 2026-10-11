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
| one scoring basis for the whole candidate set whenever it holds an intelligence-only route (first fix, commits `fe10c79`..`23e209b`) | rejected: 10 of 16 classes (13 of 48 selections) changed on the replay; 12 intelligence-only free routes moved whole free classes off the coding basis and a 0.002 intelligence margin overrode a 0.05 coding lead (`qwen3.8-27b:free` → `deepseek-v4-flash:free`); the basis depended on which routes were healthy, so a never-chosen route changing health could flip the winner |
| anchor on the same-lineage measured model, uncapped, no ordering between lineages | rejected: `best-available` flips `opus-5` → `sonnet-5-5` (0.862 vs opus-5.5 at 0.854): sonnet-5 codes far above its index (coding 71.5 at index 38.2), so its successor inherits a 0.008 lead over opus-5.5 although the index rates opus higher |
| same, credit capped at 0.05, no ordering between lineages | rejected: `cheap-sub` flips `haiku-5-5` → `gpt-6-luna`; haiku-5.5 (index 43.4) sits 0.27 above its weak measured predecessor, the cap cuts its credit, while gpt-6-luna (index 38.1) keeps a strong reference |
| ordering by the index across all vendors (envelope over every anchored route) | rejected: `chinese-flash-payg` flips `glm-5.3-flash` → `deepseek-v4.1-flash` (index 39.5 against 41.8) because gpt-6-luna's estimate lifted it |

## Fix boundary

- `openrouter-intel.ts`: fifth request `task_type=intelligence`, stored as `ModelIntel.intelligence`.
- `ranking.ts` `buildRoutes`: a route with an intelligence index and no coding index is placed on
  the coding scale by a measured model of its own lineage, not by neutral priors and not by a
  basis switch for the candidate set. Only that route's `qualityScore` changes (plus the exact-tie
  rule below); every other route's score is untouched, and the score is fixed by catalog and snapshot alone,
  so candidate-set membership and route health cannot change it.
  - Lineage = same vendor (first slug segment) and same `modelFamily` (`claude-sonnet`, `gpt-luna`).
    The reference is the measured model (coding and intelligence both published) of the lineage
    closest to the route in intelligence; it is read from the snapshot, so it need not be in the
    catalog. No measured lineage: the route keeps the neutral priors, exactly as before.
  - Score = reference benchmark quality (its coding, agentic, taskFit, popularity) + credit +
    `0.10 x` the route's own reliability. Credit = `min(0.10, 0.38 x (index - reference index))`;
    0.38 is the weight the formula gives coding plus agentic. On the snapshot's 43 measured
    same-lineage successor pairs the realised quality step minus `0.38 x` index gap has quantiles
    p10 -0.026, p25 -0.015, median +0.007, p75 +0.028, p90 +0.051, so the slope is unbiased inside a
    lineage. The 0.10 cap is the 90th percentile of the same steps (median 0.033, p75 0.056): a bigger
    gap is extrapolation and must not carry a model over other lineages' measured routes. It is a
    judgment constant, pinned by a test. The reference's taskFit and popularity are used, the route's
    own are not: opus-5.5's lone taskFit of 0.024 outweighed a 6.8-point index lead against the
    neutral 0.5 prior (review finding).
  - Between two such routes of one vendor the index decides: each index value takes the highest
    anchored base of the vendor at or below it, plus 1e-6 when that merely ties (`envelopeBases`).
    Vendor-scoped because nothing ties one vendor's index scale to another's (rejected row above).
  - `NormalizedRoute.benchmarked` and `qualityOrder`: on an exact `qualityScore` tie a route that
    has any published index ranks above one that has none (I7), under quality, value and speed. This
    is what keeps an intelligence-only route with no measured lineage above an unmeasured newer one.
- Removed: `intelligenceQualityScore`, `codingMeasured`, the per-set basis switch and its
  floor for routes without an index.

## Differential replay (live 2026-10-11 snapshot, every class x preference)

Modules: `origin/main` (before) against this branch (after), same snapshot
(`/tmp/pmr/classes.ts <moduleDir>`, 16 classes x quality/speed/value = 48 selections).

**5 of 16 classes change, 5 of 48 selections, all under `quality`.** The previous per-set rule changed 10
classes (13 selections; an earlier draft of this note said 8, grouping the three free classes as one). The other 11 classes are identical under every preference, including
`strong-chinese`, `cheap-flash`, `cheap-sub`, `chinese-flash-payg`, `best-free`, `healthy-free` and
`healthy-free-fast`.

| class (quality) | before | after | why |
|---|---|---|---|
| sonnet-sub | claude-sonnet-5 | claude-sonnet-5-5 | intended: 0.794 → 0.862 (reference sonnet-5, index 38.2 → 56.0, credit 0.068; before, neutral priors gave 0.753) |
| opus-sub | claude-opus-5 | claude-opus-5-5 | intended: reference opus-5 (index 50.8 → 57.6, credit 0.026), lifted to the sonnet-5.5 estimate by the vendor ordering: 0.8616 against 0.828 |
| best-available | claude-opus-5 | claude-opus-5-5 | same model as opus-sub; sonnet-5-5 sits 1e-6 below it because the index rates opus higher |
| luna-sub | gpt-5.6-luna | gpt-6-luna | newer lineage member, index 38.1 against 37.3, same subscription price: 0.699 → 0.727 (before, neutral priors gave 0.694) |
| opus-ish-sub | gpt-5.6-sol | gpt-6.1-sol | newer lineage member, index 51.8 against 47.0, plus 0.997 measured reliability against none: 0.734 → 0.802 (before, neutral priors gave 0.707) |

Tier winners (frontier, balanced, small, free x quality/speed/value, 12 selections): only `balanced`
under `quality` changes (`sonnet-5` → `sonnet-5-5`). `balanced` under `speed` stays `sonnet-5` (latency leads
that preference) and under `value` is already `sonnet-5-5`; production `small` (`speed`) and `free` (`value`)
are unchanged.

A first version kept the neutral prior for unmeasured routes and also flipped production `free`
to `tencent/hy3:free`; pinned by the I7 tests in `intelligence-fallback.test.ts`.

## Guards and mutation results

`intelligence-fallback.test.ts` (22 tests). Run against the previous per-set rule (the `HEAD` code),
8 of them fail; each guard of the new rule was then mutated in a scratch copy and the named test(s) went red:

| mutation | red test |
|---|---|
| previous per-set basis switch restored | far-away route does not re-rank two measured routes; DRAINING unrelated route does not flip A vs B; and six more |
| lineage ignores the family | measured model of another family is not a reference |
| lineage ignores the vendor | measured model of the same family name from another vendor is not a reference |
| no intelligence credit | successor outranks an unrelated measured route its reference was below (and 3 more) |
| no cap / cap 0.05 | the credit is capped at 0.10 |
| first reference instead of closest | the reference is the same-lineage model closest in intelligence |
| reference's reliability instead of the route's | the successor keeps its own reliability (and 3 more) |
| no evidence tie-break (all / quality+value / speed only) | route with only an index beats an unmeasured newer one; with no measured reference a route that has an index still beats one that has none |
| anchoring applied to coding-measured routes | coding-measured route keeps exactly its formula score (and 3 more) |
| no ordering between lineages / no strict step | between two intelligence-only routes of one vendor the higher index wins |
| ordering across vendors | across vendors a route is placed by its own reference |

## Not fixed here

`claude-sonnet-4-6` and other 4.x ids do not match the snapshot's `claude-4.6-sonnet` word order, so
they carry no intel at all. Pre-existing, separate from this finding.

The fifth request raises a persistently failing refresh to 480 requests/day against the 500/day
account quota (384 before). The `intelligence` rows already carry `coding_index`/`agentic_index`,
so one response could feed all three normalisers; not verified that it is a superset of the
`coding` and `agentic` responses, hence not done.
