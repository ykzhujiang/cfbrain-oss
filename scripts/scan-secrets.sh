#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Secret / PII leak scanner
#
#   ./scripts/scan-secrets.sh
#
# Run this before every commit and before making the repo public.
# Exit code 0 = clean, 1 = something must be fixed.
#
# It scans the working tree (excluding node_modules/.git) for:
#   1. API key shapes
#   2. Feishu/Lark tenant identifiers
#   3. Personal / organisation identifiers from the private origin
#   4. Hardcoded absolute home paths
#   5. Real-looking email addresses
#   6. Files that must never be committed
# ---------------------------------------------------------------------------
set -uo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

FAIL=0
PRUNE=( -name node_modules -o -name .git -o -name bin -o -name dist )

scan() { # scan <label> <extended-regex> [allowlist-regex]
  local label="$1" pattern="$2" allow="${3:-}" hits
  hits=$(find . \( "${PRUNE[@]}" \) -prune -o -type f -print 2>/dev/null \
    | xargs grep -InE "$pattern" 2>/dev/null \
    | { [ -n "$allow" ] && grep -vE "$allow" || cat; } \
    | grep -v 'scripts/scan-secrets.sh')
  if [ -n "$hits" ]; then
    printf '\033[31mFAIL\033[0m  %s\n' "$label"
    printf '%s\n' "$hits" | sed 's/^/        /' | head -20
    FAIL=1
  else
    printf '\033[32m ok \033[0m  %s\n' "$label"
  fi
}

echo "Scanning $(pwd)"
echo

# 1. API keys — real OpenAI/Anthropic keys are long; placeholders are short
scan "no OpenAI/Anthropic API keys" \
  'sk-[A-Za-z0-9]{24,}|sk-ant-[A-Za-z0-9_-]{24,}' \
  'your-key-here|sk-\.\.\.|sk-xxx'

# 2. Feishu / Lark tenant identifiers
scan "no Feishu app ids or open ids" \
  'cli_[a-f0-9]{16}|ou_[a-f0-9]{32}'

scan "no Feishu space id / wiki node tokens" \
  '\b7592817423070268638\b|Hd4Jwpdsxi|PNVewbGkri|FsWSwmlmdi|Cu8bwkcHNi|Xb00wtL3pi|UMvsw5Mhdi|ZbLZwwk3Vi|Zu7JwJZoli|PygOwzdfwi|JaFpwy7pgi|CKAVwW7aGi'

# 3. Identifiers inherited from the private origin.
#    Note: "openclaw" on its own is fine — it is a public tool this CLI
#    integrates with. What must never ship is a path that reads ANOTHER
#    agent's credential store (see the dedicated check below).
scan "no personal / org identifiers" \
  'ahzhu_agent|welltop|t8star|cfbrain-oc|朱江|井英|CreativeFitting|小江|小习|小默|xiaoxi-agent|silent-agent'

# 3b. Cross-agent credential harvesting.
#     The audit report describes this pattern in prose, so it is allowlisted.
scan "no reads of another agent's credential store" \
  '\.openclaw/credentials|lark\.secrets\.json|\.xiaoxi/' \
  'docs/AUDIT-AND-STRIPPING\.md'

# 4. Hardcoded absolute home paths
scan "no hardcoded /Users or /home paths" \
  "['\"\`]/(Users|home)/[a-z]" \
  'example|<your|placeholder'

# 5. Real-looking emails.
#    Allowlisted: documentation examples (acmecorp/company/kovac.dev are fictional),
#    npm scopes, cloud hostnames, and test fixtures.
scan "no real email addresses" \
  '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' \
  '@example\.com|@test\.com|@t\.com|@x\.com|@y\.com|@acmecorp\.com|@company\.com|@gmail\.com|@slack\.com|@kovac\.dev|@novamind\.ai|somewhere-unknown\.io|@types/|@electric-sql|@anthropic-ai|@modelcontextprotocol|@aws-sdk|@larksuite|supabase\.co|amazonaws\.com|amazonses\.com|bun\.sh|schemas\.|\.png|@[a-z-]+/[a-z]'

# 6. Files that must never exist here
echo
for f in .env config.json; do
  if [ -e "$f" ]; then
    printf '\033[31mFAIL\033[0m  %s must not be committed\n' "$f"; FAIL=1
  else
    printf '\033[32m ok \033[0m  no %s present\n' "$f"
  fi
done
for pat in '*.env.bak' '*.pem' '*.key'; do
  found=$(find . \( "${PRUNE[@]}" \) -prune -o -name "$pat" -print 2>/dev/null)
  if [ -n "$found" ]; then
    printf '\033[31mFAIL\033[0m  found %s:\n%s\n' "$pat" "$found"; FAIL=1
  else
    printf '\033[32m ok \033[0m  no %s files\n' "$pat"
  fi
done

# 7. Knowledge data must not be bundled
for d in pages raw export; do
  if [ -d "$d" ]; then
    printf '\033[31mFAIL\033[0m  %s/ directory must not be committed\n' "$d"; FAIL=1
  else
    printf '\033[32m ok \033[0m  no %s/ directory\n' "$d"
  fi
done

echo
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32mCLEAN\033[0m — safe to commit.\n'
else
  printf '\033[31mBLOCKED\033[0m — fix the FAIL items above before committing.\n'
fi
exit "$FAIL"
