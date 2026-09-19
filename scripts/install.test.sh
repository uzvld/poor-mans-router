#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
AGENT_DIR="$TMP/agent profile"
FAKE_BIN="$TMP/bin"
LOG="$TMP/omp-calls.log"
mkdir -p "$AGENT_DIR" "$FAKE_BIN"
printf 'retry:\n  enabled: true\n' > "$AGENT_DIR/config.yml"

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

TEST_AGENT_DIR="$AGENT_DIR" TEST_OMP_LOG="$LOG" PATH="$FAKE_BIN:$PATH" bash "$ROOT/install.sh"

DEST="$AGENT_DIR/extensions/adaptive-router"
[[ -f "$DEST/index.ts" ]]
[[ -f "$DEST/policy.yml" ]]
[[ ! -e "$DEST/state.json" ]]
[[ ! -d "$DEST/tests" ]]
find "$AGENT_DIR/backups" -type f -name 'config.yml-pre-adaptive-router-*' -print -quit | grep -q config.yml-pre-adaptive-router

grep -q 'retry.usageAwareFallback true' "$LOG"
grep -q 'retry.usageReservePct 10' "$LOG"
grep -q 'retry.usageReservePolicy auto' "$LOG"
grep -q 'retry.waitForUsageReset false' "$LOG"
grep -q 'task.showResolvedModelBadge true' "$LOG"
! grep -q 'fallbackChains' "$LOG"
! grep -q 'OPENROUTER' "$LOG"

# Reinstall backs up existing extension outside extensions/ and does not break the destination.
printf 'sentinel\n' > "$DEST/sentinel.txt"
TEST_AGENT_DIR="$AGENT_DIR" TEST_OMP_LOG="$LOG" PATH="$FAKE_BIN:$PATH" bash "$ROOT/install.sh"
[[ -f "$DEST/index.ts" ]]
find "$AGENT_DIR/backups" -type f -name sentinel.txt -print -quit | grep -q sentinel.txt

# Uninstall removes only the extension and leaves the native OMP settings alone.
TEST_AGENT_DIR="$AGENT_DIR" TEST_OMP_LOG="$LOG" PATH="$FAKE_BIN:$PATH" bash "$ROOT/uninstall.sh"
[[ ! -e "$DEST" ]]
