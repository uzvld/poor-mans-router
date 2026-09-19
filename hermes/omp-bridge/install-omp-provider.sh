#!/usr/bin/env bash
# Re-apply the local OMP provider integration to the Hermes agent checkout.
#
# Why: the omp provider lives partly as an out-of-tree plugin
# (~/.hermes/plugins/model-providers/omp/) and partly as three small edits to
# the LOCAL hermes-agent checkout (agent/agent_init.py, hermes_cli/providers.py,
# hermes_cli/model_switch_providers.py). A `hermes update` overwrites the
# checkout and silently reverts those edits. This script re-applies them
# idempotently, then tells you to restart Hermes.
#
# Usage:
#   bash install-omp-provider.sh            # apply
#   bash install-omp-provider.sh --check    # verify (no write)
set -eu
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARGS=()
if [ "${1:-}" = "--check" ]; then ARGS+=(--check); fi
exec python3 "$DIR/reapply_omp_patches.py" "${ARGS[@]}"