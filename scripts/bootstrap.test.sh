#!/usr/bin/env bash
# Contract for scripts/bootstrap.sh — the one-command install path for humans and
# agents. Every check runs against a local clone in a temp directory; the real
# checkout's .git/config, extensions/, and ~/.hermes are never touched.
#
# Assertions are POSIX `[ … ]`, not `[[ … ]]`: see scripts/install-bridge.test.sh for why.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BOOTSTRAP="$ROOT/scripts/bootstrap.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# A real local copy, not a `git clone` (bootstrap.sh itself is new/untracked while this
# test is being developed) — bootstrap.sh's "already have a checkout" path resolves
# REPO_ROOT from $BASH_SOURCE, so running it from a copy must never touch this repo's
# own .git/config or extensions/.
CHECKOUT="$WORK/checkout"
mkdir -p "$CHECKOUT"
cp -a "$ROOT/." "$CHECKOUT/"
rm -rf "$CHECKOUT/extension/state.json" "$CHECKOUT/.secret-scan.attest"

FAKE_BIN="$WORK/bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/omp" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "config" && "${2:-}" == "path" ]]; then
  printf '%s\n' "$TEST_AGENT_DIR"
  exit 0
fi
if [[ "${1:-}" == "config" && "${2:-}" == "set" ]]; then
  printf '%q ' "$@" >> "$TEST_OMP_LOG"
  printf '\n' >> "$TEST_OMP_LOG"
  exit 0
fi
echo "unexpected omp invocation: $*" >&2
exit 2
FAKE
chmod +x "$FAKE_BIN/omp"

echo "test: existing checkout deploys the extension and sets hooksPath, not the bridge"
AGENT_DIR="$WORK/agent1"
LOG="$WORK/omp-calls-1.log"
mkdir -p "$AGENT_DIR"
TEST_AGENT_DIR="$AGENT_DIR" TEST_OMP_LOG="$LOG" HERMES_PLUGIN_DIR="$WORK/hermes-target-1" \
  PATH="$FAKE_BIN:$PATH" bash "$CHECKOUT/scripts/bootstrap.sh" >/dev/null
[ -f "$AGENT_DIR/extensions/adaptive-router/index.ts" ]
[ "$(git -C "$CHECKOUT" config core.hooksPath)" = ".githooks" ]
[ ! -d "$WORK/hermes-target-1" ]

echo "test: --bridge also deploys hermes/omp-bridge/ but not the launcher"
AGENT_DIR2="$WORK/agent2"
LOG2="$WORK/omp-calls-2.log"
mkdir -p "$AGENT_DIR2"
TEST_AGENT_DIR="$AGENT_DIR2" TEST_OMP_LOG="$LOG2" HERMES_PLUGIN_DIR="$WORK/hermes-target-2" \
  HERMES_BIN_DIR="$WORK/bin-target-2" PATH="$FAKE_BIN:$PATH" bash "$CHECKOUT/scripts/bootstrap.sh" --bridge >/dev/null
[ -f "$AGENT_DIR2/extensions/adaptive-router/index.ts" ]
[ -f "$WORK/hermes-target-2/omp_rpc_client.py" ]
[ ! -f "$WORK/bin-target-2/hermes" ]

echo "test: --launcher implies --bridge and installs the launcher wrapper"
AGENT_DIR3="$WORK/agent3"
LOG3="$WORK/omp-calls-3.log"
mkdir -p "$AGENT_DIR3"
TEST_AGENT_DIR="$AGENT_DIR3" TEST_OMP_LOG="$LOG3" HERMES_PLUGIN_DIR="$WORK/hermes-target-3" \
  HERMES_BIN_DIR="$WORK/bin-target-3" PATH="$FAKE_BIN:$PATH" bash "$CHECKOUT/scripts/bootstrap.sh" --launcher >/dev/null
[ -f "$AGENT_DIR3/extensions/adaptive-router/index.ts" ]
[ -f "$WORK/hermes-target-3/omp_rpc_client.py" ]
[ -x "$WORK/bin-target-3/hermes" ]

echo "test: an unknown flag is refused before any install runs"
AGENT_DIR4="$WORK/agent4"
mkdir -p "$AGENT_DIR4"
set +e
OUT="$(TEST_AGENT_DIR="$AGENT_DIR4" PATH="$FAKE_BIN:$PATH" bash "$CHECKOUT/scripts/bootstrap.sh" --nope 2>&1)"
STATUS=$?
set -e
[ "$STATUS" -eq 2 ]
printf '%s' "$OUT" | grep -q 'unknown argument: --nope'
[ ! -e "$AGENT_DIR4/extensions" ]

echo "test: piped execution (no on-disk script) clones a fresh checkout and installs"
PMR_DIR="$WORK/piped-checkout"
AGENT_DIR5="$WORK/agent5"
LOG5="$WORK/omp-calls-5.log"
mkdir -p "$AGENT_DIR5"
OUT5="$(TEST_AGENT_DIR="$AGENT_DIR5" TEST_OMP_LOG="$LOG5" PMR_DIR="$PMR_DIR" PMR_REPO_URL="$ROOT" \
  PATH="$FAKE_BIN:$PATH" bash -s -- < "$BOOTSTRAP" 2>&1)"
printf '%s' "$OUT5" | grep -q "poor-mans-router ready. Checkout: $PMR_DIR"
[ -d "$PMR_DIR/.git" ]
[ -f "$AGENT_DIR5/extensions/adaptive-router/index.ts" ]

echo "test: a second piped run fast-forwards the existing clone instead of re-cloning"
OUT6="$(TEST_AGENT_DIR="$AGENT_DIR5" TEST_OMP_LOG="$LOG5" PMR_DIR="$PMR_DIR" PMR_REPO_URL="$ROOT" \
  PATH="$FAKE_BIN:$PATH" bash -s -- < "$BOOTSTRAP" 2>&1)"
printf '%s' "$OUT6" | grep -qi 'up to date'

echo "bootstrap.test.sh: all checks passed"
