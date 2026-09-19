# BUG D — Final Report: Healthy Sonnet subscription bypassed

Status: **FIXED in a staging copy. NOT yet installed.** Awaiting your go-ahead to deploy (see "Deploy" below).

## Root cause

`health.ts:139-140` returned CodexBar's provider-wide `DRAINING` pace **forecast** before evaluating OMP's authoritative capacity verdict. `telemetry.ts:146` had already collapsed the per-window pace vector with `.some()`, so a pessimistic 7-day burn-rate extrapolation (`pace.secondary.willLastToReset=false`) overrode a healthy 5-hour window (`pace.primary.willLastToReset=true`) **and** OMP's own `status: ok, 99% remaining`. Every `sonnet-sub` route became `DRAINING`; `ranking.ts:118`'s healthy-first ladder admitted only `AVAILABLE`, walked past `sonnet-sub`, and landed on `free-chinese-flash`.

A secondary defect was proven along the way: with all subscription routes at `effectiveCost=0` and no OpenRouter intel, `bestComparator` fell through to `a.key.localeCompare(b.key)`, which picks `claude-3-5-sonnet-20240620` over `claude-sonnet-5` because `"3"` sorts before `"s"`.

## Policy applied (yours, verbatim in spirit)

1. Fresh OMP scoped quota/capacity is authoritative for route health.
2. CodexBar `pace.*.willLastToReset=false` is a forecast, not by itself grounds to demote a healthy subscription.
3. OMP near-reserve / exhausted still demotes / blocks normally.
4. Pace stays a pressure/admission input and remains the health source when OMP has no report for a provider.
5. `ranking.ts` ladder semantics **unchanged**. Only the *last* tie-break inside `bestComparator` was touched, and only after a failing test proved it necessary.

## Component fixed

`adaptive-router` only. OMP core, Multica, provider adapters: untouched.

## Exact files changed (staging: `/tmp/ar-work/extension/`)

| File | Change |
|---|---|
| `health.ts` | Removed the 3-line CodexBar-pace early return (old 138-140) that sat above the OMP `AVAILABLE` branch. Net: `-4 / +6` lines, comment only beyond the deletion. |
| `ranking.ts` | Added `modelGeneration()`, `modelFamily()`, `compareModelGeneration()`. Inserted one generation comparison in `bestComparator` **after** quality, reliability, latency, cost and **before** the lexical fallback. Same-family only. |
| `tests/health.test.ts` | Renamed/inverted the one test that pinned the old behavior: `'CodexBar bad pace makes usable subscription draining'` → `'CodexBar bad pace does not demote a subscription that OMP reports healthy'` (`DRAINING` → `AVAILABLE`). |
| `tests/bug-d-sonnet-subscription.test.ts` | **new** — 5 tests against the live 2026-09-19 snapshot. |
| `tests/sonnet-tiebreak.test.ts` | **new** — 5 tests for the tie-break. |
| `fixtures/live-omp-usage-2026-09-19.json`, `fixtures/live-codexbar-2026-09-19.json` | **new** — redacted live snapshots (only the 6 provider rows the router consumes; error prose and paths stripped). |

Diffs: `/tmp/bug-d-health.diff`, `/tmp/bug-d-ranking.diff`, `/tmp/bug-d-health-test.diff`.

## Tests

Baseline (installed sources on the shipped suite): **49 pass / 0 fail**.
After fix: **59 pass / 0 fail** — `Ran 59 tests across 12 files`.

Each new test was watched fail first (RED), then pass (GREEN). Every guard was additionally proven red-capable by mutation:

| Test | RED observed | Mutation that re-reds it |
|---|---|---|
| Sonnet 5 stays `AVAILABLE` under pessimistic weekly pace (live snapshot) | `got DRAINING (CodexBar pace will not last to reset)` | — (the bug itself) |
| OMP inside 10% reserve still → `DRAINING` | — | `if (usable.some(r=>r.healthy))` → `if (true)` ✔ fails |
| OMP exhausted still → `COOLDOWN` until reset | — | `if (!usable.length)` → `if (false)` ✔ fails |
| Fable-scoped exhaustion blocks Fable, leaves Sonnet `AVAILABLE` | — | same mutation ✔ fails |
| No OMP report → CodexBar pace still drives `DRAINING` | — | guards the fallback path is intact |
| `sonnet-sub` no-intel tie-break → `claude-sonnet-5` | `Export named 'modelGeneration' not found` | — |
| Generation parse / order / dated-snapshot tie | — | — |
| Explicit intel still outranks generation | — | — |
| Cross-family ids are NOT reordered by generation | `actual: kilo/qwen/qwen3.8-27b:free` | — (caught real collateral, see below) |

## Live replay: exact live telemetry snapshot, installed vs fixed

| | installed | fixed |
|---|---|---|
| `anthropic/claude-sonnet-5` health | `DRAINING` — "CodexBar pace will not last to reset" | `AVAILABLE` |
| `CLASS sonnet-sub` | matching=8 healthy=**0** draining=8 | matching=8 healthy=**8** draining=0 |
| tier `balanced` selected-class | `free-chinese-flash` | **`sonnet-sub`** |
| tier `balanced` selected-route | `kilo/deepseek/deepseek-v4-flash-0731:free` | **`anthropic/claude-sonnet-5`** |
| health census (1084 routes) | AVAILABLE 113 / DRAINING 25 / COOLDOWN 946 | AVAILABLE 138 / COOLDOWN 946 |

The 25 routes that moved `DRAINING → AVAILABLE` are exactly the 25 Anthropic subscription routes. Nothing else changed state.

Full traces: `/tmp/router-sonnet-subscription-trace.txt` (before), `/tmp/router-sonnet-subscription-trace.AFTER-FIX.txt` (after), `/tmp/router-selection-diff.txt` (per-tier / per-class differential).

### Collateral caught and fixed before install

The first tie-break version compared generation digits across **all** ids. The differential showed it flipping `best-free` / `healthy-free` / `healthy-free-fast` from `trinity-large-preview:free` to `qwen3.8-27b:free` — a meaningless reorder driven by the digit in "qwen**3**". A failing test was written for it, then `compareModelGeneration` was scoped to same-family ids only (`modelFamily()` strips digits, dates and variant suffixes). After that, all three free classes are `same` in the differential.

Other differential changes are the intended consequence of the policy: frontier now picks `fable-sub → claude-fable-5-1` instead of a free model, small picks `cheap-sub → claude-3-haiku-20240307`. If you did **not** intend frontier/small to regain Anthropic, say so — but it follows directly from "healthy OMP is authoritative", and it is the same 25-route flip.

## OpenRouter intel — not captured

`openrouter.ai/api/v1/benchmarks|classifications` return **HTTP 401** without a key, and no OpenRouter key is present in `~/.omp/agent/auth.json` or the environment (the extension resolves it at runtime via `ctx.modelRegistry.getApiKeyForProvider`). So the live-intel question could not be settled empirically. The tie-break fix makes the answer moot for correctness: with intel absent/equal, Sonnet 5 wins by generation; with intel present, quality wins first (tested: `'explicit OpenRouter intel still outranks generation order'`).

## Known limitations

- `modelFamily()` is heuristic string-stemming. It is correct for every id in the live 1167-model registry that matters here, and it is only ever consulted **after** quality, reliability, latency and cost all tie — so a wrong family split can at worst fall back to the old lexical order, never reorder a quality-ranked pair.
- CodexBar pace no longer influences route *health* when OMP reports on that provider. It still flows into the pressure signal indirectly (a route OMP marks near-reserve is `DRAINING`, which sets `resource-pressure: draining`). Wiring pace into pressure/admission **directly** (your policy point 4) is a follow-up, not part of this fix.
- `design.md:172/446/727` still document the old behavior. They should be updated to match the new policy.

## Deploy

Not done. Requires your confirmation, because the extension is live in several running OMP sessions.

```
cp /tmp/ar-work/extension/health.ts  ~/.omp/agent/extensions/adaptive-router/health.ts
cp /tmp/ar-work/extension/ranking.ts ~/.omp/agent/extensions/adaptive-router/ranking.ts
```

The extension is loaded per-process at `session_start`; running sessions keep the old code until restarted. New sessions pick up the fix immediately. No OMP restart is required for new work.

## Rollback

Backup of the installed originals exists byte-identical in the handoff zip (`~/Downloads/omp-adaptive-router-handoff.zip → extension/health.ts`, `extension/ranking.ts` — verified identical to installed by `diff`). Also:

```
cp /tmp/ar-installed/extension/health.ts  ~/.omp/agent/extensions/adaptive-router/
cp /tmp/ar-installed/extension/ranking.ts ~/.omp/agent/extensions/adaptive-router/
```
