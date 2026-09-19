#!/usr/bin/env bash
set -euo pipefail

OMP_BIN="${OMP_BIN:-omp}"
if ! command -v "$OMP_BIN" >/dev/null 2>&1; then
  echo "OMP executable not found: $OMP_BIN" >&2
  exit 1
fi
AGENT_DIR="$($OMP_BIN config path | tail -n 1)"
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
