#!/usr/bin/env bash
# Hermes launcher that re-integrates OMP after an update.
#
# `hermes update` replaces the whole hermes-agent tree. Every OMP core patch scripted in
# reapply_omp_patches.py is wiped by it — on 2026-09-19 all 15 were missing, which is why
# Multica's model picker had silently lost every OMP model (the ACP catalog was down to a
# single fallback row) — and the Electron app is rebuilt from those unpatched sources.
#
# A hook inside hermes-agent cannot repair that: it is deleted before it could run. This
# wrapper lives in ~/.local/bin, outside the replaced tree, so it is the only place that
# survives the wipe. Install it over ~/.local/bin/hermes.
#
# Everything except `hermes update` is exec'd straight through — zero added latency and no
# behaviour change on the hot path.
set -uo pipefail
unset PYTHONPATH
unset PYTHONHOME

HERMES_PYTHON="${HERMES_PYTHON:-$HOME/.hermes/hermes-agent/venv/bin/python}"
HERMES_ENTRY="${HERMES_ENTRY:-$HOME/.hermes/hermes-agent/hermes}"
OMP_REAPPLY="${OMP_REAPPLY:-$HOME/.hermes/plugins/model-providers/omp/reapply_omp_patches.py}"

if [ "${1:-}" != "update" ]; then
  exec "$HERMES_PYTHON" "$HERMES_ENTRY" "$@"
fi

"$HERMES_PYTHON" "$HERMES_ENTRY" "$@"
update_rc=$?

# The update's own exit code is what the caller (and the gateway's .update_exit_code)
# cares about; re-integration reports separately and never masks it.
if [ ! -f "$OMP_REAPPLY" ]; then
  exit "$update_rc"
fi

echo
echo "→ Re-applying the OMP core patches this update wiped..."
reapply_out="$("$HERMES_PYTHON" "$OMP_REAPPLY" 2>&1)"
reapply_rc=$?
printf '%s\n' "$reapply_out"

if [ "$reapply_rc" -ne 0 ]; then
  echo "✗ OMP re-integration NEEDS HAND FIX: the model picker and the thin-host tool rail" >&2
  echo "  stay degraded until it is resolved. Reconcile the failing anchor by hand, then" >&2
  echo "  run: $OMP_REAPPLY" >&2
  exit "$update_rc"
fi

# `hermes update` already rebuilt the desktop app — from the unpatched sources. If the
# renderer was re-patched just now, that build is stale by exactly those patches.
if printf '%s' "$reapply_out" | grep -q 'apps/desktop.*patched'; then
  echo "→ Desktop sources were re-patched; rebuilding the Electron app..."
  if ! "$HERMES_PYTHON" "$HERMES_ENTRY" desktop --build-only --force-build; then
    echo "✗ Desktop rebuild failed. Run: hermes desktop --build-only --force-build" >&2
  fi
fi

exit "$update_rc"
