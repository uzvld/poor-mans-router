"""OpenAI-compatible thin host on top of OMP rpc-ui.

Hermes is Paseo-shaped here: it does not inject its tools, does not parse
``<tool_call>`` out of OMP text, and does not execute a second agent loop.
OMP owns inference, Cursor/OpenCode models, tools, MCP, skills, and native
sessions. This facade only:

* sends the latest user message (prompt, then follow_up) prefixed with Hermes'
  own memory blocks, which is read-only context for the OMP agent
* streams text / thinking / tool-activity deltas
* closes the OpenAI-shaped stream with ``finish_reason="stop"``
* aborts the native turn on interrupt

Session identity comes from Hermes session context, never from a key injected
into the shared ``client_kwargs`` dict (that leaks into OpenAI/OpenRouter
constructors).
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import inspect
import logging
import os
import sys
import threading
from pathlib import Path
from queue import Empty, Queue
from types import SimpleNamespace
from typing import Any

sys_path_added = os.path.dirname(os.path.abspath(__file__))
if sys_path_added not in sys.path:
    sys.path.insert(0, sys_path_added)

from omp_adapter.runtime import OMPRuntime  # noqa: E402

_DEFAULT_TIMEOUT_SECONDS = 600.0
_STREAM_POLL_SECONDS = 0.05
_APPROVAL_MODES = {"always-ask", "write", "yolo"}

logger = logging.getLogger(__name__)


class OMPAuxiliaryUnsupported(RuntimeError):
    """OMP is a thin host, not an auxiliary LLM (title / compression / vision)."""


def called_from_auxiliary() -> bool:
    """True when Hermes is building or calling a client for an auxiliary task.

    Title generation, compression and vision all go through auxiliary_client.py and
    would otherwise spawn a second ``omp --mode rpc-ui`` that holds the session lease
    while the chat stream waits — surfacing as BlockingIOError [Errno 35].
    """
    thread = threading.current_thread().name.lower()
    if "aux" in thread or "title" in thread:
        return True
    for info in inspect.stack(context=0):
        filename = info.filename or ""
        if filename.endswith("auxiliary_client.py"):
            return True
    return False


def refuse_auxiliary_omp() -> None:
    if called_from_auxiliary():
        raise OMPAuxiliaryUnsupported(
            "omp is a thin-host agent (Cursor/OpenCode tools), not an auxiliary LLM"
        )


class _HubSlot:
    __slots__ = ("runtime", "loop", "loop_thread", "refcount")

    def __init__(self, runtime, loop, loop_thread):
        self.runtime = runtime
        self.loop = loop
        self.loop_thread = loop_thread
        self.refcount = 1


_HUB_LOCK = threading.Lock()
_HUB: dict[tuple, _HubSlot] = {}
_HUB_CREATING: dict[tuple, threading.Event] = {}


def _hub_begin(key: tuple) -> tuple[_HubSlot | None, threading.Event | None, bool]:
    with _HUB_LOCK:
        slot = _HUB.get(key)
        if slot is not None:
            slot.refcount += 1
            return slot, None, False
        ev = _HUB_CREATING.get(key)
        if ev is not None:
            return None, ev, False
        ev = threading.Event()
        _HUB_CREATING[key] = ev
        return None, ev, True


def _hub_commit(key: tuple, slot: _HubSlot) -> None:
    with _HUB_LOCK:
        _HUB[key] = slot
        ev = _HUB_CREATING.pop(key, None)
    if ev is not None:
        ev.set()


def _hub_abort_create(key: tuple) -> None:
    with _HUB_LOCK:
        ev = _HUB_CREATING.pop(key, None)
    if ev is not None:
        ev.set()


def _hub_release(key: tuple) -> bool:
    """Decrement refcount. True when the caller must close the runtime/loop."""
    with _HUB_LOCK:
        slot = _HUB.get(key)
        if slot is None:
            return True
        slot.refcount -= 1
        if slot.refcount > 0:
            return False
        _HUB.pop(key, None)
        return True


def _effective_timeout(timeout: Any) -> float:
    if isinstance(timeout, (int, float)):
        return float(timeout)
    candidates = [getattr(timeout, attr, None) for attr in ("read", "write", "connect", "pool", "timeout")]
    return max((float(v) for v in candidates if isinstance(v, (int, float))),
               default=_DEFAULT_TIMEOUT_SECONDS)


def _render_content(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, dict):
        if "text" in content:
            return str(content.get("text") or "").strip()
        inner = content.get("content")
        return inner.strip() if isinstance(inner, str) else ""
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, str) and item.strip():
                parts.append(item.strip())
            elif isinstance(item, dict) and isinstance(item.get("text"), str) and item["text"].strip():
                parts.append(item["text"].strip())
        return "\n".join(parts).strip()
    return str(content).strip()


def _latest_user_text(messages: list[dict[str, Any]] | None) -> str:
    """Thin-host prompt: only the latest user turn. OMP holds the rest of the session."""
    for message in reversed(messages or []):
        if not isinstance(message, dict):
            continue
        role = str(message.get("role") or "").strip().lower()
        if role != "user":
            continue
        text = _render_content(message.get("content"))
        if text:
            return text
    return ""


_MEMORY_OPEN = "[Hermes memory — durable notes from your long-term store]"
_MEMORY_CLOSE = "[end Hermes memory]"


def _load_memory_blocks() -> list[str]:
    """Hermes' own memory in system-prompt form (MEMORY.md, then USER.md).

    A seam for tests: the real path imports the Hermes checkout, which the thin
    host's own test suite does not load.
    """
    from tools.memory_tool import load_on_disk_store

    store = load_on_disk_store()
    return [block for block in (store.format_for_system_prompt(target)
                                for target in ("memory", "user")) if block]


def _hermes_memory_preamble() -> str:
    """Hermes memory as a preamble for the OMP turn — "" when there is none.

    Read-only: OMP gains no write path into Hermes memory, and Hermes tools stay
    on Hermes. Fail-open: an unreadable store yields no preamble rather than a
    failed turn.
    """
    try:
        blocks = _load_memory_blocks()
    except Exception as exc:  # noqa: BLE001 — memory must never break a turn
        logger.warning("Hermes memory unavailable for the omp prompt (%s); sending the turn without it", exc)
        return ""
    if not blocks:
        return ""
    return f"{_MEMORY_OPEN}\n" + "\n\n".join(blocks) + f"\n{_MEMORY_CLOSE}\n\n"


# OMP's ``message.stopReason`` -> the OpenAI ``finish_reason`` vocabulary Hermes speaks.
# Anything unmapped stays "stop"; the aborted set is not a finish at all (see _final_chunk).
_FINISH_REASONS = {
    "stop": "stop", "end_turn": "stop", "stop_sequence": "stop",
    "max_tokens": "length", "length": "length", "max_output_tokens": "length", "truncated": "length",
    "tool_use": "tool_calls", "tool_calls": "tool_calls",
    "content_filter": "content_filter", "refusal": "content_filter",
}
_ABORTED_STOP_REASONS = {"aborted", "cancelled", "canceled", "error", "interrupted"}


_TOOL_START_EVENTS = {"tool_execution_start", "tool_start", "tool_call_start"}
_TOOL_END_EVENTS = {"tool_execution_end", "tool_end", "tool_call_end"}


def _tool_event_name(event: dict[str, Any]) -> str | None:
    for key in ("toolName", "name", "tool"):
        value = event.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _tool_event_args(event: dict[str, Any]) -> dict[str, Any]:
    """Args for the tool card. OMP sends either a structured ``args`` or a display title."""
    args = event.get("args")
    if isinstance(args, dict):
        return args
    for key in ("title", "args", "input"):
        value = event.get(key)
        if isinstance(value, str) and value:
            return {"title": value}
    return {}


def _tool_event_result(event: dict[str, Any]) -> Any:
    for key in ("result", "output", "text"):
        if key in event and event[key] not in (None, ""):
            return event[key]
    return None


def _tool_activity_text(event: dict[str, Any]) -> str | None:
    kind = str(event.get("type") or "")
    if kind in _TOOL_START_EVENTS:
        name = event.get("toolName") or event.get("name") or event.get("tool") or "tool"
        title = event.get("title") or event.get("args") or ""
        extra = f" {title}" if isinstance(title, str) and title and title != name else ""
        return f"\n[omp:{name}]{extra}\n"
    if kind == "command_output":
        text = event.get("text")
        if isinstance(text, str) and text.strip():
            snippet = text.strip()
            if len(snippet) > 400:
                snippet = snippet[:400] + "…"
            return f"{snippet}\n"
    if kind in _TOOL_END_EVENTS:
        err = event.get("error") or event.get("isError")
        if err:
            return f"[omp tool error] {err}\n"
    if kind == "retry_fallback_applied":
        # OMP native retry chain switched model mid-turn; make it as visible as a tool call.
        src, dst = event.get("from"), event.get("to")
        if isinstance(src, str) and src and isinstance(dst, str) and dst:
            return f"\n[omp:fallback] {src} -> {dst}\n"
    if kind == "extension_ui_request" and event.get("method") == "notify":
        # Extensions opt a notification into the transcript with an [omp:...] prefix;
        # everything else is UI chrome (toasts, widgets) and stays out.
        message = event.get("message")
        if isinstance(message, str) and message.startswith("[omp:"):
            return f"\n{message}\n"
    return None


def _host_session_id() -> str | None:
    try:
        from gateway.session_context import get_session_env
        sid = get_session_env("HERMES_SESSION_ID", "")
        if sid:
            return str(sid)
    except Exception:
        pass
    env_sid = os.environ.get("HERMES_SESSION_ID")
    if env_sid:
        return env_sid
    for info in inspect.stack():
        agent = info.frame.f_locals.get("agent")
        if agent is None:
            continue
        sid = getattr(agent, "session_id", None)
        if sid:
            return str(sid)
    return None


def _host_cwd(explicit: str | None) -> str:
    if explicit:
        return str(Path(explicit).expanduser().resolve())
    try:
        from agent.runtime_cwd import resolve_agent_cwd
        return str(resolve_agent_cwd())
    except Exception:
        return str(Path(os.getcwd()).resolve())


def _approval_mode() -> str:
    raw = (os.environ.get("OMP_APPROVAL_MODE") or "yolo").strip().lower()
    return raw if raw in _APPROVAL_MODES else "yolo"


class _OMPRPCStream:
    """Blocking iterator over a live OMP turn, fed by the worker-loop producer."""

    def __init__(self, client: "OMPRPCClient", prompt_text: str, timeout: float, model: str, *, follow_up: bool):
        self._client = client
        self._queue: Queue = Queue(maxsize=1024)
        self._closed = threading.Event()
        self._final = None
        self._failure = None
        self.model = model
        self.client = client.chat
        self._start(prompt_text, timeout, follow_up)

    def _start(self, prompt_text: str, timeout: float, follow_up: bool) -> None:
        runtime = self._client._ensure_runtime()
        loop = self._client._loop

        async def _drive():
            text_parts: list[str] = []
            reason_parts: list[str] = []
            saw_text_delta = False
            stop_reason: str | None = None
            async for env in runtime.turn(prompt_text, timeout=timeout, follow_up=follow_up):
                event = env.get("event") or {}
                kind = event.get("type")
                if kind == "message_update":
                    ev = event.get("assistantMessageEvent") or {}
                    etype = ev.get("type")
                    role = ((event.get("message") or {}).get("role")
                            if isinstance(event.get("message"), dict) else None)
                    if role not in (None, "assistant"):
                        continue
                    if etype == "text_delta" and isinstance(ev.get("delta"), str) and ev["delta"]:
                        saw_text_delta = True
                        text_parts.append(ev["delta"])
                        self._queue.put(("text", ev["delta"]))
                    elif etype == "thinking_delta" and isinstance(ev.get("delta"), str) and ev["delta"]:
                        reason_parts.append(ev["delta"])
                        self._queue.put(("reasoning", ev["delta"]))
                elif kind in ("message_end", "turn_end"):
                    message = event.get("message") or {}
                    reason = message.get("stopReason")
                    if isinstance(reason, str) and reason:
                        stop_reason = reason
                    role = message.get("role")
                    if kind == "turn_end" or role != "assistant" or saw_text_delta:
                        continue
                    for item in message.get("content") or []:
                        if isinstance(item, dict) and item.get("type") == "text" and item.get("text"):
                            text_parts.append(str(item["text"]))
                            self._queue.put(("text", str(item["text"])))
                else:
                    activity = None if self._client._report_tool_event(event) else _tool_activity_text(event)
                    if activity:
                        self._queue.put(("text", activity))
            self._queue.put(("final", SimpleNamespace(
                text="".join(text_parts), reasoning="".join(reason_parts), stop_reason=stop_reason)))
            self._queue.put(("__done__", None))

        def _run():
            try:
                fut = asyncio.run_coroutine_threadsafe(_drive(), loop)
                try:
                    fut.result(timeout=timeout + 30)
                except Exception as exc:  # noqa: BLE001
                    self._failure = exc
                    self._queue.put(("__done__", None))
            except Exception as exc:  # noqa: BLE001
                self._failure = exc
                self._queue.put(("__done__", None))
            finally:
                self._queue.put(("__done__", None))

        self._producer = threading.Thread(target=_run, daemon=True, name="omp-rpc-stream")
        self._producer.start()

    def __iter__(self):
        return self

    def __next__(self) -> Any:
        if self._failure is not None:
            raise self._failure
        while True:
            if self._closed.is_set():
                raise StopIteration
            try:
                kind, payload = self._queue.get(timeout=_STREAM_POLL_SECONDS)
            except Empty:
                continue
            if kind == "__done__":
                # The producer sets ``_failure`` and pushes ``__done__`` back to back. A
                # consumer already parked in ``queue.get()`` sees only ``__done__``, so
                # without this re-check an OMP-side turn failure became a clean, EMPTY
                # stream — no chunks, no exception — while the non-streaming path raised.
                if self._failure is not None:
                    raise self._failure
                raise StopIteration
            if kind in ("text", "reasoning"):
                return self._chunk(kind, payload)
            if kind == "final":
                self._final = payload
                return self._final_chunk()

    def _final_chunk(self) -> Any:
        delta = SimpleNamespace(role="assistant", content=None, tool_calls=None,
                                reasoning_content=None, reasoning=None)
        reason = getattr(self._final, "stop_reason", None)
        if reason in _ABORTED_STOP_REASONS:
            # An aborted/errored turn is not an answer. Closing it as ``stop`` is what made
            # truncation, cancellation and failure indistinguishable downstream.
            raise RuntimeError(f"OMP turn ended as {reason!r} before completing")
        return SimpleNamespace(
            id=None, provider=None,
            choices=[SimpleNamespace(index=0, delta=delta,
                                     finish_reason=_FINISH_REASONS.get(str(reason or ""), "stop"))],
            model=self.model, usage=SimpleNamespace(
                prompt_tokens=0, completion_tokens=0, total_tokens=0),
        )

    def _chunk(self, kind: str, delta_text: str) -> Any:
        if kind == "reasoning":
            delta = SimpleNamespace(role="assistant", content=None, tool_calls=None,
                                    reasoning_content=delta_text, reasoning=delta_text)
        else:
            delta = SimpleNamespace(role="assistant", content=delta_text, tool_calls=None,
                                    reasoning_content=None, reasoning=None)
        return SimpleNamespace(
            id=None, provider=None,
            choices=[SimpleNamespace(index=0, delta=delta, finish_reason=None)],
            model=self.model, usage=None,
        )

    def close(self) -> None:
        if self._closed.is_set():
            return
        self._closed.set()
        runtime = self._client._runtime
        if runtime is not None:
            try:
                asyncio.run_coroutine_threadsafe(runtime.abort(), self._client._loop).result(5)
            except Exception:
                pass
        with contextlib.suppress(Exception):
            while True:
                self._queue.get_nowait()


# Hermes hands us whatever its picker/config resolved. Picker ids carry the Hermes
# provider as a prefix (``omp:pmr/balanced``), while OMP's ``set_model`` takes the
# native ``provider/modelId`` only — the prefixed form partitions into provider
# ``omp:pmr`` and OMP answers "Model not found". Strip the prefix so both forms pin.
_HOST_PROVIDER_PREFIXES = ("omp:", "oh-my-pi:", "omp-rpc:", "ohmyai:")


def _native_model_id(model_id: str | None) -> str | None:
    """``omp:anthropic/claude-sonnet-5`` -> ``anthropic/claude-sonnet-5``; bare ids pass through."""
    native = str(model_id or "").strip()
    for prefix in _HOST_PROVIDER_PREFIXES:
        if native.lower().startswith(prefix):
            native = native[len(prefix):].strip()
            break
    return native or None


class OMPRPCClient:
    HERMES_SKIP_TRANSPORT_WRAP = True
    HERMES_SKIP_ASYNC_WRAP = True

    def __init__(
        self, *, api_key: str | None = None, base_url: str | None = None,
        acp_cwd: str | None = None, model: str | None = None, omp_command: list[str] | None = None,
        default_headers: dict[str, str] | None = None, _hermes_agent: Any = None, **_: Any,
    ):
        # Present only when the profile declares ``wants_agent_handle`` (see
        # providers/base.py). OMP runs its own tools, so this is the only way that
        # activity can reach Hermes' tool rail instead of being flattened into prose.
        self._agent = _hermes_agent
        self.api_key, self.base_url = api_key or "omp-rpc", base_url or "rpc-ui://omp"
        self._default_headers = dict(default_headers or {})
        self.cwd = _host_cwd(acp_cwd)
        self.default_model = model
        self._command = list(omp_command or ["/opt/homebrew/bin/omp"])
        self.session_key = _host_session_id() or self.cwd
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create_chat_completion))
        self.is_closed = False
        self._runtime = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._loop_thread: threading.Thread | None = None
        self._loop_ready = threading.Event()
        self._turns_completed = 0
        self._hub_key: tuple | None = None
        self._open_tools: list[str] = []

    def _report_tool_event(self, event: dict[str, Any]) -> bool:
        """Put OMP's own tool activity on Hermes' tool rail. ``True`` when reported.

        Both hosts install ``tool_progress_callback`` on the agent — the ACP adapter
        (``acp_adapter/server.py``, which is what Multica talks to) and the desktop
        gateway (``tui_gateway/agent_callbacks.py``) — so feeding it renders OMP's
        tools as real tool calls instead of ``[omp:bash]`` prose. ``delta.tool_calls``
        deliberately stays ``None``: this work is already done, and Hermes must never
        treat it as calls it has to execute.

        Falls back to the text marker (``False``) whenever there is no agent handle or
        the callback misbehaves — tool activity must never silently vanish.
        """
        callback = getattr(self._agent, "tool_progress_callback", None)
        if not callable(callback):
            return False
        kind = str(event.get("type") or "")
        if kind in _TOOL_START_EVENTS:
            name = _tool_event_name(event) or "tool"
            try:
                callback("tool.started", name=name, args=_tool_event_args(event))
            except Exception:
                logger.debug("tool.started report failed for %s", name, exc_info=True)
                return False
            self._open_tools.append(name)
            return True
        if kind in _TOOL_END_EVENTS:
            # The end event may omit the name; the host matches start/end by name, so
            # close the most recent open call rather than inventing an unmatched one.
            name = _tool_event_name(event) or (self._open_tools[-1] if self._open_tools else None)
            if name is None:
                return False
            error = event.get("error") or event.get("isError")
            try:
                callback(
                    "tool.completed", name=name, result=_tool_event_result(event),
                    is_error=bool(error),
                )
            except Exception:
                logger.debug("tool.completed report failed for %s", name, exc_info=True)
                return False
            if name in self._open_tools:
                self._open_tools.remove(name)
            return True
        return False

    def _ensure_loop(self) -> asyncio.AbstractEventLoop:
        if self._loop is not None:
            return self._loop
        loop = asyncio.new_event_loop()
        self._loop = loop

        def _run_forever():
            asyncio.set_event_loop(loop)
            self._loop_ready.set()
            loop.run_forever()
            with contextlib.suppress(Exception):
                loop.close()

        self._loop_thread = threading.Thread(target=_run_forever, daemon=True,
                                             name="omp-rpc-loop")
        self._loop_thread.start()
        self._loop_ready.wait(timeout=10)
        return self._loop

    def _await_async(self, coro, timeout: float | None = None):
        loop = self._ensure_loop()
        future = asyncio.run_coroutine_threadsafe(coro, loop)
        return future.result(timeout)

    def _attach_slot(self, slot: _HubSlot) -> None:
        self._runtime = slot.runtime
        self._loop = slot.loop
        self._loop_thread = slot.loop_thread
        self._loop_ready.set()

    def _runtime_key(self) -> tuple:
        # Resolve session id at first use: agent_init often runs before Hermes has a session.
        self.session_key = _host_session_id() or self.session_key or self.cwd
        host_id = "hermes/rpc/" + hashlib.sha256(self.session_key.encode()).hexdigest()[:16]
        return ("default", host_id, str(self.cwd))

    def _ensure_runtime(self) -> OMPRuntime:
        if self._runtime is not None:
            return self._runtime
        key = self._runtime_key()
        slot, ev, creator = _hub_begin(key)
        if slot is not None:
            self._hub_key = key
            self._attach_slot(slot)
            return self._runtime
        if not creator:
            if ev is None or not ev.wait(timeout=120):
                raise TimeoutError("timed out waiting for omp runtime in this session")
            # Creator either published a slot or aborted; retry as attach-or-create.
            return self._ensure_runtime()
        try:
            mode = _approval_mode()
            runtime = OMPRuntime(
                store=self._make_store(), profile="default",
                host_id=key[1], cwd=self.cwd, command=self._command,
                approval_mode=mode,
                permission_policy="allow" if mode == "yolo" else "deny",
            )
            self._runtime = runtime
            self._await_async(runtime.start(), 120)
            self._pin_model(self.default_model)
            slot = _HubSlot(runtime, self._loop, self._loop_thread)
            self._hub_key = key
            _hub_commit(key, slot)
            return runtime
        except BaseException:
            _hub_abort_create(key)
            self._runtime = None
            raise

    def _pin_model(self, model_id: str | None) -> None:
        """Pin OMP to the model Hermes asked for, or fail the turn.

        Never return quietly after a failed switch: OMP would then serve the turn on
        whatever model it happened to be on (its own persisted current model), which is
        how a routed request silently lands on an unintended — possibly far more
        expensive — model.
        """
        native = _native_model_id(model_id)
        if not native or "/" not in native:
            return
        runtime = self._runtime
        if runtime is None:
            return

        def _current() -> str | None:
            state_model = (runtime.state or {}).get("model") if runtime.state else None
            if isinstance(state_model, dict):
                provider, native_id = state_model.get("provider"), state_model.get("id")
                if provider and native_id:
                    return f"{provider}/{native_id}"
            return None

        before = _current()
        if before == native:
            return
        try:
            self._await_async(runtime.set_model(native), 30)
        except Exception as exc:
            raise RuntimeError(
                f"OMP refused model {native!r} (Hermes requested {model_id!r}); "
                f"refusing to run the turn on {before or 'the current OMP model'}: {exc}"
            ) from exc
        after = _current()
        if after == before:
            raise RuntimeError(
                f"OMP acked set_model({native!r}) but stayed on {before or 'its current model'}; "
                "refusing to run the turn on the wrong model"
            )
        if after != native:
            # OMP may normalise an id (alias, tier suffix). Not a failure, but it must be visible.
            logger.warning("OMP normalised model %r to %r (Hermes requested %r)", native, after, model_id)

    def _make_store(self):
        from omp_adapter.mapping import MappingStore
        from hermes_constants import get_hermes_home
        root = Path(get_hermes_home()) / "omp-rpc"
        root.mkdir(parents=True, exist_ok=True)
        return MappingStore(str(root / "map.db"), str(root / "sessions"))

    def close(self) -> None:
        if self.is_closed:
            return
        self.is_closed = True
        last = True
        if self._hub_key is not None:
            last = _hub_release(self._hub_key)
            self._hub_key = None
        if last and self._runtime is not None:
            with contextlib.suppress(Exception):
                self._await_async(self._runtime.close(), 15)
        self._runtime = None
        if last and self._loop is not None:
            with contextlib.suppress(Exception):
                self._loop.call_soon_threadsafe(self._loop.stop)
            if self._loop_thread:
                self._loop_thread.join(timeout=5)
        self._loop = None
        self._loop_thread = None

    def _run_turn(self, text: str, timeout: float, *, follow_up: bool) -> tuple[str, str, str | None]:
        runtime = self._ensure_runtime()
        text_parts: list[str] = []
        reason_parts: list[str] = []
        saw_text_delta = [False]
        stop_reason: list[str | None] = [None]

        async def _drive():
            async for env in runtime.turn(text, timeout=timeout, follow_up=follow_up):
                event = env.get("event") or {}
                kind = event.get("type")
                if kind == "message_update":
                    ev = event.get("assistantMessageEvent") or {}
                    etype = ev.get("type")
                    role = ((event.get("message") or {}).get("role")
                            if isinstance(event.get("message"), dict) else None)
                    if role not in (None, "assistant"):
                        continue
                    if etype == "text_delta" and isinstance(ev.get("delta"), str):
                        text_parts.append(ev["delta"])
                        saw_text_delta[0] = True
                    elif etype == "thinking_delta" and isinstance(ev.get("delta"), str):
                        reason_parts.append(ev["delta"])
                elif kind in ("message_end", "turn_end"):
                    message = event.get("message") or {}
                    reason = message.get("stopReason")
                    if isinstance(reason, str) and reason:
                        stop_reason[0] = reason
                    role = message.get("role")
                    if kind == "turn_end" or role != "assistant" or saw_text_delta[0]:
                        continue
                    for item in message.get("content") or []:
                        if isinstance(item, dict) and item.get("type") == "text" and item.get("text"):
                            text_parts.append(str(item["text"]))
                else:
                    activity = None if self._report_tool_event(event) else _tool_activity_text(event)
                    if activity:
                        text_parts.append(activity)

        try:
            self._await_async(_drive(), timeout + 30)
        except BaseException:
            with contextlib.suppress(Exception):
                self._await_async(runtime.abort(), 5)
            raise
        return "".join(text_parts), "".join(reason_parts), stop_reason[0]

    def _create_chat_completion(
        self, *, model: str | None = None, messages: list[dict[str, Any]] | None = None,
        timeout: float | None = None, tools: list[dict[str, Any]] | None = None,
        tool_choice: Any = None, stream: bool = False, **_: Any,
    ) -> Any:
        del tools, tool_choice  # Hermes tools stay on Hermes; OMP has its own.
        refuse_auxiliary_omp()
        prompt_text = _hermes_memory_preamble() + (_latest_user_text(messages) or "Continue.")
        timeout = _effective_timeout(timeout)
        resolved_model = model or self.default_model or "omp-rpc"
        self._ensure_runtime()
        self._pin_model(resolved_model)
        # `follow_up` continues an agent that is live in THIS process. A cold
        # `omp --resume` restores messageCount>0 from disk without a live agent:
        # OMP acks the follow_up (success) and then emits no agent_start/turn, so
        # the turn stalls to timeout and Hermes shows an empty reply. Only a turn
        # this client already completed proves the agent is warm.
        follow_up = self._turns_completed > 0
        if stream:
            stream_obj = _OMPRPCStream(self, prompt_text, timeout, resolved_model, follow_up=follow_up)
            self._turns_completed += 1
            return stream_obj
        response_text, reasoning, stop_reason = self._run_turn(prompt_text, timeout, follow_up=follow_up)
        if stop_reason in _ABORTED_STOP_REASONS:
            raise RuntimeError(f"OMP turn ended as {stop_reason!r} before completing")
        self._turns_completed += 1
        message = SimpleNamespace(
            content=response_text, tool_calls=None, reasoning=reasoning or None,
            reasoning_content=reasoning or None, reasoning_details=None,
        )
        return SimpleNamespace(
            choices=[SimpleNamespace(message=message,
                                     finish_reason=_FINISH_REASONS.get(str(stop_reason or ""), "stop"))],
            usage=SimpleNamespace(prompt_tokens=0, completion_tokens=0, total_tokens=0,
                                  prompt_tokens_details=SimpleNamespace(cached_tokens=0)),
            model=resolved_model,
        )
