"""Streaming-fidelity contract tests for the OMP rpc-ui bridge (ROADMAP item 6).

Covers three unverified rows against ``_OMPRPCStream`` / ``_run_turn`` in
``omp_rpc_client.py``, using the synthetic ``fake_omp.py`` subprocess (no real
``omp`` binary, no network, no live inference):

1. Streaming  -- delta ordering, no drop/duplicate, tool-activity interleaving,
   and how an OMP-side failure surfaces through the stream.
2. Reasoning  -- ``thinking_delta`` stays on the reasoning channel and never
   leaks into ``delta.content`` / the final assembled message.
3. Termination -- whether a truncated/aborted/errored OMP turn is
   distinguishable from a clean one. Two of the tests below PIN a gap: the
   bridge does not currently make that distinction (see each docstring).
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from omp_adapter.mapping import MappingStore  # noqa: E402
from omp_rpc_client import OMPRPCClient  # noqa: E402


class _StreamFidelityTestCase(unittest.TestCase):
    def setUp(self):
        import omp_rpc_client as mod
        self._real_memory_blocks = mod._load_memory_blocks
        mod._load_memory_blocks = lambda: []

    def tearDown(self):
        import omp_rpc_client as mod
        mod._load_memory_blocks = self._real_memory_blocks

    def _client(self, tmp):
        os.environ["HERMES_SESSION_ID"] = "sess-stream-fidelity"
        client = OMPRPCClient(
            omp_command=[sys.executable, str(ROOT / "fake_omp.py")],
            acp_cwd=tmp,
            model="cursor/cursor-grok-4.6",
        )
        client._make_store = lambda: MappingStore(str(Path(tmp) / "map.db"), str(Path(tmp) / "sessions"))
        return client

    def _stream(self, prompt, timeout=15):
        with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
            client = self._client(tmp)
            try:
                stream = client.chat.completions.create(
                    model="cursor/cursor-grok-4.6",
                    messages=[{"role": "user", "content": prompt}],
                    stream=True, timeout=timeout,
                )
                chunks = []
                error = None
                try:
                    for chunk in stream:
                        chunks.append(chunk)
                except Exception as exc:  # noqa: BLE001 -- captured for assertion, not swallowed
                    error = exc
                return chunks, error
            finally:
                client.close()

    def _completion(self, prompt, timeout=15):
        with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
            client = self._client(tmp)
            try:
                return client.chat.completions.create(
                    model="cursor/cursor-grok-4.6",
                    messages=[{"role": "user", "content": prompt}],
                    stream=False, timeout=timeout,
                )
            finally:
                client.close()


class TextAndToolActivityOrderingTests(_StreamFidelityTestCase):
    def test_text_and_tool_activity_stream_in_exact_order_without_drop_or_duplicate(self):
        # fake_omp /interleave emits: text_delta A, tool_execution_start, command_output B,
        # tool_execution_end, text_delta C, then message_end (skipped: saw_text_delta=True).
        chunks, error = self._stream("/interleave")
        self.assertIsNone(error)
        parts = [c.choices[0].delta.content for c in chunks if c.choices[0].delta.content]
        self.assertEqual(parts, ["A", "\n[omp:bash] step1\n", "B\n", "C"])
        self.assertEqual(chunks[-1].choices[0].finish_reason, "stop")
        self.assertTrue(all(c.choices[0].finish_reason is None for c in chunks[:-1]))


class ReasoningChannelTests(_StreamFidelityTestCase):
    def test_thinking_delta_stream_stays_in_reasoning_channel_never_content(self):
        # fake_omp /think emits thinking_delta 'pondering', thinking_delta ' more',
        # then text_delta 'answer'.
        chunks, error = self._stream("/think")
        self.assertIsNone(error)
        deltas = [c.choices[0].delta for c in chunks[:-1]]
        self.assertEqual([d.reasoning_content for d in deltas], ["pondering", " more", None])
        self.assertEqual([d.reasoning for d in deltas], ["pondering", " more", None])
        self.assertEqual([d.content for d in deltas], [None, None, "answer"])
        # Every reasoning chunk carries no content, and the content chunk carries no reasoning.
        for d in deltas:
            if d.reasoning_content is not None:
                self.assertIsNone(d.content)
            if d.content is not None:
                self.assertIsNone(d.reasoning_content)
                self.assertIsNone(d.reasoning)
        joined_content = "".join(d.content or "" for d in deltas)
        joined_reasoning = "".join(d.reasoning_content or "" for d in deltas)
        self.assertEqual(joined_content, "answer")
        self.assertEqual(joined_reasoning, "pondering more")
        self.assertNotIn("pondering", joined_content)
        self.assertNotIn("answer", joined_reasoning)

    def test_non_streaming_message_keeps_reasoning_separate_from_content(self):
        completion = self._completion("/think")
        message = completion.choices[0].message
        self.assertEqual(message.content, "answer")
        self.assertEqual(message.reasoning, "pondering more")
        self.assertEqual(message.reasoning_content, "pondering more")
        self.assertNotIn("pondering", message.content)
        self.assertNotIn("answer", message.reasoning)


class TerminationFidelityTests(_StreamFidelityTestCase):
    def test_streaming_turn_failure_surfaces_the_error_instead_of_an_empty_stream(self):
        """fake_omp ``/latefail`` makes OMP's own ``prompt`` RPC fail (a second
        ``response`` with ``success: false``). ``OMPRuntime.turn()`` raises
        ``RPCError`` from inside the async generator and the producer captures it
        into ``self._failure``.

        The consumer must report it. It used to check ``_failure`` only once, at the
        top of ``__next__``, before blocking on the queue: the producer sets
        ``_failure`` and pushes ``("__done__", None)`` in the same breath, so a
        consumer already parked in ``queue.get()`` saw ``__done__`` first and raised
        a bare ``StopIteration`` — an OMP-side failure became a clean, EMPTY answer,
        while the non-streaming path raised for the identical failure.
        """
        chunks, error = self._stream("/latefail")
        self.assertEqual(chunks, [])
        self.assertIsNotNone(error)
        self.assertIn("synthetic failure", str(error))

    def test_non_streaming_turn_failure_raises_the_underlying_error(self):
        """The path that was always right, kept honest: ``_run_turn`` awaits the same
        ``_drive()`` coroutine directly, so the ``RPCError`` propagates. Both paths now
        agree for the identical underlying OMP failure.
        """
        with self.assertRaises(Exception) as ctx:
            self._completion("/latefail")
        self.assertIn("synthetic failure", str(ctx.exception))

    def test_natively_aborted_turn_is_not_reported_as_a_completed_answer(self):
        """fake_omp ``/native-abort`` streams one text delta and then ends the
        OMP-native message with ``stopReason: 'aborted'`` (no client called
        ``runtime.abort()``).

        The bridge used to close such a stream exactly like a successful turn
        (``finish_reason="stop"``), so truncation, cancellation and failure were
        indistinguishable downstream. An abort is not an answer: the partial text is
        still delivered, and then the stream errors.
        """
        chunks, error = self._stream("/native-abort")
        parts = [c.choices[0].delta.content for c in chunks if c.choices[0].delta.content]
        self.assertEqual(parts, ["partial"])
        self.assertIsNotNone(error)
        self.assertIn("aborted", str(error))

    def test_token_limit_stop_reason_maps_to_the_openai_length_vocabulary(self):
        """A truncated turn must be visible as ``length``, not ``stop`` — that
        distinction is the whole point of the mapping table.
        """
        from omp_rpc_client import _FINISH_REASONS

        self.assertEqual(_FINISH_REASONS["max_tokens"], "length")
        self.assertEqual(_FINISH_REASONS["truncated"], "length")
        self.assertEqual(_FINISH_REASONS["stop"], "stop")
        self.assertEqual(_FINISH_REASONS["tool_use"], "tool_calls")


if __name__ == "__main__":
    unittest.main()
