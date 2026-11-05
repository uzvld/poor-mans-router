# Repeated 401, then `virtual model leaked`: sibling models on a dead key

Date: 2026-11-05. Verified runtime: OMP 18.12.3.
Layer: `index.ts` wiring (failure bookkeeping) ← OMP auth pool (credential blocks and health).
Telemetry, health classes, the ladder and the in-class comparator are not involved.

## Incident

A managed `pmr/balanced` session (Paseo) showed, in order:

1. `opencode-go/deepseek-v4.1-flash` failed: `401 This API key has expired`.
2. OMP applied its native fallback to the role primary `pmr/balanced`.
3. PMR repaired that virtual fallback by selecting `opencode-go/glm-5.3-flash`, a sibling
   model served by the **same** stored key.
4. OMP's usage preflight refused that sibling and fell back to `pmr/balanced` again.
5. The leak guard aborted the turn: `pmr: virtual model leaked to provider transport`.
   The next user message hit the same path.

The session transcript confirms steps 1 to 5 (model changes and a `401` assistant error,
then two aborted turns on provider `pmr`).

## Reproduction

`bun scripts/provider-auth-recovery-probe.ts` runs a real OMP process in a disposable
profile: OMP's built-in `openai-completions` transport, its stored login-key resolver,
its `opencode-go` usage parser and its retry/fallback driver. Keys are synthetic and
every request goes to loopback (the probe extension throws on any other host and refuses
to run outside the profile its driver creates).

| Scenario | Router | Requests (provider, credential) | Exit |
|---|---|---|---|
| One key, expired | baseline (`main`) | `opencode-go` expired → *no further request* | turn ends on a leaked virtual model |
| One key, expired | this change | `opencode-go` expired → `rescue` | 0, task completed |
| Two keys, one expired | baseline | `opencode-go` expired → `opencode-go` healthy | 0 |
| Two keys, one expired | this change | `opencode-go` expired → `opencode-go` healthy | 0, key never abandoned |

The baseline trace for the first row reproduces the incident exactly: native fallback
reason `401 … has expired`, then PMR selects the sibling, then a second
`retry_fallback_applied` whose reason is `Usage preflight: all eligible accounts are
quota-exhausted or temporarily blocked … No request was sent to the source model`, then a
request on `pmr/balanced`.

## Hypotheses

| # | Hypothesis | Verdict | Evidence |
|---|---|---|---|
| 1 | The 401 cooldown is provider-wide | Disproved | It is route-scoped, five minutes (`health.ts` `cooldownFromProviderError`); the sibling stays `AVAILABLE` |
| 2 | OMP's retry events say which credential failed | Disproved | `auto_retry_start` carries `attempt/maxAttempts/delayMs/errorMessage`; `retry_fallback_applied` carries `from/to/role/reason`. No credential id |
| 3 | `/usage`, CodexBar or cswap can show this provider is dead | Disproved for this provider | `omp usage` reports the account as `no usage data`; CodexBar returns HTTP 500; cswap manages Claude Code accounts only |
| 4 | OMP's auth pool knows | **Confirmed** | After a hard 401, OMP records an `auth`-scope block on that credential and `health.model` reports it `depleted`; the probe traces show both |
| 5 | `virtual model leaked` is an independent router bug | Disproved | It follows selecting a route OMP's own preflight refuses (step 4); the same sequence disappears when PMR does not select the sibling |
| 6 | Ban the whole provider on any 401 | Rejected | Would disable a working second key (row 3 of the matrix) |
| 7 | Resume the task from `session_stop` after a terminal 401 | Rejected | Owner decision of 2026-11-01 (manual-selection race); not reintroduced |

## Fix boundary

`extension/index.ts` only (plus the shared credential-rejection matcher in `health.ts`).

- A credential rejection still cools the **failed route** for five minutes, unchanged.
- It also cools the provider's other routes for the same five minutes **only if** OMP reports,
  right then, that the pool it would use for this provider is entirely unusable:
  every credential has a live `auth` block **and** `health.model` returns `depleted`
  with exactly that set of accounts, the pool generation did not move during the check,
  and the answer arrived within 250 ms.
- Anything else fails open to the old behaviour: unknown key source (environment, config,
  runtime key), disabled or unreadable rows, an unblocked sibling credential, a pool that mixes
  OAuth accounts with a login API key (OMP can fall through from one to the other), partial,
  contradictory or slow health, a stale generation or key source.
- Only row ids, kinds and states are read. No key material is read, stored or logged; the
  persisted reason for a widened cooldown is a fixed string.
- Not widened for non-credential errors (transport, 429, permanent-model), whatever the pool says.

## Verification

- Regressions in `provider-error-routing.test.ts` (29 tests in the file): widening on a fully
  blocked pool (also in a fresh process) and on a fully blocked OAuth pool; no widening with a
  usable second credential, with no auth storage, or for a transport failure; the terminal
  `agent_end` path; and one case per fact the proof rests on (fifteen inconclusive pools: a
  usage-scope block, an expired block, a block for another credential kind, health reporting
  healthy / reserve / an unknown aggregate / contradictory or foreign accounts, a pool or key
  source that changed mid-check, a disabled row, duplicate ids, a non-managed key source, a mixed
  OAuth + API-key pool; plus a health call that never answers). Two were red on `main` for the
  right reason.
- Sixteen single-guard mutations of `authBlockedUntil` and `widenCredentialCooldown` on a copy,
  all caught by at least one test: generation check, block scope, block credential kind, block
  expiry, aggregate health state, account kind, account state, login-key filter, duplicate-id
  check, disabled-row check, key-source re-check, pool-size check, mixed-pool guard, the 250 ms
  bound, the credential-rejection gate, and the whole pool proof. Separately: credential rejection
  no longer cooling the failed route (5 red) and the Codex rule reverted (1 red). A first round
  left two guards (aggregate state, pool size) with no isolating case; they were added.
- Probe: red on `main` (assertion on the missing rescue request), green with this change.
- Differential replay on a freshly captured, sanitised snapshot (1,255 routes, 24 tier/class
  decisions): one selection changed (see the Codex section), nothing else.

## Related change: Codex `warning` at 100%

OMP marks a Codex plan window at 100% as `warning` (not `exhausted`) when requests are still
permitted, which includes paid-credit overage (`openai-codex.ts` `buildUsageStatus` /
`buildPlanMeterState`). PMR treated `remainingFraction <= 0` as exhausted and put every
Codex route in `COOLDOWN` while Codex answered normally.

The owner explicitly authorised spending Codex credits on 2026-11-05. Codex `warning` is now
`DRAINING`. `exhausted` and a local 429 stay hard vetoes. Replay: eight `openai-codex` routes
change `COOLDOWN` → `DRAINING`; the only changed class winner is `balanced/luna-sub`
(none → `openai-codex/gpt-6-luna`).

`pmr/frontier` does not select `DRAINING` routes (`allowDrainingForTier`), so Codex credits stay
out of reach there. Changing that is a policy decision and is not made here. `AGENTS.md` I3 is
left as written; this paragraph is the record of the exception.

## Not fixed

- An OMP usage preflight can still return a session to `pmr/*` for reasons other than a dead key
  (reserve fail-closed, plan ineligibility). Repairing it from `retry_fallback_applied` would need
  an awaited `setModel` with no compare-and-set, the race already rejected for terminal recovery.
- A replaced key is picked up after the five-minute cooldown, as before. OMP's own `auth` block
  is shorter (about one minute); it does not shorten the router's cooldown.
- Credentials that are not login-stored (environment, config, runtime) give OMP no pool to
  inspect, so only the failed route is cooled there.

## Review

Two independent read-only reviews. The first, of an earlier design (a selection-time hint that
dropped the five-minute route cooldown), found that it left a failed route unvetoed whenever OMP
gave no pool evidence, an over-broad `401` text match, and a probe extension that would seed
credentials into any profile. The design above replaces it: the route cooldown is kept, and the
text match is the existing expired/invalid/revoked wording.

The second, of this design, found no critical defect and reported: guards without an isolating
test (fixed, see Verification), a probe isolation check on unresolved strings (now resolved paths,
no named profile, and a TMPDIR that is or contains the real home is refused; five bypasses
tried, all refused), the mixed OAuth + API-key pool (now fails open), and an unguarded exception
path in the widening step (now caught, so a failure there cannot skip the state save or the
virtual-fallback repair). Left as documented limits: the five-minute widened cooldown outlasts
OMP's one-minute `auth` block, so a key replaced after a failure is used once it expires.
