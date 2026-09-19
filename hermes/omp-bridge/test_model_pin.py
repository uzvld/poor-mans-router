"""Model pinning must never leave a turn on a model Hermes did not ask for.

Real failure this guards (2026-09-19): Multica's picker sends Hermes-provider-prefixed
ids (`omp:anthropic/claude-fable-5-1`). OMP's `set_model` takes the native
`provider/modelId`, so the prefixed form partitioned into provider `omp:anthropic`
and OMP replied "Model not found" — and `_pin_model` swallowed it with `except
Exception: pass`. The turn then ran on OMP's own persisted current model
(observed: `kilo/kilo-auto/efficient`), with nothing reported to Hermes or Multica.
"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from omp_rpc_client import OMPRPCClient, _native_model_id  # noqa: E402


class _StubRuntime:
    """Mimics OMPRuntime.set_model: native provider/modelId only, unknown → RPCError."""

    def __init__(self, current="kilo/kilo-auto/efficient", known=("pmr/balanced", "anthropic/claude-sonnet-5")):
        provider, _, native = current.partition("/")
        self.state = {"model": {"provider": provider, "id": native}}
        self.known = set(known)
        self.calls: list[str] = []

    def set_model(self, model_id: str):
        self.calls.append(model_id)
        if model_id not in self.known:
            raise RuntimeError(f"OMP set_model: Model not found: {model_id}")
        provider, _, native = model_id.partition("/")
        self.state["model"] = {"provider": provider, "id": native}
        return self.state["model"]


def _client(runtime):
    client = OMPRPCClient.__new__(OMPRPCClient)
    client._runtime = runtime
    client._await_async = lambda value, _timeout=None: value
    return client


class NativeModelIdTests(unittest.TestCase):
    def test_hermes_provider_prefix_is_stripped(self):
        self.assertEqual(_native_model_id("omp:pmr/balanced"), "pmr/balanced")
        self.assertEqual(_native_model_id("omp:anthropic/claude-fable-5-1"), "anthropic/claude-fable-5-1")

    def test_profile_aliases_are_stripped(self):
        for prefixed in ("oh-my-pi:pmr/small", "omp-rpc:pmr/small", "OMP:pmr/small"):
            self.assertEqual(_native_model_id(prefixed), "pmr/small", prefixed)

    def test_bare_nested_ids_pass_through_untouched(self):
        # OMP ids carry their own slashes; nothing but the host prefix may be removed.
        self.assertEqual(_native_model_id("kilo/kilo-auto/free"), "kilo/kilo-auto/free")
        self.assertEqual(_native_model_id("openrouter/stealth/union-alpha"), "openrouter/stealth/union-alpha")

    def test_empty_input_is_not_a_model(self):
        self.assertIsNone(_native_model_id(None))
        self.assertIsNone(_native_model_id("   "))


class PinModelTests(unittest.TestCase):
    def test_prefixed_picker_id_pins_the_native_model(self):
        runtime = _StubRuntime()
        _client(runtime)._pin_model("omp:pmr/balanced")
        self.assertEqual(runtime.calls, ["pmr/balanced"])
        self.assertEqual(runtime.state["model"], {"provider": "pmr", "id": "balanced"})

    def test_rejected_model_fails_the_turn_instead_of_running_on_the_wrong_one(self):
        runtime = _StubRuntime()
        with self.assertRaises(RuntimeError) as ctx:
            _client(runtime)._pin_model("typo/does-not-exist")
        message = str(ctx.exception)
        self.assertIn("typo/does-not-exist", message)
        self.assertIn("kilo/kilo-auto/efficient", message)
        self.assertEqual(runtime.state["model"], {"provider": "kilo", "id": "kilo-auto/efficient"})

    def test_acked_switch_that_does_not_move_is_a_failure(self):
        runtime = _StubRuntime(known=("pmr/balanced",))
        runtime.set_model = lambda model_id: runtime.calls.append(model_id)  # acks, changes nothing
        with self.assertRaises(RuntimeError):
            _client(runtime)._pin_model("pmr/balanced")

    def test_already_current_is_a_no_op(self):
        runtime = _StubRuntime(current="pmr/balanced")
        _client(runtime)._pin_model("omp:pmr/balanced")
        self.assertEqual(runtime.calls, [])


if __name__ == "__main__":
    unittest.main()
