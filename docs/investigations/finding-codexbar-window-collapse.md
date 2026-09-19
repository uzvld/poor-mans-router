# FINDING — CodexBar exhaustion collapses independent quota windows

**Found:** 2026-09-19, during live verification of the virtual-model routing install (OMP 18.2.6, installed extension, unmodified).
**Status:** NOT FIXED. Policy decision required — this touches `health.ts`/`telemetry.ts` exhaustion semantics, which `AGENTS.md` puts behind a human decision.
**Impact today:** latent. The balanced ladder picks `sonnet-sub` before any kilo class, so the wrong verdict changed no decision in the observed session.
**Impact when it bites:** every kilo route is vetoed for ~a month whenever the paid window is spent, even with plan credits left — so a drained Anthropic subscription would push work to PAYG or free routes instead of a working kilo subscription.

## Evidence

`/route-status` on a live managed session (`router/balanced`, 2026-09-19T06:2x):

```
mode: balanced
tier: balanced
selected: anthropic/claude-sonnet-5
reason: available sonnet-sub; effective-cost=0.0000
  anthropic/claude-sonnet-5                AVAILABLE/FRESH
  kilo/~anthropic/claude-sonnet-latest     COOLDOWN/FRESH until 2026-10-17T09:22:52.000Z  CodexBar quota exhausted
  kilo/~deepseek/deepseek-v4-flash-latest  COOLDOWN/FRESH until 2026-10-17T09:22:52.000Z  CodexBar quota exhausted
  … every other kilo route, same verdict …
  OMP usage: 12s old   CodexBar: 12s old   OpenRouter Data API: 40s old   OMP stats: 38s old
```

Live CodexBar row for kilo (`codexbar usage --provider all --format json`):

```json
{"provider":"kilo","usage":{
  "primary":   {"usedPercent":68.69402, "resetDescription":"6.87/10 credits"},
  "secondary": {"usedPercent":100, "resetsAt":"2026-10-17T09:22:52Z",
                "resetDescription":"$45.10 / $19.00 (+ $9.50 bonus)"},
  "tertiary":  null, "loginMethod":"Starter · Auto top-up: off"}}
```

`omp usage --redact --json` has **no** row for kilo, so CodexBar is authoritative here (no I2 override).

Counter-evidence that the provider is not exhausted: minutes earlier, in the same environment, `omp --model kilo/kilo-auto/efficient -p …` answered normally.

## Layer

`telemetry.ts:152` — `exhausted: exhaustedWindows.length > 0`.

Replay of the **installed** modules against the live row:

```
normalized: {"exhausted":true,"draining":false,"blockedUntil":"2026-10-17T09:22:52.000Z"}
windows:    primary=68.7% (6.87/10 credits, capacity left)   secondary=100% ($ wallet)
```

`health.ts:86-94` then turns `exhausted` into `COOLDOWN` + `reason: 'CodexBar quota exhausted'` with `cooldownUntil` = the *secondary* window's reset, for every route of the provider.

The two windows are different scopes: `primary` is the plan's credit pool (31 % left), `secondary` is the paid/overage wallet (spent). Collapsing them with `length > 0` makes the spent wallet veto the credit pool.

This is the exhaustion-path twin of open roadmap item 3 (FOLLOWUP-T1), which describes the same collapse on the **pace** path (`.some()` in `telemetry.ts:146`). Both stem from CodexBar windows losing their scope during normalisation.

## Why no fix in this change

Invariant I4 ("quota windows are independent scopes") is currently tested only for OMP-reported windows (`health.test.ts` · "Fable scoped quota"). Extending it to CodexBar windows changes which routes are eligible under real quota pressure — a policy change, not a defect fix with an obvious correct answer. Open questions for the human:

1. Does a spent `secondary` (paid wallet) window block **paid** kilo routes only, or nothing, while `primary` credits remain?
2. Is `primary` the authority for subscription-like routes on aggregators, with `secondary` only gating PAYG overage?
3. Should `blockedUntil` ever come from a window that did not veto the route?

A fix would carry each window's scope through `CodexBarUsage` (instead of one provider-wide boolean) and let `health.ts` match window → route economics, which is the same refactor FOLLOWUP-T1 needs.

## Reproduction

```bash
cd ~/Projects/poor-mans-router/extension
# feed the live row above through the installed normaliser
bun -e 'import {normalizeCodexBarProvider} from "./telemetry.ts";
console.log(normalizeCodexBarProvider({provider:"kilo",usage:{
  primary:{usedPercent:68.69402},
  secondary:{usedPercent:100,resetsAt:"2026-10-17T09:22:52Z"}}}))'
```
