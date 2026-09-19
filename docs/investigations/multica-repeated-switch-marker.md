# Investigation: repeated `[omp:pmr]` switch marker, no answer (multica → hermes → omp → pmr/free)

**Date:** 2026-09-19
**Reported by:** live Multica screenshot — agent "Jared", session on `pmr/free`, replied to a
direct user question twice with four identical lines each:

```
[omp:pmr] pmr/free -> kilo/arcee-ai/trinity-large-preview:free (available best-free; effective-cost=0.0000)
```

No other content in either reply.

## Reproduction matrix

| # | Layer | Evidence | Verdict |
|---|---|---|---|
| A | Duplicate extension registration (two `before_agent_start` handlers firing per event) | Live `~/.omp/agent/config.yml` has zero `extensions:` entries (OMP scans the `extensions/` directory itself); `~/.omp/agent/extensions/` has exactly one `adaptive-router/` directory; live `index.ts`/`virtual-model.ts` diff byte-identical to this repo; `pi.on('before_agent_start', …)` called exactly once in the function body. 9 reinstalls in ~18h were each an atomic `rm -rf $DEST; mv $STAGING $DEST`, never additive. | **DISPROVED** |
| B | Bridge conflates router notify text with real assistant content | `hermes/omp-bridge/omp_rpc_client.py:249-278` (`_tool_activity_text`) returns any `extension_ui_request{method:"notify"}` message that starts with `[omp:` verbatim; both the streaming path (`:368-371`) and non-streaming path (`:730-733`) push that string into the **same** `text_parts`/`delta.content` buffer as real `text_delta` chunks, with no provenance tag. `OMPRuntime.turn()` (`hermes/omp-bridge/omp_adapter/runtime.py:163-169`) completes a turn as soon as OMP reports `agentInvoked: False` for the prompt, with zero requirement that any assistant content was ever produced. | **CONFIRMED as a contributing mechanism** — this is *why* a marker-only turn renders as if it were the whole answer instead of being visibly distinguished from one. Not touched by this fix; flagged below as a separate, larger decision. |
| C | Fail-closed guard (`before_provider_request`) aborts silently without ever cooling the route it aborted for | `extension/health.ts` `evaluateRouteHealth` only demotes a route once `local.cooldownUntil` is set; `recordFailure`/`markCooldown` were, before this fix, only called from the `auto_retry_start` handler — the guard's `ctx.abort()` never routed through it. | Real gap, closed as a defensive hardening (see Fix 1) — **not what triggered this specific incident** (the request did reach the real `kilo` provider; the virtual model never leaked to transport for this incident). |
| D | `auto_retry_start` never fires / crashes | `lastRetryFrom` is read and written throughout `extension/index.ts`'s `auto_retry_start`/`retry_fallback_applied`/`auto_retry_end` handlers but was **never declared** with `let`/`const`/`var` anywhere in `adaptiveRouter`'s closure. Every `auto_retry_start` event threw an uncaught `ReferenceError: lastRetryFrom is not defined` at `index.ts:369` (pre-fix line numbers), before any cooldown/failure bookkeeping ran. No existing test called this handler — `index-wiring.test.ts` only asserted it was *registered*, never invoked it — so the crash shipped undetected. | **CONFIRMED — root cause, part 1.** |
| E | Hard "model does not exist" provider errors are never cooldown-worthy | Live `~/.omp/logs/omp.2026-09-19.*.log`, 13:38:08.209: `provider=kilo model=arcee-ai/trinity-large-preview:free errorStatus=404 errorMessage="404 The requested model 'arcee-ai/trinity-large-preview:free' does not exist. …"`. `isRateOrQuotaError` (`health.ts:184-186`) only matches `429/rate-limit/quota/…` wording, so `rateOrQuota=false`; `retryRoutingPolicy` (`runtime.ts:85-109`) returns `markRouteCooldown: false` for any non-rate/quota message, on the documented assumption that OMP's native retry/fallback engine owns non-rate/quota failures. For a route whose model id is permanently gone from the provider's live catalog (while still listed in OMP's local model catalog), that assumption doesn't hold — nothing else ever runs `markCooldown`. Live `~/.omp/agent/extensions/adaptive-router/state.json` (`routes`, 6 entries) has **no key at all** for `kilo/arcee-ai/trinity-large-preview:free`, confirming zero bookkeeping ever happened for it. | **CONFIRMED — root cause, part 2.** |
| F | Multica spawns a fresh OMP process per attempt, and each fresh process re-derives the identical unpenalized winner | `index.ts` comment (`refreshLive`, unchanged): "Multica spawns a fresh OMP process per run." Live `~/.hermes/omp-rpc/sessions/`: 4 distinct OMP-side sessions all touched in the 13:20–13:38 window, `"Session exit recorded"` logged 24 times across them today. | **CONFIRMED** — this is why the identical marker repeats across *separate* replies instead of once per session; each process reads the same on-disk `state.json`, finds the route still unpenalized, re-derives the same "best-free" winner, and repeats. |

## Root cause (combined, D + E + F)

1. Kilo permanently removed/renamed `arcee-ai/trinity-large-preview:free`; the gateway hard-404s it while OMP's own model catalog still lists it.
2. `auto_retry_start` — the *only* place local failures are recorded — has been silently crashing on every invocation since `lastRetryFrom` was introduced without a declaration, so **no** retry-driven cooldown or failure has been recorded for any route through this path.
3. Even with the crash fixed, a hard "model does not exist" message was never classified as cooldown-worthy in the first place (only rate/quota wording was).
4. Multica spawns a fresh OMP process per turn/attempt; each one reads the same persisted, never-penalized route state, re-derives the identical "best-free" winner deterministically, announces `[omp:pmr] pmr/free -> …` again, hits the same 404, produces zero real content, and exits — repeating forever, invisibly (D above meant even the *existing* fallback-probing/alternate-route logic in `auto_retry_start` never ran either).
5. Because of B (bridge notify/content conflation), the only thing that reaches Multica for a marker-only, zero-content turn is the switch marker itself, rendered as if it were the model's answer — with no visible error explaining why.

## Fix

- **`extension/index.ts`**: declared the missing `lastRetryFrom` closure variable (pure crash fix — `auto_retry_start` could not run at all before this).
- **`extension/health.ts`**: added `isPermanentModelError` / `cooldownFromPermanentModelError` — classifies "model does not exist / not found / unknown model / invalid model id" provider errors and assigns a 15-minute cooldown, independent of the rate/quota-specific `delayMs`/native-fallback heuristics in `retryRoutingPolicy` (those heuristics exist to protect healthy same-provider credential rotation, which does not apply to a model that no longer exists).
- **`extension/index.ts`** `auto_retry_start` handler: classifies `permanentModelError` alongside `rateOrQuota` and cools the route down when either applies.
- **`extension/index.ts`** `before_provider_request` guard: now also records a cooldown for `lastRouterSelected` when it fires (defensive hardening — closes gap C so *any* future cause of a leaked virtual model also self-heals instead of repeating forever; not what triggered this specific incident).

Test: `extension/tests/hard-model-error-cooldown.test.ts` — reproduces the bug with two independent `adaptiveRouter(pi)` instances sharing one on-disk `state.json` (simulating two Multica-spawned OMP processes) and a 404 "model does not exist" `auto_retry_start` event between them. RED before the fix (second process re-selects the identical dead route); GREEN after.

Full suite: 114/114 (`bun test $(ls extension/tests/*.test.ts | grep -v '/\._')`), `bun run test:sim` (fixture/differential simulation) 4/4.

## Not fixed here — needs a human decision

**B (bridge notify/content conflation, `hermes/omp-bridge/omp_rpc_client.py`)** is a separate, larger-blast-radius issue: it affects every extension's notify markers for every provider on this bridge, not just `pmr`. Changing how a marker-only, zero-real-content turn is reported to Hermes (e.g. surfacing it as an explicit empty-completion/error condition instead of silently returning the marker text as `message.content`) is a turn-completion-semantics change outside `extension/`, and per this repo's contract that kind of change needs a human decision before implementation, not a silent patch alongside a router bug fix.

## Live proof

Not yet performed from this debug worktree — would require `scripts/install.sh` against the
live `~/.omp` install and triggering a real Multica turn against the (now cooled-down) dead
route. Held pending explicit go-ahead, since the live install is the production surface other
concurrent sessions are actively using.
