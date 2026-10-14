# BUG E — a `pmr/*` model re-selected mid-run aborts the turn

Status: **fixed in the working tree** (`extension/index.ts`), unit-tested and live-verified against OMP 18.10.2. **Not installed.** A second, independent leak path is documented at the end and is **not** fixed.

## Symptom

In Paseo, a turn that has been running for a while ends with the red notice `pmr: virtual model leaked to provider transport — this is a router bug; select a concrete model with /model`. The OMP session holds an assistant message on provider `pmr` with `stopReason: aborted` and the text "Interrupted by user". That is the N2 guard calling `ctx.abort()`.

## Root cause

Layer: `index.ts` wiring (event ordering). Telemetry, health, classes, the ladder and the comparator are not involved.

1. A client sends `set_agent_model` with a `pmr/*` id **while a turn is running**. Paseo's model picker does this. The selection is the documented opt-in (N4), so the client behaves as specified.
2. The router reconciled the session model only in `before_agent_start`, the start of a turn. A mid-run selection is not followed by another `before_agent_start`.
3. OMP reads the session model at the top of every agent-loop iteration. The next provider request is therefore issued with the virtual model, and the N2 guard aborts the turn.

## Evidence

### Who sets `pmr/*`

The Paseo daemon logs `session: set_agent_model_request` for each client model change. In two days (2026-10-12 to 2026-10-14) it logged six requests for a `pmr/*` model, all from the same relay client. Each one coincides within 8–11 ms with a `model_change` to the same model in the OMP session.

| UTC | Model | Session state | Outcome |
|---|---|---|---|
| 2026-10-12 19:14:50 | `pmr/small` | **running** | next request hit the guard, aborted 14.0 s later |
| 2026-10-13 15:01:39 | `pmr/balanced` | idle | next prompt: `before_agent_start` switched, 13.9 s later |
| 2026-10-13 16:28:50 | `pmr/frontier` | idle | switched 12.1 s later |
| 2026-10-13 17:27:46 | `pmr/balanced` | idle (after Stop) | switched 2.9 s later |
| 2026-10-14 16:08:07 | `pmr/balanced` | idle | switched 8.3 s later |
| 2026-10-14 16:14:23 | `pmr/balanced` | **running** | next request hit the guard, aborted 13.3 s later |

An idle selection is harmless: the next prompt runs `before_agent_start` and the router switches. Only a selection that arrives mid-run reaches the guard.

### What OMP does with a mid-run model change

Measured with `omp --mode rpc` and a throwaway probe extension that logged, per hook, `ctx.models.current()` and, for provider requests, `ctx.model` and the payload's model id. `set_model` was sent during the first tool execution. Two concrete models were used, so no virtual provider was involved. The "repair" column means the probe called `pi.setModel` back to the original model from that hook.

| Repair hook | Model of the next provider request | Verdict |
|---|---|---|
| none | the model set mid-run (read per iteration, not snapshotted per run) | the guard's view of the session model is correct |
| `turn_start` | the mid-run model | one request too late |
| `context` | the mid-run model | one request too late |
| `turn_end` | the repaired model | works, but the repair finishes after the request was issued in the trace: a race |
| `tool_result` | the repaired model | works, awaited to completion |

OMP captures the model for an iteration **before** `context` and `turn_start` run, which is why those two cannot help.

## Hypotheses

| # | Hypothesis | Verdict | Evidence |
|---|---|---|---|
| A | Auto-compaction leaves the session on a virtual model | **DISPROVED** | No compaction in the window of either mid-run incident (one session had none, the other its last compaction 50 minutes earlier). The five virtual switches that fell within ±2 minutes of a compaction in 21 days of sessions all ran normally. |
| B | The guard is a false positive because OMP snapshots the model per run | **DISPROVED** | After a mid-run `set_model` the next request's payload model and `ctx.model` are the new model. |
| C | The router itself selects a virtual model | **DISPROVED** | `currentRoutes` filters the virtual provider out; the router only calls `setModel` with concrete routes. Every `model_change` to `pmr/*` follows a client request by at most 11 ms. |
| D | A client re-selects `pmr/*` mid-run and no router hook runs before the next request | **CONFIRMED** | table above; live reproduction below |
| E | Repair from `turn_start` | **DISPROVED** | one request too late |
| F | Repair from `context` | **DISPROVED** | one request too late |
| G | Repair from `tool_result` | **CONFIRMED** | awaited; next request uses the repaired model |
| H | Repair from `turn_end` | **WORKS, RACY** | kept as the second line, never the only one |

## Alternatives rejected

- **Change the guard to inspect `ctx.model` instead of the session model.** Under hypothesis B this would be the minimal fix, but B is disproved: the guard is already correct.
- **Repair inside `before_provider_request`.** The payload for the virtual model is already built; spec §4 forbids it and nothing here changes that.
- **Fix it in Paseo.** The client selects a virtual model, which is the documented way to opt in. Refusing it mid-run would break the activation contract.

## Fix boundary

`extension/index.ts` only. The routing pass is extracted from `before_agent_start` into `routeSession`; `tool_result` and `turn_end` call it when, and only when, the current model is `pmr/*`. It reuses the same remote-compaction hold, `lastRouterSelected` bookkeeping and switch marker, and stays out of the way while a native retry owns the model. Nothing in `ranking.ts`, `policy.yml`, `health.ts` or telemetry changed. The N2 guard is unchanged and remains the backstop.

## Verification

- RED→GREEN: `midrun-virtual-repair.test.ts` had 5 red / 2 green before the fix, 7 green after. Full unit suite 225/225; `bun run test:sim` 7/7; `install.test.sh` and `bootstrap.test.sh` pass.
- Mutations: letting the repair act on a non-`pmr/*` current model turns the N1 mid-run test red; removing the `currentKey !== winner` check turns the existing affinity tests red.
- Differential: `before_agent_start` of the previous and the new `index.ts` produce identical `setModel` calls, notifications and return values for all four virtual modes and eight concrete start models.
- Live, OMP 18.10.2, RPC, copy of the real router state, probe registered before the router. Old router: the request after a mid-run `set_model pmr/balanced` is issued on `pmr/balanced` and the turn ends `aborted`. New router: the probe sees `pmr/balanced` at `tool_result`, `claude-sonnet-5-5` at `turn_end`, all four assistant messages are on `claude-sonnet-5-5`, the run ends `stop`.

## Not fixed: a second leak path

During live reproduction on a **fresh** router state a different failure appeared. Right after `before_agent_start` switched to a concrete route, OMP emitted `retry_fallback_applied` with the reason "Usage preflight: all eligible accounts are quota-exhausted or temporarily blocked" and moved the session back to `pmr/balanced` (the role's fallback chain). There was **no** `auto_retry_start`, and the first request hit the guard.

- Spec §6's virtual-fallback exception only runs inside `auto_retry_start`.
- No `tool_result` or `turn_end` occurs between that fallback and the request, so §4a cannot cover it.
- The same signature (`model_change` with role `fallback` to a `pmr/*` model, then `aborted` on provider `pmr`) appears in sessions on 2026-10-12 at 17:13 and 17:59 UTC.

This needs a design decision before any change: either stop the router from choosing a route that OMP's own preflight will reject, or find a hook that precedes the fallback.

## Independent review follow-up

A read-only review of the first version found no blocking issue and one real defect: parallel tool calls run their `tool_result` hooks concurrently and `pi.setModel` awaits credential lookups, so three parallel results made three `setModel` calls and three `[omp:pmr]` markers. The repair is now single-flight: concurrent callers share one in-flight promise and each awaits it. The review also showed that six realistic mutations (no-await handler, dropped `routingMode = mode`, dropped retry guard, always `balanced`, dropped try/catch, no single-flight) stayed green; each now turns a test red, including a `setModel` with real latency and a mode check through `/route-status`.
