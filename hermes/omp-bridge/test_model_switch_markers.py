"""Model switches must be visible in the transcript the same way tool calls are
(``[omp:bash]``). Three sources, one rendering seam (``_tool_activity_text``):

* OMP native retry fallback  -> ``[omp:fallback] from -> to``
* an extension's ``ctx.ui.notify('[omp:...] ...')``  -> passed through verbatim
* the model that actually answered (``message_start`` role=assistant) differing
  from what Hermes requested / last saw  -> ``[omp:model] provider/id``
"""
import unittest

from omp_rpc_client import _tool_activity_text


class FallbackMarkerTests(unittest.TestCase):
    def test_native_retry_fallback_renders_from_to_marker(self):
        text = _tool_activity_text({
            "type": "retry_fallback_applied",
            "from": "openrouter/liquid/lfm-2.5-1.2b-thinking:free:low",
            "to": "openrouter/~deepseek/deepseek-v4-flash-latest",
            "role": "openrouter/*",
        })
        self.assertEqual(
            text,
            "\n[omp:fallback] openrouter/liquid/lfm-2.5-1.2b-thinking:free:low -> "
            "openrouter/~deepseek/deepseek-v4-flash-latest\n",
        )

    def test_fallback_without_endpoints_renders_nothing(self):
        # OMP guarantees from/to on this event; a malformed one must not crash a turn.
        self.assertIsNone(_tool_activity_text({"type": "retry_fallback_applied"}))


if __name__ == "__main__":
    unittest.main()


class ExtensionNotifyMarkerTests(unittest.TestCase):
    """``ctx.ui.notify()`` from an extension reaches the thin host as an
    ``extension_ui_request`` with ``method: "notify"`` (verified against
    ``omp --mode rpc-ui``)."""

    def test_omp_prefixed_notify_is_rendered_verbatim(self):
        text = _tool_activity_text({
            "type": "extension_ui_request", "id": "x", "method": "notify",
            "message": "[omp:router] anthropic/claude-sonnet-5 -> kilo/deepseek (quota)",
            "notifyType": "info",
        })
        self.assertEqual(
            text, "\n[omp:router] anthropic/claude-sonnet-5 -> kilo/deepseek (quota)\n")

    def test_plain_notify_stays_out_of_the_transcript(self):
        # Toasts like "adaptive-router: no routing decision yet" are UI chrome, not output.
        self.assertIsNone(_tool_activity_text({
            "type": "extension_ui_request", "id": "x", "method": "notify",
            "message": "adaptive-router: no routing decision yet", "notifyType": "info",
        }))

    def test_non_notify_ui_requests_render_nothing(self):
        self.assertIsNone(_tool_activity_text({
            "type": "extension_ui_request", "id": "x", "method": "setWidget",
            "widgetKey": "autoresearch",
        }))


class StreamedMarkerTests(unittest.TestCase):
    """End-to-end through the RPC stream: fake OMP emits a native fallback plus an
    extension notify during one turn; both markers must land in the streamed text,
    in event order, before the model's own text."""

    def setUp(self):
        import omp_rpc_client as mod
        self._real_memory_blocks = mod._load_memory_blocks
        mod._load_memory_blocks = lambda: []

    def tearDown(self):
        import omp_rpc_client as mod
        mod._load_memory_blocks = self._real_memory_blocks

    def test_fallback_and_router_markers_stream_in_order(self):
        import os, sys, tempfile
        from pathlib import Path
        from omp_adapter.mapping import MappingStore
        from omp_rpc_client import OMPRPCClient
        root = Path(__file__).resolve().parent
        with tempfile.TemporaryDirectory(dir=root) as tmp:
            os.environ["HERMES_SESSION_ID"] = "sess-markers"
            client = OMPRPCClient(
                omp_command=[sys.executable, str(root / "fake_omp.py")],
                acp_cwd=tmp, model="cursor/cursor-grok-4.6")
            client._make_store = lambda: MappingStore(str(Path(tmp) / "map.db"), str(Path(tmp) / "sessions"))
            try:
                stream = client.chat.completions.create(
                    model="cursor/cursor-grok-4.6",
                    messages=[{"role": "user", "content": "/fallback"}],
                    stream=True, timeout=15)
                joined = "".join(c.choices[0].delta.content or "" for c in stream)
            finally:
                client.close()
        fb = joined.index("[omp:fallback] p/a-model -> p/b-model")
        rt = joined.index("[omp:router] p/b-model -> p/c-model (cooldown)")
        txt = joined.index("recovered")
        self.assertLess(fb, rt)
        self.assertLess(rt, txt)
