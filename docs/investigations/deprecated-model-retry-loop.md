# Deprecated model retry loop (2026-10-28)

## Incident and layer

A managed OMP 18.12.3 session produced 143 HTTP 410 errors for
`opencode-go/minimax-m3.1-flash-free` between 10:30:43 and 10:31:25 UTC.
The error was:

```text
410 Model minimax-m3.1-flash-free has been deprecated.
Model minimax-m3.1-flash-free has been deprecated. (type=ModelDeprecated)
```

An initial Kilo request had returned `402 Add credits to continue, or switch to a
free model`. The repeating part was the deprecated MiniMax route, not Kilo:

```text
MiniMax request → 410 → native fallback to pmr/balanced
  → PMR repairs the virtual fallback by selecting MiniMax again → 410 → …
```

This was a **livelock**, not a mutual lock wait. The native session journal records
repeated model changes and failed requests. It later records a switch to Codex
and successful tool execution. No daemon restart was necessary for that recovery.

Root-cause layer: **provider error → local health classification**.
`isPermanentModelError()` recognized missing/unknown model errors but not
`Model <id> has been deprecated`. Replaying the exact error against the installed
module returned `permanent=false`, `rateOrQuota=false`, and no cooldown from either
error helper. `auto_retry_start` therefore recorded a failure without a cooldown;
virtual-fallback recovery could select the same still-eligible route immediately.

## Hypotheses and alternatives

| Hypothesis | Verdict | Evidence |
| --- | --- | --- |
| Agent tools or daemon locks are mutually blocked | Disproved for this incident | 143 completed provider errors and model transitions, followed by tool execution |
| Kilo's empty paid wallet is the repeating failure | Disproved | One Kilo 402, followed by 143 OpenCode 410 errors |
| A transient quota error needs a longer retry delay | Disproved | Provider explicitly reports `ModelDeprecated`, not quota/rate exhaustion |
| Deprecated model rejection never creates a local cooldown | Confirmed | Installed helper replay returns no cooldown; regression selects the same failed route before the fix |
| Class order or in-class comparator needs changing | Disproved | The same routing logic selects a backup once the rejected route has a cooldown |

## Minimal fix boundary

Recognize the observed `Model <id> has been deprecated` verdict as an existing
permanent-model error. Require the verdict immediately after the model id, rather
than matching arbitrary `deprecated` text. A deprecated request parameter, a future
retirement warning, or a deprecated file must not cool a model route.

Reuse the existing 24-hour **per-route** cooldown and fallback repair. Do not change
ladders, selection semantics, telemetry sources, retry budgets, manual activation,
provider-wide wallet handling, or credential rotation. A bare HTTP 410 is not enough
to identify a retired model.

## Reproduction matrix

| Scenario | Before | After |
| --- | --- | --- |
| Exact live 410 error through health helpers | No cooldown | Existing 24-hour permanent-model cooldown |
| Managed `retired → pmr/balanced` native fallback with zero delay | Retired route selected again | Backup selected before the next request |
| Next turn and fresh extension instance sharing scratch state | Failed route remains eligible | Backup retained; cooldown persists |
| Parameter deprecation / future retirement / file deprecation | No permanent cooldown | Unchanged |
| Two real OMP processes with localhost rejection and backup transports | Original incident demonstrates repeated requests | Requests: rejected route, backup, backup; original task context preserved |

Regression commands, from `extension/`:

```sh
bun test tests/health.test.ts tests/error-turn-cooldown.test.ts
```

The exact-error classifier and same-run retry tests were observed red on the old
implementation and green on the fix. Replacing the narrow predicate with a broad
`deprecated` match made the negative classification guard fail; restoring the
predicate returned the suite to green.

## Differential replay

Captured fresh `omp usage --redact --json`, `omp models --json`, `omp stats --json`
and `codexbar usage --provider all --format json`. Ran all four through
`scripts/sanitize-fixtures.py` in a temporary evidence directory and inspected its
removed-field-path report. CodexBar returned exit 1 with parseable per-provider
results; those results, including unavailable-provider entries, were used in both
arms. No raw machine output is committed.

On the same 1331-model snapshot, compared every tier and each class separately
(24 selections, including the free tier). Without a new provider error, all
normalized routes and all selections were identical. Applying the exact rejection
changed only the MiniMax route's health to `COOLDOWN`:

| Selection | Before learning the 410 | After learning the 410 |
| --- | --- | --- |
| balanced; balanced/chinese-flash-payg | opencode-go/minimax-m3.1-flash-free | opencode-go/deepseek-v4-flash |
| small; small/cheap-flash | opencode-go/minimax-m3.1-flash-free | opencode-go/mimo-v2.6-flash |

Every other selection was unchanged. The snapshot's economics put the rejected
route in those classes despite its `-free` name; this fix does not reclassify it.

## Runtime and local gates

Installed into a **temporary OMP profile**, not the user's live profile. All 15
installed source/config hashes matched the candidate. Two fresh OMP processes
against localhost exercised the real native fallback and PMR hooks. The first
escaped the 410; the second avoided the persisted failed route. Captured provider
request order `paid, backup, backup`, preserved original user context, and saved
`/route-status` output showing the rejected route as `COOLDOWN/FRESH` and the backup
selected. No live provider inference, credentials, shared configuration, or running
user sessions were used or changed.

Candidate `health.ts` SHA-256:
`c8168ea33fb3d5ac3073a4ad2a80f9b28419de772164a0ba372df98195279ae0`.

Local gates: 234 router tests, 7 snapshot simulation tests, 43 bridge unit tests,
installation, bridge installation, bootstrap, and launcher-wrapper shell suites
passed. The bridge was not modified or deployed.
