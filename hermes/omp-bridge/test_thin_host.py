"""Thin-host contract tests for the Hermes OMP adapter. No live inference."""
import hashlib
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from omp_adapter.mapping import MappingStore
from omp_adapter.runtime import OMPRuntime
from omp_rpc_client import OMPRPCClient, _latest_user_text


class LatestUserTextTests(unittest.TestCase):
    def test_ignores_system_tools_and_hermes_tool_bridge(self):
        messages = [
            {"role": "system", "content": "You are Hermes. Use <tool_call>."},
            {"role": "user", "content": "old question"},
            {"role": "assistant", "content": "old answer"},
            {"role": "user", "content": "list files"},
        ]
        self.assertEqual(_latest_user_text(messages), "list files")


class ThinHostRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_yolo_auto_confirms_without_ui(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
            cwd = Path(tmp)
            store = MappingStore(cwd / "map.db", cwd / "sessions")
            runtime = OMPRuntime(
                store, "/profile/a", "host-a", cwd,
                command=[sys.executable, str(ROOT / "fake_omp.py")],
                approval_mode="yolo", permission_policy="allow",
            )
            await runtime.start()
            try:
                launch = (await runtime.transport.request("get_launch"))["argv"]
                self.assertIn("yolo", launch)
                self.assertIn("--auto-approve", launch)
                events = [env["event"] async for env in runtime.turn("/permission")]
                result = next(e for e in events if e["type"] == "message_end")
                self.assertIn('"confirmed": true', result["message"]["content"][0]["text"])
                self.assertNotIn('"cancelled": true', result["message"]["content"][0]["text"])
            finally:
                await runtime.close()

    async def test_always_ask_denies_without_ui(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
            cwd = Path(tmp)
            store = MappingStore(cwd / "map.db", cwd / "sessions")
            runtime = OMPRuntime(
                store, "/profile/a", "host-b", cwd,
                command=[sys.executable, str(ROOT / "fake_omp.py")],
            )
            await runtime.start()
            try:
                launch = (await runtime.transport.request("get_launch"))["argv"]
                self.assertIn("always-ask", launch)
                events = [env["event"] async for env in runtime.turn("/permission")]
                result = next(e for e in events if e["type"] == "message_end")
                self.assertIn('"cancelled": true', result["message"]["content"][0]["text"])
            finally:
                await runtime.close()


class ThinHostClientTests(unittest.TestCase):
    def setUp(self):
        import omp_rpc_client as mod
        # Hermetic: never read the developer's real ~/.hermes memory in tests.
        self._real_memory_blocks = mod._load_memory_blocks
        mod._load_memory_blocks = lambda: []

    def tearDown(self):
        import omp_rpc_client as mod
        mod._load_memory_blocks = self._real_memory_blocks

    def _client(self, tmp):
        os.environ["HERMES_SESSION_ID"] = "sess-thin-host"
        client = OMPRPCClient(
            omp_command=[sys.executable, str(ROOT / "fake_omp.py")],
            acp_cwd=tmp,
            model="cursor/cursor-grok-4.6",
        )
        client._make_store = lambda: MappingStore(str(Path(tmp) / "map.db"), str(Path(tmp) / "sessions"))
        return client

    def test_does_not_emit_hermes_tool_calls_and_pins_nested_model(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
            client = self._client(tmp)
            try:
                completion = client.chat.completions.create(
                    model="cursor/cursor-grok-4.6",
                    messages=[
                        {"role": "system", "content": "use tools"},
                        {"role": "user", "content": "hello from hermes"},
                    ],
                    tools=[{"type": "function", "function": {"name": "terminal"}}],
                    stream=False,
                    timeout=15,
                )
                self.assertIsNone(completion.choices[0].message.tool_calls)
                self.assertEqual(completion.choices[0].finish_reason, "stop")
                self.assertEqual(completion.choices[0].message.content, "hello from hermes")
                self.assertEqual(client._runtime.state["model"],
                                 {"provider": "cursor", "id": "cursor-grok-4.6"})
            finally:
                client.close()

    def test_stream_finish_reason_and_tool_activity(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
            client = self._client(tmp)
            try:
                stream = client.chat.completions.create(
                    model="cursor/cursor-grok-4.6",
                    messages=[{"role": "user", "content": "/tool"}],
                    stream=True,
                    timeout=15,
                )
                chunks = list(stream)
                texts = [c.choices[0].delta.content for c in chunks if c.choices[0].delta.content]
                joined = "".join(texts)
                self.assertIn("[omp:bash]", joined)
                self.assertIn("did it", joined)
                self.assertEqual(chunks[-1].choices[0].finish_reason, "stop")
            finally:
                client.close()

    def test_two_clients_share_one_runtime(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
            a = self._client(tmp)
            b = self._client(tmp)
            try:
                a.chat.completions.create(
                    model="cursor/cursor-grok-4.6",
                    messages=[{"role": "user", "content": "one"}],
                    stream=False, timeout=15,
                )
                b.chat.completions.create(
                    model="cursor/cursor-grok-4.6",
                    messages=[{"role": "user", "content": "two"}],
                    stream=False, timeout=15,
                )
                self.assertIs(a._runtime, b._runtime)
            finally:
                a.close()
                b.close()

    def test_prompt_carries_hermes_memory_before_the_user_turn(self):
        import omp_rpc_client as mod
        original = mod._load_memory_blocks
        mod._load_memory_blocks = lambda: [
            "MEMORY (your personal notes)\nblokks deploys via cloud run",
            "USER PROFILE (who the user is)\nJared owns the squad",
        ]
        try:
            with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
                client = self._client(tmp)
                try:
                    completion = client.chat.completions.create(
                        model="cursor/cursor-grok-4.6",
                        messages=[{"role": "user", "content": "what do you remember"}],
                        stream=False, timeout=15,
                    )
                    text = completion.choices[0].message.content
                finally:
                    client.close()
        finally:
            mod._load_memory_blocks = original
        self.assertIn("blokks deploys via cloud run", text)
        self.assertIn("Jared owns the squad", text)
        self.assertTrue(text.rstrip().endswith("what do you remember"))
        self.assertLess(text.index("blokks deploys via cloud run"),
                        text.index("what do you remember"))

    def test_no_memory_preamble_when_memory_is_empty(self):
        import omp_rpc_client as mod
        original = mod._load_memory_blocks
        mod._load_memory_blocks = lambda: []
        try:
            with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
                client = self._client(tmp)
                try:
                    completion = client.chat.completions.create(
                        model="cursor/cursor-grok-4.6",
                        messages=[{"role": "user", "content": "plain turn"}],
                        stream=False, timeout=15,
                    )
                    self.assertEqual(completion.choices[0].message.content, "plain turn")
                finally:
                    client.close()
        finally:
            mod._load_memory_blocks = original

    def test_unreadable_memory_does_not_break_the_turn(self):
        import omp_rpc_client as mod
        original = mod._load_memory_blocks

        def _boom():
            raise RuntimeError("memory store unavailable")

        mod._load_memory_blocks = _boom
        try:
            with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
                client = self._client(tmp)
                try:
                    completion = client.chat.completions.create(
                        model="cursor/cursor-grok-4.6",
                        messages=[{"role": "user", "content": "still answered"}],
                        stream=False, timeout=15,
                    )
                    self.assertEqual(completion.choices[0].message.content, "still answered")
                finally:
                    client.close()
        finally:
            mod._load_memory_blocks = original

    def test_resumed_session_turn_is_never_sent_as_follow_up(self):
        """A cold --resume restores messageCount>0 without a live agent.

        Real OMP acks a follow_up in that state and then emits nothing, so the
        first turn must go out as a prompt — otherwise the chat stalls to its
        timeout and Hermes reports an empty reply.
        """
        with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
            cwd = str(Path(tmp).resolve())
            sessions = Path(tmp) / "sessions"
            sessions.mkdir()
            native = sessions / "synthetic-native.jsonl"
            native.write_text(json.dumps({
                "sessionId": "synthetic-native", "sessionFile": str(native),
                "model": {"provider": "backend", "id": "nested/model"},
                "isStreaming": False, "messageCount": 6}))
            os.environ["HERMES_SESSION_ID"] = "sess-thin-host"
            host_id = "hermes/rpc/" + hashlib.sha256(b"sess-thin-host").hexdigest()[:16]
            store = MappingStore(str(Path(tmp) / "map.db"), str(sessions))
            with sqlite3.connect(store.path) as db:
                db.execute("INSERT OR REPLACE INTO mappings VALUES (?,?,?,?,?,?)",
                           ("default", host_id, cwd, "synthetic-native", str(native),
                            "backend/nested/model"))
            client = OMPRPCClient(
                omp_command=[sys.executable, str(ROOT / "fake_omp.py")],
                acp_cwd=cwd, model="backend/nested/model",
            )
            client._make_store = lambda: store
            try:
                for turn in ("first after resume", "second turn"):
                    completion = client.chat.completions.create(
                        model="backend/nested/model",
                        messages=[{"role": "user", "content": turn}],
                        stream=False, timeout=10,
                    )
                    self.assertEqual(completion.choices[0].message.content, turn)
            finally:
                client.close()

    def test_auxiliary_caller_is_refused_before_spawn(self):
        import omp_rpc_client as mod
        original = mod.called_from_auxiliary
        mod.called_from_auxiliary = lambda: True
        try:
            with self.assertRaises(mod.OMPAuxiliaryUnsupported):
                mod.refuse_auxiliary_omp()
            with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
                client = self._client(tmp)
                try:
                    with self.assertRaises(mod.OMPAuxiliaryUnsupported):
                        client.chat.completions.create(
                            model="cursor/cursor-grok-4.6",
                            messages=[{"role": "user", "content": "title me"}],
                            stream=False, timeout=5,
                        )
                    self.assertIsNone(client._runtime)
                finally:
                    client.close()
        finally:
            mod.called_from_auxiliary = original


if __name__ == "__main__":
    unittest.main()
