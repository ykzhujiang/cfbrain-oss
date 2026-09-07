#!/bin/bash
#
# restart-main.sh — Restart Main Agent serve after staging merge (monorepo layout)
#
# Template variables:
#   $CFBRAIN_HOME    — Monorepo root, e.g. $HOME/.news-briefing
#   com.<AGENT_NAME> — e.g. com.news-briefing
#   3496    — e.g. 3468

set -euo pipefail

# --- Caller role audit logging ---
# CALLER_ROLE should be set by the invoking agent/script (e.g. "evaluator", "human")
# If not set or not an authorized role, emit a WARNING for audit trail
CALLER_ROLE="${CALLER_ROLE:-unknown}"
if [[ "$CALLER_ROLE" != "evaluator" && "$CALLER_ROLE" != "human" ]]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [restart-main] WARNING: Called by unauthorized role: CALLER_ROLE='${CALLER_ROLE}'. Only 'evaluator' and 'human' should execute this script." >&2
fi
echo "[$(date '+%Y-%m-%d %H:%M:%S')] [restart-main] Invoked by CALLER_ROLE='${CALLER_ROLE}'"

SERVE_PLIST="$HOME/Library/LaunchAgents/com.<AGENT_NAME>.main.serve.plist"
MAIN_DIR="$CFBRAIN_HOME"

# --- Read main port from port-registry.json ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT_REGISTRY="${SCRIPT_DIR}/port-registry.json"
if command -v jq >/dev/null 2>&1 && [ -f "$PORT_REGISTRY" ]; then
    PORT=$(jq -r '.main // empty' "$PORT_REGISTRY" 2>/dev/null)
fi
if [ -z "${PORT:-}" ] && [ -f "$PORT_REGISTRY" ]; then
    PORT=$(grep '"main"' "$PORT_REGISTRY" | sed 's/[^0-9]//g' 2>/dev/null)
fi
PORT="${PORT:-3496}"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [restart-main] $*"
}

log "Starting Main Agent restart..."

# 1. Pull latest in Main workspace (monorepo root)
cd "$MAIN_DIR"
log "Pulling latest in Main workspace..."

# --- Dirty workspace tolerance: stash before pull ---
STASHED=false
DIRTY_FILES=$(git status --porcelain 2>/dev/null)
if [ -n "$DIRTY_FILES" ]; then
    DIRTY_COUNT=$(echo "$DIRTY_FILES" | wc -l | tr -d ' ')
    log "Workspace dirty, stashing ${DIRTY_COUNT} file(s)..."
    log "Dirty files: $(echo "$DIRTY_FILES" | head -10)"
    if git stash --include-untracked; then
        STASHED=true
        log "git stash SUCCESS"
    else
        log "WARNING: git stash failed, attempting pull anyway"
    fi
fi

# Execute git pull
if git pull; then
    log "git pull SUCCESS"
else
    log "git pull FAILED — attempting rebase"
    git pull --rebase || { log "FATAL: git pull failed"; exit 1; }
fi

# --- Restore stashed changes if applicable ---
if [ "$STASHED" = true ]; then
    log "Attempting to restore stashed changes..."
    if git stash pop 2>/dev/null; then
        log "Stash restored successfully"
    else
        # Conflict detected — discard local changes in favor of remote
        CONFLICTED_FILES=$(git diff --name-only 2>/dev/null || true)
        log "WARNING: Stash conflicts detected, dropped local changes in favor of remote"
        log "Dropped files: ${CONFLICTED_FILES:-unknown}"
        git checkout -- . 2>/dev/null || true
        git stash drop 2>/dev/null || true
    fi
fi

# monorepo: main/AGENTS.md is updated by git pull directly, no cp needed

# 3. Restart Main serve via launchctl
if [ -f "$SERVE_PLIST" ]; then
    SERVE_LABEL=$(basename "$SERVE_PLIST" .plist)
    uid=$(id -u)

    log "Unloading Main serve..."
    launchctl bootout "gui/${uid}/${SERVE_LABEL}" 2>/dev/null || true
    sleep 2

    log "Loading Main serve..."
    bootstrap_output=$(launchctl bootstrap "gui/${uid}" "$SERVE_PLIST" 2>&1)
    if [ $? -ne 0 ]; then
        log "bootstrap failed ($bootstrap_output), trying load fallback..."
        launchctl load "$SERVE_PLIST" 2>/dev/null || true  # fallback
    fi
    sleep 5

    # 4. Verify serve is running
    http_code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}" 2>/dev/null || echo "000")
    if [ "$http_code" = "200" ]; then
        log "Main serve restart SUCCESS (HTTP 200 on port ${PORT})"
    else
        log "WARNING: Main serve — HTTP $http_code (may still be starting)"
        sleep 10
        http_code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}" 2>/dev/null || echo "000")
        if [ "$http_code" = "200" ]; then
            log "Main serve restart SUCCESS (delayed, HTTP 200)"
        else
            log "ERROR: Main serve not responding after 15s (HTTP $http_code)"
            exit 1
        fi
    fi
else
    log "ERROR: serve plist not found at $SERVE_PLIST"
    exit 1
fi

log "Main Agent restart complete."
