#!/usr/bin/env bash
# Deploy the Hermes OMP bridge from this repo into the live Hermes plugin directory.
#
# The bridge used to exist ONLY at ~/.hermes/plugins/model-providers/omp/, which is not
# under version control: the thin-host client, the launcher wrapper and their tests had
# no history, no review and no secret scan. This repo is the source of truth now; the
# plugin directory is a deployment target, exactly like the OMP extension itself.
#
# Usage:
#   scripts/install-bridge.sh            deploy (backs up anything it replaces)
#   scripts/install-bridge.sh --check    report drift between repo and installed copy
#
# Env:
#   HERMES_PLUGIN_DIR   deployment target (default ~/.hermes/plugins/model-providers/omp)
#   HERMES_BIN_DIR      launcher target   (default ~/.local/bin) — only with --launcher
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO_DIR/hermes/omp-bridge"
DST="${HERMES_PLUGIN_DIR:-$HOME/.hermes/plugins/model-providers/omp}"
BIN_DIR="${HERMES_BIN_DIR:-$HOME/.local/bin}"

CHECK=0
WITH_LAUNCHER=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK=1 ;;
    --launcher) WITH_LAUNCHER=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

[ -d "$SRC" ] || { echo "missing bridge sources: $SRC" >&2; exit 1; }

# Runtime state that belongs to the machine, never to the repo: caches, compiled Python,
# per-machine databases and the .bak-* files an ad-hoc edit leaves behind.
files() { # files <root> — repo-tracked bridge files, relative paths, sorted
  (cd "$1" && find . -type f \
    ! -name '._*' ! -name '*.pyc' ! -name '*.bak-*' ! -name '*.db' \
    ! -path './__pycache__/*' ! -path './omp_adapter/__pycache__/*' \
    ! -path './.pytest_cache/*' | sed 's|^\./||' | sort)
}

if [ "$CHECK" = "1" ]; then
  drift=0
  while read -r rel; do
    [ -n "$rel" ] || continue
    if [ ! -f "$DST/$rel" ]; then
      echo "MISSING   $rel"
      drift=1
    elif ! cmp -s "$SRC/$rel" "$DST/$rel"; then
      echo "DIFFERS   $rel"
      drift=1
    fi
  done <<EOF
$(files "$SRC")
EOF
  if [ "$drift" = "1" ]; then
    echo
    echo "Installed bridge differs from this repo. Deploy with: scripts/install-bridge.sh" >&2
    exit 1
  fi
  echo "bridge: installed copy matches the repo ($(files "$SRC" | wc -l | tr -d ' ') files)"
  exit 0
fi

mkdir -p "$DST"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backed_up=0
while read -r rel; do
  [ -n "$rel" ] || continue
  mkdir -p "$DST/$(dirname "$rel")"
  if [ -f "$DST/$rel" ] && ! cmp -s "$SRC/$rel" "$DST/$rel"; then
    cp -p "$DST/$rel" "$DST/$rel.bak-$stamp"
    backed_up=$((backed_up + 1))
  fi
  cp -X "$SRC/$rel" "$DST/$rel"
done <<EOF
$(files "$SRC")
EOF
chmod +x "$DST"/*.sh 2>/dev/null || true

echo "Deployed bridge to: $DST"
[ "$backed_up" -gt 0 ] && echo "Replaced $backed_up file(s); backups carry the suffix .bak-$stamp"

if [ "$WITH_LAUNCHER" = "1" ]; then
  mkdir -p "$BIN_DIR"
  if [ -f "$BIN_DIR/hermes" ] && ! cmp -s "$SRC/hermes-launcher.sh" "$BIN_DIR/hermes"; then
    cp -p "$BIN_DIR/hermes" "$BIN_DIR/hermes.bak-$stamp"
  fi
  install -m 755 "$SRC/hermes-launcher.sh" "$BIN_DIR/hermes"
  echo "Installed launcher wrapper: $BIN_DIR/hermes"
fi

echo
echo "Core overlays are applied separately (they are wiped by every \`hermes update\`):"
echo "  python3 $DST/reapply_omp_patches.py --check"
echo "Restart the gateway after core edits: hermes gateway restart"
