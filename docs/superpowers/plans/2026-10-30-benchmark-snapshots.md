# Multi-source benchmark snapshots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fetch benchmark evidence from four sources on a 24 h staleness rule, keep dated snapshots, blend them into the `IntelMap` the router already consumes, and weight the blend per tier, so `balanced` selects `claude-sonnet-5-5`.

**Architecture:** Source adapters emit `BenchSnapshot`s; `BenchStore` keeps the last 30 per source in `state.bench.json`; `blendIntel` maps every source onto the AA scale, blends per facet, applies the nerf penalty and returns a plain `IntelMap` (AA keys overlaid, new models added). `ranking.ts`/`rungs.ts` stay structurally the same: only the `0.24/0.14` and `0.63/0.37` constants become tier weights. `anchoredBase` stays as a last resort.

**Tech Stack:** Bun, TypeScript loaded directly by OMP, `node:test` + `bun test`. No new dependency.

**Spec:** `docs/superpowers/specs/2026-10-30-benchmark-snapshots-design.md`

## Global Constraints

- Install copies only `extension/*.ts` and `policy.yml` (`scripts/install.sh:118`): every new module is a flat `extension/bench-*.ts`, never a subdirectory.
- No new dependency; no secret read from disk (I12); AA key only from `ctx.modelRegistry`.
- Invariants I1, I7, I8, I9, I10, I12 and their tests stay green and unchanged. A missing score is never 0 and never a prior bonus (I7).
- Refresh never awaits on the turn path and never throws into routing; each source fails open and keeps its last good snapshot.
- Staleness 24 h, retry floor 15 min, 30 snapshots per source, effort rule: better of `high`/`xhigh`, else `max`, then `medium`.
- `RUNG_HYSTERESIS` stays 0.02; nerf cap 0.015 (below it).
- Tier weights (coding/agentic/general): frontier 0.40/0.45/0.15, balanced 0.45/0.35/0.20, small 0.40/0.20/0.40; `free` uses balanced's.
- Attribution: "Data from BenchLM.ai", Epoch AI (CC-BY 4.0), LMArena dataset (CC-BY 4.0) in `README.md` and `/route-status`.
- `bun test` from `extension/` (it preloads `PMR_STATE_FILE`); exclude AppleDouble: `bun test $(ls tests/*.test.ts | grep -v '/\._')`.
- Committed fixtures pass `scripts/sanitize-fixtures.py` / `scripts/secret-scan.sh`. **The implementer makes no commits**; the owner commits after review with the `Secret-Scan:` trailer (`AGENTS.md`).

## Review Focus

1. A source answers HTTP 200 with an empty or changed-schema body: no snapshot is stored, the last good one stays.
2. A model name no mapping understands (unknown vendor, odd casing such as `GPT-6 Luna (Max)`): the row is dropped, never mis-keyed.
3. `qwen3` vs `trinity`-style names: identity parsing never merges models across families (I9).
4. A corrupted, hand-edited or future-dated `state.bench.json` reads as empty.
5. A malformed or oversized Epoch zip fails open.

## File Structure

| file | responsibility |
|---|---|
| `extension/bench-types.ts` (new) | `Facet`, `BenchSource`, `Effort`, `BenchObservation`, `BenchRow`, `BenchSnapshot`, `FacetWeights`, `ATTRIBUTION` |
| `extension/bench-identity.ts` (new) | `canonicalBenchModel(name, organization?)` |
| `extension/bench-lmarena.ts`, `bench-epoch.ts`, `bench-benchlm.ts`, `bench-aa.ts` (new) | one adapter each: `parse*`, `fetch*` |
| `extension/bench-store.ts` (new) | `BenchStore`, `benchRefreshDue`, retention |
| `extension/bench-rebaseline.ts` (new) | `detectRebaseline` |
| `extension/bench-blend.ts` (new) | `mapToReference`, `pickEffortRows`, `nerfPenalties`, `blendIntel` |
| `extension/policy.ts`, `policy.yml`, `types.ts` | `weights` block, `RouterPolicy.weights` |
| `extension/ranking.ts`, `rungs.ts` | weighted composite; per-tier ladder input |
| `extension/index.ts`, `status.ts` | refresh wiring, `/route-status` |
| `fixtures/bench-2026-10-30/*` | sanitised live capture |
| tests in `extension/tests/bench-*.test.ts` | one file per module |

---

### Task 1: Fixtures and the RED replay

**Files:** Create `fixtures/bench-2026-10-30/` (`aa-intel.json`, `lmarena-text-{overall,coding,hard_prompts}.json`, `lmarena-agent.json`, `epoch-<benchmark>.csv`, `benchlm-leaderboard.json`, `omp-models.json`, `omp-usage.json`, `codexbar.json`, `omp-stats.json`, `README.md` with attributions); Test `extension/tests/bench-sonnet-5-5-replay.test.ts`.

**Interfaces:** Produces `fixtures/bench-2026-10-30/*` read by every later test; replay helper `routesFor(tier, intel)`.

- [ ] **Step 1:** Copy the captures in `/tmp/pmr-live/` (usage, codexbar, stats, models) to `fixtures/raw/`, run `python3 scripts/sanitize-fixtures.py fixtures/raw fixtures/bench-2026-10-30`, read the "removed field paths" report. AA: copy `state.intel.json` `data` only (no cache metadata). LMArena/Epoch/BenchLM: keep only the fields adapters read and only rows of vendors present in the catalog. `omp-models.json`: `provider`, `id`, `cost` only.
- [ ] **Step 2:** `scripts/secret-scan.sh` on each new file; fix findings by removing content, never by widening `ALLOW`.
- [ ] **Step 3: failing test** `balanced with the 2026-10-30 AA snapshot alone selects sonnet-5-5`: builds routes from the fixtures with `intel = aa-intel.json`, `selectForTier(routes, DEFAULT_POLICY.tiers.balanced.classes, {allowDraining: true, preference: 'quality'})`, asserts `route.key === 'anthropic/claude-sonnet-5-5'`.
- [ ] **Step 3b:** run `cd extension && bun test tests/bench-sonnet-5-5-replay.test.ts`; expected FAIL with winner `anthropic/claude-sonnet-5` (reproduces the live bug).

### Task 2: Types and model identity

**Files:** Create `bench-types.ts`, `bench-identity.ts`; Test `tests/bench-identity.test.ts`.

**Interfaces:** Produces
```ts
export type Facet = 'coding' | 'agentic' | 'general';
export type BenchSource = 'aa' | 'epoch' | 'lmarena' | 'benchlm';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export interface BenchObservation { facet: Facet; value: number; confidence: number; label: string; effort?: Effort; ci?: number }
export interface BenchRow { model: string; observations: BenchObservation[] }
export interface BenchSnapshot { source: BenchSource; fetchedAt: number; sourceVersion: string; publishedAt?: string; rows: BenchRow[] }  // sourceVersion = methodology, publishedAt = the source's data date (shown only)
export type FacetWeights = Record<Facet, number>;
export function canonicalBenchModel(name: string, organization?: string): { model: string; effort?: Effort } | undefined;
```
`model` is `vendor/slug`, lower case, dotted versions, no effort, no date (`anthropic/claude-sonnet-5.5`); same shape as `intelAliases` keys.

- [ ] **Step 1: tests** (names + assertions): `Claude Sonnet 5.5 (xHigh)` → `anthropic/claude-sonnet-5.5`, effort `xhigh`; `claude-sonnet-5-5_max` → same model, `max`; `claude-sonnet-5-5` (BenchLM) → same model, no effort; `GPT-6.1 Sol (Max)` → `openai/gpt-6.1-sol`; `Qwen3.8 Max` and a `trinity-*` name never share a key (I9); an unknown vendor/name → `undefined`.
- [ ] **Step 2:** run, expect FAIL. **Step 3:** implement; vendor from `organization` via a small table, else from a family prefix (`claude`→anthropic, `gpt`→openai, `gemini`→google, …); reuse `modelFamily`/`stripVariants` where they fit. **Step 4:** run, expect PASS.

### Task 3: Adapters (independent; run in parallel)

Each adapter: pure `parse*` plus `fetch*(fetchImpl = fetch, now = Date.now())` that returns a `BenchSnapshot` or throws; 10 s timeout (Epoch 30 s); a body that parses to zero rows throws. Fixture rows are the tests' input.

**3a `bench-lmarena.ts`** — `parseLmarena(input: {text: Record<'overall'|'coding'|'hard_prompts', unknown[]>; agent: unknown[]}, fetchedAt: number): BenchSnapshot`. `agent` rows → facet `agentic` (value `score`, `ci` from `score_ci_*`, confidence 0.9); `text/coding` → `coding` (0.4); `text/overall` and `hard_prompts` → `general` (0.4); `sourceVersion` `'lmarena'`, `publishedAt` = `leaderboard_publish_date`. `fetchLmarena` pages `datasets-server.huggingface.co/filter` (100 rows/page, stop at `num_rows_total`, cap 20 pages).
Tests: Sonnet 5.5 agent rank row becomes an `agentic` observation with effort from the suffix; an empty page set throws.

**3b `bench-epoch.ts`** — `readZipEntries(zip: Uint8Array, wanted: (name: string) => boolean, maxBytes: number): Record<string, string>` (stored + deflate via `node:zlib` `inflateRawSync`; reject zip64, encryption, any entry over `maxBytes`, compressed total over 8 MB); `parseEpoch(files: Record<string, string>, fetchedAt: number): BenchSnapshot` using `benchmark_metadata.csv` (skip rows with `superseded_by`, scale by `score_ceiling`). Facet map: coding = `frontierswe`, `cursorbench`, SWE-Bench verified, Aider polyglot, `webdev_arena`; agentic = `apex_agents`, Terminal Bench, OSWorld. Confidence 0.8; `sourceVersion` `'epoch'`, `publishedAt` = newest `Release date`. Only benchmarks that `benchmark_metadata.csv` describes are read, which excludes `cursorbench` and `webdev_arena` (no declared scale or ceiling).
Tests: a hand-built zip (built in the test with `node:zlib`) round-trips; a truncated zip and a 20 MB claimed entry throw; `claude-sonnet-5-5_max` → `apex_agents` 0.755 agentic observation, effort `max`.

**3c `bench-benchlm.ts`** — `parseBenchlm(json: unknown, fetchedAt: number): BenchSnapshot`: `items[].score` → `general` (÷100), `categories.coding[].score` / `categories.agentic[].score` → `coding` / `agentic` (in a category list `displayScore` is the overall score, the category's is `score`); `evidenceStatus === 'estimated'` halves confidence (base 0.5); `sourceVersion` = `rankingMode` (methodology; `dataVersion` is a content hash), `publishedAt` = `generatedAt` date.
Tests: the `claude-sonnet-5-5` item parses; an item with an unknown `creator` is dropped.

- [ ] Per adapter: write the tests, run (FAIL), implement, run (PASS).

**3d `bench-aa.ts`** — `aaSnapshot(intel: IntelMap, fetchedAt: number): BenchSnapshot`: `coding`/`agentic`/`intelligence` → facets, confidence 1.0, `sourceVersion` `'aa'` (no version is exposed); keys through `canonicalBenchModel` of the slug. Test on `aa-intel.json`: 15 intelligence-only rows keep only `general`.

### Task 4: Store, refresh rule, re-baseline detection

**Files:** Create `bench-store.ts`, `bench-rebaseline.ts`; modify `.gitignore` (`state.bench.json`, `*.bench.json`, `*.bench.json.lock`); Tests `bench-store.test.ts`, `bench-rebaseline.test.ts`.

**Interfaces:**
```ts
export type BenchHistory = Partial<Record<BenchSource, BenchSnapshot[]>>; // oldest → newest, ≤ 30
export class BenchStore {
  static besideStateFile(stateFile: string): BenchStore;      // state.json → state.bench.json
  read(now?: number): { history: BenchHistory; attempts: Partial<Record<BenchSource, number>> };
  append(snapshot: BenchSnapshot, now?: number): BenchHistory; // atomic; newest wins per source across processes
  recordAttempt(source: BenchSource, now?: number): void;
  claim(now?: number): (() => void) | undefined;              // delegates to IntelStore.claim on the same filename
}
export const BENCH_TTL_MS = 24 * 3_600_000;
export const BENCH_RETRY_FLOOR_MS = 15 * 60_000;
export function benchRefreshDue(state: ReturnType<BenchStore['read']>, source: BenchSource, now?: number): boolean;
export function detectRebaseline(previous: BenchSnapshot | undefined, next: BenchSnapshot): { rebaselined: boolean; reason?: string };
```
`detectRebaseline` rules: `sourceVersion` differs → rebaselined (only BenchLM's `rankingMode` can differ; the constants of AA, Epoch and LMArena never trigger this rule); or ≥ 30 % of the models measured in `previous` on a facet lose that facet in `next`; or the median absolute change of within-snapshot min-max scores of models present in both exceeds 0.05.

- [ ] Tests: a 200 with zero rows is never appended (store rejects empty); corrupted JSON and a `fetchedAt` in the future read as empty; retention keeps 30; two stores writing different sources keep both; `benchRefreshDue` is false at 23 h, true at 25 h, false 14 min after a failed attempt; **the live case**: `previous` = the 2026-10-11 fixture (`intel-anchor-claude-2026-10-11.json`) vs `next` = `aa-intel.json` → rebaselined (16 of 27 lose `general`).
- [ ] Run (FAIL), implement, run (PASS).

### Task 5: Blend

**Files:** Create `bench-blend.ts`; Test `tests/bench-blend.test.ts`.

**Interfaces:**
```ts
export function mapToReference(source: Array<{ model: string; x: number }>, reference: Map<string, number>): (x: number) => number;
export function pickEffortRows(observations: BenchObservation[]): BenchObservation[];
export function nerfPenalties(history: BenchHistory): Map<string, number>;   // model → 0..0.015
export interface BlendReport { rebaselined: BenchSource[]; matched: Record<BenchSource, number>; byModel: Record<string, Partial<Record<Facet, Array<{ source: BenchSource; label: string; value: number; mapped: number; confidence: number }>>>> }
export function blendIntel(base: IntelMap, history: BenchHistory): { intel: IntelMap; report: BlendReport };
```
- `mapToReference`: least-squares line fitted on models both measured (≥ 5), clamped to 0..1; fewer than 5 overlapping → min-max onto the reference range; no reference at all → min-max onto 0..1.
- `pickEffortRows`: rows at `high`/`xhigh` (best value wins); else `max`; else `medium`; no effort stated → kept.
- Facet value = Σ(confidence × mapped) / Σ confidence over the observations of the models' sources; a source without the model adds nothing (I7).
- `nerfPenalties`: from LMArena `agentic`/`coding`/`general` observations, `(value_now − median of last 7 snapshots) − cohort drift` (median of the same quantity over models present in both); needs ≥ 3 snapshots; only a drop beyond the row `ci` counts; penalty = `min(0.015, drop scaled to the AA range)`; none while LMArena is rebaselined.
- `blendIntel`: output `coding`/`agentic` from those facets, `intelligence` from `general`; AA keys overlaid when `intelAliases` matches, otherwise the canonical key added; `taskFit`/`popularity` untouched; penalty subtracted from each facet (floor 0).

- [ ] Tests: **the live case** — blending `aa-intel.json` with the LMArena/Epoch/BenchLM fixtures gives `anthropic/claude-sonnet-5.5` a `coding` and `agentic` value above `sonnet-5`'s; a model only in LMArena is added; a model absent from a source is not lowered by it; effort picking prefers `xhigh`/`high` over `max`; nerf: a synthetic 3-snapshot fall beyond `ci` yields a penalty ≤ 0.015, the same fall on every model yields 0 (cohort drift), and 2 snapshots yield 0.
- [ ] Run (FAIL), implement, run (PASS).

### Task 6: Tier weights in scoring and ladders

**Files:** Modify `types.ts` (`RouterPolicy.weights?: Record<Tier, FacetWeights>`), `policy.ts` (`DEFAULT_POLICY.weights`, `normalizePolicy` validates: three finite numbers ≥ 0 summing > 0, else the default), `policy.yml` (`weights:` block), `ranking.ts`, `rungs.ts`; Tests `policy.test.ts`, `ranking.test.ts`, `rungs.test.ts`, `tests/bench-weights.test.ts`.

**Interfaces:**
```ts
// ranking.ts — composite renormalised over the facets present; undefined when none
export function facetComposite(intel: IntelMap[string] | undefined, weights: FacetWeights): number | undefined;
// BuildRoutesInputs gains: weights?: FacetWeights   (default DEFAULT_POLICY.weights.balanced)
// rungs.ts
export function benchmarkPower(intel: IntelMap[string] | undefined, weights?: FacetWeights): number | undefined;
export function computeLadders(policy: RouterPolicy, routes: NormalizedRoute[] | Record<Tier, NormalizedRoute[]>, previous?: Partial<Record<Tier, string[]>>): Record<Tier, ComputedLadder>;
```
- `qualityFromIntel` becomes `0.35 + 0.38 * (facetComposite(...) ?? 0.5) + 0.10 * taskFit + 0.10 * reliability + 0.07 * popularity`; `intelligence` is read as `general`.
- A plain `NormalizedRoute[]` keeps working (all tiers use it); a per-tier record gives each tier its own powers.
- Tests that pin the old constants (`rungs.test.ts` 0.689, `intel-slug-coverage` 0.768) are re-pinned only where they assert the old formula; list every re-pin in the investigation note (Task 9).

- [ ] Tests: `facetComposite` renormalises over a missing facet and returns `undefined` with none; changing `weights` changes the class order only inside the hysteresis rules (a case where `frontier` and `small` weights order two rungs differently); `normalizePolicy` rejects `{coding: -1}` and falls back; **mutation check:** swapping the frontier and small weights in `DEFAULT_POLICY` fails the weights test.
- [ ] Run (FAIL), implement, run the whole `extension` suite; I1/I7/I8/I9/I10 tests stay green.

### Task 7: Wiring and `/route-status`

**Files:** Modify `index.ts`, `status.ts`; Tests `tests/bench-wiring.test.ts` (extends the harness pattern of `index-wiring.test.ts`), `status.test.ts`.

- [ ] `index.ts`: create `benchStore = BenchStore.besideStateFile(STATE_FILE)`; `refreshBench(ctx)` loops the three keyless sources, each independently: `benchRefreshDue` → `recordAttempt` → `fetch*` under `benchStore.claim()` → `append`; failures are logged and swallowed. After `refreshIntelSnapshot`, append an `aaSnapshot` when the newest AA snapshot is older than 24 h. `refreshIntel` calls `refreshBench` in the same background path (never awaited by a turn). Keep one in-flight promise like `liveRefresh`.
- [ ] `currentRoutes(ctx, tier)` builds with `intel: blended.intel` and `weights: policy.weights[tier]`; `chooseForCurrentWork` passes `mode`; ladders are computed from per-tier routes; the recompute key becomes `Math.max(intel.fetchedAt, newest bench snapshot)`; `blended` is recomputed only when a snapshot lands.
- [ ] `status.ts`: `StatusSources.bench?: Array<{ source: BenchSource; ageMs?: number; version?: string; rebaselined?: boolean; stale?: boolean; matched?: number }>`; one line per source (`stale` after 72 h), the selected route's per-source contributions from `report.byModel`, and the attribution lines.
- [ ] Wiring tests: with all sources failing, routing behaves as before and no turn waits; a fresh snapshot older than 24 h triggers exactly one fetch per source (also across two concurrent sessions); the I11 test (`index-wiring.test.ts`) still passes.

### Task 8: Differential replay and gates

- [ ] `git archive HEAD extension | tar -x -C /tmp/pmr-before`; a throwaway script replays **the same** fixtures through the old and the new modules for tiers `frontier`, `balanced`, `small`, `free` and **every class**, printing every changed winner.
- [ ] Every changed line is explained by the intended change; an unexplained flip (a free class reordering, a cross-family flip) is a regression to fix, not to document.
- [ ] Write `docs/investigations/finding-multi-source-benchmarks.md`: reproduction (the live replay), hypothesis table with verdicts (AA re-baseline confirmed from the 2026-10-11 vs 2026-10-30 diff; merge ruled out by the `A/B` test), alternatives disproved ("keep last known value" mixes index scales), minimal fix boundary, the differential table, the list of re-pinned tests.
- [ ] Gates: `bun run test`, `bun run test:sim`, `bash scripts/install.test.sh`, `bash scripts/install-bridge.test.sh`, `bash scripts/bootstrap.test.sh`; prove each new guard red-capable by mutation (e.g. drop the empty-snapshot rejection, drop the cohort drift term, swap the weights).

### Task 9: Live proof, docs, scan

- [ ] `README.md`: sources, staleness rule, attribution; `docs/design.md` §14 gets one pointer line to the spec.
- [ ] Install with `scripts/install.sh`, verify installed hashes, start one fresh `omp` session, run `/route-status`, save the sanitised output; `balanced` must name `anthropic/claude-sonnet-5-5`.
- [ ] `scripts/secret-scan.sh` on the whole change; report the attest value; no commit.

## Self-review

- **Spec coverage:** §4 sources → T3; §6.1 → T4 + T7; §6.2 → T2/T5; §6.3 → T4; §6.4/6.4a → T5/T6; §6.5 → T5; §6.6 → T7; §7 acceptance 1 → T1/T9, 2 → T8, 3 → T3/T4/T7, 4 → T4/T5, 5 → T5, 6 → T6/T8, 7 → T9.
- **Types:** `BenchHistory`, `BenchSnapshot`, `FacetWeights`, `benchRefreshDue`, `blendIntel`, `facetComposite`, `computeLadders` signatures match across T2–T7.
- **Proportion:** bodies appear only for the three rules the signatures do not fix (re-baseline, mapping, nerf).
