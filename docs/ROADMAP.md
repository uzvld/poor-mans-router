# Roadmap

Ordered. Each item links to the evidence that put it here. Do not start an item whose predecessor is open unless the human says so.

## Open

### 1. BUG C — context loss on model switch
**Status:** not investigated. A systematic-debugging matrix is specified (cases 0–7: direct OMP switch with router disabled, router `pi.setModel`, native 429 fallback, Multica model-field change, same-provider vs cross-provider). The deliverable is a root-cause report with session/branch identity and provider-payload traces before and after the switch. **No fix until the losing layer is proven.**

### 2. Deploy lock
Installs and rollbacks must be single-writer. Proposed: atomic `mkdir` of `$(omp config path)/extensions/.adaptive-router-deploy.lock` containing `{pid, session, started_at}`, stale-lock reclaim after N minutes, and the installer refusing to run while it exists. Motivated by a replayed-turn incident where two runs of one session both deployed.

### 3. Visible model-switch marker
When the router or native fallback changes the model mid-session, OMP output should show it the way tool calls are shown (`[omp:hub]`-style), e.g. `[omp:router] anthropic/claude-sonnet-5 → kilo/…` with the reason. Today the only signal is the status bar.

### 4. FOLLOWUP-T1 — scoped CodexBar pace
`telemetry.ts` still collapses all pace windows into one provider-wide boolean via `.some()`. Harmless while OMP reports on the provider (I2), but for providers with **no** OMP usage report it can still yield an over-broad `DRAINING`. Fix: carry per-window pace with its scope and let `health.ts` match window to route.

### 5. 429 / fallback and PAYG-vs-free routing
Deferred until BUG C. Includes verifying that a native fallback request carries the full prior history and that a PAYG route is never chosen over an equivalent healthy subscription.

### 6. Docs drift
`docs/design.md` §"DRAINING", lines describing "CodexBar `willLastToReset=false` → DRAINING" and the worked example `claude-sonnet-5 DRAINING quota pace`, predate the I2 policy. Update to match `health.ts`.

## Done

- **BUG D** — healthy Sonnet subscription bypassed by CodexBar weekly pace forecast. Root cause proven with counterfactual replay; fixed in `health.ts` precedence; in-class winner fixed (neutral cold-start prior, family-scoped affinity, generation tie-break). 67/67 tests; live-verified. See `docs/investigations/`.
