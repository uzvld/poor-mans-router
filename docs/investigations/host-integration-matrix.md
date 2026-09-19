# Host integration — where the routing contract applies

**Date:** 2026-09-19. OMP 18.2.6, installed `adaptive-router`.
**Question:** the router is an in-process OMP *extension*. For each host the owner drives OMP with, does the opt-in contract (`router/*` today, `pmr/*` after the rename) actually govern model selection?

## Verdict

| Path | OMP agent session? | Router governs? | Evidence |
|---|---|---|---|
| `omp` directly (TUI / `-p`) | yes | **yes** | live: managed cold start switches and announces; manual sessions untouched |
| `multica → omp` | yes | **yes** | daemon log: `omp base_url=rpc-ui://omp model=cursor/cursor-grok-4.6`; live probe of the same argv shape below |
| `paseo → omp` | yes | **yes (by construction, live proof pending)** | `~/.paseo/*-daemon.log` carries stack frames from `/$bunfs/root/omp-darwin-arm64`, i.e. Paseo runs the OMP binary as an agent |
| `multica → hermes → omp` | **no** | **no** | Hermes uses OMP as a *model provider* over RPC (`~/.hermes/config.yaml`: `model.provider: omp`), through the bridge plugin `~/.hermes/plugins/model-providers/omp/`. No OMP agent process exists on this path, so no extension is loaded and `pmr/*` selectors do not exist for it. |

**Consequence to know:** agents that run through Hermes are routed by *Hermes'* model configuration, not by this router. Pointing a Hermes agent at `pmr/balanced` cannot work — the virtual models are registered by an extension inside an OMP agent process, and the bridge talks to OMP as a completion backend. If adaptive routing is wanted there, it has to live in Hermes' provider layer (or Hermes must spawn a real OMP agent session).

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

## Paseo path

Paseo runs the OMP binary (stack frames in its daemon log prove an OMP agent process, not a gateway call), so the extension loads and the contract applies. Still to capture as live proof: a Paseo agent configured with a virtual selector, showing the switch marker and the outgoing provider payload.

## Hermes bridge — separate concern

The bridge works (owner's report). What is **unverified** is translation fidelity between OMP's event stream and Hermes' OpenAI-shaped stream. Reading `~/.hermes/plugins/model-providers/omp/omp_rpc_client.py`:

- `text_delta → delta.content`, `thinking_delta → delta.reasoning_content` *and* `delta.reasoning` (both set to the same text);
- tool activity arrives as `tool_execution_start` / `tool_end` / `tool_call_start` events (lines ~209 and ~221) but **`delta.tool_calls` is hard-coded `None`** in both chunk builders — Hermes never receives structured tool calls on this path; OMP executes tools itself (the module header states it parses `<tool_call>` out of OMP text and does not run a second agent loop);
- the stream always closes with `finish_reason="stop"`, so truncation (`length`), tool-call stops and error terminations are indistinguishable downstream.

None of these are proven wrong — they are the exact places where a wrong mapping would hide. Tracked as its own roadmap item with a concrete test plan; it is a Hermes-side concern, not `adaptive-router` code.
