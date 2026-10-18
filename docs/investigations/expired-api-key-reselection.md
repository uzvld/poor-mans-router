# Expired API key repeatedly selected as available

Date: 2026-10-18. Layer: terminal provider error → persisted local health → ladder selection.

## Evidence and reproduction matrix

A recent OMP session repeatedly selected `opencode-go/glm-5.3-flash`, received
`401` with `authentication_error` / `api_key_expired`, then used native Anthropic
fallbacks that returned `429`. A direct selection of Codex Luna subsequently
produced assistant/tool responses. The later Codex
`unsupported_native_inflight_message` was a transport/turn-state error, not a quota
verdict. Session/account identifiers and raw provider responses are omitted.

| Reproduction | Before | After |
|---|---|---|
| Terminal expired-key error, then a fresh managed instance sharing state | Re-selects the failed route | Selects the alternative |
| Terminal invalid-key error, another model on the same provider | Re-selects the failed route | Sibling model remains eligible |
| Intermediate key rejection, native recovery, final successful response | Route remains eligible | Route remains eligible |
| Generic permission, signature, or request-body error | No auth cooldown | No auth cooldown |
| Cooldown elapsed | Route eligible | Route eligible |
| Two real OMP 18.11.0 processes, isolated state, localhost HTTP provider | `key → key`, both processes exit 1 | `key → backup`, exits 1 then 0 |

The native smoke captured the actual provider request bodies: the expected model
and user context reached both requests. The backup returned streamed assistant
content. The registered `/route-status` handler ran before the provider requests;
its output was saved to a file. The fixed second process reported the first route
as `COOLDOWN/FRESH` with `API key expired or invalid; update provider credentials`.
No live provider inference or real credentials were used. The credential-recovery
row is an event-harness regression, not a live multi-account rotation claim.

## Hypotheses and verdicts

| Hypothesis | Verdict | Evidence |
|---|---|---|
| Codex models were absent from the catalog | Disproved | Catalog contained Luna/Astra/Sol; direct Codex requests succeeded in the session |
| An active local Codex cooldown explained the inspected state | Disproved | Inspected persisted Codex entries had no active cooldown |
| Codex was below the configured reserve | Confirmed for the inspection-time snapshot only | Installed health replay returned `DRAINING`, reason `OMP quota within 10% reserve` |
| The expired OpenCode key was excluded after its 401 | Disproved | Its route had `lastFailureAt` but no cooldown and evaluated as `AVAILABLE/UNKNOWN` |
| A terminal key error was only recorded as a failure timestamp | Confirmed root cause | Both existing cooldown classifiers returned no result; `agent_end` used `recordFailure` |

The inspection-time reserve result does not reconstruct quota values at earlier
routing decisions. An absent telemetry report is not evidence that a known failed
key works.

## Minimal fix boundary

`health.ts` classifies a terminal `401` only when it explicitly identifies an
expired, invalid, or revoked API key. It creates a five-minute route cooldown with
a static, non-sensitive reason. `index.ts` applies this classifier only to the
last assistant error in `agent_end`.

There is no new auth handling in `auto_retry_start`: OMP retains ownership of
credential recovery. A final successful response does not classify earlier error
messages. The cooldown is not broadened to a provider or sibling models. This is
route-level failure learning, not credential-level inventory or disablement.
Generic `401`, `403`, request-signature errors, and resource permissions are not
classified as rejected API keys. After the cooldown expires the route is eligible
again, allowing a replaced key to be tried without deleting state.

No class order, `selectForTier` semantics, reserve percentage, credential store,
extra-credit spending, or reset-credit policy changed. The separate Codex native
inflight-message error is outside this fix.

## Verification

- RED: the expired-key and invalid-key reselection regressions both failed on the
  original implementation by selecting the rejected route again.
- GREEN: 20 error-turn tests passed with the fix.
- Mutation checks: removing the HTTP-status guard failed two permission/body
  regressions; removing the key-specific classifier failed the signature-error
  guard; applying auth cooldown during native retry failed the successful
  credential-recovery guard. All mutations were restored.
- Full router suite: 238 passed across 36 files. Snapshot simulation: 7 passed.
- Installer, bridge installer, and bootstrap integration suites passed.
- Bridge suites: 43 passed; launcher-wrapper integration suite passed.
- Fresh sanitized snapshot: 1,297 models, 1,201 routes, four tiers and 26 classes
  (30 decisions per scenario). Installed-before versus candidate on identical
  inputs: zero selection or health changes. Adding the observed expired-key
  failure changed only `opencode-go/glm-5.3-flash` from `AVAILABLE` to `COOLDOWN`;
  every selection matched the old selector with that failed route removed.
  At this snapshot none of the 30 winners changed.
- Fresh native-process smoke passed against the source and then the installed
  fix, with captured request payloads and saved `/route-status` output.

The two changed runtime modules were deployed under the installer's deployment
lock, with backups and installed/source SHA-256 equality checks. `health.ts` was
atomically replaced before `index.ts`; configuration and runtime state were not
rewritten. Existing long-lived OMP processes keep their loaded extension code and
must be restarted to execute this fix. Other agents were not interrupted.
