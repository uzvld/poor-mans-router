# adaptive-router — Root Cause Report

Installed OMP: `18.2.6` (`/opt/homebrew/Cellar/omp/18.2.6`)
Extension under test: `~/.omp/agent/extensions/adaptive-router` (installed, unmodified)
Capture time: `2026-09-19T02:56:09.916Z`
Method: the **installed** extension modules (`ranking.ts`, `health.ts`, `telemetry.ts`, `policy.ts`) were imported and replayed against live `omp usage --redact --json`, live `codexbar usage --provider all`, the live 1167-model OMP registry, and the live persisted `state.json`.

**No production file was modified. No fix was applied.**

Artifacts:
- `/tmp/router-sonnet-subscription-trace.txt` — full redacted live trace
- `/tmp/router-trace/trace.ts` — the replay harness (throwaway, outside the extension)

---

## BUG D — Healthy Sonnet subscription bypassed

### Verdict

**ROOT CAUSE PROVEN.**

A provider-wide `DRAINING` verdict, derived from a **CodexBar pace forecast on the Anthropic 7-day window**, overrides OMP's own authoritative "healthy" verdict for the Anthropic subscription. Because the class ladder's first pass admits **only `AVAILABLE`** routes, every `sonnet-sub` route is skipped and the ladder falls through to `free-chinese-flash`.

### Live selection reproduced exactly

```
selected-class  free-chinese-flash
selected-route  kilo/deepseek/deepseek-v4-flash-0731:free
reason          available free-chinese-flash; effective-cost=0.0000
```

This matches the user-reported live `/route-status` and matches the most recent `lastSuccessAt` entry in `state.json`.

### The answer to "WHY was `sonnet-sub` considered empty/ineligible/unhealthy?"

`sonnet-sub` was **neither empty nor ineligible**. It contained **8 routes, 0 in COOLDOWN**. All 8 were forced to `DRAINING`, and the ladder's healthy-first pass does not admit `DRAINING`.

```
CLASS sonnet-sub:        matching=8  healthy(AVAILABLE)=0  draining=8  cooldown=0
CLASS luna-sub:          matching=2  healthy=0  cooldown=2
CLASS chinese-flash-payg: matching=29 healthy=0  cooldown=29
CLASS free-chinese-flash: matching=4  healthy=4  cooldown=0   <-- selected
```

Every `sonnet-sub` route, including `anthropic/claude-sonnet-5`:

```
anthropic/claude-sonnet-5
   capability=subscription   credScope=anthropic#1
   classes=[sonnet,best-available,sonnet-sub]
   health=DRAINING  freshness=FRESH  healthSource=omp-usage
   reason=CodexBar pace will not last to reset
   persistedCooldown=none
```

### The causal chain, layer by layer

**1. OMP (authoritative quota source) reports the Anthropic subscription as healthy.**

```
credential anthropic#1  fetchedAt=2026-09-19T02:50:02Z
   window=5h  shared=true  tier=-      used=1%   remainingFraction=0.99  status=ok
   window=7d  shared=true  tier=-      used=24%  remainingFraction=0.76  status=ok
   window=7d  shared=false tier=fable  used=17%  remainingFraction=0.83  status=ok
```

99% of the 5-hour window remains. Nothing is exhausted. Nothing is within the 10% reserve.

**2. CodexBar emits a pace forecast that flags one window as not lasting to reset.**

```
pace.primary   willLastToReset=true   "81% in reserve | Lasts until reset"
pace.secondary willLastToReset=false  "14% in deficit | Runs out in 2d 8h"
```

The 5-hour window is explicitly healthy. Only the **7-day** window's *extrapolated burn rate* is pessimistic — a forecast, not a capacity fact.

**3. `telemetry.ts` collapses that per-window forecast into a provider-wide boolean.**

`telemetry.ts:146`
```ts
const draining = paceRows.some((p) => p?.willLastToReset === false);
```

`.some()` over all windows. The result is scoped to the **provider**, carrying no window, model, tier, or credential scope. `pace.primary.willLastToReset === true` is discarded.

**4. `health.ts` lets that CodexBar forecast override OMP's healthy verdict.**

`health.ts:138-140`
```ts
// OMP is authoritative for exhaustion, while CodexBar pace is complementary runway telemetry.
const codex = combineCodexBar(route, input.codexbar, input.now, false);
if (codex?.state === 'DRAINING') return { ...codex, ... };
```

The comment states OMP is authoritative. The code does the opposite: this early return sits **above** the `usable.some(r => r.healthy)` → `AVAILABLE` branch at line 142, so a CodexBar pace forecast wins over OMP's live "status: ok, 99% remaining". This is the defect.

**5. `ranking.ts` healthy-first ladder then skips the entire class.**

`ranking.ts:118-122`
```ts
for (const className of classOrder) {
  const healthy = routes.filter((r) => r.classes.includes(className) && r.health.state === 'AVAILABLE');
  const route = bestModelThenCheapestSeller(healthy, ...);
  if (route) return build(route, className);
}
```

The first pass walks the **whole ladder** admitting only `AVAILABLE`. `sonnet-sub` yields nothing, so evaluation continues down to `free-chinese-flash`, which has 4 `AVAILABLE` free routes. The degraded second pass (line 127) — which *would* have returned Sonnet — is never reached, because the first pass already returned.

This is working as designed per the comment at line 116 ("avoids burning a draining preferred class when a healthy fallback class exists"). The design is only safe if `DRAINING` is accurate. Here it is not.

### Counterfactual proof

Identical inputs, single variable changed:

| Variant | `anthropic/claude-sonnet-5` health | selected-class | selected-route |
|---|---|---|---|
| **Live (as installed)** | `DRAINING` | `free-chinese-flash` | `kilo/deepseek/deepseek-v4-flash-0731:free` |
| CodexBar removed entirely | `AVAILABLE` | **`sonnet-sub`** | `anthropic/claude-3-5-sonnet-20240620` |
| Only `pace` cleared on the CodexBar `claude` row | `AVAILABLE` | **`sonnet-sub`** | `anthropic/claude-3-5-sonnet-20240620` |

Clearing **only `pace`**, changing nothing else, flips the selection from free DeepSeek to `sonnet-sub`. This isolates the cause to a single field: `pace.secondary.willLastToReset`.

### Hypothesis verdicts

| # | Hypothesis | Verdict | Evidence |
|---|---|---|---|
| H1 | Sonnet 5 not classified as `sonnet-sub` | **DISPROVED** | `classifyModelId('anthropic/claude-sonnet-5')` → `[sonnet]`; `decorateClasses(free=false, subscriptionLike=true)` → `[sonnet, best-available, sonnet-sub]`. All 8 Anthropic Sonnets carry `sonnet-sub`. |
| H2 | Anthropic health incorrectly provider-wide | **CONFIRMED (as `DRAINING`, not `COOLDOWN`)** | Scope is **provider**. `telemetry.ts:146` `.some()` has no model/tier/credential/window dimension. Only one credential (`anthropic#1`) exists, so credential collapse is not the trigger here — **window** collapse is: healthy 5h is discarded in favour of pessimistic 7d. |
| H3 | OMP and CodexBar disagree | **CONFIRMED — this is the root cause** | Same account, same subscription, **different scope**: OMP reports *capacity* (`status: ok`, 99% left on 5h); CodexBar reports a *7d burn-rate forecast*. `health.ts:139` applies CodexBar's forecast with authority over OMP's capacity fact, contradicting its own line-138 comment. Neither snapshot is stale (OMP 2026-09-19T02:50:02Z, CodexBar 02:54:07Z, ~6 and ~2 min old). |
| H4 | Stale persisted cooldown | **DISPROVED** | `state.json` contains **0** entries with `cooldownUntil`. Only `lastSuccessAt` markers. |
| H5 | Bootstrap intent excludes the model from candidates | **DISPROVED** | `anthropic/claude-sonnet-5` is enumerated as a normal candidate in `sonnet-sub`. Bootstrap does not filter it. |
| H6 | Class loop fails to short-circuit | **DISPROVED** | `selectForTier(['sonnet-sub'])` alone returns `anthropic/claude-3-5-sonnet-20240620`. The ladder short-circuits correctly; it descends only because `sonnet-sub` has zero `AVAILABLE` members. Class priority is not broken. |

### Decisive evidence: the ladder behavior is BY DESIGN; only the pace collapse is a defect

A shipped test suite exists (`~/Downloads/omp-adaptive-router-handoff.zip`). Run against the **installed** sources with fixtures wired up:

```
49 pass, 0 fail   (Ran 49 tests across 10 files)
```

The installed code is **green on its own suite**. Two findings follow, and they split BUG D in half:

**1. `DRAINING`-outranked-by-free is intentional, codified, and tested.**

`tests/health.test.ts:50` — **passes**:
```ts
test('CodexBar bad pace makes usable subscription draining', () => {
  const h = evaluateRouteHealth({ provider: 'anthropic', modelId: 'claude-sonnet-5', free: false }, {
    ompReports, codexbar, local: undefined, reservePct: 10, now: 1789754000000,
  });
  assert.equal(h.state, 'DRAINING');   // <-- asserted, green
});
```

`design.md:446`:
> "Subscription routes and true free routes are treated as zero marginal-dollar cost **only while quota health is acceptable**. A scarce/draining subscription is not automatically preferred to a cheap healthy PAYG route."

`design.md:172`:
> "CodexBar `willLastToReset=false` → `DRAINING`"

`design.md:727` even ships the worked example verbatim:
```
anthropic/claude-sonnet-5   DRAINING   quota pace
```

So `health.ts:139` (CodexBar pace outranking OMP) and `ranking.ts:118` (healthy-first ladder descent) are **both implementing the written specification**. They are not accidents. Changing either is a **policy change**, not a bug fix, and requires the user's decision.

**2. The genuine defect is narrower: the per-window pace collapse.**

What the design does *not* sanction is discarding a healthy window. `telemetry.ts:146`:
```ts
const draining = paceRows.some((p) => p?.willLastToReset === false);
```
Live Anthropic pace is **split**: `primary` (5h) `willLastToReset=true` — "81% in reserve"; `secondary` (7d) `willLastToReset=false`. The `.some()` discards the healthy 5h signal and declares the whole provider draining on the strength of the pessimistic 7d forecast alone.

No test covers a *split* pace vector — the fixture's pace is uniformly bad, which is why the suite is green while live behavior is wrong. **This is the untested gap and the one provable defect.**

### Root cause — one sentence

**`health.ts:139-140` returns CodexBar's provider-wide `DRAINING` pace forecast before evaluating OMP's authoritative capacity verdict, so a pessimistic burn-rate extrapolation on Anthropic's 7-day window marks a 1%-used Sonnet 5 subscription non-`AVAILABLE`; `ranking.ts:118`'s healthy-first pass then admits only `AVAILABLE` routes and walks past `sonnet-sub` down to `free-chinese-flash`.**

Two independent design decisions combine; both are load-bearing:
- **D-1a** `telemetry.ts:146` — per-window pace is collapsed provider-wide by `.some()`, discarding `pace.primary.willLastToReset === true`.
- **D-1b** `health.ts:139` — CodexBar pace is checked *before*, and therefore outranks, OMP's healthy verdict, contradicting the stated precedence.

### Alternatives disproved

- **Not model classification** — Sonnet 5 carries `sonnet-sub` (H1 proof, trace).
- **Not a stale persisted cooldown** — zero cooldown entries in `state.json` (H4).
- **Not quota exhaustion** — OMP reports `status: ok` with `remainingFraction 0.99` on the 5h window.
- **Not a class-priority/short-circuit bug** — `sonnet-sub` is reachable and returns a route when evaluated in isolation (H6).
- **Not credential collapse** — only one Anthropic credential exists; the collapse that matters is across *windows*, not credentials.
- **Not stale telemetry** — both snapshots are ~2-6 minutes old.
- **Not bootstrap exclusion** — the model appears in candidate enumeration (H5).

### Minimal fix boundary

**`adaptive-router` only** — and, per the evidence above, **only `telemetry.ts`**.

- **`telemetry.ts:146` — a genuine defect, safe to fix.** Collapsing a split pace vector with `.some()` discards `pace.primary.willLastToReset === true`. No design text sanctions this, and no test covers a split vector. This is the fix.
- **`health.ts:139` — DO NOT TOUCH without a policy decision.** It implements `design.md:172` and is pinned green by `tests/health.test.ts:50`.
- **`ranking.ts:118` — DO NOT TOUCH without a policy decision.** It implements `design.md:446`.

No change is required in OMP core, Multica, or any provider adapter. OMP's usage reporting is correct; CodexBar's pace reporting is correct; the extension's *collapse* of the pace vector is not.

### Open policy question — must be decided before any fix

`DRAINING` on a subscription is ambiguous today. Per TEST D2 this needs an explicit answer, not a silent one:

- If `DRAINING` subscriptions should still outrank free classes, the ladder must attempt the degraded pass **within** a class before descending.
- If `DRAINING` should intentionally divert new work, then falling to free is correct — but the 5h window says 99% remains, so calling this route `DRAINING` at all is itself wrong.

The evidence supports the second framing: the `DRAINING` verdict is **incorrect**, independent of ladder policy.

---

## Secondary observation (NOT a proven bug — flagged for verification)

In the counterfactual runs, `sonnet-sub` selected `anthropic/claude-3-5-sonnet-20240620` rather than `anthropic/claude-sonnet-5`.

Mechanism: `effectiveCost()` (`ranking.ts:13`) returns `0` for every `subscriptionLike` route, so all 8 Sonnets tie on cost, and with an empty OpenRouter intel map they also tie on `qualityScore`. The final tie-break is `a.key.localeCompare(b.key)`, which alphabetically favours the 2024 Sonnet 3.5.

**This is not asserted as a live defect.** The replay ran with `intel = {}`; the live extension refreshes OpenRouter intelligence and may score `claude-sonnet-5` above `claude-3-5-sonnet-20240620`, breaking the tie correctly. Confirming this requires a live capture of `intel` with the same harness. Recorded here so it is not lost, and so a BUG D fix is verified against *Sonnet 5 specifically* rather than merely "some `sonnet-sub` route".

---

## BUG C — status

**NOT INVESTIGATED.** Work on BUG C (context loss on model switch) was pre-empted by the BUG D request before Phase 1 produced any evidence. No BUG C conclusion should be drawn from this document, and `/tmp/adaptive-router-context-root-cause.md` / `/tmp/adaptive-router-context-trace.log` were **not** produced.

---

## Status

Root cause for BUG D is proven and **narrowed to a single line**: `telemetry.ts:146`.

Baseline: installed sources are **49 pass / 0 fail** on the shipped suite. Any fix must keep that green.

**No fix applied; no production behavior modified.** The extension files are untouched (all still `Sep 18 21:57`).

Awaiting the user's decision on the `DRAINING`-vs-free policy question above before Phase 10 TDD, because two of the three implicated lines are specified behavior rather than defects.
