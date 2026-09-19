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

TEST_AGENT_DIR="$AGENT_DIR" TEST_OMP_LOG="$LOG" PATH="$FAKE_BIN:$PATH" bash "$ROOT/scripts/install.sh"

DEST="$AGENT_DIR/extensions/adaptive-router"
[ -f "$DEST/index.ts" ]
[ -f "$DEST/policy.yml" ]
[ ! -e "$DEST/state.json" ]
[ ! -d "$DEST/tests" ]
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
TEST_AGENT_DIR="$AGENT_DIR" TEST_OMP_LOG="$LOG" PATH="$FAKE_BIN:$PATH" bash "$ROOT/scripts/install.sh"
[ -f "$DEST/index.ts" ]
find "$AGENT_DIR/backups" -type f -name sentinel.txt -print -quit | grep -q sentinel.txt

# Uninstall removes only the extension and leaves the native OMP settings alone.
TEST_AGENT_DIR="$AGENT_DIR" TEST_OMP_LOG="$LOG" PATH="$FAKE_BIN:$PATH" bash "$ROOT/scripts/uninstall.sh"
[ ! -e "$DEST" ]

# --- Deploy lock (ROADMAP item 2) ---------------------------------------------

# Second fake omp: config set can be made to fail on demand, to exercise the
# lock-release-on-failure path without touching install.sh's real logic.
FAKE_BIN2="$TMP/bin2"
mkdir -p "$FAKE_BIN2"
cat > "$FAKE_BIN2/omp" <<'FAKE2'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "config" && "${2:-}" == "path" ]]; then
  printf '%s\n' "$TEST_AGENT_DIR"
  exit 0
fi
if [[ "${1:-}" == "config" && "${2:-}" == "set" ]]; then
  if [[ "${TEST_FAIL_CONFIG_SET:-0}" == "1" ]]; then
    echo "simulated config set failure" >&2
    exit 9
  fi
  exit 0
fi
echo "unexpected omp invocation: $*" >&2
exit 2
FAKE2
chmod +x "$FAKE_BIN2/omp"

LOCK_AGENT_DIR="$TMP/lock agent"
mkdir -p "$LOCK_AGENT_DIR"
LOCK_DIR="$LOCK_AGENT_DIR/extensions/.adaptive-router-deploy.lock"
LOCK_DEST="$LOCK_AGENT_DIR/extensions/adaptive-router"

# write_lock <pid> <age_seconds> <session> writes a lock dir the way install.sh
# would, but backdated by <age_seconds>, to drive the reclaim decision.
write_lock() {
  local pid="$1" age="$2" session="$3"
  local now started_epoch started_iso
  mkdir -p "$LOCK_AGENT_DIR/extensions"
  rm -rf "$LOCK_DIR"
  mkdir "$LOCK_DIR"
  now="$(date -u +%s)"
  started_epoch=$((now - age))
  started_iso="$(date -u -r "$started_epoch" +%Y-%m-%dT%H:%M:%SZ)"
  printf '{"pid": %s, "session": "%s", "started_at": "%s"}\n' "$pid" "$session" "$started_iso" > "$LOCK_DIR/meta.json"
  printf '%s\n' "$started_epoch" > "$LOCK_DIR/.started_at_epoch"
}

echo "test: concurrent install refuses while a fresh lock is held"
write_lock "$$" 5 "concurrent-holder"
set +e
LOCK_OUT="$(TEST_AGENT_DIR="$LOCK_AGENT_DIR" TEST_OMP_LOG="$LOG" PATH="$FAKE_BIN:$PATH" bash "$ROOT/scripts/install.sh" 2>&1)"
LOCK_STATUS=$?
set -e
[ "$LOCK_STATUS" -ne 0 ]
printf '%s\n' "$LOCK_OUT" | grep -q 'deploy lock'
printf '%s\n' "$LOCK_OUT" | grep -q 'concurrent-holder'
[ ! -e "$LOCK_DEST" ]
[ -d "$LOCK_DIR" ]
grep -q 'concurrent-holder' "$LOCK_DIR/meta.json"

echo "test: lock with a dead pid is reclaimed"
( : ) & DEAD_PID=$!
wait "$DEAD_PID" 2>/dev/null || true
write_lock "$DEAD_PID" 5 "dead-pid-holder"
set +e
LOCK_OUT="$(TEST_AGENT_DIR="$LOCK_AGENT_DIR" TEST_OMP_LOG="$LOG" PATH="$FAKE_BIN:$PATH" bash "$ROOT/scripts/install.sh" 2>&1)"
LOCK_STATUS=$?
set -e
[ "$LOCK_STATUS" -eq 0 ]
printf '%s\n' "$LOCK_OUT" | grep -qi 'reclaim'
printf '%s\n' "$LOCK_OUT" | grep -q 'dead-pid-holder'
[ -f "$LOCK_DEST/index.ts" ]
[ ! -d "$LOCK_DIR" ]

echo "test: lock older than the stale window is reclaimed"
write_lock "$$" 700 "stale-age-holder"
set +e
LOCK_OUT="$(TEST_AGENT_DIR="$LOCK_AGENT_DIR" TEST_OMP_LOG="$LOG" PATH="$FAKE_BIN:$PATH" bash "$ROOT/scripts/install.sh" 2>&1)"
LOCK_STATUS=$?
set -e
[ "$LOCK_STATUS" -eq 0 ]
printf '%s\n' "$LOCK_OUT" | grep -qi 'reclaim'
printf '%s\n' "$LOCK_OUT" | grep -q 'stale-age-holder'
[ -f "$LOCK_DEST/index.ts" ]
[ ! -d "$LOCK_DIR" ]

echo "test: lock directory absent after a successful install"
CLEAN_AGENT_DIR="$TMP/clean agent"
mkdir -p "$CLEAN_AGENT_DIR"
TEST_AGENT_DIR="$CLEAN_AGENT_DIR" TEST_OMP_LOG="$LOG" PATH="$FAKE_BIN:$PATH" bash "$ROOT/scripts/install.sh"
[ -f "$CLEAN_AGENT_DIR/extensions/adaptive-router/index.ts" ]
[ ! -d "$CLEAN_AGENT_DIR/extensions/.adaptive-router-deploy.lock" ]

echo "test: lock directory absent after a failed install"
FAIL_AGENT_DIR="$TMP/fail agent"
mkdir -p "$FAIL_AGENT_DIR"
set +e
FAIL_OUT="$(TEST_AGENT_DIR="$FAIL_AGENT_DIR" TEST_FAIL_CONFIG_SET=1 PATH="$FAKE_BIN2:$PATH" bash "$ROOT/scripts/install.sh" 2>&1)"
FAIL_STATUS=$?
set -e
[ "$FAIL_STATUS" -ne 0 ]
printf '%s\n' "$FAIL_OUT" | grep -q 'simulated config set failure'
[ ! -d "$FAIL_AGENT_DIR/extensions/.adaptive-router-deploy.lock" ]

echo "install.test.sh: all checks passed"
