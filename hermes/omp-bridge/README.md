# omp — Oh My Pi thin-host plugin

Hermes hosts the already-installed `omp` binary the same way Paseo/Multica do:
`omp --mode rpc-ui`. OMP owns Cursor/OpenCode models, tools, MCP, skills and
`~/.omp` auth. Hermes only streams the turn.

## Layout

```
~/.hermes/plugins/model-providers/omp/
├── plugin.yaml
├── __init__.py              # registers provider `omp` (rpc-ui) and `omp-acp`
├── omp_rpc_client.py        # thin-host OpenAI facade
├── hermes_memory_mcp.py     # Hermes memory as a stdio MCP server (the write path)
├── omp_adapter/             # transport, mapping, runtime
├── reapply_omp_patches.py   # Hermes checkout overlays (picker / known provider / agent handle)
├── hermes-launcher.sh       # ~/.local/bin/hermes wrapper: re-integrates after `hermes update`
├── test_thin_host.py
├── test_model_pin.py
├── test_tool_rail.py
├── test_stream_fidelity.py
├── test_launcher_wrapper.sh
└── test_hermes_memory_mcp.py
```

A `hermes update` overwrites the checkout: every overlay in `reapply_omp_patches.py`
is wiped, and the desktop app is then rebuilt from those unpatched sources. On
2026-09-19 all 15 overlays were missing and the model picker had silently lost every
OMP model — the ACP catalog was down to a single current-model fallback row.

A hook inside the checkout cannot repair this: it is deleted before it could run.
`hermes-launcher.sh` therefore lives here and is installed over `~/.local/bin/hermes`,
outside the replaced tree:

```
install -m 755 ~/.hermes/plugins/model-providers/omp/hermes-launcher.sh ~/.local/bin/hermes
```

It execs straight through for everything except `hermes update`; after an update it
reapplies the overlays, rebuilds the Electron app only when a renderer overlay was
re-applied, and keeps the update's own exit code. Verify by hand at any time:

```
python3 ~/.hermes/plugins/model-providers/omp/reapply_omp_patches.py --check
```

Core edits still need a gateway restart (`hermes gateway restart`).

## Behaviour

- Nested model ids stay native: `anthropic/claude-haiku-4.5`, `opencode-go/...`
- Hermes tools are not injected into OMP. OMP's own tool activity is reported on
  Hermes' tool rail (`agent.tool_progress_callback` → ACP tool calls for Multica,
  tool cards in the desktop) via the `wants_agent_handle` opt-in; `delta.tool_calls`
  stays `None`, so Hermes never re-executes finished work. Without the agent handle
  (CLI one-shot) the same activity degrades to `[omp:<tool>]` text markers
- `finish_reason` reflects OMP's `stopReason` (`max_tokens`/`truncated` → `length`,
  `tool_use` → `tool_calls`); an aborted/errored turn raises instead of closing as a
  completed answer, and a streaming failure surfaces as an error rather than an empty
  stream
- The `omp` row reads as a nested-provider catalog: all 700+ routes stay in the
  picker by default, and each row is labelled with the provider serving it
  (`OpenRouter`, `OpenCode Go`) — without that, the backend's
  5-per-lab `featured_models` shortlist showed 28 of 673 families and
  `openrouter/deepseek/deepseek-v4.1-flash` was indistinguishable from
  `opencode-go/deepseek-v4.1-flash`
- Picker caps are skipped for the `omp` row: the ACP catalog that Paseo/Multica's
  `hermes` runtime reads (`hermes acp` → `session/new`) capped it at
  `ACP_MAX_MODELS_PER_PROVIDER = 200`, which dropped `opencode-go` entirely and
  470 of openrouter's 526 ids. All 717 now reach `availableModels`
- Approvals default to `--approval-mode yolo` (override with `OMP_APPROVAL_MODE=always-ask|write|yolo`)
- Session leases key on Hermes session id, so chat + cron in one cwd do not collide
- A cold `--resume` turn is sent as `prompt`, never `follow_up`: with no live
  agent in the process OMP acks a follow_up and emits nothing, which stalled the
  turn to its timeout and reached the user as an empty reply
- Hermes memory (`~/.hermes/memories/MEMORY.md` + `USER.md` — the same blocks Hermes
  puts in its own system prompt) is prepended to every turn sent to OMP under a
  `[Hermes memory …]` marker, so squad agents routed multica → hermes → omp see it;
  an unreadable store just omits the block
- OMP agents can **write** that memory back through `hermes_memory_mcp.py` (see below)
- Auxiliary Hermes tasks (title/compression/vision) are refused: they are not LLM calls and used to spawn a second omp that held the lease (`[Errno 35]`)
- Multiple Hermes clients in one session share one omp subprocess (stream requests used to each spawn their own)
- Broken MCP `oh-my-pi` (`/opt/homebrew/bin/node`) is disabled; use this provider instead

## Memory write path (MCP)

`hermes_memory_mcp.py` serves the same `MemoryStore` Hermes itself uses, so char
caps, the injection scan, dedupe, the external-drift guard and atomic writes all
still apply; Hermes' approval staging is deliberately bypassed (an OMP agent has
no interactive approver). Registered in `~/.omp/agent/mcp.json`:

```json
"hermes-memory": {
  "command": "<hermes venv>/bin/python",
  "args": ["~/.hermes/plugins/model-providers/omp/hermes_memory_mcp.py"]
}
```

Tools, reachable by an OMP agent as `xd://mcp__hermes_memory_<tool>`:
`memory_read`, `memory_add`, `memory_replace`, `memory_remove`,
`memory_apply_batch` (all-or-nothing, for freeing space and adding in one call
when memory is at its cap).

No `env`/`cwd` is pinned in that entry on purpose: the server must inherit
`HERMES_HOME` from the Hermes process so a write lands in the profile whose
memory the bridge injects. Pinning it would silently split reads from writes
under a named profile.

## Env

- `OMP_BIN` — omp executable
- `OMP_APPROVAL_MODE` — `yolo` (default), `write`, or `always-ask`
- `OMP_RPC_ARGS` — extra launch args
