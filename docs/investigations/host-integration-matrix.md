# Host integration — where the routing contract applies

**Date:** 2026-09-19. OMP 18.2.6, installed `adaptive-router`.
**Question:** the router is an in-process OMP *extension*. For each host the owner drives OMP with, does the opt-in contract (`router/*` today, `pmr/*` after the rename) actually govern model selection?

## Verdict

| Path | OMP agent session? | Router governs? | Evidence |
|---|---|---|---|
| `omp` directly (TUI / `-p`) | yes | **yes** | live: managed cold start switches and announces; manual sessions untouched |
| `multica → omp` | yes | **yes** | daemon log: `omp base_url=rpc-ui://omp model=cursor/cursor-grok-4.6`; live probe of the same argv shape below |
| `paseo → omp` | yes | **yes** | live: an agent started as `omp/pmr/balanced` was reported by Paseo as `omp/anthropic/claude-sonnet-5` after the router switched, and answered |
| `multica → hermes → omp` | yes (`omp --mode rpc-ui`) | **yes**, once Hermes' model is a `pmr/*` id | **Corrected 2026-09-19** — the earlier "cannot be governed" verdict was wrong. Extensions ARE loaded in `rpc-ui` mode: the bridge's own discovery returns `pmr/frontier|balanced|small|free`, `set_model('pmr/balanced')` is accepted, and `before_agent_start` switches the turn. Live: `hermes -z` printed `[omp:pmr] pmr/balanced -> anthropic/claude-sonnet-5 (available sonnet-sub; effective-cost=0.0000)` and answered. Probe: `tools/hermes-path-probe/probe.py`. |

**Why the first verdict was wrong:** it inferred "model provider over RPC ⇒ no agent process ⇒ no extension" from the bridge's architecture instead of probing it. `omp --mode rpc-ui` is a full agent host — it owns inference, tools and extensions; Hermes only consumes its event stream. The falsifying measurement is one call: `omp_models_probe.py` returns 1173 ids including all four `pmr/*` selectors, which only exist if `adaptiveRouter(pi)` ran `registerProvider('pmr')` inside that process.

**What the path still needs:** Hermes must *select* a `pmr/*` id. Two seams, only the first is required:

1. **Config (works today).** `~/.hermes/config.yaml` → `model.default: pmr/balanced`, `model.provider: omp`. Multica spawns a fresh `hermes acp` per task, so every new task picks it up with no restart.
2. **The ACP picker cannot list it (Hermes-side gap).** `acp_adapter/model_catalog.py::build_model_state` builds rows from `hermes_cli.inventory.build_models_payload` → `list_authenticated_providers`, which enumerates only *credentialed* providers. The `omp` profile declares `env_vars=()` ("owned by the OMP subprocess"), so no `omp` row is ever produced — measured: 0 `omp` rows at every filter combination (`explicit_only`/`include_unconfigured`, `refresh` on and off). The current model survives only via the fallback insert at `model_catalog.py:298-303`, which is why the picker shows `omp:pmr/balanced` as current but offers no other OMP model. Hermes has the precedent for the fix three lines above the call: `_local_runtime_row` (`hermes_cli/inventory.py:103`) injects the credential-less `llamacpp` row for exactly this reason.

**Second-order finding — the picker was also stale.** `~/.hermes/omp-rpc/models-cache.json` (30 min TTL, `plugins/model-providers/omp/__init__.py:24,106-150`) held a 06:30 snapshot of 1169 models, taken before the 09:58 install that registered the provider. Refreshed: 1173 models, all four `pmr/*` present.

## Multica path — live probe

Multica re-spawns OMP per run with the same session file and a `--model` (established in the BUG C investigation, daemon log confirms the `rpc-ui` transport and per-agent `model=`). Replaying that exact shape twice against one session file:

```bash
omp --mode json --session /tmp/mc-probe.jsonl --model router/balanced -p "Reply with exactly: MULTICA_SHAPE_OK"
omp --mode json --session /tmp/mc-probe.jsonl --model router/balanced -p "Reply with exactly: RESPAWN_OK"
```

```
run 1:  "provider":"anthropic","model":"claude-sonnet-5"   MULTICA_SHAPE_OK
run 2:  "provider":"anthropic","model":"claude-sonnet-5"   RESPAWN_OK
```

Both runs routed the virtual selector to a concrete model, and the second run — a fresh process resuming the same session — rebuilt managed mode from `ctx.models.current()` with no persisted routing state. That is invariant N3 holding across process boundaries, which is the property Multica needs.

Not yet checked on this path: whether Multica ever passes `--no-extensions` (the flag string exists in the binary). If it does for some runtime, the router is silently absent there.

## Paseo path — live probe

Paseo runs the OMP binary (stack frames in its daemon log prove an OMP agent process, not a gateway call), and `paseo run` accepts the selector directly:

```bash
paseo run --provider omp/pmr/balanced --background "Reply with exactly: PASEO_PMR_OK"
```

The agent answered, and `paseo ls --json` then reported it as:

```json
{ "name": "pmr-live-check", "provider": "omp/anthropic/claude-sonnet-5", "status": "idle" }
```

It was started as `omp/pmr/balanced` and Paseo reports the concrete model the router switched to — the contract holds end to end on this path, and Paseo's own UI reflects the switch. Probe agent deleted afterwards.

## Hermes bridge — separate concern

The bridge works (owner's report). What is **unverified** is translation fidelity between OMP's event stream and Hermes' OpenAI-shaped stream. Reading `~/.hermes/plugins/model-providers/omp/omp_rpc_client.py`:

- `text_delta → delta.content`, `thinking_delta → delta.reasoning_content` *and* `delta.reasoning` (both set to the same text);
- tool activity arrives as `tool_execution_start` / `tool_end` / `tool_call_start` events (lines ~209 and ~221) but **`delta.tool_calls` is hard-coded `None`** in both chunk builders — Hermes never receives structured tool calls on this path; OMP executes tools itself (the module header states it parses `<tool_call>` out of OMP text and does not run a second agent loop);
- the stream always closes with `finish_reason="stop"`, so truncation (`length`), tool-call stops and error terminations are indistinguishable downstream.

None of these are proven wrong — they are the exact places where a wrong mapping would hide. Tracked as its own roadmap item with a concrete test plan; it is a Hermes-side concern, not `adaptive-router` code.
