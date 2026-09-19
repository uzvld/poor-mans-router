#!/usr/bin/env bash
# BUG C reproduction matrix — one OMP session per case, driven through the TUI over a PTY
# via `expect`, tracer attached with -e. Never modifies the live extension install.
#
# usage: tools/context-tracer/run-case.sh <case-id> <model-A> [<model-B>|-] [--router]
#   --router : also load the LIVE adaptive-router (discovery on); otherwise --no-extensions
set -euo pipefail
CASE="$1"; MODEL_A="$2"; MODEL_B="${3:-}"; ROUTER="${4:-}"
[[ "$MODEL_B" == "-" ]] && MODEL_B=""
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="/tmp/bug-c/$CASE"; rm -rf "$OUT"; mkdir -p "$OUT/sessions"
export CONTEXT_TRACE_FILE="$OUT/trace.jsonl"; : > "$CONTEXT_TRACE_FILE"
export CONTEXT_TRACE_MARKER="ROUTER_CONTEXT_MARKER_71C9E4"
TRACER="$ROOT/tools/context-tracer/index.ts"
TRANSCRIPT="$OUT/tui.log"

EXT_FLAGS="-e $TRACER"
[[ "$ROUTER" == "--router" ]] || EXT_FLAGS="$EXT_FLAGS --no-extensions"

# Each turn: send prompt, wait for the "Working" indicator, then for the idle prompt glyph
# "π >" in the status bar. Waiting for Working FIRST means we never match our own echo or
# a stale idle bar from the previous turn.
cat > "$OUT/driver.exp" <<EOF
set timeout 240
log_file -noappend "$TRANSCRIPT"
spawn env CONTEXT_TRACE_FILE=$CONTEXT_TRACE_FILE CONTEXT_TRACE_MARKER=$CONTEXT_TRACE_MARKER omp --no-tools --session-dir "$OUT/sessions" --model "$MODEL_A" $EXT_FLAGS
expect -re {π >}
sleep 2

proc turn {text} {
    send -- "\$text\r"
    expect -re {Working}
    expect -re {π >}
    sleep 2
}

turn "Remember this exact test marker for this session: ROUTER_CONTEXT_MARKER_71C9E4. Also remember: animal = capybara, number = 48317. Do not repeat them unless I ask. Reply only: noted."
turn "What is 2+2? Reply with just the number."
turn "What animal and number did I tell you? Reply in the form: animal=<x> number=<y>."
EOF

if [[ -n "$MODEL_B" ]]; then
cat >> "$OUT/driver.exp" <<EOF
send -- "/ctx-switch $MODEL_B\r"
sleep 6
EOF
fi

cat >> "$OUT/driver.exp" <<EOF
turn "Without looking at files or external state, what was ROUTER_CONTEXT_MARKER_71C9E4, the animal, and the number from earlier in this same conversation? Reply in the form: marker=<m> animal=<a> number=<n>."
send -- "/exit\r"
expect eof
EOF

expect -f "$OUT/driver.exp" >/dev/null 2>&1 || true
echo "case=$CASE modelA=$MODEL_A modelB=${MODEL_B:-none} router=${ROUTER:-off} trace_lines=$(wc -l < "$CONTEXT_TRACE_FILE" | tr -d ' ')"
