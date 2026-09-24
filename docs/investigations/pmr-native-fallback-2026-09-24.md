# PMR native fallback and unlearned credit exhaustion

Status: draft investigation; no production deployment or end-to-end recovery claim.

## Failure evidence

The reported symptom is two `pmr/balanced` agent failures whose reserve model led
back to Kilo. Diagnostic logs dated 2026-09-24 contain two errors at
09:29:09 and 09:29:11 (+02:00) for `kilo/qwen/qwen3.7-flash`:

```text
402 Add credits to continue, or switch to a free model
```

Other paid Kilo models also returned this error. These are confirmed gateway
failures; correspondence between those two log entries and the two user-reported
agent runs is not yet established. Raw logs, session contents and account data
are not included in this public report.

## Layers and hypothesis table

| Hypothesis | Evidence | Verdict |
|---|---|---|
| A terminal credit error is learned as a PMR cooldown | `health.ts:isRateOrQuotaError` does not recognize the observed wording; `index.ts:agent_end` consequently calls only `recordFailure` | Disproved for the observed error |
| PMR controls the native fallback target | `retry_fallback_applied` records a target already selected by OMP; `shouldRouteBeforeAgentStart` declines routing during native retries | Disproved |
| Replacing `retry.fallbackChains` through Settings is session-isolated | The installed-runtime probe shows policy inherited by a cloned Settings instance after parent release | Disproved |
| A global Kilo ban is required | A wallet error says to switch to a free model; invariant I6 preserves free routes on an empty paid wallet | Not justified |
| A network failure in the code-search tool proves a PMR routing failure | No corresponding route transition established | Not justified |

## Reproduction matrix

`bash scripts/native-fallback-probe.sh` was run against the installed OMP with an
empty environment and temporary agent directory. It made zero provider requests.

| Observation | Result |
|---|---|
| Native wildcard next candidate | `anthropic/claude-sonnet-5` |
| Exact-model override next candidate | `openai-codex/gpt-6-astra` |
| Inherited wildcard survives override | true |
| Child next candidate | `openai-codex/gpt-6-astra` |
| Parent next candidate after release | `anthropic/claude-sonnet-5` |
| Child next candidate after parent release | `openai-codex/gpt-6-astra` |
| Prior runtime override recovered after release | false |
| Provider requests | 0 |

This reproduces the integration limitation documented in `docs/design.md`, not a
successful live recovery. The baseline router suite passes 146 tests when macOS
AppleDouble sidecars are excluded.

## Minimal fix boundary

The credit-error learning defect is in terminal error classification and route
health. It must not be confused with selection of the native fallback candidate.
Learning a failed route alone cannot establish that an in-flight native fallback
will avoid that route, another paid model sharing its wallet, or the wrong tier.

The complete fallback fix requires a session-owned candidate policy consulted by
OMP before native preflight and retry selection. Native credential rotation,
context-fit checks, the 10% reserve, local cooldown vetoes, manual opt-out and
session history must remain intact. No global wildcard rewrite, shared Settings
override, ladder change or new SessionManager is an acceptable substitute.

The draft remains unready until that boundary is verified and both the failing
reproduction and end-to-end native recovery are exercised. Nothing has been
installed into running sessions.
