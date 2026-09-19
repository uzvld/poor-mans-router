#!/usr/bin/env bash
set -euo pipefail

SKIP_WARMUP="${ADAPTIVE_ROUTER_SKIP_WARMUP:-0}"
for arg in "$@"; do
  if [[ "$arg" == "--skip-warmup" ]]; then SKIP_WARMUP=1; fi
done

OMP_BIN="${OMP_BIN:-omp}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if [[ -d "$REPO_ROOT/extension" ]]; then
  SOURCE_DIR="$REPO_ROOT/extension"
elif [[ -d "$SCRIPT_DIR/adaptive-router" ]]; then
  SOURCE_DIR="$SCRIPT_DIR/adaptive-router"
elif [[ -d "$SCRIPT_DIR/extension" ]]; then
  SOURCE_DIR="$SCRIPT_DIR/extension"
else
  echo "adaptive-router source directory not found (expected <repo>/extension)" >&2
  exit 1
fi

if ! command -v "$OMP_BIN" >/dev/null 2>&1; then
  echo "OMP executable not found: $OMP_BIN" >&2
  exit 1
fi

AGENT_DIR="$($OMP_BIN config path | tail -n 1)"
if [[ -z "$AGENT_DIR" ]]; then
  echo "omp config path returned an empty agent directory" >&2
  exit 1
fi

DEPLOY_LOCK_DIR="$AGENT_DIR/extensions/.adaptive-router-deploy.lock"
DEPLOY_LOCK_STALE_SECONDS=600
DEPLOY_LOCK_ACQUIRED=0

release_deploy_lock() {
  if [[ "$DEPLOY_LOCK_ACQUIRED" == "1" ]]; then
    rm -rf "$DEPLOY_LOCK_DIR"
  fi
}
trap release_deploy_lock EXIT

mkdir -p "$AGENT_DIR/extensions"
DEPLOY_LOCK_WAIT_ATTEMPTS=0
while true; do
  if mkdir "$DEPLOY_LOCK_DIR" 2>/dev/null; then
    DEPLOY_LOCK_ACQUIRED=1
    DEPLOY_LOCK_SESSION="${OMP_SESSION_ID:-unknown}"
    DEPLOY_LOCK_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '{"pid": %s, "session": "%s", "started_at": "%s"}\n' \
      "$$" "$DEPLOY_LOCK_SESSION" "$DEPLOY_LOCK_STARTED_AT" > "$DEPLOY_LOCK_DIR/meta.json"
    date -u +%s > "$DEPLOY_LOCK_DIR/.started_at_epoch"
    break
  fi

  if [[ ! -f "$DEPLOY_LOCK_DIR/meta.json" ]]; then
    DEPLOY_LOCK_WAIT_ATTEMPTS=$((DEPLOY_LOCK_WAIT_ATTEMPTS + 1))
    if [[ "$DEPLOY_LOCK_WAIT_ATTEMPTS" -gt 5 ]]; then
      echo "adaptive-router deploy lock at $DEPLOY_LOCK_DIR is missing meta.json; refusing to guess ownership" >&2
      exit 1
    fi
    sleep 1
    continue
  fi

  HOLDER_PID="$(sed -n 's/.*"pid": *\([0-9]*\).*/\1/p' "$DEPLOY_LOCK_DIR/meta.json" | head -n1)"
  HOLDER_SESSION="$(sed -n 's/.*"session": *"\([^"]*\)".*/\1/p' "$DEPLOY_LOCK_DIR/meta.json" | head -n1)"
  HOLDER_STARTED_AT="$(sed -n 's/.*"started_at": *"\([^"]*\)".*/\1/p' "$DEPLOY_LOCK_DIR/meta.json" | head -n1)"
  HOLDER_EPOCH="$(cat "$DEPLOY_LOCK_DIR/.started_at_epoch" 2>/dev/null || echo 0)"
  NOW_EPOCH="$(date -u +%s)"
  DEPLOY_LOCK_AGE=$((NOW_EPOCH - HOLDER_EPOCH))

  DEPLOY_LOCK_STALE=0
  if [[ "$DEPLOY_LOCK_AGE" -gt "$DEPLOY_LOCK_STALE_SECONDS" ]]; then
    DEPLOY_LOCK_STALE=1
  elif [[ -n "$HOLDER_PID" ]] && ! kill -0 "$HOLDER_PID" 2>/dev/null; then
    DEPLOY_LOCK_STALE=1
  fi

  if [[ "$DEPLOY_LOCK_STALE" == "1" ]]; then
    echo "Reclaiming stale adaptive-router deploy lock: pid=$HOLDER_PID session=$HOLDER_SESSION started_at=$HOLDER_STARTED_AT age=${DEPLOY_LOCK_AGE}s" >&2
    rm -rf "$DEPLOY_LOCK_DIR"
    continue
  fi

  echo "adaptive-router deploy lock is held by pid=$HOLDER_PID session=$HOLDER_SESSION started_at=$HOLDER_STARTED_AT age=${DEPLOY_LOCK_AGE}s: $DEPLOY_LOCK_DIR" >&2
  exit 1
done

DEST="$AGENT_DIR/extensions/adaptive-router"
BACKUP_ROOT="$AGENT_DIR/backups"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$AGENT_DIR/extensions" "$BACKUP_ROOT"

for config_name in config.yml config.yaml; do
  config_path="$AGENT_DIR/$config_name"
  if [[ -f "$config_path" ]]; then
    cp "$config_path" "$BACKUP_ROOT/${config_name}-pre-adaptive-router-$STAMP"
  fi
done

if [[ -d "$DEST" ]]; then
  BACKUP="$BACKUP_ROOT/adaptive-router-$STAMP"
  suffix=0
  while [[ -e "$BACKUP" ]]; do
    suffix=$((suffix + 1))
    BACKUP="$BACKUP_ROOT/adaptive-router-$STAMP-$suffix"
  done
  cp -a "$DEST" "$BACKUP"
  echo "Backed up existing adaptive-router to: $BACKUP"
fi

STAGING="$AGENT_DIR/extensions/.adaptive-router-install-$$"
rm -rf "$STAGING"
mkdir -p "$STAGING"
for src in "$SOURCE_DIR"/*.ts "$SOURCE_DIR"/policy.yml; do
  [[ -e "$src" ]] || continue
  cp "$src" "$STAGING/"
done

rm -rf "$DEST"
mv "$STAGING" "$DEST"

# Keep OMP itself responsible for reactive retries/fallbacks. These are intentionally
# narrow config mutations: modelRoles and fallbackChains are never overwritten here.
"$OMP_BIN" config set retry.enabled true
"$OMP_BIN" config set retry.modelFallback true
"$OMP_BIN" config set retry.fallbackRevertPolicy cooldown-expiry
"$OMP_BIN" config set retry.usageAwareFallback true
"$OMP_BIN" config set retry.usageReservePct 10
"$OMP_BIN" config set retry.usageReservePolicy auto
"$OMP_BIN" config set retry.waitForUsageReset false
"$OMP_BIN" config set task.showResolvedModelBadge true

# Live incident 2026-09-19 (docs/investigations/multica-repeated-switch-marker.md ·
# Follow-up 2): a long-lived `omp --mode rpc-ui` session loads adaptive-router's code
# into memory ONCE at its own startup and keeps it there for the life of the process.
# Its background `refreshLive()` timer still calls `state.save()` on the OLD in-memory
# code every few minutes -- on any version before the per-route merge (state.ts), that
# is a plain whole-file overwrite that silently erases every cooldown a freshly-started
# process (or this install) just recorded, undoing the fix with no error anywhere.
# Restarting OMP is therefore not optional cleanup -- skip it and the previous binary
# keeps corrupting the very state this install just fixed.
STALE_RPC_PIDS="$(pgrep -f 'omp .*--mode[= ]rpc-ui' 2>/dev/null || true)"

cat <<MSG
Installed adaptive-router to:
  $DEST

No OpenRouter key was copied or created. The extension reuses OMP's resolved
'openrouter' credential in memory for the OpenRouter Data API.

Restart OMP, then run /route-status after the first routing decision.
CodexBar serve mode is optional; the extension falls back to the CodexBar CLI.
MSG

if [[ -n "$STALE_RPC_PIDS" ]]; then
  cat <<WARN

WARNING: long-lived 'omp --mode rpc-ui' processes are still running and hold the
PREVIOUS adaptive-router code in memory (PID(s): $(echo "$STALE_RPC_PIDS" | tr '\n' ' ')).
Each one will keep overwriting $DEST/state.json with its stale in-memory snapshot on
its own schedule until it is restarted -- this can silently undo this install. Restart
or kill these processes now; do not rely on redeploying files alone.
WARN
fi

# Follow-up 3 (docs/investigations/multica-repeated-switch-marker.md): Kilo's free-tier
# catalog can have several dead ids ranked ahead of the first live one (5 observed live
# 2026-09-19). Multica caps a turn at a handful of attempts, so the FIRST real turn after
# any cold/wiped state.json burns its whole budget learning dead routes one at a time and
# never reaches a live model -- correct cooldown code cannot help within a single turn's
# attempt budget. Pre-warming here (or after any future state.json wipe) means the first
# real turn starts from already-learned cooldowns instead of a cold ladder.
if [[ "$SKIP_WARMUP" != "1" ]]; then
  echo ""
  echo "Warming up pmr/free (learns any dead free-tier routes before the first real turn)..."
  WARMUP_ATTEMPTS=0
  WARMUP_MAX_ATTEMPTS=10
  WARMUP_ANSWERED=0
  while [[ "$WARMUP_ATTEMPTS" -lt "$WARMUP_MAX_ATTEMPTS" ]]; do
    WARMUP_ATTEMPTS=$((WARMUP_ATTEMPTS + 1))
    WARMUP_OUT="$("$OMP_BIN" -p --model pmr/free "Reply with exactly: PONG" 2>&1)" || true
    if printf '%s' "$WARMUP_OUT" | grep -q 'PONG'; then
      WARMUP_ANSWERED=1
      break
    fi
  done
  if [[ "$WARMUP_ANSWERED" == "1" ]]; then
    echo "Warm-up done after $WARMUP_ATTEMPTS attempt(s): pmr/free answered."
  else
    echo "Warm-up did not get a live answer within $WARMUP_MAX_ATTEMPTS attempts -- check /route-status." >&2
  fi
fi
