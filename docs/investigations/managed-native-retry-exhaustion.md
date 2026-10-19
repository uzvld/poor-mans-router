# Managed PMR stops after native fallback exhaustion

Date: 2026-10-19. Verified runtime: OMP 18.11.0.
Layer: native retry exhaustion → extension lifecycle → managed-session ownership.

## Incident and reproduction matrix

Recent Anthropic requests returned `429` with multi-hour retry hints. The native
`anthropic/*` chain selected another Sonnet, which also failed, and the original
user task stopped despite an eligible backup provider. Some observed agents were
explicitly created on Anthropic rather than `pmr/*`; their manual-mode behavior is
not evidence of managed recovery. A separate real-process reproduction established
that managed launches also stopped after native exhaustion.

| Scenario | Before | After |
|---|---|---|
| Managed PMR; native concrete fallback also returns 429 | Process exits 1; backup not requested | Same task completes on backup; exits 0 |
| Managed PMR; native chain has no fallback candidate | Process exits 1 | PMR walks its original tier and completes; exits 0 |
| Direct concrete-model launch with the same native chain | Native chain fails; exits 1 | Unchanged; PMR does not opt it in |
| Managed PMR; no eligible alternative remains | Stops with provider error | Still stops with provider error; no fake success |
| Native fallback succeeds | Next request can be mistaken for manual opt-out | Proven native descendants retain managed ownership |
| Native cooldown-expiry restore before next prompt, terminal stop or another native hop | Restored primary is mistaken for manual opt-out | Original ownership is recognized from native model-change provenance |
| Failed PMR switch followed by another user turn | Ownership is discarded and routing silently turns manual | Unchanged owned concrete route stays managed and can retry selection |
| Manual change, user interruption, partial output, failed switch or remote-compaction hold | Must remain safe | Recovery is vetoed |

`bun scripts/managed-retry-recovery-probe.ts` runs the first four rows through real
OMP processes with isolated configuration/state and localhost providers. Before
the failure an actual extension tool records one completed action. Request bodies
are inspected: the original task and completed tool result reach the backup, and
the action count remains exactly one in every scenario. The providers use a local
OpenAI-compatible transport with Anthropic/Codex-shaped model classes: this proves
OMP lifecycle, selection and context continuity, not live account availability or
provider-specific network compatibility. No live credentials or inference are used.

## Hypotheses and verdicts

| Hypothesis | Verdict | Evidence |
|---|---|---|
| The API-key cooldown fix also guarantees same-task continuation | Disproved | It only records a failed route for later selection; native retry can still end first |
| Managed PMR re-runs `before_agent_start` for every native retry | Disproved | Captured native event order runs it once before the retry chain |
| Existing virtual-fallback repair covers concrete native fallback | Disproved | `auto_retry_start` repair requires a target under `pmr/*` |
| `agent_end` cooldown bookkeeping restarts the stopped task | Disproved | That notification persists health but returns no native continuation control |
| Rewriting shared fallback settings is required | Disproved for terminal main-session recovery | OMP 18.11 exposes `session_stop` after native exhaustion with a bounded same-session continuation result |
| Concrete native fallback is always a manual selection | Disproved | `retry_fallback_applied` supplies explicit from/to provenance before retry continuation |
| A restored original selector can be accepted solely because it was once router-owned | Disproved | Manual re-selection of that same selector must remain an opt-out; native model-change role and fallback-resolution flag distinguish the cases |

## Native contract

Exact-version public sources:

- [AgentSession](https://unpkg.com/@oh-my-pi/pi-coding-agent@18.11.0/src/session/agent-session.ts), terminal maintenance and `#emitSessionStopEvent`.
- [Shared event types](https://unpkg.com/@oh-my-pi/pi-coding-agent@18.11.0/src/extensibility/shared-events.ts), `SessionStopEvent` and `SessionStopEventResult`.
- [Turn recovery](https://unpkg.com/@oh-my-pi/pi-coding-agent@18.11.0/src/session/turn-recovery.ts), native hop and primary restore model-change records.
- [Model controls](https://unpkg.com/@oh-my-pi/pi-coding-agent@18.11.0/src/session/model-controls.ts), explicit selections and reset of the active fallback record.

Native credential recovery and configured fallback finish first. On an eligible
terminal stop, OMP emits `session_stop` **before** the final `agent_end` extension
notification. A result of `continue: true` plus additional context queues a hidden
custom continuation in the same session/prompt lifecycle. It does not resend the
user prompt, create a SessionManager, branch history, or replay completed tools.
OMP retains its continuation cap and abort/generation checks. `decision: block`
would bypass that cap and is deliberately not used.

OMP 18.11 emits this hook only for main sessions, including independently launched
Paseo agents. Native task subprocesses (`agent.kind=sub`) do not emit it. The fix
does not claim stop-time recovery for that unsupported hook boundary. The general
session-owned candidate-policy lease discussed in `docs/design.md` remains a
separate boundary for authoritative preflight/native-chain policy.

## Minimal fix

1. Track native fallback descendants only when `from` is the current router-owned
   chain and `to` matches the actual session model. Do not broaden ownership from
   arbitrary provider/model identities. Native concrete fallback still gets its
   own chance while retry is active.
2. Preserve this provenance through retry completion. A successful native fallback
   is not a manual opt-out on the next request. Real manual opt-out remains sticky.
   The latest branch model-change entry must identify the owned model and native
   role. A hop sets `resolvedModelIsFallback: true`; a restore to the original
   pick does not. For a new hop, inspect provenance immediately before its
   already-appended target entry. No matching native provenance means no adoption.
   A failed PMR switch retains ownership if the concrete model did not change.
3. In `session_stop`, require managed mode, no active native retry, a live signal,
   and an empty classified final assistant error on the owned current model.
   Do not continue partial text/tool calls or unclassified request errors.
4. Learn the terminal cooldown before selecting: final `agent_end` has not notified
   the extension yet. Use the existing class ladder, reserve, original tier,
   paid-wallet scoping, and remote-compaction guard.
5. Request native continuation only after the replacement actually lands. A failed
   switch, cancellation, a changed mode, a hold, or no eligible route returns no
   continuation. No shared settings or credentials are changed.

Generic upstream 5xx, overload and network failures without a recognized
rate/quota, unavailable-model or explicit API-key rejection are not reclassified
as quota exhaustion. They do not trigger this terminal recovery path.

## Verification

- Five new consumer-visible regressions were RED on the prior implementation:
  exhausted concrete fallback, no native retry event, multiple concrete hops,
  original-tier preservation, and next-request ownership after native success.
- All 47 error-turn regressions pass. Full router suite: 265 passed across 36 files.
  Snapshot simulation: 7 passed.
- Mutation checks caught removed liveness guards (three failures), ownership guard
  (one), partial-output guard (one), and actual-switch-success guard (one). All
  mutations were restored.
- Two independent reviewers found failed-switch ownership loss and native-primary
  restore opt-out. Both were reproduced RED and corrected. The three restore
  boundaries and explicit manual re-selection of the native descendant were RED
  before the provenance fix; original-model manual re-selection remains protected.
  Additional mutation checks removing native-role provenance and the
  remote-compaction hold produced three expected failures; mutations were restored.
- New native smoke is RED before the fix and GREEN afterwards for both managed
  recovery cases; manual and no-alternative cases remain errors. Original task and
  completed work survive; the tool executes once.
  The empty-chain case removes the second native model from the inventory and
  asserts zero `retry_fallback_applied` events. Captured model-change entries also
  prove PMR's own switches use `role: default`, not native fallback provenance.
- Existing native virtual-fallback recovery probe still passes.
- Installer, bridge installer, bootstrap, bridge unit (43 tests), and launcher
  integration gates pass.
- A fresh sanitized snapshot compares 1,297 models, 1,197 concrete routes, four
  tiers and 26 classes (30 decisions): zero selection, health or derived-ladder
  changes against the installed baseline on identical inputs. The change is
  terminal lifecycle continuation, not class selection policy.
- The reviewed `index.ts` was atomically deployed under the deployment lock, with
  the prior file backed up and configuration/runtime state untouched. Installed
  SHA-256 matches source:
  `b358e85b45d5264ddde245386e965cd9070045e14f1ef9ce60e913615f3e6c36`.
  Fresh OMP processes loading the installed copy pass the four native scenarios;
  request summaries and `/route-status` are saved locally in
  `tmp/managed-recovery/native-installed.json`. Existing running agents were not
  interrupted and require a restart to load the new code.
