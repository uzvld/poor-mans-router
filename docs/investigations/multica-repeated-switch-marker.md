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

## Live proof (first fix)

Not performed before install. The first fix (`d3b888e`) was installed live at 14:43 (+02:00)
and the identical four-marker, zero-content reply recurred at 14:52 (Mr Janitor) and 14:57
(Jared). That is the follow-up below.

## Follow-up 2026-09-19 14:52 — the first fix did not hold

### Reproduction matrix

| # | Layer | Evidence | Verdict |
|---|---|---|---|
| G | Fix not installed | `md5` of live `~/.omp/agent/extensions/adaptive-router/{index,health,state,runtime}.ts` == repo HEAD `c4758a2`; install mtime 14:43, failures 14:52/14:57. | **DISPROVED** |
| H | `auto_retry_start` never fires for a 404 | 50 OMP processes in `~/.omp/logs/omp.2026-09-19.*.log` hit the trinity 404 today; **0** of them logged any `auto_retry_start`/`retry_fallback_applied`/fallback line. Every one goes `agent turn ended with provider error` → `agent_end maintenance routing stopReason=error` → `Session exit recorded`. OMP 18.2.6 `isRetryableError` (strings of the compiled binary): `if (n >= 400 && n < 500) return false` after the 408/429 check, and its non-retryable regex includes `not found`. The retry engine is never entered, so the handler the first fix hooked never runs. Its regression test synthesised an `auto_retry_start` 404 event OMP never emits. | **CONFIRMED — root cause 1** |
| I | `agent_end` records the error turn as a success | `index.ts` `agent_end` handler called `state.recordSuccess(key)` unconditionally; OMP delivers the full message list to extensions and the last assistant message carries `stopReason: "error"`, `errorMessage`, `errorStatus`, `provider`, `model` (`logProviderTurnError`, same object). Reproduced in-repo: after an error-turn `agent_end`, the dead route's record was `{lastSuccessAt, updatedAt}`. | **CONFIRMED — root cause 1, mechanism** |
| J | `state.json` last-writer-wins | `RouterStateStore.save()` wrote the whole in-memory `routes` map loaded once at `session_start`; every long-lived session saves on every `agent_end`. Live: no trinity entry at all despite 50 logged 404s, while the file's mtime moved every few minutes (14:58, 15:02, …) from unrelated sessions on `anthropic/*`. Would erase any cooldown fix H/I records. | **CONFIRMED — would defeat the fix** |
| K | `isPermanentModelError` length bound | Live loop with the fixed handler: `bytedance-seed/dola-seed-2.0-pro:free` 404d six times in a row and only got `lastFailureAt`. `/model.{0,40}(does not exist|not found)/` — the quoted id plus spaces is 41 chars. | **CONFIRMED — root cause 2** |
| L | Catalog drift is wide | `omp models --json` lists 52 `kilo/*:free` ids; Kilo's live `/api/gateway/models` serves 20; **32 are dead**, at least 5 of them rank above the first live free route. Multica gives a turn 4 fresh attempts. With a 15-minute cooldown that is one dead turn every 15 minutes, forever. | **CONFIRMED — why 15 min could not work** |

### Fix

- `extension/index.ts` `agent_end`: find the last assistant message; on `stopReason: "error"` classify `errorMessage` (permanent model error → cooldown; rate/quota → `cooldownFromRetry`; else `recordFailure`) and announce `[omp:pmr] <route> failed; cooled down <n> (<error>)` on the same notify channel as the switch marker. Never `recordSuccess` an error turn. Route key is taken from the message's own `provider`/`model`.
- `extension/state.ts` `save()`: re-read the file and merge per route, newest `updatedAt` wins (telemetry snapshot: newest `fetchedAt`); the `garbageCollect` sweep is remembered and re-applied after the merge so collected keys are not resurrected from a peer's older copy.
- `extension/health.ts`: `isPermanentModelError` anchors on the phrase, not a 40-char budget; `PERMANENT_MODEL_ERROR_COOLDOWN_MS` 15 min → 24 h (the store's GC window).
- `extension/runtime.ts`: `failureMarker`.

Tests (RED on `c4758a2`, GREEN after): `error-turn-cooldown.test.ts` (error-turn `agent_end` → cooldown, second process picks another route; unclassified error → failure without success stamp), `state-concurrent-save.test.ts` (stale peer save preserves the other process's cooldown; newer per-route record wins), `health.test.ts` (long quoted model ids). Full suite 121/121, `test:sim` 5/5.

### Live proof (this fix)

Run against the real Kilo gateway with the worktree extension only, isolated from the live install and its state (`omp -p --no-extensions -e <worktree>/extension/index.ts --model pmr/free "Reply with exactly: PONG"`), starting from `{"routes":{}}`:

```
attempt 1: 404 arcee-ai/trinity-large-preview:free       -> cooled 24h
attempt 2: 404 arcee-ai/trinity-large-thinking:free      -> cooled 24h
attempt 3: 404 baidu/cobuddy:free                        -> cooled 24h
attempt 4: 404 baidu/qianfan-ocr-fast:free               -> cooled 24h
attempt 5: 404 bytedance-seed/dola-seed-2.0-pro:free     -> cooled 24h
attempt 6: PONG   (kilo/cohere/north-mini-code:free, lastSuccessAt recorded)
next fresh process: PONG
```

Before fix K the loop sat on `dola-seed-2.0-pro:free` for 6 consecutive processes. Before fix H/I (= live `c4758a2`) it sat on `trinity-large-preview:free` for 50.

### Still open

- **B (bridge notify/content conflation)** — unchanged, still a human decision. The failure marker makes a marker-only turn *say why*, it does not make the bridge report it as an error.
- **Catalog drift (L)** — the router now learns dead routes one failed turn each and remembers them for a day. Filtering `kilo/*` candidates against Kilo's live `/api/gateway/models` up front would remove even those first failures, but that is a new telemetry source (`AGENTS.md` · must ask).
- **Multica's 4 attempts per turn** — each is a fresh OMP process; from a cold state the first turn after install still burns its 4 attempts on dead routes and fails once. Pre-warming the live `state.json` (run the loop above against the installed extension path once) avoids that.
