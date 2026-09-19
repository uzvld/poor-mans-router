# Roadmap

Ordered. Each item links to the evidence that put it here. Do not start an item whose predecessor is open unless the human says so.

## Open

### 1. BUG C — context loss on model switch — ROOT CAUSE PROVEN, fix is outside this repo
**Status:** investigated across 7 cases with provider-payload tracing (`tools/context-tracer/`). The hypothesised loss (switch resets/omits history) **does not reproduce** for direct switch, `pi.setModel`, native 429 fallback, cross-provider, 1M→32k shrink, or Multica same-file re-spawn. The real loss is **OMP OpenAI remote compaction**: on a Responses-API provider OMP stores provider-native `replacementHistory` and a one-line placeholder summary; after a switch to any non-Responses model the placeholder is all the new model sees. Proven in a real 3,300-entry session (4 remote compactions, 250–300k tokens each → 933-char placeholder). See `docs/investigations/bug-c-context-loss-root-cause.md`.
**Fix boundary:** OMP config or OMP core — **not adaptive-router**. The config lever was renamed upstream: `compaction.remoteEnabled` no longer exists in 18.2.6 ("Replaced `compaction.strategy` and `compaction.remoteEnabled` with an ordered `compaction.methodOrder` preference list"), so the mitigation is `compaction.methodOrder` without `"remote"` — applied at user level 2026-09-19, which also disables Anthropic's server-side compaction (the `remote` method now covers both). Router-side follow-up (guard only, not a fix): warn/refuse `setModel` away from a Responses-API provider when the branch's newest compaction is `method: "remote"`.

### 2. Deploy lock
Installs and rollbacks must be single-writer. Proposed: atomic `mkdir` of `$(omp config path)/extensions/.adaptive-router-deploy.lock` containing `{pid, session, started_at}`, stale-lock reclaim after N minutes, and the installer refusing to run while it exists. Motivated by a replayed-turn incident where two runs of one session both deployed.

### 3. 429 / fallback and PAYG-vs-free routing
Deferred until BUG C. Includes verifying that a native fallback request carries the full prior history and that a PAYG route is never chosen over an equivalent healthy subscription.

### 4. Docs drift
`docs/design.md` §"DRAINING", lines describing "CodexBar `willLastToReset=false` → DRAINING" and the worked example `claude-sonnet-5 DRAINING quota pace`, predate the I2 policy. Update to match `health.ts`.

### 5. Rename the virtual provider to `PMR`
Requested by the owner 2026-09-19: the picker should read `PMR/balanced`, `PMR/frontier`, … instead of `router/*`. Mechanical in `virtual-model.ts` (`VIRTUAL_PROVIDER`, model `name`s) plus the `[omp:router]` marker tag, README/AGENTS wording, and `docs/spec-virtual-model-routing.md`. Two things to settle first:
- **Tier naming.** The request listed `PMR/balanced`, `PMR/free`, `PMR/frontier`. Today the third tier is `small` (`cheap-sub → cheap-flash → healthy-free-fast`), i.e. cheap-and-fast, not free-only. Either rename `small` → `free` (then its ladder should drop the paid `cheap-sub`/`cheap-flash` rungs, which changes routing) or keep `small` and treat `free` as a wording slip. Needs the owner's answer before touching the ladder.
- **Provider-id casing — RESOLVED 2026-09-19.** An upper-case runtime provider id survives: a probe extension registering `PMR` resolved at cold start (`omp --model PMR/balanced`) and the outgoing payload carried `"provider":"PMR","model":"balanced"`. No lower-case fallback needed.

Migration note: any session or Multica agent pinned to `router/*` stops resolving after the rename — ship it with the selectors documented in one place.

### 6. Host integration — MOSTLY ANSWERED, one row open
See `docs/investigations/host-integration-matrix.md`. Established: `omp` directly, `multica → omp` and `paseo → omp` all run a real OMP agent session, so the contract governs them; the Multica shape (fresh process per run, same session file, `--model`) was live-probed twice and rebuilt managed mode from `current()` both times.

**`multica → hermes → omp` is not governed and cannot be:** Hermes uses OMP as a model *provider* over RPC (`model.provider: omp` via `~/.hermes/plugins/model-providers/omp/`), so no OMP agent process and no extension exist on that path. Agents routed through Hermes are selected by Hermes' own model config; `pmr/*` selectors are meaningless there. If adaptive routing is wanted for them it belongs in Hermes' provider layer.

Still open:
- Multica: confirm no runtime passes `--no-extensions` (the flag string exists in the binary); if one does, the router is silently absent there.

### 7. Hermes ⇄ OMP bridge: verify translation fidelity
The bridge works (owner's report) — what is unverified is whether it translates OMP's stream faithfully into Hermes' OpenAI-shaped stream. Reading `~/.hermes/plugins/model-providers/omp/omp_rpc_client.py`, three places where a wrong mapping would hide:
- **Streaming.** `text_delta → delta.content`; check chunk boundaries, ordering against tool activity, and that an interrupted OMP stream surfaces as an error rather than a clean end.
- **Reasoning.** `thinking_delta` is written to **both** `delta.reasoning_content` and `delta.reasoning` with the same text; confirm Hermes does not double-count or double-render it, and that reasoning never leaks into `content`.
- **Tool calls.** `delta.tool_calls` is hard-coded `None` in both chunk builders while OMP emits `tool_execution_start` / `tool_end` / `tool_call_start`; OMP executes the tools itself (thin host). Confirm Hermes' loop is not waiting for structured tool calls, that tool activity is rendered rather than injected as assistant prose, and that `<tool_call>` text parsing cannot double-execute.
- **Termination.** The stream always closes `finish_reason="stop"`, so truncation (`length`), tool-stops and errors are indistinguishable downstream; verify nothing depends on that distinction.

Hermes-side work (the plugin has `test_thin_host.py` / `test_model_switch_markers.py` to extend), not `adaptive-router` code.

Deliverable per row of item 8: the outgoing provider payload and the route decision, not just a model that answered (AGENTS.md step 6).

## Done

- **First managed turn no longer waits for telemetry** — `before_agent_start` used to await `omp usage` + the CodexBar CLI (28–31 s live). Refreshes are scheduled instead, and the normalized snapshot is persisted in `state.json` (15-minute bound) so a fresh process — every Multica run — routes from last-known data. Live: 7 s including the answer. `first-turn-latency.test.ts`.

- **CodexBar window scope** — allowance windows (with a reset) no longer veto a provider whose prepaid balance still has capacity, a spent balance no longer borrows an allowance's reset date, and a pace forecast only counts for the window that carries capacity. Closes FOLLOWUP-T1 and the exhaustion half found live on kilo. Invariants N5/N6; `codexbar-windows.test.ts`, `codexbar-pace-scope.test.ts`. See `docs/investigations/finding-codexbar-window-collapse.md`.

- **BUG D** — healthy Sonnet subscription bypassed by CodexBar weekly pace forecast. Root cause proven with counterfactual replay; fixed in `health.ts` precedence; in-class winner fixed (neutral cold-start prior, family-scoped affinity, generation tie-break). 67/67 tests; live-verified. See `docs/investigations/`.
- **Virtual-model routing contract** — the router no longer guesses which sessions it owns. Three registered virtual models (`router/frontier|balanced|small`) are the only opt-in; selecting any concrete model is a permanent per-session opt-out; `agentTiers`/`modelRole`/agent-name tier guessing deleted. A fail-closed `before_provider_request` guard aborts the turn if a request ever reaches the virtual provider (live-verified: 0 auto-retries vs 10 unguarded). 85/85 unit tests + differential replay; live-verified managed cold start and manual opt-out. Spec: `docs/spec-virtual-model-routing.md`; plan: `docs/superpowers/plans/2026-09-19-virtual-model-routing.md`.
- **Visible model-switch marker** (was open item 3) — router-initiated switches emit `[omp:router] <from> -> <to> (<reason>)` through `ctx.ui.notify`. Guarded by `switch-marker.test.ts`.
