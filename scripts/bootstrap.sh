#!/usr/bin/env bash
# One-command install for humans and agents: fetch the repo if needed, deploy the OMP
# extension, and (optionally) the Hermes bridge — in a single invocation.
#
# Already have a checkout:
#   ./scripts/bootstrap.sh [--bridge] [--launcher]
#
# No checkout yet (curl one-liner, safe for agents — no prompts, no TTY needed):
#   curl -fsSL https://raw.githubusercontent.com/uzvld/poor-mans-router/main/scripts/bootstrap.sh \
#     | bash -s -- [--bridge] [--launcher]
#
# Flags:
#   --bridge     also deploy hermes/omp-bridge/ (scripts/install-bridge.sh)
#   --launcher   implies --bridge; also installs the `hermes` launcher wrapper that
#                re-applies the Hermes core overlays every `hermes update` wipes
#
# Env:
#   PMR_DIR       checkout location when no on-disk checkout is running this script
#                 (default: ~/.local/share/poor-mans-router)
#   PMR_REPO_URL  git remote to clone (default: https://github.com/uzvld/poor-mans-router.git)
#   OMP_BIN       omp binary, forwarded to scripts/install.sh (default: omp)
set -euo pipefail

REPO_URL="${PMR_REPO_URL:-https://github.com/uzvld/poor-mans-router.git}"
INSTALL_BRIDGE=0
WITH_LAUNCHER=0
for arg in "$@"; do
  case "$arg" in
    --bridge) INSTALL_BRIDGE=1 ;;
    --launcher) INSTALL_BRIDGE=1; WITH_LAUNCHER=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# Reuse the checkout this script is running from when there is one on disk. Piped
# execution (`curl | bash`) has no on-disk script file — $BASH_SOURCE resolves to
# nothing real — so that path clones (or fast-forwards) one instead.
SELF="${BASH_SOURCE[0]:-}"
if [[ -n "$SELF" && -f "$SELF" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "$SELF")" && pwd)"
  REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
else
  command -v git >/dev/null 2>&1 || { echo "error: git is required to fetch poor-mans-router" >&2; exit 1; }
  REPO_ROOT="${PMR_DIR:-$HOME/.local/share/poor-mans-router}"
  if [[ -d "$REPO_ROOT/.git" ]]; then
    git -C "$REPO_ROOT" pull --ff-only
  else
    git clone "$REPO_URL" "$REPO_ROOT"
  fi
fi

[[ -f "$REPO_ROOT/scripts/install.sh" ]] || {
  echo "error: $REPO_ROOT is not a poor-mans-router checkout (missing scripts/install.sh)" >&2
  exit 1
}

# Route hooks through .githooks whenever we own a git checkout, so the secret-scan gate
# (AGENTS.md) is live before anyone's first commit here — cheap and always correct.
if [[ -d "$REPO_ROOT/.git" ]]; then
  git -C "$REPO_ROOT" config core.hooksPath .githooks
fi

"$REPO_ROOT/scripts/install.sh"

if [[ "$INSTALL_BRIDGE" == "1" ]]; then
  if [[ "$WITH_LAUNCHER" == "1" ]]; then
    "$REPO_ROOT/scripts/install-bridge.sh" --launcher
  else
    "$REPO_ROOT/scripts/install-bridge.sh"
  fi
fi

cat <<MSG

poor-mans-router ready. Checkout: $REPO_ROOT
Restart omp, then opt in with one of: /model pmr/balanced | pmr/frontier | pmr/small | pmr/free
After the first turn: /route-status
MSG
