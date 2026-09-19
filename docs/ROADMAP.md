# Roadmap

Ordered. Each item links to the evidence that put it here. Do not start an item whose predecessor is open unless the human says so.

## Open

### 1. BUG C — context loss on model switch — ROOT CAUSE PROVEN, fix is outside this repo
**Status:** investigated across 7 cases with provider-payload tracing (`tools/context-tracer/`). The hypothesised loss (switch resets/omits history) **does not reproduce** for direct switch, `pi.setModel`, native 429 fallback, cross-provider, 1M→32k shrink, or Multica same-file re-spawn. The real loss is **OMP OpenAI remote compaction**: on a Responses-API provider OMP stores provider-native `replacementHistory` and a one-line placeholder summary; after a switch to any non-Responses model the placeholder is all the new model sees. Proven in a real 3,300-entry session (4 remote compactions, 250–300k tokens each → 933-char placeholder). See `docs/investigations/bug-c-context-loss-root-cause.md`.
**Fix boundary:** OMP config or OMP core — **not adaptive-router**. The config lever was renamed upstream: `compaction.remoteEnabled` no longer exists in 18.2.6 ("Replaced `compaction.strategy` and `compaction.remoteEnabled` with an ordered `compaction.methodOrder` preference list"), so the mitigation is `compaction.methodOrder` without `"remote"` — applied at user level 2026-09-19, which also disables Anthropic's server-side compaction (the `remote` method now covers both). Router-side follow-up (guard only, not a fix): warn/refuse `setModel` away from a Responses-API provider when the branch's newest compaction is `method: "remote"`.

### 2. Deploy lock
Installs and rollbacks must be single-writer. Proposed: atomic `mkdir` of `$(omp config path)/extensions/.adaptive-router-deploy.lock` containing `{pid, session, started_at}`, stale-lock reclaim after N minutes, and the installer refusing to run while it exists. Motivated by a replayed-turn incident where two runs of one session both deployed.

### 3. FOLLOWUP-T1 — CodexBar pace still loses window scope
`telemetry.ts` collapses all pace windows into one provider-wide boolean (`draining = paceRows.some(...)`). Harmless while OMP reports on the provider (I2), but for providers with **no** OMP usage report it can yield an over-broad `DRAINING`. Fix: carry each pace window with its scope and let `health.ts` match window → route, the way the exhaustion path now does.

The exhaustion half of this defect is **closed**: allowance windows (with a reset) no longer veto a provider whose prepaid balance still has capacity, and a spent balance no longer borrows an allowance's reset date. Found live on kilo, where a consumed monthly pass had vetoed every route for a month. See `docs/investigations/finding-codexbar-window-collapse.md`.

### 4. 429 / fallback and PAYG-vs-free routing
Deferred until BUG C. Includes verifying that a native fallback request carries the full prior history and that a PAYG route is never chosen over an equivalent healthy subscription.

### 5. Docs drift
`docs/design.md` §"DRAINING", lines describing "CodexBar `willLastToReset=false` → DRAINING" and the worked example `claude-sonnet-5 DRAINING quota pace`, predate the I2 policy. Update to match `health.ts`.

### 6. Rename the virtual provider to `PMR`
Requested by the owner 2026-09-19: the picker should read `PMR/balanced`, `PMR/frontier`, … instead of `router/*`. Mechanical in `virtual-model.ts` (`VIRTUAL_PROVIDER`, model `name`s) plus the `[omp:router]` marker tag, README/AGENTS wording, and `docs/spec-virtual-model-routing.md`. Two things to settle first:
- **Tier naming.** The request listed `PMR/balanced`, `PMR/free`, `PMR/frontier`. Today the third tier is `small` (`cheap-sub → cheap-flash → healthy-free-fast`), i.e. cheap-and-fast, not free-only. Either rename `small` → `free` (then its ladder should drop the paid `cheap-sub`/`cheap-flash` rungs, which changes routing) or keep `small` and treat `free` as a wording slip. Needs the owner's answer before touching the ladder.
- **Provider-id casing.** OMP normalises/compares provider ids in several paths; confirm an upper-case id survives registration, `/model` fuzzy match and cold-start `--model PMR/balanced` before committing to `PMR` over `pmr` with a display name.
Migration note: any session or Multica agent pinned to `router/*` stops resolving after the rename — ship it with the selectors documented in one place.

### 7. First managed turn stalls ~28 s on telemetry
`before_agent_start` awaits `refreshLive()` on the first turn of a managed session, which runs `omp usage` plus the CodexBar CLI. Observed 28–31 s before the first request goes out. Fix: route from cached/last-known telemetry (or no telemetry) and refresh in the background, so only later turns benefit from fresh quota data.

## Done

- **BUG D** — healthy Sonnet subscription bypassed by CodexBar weekly pace forecast. Root cause proven with counterfactual replay; fixed in `health.ts` precedence; in-class winner fixed (neutral cold-start prior, family-scoped affinity, generation tie-break). 67/67 tests; live-verified. See `docs/investigations/`.
- **Virtual-model routing contract** — the router no longer guesses which sessions it owns. Three registered virtual models (`router/frontier|balanced|small`) are the only opt-in; selecting any concrete model is a permanent per-session opt-out; `agentTiers`/`modelRole`/agent-name tier guessing deleted. A fail-closed `before_provider_request` guard aborts the turn if a request ever reaches the virtual provider (live-verified: 0 auto-retries vs 10 unguarded). 85/85 unit tests + differential replay; live-verified managed cold start and manual opt-out. Spec: `docs/spec-virtual-model-routing.md`; plan: `docs/superpowers/plans/2026-09-19-virtual-model-routing.md`.
- **Visible model-switch marker** (was open item 3) — router-initiated switches emit `[omp:router] <from> -> <to> (<reason>)` through `ctx.ui.notify`. Guarded by `switch-marker.test.ts`.
