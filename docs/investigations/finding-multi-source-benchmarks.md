# Finding: the AA index was re-based, one source decided every ranking, and a scale bug fed it

Date: 2026-10-30. Layers: telemetry (intel fetch, normaliser) → scoring (`qualityFromIntel`, `benchmarkPower`) → ladders.
Design: `docs/superpowers/specs/2026-10-30-benchmark-snapshots-design.md`. Plan: `docs/superpowers/plans/2026-10-30-benchmark-snapshots.md`.

## Symptom

`pmr/balanced` kept selecting `anthropic/claude-sonnet-5` although `claude-sonnet-5-5` was `AVAILABLE` in the same
class (`sonnet-sub`), cost the same and had a clean history. The same symptom as
[finding-intelligence-only-benchmarks.md](finding-intelligence-only-benchmarks.md) (2026-10-11), with a different cause.

## Reproduction

Installed modules replayed against the live capture of 2026-10-30 (`fixtures/bench-2026-10-30/`, test
`extension/tests/bench-sonnet-5-5-replay.test.ts`): `sonnet-5` 0.7913, `sonnet-5-5` 0.7534, winner `sonnet-5`.

## Root cause

Artificial Analysis re-based its Intelligence Index between 2026-10-11 and 2026-10-30. Compared on the same models
(`fixtures/intel-anchor-claude-2026-10-11.json` against the 2026-10-30 cache):

- 16 Anthropic models lost `intelligence` (`claude-2` … `sonnet-5`, `opus-5`); `coding` and `agentic` stayed.
- All 5 that kept it changed value: sonnet-5.5 0.56 → 0.542, opus-5.5 0.576 → 0.584, fable-5.1 0.534 → 0.497,
  haiku-5.5 0.434 → 0.362. None unchanged.

`anchoredBase` needs a reference with both `coding` and `intelligence`. The `sonnet` lineage had none left, so
sonnet-5.5 fell back to the neutral 0.5 priors. Independent sources disagree with the router by a wide margin:

| source | sonnet-5.5 | opus-5.5 | sonnet-5 |
|---|---|---|---|
| LMArena agent board, rank | 3 | 1 | 16 |
| Epoch `apex_agents` pass@1 (max) | 0.755 | 0.735 | 0.545 |
| LMArena text `coding` rating | 1512 | 1547 | 1484 |

The re-base is an inference from the two snapshots: the Data API needs a key and this repo never reads one (I12).

## Hypotheses

| hypothesis | verdict |
|---|---|
| the merge in `mergeOpenRouterIntel` drops `intelligence` | disproved: with the field in the payload it survives, with `null` it is absent (replay) |
| sonnet-5-5 is down or in cooldown | disproved: `AVAILABLE`, no local state |
| price or reliability decides | disproved: both subscription routes, 0 effective cost, `qualityScore` is the first comparator key |
| keep the last known `intelligence` of older models | rejected: 0.382/0.508 are on the old index, 0.542 on the new one; mixing scales happened to give the right winner only by coincidence |
| AA re-based its index and one source is a single point of failure | **confirmed** |

## Second finding, found by the differential replay: AA indices were read on the wrong scale

`normalizeBenchmarkRows` divided a value by 100 only when it exceeded 1. AA indices are points out of 100
(`fixtures/aa-bench-2026-09-22.json`: agentic tops out at 57.9, the weakest models score 0.1–1). Nineteen of 100
agentic rows had a raw `score` of 1, 0.9, 0.8, 0.6, 0.5 or 0.1 and were kept as fractions: `arcee-ai/trinity-large-thinking`
(coding 0.258) had agentic 1.0, a perfect score. Fixed with `indexScore` (always ÷100), red test first. The captured
cache was written by the old code: 14 impossible agentic values (four 1.0, five 0.9, five 0.8) are corrected in
`aa-intel.json` and listed in its README; the others (raw 0.6, 0.5, 0.1) cannot be recovered and heal on the next refresh.

## Third finding: `general` on its own scale beats nothing

The first version fed the raw intelligence index into the composite. It runs at 0.2–0.5 against 0.4–0.8 for coding
and agentic, so a model rated on it lost to one that was not: `glm-5.3-flash` lost `chinese-flash-payg` to
`deepseek-v4-flash-vision-exp` although AA and every other source rate it higher on both axes. The blend now puts
`general` on the coding scale through the line fitted on the models that have both (`ModelIntel.general`); the raw
`intelligence` index stays what `anchoredBase` reads. Red tests: `bench-blend.test.ts` (general block) and
`bench-weights.test.ts`.

## Change

Four sources (AA, Epoch, LMArena, BenchLM) → dated snapshots (`state.bench.json`, 30 per source, staleness 24 h,
retry floor 15 min, no cron) → `blendIntel` (each source mapped onto the AA scale per benchmark, effort row =
better of `high`/`xhigh`, confidence-weighted mean, re-base detection, nerf penalty ≤ 0.015) → the `IntelMap` the
ranking code already reads. Tier weights (`policy.yml` `weights:`) replace the fixed 0.24/0.14 and 0.63/0.37.

## Differential replay (same snapshot, before → after; `/tmp` script, 24 selections per capture)

`2026-10-30` capture, AA alone → blended evidence: 11 of 24 selections change.

| selection | before → after | why |
|---|---|---|
| balanced, `sonnet-sub`, `best-available` | sonnet-5 → **sonnet-5-5** | the intended fix |
| frontier ladder | `fable-sub > opus-sub` → `opus-sub > fable-sub` | opus-5.5 above fable-5.1 on every blended facet (coding 0.862/0.823, agentic 0.676/0.569), LMArena agent rank 1 vs 4, Epoch frontierswe 0.623 vs 0.563. Both are subscriptions: `swappable`, hysteresis 0.02 respected |
| frontier winner, `opus-sub` | fable-5-1 / opus-5 → **opus-5-5** | follows the ladder; opus-5.5 is new evidence-wise |
| balanced `chinese-flash-payg` | glm-5.3-flash → **deepseek-v4.1-flash** | AA does not list v4.1-flash at all; the other three sources rate it coding 0.735 against 0.697. **The 2026-10-11 note rejected this flip when it came from gpt-6-luna's anchor; here it comes from measurement. Owner to confirm.** |
| free tier / `best-free` / `healthy-free(-fast)` / frontier `best-free` | nemotron-3.5-super-vl / qwen3.8-27b → **mimo-v2-pro:free** | see open question below |

`2026-09-22` capture (no other sources): 0 of 24 selections change.

## Open question for the owner (not changed here)

A model measured on fewer facets is renormalised over the facets it has. In the data agentic runs systematically
below coding (sonnet-5: 0.44 against 0.72), so a model with **no** agentic score beats a measured one of similar
coding strength: `mimo-v2-pro:free` (coding 0.587, no agentic) over `qwen3.8-27b:free` (coding 0.651, agentic 0.401)
in the free and frontier-`best-free` classes. The alternative is to impute a missing facet from the model's others
through the same kind of fitted line `general` now uses. That changes how a missing score is valued, which is a
policy decision (`AGENTS.md`), so it is left as it is and listed here.

## Tests re-pinned (each explained)

- `rungs.test.ts`: `benchmarkPower({coding: 0.8, agentic: 0.5})` 0.689 → 0.66875, the balanced weights renormalised.
- `intelligence-fallback.test.ts`: the ulp-exact formula pin is a 1e-12 tolerance (the formula runs through the weights).
- `intelligence-anchor-followups.test.ts`, `intelligence-fallback.test.ts`: score routes with `ANCHORING_WEIGHTS`
  (0.24/0.14/0), the blend those tests were written under; they pin anchoring, not tier policy.
- `preload.ts`: `fetch` refuses everything but loopback, so no suite reaches a public endpoint.

## Verification

- 351 router tests, `scripts/fixture-simulation.test.ts` 7/7, `install.test.sh`, `bootstrap.test.sh` pass.
- 15 mutations of the new guards (empty snapshot, retry floor, field drift, nerf cap, both re-base rules, swapped tier
  weights, raw intelligence as power, fraction scale, zip bound, unreleased claim, missing facet as zero, effort order,
  future-dated snapshot, general off the coding scale): all turn a test red.
- Live: not yet; see the PR for the install proof.

## Deployment note

`state.intel.json` on a machine that ran the old code holds values from the old normaliser. After install they are used
until the next Data API refresh (6 h TTL), so for up to six hours some weak models can still carry an inflated agentic
score. Nothing is dropped automatically.
