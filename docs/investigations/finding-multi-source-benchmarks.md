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

The status output includes the source's methodology version separately from its publication date
(`version bench-align-v5` versus `data 2026-10-29`). A red/green formatter smoke caught and corrected
the initially missing version field; the status and benchmark-wiring suites passed afterward (15 tests).

The nerf regression also exposed a projection-order bug: subtracting the penalty before fitting `general`
changed every peer's calibration, then `general` was penalised a second time. In the reproduced ten-model
cohort a 0.015 penalty lowered the affected model's general score by approximately 0.030006.
The fit now uses unpenalised measurements, followed by one model-local subtraction on each composite facet.
Raw AA `intelligence` remains unchanged: it is an anchor coordinate, not an external overall score or a nerf
target. The regression failed before the fix; afterward the affected power fell by 0.015 and peers stayed
unchanged. External overall/hard-prompt readings populate `general` without fabricating AA intelligence.

Boundary review corrections reject an incomplete LMArena board (early empty page or page cap before
the declared total), cancel Epoch's streamed response once it exceeds 32 MiB rather than allocating the
entire response first, and omit BenchLM observations outside its documented 0–100 score domain.
The streamed Epoch path was exercised against the captured real ZIP and still recovered Sonnet 5.5's
APEX-Agents 0.755 and FrontierSWE 0.618893 observations.

The trend window now starts at the most recent rebaseline boundary; an unchanged post-rebaseline model
must not be compared with its old scale. Rebaseline movement uses the magnitude of the signed median
cohort change, so half the models rising and half falling is not mistaken for a shared shift.
ISO release dates are stripped before generation normalization, so dated Epoch rows match undated routes.

`anchoredBase` is a last resort only when `benchmarkPower` finds no usable facet under that tier's weights.
Measured agentic/general evidence now reaches the composite instead of being overwritten by an
intelligence-only estimate. A zero-weight facet still leaves the old fallback available. A general-only
measurement also counts as benchmark evidence in the tie-break against an otherwise equal unmeasured model.

The blend/ladder cache key includes every source's retained snapshot timestamps and methodology versions,
not their maximum timestamp. A slower source can finish after a peer whose timestamp is newer; the old
maximum-only key ignored that evidence. A managed-session regression first reproduced the stale Sonnet 5.5
pick after an older-timestamp source arrived, then passed when the new evidence correctly selected Sonnet 5.

Sidecar writes now use a separate short writer transaction rather than the network-refresh claim.
The owner token is created atomically, only a provably dead process can be reclaimed, and malformed/live
lock contention fails in bounded time instead of hanging refresh forever. Reads and per-source due checks
use the current clock so a legitimate newer peer snapshot is not dropped as future-dated.
An AA credential-lookup rejection no longer prevents the independent keyless refresh.

## Differential replay (same snapshot, before → after; `/tmp` script, 24 selections per capture)

`2026-10-30` capture, AA alone → blended evidence: 10 of 24 selections change after review corrections.

| selection | before → after | why |
|---|---|---|
| balanced, `sonnet-sub`, `best-available` | sonnet-5 → **sonnet-5-5** | the intended fix |
| frontier ladder | `fable-sub > opus-sub` → `opus-sub > fable-sub` | opus-5.5 above fable-5.1 on every blended facet (coding 0.866/0.825, agentic 0.676/0.569), LMArena agent rank 1 vs 4, Epoch frontierswe 0.623 vs 0.563. Both are subscriptions: `swappable`, hysteresis 0.02 respected |
| frontier winner, `opus-sub` | fable-5-1 / opus-5 → **opus-5-5** | follows the ladder; opus-5.5 is new evidence-wise |
| balanced `chinese-flash-payg` | glm-5.3-flash → **deepseek-v4.1-flash** | AA does not list v4.1-flash at all; the other three sources rate it coding 0.736 against 0.695. **The 2026-10-11 note rejected this flip when it came from gpt-6-luna's anchor; here it comes from measurement. Owner to confirm.** |
| free tier / `best-free` / `healthy-free(-fast)` | nemotron-3.5-super-vl → **mimo-v2-pro:free** | see open question below; frontier `best-free` remains qwen3.8-27b after preserving raw AA coordinates |

`2026-09-22` capture (no other sources): 0 of 24 selections change.

## Open question for the owner (not changed here)

A model measured on fewer facets is renormalised over the facets it has. The missing-agentic case still
needs a policy decision: MiMo v2 Pro has coding 0.579 and no agentic, while Qwen3.8-27B has coding 0.648 and
agentic 0.401. Qwen now has higher final quality (frontier 0.711686 vs 0.710410; free 0.720145 vs 0.711118),
so frontier `best-free` stays Qwen. The free tier's existing agentic-first value preference instead uses
MiMo's neutral 0.5 agentic prior and selects it over Qwen's measured 0.401. Changing that prior or imputing
missing facets alters policy (`AGENTS.md`); neither is silently changed here.

## Existing test migrations

- Removed the duplicate default-weight numeric pin in `rungs.test.ts`; explicit tier-weight behaviour is covered
  by `bench-weights.test.ts`. Removed the old exact-formula test in `intelligence-fallback.test.ts` rather than
  preserving an implementation-detail assertion with a different tolerance.
- `intelligence-anchor-followups.test.ts`, `intelligence-fallback.test.ts`: score routes with `ANCHORING_WEIGHTS`
  (0.24/0.14/0), the blend those tests were written under; they pin anchoring, not tier policy.
- `preload.ts`: `fetch` refuses everything but loopback, so no suite reaches a public endpoint.

## Verification

- 369 router tests passed across 49 files using `bun test tests/[!._]*.test.ts` from `extension/`.
  The root `bun run test` command includes binary AppleDouble sidecars on this checkout and fails on them.
- Snapshot simulation passed 7/7; router install, bridge install and bootstrap scripts passed against temporary targets.
- A real four-process smoke preserved all 40 snapshots and all four attempt records in the shared sidecar.
- 21 deliberate guard mutations were killed, with no surviving or unchecked case: empty snapshots, retry floor,
  cohort drift, nerf cap, methodology/lost-facet rebaseline rules, tier weights, raw intelligence as power,
  AA index scaling, ZIP bounds, claim release, missing facets, effort order, future snapshots, general projection,
  duplicate nerf, raw AA coordinate protection, composite precedence, signed cohort shift, trend boundaries and ISO dates.
- Live deployment proof is not yet available; temporary install tests and fixture replay do not satisfy it.

## Deployment note

`state.intel.json` on a machine that ran the old code holds values from the old normaliser. After install they are used
until the next Data API refresh (6 h TTL), so for up to six hours some weak models can still carry an inflated agentic
score. Nothing is dropped automatically.

## Publication gate

The full-tree `secret-scan.sh --all` run is blocked. Gitleaks' `generic-api-key` rule reports 27 public
BenchLM model identifiers in `canonicalModelKey` fields and two attestation hashes in an unrelated local
temporary PR description. These are not access credentials, but the repository contract does not permit
changing scanner allowlists or bypassing hooks to publish them. The earlier staged scans are not evidence
of a clean full-tree gate. No push or PR creation is claimed while this remains unresolved.
