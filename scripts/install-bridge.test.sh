#!/usr/bin/env bash
# Contract for scripts/install-bridge.sh — the repo is the source of truth for the
# Hermes OMP bridge, and `--check` is what proves the live plugin directory still
# matches it. Every check runs against a temporary target; the real
# ~/.hermes/plugins/model-providers/omp is never touched.
#
# Assertions are POSIX `[ … ]`, not `[[ … ]]`: under macOS bash 3.2 a bare `[[ … ]]`
# that fails does NOT trip `set -e` unless it is the script's last statement, which is
# how a whole file of assertions can silently pass (see scripts/install.test.sh).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INSTALLER="$REPO_DIR/scripts/install-bridge.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "test: --check reports every file missing on a virgin target"
out="$(HERMES_PLUGIN_DIR="$WORK/empty" bash "$INSTALLER" --check 2>&1)" && rc=0 || rc=$?
[ "$rc" -ne 0 ]
printf '%s' "$out" | grep -q "MISSING   omp_rpc_client.py"
printf '%s' "$out" | grep -q "MISSING   omp_adapter/runtime.py"

echo "test: deploy makes --check clean, nested files included"
HERMES_PLUGIN_DIR="$WORK/target" bash "$INSTALLER" >/dev/null
[ -f "$WORK/target/omp_rpc_client.py" ]
[ -f "$WORK/target/omp_adapter/runtime.py" ]
[ -x "$WORK/target/hermes-launcher.sh" ]
HERMES_PLUGIN_DIR="$WORK/target" bash "$INSTALLER" --check >/dev/null

echo "test: a locally edited plugin file is reported as drift"
echo "# local hack" >>"$WORK/target/omp_rpc_client.py"
out="$(HERMES_PLUGIN_DIR="$WORK/target" bash "$INSTALLER" --check 2>&1)" && rc=0 || rc=$?
[ "$rc" -ne 0 ]
printf '%s' "$out" | grep -q "DIFFERS   omp_rpc_client.py"

echo "test: redeploy backs the edited file up instead of destroying it"
HERMES_PLUGIN_DIR="$WORK/target" bash "$INSTALLER" >/dev/null
HERMES_PLUGIN_DIR="$WORK/target" bash "$INSTALLER" --check >/dev/null
backup="$(ls "$WORK/target"/omp_rpc_client.py.bak-* 2>/dev/null | head -1)"
[ -n "$backup" ]
grep -q "# local hack" "$backup"

echo "test: machine state is never deployed into the plugin directory"
# __pycache__, state databases and .bak-* files belong to the machine. If the installer
# shipped them, a deploy would overwrite live runtime state.
[ ! -d "$WORK/target/__pycache__" ]
[ -z "$(find "$WORK/target" -name '*.pyc' -o -name '*.db' | head -1)" ]

echo "test: --launcher installs the wrapper and keeps the previous one"
mkdir -p "$WORK/bin"
printf '#!/bin/sh\necho old-launcher\n' >"$WORK/bin/hermes"
chmod +x "$WORK/bin/hermes"
HERMES_PLUGIN_DIR="$WORK/target2" HERMES_BIN_DIR="$WORK/bin" bash "$INSTALLER" --launcher >/dev/null
grep -q "re-integrates OMP after an update" "$WORK/bin/hermes"
[ -x "$WORK/bin/hermes" ]
grep -q "old-launcher" "$(ls "$WORK/bin"/hermes.bak-* | head -1)"

echo "test: the launcher is not touched without --launcher"
printf '#!/bin/sh\necho untouched\n' >"$WORK/bin/hermes"
HERMES_PLUGIN_DIR="$WORK/target3" HERMES_BIN_DIR="$WORK/bin" bash "$INSTALLER" >/dev/null
grep -q "untouched" "$WORK/bin/hermes"

echo "test: an unknown argument is refused"
HERMES_PLUGIN_DIR="$WORK/target4" bash "$INSTALLER" --nope >/dev/null 2>&1 && rc=0 || rc=$?
[ "$rc" -eq 2 ]

echo "install-bridge.test.sh: all checks passed"
