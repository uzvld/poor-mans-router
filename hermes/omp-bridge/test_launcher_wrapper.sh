#!/usr/bin/env bash
# Contract for hermes-launcher.sh — the only OMP re-integration point that survives
# `hermes update` (the tree it would otherwise live in is replaced wholesale).
#
# Run: bash test_launcher_wrapper.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WRAPPER="$HERE/hermes-launcher.sh"
failures=0

check() { # check <description> <condition-result>
  if [ "$2" = "0" ]; then
    echo "ok   — $1"
  else
    echo "FAIL — $1" >&2
    failures=$((failures + 1))
  fi
}

# One fake stands in for the interpreter: it records every invocation and answers as the
# update, the reapply script or the desktop build depending on the argv it is handed.
make_fake() { # make_fake <workdir> <update_rc> <reapply_rc> <reapply_output>
  local dir="$1" update_rc="$2" reapply_rc="$3" reapply_out="$4"
  cat >"$dir/fake_python" <<FAKE
#!/usr/bin/env bash
echo "\$*" >>"$dir/calls"
case "\$*" in
  *reapply*) printf '%s\n' "$reapply_out"; exit $reapply_rc ;;
  *"desktop --build-only"*) echo "desktop build"; exit 0 ;;
  *update*) echo "update ran"; exit $update_rc ;;
esac
echo "passthrough"
exit 0
FAKE
  chmod +x "$dir/fake_python"
  : >"$dir/calls"
  touch "$dir/reapply_omp_patches.py"
}

run_wrapper() { # run_wrapper <workdir> <args...>
  local dir="$1"; shift
  HERMES_PYTHON="$dir/fake_python" HERMES_ENTRY="$dir/entry" \
    OMP_REAPPLY="$dir/reapply_omp_patches.py" bash "$WRAPPER" "$@" >"$dir/out" 2>"$dir/err"
  echo $?
}

# 1. The hot path must not pay for the update hook.
dir="$(mktemp -d)"; make_fake "$dir" 0 0 "OK: patched"
rc="$(run_wrapper "$dir" -z "hello")"
check "a normal invocation is passed through" "$([ "$rc" = "0" ] && echo 0 || echo 1)"
check "a normal invocation never runs the reapply script" \
  "$(grep -q reapply "$dir/calls" && echo 1 || echo 0)"

# 2. After an update the patches must be reapplied, in that order.
dir="$(mktemp -d)"; make_fake "$dir" 0 0 "OK:   hermes_cli/providers.py patched"
rc="$(run_wrapper "$dir" update)"
check "update still reports its own success" "$([ "$rc" = "0" ] && echo 0 || echo 1)"
check "the reapply script runs after an update" \
  "$(grep -q reapply "$dir/calls" && echo 0 || echo 1)"
check "the update runs before the reapply" \
  "$([ "$(grep -n 'update' "$dir/calls" | head -1 | cut -d: -f1)" -lt \
      "$(grep -n 'reapply' "$dir/calls" | head -1 | cut -d: -f1)" ] && echo 0 || echo 1)"

# 3. A wiped renderer patch means the update's own desktop build is stale.
dir="$(mktemp -d)"; make_fake "$dir" 0 0 "OK:   apps/desktop/src/lib/model-status-label.ts patched"
run_wrapper "$dir" update >/dev/null
check "a re-patched renderer triggers a desktop rebuild" \
  "$(grep -q 'desktop --build-only' "$dir/calls" && echo 0 || echo 1)"

# 4. No renderer change must never cost an Electron build.
dir="$(mktemp -d)"; make_fake "$dir" 0 0 "OK:   hermes_cli/providers.py anchor present"
run_wrapper "$dir" update >/dev/null
check "an unchanged renderer does not trigger a desktop rebuild" \
  "$(grep -q 'desktop --build-only' "$dir/calls" && echo 1 || echo 0)"

# 5. A broken anchor must be loud — this is the case that silently degraded the picker.
dir="$(mktemp -d)"; make_fake "$dir" 0 1 "FAIL: hermes_cli/providers.py — needle missing"
rc="$(run_wrapper "$dir" update)"
check "a failed reapply is reported on stderr" \
  "$(grep -q 'NEEDS HAND FIX' "$dir/err" && echo 0 || echo 1)"
check "a failed reapply does not trigger a desktop build" \
  "$(grep -q 'desktop --build-only' "$dir/calls" && echo 1 || echo 0)"

# 6. The update's exit code is the caller's contract (gateway writes .update_exit_code).
dir="$(mktemp -d)"; make_fake "$dir" 3 0 "OK: patched"
rc="$(run_wrapper "$dir" update)"
check "a failing update keeps its own exit code" "$([ "$rc" = "3" ] && echo 0 || echo 1)"

if [ "$failures" -eq 0 ]; then
  echo "test_launcher_wrapper.sh: all checks passed"
  exit 0
fi
echo "test_launcher_wrapper.sh: $failures check(s) failed" >&2
exit 1
