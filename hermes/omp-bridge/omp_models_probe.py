#!/usr/bin/env python3
"""Metadata-only OMP model discovery for the omp-rpc provider.

Runs as a CHILD PROCESS so the caller's event loop state never matters: a fresh
interpreter, a fresh asyncio loop, `omp --mode rpc-ui` launched, models read,
process exits. Prints one JSON line: {"models": [id, ...]} on success or
{"error": "..."} on failure. No prompt, no inference, no tools executed.
"""

import asyncio
import json
import os
import sys

PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
if PLUGIN_DIR not in sys.path:
    sys.path.insert(0, PLUGIN_DIR)


def main() -> int:
    omp_bin = sys.argv[1] if len(sys.argv) > 1 else "/opt/homebrew/bin/omp"
    try:
        from omp_adapter.runtime import OMPRuntime
        from omp_adapter.mapping import MappingStore

        cwd = os.environ.get("OMP_PROBE_CWD", "/tmp/omp-models-probe")
        os.makedirs(cwd, exist_ok=True)
        store = MappingStore(str(os.path.join(cwd, "map-probe.db")),
                             str(os.path.join(cwd, "sessions-probe")))
        runtime = OMPRuntime(store, "/probe", "probe", cwd, command=[omp_bin])

        async def _probe():
            await runtime.start(timeout=30)
            try:
                rows = await runtime.models()
                return [m["id"] for m in rows if isinstance(m, dict) and isinstance(m.get("id"), str)]
            finally:
                await runtime.close()

        loop = asyncio.new_event_loop()
        try:
            ids = loop.run_until_complete(_probe())
        finally:
            loop.close()
        print(json.dumps({"models": ids or []}))
        return 0
    except Exception as exc:  # noqa: BLE001 — child process reports, not raises
        print(json.dumps({"error": f"{type(exc).__name__}: {exc}"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())