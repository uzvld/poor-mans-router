"""Hermes memory as a stdio MCP server for OMP agents.

Under the bridge, OMP sees Hermes memory read-only (``omp_rpc_client`` prepends
the blocks to every turn). This server is the write path: it goes through the
same ``MemoryStore`` Hermes itself uses, so char caps, the injection scan,
dedupe, the external-drift guard, and atomic writes all still apply.

Hermes' approval staging is deliberately not applied: OMP agents are not
interactive Hermes sessions, so a staged write would have nobody to approve it.

Registered in OMP's own config (``~/.omp/agent/mcp.json``)::

    "hermes-memory": {
      "command": "<hermes venv>/bin/python",
      "args": ["<this file>"]
    }

The profile is resolved exactly as Hermes resolves it (context override →
``HERMES_HOME`` → platform default), so a write lands in the same profile whose
memory the bridge injects. No ``env``/``cwd`` is pinned in the config precisely
to keep that inheritance intact.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

_AGENT_ROOT = "hermes-agent"


def _ensure_agent_root_on_path() -> None:
    """Make the Hermes checkout importable (OMP spawns us from an agent worktree)."""
    try:
        import hermes_constants  # noqa: F401
        return
    except ImportError:
        pass
    hermes_home = os.environ.get("HERMES_HOME", "").strip() or str(Path.home() / ".hermes")
    candidates = [
        os.environ.get("HERMES_AGENT_ROOT", ""),
        str(Path(__file__).resolve().parents[3] / _AGENT_ROOT),
        str(Path(hermes_home) / _AGENT_ROOT),
    ]
    for candidate in candidates:
        if candidate and (Path(candidate) / "hermes_constants.py").exists():
            sys.path.insert(0, candidate)
            return


_ensure_agent_root_on_path()

from mcp.server import MCPServer  # noqa: E402
from hermes_constants import get_hermes_home  # noqa: E402
from tools.memory_tool import get_memory_dir, load_on_disk_store  # noqa: E402
from tools.memory_tool_store import ENTRY_DELIMITER  # noqa: E402

_LABELS = {"memory": "MEMORY.md (your personal notes)", "user": "USER.md (user profile)"}
_FILES = {"memory": "MEMORY.md", "user": "USER.md"}

server = MCPServer(
    name="hermes-memory",
    instructions=(
        "Hermes memory is durable, char-capped memory shared with the user's Hermes agents: "
        "'memory' holds your own notes (environment, conventions, tool quirks, lessons), 'user' "
        "holds durable facts about the user. Add a new fact with memory_add. When memory is at "
        "its cap, consolidate with memory_apply_batch so the remove/merge and the add land "
        "together instead of half-applying."
    ),
)


def _fail(message: str) -> str:
    return json.dumps({"success": False, "error": message}, ensure_ascii=False)


def _load():
    """Fresh store per call: a write must see what is on disk right now."""
    return load_on_disk_store()


def _target_error(store, target: str):
    if target not in _LABELS:
        return f"Unknown target {target!r}. Use 'memory' (your notes) or 'user' (user profile)."
    if not store.target_enabled(target):
        return f"Built-in {_FILES[target]} writes are disabled in memory config."
    return None


def _run(target: str, operation) -> str:
    try:
        store = _load()
    except Exception as exc:  # noqa: BLE001 — surface, never crash the agent's turn
        return _fail(f"Hermes memory store unavailable: {type(exc).__name__}: {exc}")
    if error := _target_error(store, target):
        return _fail(error)
    try:
        return json.dumps(operation(store), ensure_ascii=False)
    except Exception as exc:  # noqa: BLE001
        return _fail(f"{type(exc).__name__}: {exc}")


@server.tool()
def memory_read() -> str:
    """Read Hermes memory — both MEMORY.md (your notes) and USER.md (the user profile).

    Shows every entry verbatim with its char budget, which is what you need to
    pick exact text for memory_replace or memory_remove. Under the Hermes bridge
    these same blocks are already prepended to each turn, so reading is only
    necessary when you need entry text mid-turn.
    """
    try:
        store = _load()
    except Exception as exc:  # noqa: BLE001
        return _fail(f"Hermes memory store unavailable: {type(exc).__name__}: {exc}")
    blocks = []
    for target in ("memory", "user"):
        entries = store.memory_entries if target == "memory" else store.user_entries
        limit = store.memory_char_limit if target == "memory" else store.user_char_limit
        used = len(ENTRY_DELIMITER.join(entries))
        body = ENTRY_DELIMITER.join(entries) if entries else "(empty)"
        blocks.append(f"{_LABELS[target]} — {used:,}/{limit:,} chars\n{body}")
    return "\n\n".join(blocks)


@server.tool()
def memory_add(target: str, content: str) -> str:
    """Append one entry to Hermes memory.

    target: 'memory' for your own notes, 'user' for durable facts about the user.
    Duplicates are ignored. If the entry would exceed the char cap the call is
    refused with the current entries — consolidate with memory_apply_batch, then
    retry. Writes that look like prompt injection are rejected, since memory is
    injected into system prompts.
    """
    return _run(target, lambda store: store.add(target, content))


@server.tool()
def memory_replace(target: str, old_text: str, new_content: str) -> str:
    """Replace the single entry containing old_text with new_content.

    old_text must match exactly one distinct entry (use memory_read to copy it).
    Use this to shorten or merge entries when memory is at its cap; to delete an
    entry use memory_remove.
    """
    return _run(target, lambda store: store.replace(target, old_text, new_content))


@server.tool()
def memory_remove(target: str, old_text: str) -> str:
    """Delete the single entry containing old_text.

    old_text must match exactly one distinct entry (use memory_read to copy it).
    """
    return _run(target, lambda store: store.remove(target, old_text))


@server.tool()
def memory_apply_batch(target: str, operations: list[dict[str, str]]) -> str:
    """Apply several memory operations atomically — all of them or none.

    This is the way to free space and add in one shot when memory is at its cap:
    a failing op leaves memory untouched instead of half-applied.

    Each operation is an object: {"action": "add" | "replace" | "remove",
    "content": "<new text, for add/replace>", "old_text": "<unique substring of
    the entry, for replace/remove>"}.
    """
    return _run(target, lambda store: store.apply_batch(target, operations))


def main() -> None:
    print(f"[hermes-memory] profile={get_hermes_home()} memories={get_memory_dir()}",
          file=sys.stderr, flush=True)
    asyncio.run(server.run_stdio_async())


if __name__ == "__main__":
    main()
