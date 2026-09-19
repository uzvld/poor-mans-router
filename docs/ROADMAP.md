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

### 5. Host integration — ANSWERED for all four paths
See `docs/investigations/host-integration-matrix.md`. Established: `omp` directly, `multica → omp` and `paseo → omp` all run a real OMP agent session, so the contract governs them; the Multica shape (fresh process per run, same session file, `--model`) was live-probed twice and rebuilt managed mode from `current()` both times.

**`multica → hermes → omp` IS governed — the earlier "cannot be" verdict was wrong (corrected 2026-09-19).** `omp --mode rpc-ui` is a full agent host, so the extension loads and routes there too: the bridge's own discovery lists `pmr/frontier|balanced|small|free`, and a live `hermes -z` turn printed `[omp:pmr] pmr/balanced -> anthropic/claude-sonnet-5 (available sonnet-sub; effective-cost=0.0000)` before answering. Reproduce with `tools/hermes-path-probe/probe.py`. The only requirement is that Hermes selects a `pmr/*` id (`~/.hermes/config.yaml` → `model.default`).

Still open:
- Multica: confirm no runtime passes `--no-extensions` (the flag string exists in the binary); if one does, the router is silently absent there.
- Hermes-side (not this repo): the ACP picker cannot enumerate OMP models at all, because `list_authenticated_providers` only yields credentialed providers and the `omp` profile has `env_vars=()`. `pmr/*` is therefore config-selectable but not menu-selectable. Fix has a precedent: the credential-less row injection `_local_runtime_row` at `hermes_cli/inventory.py:103`.

### 6. Hermes ⇄ OMP bridge: translation fidelity — two rows measured, two open
The bridge works (owner's report). Measured 2026-09-19 on the owner's machine; the plugin lives in `~/.hermes/plugins/model-providers/omp/`, not in this repo.

- **Model pinning — FIXED (plugin-side).** `_pin_model` split the model id on the first `/` and swallowed every error (`except Exception: pass`). Multica's picker sends Hermes-provider-prefixed ids (`omp:anthropic/claude-fable-5-1`, `omp:openai-codex/gpt-5.6-luna` — the latter every 30 min from the hotline cron), which partitioned into provider `omp:anthropic` → OMP answered `Model not found` → the turn silently ran on OMP's own persisted current model (`kilo/kilo-auto/efficient` on a fresh rpc-ui session). Fix: strip the host-provider prefix, raise on refusal, raise when an acked switch does not move, warn when OMP normalises the id. `test_model_pin.py` (8 tests, red-capable: 4/4 behavioural tests fail against the pre-fix file).
- **Tool calls — answered, and it is a rendering gap, not a correctness bug.** `delta.tool_calls` is hard-coded `None`; `_tool_activity_text` flattens `tool_execution_start`/`tool_end`/`command_output` into `[omp:<tool>]` text inside `delta.content`. Hermes therefore never waits for structured calls (no double-execution risk), but Multica shows prose. Measured in Multica's daemon log by task provider: `provider=omp` → 7750 structured `tool_result` rows, 0 markers; `provider=hermes` → 5674 `[omp:*]` markers, 0 structured rows. Pretty rendering on the Hermes path needs the live ACP rail (`acp_adapter/server.py:889,921` installs `agent.tool_progress_callback`), which a provider plugin cannot reach: `agent/agent_runtime_helpers.py:1668` calls `profile.create_client(**client_kwargs)` without the agent, and there is no ambient agent ContextVar nor a tool-lifecycle plugin hook. Precedent for the core patch: `agent/codex_runtime.py:285`. The transcript-only alternative (`hermes_projected_messages` → `agent/provider_projection.py`) fixes Hermes' own UI but not Multica, which renders from live ACP updates.
- **Streaming — open.** `text_delta → delta.content`; check chunk boundaries, ordering against tool activity, and that an interrupted OMP stream surfaces as an error rather than a clean end.
- **Reasoning — open.** `thinking_delta` is written to **both** `delta.reasoning_content` and `delta.reasoning` with the same text; confirm Hermes does not double-count or double-render it, and that reasoning never leaks into `content`.
- **Termination — open, and it interacts with the row above.** The stream always closes `finish_reason="stop"` (`omp_rpc_client.py`), so truncation (`length`), tool-stops and errors are indistinguishable downstream; any status shown in a UI built on this path would be wrong for failures.

Deliverable per row: the outgoing provider payload and the route decision, not just a model that answered (AGENTS.md step 6).

## Done

- **`pmr/*` selectors** — the virtual provider is `pmr`, and the picker offers four tiers: `pmr/frontier`, `pmr/balanced`, `pmr/small` (cheap and fast, paid rungs included) and `pmr/free` (free-only by contract, never spends). Switch markers read `[omp:pmr]`. Upper-case ids were verified to resolve, but lower case matches every other OMP provider id, with `PMR: …` as the display name.
- **First managed turn no longer waits for telemetry** — `before_agent_start` used to await `omp usage` + the CodexBar CLI (28–31 s live). Refreshes are scheduled instead, and the normalized snapshot is persisted in `state.json` (15-minute bound) so a fresh process — every Multica run — routes from last-known data. Live: 7 s including the answer. `first-turn-latency.test.ts`.

- **CodexBar window scope** — allowance windows (with a reset) no longer veto a provider whose prepaid balance still has capacity, a spent balance no longer borrows an allowance's reset date, and a pace forecast only counts for the window that carries capacity. Closes FOLLOWUP-T1 and the exhaustion half found live on kilo. Invariants N5/N6; `codexbar-windows.test.ts`, `codexbar-pace-scope.test.ts`. See `docs/investigations/finding-codexbar-window-collapse.md`.

- **BUG D** — healthy Sonnet subscription bypassed by CodexBar weekly pace forecast. Root cause proven with counterfactual replay; fixed in `health.ts` precedence; in-class winner fixed (neutral cold-start prior, family-scoped affinity, generation tie-break). 67/67 tests; live-verified. See `docs/investigations/`.
- **Virtual-model routing contract** — the router no longer guesses which sessions it owns. Three registered virtual models (`pmr/frontier|balanced|small`) are the only opt-in; selecting any concrete model is a permanent per-session opt-out; `agentTiers`/`modelRole`/agent-name tier guessing deleted. A fail-closed `before_provider_request` guard aborts the turn if a request ever reaches the virtual provider (live-verified: 0 auto-retries vs 10 unguarded). 85/85 unit tests + differential replay; live-verified managed cold start and manual opt-out. Spec: `docs/spec-virtual-model-routing.md`; plan: `docs/superpowers/plans/2026-09-19-virtual-model-routing.md`.
- **Visible model-switch marker** (was open item 3) — router-initiated switches emit `[omp:pmr] <from> -> <to> (<reason>)` through `ctx.ui.notify`. Guarded by `switch-marker.test.ts`.
