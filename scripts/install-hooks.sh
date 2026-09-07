#!/usr/bin/env bash
# Install the repo's git hooks (currently: pre-commit secret scan).
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cp "$REPO_ROOT/scripts/pre-commit" "$REPO_ROOT/.git/hooks/pre-commit"
chmod +x "$REPO_ROOT/.git/hooks/pre-commit"
echo "Installed pre-commit hook -> .git/hooks/pre-commit"
echo "It runs scripts/scan-secrets.sh and blocks the commit on any finding."
