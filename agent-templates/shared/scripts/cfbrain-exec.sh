#!/usr/bin/env bash
# cfbrain CLI wrapper
#
# Why this wrapper exists:
#   1. cfbrain stores its knowledge base under a dedicated HOME so that the
#      brain data lives outside your normal home directory.
#   2. lark-cli (optional Feishu integration) needs the REAL home directory to
#      reach the OS keychain, so we stash it in REAL_HOME before overriding HOME.
#   3. Secrets come from .env — never hardcode a key in this file.
#
# Setup:
#   cp .env.example .env      # then fill in your keys
#   export CFBRAIN_HOME=/path/to/this/repo
#   export CFBRAIN_DATA_HOME=$HOME/.cfbrain-data
set -euo pipefail

CFBRAIN_HOME="${CFBRAIN_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
CFBRAIN_DATA_HOME="${CFBRAIN_DATA_HOME:-$HOME/.cfbrain-data}"

# Load secrets from .env if present (does not clobber already-exported vars)
if [ -f "$CFBRAIN_HOME/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$CFBRAIN_HOME/.env"
  set +a
fi

if [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "cfbrain: OPENAI_API_KEY is not set. Copy .env.example to .env and fill it in." >&2
  echo "         (embeddings are required for semantic search)" >&2
  exit 1
fi

# lark-cli needs the real HOME for keychain access
export REAL_HOME="$HOME"
export HOME="$CFBRAIN_DATA_HOME"
export OPENAI_BASE_URL="${OPENAI_BASE_URL:-https://api.openai.com/v1}"

exec bun run "$CFBRAIN_HOME/src/cli.ts" "$@"
