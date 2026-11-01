# Provider error/reselection loops: route-veto fix

## Incident and layers

A read-only audit of October 28–November 1 (partial day) found 4,067 persisted assistant messages with `stopReason: error`, excluding temporary smoke workspaces. The longest sequence had 915 consecutive errors in roughly four minutes, including 914 rejections of the same unavailable model and repeated transitions through `pmr/balanced`. These are active retry/reselection loops, not proof of mutex deadlock.

Counts describe stored event occurrences, not unique user incidents or independently attested provider requests. Quoted errors in prompts/tool results were not counted. No raw session files, private identifiers or credential data accompany this report.

| Observed class | Error events | Fix boundary |
| --- | ---: | --- |
| HTTP 400 explicitly saying the model is unavailable | 2,608 | Semantic model-health classification, independent of status |
| Deprecated/not-found/unavailable 404/410 | 511 | Existing permanent route cooldown, including omitted unavailable wording |
| Quota/credits/rate limits | 347 | Existing scoped quota/wallet logic; preserve native account rotation |
| Codex native-turn protocol conflict | 319 | Upstream native-turn ownership; not blindly retried here |
| Expired authentication | 166 | Temporary failed-route veto; not a provider-wide credential ban |
| Network/DNS/connectivity | 61 | Temporary failed-route veto |
| Stream/socket termination | 52 | Includes seven retirement notices in partial failed output |
| Request thinking/effort incompatibility | 2 | Request-shape issue, not retirement or quota |
| Internal request-metadata incompatibility | 1 | Request-shape issue, not model health |

A separate 2,879 OpenRouter judge/control-plane 402 usage events were observed for `auto-thinking` and `find`. They are not main assistant errors and are not added to the table or attributed to the PMR main-model pick. Explicit thinking avoids the user's observed startup failure, but globally forcing high thinking is not part of this fix.

## Confirmed causes

1. `400 Upstream request failed: Model is unavailable.` and `404 The requested model is currently unavailable. Please choose a different model.` were not recognized as route failures. `recordFailure` updates timestamps but creates no health veto. Native fallback to a `pmr/*` role could consequently select the same route again.
2. The provider returned `Claude Sonnet 4.6 is no longer available. Please switch to Claude Sonnet 5.5.` as partial text, while `errorMessage` contained only `Cloud Code Assist stream ended without a finish reason (connection dropped or response truncated)`. PMR inspected only `errorMessage`, and its classifier also omitted that retirement wording.
3. Recording terminal errors does not continue a settled turn. Native OMP can decline replay after visible output. This is distinct from failing to exclude a bad route.

## Scope decision after independent review

An initial approach used the public OMP `session_stop` continuation hook. Independent review identified a manual-selection race: extension `setModel` awaits credentials/metadata before committing, and OMP 18.12.3 offers neither compare-and-set nor an extension-facing model-change event. A pending automatic switch could overwrite an intervening manual selection. A post-await current-model check cannot undo that violation safely.

The owner was offered a full OMP-core plus PMR solution or a PMR-only solution without automatic terminal resumption, and explicitly chose **PMR only, without automatic terminal resumption**. The new stop handler was removed entirely. No asynchronous terminal switching or extension-owned continuation ships in this change. Native OMP retains all continuation ownership; a terminal failure may still require the user to continue manually, but its failed route is excluded on the next routing pass.

## Hypotheses and alternatives

| Hypothesis | Verdict | Evidence |
| --- | --- | --- |
| Class ladder or comparator order is wrong | Disproved for this failure | A health veto excludes the route; all unfailed snapshot selections remain identical |
| Every HTTP 400 is a malformed request | Disproved | The dominant observed 400 explicitly says the model is unavailable |
| Recording a failure makes a route unavailable | Disproved | Store only records a timestamp; health needs `cooldownUntil` |
| A retirement notice is always in `errorMessage` | Disproved | The stream-wrapper case carries it in failed assistant text |
| A post-await model comparison protects manual selection during `setModel` | Disproved by review | The pending switch itself may overwrite the manual model before that comparison |
| A PMR-only health fix can safely implement universal terminal recovery | Rejected for this PR | Would require a stronger public model-switch contract in OMP |
| Jev credit errors mean the selected main route is exhausted | Disproved | Judge calls have separate purpose/provider attribution |
| All reported hangs are literal deadlocks | Not established | The largest incidents actively completed hundreds of failed attempts |

## Minimal fix boundary

- Recognize explicit model unavailability and retirement independently of provider and status.
- Preserve retirement text from the actual failed assistant only when its normalized display name identifies that failed model. Successful prose, user/tool messages and notices about other models are not retirement evidence.
- Reuse the existing 24-hour permanent-model route cooldown. Explicit `currently unavailable` is conservatively treated as a long-lived model rejection; this can exclude a recovered temporary model outage for a day, rather than immediately entering another selection loop.
- Recognized expired-key and transport failures receive a five-minute route cooldown. This is conservative: successful native recovery does not currently clear that timestamp immediately. No claim is made that every credential on the provider is expired.
- Apply non-quota vetoes before existing virtual native-fallback repair. Preserve zero-delay rate/quota credential rotation, independent scopes, paid-wallet/free-route handling, manual opt-out and remote-compaction protection.
- Terminal `agent_end` bookkeeping uses only an actual assistant result. Setup/control-plane events do not stamp the remembered current model as successful or failed.
- Add no session, branch, recursive prompt, stop-hook continuation, terminal model switch or retry-budget change.

## Reproduction matrix

`bun scripts/provider-error-recovery-probe.ts` exercises real OMP 18.12.3 processes, temporary profiles and loopback-only custom stream transports. It uses no credentials or paid inference. Explicit error streams avoid the OpenAI adapter treating a missing finish marker as an ordinary stop. Separate terminal attempts are driven by the probe, not by the extension.

| Scenario | Observed requests across probe runs | Expected result |
| --- | --- | --- |
| Installed baseline retirement partial stream | primary | Terminal failure, route not excluded |
| Patched retirement partial stream; then fresh attempt | primary, backup | First attempt remains terminal; persisted route veto sends next attempt elsewhere |
| HTTP 400 unavailable with native fallback; then fresh attempt | primary, backup, backup | Native OMP recovers; rejected route stays excluded |
| Expired API key with native fallback; then fresh attempt | primary, backup, backup | Failed route excluded; native backup retained |
| Ordinary partial stream failure; then fresh attempt | primary, backup | No automatic terminal replay; next attempt avoids failed route |
| Every registered route unavailable | primary, backup, third | Finite native fallback sequence; no route reselected |
| Manually selected concrete route | primary | No new PMR terminal switch or replay |
| Unknown request-schema failure | primary | No blind extension retry |

Unit regressions cover same-session next-turn and fresh-instance persistence, native alias repair, expired credentials, intervening manual selection, successful prose and control-plane attribution. Original user context markers are present in every local request.

## Differential replay and verification

Captured fresh model/usage/CodexBar/stats data locally, sanitized it with `scripts/sanitize-fixtures.py`, and inspected the removed-field-path report. CodexBar exited 1 with parseable per-provider results; the same results were used in both arms. This snapshot remains local and is not included in the PR.

All 24 tier/class selections and health for 1,246 normalized routes were identical before and after without a new runtime rejection. No ladder, ranking, economics or telemetry-source policy changed.

The full router, snapshot simulation, installation/bootstrap and bridge gates are run locally and reported in the PR. The bridge installation gate initially reported drift while other gates were concurrent; a separate deploy/check diagnostic and subsequent serial bridge gate passed. No bridge source was changed.

## Remaining upstream domains

- Terminal auto-resumption with safe manual-selection precedence needs an OMP-core conditional model-switch contract and is explicitly outside the owner-approved PMR-only scope.
- Request-schema defects, Codex `unsupported_native_inflight_message`, and setup-stage judge failure propagation need separate upstream repairs. Generic replay could repeat side effects or conceal the cause.
- Existing OMP processes retain loaded extension code until restarted; replacing files is not a hot patch. This PR does not restart other live user sessions.

Source contract inspected: [OMP v18.12.3 extension model switching](https://github.com/can1357/oh-my-pi/blob/v18.12.3/packages/coding-agent/src/extensibility/extensions/compact-handler.ts), [native turn recovery](https://github.com/can1357/oh-my-pi/blob/v18.12.3/packages/coding-agent/src/session/turn-recovery.ts), and [model controls](https://github.com/can1357/oh-my-pi/blob/v18.12.3/packages/coding-agent/src/session/model-controls.ts).
