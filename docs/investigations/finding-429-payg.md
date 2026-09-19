# Finding — ROADMAP #3: 429/fallback and PAYG-vs-free routing

Installed extension: `adaptive-router` (unmodified — no production file changed by this
investigation; `extension/policy.ts` and `extension/ranking.ts` were mutated in-place and
reverted, one mutation at a time, purely to prove the new tests are red-capable; see
"Mutation proof" below). New artifact: `extension/tests/payg-vs-sub.test.ts` (4 tests, all
run against the real `buildRoutes()`/`selectForTier()`/`evaluateRouteHealth()`/
`decorateClasses()` pipeline — no hand-built `NormalizedRoute` stubs for the routing
decision itself).

---

## Claim 1 — "a PAYG route is never chosen over an equivalent healthy subscription"

**Verdict: CONFIRMED**, with one adjacent, deliberately-flagged non-invariant observation
(row 4 below is not part of this claim — see caveat).

### What "equivalent" means, reconstructed from code

- **Health** (`extension/health.ts:115-182`, `evaluateRouteHealth`): three states,
  `AVAILABLE` / `DRAINING` / `COOLDOWN`. A route is `DRAINING` when OMP-reported quota is
  usable but inside the configured reserve (`health.ts:163-169`), and `COOLDOWN` when
  quota/balance is exhausted or a local runtime cooldown is active (`health.ts:117-126`,
  `134-146`). Only `AVAILABLE` counts as healthy.
- **Class**: `extension/policy.ts:56-90` (`decorateClasses`). A route is tagged `<x>-sub`
  (e.g. `sonnet-sub`, `luna-sub`) **only** when `economics.subscriptionLike` is true
  (line 71 gate); a PAYG route for the identical model instead only ever gets
  `best-available` (line 69, unconditional for any non-free route) plus, for chinese-flash
  models specifically, `chinese-flash-payg` (line 84). **A subscription route and its PAYG
  counterpart for the same model are never members of the same policy class** except
  through the generic `best-available` catch-all — this is the structural reason "same
  model, same class" cannot occur for sub vs. PAYG.
- **Selection**: `extension/ranking.ts:171-199` (`selectForTier`). Two passes over the
  ordered class ladder (`policy.yml` / `DEFAULT_POLICY.tiers.<tier>.classes`): pass 1 walks
  every class in ladder order admitting only `AVAILABLE` routes; only if pass 1 finds
  nothing anywhere in the ladder does pass 2 re-walk it admitting any non-`COOLDOWN`
  (i.e. `DRAINING`) route (`ranking.ts:182-197`, comment explains the intent explicitly).
  Within a class, `effectiveCost()` (`ranking.ts:12-22`) returns `0` for both `free` and
  `subscriptionLike` routes and the real dollar cost for PAYG, so even where a subscription
  and PAYG route for the *same model* do land in the same class (`best-available`), the
  cost tie-break independently favors the subscription route too.

### Reproduction matrix

All four rows built with `buildRoutes()` fed synthetic `OmpCredentialUsage` (10% reserve,
`now = 2026-09-19T00:00:00Z`), then `selectForTier(routes, DEFAULT_POLICY.tiers.balanced.classes, { allowDraining: true })` — the exact call `index.ts:176-185` makes for a session in `balanced` mode.

| Row | Subscription state | PAYG state | Winner | Why (file:line) | Test |
|---|---|---|---|---|---|
| 1 | `AVAILABLE` (remainingFraction 0.8) | `AVAILABLE` (no telemetry) | **subscription** | `sonnet-sub` precedes `best-available` in `policy.ts:7`; pass 1 finds it first (`ranking.ts:184-188`) | `healthy subscription beats an equally healthy PAYG route for the same model` |
| 2 | `DRAINING` (remainingFraction 0.05 < 10% reserve) | `AVAILABLE` | **PAYG** | Pass 1 (`ranking.ts:184-188`) requires `state === 'AVAILABLE'`; a `DRAINING` `sonnet-sub` route does not qualify, so pass 1 continues down the ladder to `best-available` and returns the PAYG route *before pass 2 ever runs*. This is the documented "avoid burning a draining preferred class when a healthy fallback exists" behaviour (`ranking.ts:182-183` comment). | `a draining subscription (inside reserve, not down) falls back to a healthy PAYG route for the same model` |
| 3 | `COOLDOWN` (remainingFraction 0, exhausted) | `AVAILABLE` | **PAYG** | Same pass-1 mechanism; `COOLDOWN` is excluded even more strongly (also excluded from pass 2, `ranking.ts:194`) | `a cooled-down subscription is excluded entirely in favor of a healthy PAYG route for the same model` |
| 4 | n/a (free vs. PAYG, not subscription) | both `AVAILABLE` | **PAYG** | `chinese-flash-payg` precedes `free-chinese-flash` in `policy.ts:7` (human-authored ladder) | see caveat below |

Row 2 is **the interesting case** the task asked to name explicitly: a subscription that is
*not down*, merely inside its reserve, still loses to a healthy PAYG route for the same
model. This is **not** a violation of claim 1 — claim 1 protects a *healthy* subscription,
and `DRAINING` is by definition not healthy. It is the intended fallback design: `ranking.ts:182-183`'s own comment states the goal is precisely "avoids burning a draining preferred class when a healthy fallback class exists," so a session under reserve pressure is deliberately moved off the strained subscription route rather than forced to keep spending down the reserve. Confirmed correct as designed, not a bug.

### Caveat on row 4 (free vs. PAYG) — not part of claim 1, flagged separately

Claim 1 as stated is about **subscription vs. PAYG**. Row 4 (same-model plain vs. `:free`
OpenRouter selector, both `AVAILABLE`) is a different pair not covered by any invariant in
`AGENTS.md` (I1–I12, N1–N6 all name subscription/free/quota interactions, none says "free
must outrank PAYG for the same model"). What the code actually does here is entirely a
`policy.yml`/`DEFAULT_POLICY` **ladder-ordering** decision — `chinese-flash-payg` is listed
before `free-chinese-flash` in `extension/policy.ts:7` (`balanced` tier) and the same
PAYG-before-free ordering repeats in the `small` tier (`cheap-flash` before
`healthy-free-fast`, `policy.ts:8`) and the `frontier` tier (`strong-flash-sub` /
`strong-chinese` before `best-free`, `policy.ts:6`). This is a **human policy decision**
(free-tier capacity for these categories is presumably considered less reliable/available
in practice than a metered paid seller), not a computation `ranking.ts` performs. Per
`AGENTS.md` ("Changing a class ladder in `policy.yml`... [is something] you must ask about"),
this investigation does not propose changing it — it is reported as an as-designed,
pre-existing behaviour, distinct from and not contradicting claim 1.

### Mutation proof (red-capability)

Each test was proven capable of failing by mutating the exact production line it protects,
observing the correct failure, then reverting (verified back to green + full suite green
after every revert):

| Test | Mutation | File:line | Result |
|---|---|---|---|
| Row 1 | Inverted the `economics.subscriptionLike` gate (`if (economics.subscriptionLike)` → `if (!economics.subscriptionLike)`) so PAYG gets `sonnet-sub` and subscription does not | `policy.ts:71` | `sel?.route.key` flipped to `openrouter/claude-sonnet-5` (expected `anthropic/...`) — failed for the right reason. Row 4's classification assertion also collaterally failed (expected, same root mutation). Reverted; 4/4 green. |
| Row 2 | Loosened pass 1's filter from `state === 'AVAILABLE'` to `state !== 'COOLDOWN'`, collapsing the two-pass design into one pass that admits `DRAINING` immediately | `ranking.ts:185` | `sel?.route.key` flipped to `anthropic/claude-sonnet-5` (the still-draining subscription) — failed for the right reason, isolated to this one test (3/4 pass). Reverted; 4/4 green. |
| Row 3 | Removed the health check from pass 1's filter entirely (`r.classes.includes(className)` only) | `ranking.ts:185` | Both row 2 and row 3 failed (superset mutation, expected) — row 3's `COOLDOWN` subscription was wrongly selected. Reverted; 4/4 green. |
| Row 4 | Swapped `chinese-flash-payg`/`free-chinese-flash` order in `DEFAULT_POLICY.tiers.balanced.classes` | `policy.ts:7` | Row 4's ladder-order assertion failed, isolated (3/4 pass). Reverted; 4/4 green. |

Each mutation was applied, `bun test tests/payg-vs-sub.test.ts` run to observe the failure
verbatim (captured above), then reverted with a matching edit and re-verified green before
moving to the next mutation. No two mutations were live at once.

---

## Claim 2 — "a native fallback request carries the full prior history"

**Verdict: CONFIRMED — by code-level evidence that the extension does not touch history,
plus the pre-existing empirical proof in `docs/investigations/bug-c-context-loss-root-cause.md`.** This does not re-litigate BUG C; it answers the narrower question the task asked: *what does the extension itself control here, and could it truncate/replace history?*

### What the extension controls (and doesn't) at retry/fallback time

OMP's own retry/fallback engine is configured, not implemented, by this repo. The
installer writes the following into OMP's own config (`config/config-patch.yml:1-11`):

```yaml
retry:
  enabled: true
  modelFallback: true
  fallbackRevertPolicy: cooldown-expiry
  usageAwareFallback: true
  usageReservePct: 10
  usageReservePolicy: auto
  waitForUsageReset: false
```

These are OMP core keys (`retry.fallbackChains`, referenced but "intentionally preserved,"
per the file's own header comment) — the extension never reads or writes conversation
history through them.

The extension's only touchpoints for a retry/fallback turn are three event hooks in
`extension/index.ts`, none of which reference `ctx.branch`, `ctx.history`, session
messages, or anything content-shaped:

- **`retry_fallback_applied`** (`index.ts:302-306`): records `event.from`/`event.to` into
  two in-memory strings (`lastRetryFrom`, `lastRoutedSelector`) for the router's own
  bookkeeping of which route is "current" for the next turn. No content is read.
- **`auto_retry_start`** (`index.ts:308-354`): classifies the error
  (`isRateOrQuotaError`, `health.ts:184-186`), decides whether to mark the failed route's
  *local health state* in cooldown (`state.markCooldown`/`state.recordFailure`,
  `index.ts:323-334`, persisted to `extension/state.json` — a routing-health cache, not a
  conversation transcript), and optionally schedules a background telemetry refresh
  (`index.ts:337-353`). Again: route-health bookkeeping only.
- **`auto_retry_end`** (`index.ts:356-360`): resets three booleans/strings. Nothing else.

Critically, `before_agent_start` — the only hook where the router calls `pi.setModel` —
is explicitly gated off *during* an active retry: `shouldRouteBeforeAgentStart(retryActive)`
(`runtime.ts:102-104`) returns `false` while `retryActive` is true (`index.ts:234`), so
**the router does not even attempt a model switch while OMP's native retry/fallback is
handling the in-flight turn.** The router only acts *before* the next new turn, once
`auto_retry_end` has cleared `retryActive`. There is no code path in this extension that
constructs, filters, or resends the message/history array for a fallback request — that
entire mechanism (which messages accompany a fallback request) is OMP core, outside
`extension/`.

This matches the activation-contract spec's own statement: `docs/spec-virtual-model-routing.md:111-113`
("`manual` means 'adaptive-router doesn't switch models'. It does **not** disable OMP's own
retry/`modelFallback` for the active turn — that's OMP core behavior
(`retry.fallbackChains`), untouched by this change.").

### Empirical corroboration (not re-derived here — cited from BUG C)

`docs/investigations/bug-c-context-loss-root-cause.md` case 4+5 (`tools/context-tracer/`,
`bug-c-context-trace.jsonl`) is a **live trace of two consecutive
`retry_fallback_applied` events** (`lfm-2.5-1.2b-thinking:free → ~deepseek-v4-flash-latest →
nemotron-3-ultra:free`) where the provider payload after each fallback carried the marker
and a consistent message count (`✓ in all 4 post-switch requests incl. both fallback
models`, matrix row "4+5"). BUG C's own alternatives-disproved section states this
outright: "**Not native fallback** — fallback requests in case 4+5 carry the full history."
The root cause BUG C found for *actual* context loss (OpenAI remote compaction replaced by
an unreplayable placeholder on a subsequent switch, `bug-c-context-loss-root-cause.md:68-119`)
is orthogonal to fallback itself — it is a property of OMP's compaction storage
(`preserveData.openaiRemoteCompaction.replacementHistory`) combined with a *later*
provider-family switch, not of the fallback request itself, and it is not re-investigated
here per the task's instruction not to re-litigate BUG C.

### Alternatives disproved

- **The extension truncates history on fallback** — disproved by code inspection: no hook
  in `index.ts` reads or writes message/branch content; `retry_fallback_applied`,
  `auto_retry_start`, `auto_retry_end` only touch route-health bookkeeping strings and
  `state.json` (health cache, not transcript).
- **The extension re-routes mid-fallback and could substitute a different model without
  its accumulated history** — disproved: `shouldRouteBeforeAgentStart` (`runtime.ts:102-104`)
  blocks the router's `setModel` call for the entire duration `retryActive` is true
  (`index.ts:234`); OMP's own fallback chain owns model selection and message
  continuation for that turn (`retryRoutingPolicy`'s `nativeOwnsContinuation: true` in every
  branch, `runtime.ts:80-99`).
- **A fresh fallback model starts a new session/branch, dropping prior turns** — already
  disproved with provider-payload evidence in BUG C case 4+5 (same session id, linear leaf
  advancement, marker present in every subsequent payload).

### Minimal fix boundary

None. No violation found. Nothing to fix in `extension/`.

---

## Summary

| Claim | Verdict |
|---|---|
| 1. A PAYG route is never chosen over an equivalent healthy subscription | **CONFIRMED** (`extension/tests/payg-vs-sub.test.ts`, 4/4 green, each mutation-proven). The one "surprising" row (draining subscription loses to healthy PAYG) is intended fallback behavior, not a violation — the subscription in that row is not healthy. |
| 2. A native fallback request carries the full prior history | **CONFIRMED** by code-level evidence (`extension/index.ts` retry/fallback hooks touch only route-health bookkeeping, never message content; `runtime.ts:102-104` blocks router-initiated switches during an active retry) plus the pre-existing empirical trace in `docs/investigations/bug-c-context-loss-root-cause.md` (case 4+5). |

No production code was changed. No policy/ladder change is proposed.
