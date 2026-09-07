#!/bin/bash
#
# cron-poll-precheck.sh — Lightweight precheck for feishu comment polling
#
# Executes `cfbrain feishu poll --json` and determines whether there are
# pending comments to process. Designed to be called by cron-run.sh --agent-if
# mode to avoid starting a full LLM Agent session when there's nothing to do.
#
# Output (stdout):
#   POLL_RESULT=no_comments   — No pending comments, Agent session not needed
#   POLL_RESULT=has_comments  — Pending comments found, data saved for Agent
#   POLL_RESULT=error         — Precheck failed (exit 1)
#
# When has_comments: poll result JSON is written to /tmp/cfbrain-poll-result.json

set -o pipefail

CFBRAIN_EXEC="$CFBRAIN_HOME/shared/scripts/cfbrain-exec.sh"
POLL_OUTPUT_FILE="/tmp/cfbrain-poll-result.json"

# --- Sanity checks ---
if [ ! -f "$CFBRAIN_EXEC" ]; then
    echo "POLL_RESULT=error"
    echo "ERROR: cfbrain-exec.sh not found at $CFBRAIN_EXEC" >&2
    exit 1
fi

# --- Execute poll ---
poll_output=$(bash "$CFBRAIN_EXEC" feishu poll --json 2>/dev/null)
poll_exit=$?

if [ $poll_exit -ne 0 ]; then
    echo "POLL_RESULT=error"
    echo "ERROR: feishu poll --json exited with code $poll_exit" >&2
    exit 1
fi

# --- Validate JSON structure ---
if [ -z "$poll_output" ]; then
    echo "POLL_RESULT=error"
    echo "ERROR: feishu poll --json returned empty output" >&2
    exit 1
fi

# --- Parse pending_comments count ---
# Use jq if available, fallback to grep-based parsing
if command -v jq >/dev/null 2>&1; then
    comment_count=$(echo "$poll_output" | jq '.pending_comments | length' 2>/dev/null)
    if [ $? -ne 0 ] || [ -z "$comment_count" ]; then
        echo "POLL_RESULT=error"
        echo "ERROR: failed to parse poll JSON with jq" >&2
        exit 1
    fi
else
    # Fallback: check if pending_comments array is empty []
    # This handles the common case where jq is not installed
    if echo "$poll_output" | grep -q '"pending_comments":\s*\[\]'; then
        comment_count=0
    elif echo "$poll_output" | grep -q '"pending_comments":\s*\['; then
        # Non-empty array — count elements by counting opening braces after pending_comments
        comment_count=$(echo "$poll_output" | grep -o '"slug"' | wc -l | tr -d ' ')
        # Ensure at least 1 if we got here
        [ "$comment_count" -eq 0 ] && comment_count=1
    else
        echo "POLL_RESULT=error"
        echo "ERROR: unexpected poll output format (no pending_comments field)" >&2
        exit 1
    fi
fi

# --- Decision ---
if [ "$comment_count" -eq 0 ]; then
    echo "POLL_RESULT=no_comments"
    exit 0
else
    # Save full poll result for Agent consumption
    echo "$poll_output" > "$POLL_OUTPUT_FILE"
    echo "POLL_RESULT=has_comments"
    echo "INFO: ${comment_count} pending comment(s) saved to ${POLL_OUTPUT_FILE}" >&2
    exit 0
fi
