"""Oh My Pi (omp) provider — thin rpc-ui host, no Paseo daemon.

Drives the already-installed ``omp`` binary over ``--mode rpc-ui`` the same way
Paseo/Multica do. OMP owns inference, Cursor/OpenCode models, tools, MCP,
skills and ``~/.omp`` auth. Hermes is only the host UI: it streams events and
does not inject its own tool loop.
"""

from __future__ import annotations

import shutil
import subprocess
from typing import Any

from providers import register_provider
from providers.base import ProviderProfile

_OMP_EXECUTABLES = (
    shutil.which("omp"),
    "/opt/homebrew/bin/omp",
    "/usr/local/bin/omp",
)

# How long fetched OMP model catalogs stay fresh on disk before the picker
# respawns the probe. 30 minutes balances catalog churn vs spawn cost.
_MODELS_CACHE_TTL = 1800.0


def _resolve_omp_bin() -> str:
    for candidate in _OMP_EXECUTABLES:
        if candidate and shutil.which(candidate):
            return shutil.which(candidate) or candidate
    raise RuntimeError(
        "omp binary not found. Set OMP_BIN env var or install Oh My Pi, e.g. "
        "npm install -g @oh-my-pi/pi-coding-agent"
    )


class OMPACPProfile(ProviderProfile):
    """Oh My Pi ACP — external process, no REST models endpoint."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self.omp_bin = kwargs.pop("omp_bin", None) or _resolve_omp_bin()
        super().__init__(*args, **kwargs)

    def create_client(self, **client_kwargs: Any) -> Any:
        """Build the ACP stdio shim driving ``omp acp`` rather than an HTTP client."""
        from agent.copilot_acp_client import CopilotACPClient

        client_kwargs.pop("acp_command", None)
        client_kwargs.pop("command", None)
        client_kwargs.pop("acp_args", None)
        client_kwargs.pop("args", None)
        return CopilotACPClient(
            acp_command=self.omp_bin,
            acp_args=["acp"],
            **client_kwargs,
        )

    def fetch_models(
        self, *, api_key: str | None = None, base_url: str | None = None, timeout: float = 8.0
    ) -> list[str] | None:
        """Model listing is handled by the ACP subprocess. Return None."""
        return None


_omp_bin = _resolve_omp_bin()

class OMPRPCProfile(ProviderProfile):
    """OMP over rpc-ui — full nested model discovery + native sessions."""

    # OMP executes its own tools (thin host), so Hermes never sees structured
    # tool_calls for them. With the agent handle the client can report that work
    # through ``agent.tool_progress_callback``, which is what turns it into ACP
    # tool calls for Multica and tool cards in the desktop UI.
    wants_agent_handle = True

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self.omp_bin = kwargs.pop("omp_bin", None) or _resolve_omp_bin()
        super().__init__(*args, **kwargs)

    def create_client(self, **client_kwargs: Any) -> Any:
        """Build the rpc-ui OpenAI-compatible client driving ``omp --mode rpc-ui``."""
        from .omp_rpc_client import OMPRPCClient, refuse_auxiliary_omp

        # Title/compression/vision would spawn a second omp and hold the session
        # lease — chat then fails with BlockingIOError [Errno 35].
        refuse_auxiliary_omp()
        client_kwargs.pop("omp_command", None)
        # Never forward a host session key through the shared client_kwargs dict:
        # openai.OpenAI / OpenRouter constructors reject unknown keywords.
        client_kwargs.pop("hermes_session_id", None)
        return OMPRPCClient(omp_command=[self.omp_bin], **client_kwargs)

    def fetch_models(
        self, *, api_key: str | None = None, base_url: str | None = None, timeout: float = 30.0
    ) -> list[str] | None:
        """Discover OMP's native nested models (e.g. ``openai-codex/gpt-5.6-luna``).

        Discovery runs in an ISOLATED child interpreter (``omp_models_probe.py``)
        because the parent process's asyncio loop may already be running (gateway
        RPC handler) — re-entering it raises ``RuntimeError: event loop is already
        running``. Results are cached on disk for ``_MODELS_CACHE_TTL`` seconds so
        the picker does not spawn OMP on every open. Failures return None so the
        picker falls back gracefully.
        """
        import json as _json
        import os as _os
        import tempfile
        import time as _time

        cache_path = None
        try:
            from hermes_constants import get_hermes_home
            cache_root = _os.path.join(get_hermes_home(), "omp-rpc")
            _os.makedirs(cache_root, exist_ok=True)
            cache_path = _os.path.join(cache_root, "models-cache.json")
            try:
                with open(cache_path, encoding="utf-8") as _fh:
                    cached = _json.load(_fh)
                if (isinstance(cached, dict) and isinstance(cached.get("models"), list)
                        and _time.time() - float(cached.get("at", 0)) < _MODELS_CACHE_TTL):
                    return cached["models"] or None
            except Exception:
                pass
        except Exception:
            pass

        probe = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "omp_models_probe.py")
        try:
            # Depend on the same interpreter that runs Hermes; the probe self-imports
            # the omp_adapter modules from the plugin dir.
            import subprocess as _sp
            import sys as _sys
            probe_cwd = tempfile.mkdtemp(prefix="omp-models-")
            env = dict(_os.environ)
            env["OMP_PROBE_CWD"] = probe_cwd
            proc = _sp.run([_sys.executable, probe, self.omp_bin],
                           capture_output=True, text=True, timeout=timeout,
                           env=env, cwd=probe_cwd)
            out = _json.loads((proc.stdout or "").strip().splitlines()[-1]) if proc.stdout.strip() else {}
        except Exception:
            return None
        models = out.get("models") if isinstance(out, dict) else None
        if not isinstance(models, list) or not models:
            return None
        models = [str(m) for m in models if isinstance(m, str) and "/" in m]
        if not models:
            return None
        if cache_path is not None:
            try:
                with open(cache_path, "w", encoding="utf-8") as _fh:
                    _json.dump({"at": _time.time(), "models": models}, _fh)
            except Exception:
                pass
        return models


# The `omp` provider is the RPC-UI (streaming) path — Hermes routes the main
# agent through `_provider_supplied_client()` → `create_client()`, and with a
# non-`acp://` base_url `_should_stream()` keeps streaming enabled (the ACP
# bridge is non-streaming and cannot be aborted). Keeping the picker slug `omp`
# means whatever the GUI writes (provider=omp) still lands on the live stream.
omp = OMPRPCProfile(
    name="omp",
    aliases=("oh-my-pi", "omp-rpc", "ohmyai"),
    display_name="Oh My Pi",
    description="Oh My Pi (native tools, Cursor/OpenCode models, skills)",
    api_mode="chat_completions",
    env_vars=(),  # Owned by the OMP subprocess
    base_url="rpc-ui://omp",  # NOT acp:// — cues Hermes to keep streaming on
    auth_type="external_process",
    supports_health_check=False,
    # Hermes resolves the binary for external_process validation/status; the
    # OMPRPCClient itself spawns `omp --mode rpc-ui` regardless.
    process_command=_omp_bin,
    process_args=(),
    process_command_env_vars=("OMP_BIN",),
    process_args_env_var="OMP_RPC_ARGS",
    omp_bin=_omp_bin,
)

# Non-streaming ACP fallback, kept separately and not wired into the picker.
omp_acp = OMPACPProfile(
    name="omp-acp",
    aliases=("oh-my-pi-acp", "ohmyai-acp"),
    api_mode="chat_completions",
    env_vars=(),
    base_url="acp://omp",
    auth_type="external_process",
    process_command=_omp_bin,
    process_args=("acp",),
    process_command_env_vars=("OMP_BIN",),
    process_args_env_var="OMP_ACP_ARGS",
    omp_bin=_omp_bin,
)

register_provider(omp)
register_provider(omp_acp)