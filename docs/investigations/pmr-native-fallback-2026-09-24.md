# PMR native fallback and unlearned credit exhaustion

Status: implementation in draft PR #16, verified with OMP 18.2.10 and a localhost
provider. Not installed into live sessions. The broader native candidate-policy
limitation remains separate and unresolved.

## Failure evidence

The inspected failing sessions follow this chain:

```text
pmr/balanced -> paid Kilo model
402 Add credits to continue, or switch to a free model
native fallback -> pmr/balanced
virtual-provider guard -> local abort -> empty reply -> session exit
next process -> another paid Kilo model
```

Both the native fallback target and the local abort are recorded in the inspected
session/log evidence. A control session received the same Kilo error but fell back
to a concrete Anthropic model and continued. Raw logs, session contents, account
identifiers and credentials are not included in this public report.

Two defects combine; a third omission lets virtual models become candidates:

1. **Health classification / persistence:** the observed wallet wording did not
   match `isRateOrQuotaError`. Terminal `agent_end` recorded failure, not cooldown.
   Cooling only one model would still leave paid siblings on the same empty wallet.
2. **Index wiring / native continuation:** OMP's role chain can prepend its virtual
   `pmr/balanced` primary. PMR deliberately skips ordinary routing during native
   retries. The virtual transport guard correctly aborts this invalid target, but
   no earlier hook repaired it. The abort guard is not the bug.
3. **Candidate construction:** registered virtual `pmr/*` models were included in
   `currentRoutes`. Once paid routes are excluded, a virtual model can win a paid
   catch-all class instead of falling through to a real free route.

A 402 is not invariably retried: terminal and native-fallback event sequences both
exist. The fix must learn it through either `agent_end` or `auto_retry_start`.
Native fallback selectors also carry `:off`; matching failed-route ownership must
normalize that thinking suffix without stripping model variants such as `:free`.

## Hypothesis table and alternatives

| Hypothesis | Evidence | Verdict |
|---|---|---|
| The failed route already gets a cooldown | Original classifier misses the observed error; a fresh-process regression selects it again | Disproved |
| Every 402 bypasses native retry | Recorded native fallback to `pmr/balanced`; localhost OMP reproduction emits fallback and retry events | Disproved |
| The dying retry simply picked another concrete Kilo model | Inspected death transition is onto the virtual PMR primary, then local abort | Disproved as the immediate cause; paid siblings explain repeated fresh-process failures |
| A concrete native fallback is inherently broken | Control session continues on Anthropic; regression leaves a concrete fallback untouched | Disproved |
| Shared Settings overrides can safely repair this | Native settings/resolver probe reproduces inheritance into cloned settings and loss of a prior override | Disproved |
| Every native-candidate policy issue needs fixing to stop this abort | Awaited session-scoped `pi.setModel` during `auto_retry_start` repairs the virtual target before OMP continues | Disproved for this incident |
| All Kilo routes must be banned | Error explicitly permits a free model; free-wallet exemption passes and fails when mutated | Disproved |
| A request needing more credits proves an empty shared wallet | Request-size rejection regression keeps a paid sibling eligible | Disproved |
| Search-tool network failure proves PMR routing failure | No corresponding route transition established | Disproved |

## Minimal fix boundary

- Recognize explicit empty-wallet wording separately from generic payment or
  request-size failures. Apply the existing retry cooldown duration, not a new
  permanent provider blacklist.
- For an explicit empty-wallet rejection of a paid PAYG route, cool the provider's
  **known paid routes**. Preserve free routes and longer sibling cooldowns. Do not
  broaden a failed subscription route across independent credentials.
- Exclude virtual PMR models from routing candidates.
- Repair only a native fallback from the **router's own last pick** onto a virtual
  target that is still current, in an already-managed session. Preserve the original
  tier, not the tier named by the native role primary. Observe manual opt-out and
  the remote-compaction hold before switching.
- Use the existing session-scoped `pi.setModel(resolvedModel)`; OMP retains retry
  scheduling and the original conversation. A missing or unsafe replacement leaves
  the virtual transport guard fail-closed. Concrete native targets and credential
  rotation remain untouched.

No ladder, `selectForTier`, telemetry source, shared Settings, installed config,
new session or SessionManager changes. General native candidate-policy enforcement
still needs the upstream boundary described in `docs/design.md`.

## Reproduction matrix

| Scenario | Before / mutation | Current draft |
|---|---|---|
| Terminal wallet rejection, fresh balanced process | Repeats the paid route | Chooses an eligible alternative |
| Native `402 -> pmr/balanced` | Local abort; process exits 1 | Concrete recovery; process exits 0 |
| Same wallet, another paid model | Remains eligible when only the failed model is cooled | Paid sibling is skipped |
| Same wallet, free model | Would be vetoed by a provider-wide ban | Free route remains eligible |
| Frontier session receives virtual balanced fallback | Tier-adopting mutation picks balanced work | Original frontier tier retained |
| Manual opt-out / intervening selection / different failed route | Each ownership-removal mutation overwrites the protected state | No PMR recovery switch |
| Concrete native fallback | Virtual-target guard removal overrides native selection | Native target retained |
| Remote-compacted history, cross-provider replacement | Hold-removal mutation switches | Existing transport guard stays fail-closed |
| Sibling already has a 24-hour catalog cooldown | Wallet backoff could shorten it | Longer veto preserved |
| Request-size credit error / subscription failure | Broad-scope mutation blocks the sibling | Scope remains local |

### Real OMP smoke

Run from the repo root:

```bash
bun scripts/native-fallback-recovery-probe.ts
```

The retained probe registers two localhost providers, including two paid models
sharing the rejecting provider. It creates temporary config/state and two real
OMP processes, then removes those files. The first process receives the actual
HTTP 402 and native virtual fallback; the second reuses the learned route state.
Observed result on OMP 18.2.10:

```json
{
  "requests": ["paid", "backup", "backup"],
  "contextPreserved": true,
  "firstRun": "native virtual fallback recovered",
  "secondRun": "paid wallet avoided",
  "liveProviderRequests": 0
}
```

`contextPreserved` asserts that the original user prompt marker reached every
localhost provider payload, including the native continuation. It is not a claim
about replaying arbitrary remote-compacted history. Disabling virtual recovery in
an isolated source copy makes this same smoke fail on its first process; restoring
the current source passes. No real Kilo inference or live account rotation was
performed, and no installation or post-install `/route-status` proof is claimed.

The separate `bash scripts/native-fallback-probe.sh` still reproduces the general
Settings limitation: inherited wildcard survives; a cloned child retains the
parent's override after release; a prior runtime override is not recovered. That
probe exits before any provider request and is not recovery evidence.

## Verification

- Router: **157 pass, 0 fail**, 31 files, excluding AppleDouble sidecars.
- Snapshot simulation: **7 pass, 0 fail**.
- Install, bridge-install, bootstrap and launcher-wrapper gates: all pass in
  temporary targets. Bridge Python suites: **43 pass**.
- **15 isolated mutations**, each failing its intended guard: credit classifier,
  paid-wallet scope, free exemption, subscription scope, longer cooldown,
  virtual candidates, virtual recovery, `:off` normalization, intervening manual
  selection, fallback provenance, remote compaction, permanent manual opt-out,
  concrete native fallback, request-sized credit scope and original tier.
- Fresh sanitized snapshot differential: **1,133 input routes**, **1,129 concrete
  candidates**, all four tiers and every class (**24 decisions before an error,
  24 after wallet rejection**). Before learning the error: zero selection changes.
  After learning it: 536 known paid Kilo routes cooled; all **55 free Kilo routes**
  keep their prior health. Every changed selection previously used that wallet.

The seven expected post-error changes are: frontier's full ladder and
`strong-chinese`; balanced's full ladder, `chinese-flash-payg` and `best-available`;
small's full ladder and `cheap-flash`. Empty paid-only classes return no candidate;
full tiers continue through their unchanged ladders. The free tier does not change.
No unexplained selection flips.
