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
  - Lineage = same vendor (first segment of the snapshot key the route matched) and same `modelFamily`
    (`claude-sonnet`, `gpt-luna`); see Follow-ups 1.
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
  - Between two such routes of one vendor the index decides, after reliability and up to a ceiling:
    each route is raised to one step (1e-6) above the highest final score of the vendor's routes with
    a lower index, but never above its reference's quality + 0.10 + its own reliability term
    (`orderByIntelligence`; Follow-ups 2 and 3). Vendor-scoped because nothing ties one vendor's index
    scale to another's (rejected row above).
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

## Follow-ups (review round 2, branch `fix/intelligence-anchor-followups`)

Four deferred findings on the anchor above, then a third round of review (PR #21) that found a hole in the fix for
finding 2 (section 5). Tests: `intelligence-anchor-followups.test.ts` (12 tests) and `intelligence-anchor-replay.test.ts`
(4 tests; a replay of the claude slice of the live snapshot, `fixtures/intel-anchor-claude-2026-10-11.json`), plus two
fixtures of `intelligence-fallback.test.ts` moved inside the new ceiling (see 3). On the code of `bf9da81` 7 of the 16 are
red (the unmeasured-route tests and the two replays); the others are regression guards or are guarded by a mutation (the
equidistant tie, the in-bound lift, the three-route chain, the measured-pair reliability gap).

| # | finding | layer | verdict |
|---|---|---|---|
| 1 | lineage vendor came from `canonicalModelSlug(provider, id)`, the intel row from `intelForRoute`'s basename aliases | in-class comparator (anchor) | confirmed: `opencode-go/grok-4.7` has slug `opencode-go/grok-4.7`, lineage `opencode-go|grok`, no pool; the snapshot row is `x-ai/grok-4.7` |
| 2 | `0.10 x reliability` was added after the vendor ordering, so a reliability gap above ~1e-5 overrode the 1e-6 step | in-class comparator (ordering) | confirmed: opus-5.5 (rel 1.0) over sonnet-5.5 (rel 1.0) at 0.8616054 against 0.8616044; at opus 0.995 sonnet-5.5 won |
| 3 | the ordering lift was unbounded | in-class comparator (ordering) | confirmed: `mistral-medium-3` +0.131, glm-4.7-flash +0.022, gemini-2.5-flash-lite +0.017, opus-5.5 +0.008 |
| 4 | the equidistant-reference tie-break had no test | test gap | confirmed: `<=` and removing the key clause both stayed green |

### 1. The lineage is the matched snapshot key's

`intelMatchForRoute` (new, in `openrouter-intel.ts`; `intelForRoute` is a wrapper) returns the intel row
together with the key that reached it (the exact alias, or the basename's unique snapshot key). `anchoredBase`
takes that key for both vendor and `modelFamily`, the same form `buildReferencePools` keys the pools by.
The catalog slug stays in `bestModelThenCheapestSeller` (it groups sellers of a model; the intel is not involved).
The same model through two sellers now has the same score before reliability.

### 2. The ordering runs on the final score, with each route's own reliability term (decision revised in section 5)

Stating that reliability may override was the other option. It was rejected because the documented intent
is that the index decides within a vendor, and a 0.005 reliability difference between two proven routes
should not pick between opus-5.5 and sonnet-5.5. The first fix ran `orderByIntelligence` on `base + 0.10 x
reliability` for every route, raising a route to one step above the highest final score of the vendor's routes
with a lower index. Cost, stated then and understated: an unproven higher-index route was raised onto the proven
lower-index route's score, so it borrowed a reliability term it had not earned (I7). Section 5 is the corrected rule.

### 3. The lift is bounded by the credit cap (decision: ceiling = reference quality + 0.10 + own reliability)

The cap exists so that a large index gap cannot carry a route over measured routes; the ordering was the
one path that went round it. A route's raise now stops at `reference.quality + MAX_INTELLIGENCE_CREDIT` plus
its own reliability term, so no anchored route scores more than 0.10 over its measured reference (plus
reliability), credit and raise together. The reliability term is in the ceiling, not a fixed constant,
because without it a reliability gap again overrides the order inside the bound (mutation M3b).
Where two lineages' estimates differ by more than the cap the route is lifted to its ceiling and no further (mistral-medium-3
goes 0.5361 -> 0.6369, +0.1008, not the +0.131 the other lineage's anchor would give); the index decides up to the cap, not past it. This
narrows the claim of the previous version ("the index decides") to "decides up to the cap".
On the snapshot only `mistral-medium-3` is bound: its lift of 0.131 (onto `mistral-large-2407`, 1.4 index points
lower, whose anchor `mistral-large-2512` has agentic 1.0) becomes about 0.100. The others (glm-4.7-flash 0.022,
gemini-2.5-flash-lite 0.017, opus-5.5 0.008) are inside the bound and unchanged. opus-5.5 stays
above sonnet-5.5 where both have history (the all-healthy state), sonnet-5.5 stays the `sonnet-sub` winner and opus-5.5 the
`opus-sub`/`best-available` winner.
A tighter bound (lift at most the index gap supports, `0.38 x gap`) was rejected: the 0.008 opus-5.5 needs
over a 1.6-point index gap is more than 0.38 x 0.016 = 0.006.

### 4. Equidistant references

Two references the same distance from the route: the smaller key is the reference, whatever order the
snapshot lists them. One test (both listing orders, indexes 0.25 / 0.5 / 0.75, exact in binary) pins it.

### 5. Review round 3 (PR #21): an unmeasured route borrowed a measured route's reliability

Finding (I7). The ordering of section 2 ran on final scores, so an unmeasured higher-index route was raised onto a
measured lower-index route's final score and gained that route's measured reliability term in place of its own neutral
0.05. Layer: in-class comparator (anchor ordering). The ordering depends on the catalog and the history, never on health,
so the raise is in place when the measured routes it borrowed from are cooling down, which is exactly when the unmeasured
seller is picked. Reproduced on the live 2026-10-11 snapshot (`/tmp/pmr/scen.ts`, main `c7929a3` against `bf9da81`):

| scenario | main | `bf9da81` |
|---|---|---|
| (a) only `anthropic/claude-opus-5-5` cooling down, `best-available`/quality | `anthropic/claude-sonnet-5-5` (free subscription, reliability 1.0, 0.8616) | `kilo/anthropic/claude-opus-5.5` (paid, no history; 0.8116 -> 0.8616054 against 0.8616044) |
| (b) sonnet-sub, luna-sub, chinese-flash-payg, free-chinese-flash and opus-5-5 down, balanced tier and `best-available`/quality | `anthropic/claude-opus-5` (free, measured, 0.8278) | `kilo/anthropic/claude-opus-5.5` (paid, unmeasured) |

The earlier statement "no class winner moves" held only in the all-healthy state. The test that pinned the behaviour
(an unproven higher-index route winning against a proven lower-index one) asserted the defect and is replaced.

Rule chosen. A route has history when its history entry has requests (`smoothedReliability` already treats an entry with
none as the neutral prior). Within one vendor, in ascending index, a route i is raised to one step above:

| i | lower route j | bound |
|---|---|---|
| measured | measured | `final(j)` (both reliability terms are earned, so a small gap cannot turn the index order) |
| measured | unmeasured | `final(j) - term(j) + term(i)` (i's own term, never j's neutral prior) |
| unmeasured | any | `final(j) - term(j) + term(i)` (i's own neutral term, never a measured term) |

capped as before at the route's ceiling. `orderByIntelligence` keeps three running maxima per vendor (measured final, measured
reliability-free level, unmeasured level). The reviewer's one-line fix (borrow only if the raised route has history; else
floor on the lower route's base plus own term) agrees with this on every row but the second, where it floors a measured route
on an unmeasured route's final score: its neutral 0.05 is borrowed by a route whose own measured term is lower, and not
credited as its own to one whose term is higher. The rule above never lets a route take a term but its own, and the measured
pair is the single exception, which is the original goal (opus-5.5 at 0.995 against sonnet-5.5 at 1.0, both measured).
It is the same arithmetic as before for every route whose neighbours are all measured or all unmeasured, and on the live snapshot
changes no route score against `bf9da81` other than the unmeasured sellers of opus-5.5, `kilo/` and `openrouter/` (0.8616 -> 0.8116, back to main).
Same-model sellers stay ordered by cost first; among them the measured seller is never scored below an unmeasured one.

### 6. Three-route chain

`reached = Math.max(reached, lifted)` mutated to `Math.max(reached, anchor.score)` left every test green: the strictly
increasing chain was only checked between two routes. One test now has three routes (`a-2 < b-2 < c-2`, `0.699000 / 0.699001 /
0.699002` unmeasured; 0.05 higher measured) and is red under that mutation in the measured and the unmeasured accumulator.

### Differential replay

Modules: `origin/main` (`c7929a3`, before) against this branch (after), same frozen copy of the live 2026-10-11 intel snapshot,
`/tmp/pmr/scen.ts <moduleDir> <scenario>`; each run is 52 selections (16 classes x quality/speed/value, plus the 4 tier winners).
Health is overridden after the build, which is exact for this change: the ordering never reads health.

| state | selections changed (of 52) | tier winners |
|---|---|---|
| (i) live, all healthy | 0 | frontier `fable-5-1`, balanced `sonnet-5-5`, small `haiku-5-5`, free `kilo/qwen/qwen3.8-27b:free` (unchanged) |
| (ii-a) `anthropic/claude-opus-5-5` cooling down | 0 (`best-available`/quality `sonnet-5-5`, same as main; `bf9da81` moved it) | unchanged |
| (ii-b) sonnet-sub, luna-sub, chinese-flash-payg, free-chinese-flash, opus-5-5 down | 0 (`best-available`/quality `claude-opus-5`, balanced `claude-opus-5`, same as main; `bf9da81` moved both) | unchanged |
| (iii) all 46 `opencode-go` routes forced AVAILABLE | 2 | unchanged |
| (iii) with (ii-a) / (ii-b) | the same 2 | unchanged |

The all-healthy replay is identical to `/tmp/pmr/cls-final.txt`, the baseline of merged main.

(iii) is the only state with flips: `strong-flash-sub` under quality and under speed goes from `opencode-go/glm-5.3-flash`
(0.7237) to `opencode-go/mimo-v2.6-flash` (0.7334, anchored on `xiaomi/mimo-v2-flash`, finding 1). That is the intended effect of finding 1,
not disclosed before: it is hidden on the live snapshot only because every opencode-go route is cooling down (the weekly window is spent). No
other class or preference changes with opencode-go available.

Route scores (1166 routes, 7 change against main; reliability 0.5 unless stated):

| route | before | after | why |
|---|---|---|---|
| `opencode-go/mimo-v2.6-flash` | 0.6710 | 0.7334 | finding 1: now anchored on `xiaomi/mimo-v2-flash`, equals `openrouter/xiaomi/mimo-v2.6-flash` (0.7334); in `flash`, `strong-flash-sub`, `cheap-sub`, `best-available` |
| `opencode-go/mimo-v2.6-pro` | 0.7023 | 0.7364 | finding 1; `best-available` |
| `opencode-go/mimo-v2-pro` | 0.6750 | 0.6692 | finding 1 (the neutral prior was above its real reference); `best-available` |
| `opencode-go/grok-4.7` | 0.7008 | 0.7515 | finding 1: equals `openrouter/x-ai/grok-4.7`; `best-available` |
| `opencode-go/minimax-m2.5` | 0.6750 | 0.6327 | finding 1; `chinese`, `best-available` |
| `openrouter/mistralai/mistral-medium-3`, `kilo/mistralai/mistral-medium-3` | 0.6668 | 0.6369 | finding 3: raise bounded, 0.131 -> 0.100; `best-available`, available, and still no winner |

`openrouter/anthropic/claude-opus-5.5` and `kilo/anthropic/claude-opus-5.5` (0.8116) are unchanged against main: the 0.8616 of `bf9da81` was the
defect of section 5. The earlier text "of these only the opencode-go routes sit in a class and none wins one" was wrong twice: the
opus-5.5 and mistral-medium-3 routes are in `best-available`, and opencode-go wins nothing only while all 46 of its routes are cooling down.

### Mutation results

Each guard was mutated in a scratch copy of `extension/` (`/tmp/pmr/fix-mut.py`, the whole suite) and the named tests went red; the
unmutated tree is green (218 / 218 router tests, 7 / 7 simulation).

| mutation | red | red tests |
|---|---|---|
| M1 lineage and vendor from the catalog slug instead of the matched key | 4 | the three bare-id twin tests (mimo-v2.6-flash, grok-4.7, minimax-m2.5); a bare-id route is ordered against its vendor by the snapshot vendor |
| M2 ordering before reliability (reliability added after) | 2 | a reliability gap between two proven routes; a 0.005 reliability gap does not flip opus-5.5 against sonnet-5.5 |
| M3 no ceiling | 1 | the order lifts a route at most 0.10 above its reference |
| M3b ceiling without the reliability term | 8 | same, plus the replay (healthy), both reliability tests, the proven-over-unproven test and the bare-id ordering test |
| M3c ceiling reference + 0.15 | 1 | the order lifts a route at most 0.10 above its reference |
| M4 equidistant `<` becomes `<=` | 1 | with two references equally far the smaller key is the reference |
| M5 equidistant key clause removed | 1 | same |
| M6 ordering step 0 | 10 | the strictly-increasing family (higher index wins, in-bound lift, chain, bare-id ordering, unproven/proven tests, both reliability tests, live scenario a) |
| M7 ordering across vendors | 1 | across vendors an intelligence-only route is placed by its own reference |
| N1 every route measured (the ordering of `bf9da81`) | 7 | replays (a) and (b), the I7 test, the proven-over-unproven test, both live synthetic scenarios |
| N2 no route measured | 2 | the two measured-pair reliability-gap tests |
| N3 measured route ignores unmeasured routes below | 2 | a proven higher-index route placed above an unproven one by its own term; a history entry with no requests is no history |
| N4 unmeasured route ignores unmeasured routes below | 5 | higher index wins between two intelligence-only routes; bare-id ordering; the ceiling and in-bound tests; the chain |
| N5 unmeasured route ignores measured routes below | 2 | the I7 test; live synthetic scenario (a) |
| N6 unmeasured route borrows the measured final score | 5 | replays (a) and (b), the I7 test, both live synthetic scenarios |
| N7 level keeps the route's reliability term | 10 | replays (a), (b) and most of the ordering tests |
| N8 chain by raw anchor, unmeasured | 1 | the three-route chain |
| N9 chain by raw anchor, measured (`Math.max(reached, anchor.score)`) | 1 | the three-route chain, measured |
| N10 "measured" = history entry exists, not requests > 0 | 1 | a history entry with no requests is no history |
