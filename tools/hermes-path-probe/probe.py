#!/usr/bin/env python3
"""Does the router govern the `multica -> hermes -> omp` path?

Falsifies the original host-integration verdict ("no OMP agent process, no
extension, `pmr/*` cannot exist there") by driving the Hermes bridge's OWN
runtime against the real `omp` binary over `--mode rpc-ui`:

  1. list the catalog the bridge sees      -> `pmr/*` present means the
     extension ran `registerProvider('pmr')` inside that process;
  2. pin `pmr/balanced` the way the bridge does (`runtime.set_model`);
  3. run one turn and print every event naming a model or router notice.

Expected output (2026-09-19, OMP 18.2.6, installed adaptive-router):

    pmr in catalog: ['pmr/frontier', 'pmr/balanced', 'pmr/small', 'pmr/free']
    state.model after pin: provider "pmr", baseUrl http://127.0.0.1:9
    [omp:pmr] pmr/balanced -> anthropic/claude-sonnet-5 (available sonnet-sub; ...)
    message_start: provider "anthropic", model "claude-sonnet-5"

Requires the Hermes OMP bridge plugin (read-only: nothing here writes to
`~/.hermes`). Costs one real inference call on whatever the router picks.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile

PLUGIN = os.environ.get(
    "OMP_BRIDGE_DIR", os.path.expanduser("~/.hermes/plugins/model-providers/omp")
)
OMP = os.environ.get("OMP_BIN", "/opt/homebrew/bin/omp")
PROMPT = "Reply with exactly: PMR_HERMES_OK"
SELECTOR = os.environ.get("PMR_SELECTOR", "pmr/balanced")


async def probe() -> int:
    sys.path.insert(0, PLUGIN)
    from omp_adapter.mapping import MappingStore  # noqa: PLC0415 — plugin path set above
    from omp_adapter.runtime import OMPRuntime  # noqa: PLC0415

    cwd = tempfile.mkdtemp(prefix="pmr-hermes-probe-")
    store = MappingStore(os.path.join(cwd, "map.db"), os.path.join(cwd, "sessions"))
    runtime = OMPRuntime(
        store, "/probe", "pmr-probe", cwd, command=[OMP],
        approval_mode="yolo", permission_policy="allow",
    )
    await runtime.start(timeout=60)
    try:
        ids = [m["id"] for m in await runtime.models() if isinstance(m, dict)]
        virtual = [i for i in ids if i.startswith("pmr/")]
        print(f"catalog: {len(ids)} models | pmr selectors: {virtual}")
        if SELECTOR not in virtual:
            print(f"FAIL: {SELECTOR} absent — extension did not register in rpc-ui mode")
            return 1

        await runtime.set_model(SELECTOR)
        pinned = (runtime.state or {}).get("model") or {}
        print(f"pinned: {pinned.get('provider')}/{pinned.get('id')} baseUrl={pinned.get('baseUrl')}")

        answer: list[str] = []
        routed_to: str | None = None
        notices: list[str] = []
        async for env in runtime.turn(PROMPT, timeout=180):
            event = env.get("event") or {}
            kind = event.get("type") or ""
            if kind == "message_update":
                delta = event.get("assistantMessageEvent") or {}
                if delta.get("type") == "text_delta" and delta.get("delta"):
                    answer.append(delta["delta"])
            elif kind in {"message_start", "message_end", "turn_end"}:
                message = event.get("message") or {}
                if message.get("provider") and message.get("model"):
                    routed_to = f"{message['provider']}/{message['model']}"
            elif kind == "extension_ui_request" and event.get("method") == "notify":
                text = str(event.get("message") or "")
                if text.startswith("[omp:"):
                    notices.append(text)

        for notice in notices:
            print(notice)
        print(f"inference ran on: {routed_to}")
        print(f"answer: {''.join(answer).strip()[:200]}")

        if routed_to is None or routed_to.startswith("pmr/"):
            print("FAIL: turn never left the virtual provider")
            return 1
        print("PASS: the router governs multica -> hermes -> omp")
        return 0
    finally:
        await runtime.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(probe()))
