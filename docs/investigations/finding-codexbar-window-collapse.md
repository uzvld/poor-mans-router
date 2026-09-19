# FINDING — CodexBar exhaustion collapses independent quota windows

**Found:** 2026-09-19, during live verification of the virtual-model routing install (OMP 18.2.6, installed extension, unmodified).
**Status:** FIXED 2026-09-19 in `telemetry.ts` (window scope) + `health.ts` (truthful reason). The exhaustion half of roadmap item 3 is closed; the pace half (FOLLOWUP-T1) remains open.
**Resolution:** the human owner clarified the semantics — the Kilo Pass is itself a monthly top-up with a bonus, so both windows describe **one wallet**, not independent scopes: `secondary` is cumulative spend against the pass allowance, `primary` is what remains of the last top-up. Capacity therefore lives in the remaining balance; a consumed allowance is the normal state and must not veto.
**Impact before the fix:** every kilo route was vetoed for ~a month whenever the pass was spent, even with credits left — a drained Anthropic subscription would have pushed work to PAYG or free routes instead of a working kilo balance. Latent at discovery time only because the balanced ladder prefers `sonnet-sub`.

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

## The fix

The distinction is derivable from the data, with no provider allowlist: **a window with a reset time is an allowance that refills on its own; a window without one is a prepaid balance that only a manual top-up refills.**

`telemetry.ts` now tags every window with that scope and picks the vetoing set accordingly:

- the provider exposes a balance window → capacity is the balance; the veto fires only when **every** balance window is spent, and allowance windows are accounting only;
- no balance window (Codex 5h + weekly, Anthropic) → the allowances *are* the capacity and any spent one vetoes until its reset — unchanged, so I2/I3 and the BUG D fix are untouched;
- `blockedUntil` is taken only from windows that actually vetoed, so a spent balance no longer borrows the allowance's reset date.

`health.ts` reports `CodexBar prepaid balance exhausted` when the veto came from a balance, instead of claiming a quota reset that does not apply. `CodexBarUsage` carries `exhaustionScope: 'allowance' | 'balance'`.

Verdict change on the live kilo row (same input as above):

```
before:  COOLDOWN/FRESH until 2026-10-17T09:22:52.000Z  "CodexBar quota exhausted"
after:   AVAILABLE/FRESH
```

Guarded by `tests/codexbar-windows.test.ts` (4 tests: pass-spent-with-credits stays usable; empty balance vetoes with no borrowed reset date; all-allowance providers keep the reset-until veto; route-level health and reason text). Mutation-checked: restoring the any-window veto turns 3 of the 4 red. Full suite 89/89, `test:sim` differential replay unchanged.

What is **not** fixed: the pace path (`telemetry.ts`, `draining = paceRows.some(...)`) still collapses pace windows into one provider-wide boolean. That is FOLLOWUP-T1 and stays open in roadmap item 3.

## Reproduction

```bash
cd ~/Projects/poor-mans-router/extension
# the live row above, through the current normaliser
bun -e 'import {normalizeCodexBarProvider} from "./telemetry.ts";
console.log(normalizeCodexBarProvider({provider:"kilo",usage:{
  primary:{usedPercent:68.69402},
  secondary:{usedPercent:100,resetsAt:"2026-10-17T09:22:52Z"}}}))'
# => { exhausted: false, ... }   (before the fix: exhausted true, blockedUntil 2026-10-17)
```
