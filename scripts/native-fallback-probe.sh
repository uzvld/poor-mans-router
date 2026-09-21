#!/usr/bin/env bash
# Investigation probe only: no live credentials, no provider requests, no install.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OMP_BIN="${OMP_BIN:-omp}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pmr-native-fallback.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/home" "$WORK/agent"
cat > "$WORK/agent/config.yml" <<'CONFIG'
mcp:
  enableProjectConfig: false
memory:
  enabled: false
autolearn:
  enabled: false
retry:
  enabled: false
  usageAwareFallback: false
CONFIG
cd "$WORK"
env -i PATH="$PATH" HOME="$WORK/home" TMPDIR="$WORK" \
  PI_CODING_AGENT_DIR="$WORK/agent" \
  "$OMP_BIN" --no-extensions -e "$ROOT/scripts/native-fallback-probe.ts" \
  --no-tools --no-skills --no-rules --no-title --no-session \
  --model pmr-probe/test --thinking off --max-time 20s -p probe
