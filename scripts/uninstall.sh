#!/usr/bin/env bash
set -euo pipefail

OMP_BIN="${OMP_BIN:-omp}"
if ! command -v "$OMP_BIN" >/dev/null 2>&1; then
  echo "OMP executable not found: $OMP_BIN" >&2
  exit 1
fi
AGENT_DIR="$($OMP_BIN config path | tail -n 1)"

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

if [[ ! -d "$DEST" ]]; then
  echo "adaptive-router is not installed at: $DEST"
  exit 0
fi

mkdir -p "$BACKUP_ROOT"
BACKUP="$BACKUP_ROOT/adaptive-router-uninstall-$STAMP"
suffix=0
while [[ -e "$BACKUP" ]]; do
  suffix=$((suffix + 1))
  BACKUP="$BACKUP_ROOT/adaptive-router-uninstall-$STAMP-$suffix"
done
cp -a "$DEST" "$BACKUP"
rm -rf "$DEST"

cat <<MSG
Removed adaptive-router from:
  $DEST
Backup saved to:
  $BACKUP

Native OMP retry/usage-aware settings were intentionally left unchanged.
MSG
