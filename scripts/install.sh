#!/usr/bin/env bash
set -euo pipefail

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

cat <<MSG
Installed adaptive-router to:
  $DEST

No OpenRouter key was copied or created. The extension reuses OMP's resolved
'openrouter' credential in memory for the OpenRouter Data API.

Restart OMP, then run /route-status after the first routing decision.
CodexBar serve mode is optional; the extension falls back to the CodexBar CLI.
MSG
