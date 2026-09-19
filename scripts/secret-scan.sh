#!/usr/bin/env bash
# Secret & PII gate for poor-mans-router. Local only (pre-commit hook + agent contract); no CI.
# Exit non-zero on ANY finding. Never prints matched content — only file:line and category.
#
# usage: scripts/secret-scan.sh [--staged | --all | --verify <attest> | <path>...]
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
MODE="${1:---staged}"

# --verify <attest>: recompute the attestation over the full tree and compare.
if [[ "$MODE" == "--verify" ]]; then
  EXPECT="${2:-}"; [[ -z "$EXPECT" ]] && { echo "usage: secret-scan.sh --verify <attest>" >&2; exit 2; }
  GOT=$("$0" --all 2>/dev/null | sed -n 's/.*attest=\([a-f0-9]*\).*/\1/p')
  if [[ "$GOT" == "$EXPECT" ]]; then printf '\033[32mverify: OK (%s)\033[0m\n' "$GOT"; exit 0
  else printf '\033[31mverify: MISMATCH expected=%s got=%s — tree or scanner changed since the attested scan\033[0m\n' "$EXPECT" "$GOT"; exit 1; fi
fi

fail=0
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }

# ---- 1. forbidden filenames -----------------------------------------------------------
if [[ "$MODE" == "--staged" ]]; then FILES=$(git diff --cached --name-only --diff-filter=ACMR); 
elif [[ "$MODE" == "--all" ]]; then FILES=$(git ls-files);
else FILES=$(printf '%s\n' "$@"); fi

FORBIDDEN_NAME='(^|/)(\.env(\..*)?|state\.json|auth\.json|\.netrc|.*\.pem|.*\.key|id_rsa.*|id_ed25519.*|.*credentials.*|.*\.har|.*\.raw\.json|fixtures/raw/.*)$'
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  if [[ "$f" =~ $FORBIDDEN_NAME ]]; then red "FORBIDDEN FILENAME: $f"; fail=1; fi
done <<< "$FILES"

# ---- 2. gitleaks (if installed) ---------------------------------------------------------
if command -v gitleaks >/dev/null 2>&1; then
  if [[ "$MODE" == "--staged" ]]; then
    gitleaks git --staged --no-banner --redact=100 --exit-code 2 . >/tmp/gitleaks.out 2>&1 || { red "GITLEAKS: findings in staged changes"; grep -E "Fingerprint|File:|RuleID" /tmp/gitleaks.out | head -20; fail=1; }
  else
    gitleaks dir --no-banner --redact=100 --exit-code 2 . >/tmp/gitleaks.out 2>&1 || { red "GITLEAKS: findings in tree"; grep -E "Fingerprint|File:|RuleID" /tmp/gitleaks.out | head -20; fail=1; }
  fi
else
  echo "warn: gitleaks not installed (brew install gitleaks) — regex gate only"
fi

# ---- 3. regex gate: secrets + PII this project specifically leaks -----------------------
# Each line: <category>|<ERE>. Allow-list tokens: <redacted>, <user>, example.com, users.noreply.github.com
PATTERNS=$(cat <<'EOF'
openai/anthropic key|sk-(ant-)?[A-Za-z0-9_-]{16,}
github token|(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})
slack token|xox[baprs]-[A-Za-z0-9-]{10,}
aws key|AKIA[0-9A-Z]{16}
google key|AIza[0-9A-Za-z_-]{35}
private key|BEGIN [A-Z ]*PRIVATE KEY
jwt|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.
bearer header|[Bb]earer[[:space:]]+[A-Za-z0-9._-]{20,}
openrouter key|sk-or-v1-[a-f0-9]{20,}
kilo key|kilo_[A-Za-z0-9]{20,}
email address|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.(com|ai|io|net|org|dev|ru|app|club)
workspace id|wrk_[A-Za-z0-9]{6,}
openai account/org id|(acct|org|user)[-_][A-Za-z0-9]{16,}
home directory|/Users/[a-z][a-z0-9_-]{2,}|/home/[a-z][a-z0-9_-]{2,}
cookie header|[Cc]ookie:[[:space:]]*[^[:space:]]{16,}
codexbar identity|"(signedInEmail|accountID|accountId|orgId|orgName|identity)"
secret assignment|(api[_-]?key|apikey|secret|password|passwd|token)[[:space:]]*[:=][[:space:]]*["'][^"'[:space:]<$]{12,}["']
EOF
)
ALLOW='<redacted>|<user>|example\.com|users\.noreply\.github\.com|/Users/<user>|\$\{?HOME|~/|git@github\.com:'

scan_file() {
  local f="$1"
  [[ -f "$f" ]] || return 0
  case "$f" in *.png|*.jpg|*.gif|*.pdf|*.zip|*.lockb) return 0;; esac
  # exempt this script and the sanitiser (they contain the patterns themselves)
  case "$f" in scripts/secret-scan.sh|scripts/sanitize-fixtures.py|.github/workflows/*) return 0;; esac
  while IFS='|' read -r cat rx; do
    [[ -z "$rx" ]] && continue
    hits=$(grep -n -E "$rx" "$f" 2>/dev/null | grep -v -E "$ALLOW" | cut -d: -f1 | head -5 | tr '\n' ',')
    if [[ -n "$hits" ]]; then red "  $f  lines[${hits%,}]  <$cat>"; fail=1; fi
  done <<< "$PATTERNS"
}

while IFS= read -r f; do [[ -n "$f" ]] && scan_file "$f"; done <<< "$FILES"

# ---- 4. fixtures must have passed the sanitiser ------------------------------------------
while IFS= read -r f; do
  [[ "$f" == fixtures/*.json ]] || continue
  [[ -f "$f" ]] || continue
  if grep -q -E '"(metadata|capacity|disabledCredentials|accountsWithoutUsage|openaiDashboard|byFolder)"' "$f"; then
    red "  $f  <unsanitised fixture: raw omp/codexbar fields present — run scripts/sanitize-fixtures.py>"; fail=1
  fi
done <<< "$FILES"

if [[ $fail -ne 0 ]]; then
  red "secret-scan: BLOCKED. Remove/sanitise the flagged content. Never commit raw telemetry, .env, state.json, or any credential."
  exit 1
fi

# ---- 5. attestation: hash of (this script + every scanned file's content) ---------------
# Written to .secret-scan.attest (gitignored). A commit/PR must quote the `attest` value;
# reviewers re-run `scripts/secret-scan.sh --verify <attest>` to prove the scan ran on
# exactly this content and this scanner. Any file or scanner change invalidates it.
attest_input() {
  shasum -a 256 "$ROOT/scripts/secret-scan.sh" | cut -d' ' -f1
  while IFS= read -r f; do
    [[ -n "$f" && -f "$f" ]] || continue
    printf '%s  %s\n' "$(shasum -a 256 "$f" | cut -d' ' -f1)" "$f"
  done <<< "$FILES" | sort
}
ATTEST=$(attest_input | shasum -a 256 | cut -c1-24)
NFILES=$(echo "$FILES" | grep -c .)
printf 'attest=%s\nmode=%s\nfiles=%s\nscanner=%s\nat=%s\n' "$ATTEST" "$MODE" "$NFILES" "$(shasum -a 256 "$ROOT/scripts/secret-scan.sh" | cut -c1-16)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$ROOT/.secret-scan.attest"
green "secret-scan: clean ($NFILES files)  attest=$ATTEST"
