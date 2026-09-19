"""OMP's own tool work must reach Hermes' tool rail, not the transcript as prose.

OMP is a thin host: it executes tools itself, so Hermes never sees `delta.tool_calls`
for them. Before this rail existed, `_tool_activity_text` flattened every tool event
into `[omp:bash]` text inside `delta.content` — measured in Multica's daemon log as
5674 markers / 0 structured rows on the hermes path, against 7750 structured rows on
the direct-omp path. With the agent handle (profile opt-in `wants_agent_handle`, see
providers/base.py) the client reports the same activity through
`agent.tool_progress_callback`, which the ACP adapter and the desktop gateway both
install — and `delta.tool_calls` must STAY None so Hermes never re-executes the work.
"""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from omp_rpc_client import OMPRPCClient, _OMPRPCStream  # noqa: E402


class _RecordingAgent:
    def __init__(self, raises=False):
        self.calls: list[tuple] = []
        self._raises = raises

    def tool_progress_callback(self, event_type, name=None, preview=None, args=None, **kwargs):
        if self._raises:
            raise RuntimeError("host callback exploded")
        self.calls.append((event_type, name, args, kwargs))


def _client(agent=None):
    client = OMPRPCClient.__new__(OMPRPCClient)
    client._agent = agent
    client._open_tools = []
    return client


class ToolRailTests(unittest.TestCase):
    def test_without_an_agent_handle_activity_still_falls_back_to_text(self):
        # The CLI/oneshot path has no callbacks; markers are the only rendering there.
        client = _client(None)
        self.assertFalse(client._report_tool_event({"type": "tool_execution_start", "toolName": "bash"}))

    def test_tool_start_is_reported_with_name_and_args(self):
        agent = _RecordingAgent()
        client = _client(agent)
        self.assertTrue(client._report_tool_event(
            {"type": "tool_execution_start", "toolName": "bash", "title": "echo hi"}))
        event_type, name, args, _kwargs = agent.calls[0]
        self.assertEqual((event_type, name), ("tool.started", "bash"))
        self.assertEqual(args, {"title": "echo hi"})

    def test_structured_args_are_passed_through_unwrapped(self):
        agent = _RecordingAgent()
        _client(agent)._report_tool_event(
            {"type": "tool_execution_start", "toolName": "read", "args": {"path": "AGENTS.md"}})
        self.assertEqual(agent.calls[0][2], {"path": "AGENTS.md"})

    def test_tool_end_completes_the_call_with_its_result(self):
        agent = _RecordingAgent()
        client = _client(agent)
        client._report_tool_event({"type": "tool_execution_start", "toolName": "bash"})
        self.assertTrue(client._report_tool_event(
            {"type": "tool_execution_end", "toolName": "bash", "result": "hi"}))
        event_type, name, _args, kwargs = agent.calls[-1]
        self.assertEqual((event_type, name), ("tool.completed", "bash"))
        self.assertEqual(kwargs["result"], "hi")
        self.assertFalse(kwargs["is_error"])

    def test_end_event_without_a_name_closes_the_most_recent_open_call(self):
        # OMP does not guarantee toolName on the end event; an unmatched id would leave
        # the host's card spinning forever.
        agent = _RecordingAgent()
        client = _client(agent)
        client._report_tool_event({"type": "tool_execution_start", "toolName": "grep"})
        self.assertTrue(client._report_tool_event({"type": "tool_end"}))
        self.assertEqual(agent.calls[-1][1], "grep")

    def test_failed_tool_is_reported_as_an_error(self):
        agent = _RecordingAgent()
        client = _client(agent)
        client._report_tool_event({"type": "tool_execution_start", "toolName": "bash"})
        client._report_tool_event({"type": "tool_execution_end", "toolName": "bash", "error": "exit 1"})
        self.assertTrue(agent.calls[-1][3]["is_error"])

    def test_a_broken_host_callback_falls_back_to_text_instead_of_losing_the_tool(self):
        client = _client(_RecordingAgent(raises=True))
        self.assertFalse(client._report_tool_event({"type": "tool_execution_start", "toolName": "bash"}))

    def test_non_tool_events_are_left_to_the_text_renderer(self):
        # `[omp:pmr]` / `[omp:fallback]` notices are transcript content, not tool calls.
        agent = _RecordingAgent()
        client = _client(agent)
        self.assertFalse(client._report_tool_event(
            {"type": "extension_ui_request", "method": "notify", "message": "[omp:pmr] a -> b"}))
        self.assertFalse(client._report_tool_event(
            {"type": "retry_fallback_applied", "from": "a/b", "to": "c/d"}))
        self.assertEqual(agent.calls, [])


class NoPendingToolCallsTests(unittest.TestCase):
    """The thin-host contract: OMP already ran the tools, so Hermes must never be
    handed anything that looks like a call awaiting execution."""

    def _stream(self):
        stream = _OMPRPCStream.__new__(_OMPRPCStream)
        stream.model = "pmr/balanced"
        stream._final = SimpleNamespace(text="", reasoning="", stop_reason=None)
        return stream

    def test_text_and_reasoning_deltas_carry_no_tool_calls(self):
        stream = self._stream()
        for kind in ("text", "reasoning"):
            chunk = stream._chunk(kind, "x")
            self.assertIsNone(chunk.choices[0].delta.tool_calls, kind)

    def test_final_chunk_carries_no_tool_calls(self):
        self.assertIsNone(self._stream()._final_chunk().choices[0].delta.tool_calls)


class ProfileOptInTests(unittest.TestCase):
    def test_the_omp_profile_receives_and_keeps_the_agent_handle(self):
        import importlib.util

        spec = importlib.util.spec_from_file_location("omp_profile_under_test", ROOT / "__init__.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        agent = SimpleNamespace(tool_progress_callback=lambda *a, **k: None)
        client = module.omp.create_client(_hermes_agent=agent, model="pmr/balanced")
        try:
            self.assertIs(client._agent, agent)
        finally:
            client.is_closed = True


if __name__ == "__main__":
    unittest.main()
