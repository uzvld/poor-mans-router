# FINDING — New model names get no tier (GPT-6 Sol / Terra are unreachable from `frontier`)

**Found:** 2026-09-22, answering "GPT-6 Sol just shipped — which of our tiers does it land in, and does it land at all?"
**Status:** OPEN — **rung decision required** (see *Decision required*). The investigation itself is evidence-only; the recommended fix is drafted and red-then-green on branch `finding/unclassified-model-names` (see *Draft patch*).
**Layer:** `policy.ts` `classifyModelId()` / `decorateClasses()` (class membership) + `policy.yml` / `DEFAULT_POLICY` (per-tier ladders). Nothing in `telemetry.ts`, `health.ts`, `ranking.ts` selection logic, or `index.ts` wiring is implicated.
**Snapshot:** `fixtures/models.json` (1166 models → 1083 live routes) + `fixtures/live-omp-usage-2026-09-19.json` + `fixtures/live-codexbar-2026-09-19.json`, at `LIVE_NOW = 2026-09-19T02:56:09.916Z`.

## Answer to the question

`openai-codex/gpt-6-sol` is **not hardcoded anywhere** — and that is precisely the problem. Class membership is a closed substring whitelist over the model *name*; a name that is not in the whitelist gets no semantic class, and the only generic class that exists is `best-available`, which sits **only in `balanced`, rung 5 of 6**. `frontier` has **no generic paid rung at all**.

| Route | `classes` (computed) | Best tier it can ever win |
|---|---|---|
| `openai-codex/gpt-6-sol` | `["best-available"]` | `balanced` rung 5 |
| `openai-codex/gpt-5.6-sol` | `["best-available"]` | `balanced` rung 5 |
| `openai-codex/gpt-5.6-terra` | `["best-available"]` | `balanced` rung 5 |
| `openai-codex/gpt-5.6-luna` | `["luna","cheap","best-available","luna-sub","cheap-sub"]` | `balanced` rung 2, `small` rung 1 |
| `openai-codex/gpt-6-luna` *(hypothetical)* | `["luna","cheap","best-available","luna-sub","cheap-sub"]` | `balanced` rung 2, `small` rung 1 |
| `openai-codex/gpt-6-astra` | `["astra","best-available","astra-sub"]` | `frontier` rung 2 |
| `openai-codex/gpt-7-sol` / `gpt-6-terra` *(hypothetical)* | `["best-available"]` | `balanced` rung 5 |
| `openrouter/openai/gpt-6-sol:free` | `["free","best-free","healthy-free","healthy-free-fast"]` | `free` rung 1 / `frontier` rung 7 |

**Generations are irrelevant; product names are everything.** The token is matched against the name, never the version, so a whole new generation of a known name classifies itself with zero code change — `gpt-6-luna`, `gpt-7-luna`, `gpt-5.6-luna` and the real `gpt-6-astra` in the catalog all land exactly like their predecessors. The failing case is a **new NAME** (`sol`, `terra`), not a new generation. That distinction is the finding; it also means the fix must be a name-token rule and never a generation rule.

**Opus 5.5 needs nothing (measured).** `opus` is already a token, so `anthropic/claude-opus-5.5` → `["opus","best-available","opus-sub"]` → `frontier` rung 3 on arrival, and it *wins* that rung: added to the live catalog as an Anthropic subscription route it beats all 10 real `opus-sub` members, and the family-scoped generation tie-break prefers it over `claude-opus-5` and `claude-opus-4.8`. Two measured caveats, both latent today:

- a **suffixed** variant is a different family (`modelFamily('claude-opus-5.5-fast')` is `claude-opus-fast`, not `claude-opus`), so generation ordering does not relate it to 5.5 and, on a full tie, the lexical fallback puts plain `anthropic/claude-opus-5` ahead of `anthropic/claude-opus-5.5-fast`. No Anthropic-provider `-fast` variant exists in the catalog today (0 of 37 opus routes) — the 8 `-fast` ids are all kilo/openrouter, i.e. PAYG, so they never enter `opus-sub`;
- `opus` is the largest single instance of limb 2: of the **37** opus routes in the catalog only **10** are OMP-reported subscription routes with an `opus-sub` rung. The other **27** are per-token sellers (`kilo/stealth/*`, `kilo/anthropic/*`, `openrouter/anthropic/*`) and cannot reach `frontier` at all — including `kilo/anthropic/claude-opus-4.6-fast` at 96.375, the single most expensive route in the whole catalog.

So: **automatic** for names the whitelist already knows (`luna`, `astra`, `fable`, `opus`, `mythos`, `sonnet`, `haiku`/`spark`, `flash`, Chinese vendors, `:free`); **silent demotion to the paid tail** for anything else. This is not hypothetical and not about "new": `gpt-5.6-sol` is *already in today's catalog* and has never had a tier.

## Evidence

### 1. Census — half the catalog has no semantic class

```
routes=1083  base-classification-empty=549
  kilo            570 routes,  319 with no base class
  openrouter      445 routes,  215 with no base class
  opencode-go      38 routes,   12 with no base class
  anthropic        25 routes,    0 with no base class
  openai-codex      5 routes,    3 with no base class
```

### 2. Frontier membership — no generic paid rung

```
frontier  fable-sub          members=  2  free/sub/payg=0/2/0
frontier  astra-sub          members=  1  free/sub/payg=0/1/0     (openai-codex/gpt-6-astra only)
frontier  opus-sub           members= 10  free/sub/payg=0/10/0
frontier  opus-ish-sub       members=  2  free/sub/payg=0/2/0     (claude-mythos-5, -5-1 only)
frontier  strong-flash-sub   members=  6  free/sub/payg=0/6/0
frontier  strong-chinese     members= 28  free/sub/payg=0/5/23
frontier  best-free          members=113  free/sub/payg=113/0/0
balanced  best-available     members=970  free/sub/payg=0/68/902
small     cheap-sub          members= 13  free/sub/payg=0/13/0
small     cheap-flash        members= 82  free/sub/payg=0/0/82
small     healthy-free-fast  members=113  free/sub/payg=113/0/0
```

`frontier`-reachable routes: **162 / 1083**. Of 970 paid routes, **49** reach `frontier` — 23 PAYG and 26 subscription — and every one of the 23 PAYG routes reaches `frontier` **through `strong-chinese`** (all 28 members of that class are DeepSeek/GLM/Qwen). **921 paid routes are reachable only through `balanced` → `best-available`.**

`best-available` is not a quality class. On the base snapshot its winner is `anthropic/claude-3-5-sonnet-20240620` — a 2024 dated snapshot — and its `qualityScore` of 0.6750 is exactly the no-intel default (`0.35 + 0.24·0.5 + 0.14·0.5 + 0.10·0.5 + 0.10·0.5 + 0.07·0.5`), so every route without OpenRouter intel and without local history enters the class tied on quality. With the subscription providers removed from the report set (the §5 scenario) the same class is won by `openrouter/openrouter/auto`, whose price vector is `{input:0,output:0,cacheRead:0,cacheWrite:0}`. Either way the class is decided at the tail of the comparator chain — cost, then `localeCompare` — not by quality: an unclassified flagship competes here against a dated 2024 snapshot and a zero-priced meta-router.

### 3. Price census — the most expensive models are the least reachable

24 most expensive routes by `effectiveCost`, all of them **not** frontier-reachable: `kilo/anthropic/claude-opus-4.6-fast` (96.4), `kilo/openai/gpt-5.5-pro` (93.0), `openrouter/openai/gpt-5.2-pro` (79.8), `kilo/openai/o1` (66.0), `kilo/openai/gpt-5-pro` (57.0), `kilo/openai/o3-pro` (48.0), `kilo/anthropic/claude-opus-4` (48.2) … — `none` for all 24/24. Price and capability carry **no** tier signal.

### 4. The 15 subscription routes that have no semantic class today

All 15 sit only in `best-available`; `openai-codex` accounts for 3 of them, `opencode-go` for 12:

```
openai-codex/gpt-5.5          openai-codex/gpt-5.6-sol      openai-codex/gpt-5.6-terra
opencode-go/grok-4.5          opencode-go/grok-4.6          opencode-go/hy3
opencode-go/hy3-preview       opencode-go/hy4-preview       opencode-go/longcat-2.0
opencode-go/mimo-v2-omni      opencode-go/mimo-v2-pro       opencode-go/mimo-v2.5
opencode-go/mimo-v2.5-pro     opencode-go/omen-alpha        opencode-go/ox-alpha-free
```

### 5. Counterfactual replay — the gap is only *masked*, not harmless

On both shipped snapshots `openai-codex` is exhausted (`7d` `status: exhausted`, `usedFraction: 1`) and Anthropic is healthy, so `frontier` → `fable-sub` and the defect is invisible. Rewriting **only** the `openai-codex` limit objects to healthy and removing Anthropic (nothing else changed):

```
counterfactual 1 — full catalog, openai-codex healthy, anthropic absent
  frontier  astra-sub   openai-codex/gpt-6-astra
  balanced  luna-sub    openai-codex/gpt-5.6-luna
  healthy but UNUSED:   gpt-5.6-sol, gpt-5.6-terra, gpt-5.5   (all best-available)

counterfactual 2 — same, astra routes removed (Sol/Terra/5.5 are the remaining OpenAI capacity)
  frontier  strong-chinese  kilo/qwen/qwen-max   free=false sub=false   <= PAYG Chinese model
  balanced  luna-sub        openai-codex/gpt-5.6-luna
  healthy but UNUSED:       openai-codex/gpt-5.6-sol, gpt-5.6-terra     (subscription, cost 0)
```

`frontier` burns a paid PAYG route while a healthy premium **subscription** route with capacity is passed over. That is the failure mode, and it is the same shape as the BUG D / CodexBar findings: latent on the snapshots we ship, real the moment the Anthropic and Astra windows are the ones that are spent.

### 6. Differential replay of the narrow candidate fix (token `sol` → `opus-ish`)

```
2026-09-19 live snapshot:  frontier fable-sub/claude-fable-5-1 ; balanced sonnet-sub/claude-sonnet-5
                           small cheap-sub/claude-3-haiku-20240307 ; free best-free/trinity-large-preview:free
                           -> identical with the fix on ALL FOUR tiers (latent, as in §5)
2026-09-18 snapshot:       identical before/after on all four tiers
counterfactual 2:          frontier kilo/qwen/qwen-max (PAYG) -> openai-codex/gpt-5.6-sol (subscription); other tiers unchanged
counterfactual 1:          frontier unchanged (astra-sub ranks above opus-ish-sub, which is correct)
```

No unexplained flips: no class reorders, no free class moves, `:batch` filtering untouched (I10 holds), `qualityScore`/`reliabilityScore` untouched (I7 holds).

## Hypothesis table

| # | Hypothesis | Verdict | Evidence |
|---|---|---|---|
| H1 | New models are classified from capability/price, so a flagship is promoted automatically. | **DISPROVED** | `classifyModelId` reads only the selector string; price never participates (24/24 most expensive routes are unreachable). |
| H2 | There is a catch-all rung that absorbs unknown strong models into `frontier`. | **DISPROVED** | `frontier.classes` = `fable-sub, astra-sub, opus-sub, opus-ish-sub, strong-flash-sub, strong-chinese, best-free`; the only generic class, `best-available`, is not in it. |
| H3 | "Sol" is new, so it is simply not in the catalog yet. | **DISPROVED** | `gpt-5.6-sol`, `gpt-5.6-sol-pro`, `gpt-5.6-sol-discounted`, `stealth/gpt-5.6-sol`, `~openai/gpt-sol-latest` are all live inventory today; all unclassified. |
| H4 | `subscriptionLike` alone is enough to enter a `*-sub` class. | **DISPROVED** | `decorateClasses` gates `*-sub` on a *base token* first ("if tags.has('fable') … "). 15 subscription routes have no base token and therefore no `-sub` class. |
| H5 | OpenRouter intel could still promote a strong unknown model. | **DISPROVED** | `qualityFromIntel` only feeds the in-class comparator; `selectForTier` walks `classOrder` strictly (I1). Intel cannot change membership. |
| H6 | The design intends a generic "other strong subscription model" slot. | **CONFIRMED (design), MISSING (code)** | `design.md:352` — "`opus-ish-sub`: other healthy subscription frontier models"; populated only from the literal token `mythos`. |
| H7 | The design's stated rule surface (config-driven class rules) exists. | **DISPROVED** | `design.md:401` — "Class rules live in configuration and support globs/regexes/tags"; `policy.yml` carries only per-tier class *order*; membership is source-code `s.includes(...)` in `policy.ts`. |
| H8 | A generic rule ("unknown subscription model → `opus-ish-sub`") is a safe superset fix. | **DISPROVED** | It pulls 15 routes in, including `opencode-go/hy3-preview`, `hy4-preview`, `ox-alpha-free`, `omen-alpha` (zero-price experiment models), and in counterfactual 2 the `opus-ish-sub` winner becomes `openai-codex/gpt-5.5` — chosen lexically over `gpt-5.6-sol`, because `modelFamily('gpt-5.5')` is `gpt` while `modelFamily('gpt-5.6-sol')` is `gpt-sol`, so `compareModelGeneration` ties across them. |
| H9 | A new generation of a known name needs a rule too (i.e. "GPT-6 Luna" fails like "GPT-6 Sol"). | **DISPROVED** | `luna` is matched as a name substring: `gpt-6-luna` and `gpt-7-luna` already produce `luna-sub` + `cheap-sub` with no code change, as does the real `gpt-6-astra`. Only a new NAME is unclassified. This is why the fix must key on names, not generations. |

## Root cause

Two independent limbs, one layer:

1. **Closed name whitelist.** `classifyModelId()` recognises a fixed set of name tokens. Any model outside that set — regardless of quality, price, or subscription status — receives only `best-available` (or the free tail). Because `best-available` exists only in `balanced` (rung 5), and `frontier` has no generic paid rung, an unclassified model **cannot** reach the top ladder. 549/1083 catalog routes are in this state; 15 of them are subscription routes with capacity that the ladder ignores.
2. **`*-sub` requires `subscriptionLike`.** Even a *known* name sold on a PAYG aggregator gets no `-sub` class: `kilo/openai/gpt-6-astra` (price 10/50, the most expensive OpenAI model in inventory) → `["astra","best-available"]`, never `astra-sub`. So a genuine frontier-grade model bought per-token can only ever be `balanced` rung 5. This is the second half of "921 paid routes are balanced-only".

`design.md:88` ("Newly added authenticated routes automatically become candidates **if they match a class rule**") is consistent with the code — the defect is that the rule set is closed, source-resident, and has no generic paid rung to fall into, which contradicts `design.md:352` and `design.md:401`.

## Alternatives considered and rejected

- **Do nothing.** Rejected as a *silent* default: the failure is not an error, it is a paid PAYG model or a free model answering while a healthy premium subscription with capacity is skipped (§5, counterfactual 2).
- **Generic "unknown subscription model → `opus-ish-sub`" rule (design-faithful reading).** Rejected as-is: §H8 — it admits preview/experiment junk into a frontier rung and its winner is decided lexically. Usable only together with a quality/size gate, which is a policy change, not a fix.
- **Add `best-available` to `frontier`.** Rejected: that is a ladder-semantics change (AGENTS.md *must ask*), and with 970 members whose winner is a zero-price meta-router, it would let `openrouter/auto` win `frontier`.
- **Widen price/capability-based promotion.** Rejected: `design.md:94/603` explicitly forbids promoting a model across the user's tier/class boundary from benchmark data.

## Minimal fix boundary (now drafted, see below)

Layer-local, one line in `policy.ts` plus a test file, no ladder reorder:

```ts
// policy.ts classifyModelId, directly after the `mythos` token
// `sol` / `terra` (OpenAI code names) are word-bounded: the catalog really contains
// `upstage/solar-pro-*` and `alfredpros/codellama-7b-instruct-solidity`, which a bare
// `includes('sol')` would drag into a frontier rung.
if (/(?:^|[-_/])(?:sol|terra)(?![a-z0-9])/.test(s)) out.add('opus-ish');
```

- `s.includes('sol')` is **not** acceptable: over the live catalog it matches **15 routes**, and 6 of them are not Sol at all — `alfredpros/codellama-7b-instruct-solidity` and `upstage/solar-pro-3` / `solar-pro4` (each sold by both kilo and openrouter, one `:free`). The word-bounded form above matches exactly the **16** genuine Sol/Terra routes and nothing else, so `no-base-class` moves 549 → 533 and `frontier`-reachable 162 → 164.
- Placement of `sol`/`terra` **is the decision**: `opus-ish` (→ `opus-ish-sub`, `frontier` rung 4) is the design's own slot for "other healthy subscription frontier models". Mapping them to `astra` (rung 2) or to a `luna`-like cheap class are the alternatives, and each implies a different bill.
- Limb 2 (PAYG sellers) is **out of this fix's boundary** — it needs a decision about whether a generic paid rung belongs in `frontier` at all.

Invariants: none of I1–I12 / N1–N6 is relaxed. Class order and `selectForTier` semantics are untouched; this only changes which routes populate an existing class.

## Draft patch (branch `finding/unclassified-model-names`)

`extension/policy.ts` — the one line above. `extension/tests/unclassified-model-names.test.ts` — 5 tests, every route built through the real `buildRoutes()` / `selectForTier()` pipeline:

| Test | Pre-fix | Post-fix | Mutation that re-reds it |
|---|---|---|---|
| a new generation of a known name classifies itself (Luna) | pass — documents the name/generation asymmetry | pass | token made generation-scoped (`/gpt-5\.6-luna/`) → 1 fail |
| an unknown name gets a frontier rung, not just the generic paid class | **FAIL** — `openai-codex/gpt-6-sol must carry the opus-ish token` | pass | token line deleted → 3 fail |
| the sol/terra token is word-bounded | **FAIL** — `kilo/openai/gpt-5.6-sol must classify as sol/terra` | pass | regex loosened to `/sol/` → 2 fail |
| frontier reaches a healthy premium subscription instead of a paid strong-class route | **FAIL** — `actual: 'kilo/qwen/qwen-max'` | pass | token line deleted → 3 fail |
| the PAYG limb is untouched (boundary pin) | pass | pass | `opus-ish-sub` added without the subscription gate → 1 fail |

- Suite: `bun test $(ls tests/*.test.ts | sed '/\/\._/d')` → **126 pass / 0 fail** (121 before this branch). `bun run test:sim` → 5/5.
- Differential replay, both shipped snapshots, 1083 routes each: the **1067 routes that are not `sol`/`terra` are byte-identical before and after** (route+health+class fingerprint unchanged: `fa2f8b5729992af7` on the 09-19 snapshot, `403b689fe1f31443` on 09-18). All four tier winners are unchanged on both snapshots, so no unexplained flip exists to justify — the patch is latent on today's data and only becomes visible when the named frontier classes are the ones without capacity (§5).
- Not done, deliberately: nothing installed, no `policy.yml` change, no ladder reorder.

## Adjacent observations (out of scope, unproven)

- `modelFamily('gpt-5.5') === 'gpt'` while `modelFamily('gpt-5.6-sol') === 'gpt-sol'`, so generation ordering never applies between an unsuffixed OpenAI id and a suffixed one, and the lexical fallback decides. Consistent with I9's family scoping, but it is the reason the generic rule in §H8 lands on the *older* model.
- The existing tokens are **not** word-bounded, so `luna` already matches `sao10k/l3-lunaris-8b` (`["luna","cheap"]`). Harmless today — that route is PAYG, so it only reaches `cheap`/`best-available` — but it is the same class of bug one subscription provider away, and it is why the new token was written word-bounded instead of following the surrounding style.
- `opencode-go` has 12 of 38 routes unclassified; anyone assuming "subscription ⇒ tiered" should read §4 first.
- If Sol and Terra should not be equal inside `opus-ish-sub`, note the in-class winner there is decided lexically (`gpt-5.6-sol` < `gpt-5.6-terra`), not by a generation or price rule — a separate, unproven concern.

## Decision required

Per AGENTS.md ("Anything that alters which model a *human's* session runs on") this needs your call. The drafted patch already implements the **recommended** reading of (1) and (2); each is a one-line change if you want another:

1. Token set to recognise: `sol` only, **`sol` + `terra` (drafted)**, or a wider set (`grok`, `hy*`, `mimo`, `longcat`, `omen`, `ox` — the rest of §4)?
2. Class/rung: **`opus-ish` (frontier rung 4, drafted)** — the design's own "other healthy subscription frontier models" slot — or `astra`-grade (rung 2), or a `balanced`-visible class?
3. Limb 2: leave PAYG sellers of frontier-grade models in `best-available` (status quo, and what the drafted patch does), or open a separate investigation for a generic paid `frontier` rung?

## Reproduction

Outputs below are **pre-patch** (`origin/main`, `c4f0c58`). With the drafted patch applied, the first two gain `opus-ish` + `opus-ish-sub` and the third is unchanged (kilo is PAYG, so still no `astra-sub`).

```bash
# from the repo root; Bun, installed-source modules, sanitised fixtures only
bun -e 'import {readFileSync} from "node:fs";
import {classifyModelId,decorateClasses} from "./extension/policy.ts";
import {normalizeOmpUsage} from "./extension/telemetry.ts";
// subscriptionLike == "the provider appears in omp usage reports" (ranking.ts buildRoutes)
const subs=new Set(normalizeOmpUsage(JSON.parse(readFileSync("fixtures/live-omp-usage-2026-09-19.json","utf8"))).map(r=>r.provider));
for (const id of ["openai-codex/gpt-6-sol","openai-codex/gpt-5.6-terra","kilo/openai/gpt-6-astra"])
  console.log(id, JSON.stringify(decorateClasses(classifyModelId(id),{free:false,subscriptionLike:subs.has(id.split("/")[0])})));'
# openai-codex/gpt-6-sol     ["best-available"]
# openai-codex/gpt-5.6-terra ["best-available"]
# kilo/openai/gpt-6-astra    ["astra","best-available"]     <- no astra-sub: kilo is PAYG
```

```bash
# the regression suite for this finding (5 tests, RED before the patch, GREEN after)
cd extension && bun test tests/unclassified-model-names.test.ts
```

```bash
# full catalog census + per-tier ladder replay (fixtures/models.json + live 2026-09-19 snapshot)
# pre-patch output; with the patch `no-base-class` is 533 (16 sol/terra routes gain a class),
# `frontier`-reachable is 164, and every tier winner below is unchanged.
bun -e 'import {readFileSync} from "node:fs";
import {normalizeOmpUsage,parseCodexBarRows} from "./extension/telemetry.ts";
import {buildRoutes,selectForTier} from "./extension/ranking.ts";
import {DEFAULT_POLICY,classifyModelId} from "./extension/policy.ts";
const models=JSON.parse(readFileSync("fixtures/models.json","utf8")).models;
const routes=buildRoutes(models,{ompReports:normalizeOmpUsage(JSON.parse(readFileSync("fixtures/live-omp-usage-2026-09-19.json","utf8"))),
 codexbar:parseCodexBarRows(JSON.parse(readFileSync("fixtures/live-codexbar-2026-09-19.json","utf8"))),
 localState:{},history:{},intel:{},reservePct:10,now:Date.parse("2026-09-19T02:56:09.916Z")});
console.log("routes", routes.length, "no-base-class", routes.filter(r=>classifyModelId(r.selector).length===0).length);
for (const t of ["frontier","balanced","small","free"]) { const s=selectForTier(routes,DEFAULT_POLICY.tiers[t].classes,{allowDraining:t!=="frontier",preference:t==="free"?"value":t==="small"?"speed":"quality"});
 console.log(t, s?.className, s?.route.key); }'
# routes 1083 no-base-class 549
# frontier  fable-sub  anthropic/claude-fable-5-1
# balanced  sonnet-sub anthropic/claude-sonnet-5
# small     cheap-sub  anthropic/claude-3-haiku-20240307
# free      best-free  kilo/arcee-ai/trinity-large-preview:free
```

## Prototype: rungs from a snapshot (branch `finding/unclassified-model-names`)

The token fix in *Draft patch* above answers "which class does a new name get". This prototype answers the
next question, which is the one that made the first one necessary: **why is the order inside a tier a
hand-written list at all?** Rung order is now derived from the last benchmark snapshot, once per refresh,
with the shipped ladder as the fallback. Nothing is installed, `policy.yml` is untouched, and
`selectForTier` semantics are unchanged — it still walks the class list it is handed, in order.

| File | Change |
|---|---|
| `extension/rungs.ts` | new: `benchmarkPower()`, `profileClasses()`, `orderLadder()`, `computeLadders()`, `RUNG_HYSTERESIS` |
| `extension/ranking.ts` | every route carries `benchmarkPower` — the raw capability signal the order needs (it was previously folded into `qualityScore` and lost) |
| `extension/index.ts` | derives all four ladders when a snapshot lands, and walks `ladders[tier].order ?? policy.tiers[tier].classes` |
| `extension/status.ts` | `/route-status` prints `ladder: computed from snapshot — fable-sub > opus-sub > …` |
| `extension/tests/rungs.test.ts` | 10 tests: 5 on the ordering rules directly, 4 through the real `buildRoutes()` / `selectForTier()` pipeline, 1 through the extension's own `before_agent_start` |

**Five rules decide what the data may move, and nothing else moves.**

1. Capability rungs are ordered by measured power.
2. An unmeasured class keeps the index the shipped policy gave it; measured classes fill the slots around
   it (I7). This is the fallback rule as much as the fairness rule: no snapshot, no movement.
3. A **catch-all** class — one whose members are a superset of another class in the same ladder — is a tail,
   not a rung, and keeps its shipped index. `best-available` holds every paid route, so its best member is
   the strongest paid model in the catalog *by construction*: ordering it by that member puts the most
   expensive model in the catalog at the top of `balanced`. Measured: `best-available=0.728` against
   `chinese-flash-payg=0.639` — the rule is what keeps `balanced` identical to its shipped ladder.
4. Rungs that sell differently never cross on power alone: subscription stays ahead of paid ahead of free.
   Economics is first order in this router (subscription-first, `package.json`), and a capability signal
   must not silently re-price a turn. A mixed class (members on both sides) is a capability class and
   crosses freely.
5. `RUNG_HYSTERESIS = 0.02` — a rung climbs past its neighbour only by at least 2 points of power, so a
   snapshot-to-snapshot wobble cannot reorder the ladder. Measured gaps between neighbouring capability
   classes on the 2026-09-22 snapshot are 2–10 points, so the floor admits every real difference in the
   data. It is a policy constant, not a fitted one: calibrating it needs two snapshots of the same day.

**Every guard is red-capable** (AGENTS.md step 4). Each mutation was applied to a clean tree, the suite run,
and the file restored byte-for-byte:

| Mutation | Red |
|---|---|
| I7 slot pinning disabled | 2 tests (I7 index, I1/I7 handover) |
| `RUNG_HYSTERESIS = 0` | hysteresis test |
| previous order discarded (insertion starts from the shipped list) | hysteresis test |
| catch-all detection never fires | catch-all tail test |
| economics gate removed (any rung crosses any other) | economics test |
| coding:agentic blend flattened to 50:50 | `benchmarkPower` test |
| `buildRoutes` stops recording `benchmarkPower` | 3 tests (both ladder tests + the wiring test) |
| `index.ts` stops walking the computed ladder | wiring test |

**Differential replay** (`bun run tools/rung-replay/replay.ts`, both arms fed the *same* snapshot — so a
line that differs can only come from the ladder; frontier is where the shipped order was demonstrably wrong):

```
shipped : fable-sub > astra-sub > opus-sub > opus-ish-sub > strong-flash-sub > strong-chinese > best-free
computed: fable-sub > opus-sub > astra-sub > strong-chinese > opus-ish-sub > strong-flash-sub > best-free
powers  : opus-sub=0.700 astra-sub=0.673 strong-chinese=0.668 opus-ish-sub=0.643 strong-flash-sub=0.639 best-free=0.598
pinned  : fable-sub
```

- `opus-sub` passes `astra-sub` on 2.7 points (Opus 5 at 78.0/56.5 vs GPT-6 Astra at 76.9/51.0).
- `strong-chinese` passes `opus-ish-sub` (2.5) and `strong-flash-sub` (2.9).
- `fable-sub` stays first because nothing measured its members — rule 2, not a judgement about Fable.
- The chain is where it becomes visible: with the account's Anthropic and Codex windows inside the 10 %
  reserve (measured, `fixtures/live-omp-usage-2026-09-22.json`: anthropic 7d 6 % and codex 7d 5 % remaining,
  both `DRAINING`), frontier's first *healthy* rung decides the turn. Shipped order falls to
  `strong-flash-sub` (cheapest flashes), computed order to `strong-chinese` (`glm-5.3`, `glm-5.2`,
  `deepseek-v4-pro`, `qwen-max`). Every one of those winners is still an `opencode-go` subscription route
  where one exists, so subscription-first is preserved and no run becomes PAYG.
- `balanced`, `small` and `free` are byte-identical to their shipped ladders on this snapshot — `balanced`
  because of rule 3 (see above), `small` and `free` because their measured classes are within the margin or
  are tails.

**What the snapshot says about the question that started this** (Artificial Analysis, 2026-09-22, saved as
`fixtures/aa-bench-2026-09-22.json`):

- **Opus 5.5, GPT-6 Sol and GPT-6 Luna are absent** from the payload — no measurement exists yet, so no
  data-driven rule can place them. Under rule 2 their classes keep their shipped rungs (`opus-sub`, and
  `opus-ish-sub` for Sol/Terra). `benchmarkPower` stays `undefined` for them; they are never "scored 0".
- **Opus 5 is measured below Fable 5.1 on all three indices** (78.0/56.5/50.8 vs 81.6/57.9/53.4, 97th vs
  98th percentile). The shipped "Fable before Opus" order is therefore *not* contradicted by the only
  measurements that exist; the earlier hypothesis that data would lift Opus above Fable is disproved for
  Opus 5, and unmeasurable for Opus 5.5.
- **GPT-6 Astra is measured** (76.9/51.0/52.7 → 0.63·0.769 + 0.37·0.510 = **0.673** in the replay's units, 96th/93rd percentile) and would be frontier rung 2 today. Its
  `openai-codex` route is `DRAINING` at ~5 % of the weekly window, which is exactly the state the first
  `fallback` line above describes.

**Three intel coverage gaps found while doing this** (each makes a route look *unmeasured*, and rule 2 then
pins its rung — safe, but it means the data silently never arrives for those routes). None is fixed here;
each changes intel coverage and therefore ranking, so it belongs in its own finding:

1. **Bare-id providers.** `canonicalModelSlug('opencode-go', 'grok-4.6')` is `opencode-go/grok-4.6`, while the
   snapshot keys the same model as `x-ai/grok-4.6`. Measured through `buildRoutes`: the same model scores
   `qualityScore 0.6750` on `opencode-go` and `0.7365` on `openrouter` (`x-ai/grok-4.6`), purely because the
   subscription copy never sees the intel. Same for `hy*`, `mimo`, `longcat`, `omen`, `ox`, `kat`, `minimax`
   ids on `opencode-go`.
2. **Dot vs dash in Claude versions.** OMP ships `anthropic/claude-opus-5-5`; the snapshot and OpenRouter key
   `anthropic/claude-opus-5.5`. `claude-fable-5-1` has the same problem, which is why `fable-sub` reads as
   unmeasured in this replay despite Fable 5.1 being the top measured model in the catalog.
3. **Dated slugs.** `stripVariants()` removes `:free`/`:batch` but not the `-YYYYMMDD` suffix, so
   `openai/gpt-6-astra-20260903` cannot match the undated `openai/gpt-6-astra` that `canonicalModelSlug()`
   produces. Both the page payload and `fixtures/aa-bench-2026-09-22.json` carry dated and undated keys, so
   today this one is masked; whether the Data API payload does too is what the 02:00 capture decides
   (`tools/rung-replay` accepts `PMR_INTEL` for exactly that check).

**Adjacent fix shipped with this prototype: the unit suite is machine-dependent no longer.** `RouterStateStore`
was constructed with a fixed `EXTENSION_DIR/state.json`, so every harness driving `session_start` read the
developer's own routing history. On this machine that made two tests fail for reasons unrelated to the code:
`managed-mode.test.ts` "cold start on pmr/balanced…" and `switch-marker.test.ts` "router-initiated switch
emits…" (`mv extension/state.json /tmp && bun test tests/managed-mode.test.ts tests/switch-marker.test.ts` →
8/8 pass; with it in place, 1/2). `index.ts` now resolves the path through `stateFilePath()` and honours
`PMR_STATE_FILE`, and the five harnesses that depend on that file point it at a per-process scratch path.
138/138 unit tests pass on a machine whose `state.json` holds history, which was not true before.

**Gates on this prototype:** `bun test $(ls tests/*.test.ts | grep -v '/\._')` → **138 pass / 0 fail**;
`bun run test:sim` → 5/5; `bash scripts/install.test.sh` → all checks passed; `bash scripts/bootstrap.test.sh`
→ all checks passed; mutation proofs above → 8/8 red. Nothing installed.

**Decision required** — this prototype is a proposal, not a shipped change:

1. **Margin.** `RUNG_HYSTERESIS = 0.02` admits `opus-sub > astra-sub` (2.7) and `strong-chinese` above
   `strong-flash-sub` (2.9), and refuses every sub-2-point move. Raising it to 0.05 would also refuse those
   two, leaving the ladder nearly static; lowering it admits noise. Calibrating needs a second snapshot of
   the same models.
2. **Should economics stay frozen across rungs (rule 4)?** If a paid rung should be able to displace a
   subscription rung on power, that is a one-line change and a policy decision about spending.
3. **Should catch-all tails stay pinned (rule 3)?** The alternative is allowing `best-available` to climb,
   which repairs the "unrecognised name is only ever balanced" complaint from the other direction — at the
   cost of putting the most expensive model in the catalog at the top of `balanced`.
4. **Coverage gaps first?** Items 1–3 above mean several premium subscription routes are permanently
   "unmeasured" and therefore permanently pinned. Fixing them may be worth more than this prototype, and it
   is the prerequisite for the data to mean anything for `anthropic/*` frontier ids at all.
