# Provider-error route-veto implementation plan

**Goal:** prevent repeated selection of rejected routes across providers while leaving all continuation to native OMP.

**Approved boundary:** independent review found a pending `setModel` race in an initial terminal-stop continuation approach. OMP 18.12.3 has no public conditional switch/cancellation contract that can prevent it overwriting an intervening manual model selection. The owner explicitly chose **PMR only, without automatic terminal resumption**, rather than extending OMP core. The unsafe stop-hook approach is removed, not waived.

**Architecture:** retain telemetry → health → classes → ladder → comparator. Extract provider failure evidence from the actual failed assistant; supplement the generic stream error only with an explicit retirement notice identifying that same model. Apply health vetoes before existing virtual native-fallback repair and in terminal error bookkeeping. Native OMP alone retries/continues the turn.

## Constraints

- Preserve every AGENTS invariant. No ladder, ranking, economics, activation or telemetry-source change.
- No credential reads, shared configuration rewrites, new sessions/branches, recursive prompts, new retry loop or terminal `setModel` call.
- Judge/control-plane errors are not failures of the selected main model.
- Successful prose and unrelated partial model notices never become retirement evidence.
- Known request-shape and native-turn protocol errors are not reinterpreted as temporary route outages.
- Expired credentials create only a route-scoped temporary veto; one key does not prove every credential is unusable.

## Work and verification

1. Add failing regressions for semantic HTTP 400/404 model unavailability, failed-stream retirement text, unrelated notices and expired credentials.
2. Add narrow failure extraction/classification; reuse existing 24-hour permanent-model and five-minute temporary route cooldowns. Preserve zero-delay quota credential rotation.
3. Verify existing native virtual fallback cannot reselect the rejected route. Terminal failures must remain terminal, while both the next turn and fresh process avoid the persisted failed route.
4. Exercise seven scenarios in real isolated OMP processes using custom loopback-only error streams, native fallback, persisted route state and original request-context markers. No paid inference.
5. Compare all 24 tier/class selections on the same sanitized snapshot, run full router/simulation/install/bridge gates, and kill representative guard mutations.
6. Re-review the narrowed stable diff with the independent subagent. Document the incident taxonomy, exact accepted scope and remaining upstream failure domains. Scan and publish a PR with Secret-Scan attestation.

## Separate upstream findings

The incident audit also found Codex native-turn protocol errors and judge 402s. A PMR health fix cannot repair those boundaries. Do not claim the approved route-veto fix automatically resumes every terminal error or changes OMP core.
