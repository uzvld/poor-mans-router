# Multi-source benchmark snapshots — design

**Date:** 2026-10-30
**Status:** Proposed — awaiting owner approval. Nothing is built.
**Scope:** a project (new data layer + scoring change). Touches `ranking.ts`, `rungs.ts`, `openrouter-intel.ts`, `state.ts`, `index.ts`, `policy.yml`.

## 1. Why

On 2026-10-30 `balanced` kept selecting `claude-sonnet-5` instead of `claude-sonnet-5-5`. Root cause (replayed on a live snapshot, see the chat investigation): the Artificial Analysis (AA) Intelligence Index, served through the OpenRouter Data API, was re-baselined between 2026-10-11 and today. Every older Anthropic model lost its `intelligence` field (16 models, `claude-2` … `sonnet-5`, `opus-5`) and all five survivors changed value (none unchanged). `anchoredBase` in `ranking.ts` needs a reference with both `coding` and `intelligence`; the `sonnet` lineage pool became empty, so `sonnet-5.5` fell back to the neutral 0.5 priors and scored 0.7534 against `sonnet-5` at 0.7913.

Independent public data says the router is wrong, and says it by a wide margin:

| source | sonnet-5.5 | opus-5.5 | sonnet-5 |
|---|---|---|---|
| LMArena **agent** leaderboard, rank | 3 | 1 | 16 |
| Epoch `apex_agents` pass@1 (max effort) | 0.755 | 0.735 | 0.545 |
| Epoch `frontierswe` score | 0.619 | 0.623 | — |
| LMArena text, `coding` category rating | 1512 | 1547 | 1484 |

One vendor, one index version, one fetch is a single point of failure for the whole ranking. The router must (a) take evidence from several independent sources, (b) keep dated snapshots so a re-baseline is *detected* instead of silently trusted, and (c) notice a model that degrades after release.

## 2. Goals, non-goals, anti-goals

**Goals**
- Fetch benchmark evidence from four sources, keep a dated snapshot per refresh, compare every model on every facet available.
- Inside the owner's tiers (which are defined by price), always rank the strongest model first, using weights that differ per tier.
- Survive an upstream re-baseline, a missing source, and a model that no source has measured yet.
- Penalise a model whose rating falls after release (post-release nerfs).
- Apply results automatically; no manual approval step.

**Non-goals**
- A cron/launchd job. Refresh is driven by staleness (§5), like `intelRefreshDue` today.
- Moving a model across a tier or class boundary on benchmark evidence (§3.3 of `design.md`, I1).
- Replacing health, quota or reliability logic.

**Anti-goals** (the feature fails even if it "works" if…)
- A benchmark fetch can block or delay a turn, or throw into routing (the router must fail open).
- A missing score is treated as a low score, or as a high one (I7).
- Two scores from different index versions are mixed in one comparison.
- Any secret, account id or raw telemetry reaches git (public repo; `AGENTS.md` gate).

## 3. Constraints

- Invariants I1, I7, I8, I9, I10, I12 hold unchanged; each stays guarded by its existing test. A new test per new guard, proven red by mutation.
- Tiers keep their meaning: price/economics groups from `policy.yml` (subscription before paid before free, `rungs.ts` rule 4). Benchmarks only order *inside* that structure.
- `RUNG_HYSTERESIS` (0.02) and "ladders derived once per snapshot, never per turn" stay; the new signal changes inputs, not the anti-flap rules.
- OpenRouter key comes from `ctx.modelRegistry` at runtime and is never persisted (I12). Keyless sources need no credential.
- OpenRouter Data API budget: 5 requests per AA refresh, 500/account/day, 429 handling already in `openrouter-intel.ts`.
- Network failures per source are independent and silent; the last good snapshot of that source stays in use.
- Snapshot files are per-machine runtime state: gitignored, like `state.json`.
- Fixtures committed to git go through `scripts/sanitize-fixtures.py` and `scripts/secret-scan.sh`.

## 4. Sources (checked live 2026-10-30; all answered HTTP 200 without a key except AA)

| source | access | licence / obligation | useful facets | model naming |
|---|---|---|---|---|
| OpenRouter → Artificial Analysis | Data API, key from OMP | existing terms | `coding`, `agentic`, `intelligence` (0–1) | `anthropic/claude-sonnet-5.5-20260928` |
| Epoch AI | `epoch.ai/data/benchmark_data.zip` (2.4 MB, CSV; `benchmark_metadata.csv` lists 91 benchmarks with `scale`, `score_ceiling`, `superseded_by`) | **CC-BY 4.0: credit Epoch AI** | coding/agentic benchmarks (`frontierswe`, `apex_agents`, `cursorbench`, `webdev_arena`, …) | `claude-sonnet-5-5_max` (effort suffix) |
| LMArena | HF datasets-server, dataset `lmarena-ai/leaderboard-dataset`; configs `text` (categories `overall`, `coding`, `hard_prompts`, …) and `agent` (`score`, CI, `observation_count`, `session_count`, `rank`); modified daily | CC-BY 4.0 (dataset card) | human preference (`text`), agent outcomes (`agent`) | `Claude Sonnet 5.5 (xHigh)` |
| BenchLM | `benchlm.ai/data/leaderboard.json` and siblings; 214 items, `rankingMode bench-align-v5`, items carry `evidenceStatus` (e.g. `estimated`) | **CC BY-NC 4.0; attribute "Data from BenchLM.ai"**. Owner confirms the project is non-commercial and open source. | overall + 8 category scores | `claude-sonnet-5-5` (`canonicalModelKey`) |

LMArena `text` ratings are human preference, not task accuracy: weak weight for `frontier`, never decisive alone. BenchLM `estimated` items count with lower confidence.

Attribution lives in `README.md` and in `/route-status` output for any source in use.

## 5. Approach (chosen)

Three approaches were considered; the owner picked the first and rejected cron.

1. **All in the extension, staleness-driven — chosen.** Source adapters + a snapshot store + a scoring layer, wired into the existing `refreshIntel` path. Gaps in history on days the machine is not used are accepted.
2. Extension plus a standalone daily script for the keyless sources. Rejected by the owner (no cron).
3. Replace `qualityFromIntel` with one unified power index. Rejected for now: widest blast radius (I7, I9, every differential) for the same data.

## 6. Design

### 6.1 Snapshot
- One refresh of one source yields a **snapshot**: `{source, fetchedAt, sourceVersion, publishedAt?, rows}`. `sourceVersion` names the source's **methodology** (BenchLM `rankingMode`); a source that states none uses a constant (`aa`, `epoch`, `lmarena`). It is never a publication date or a content hash: those change with every update and would flag every snapshot as a re-baseline. `publishedAt` carries the date the source states for its data (LMArena `leaderboard_publish_date`, newest Epoch release, BenchLM `generatedAt`) and is only shown. *Corrected during implementation: the first draft used the date as the version.*
- Staleness rule per source: refresh when the newest snapshot is older than 24 h. Retry floor 15 min after a failure; a 429 keeps the existing block logic. Sources refresh independently; a failed source keeps its last good snapshot and is marked stale in `/route-status` after 72 h.
- Refresh runs in the background from `session_start` / `before_agent_start`, exactly where `refreshIntel` runs today; it never awaits on the turn path.
- Retention: the last 30 daily snapshots per source in a gitignored sidecar of `state.json` (`state.bench.json`, written atomically; same multi-process merge rule as `IntelStore`: newest wins, per source).

### 6.2 Normalisation and matching
- Every adapter emits rows keyed to a **model identity** the router already understands (reuse `intelAliases`/`canonicalModelSlug`, extended for the three new naming schemes, and the `modelFamily` rule of I9).
- Effort/variant suffixes (`_max`, `(xHigh)`, `(High)`) collapse to one model. The router does not set reasoning effort (OMP does; there is no effort handling in `extension/`), so the row used follows the owner's stated usual level, **high/xhigh**: the better of the `high` and `xhigh` rows of that model; if neither exists, the nearest `max`, then `medium`. The level is one policy constant, not per-route state.
- Scores are comparable only **within one source and one `sourceVersion`**. Each source facet is mapped onto the AA 0–1 scale of that facet using the models both measured (builder picks linear or quantile fit; min-max when fewer than 5 models overlap), so composites keep AA-comparable magnitudes and `RUNG_HYSTERESIS` (0.02) keeps its meaning. A different constant is a recorded finding plus an owner decision, never a silent change.

### 6.3 Re-baseline detection
- Compare the new snapshot with the previous one of the same source. If the new `sourceVersion` differs, or a configured share of previously measured models lose a facet or move together beyond noise, the source is flagged **rebaselined**: its new snapshot is used alone; old values are never merged into it (this is what a "keep the last known value" fix would get wrong). `/route-status` says so.

### 6.4 Composite score
- Three facets, each fed by the sources below. Human-preference ratings are inputs with low confidence, not a facet of their own.

  | facet | inputs |
  |---|---|
  | `coding` | AA `coding`; Epoch coding benchmarks (e.g. `frontierswe`, `cursorbench`, SWE-Bench verified, Aider polyglot, `webdev_arena`); LMArena `text`/`coding`; BenchLM coding category |
  | `agentic` | AA `agentic`; **LMArena `agent` (highest confidence: millions of observations, tens of thousands of sessions)**; Epoch agent benchmarks (e.g. `apex_agents`, Terminal Bench, OSWorld); BenchLM agentic category |
  | `general` | AA `intelligence`; BenchLM overall; LMArena `text`/`overall` and `hard_prompts` |

  The builder fixes the exact Epoch benchmark list from `benchmark_metadata.csv`; benchmarks with `superseded_by` set are skipped and `score_ceiling` is used to scale the rest. Several benchmarks in one facet combine as a confidence-weighted mean.
- A model's facet value is the confidence-weighted mean over the sources that measured it. A source that did not measure the model contributes nothing — never 0, never the prior (I7). A model missing a whole facet has its tier weights renormalised over the facets it does have; a model with no facet at all keeps today's neutral priors.
- AA stays a first-class input; it no longer gates the score on `anchoredBase`. The anchor is a last resort only when no measured `coding`, `agentic`, or projected `general` facet has positive weight for the current tier. A facet excluded by tier weights does not disable the fallback.
- The tier-weighted composite replaces `0.24 * coding + 0.14 * agentic` in `qualityFromIntel` as `0.38 * composite` (same 0.38 budget, so taskFit, reliability, popularity and the score scale stay unchanged), and replaces the 0.63/0.37 blend in `benchmarkPower`. Routes are scored per tier and `computeLadders` consumes those per-tier lists. Formula-only assertions are removed rather than re-pinned; behavioural anchoring tests use explicit weights, and differential replay explains every selection change.

- **Correction made while building (found by the differential replay).** `general` is not averaged in on the intelligence scale: that index runs at 0.2-0.5 against 0.4-0.8 for coding and agentic, so a model rated on it lost to one that was not. The blend maps the general readings onto the coding scale through a fitted line (`ModelIntel.general`); raw AA-origin `intelligence` is never overwritten by external readings or nerf penalties. Without five paired models no projected `general` is made up.
- **Second correction.** `normalizeBenchmarkRows` read an AA index of 1 or less as a fraction; AA indices are points out of 100. Fixed (`indexScore`); see `docs/investigations/finding-multi-source-benchmarks.md`.
- **Left open.** Missing facets are renormalised away in the composite. The free tier's existing agentic-first value preference also uses a neutral 0.5 when agentic is missing; that can beat a measured value below 0.5 even when the measured model has higher quality. Imputing a missing facet or changing that prior is a policy change and is not made here.

### 6.4a Tier weights (my proposal)
| tier | what matters | facet weights (coding / agentic / general) |
|---|---|---|
| `frontier` | hardest agentic work | 0.40 / 0.45 / 0.15 |
| `balanced` | strong at a fair price; price already decided by class economics | 0.45 / 0.35 / 0.20 |
| `small` | speed/price first; benchmark only breaks ties | 0.40 / 0.20 / 0.40 |

`free` keeps its agentic-first value preference (`design.md` §10.1). Weights live in `policy.yml` under a new `weights:` block; changing them is the owner's call, not a code change. *Numbers are my judgment, not measured.*

### 6.5 Nerf penalty
- From the history, per model: `trend = (rating_now − median rating over the last N snapshots) − cohort drift`, where cohort drift is the median of the same quantity over all models measured in both snapshots, so a recalibration that moves everyone is not read as a nerf. Applied to LMArena `text` and `agent` rows (the only source here that republishes often). A relative drop larger than the row's own confidence interval subtracts a bounded penalty from that model's composite (cap chosen by the builder, below the hysteresis step so one noisy day cannot reorder rungs). Nerf scoring is suppressed for a source flagged rebaselined (§6.3).
- The existing reliability term (OMP request history) already penalises a degrading model from observed failures; the two are independent and both stay.
- Not verified: how often LMArena actually republishes. The trend window is therefore *snapshots*, not days.

### 6.6 What the owner sees
- `/route-status` gains per source: age, `sourceVersion`, rebaselined/stale flags, number of models matched, and for the chosen route its composite and the per-source contributions.
- Attribution lines (§4).

## 7. Verification (acceptance)
1. Replay today's post-re-baseline snapshot: `balanced` selects `anthropic/claude-sonnet-5-5`; red before the change, green after. The AA part is the cache the extension already holds (`state.intel.json`: public benchmark scores, model slugs, no credentials), the other three sources are captured live; all pass through `scripts/sanitize-fixtures.py` and `scripts/secret-scan.sh` and carry their attribution header.
2. Differential replay for all three tiers and every class, before/after, on the same snapshot; every changed line explained.
3. Each source can be unreachable, malformed, or empty: routing still works and the last good snapshot is used.
4. A synthetic re-baseline (all scores shifted, a lineage's reference missing) does not demote a newer model.
5. A synthetic nerf (rating falls beyond CI over the window) lowers that model by no more than the cap and never crosses a class boundary.
6. I1, I7, I8, I9, I10, I12 tests unchanged and green; `bun run test`, `bun run test:sim`, install scripts green.
7. Live proof: one fresh `omp` session, `/route-status` saved to a file (sanitised).

## 8. Left to the builder
Adapter code layout; exact normalisation function; confidence weights per source; the rebaseline threshold; the nerf cap and window; the on-disk format of `state.bench.json`; how `intelAliases` extends to the three new naming schemes; test fixtures (sanitised, with attribution headers).

## 9. Calls made after the independent builder check (mine, not the owner's)
Open for the owner to overrule while reading:
1. Four weights collapsed to three facets; the composite keeps the 0.38 budget of the old formula (§6.4).
2. Facet mapping, with LMArena `agent` as the top-confidence agentic input (§6.4 table).
3. Fixtures come from the live capture described in §7.1; no OpenRouter key is needed for them.
4. Nerf trend is measured relative to the cohort and suppressed on a rebaselined source (§6.5).
5. Composites are mapped onto the AA scale and `RUNG_HYSTERESIS` stays 0.02 (§6.2).
6. Epoch ships as a zip: no new dependency; a minimal reader over `node:zlib` with a size bound, failing open (the extension today has no dependencies and the install scripts copy plain `.ts`).
7. Effort rule follows the owner's answer, high/xhigh (§6.2).
