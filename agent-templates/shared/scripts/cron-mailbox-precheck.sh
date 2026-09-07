#!/bin/bash
#
# cron-mailbox-precheck.sh — Lightweight precheck for the mailbox collector
# (prd-2026-08-28-002). Modelled on cron-poll-precheck.sh.
#
# Executes `cfbrain mail fetch --json` and decides whether the Main Agent needs
# to be woken up. Keeping this in a script means the common "nothing arrived"
# case costs no LLM tokens.
#
# Output (stdout):
#   MAILBOX_RESULT=no_work   — nothing to do, Agent session not needed
#   MAILBOX_RESULT=has_work  — new fragments (or a due retry), batch saved for Agent
#   MAILBOX_RESULT=error     — precheck failed (exit 1)
#
# When has_work: the fetch report is written to /tmp/cfbrain-mailbox-batch.json
#
# --- Configuration (deliberately not hardcoded; directive section 6 requires
# --- that the threshold and the retry window stay tunable) ---
MAILBOX_TRIGGER_THRESHOLD="${MAILBOX_TRIGGER_THRESHOLD:-1}"
MAILBOX_RETRY_HOURS="${MAILBOX_RETRY_HOURS:-24}"
MAILBOX_FETCH_LIMIT="${MAILBOX_FETCH_LIMIT:-50}"

set -o pipefail

CFBRAIN_EXEC="$CFBRAIN_HOME/shared/scripts/cfbrain-exec.sh"
BATCH_OUTPUT_FILE="/tmp/cfbrain-mailbox-batch.json"

# --- Sanity checks ---
if [ ! -f "$CFBRAIN_EXEC" ]; then
    echo "MAILBOX_RESULT=error"
    echo "ERROR: cfbrain-exec.sh not found at $CFBRAIN_EXEC" >&2
    exit 1
fi

# The API key must be present in the environment. We only test for emptiness —
# the value is never printed, logged or echoed (guardrails: 绝不暴露 API Key).
if [ -z "${AGENTMAIL_API_KEY:-}" ]; then
    echo "MAILBOX_RESULT=error"
    echo "ERROR: AGENTMAIL_API_KEY is not set in the environment" >&2
    exit 1
fi

# --- Execute fetch ---
fetch_output=$(bash "$CFBRAIN_EXEC" mail fetch --json \
    --limit "$MAILBOX_FETCH_LIMIT" \
    --retry-hours "$MAILBOX_RETRY_HOURS" 2>/dev/null)
fetch_exit=$?

if [ $fetch_exit -ne 0 ]; then
    # Fetch failed → do not consume mail, do not write a batch. Next run retries.
    echo "MAILBOX_RESULT=error"
    echo "ERROR: mail fetch --json exited with code $fetch_exit" >&2
    exit 1
fi

if [ -z "$fetch_output" ]; then
    echo "MAILBOX_RESULT=error"
    echo "ERROR: mail fetch --json returned empty output" >&2
    exit 1
fi

# --- Parse new_count and retry_candidates ---
# Use jq when available, fall back to grep (same approach as cron-poll-precheck.sh).
if command -v jq >/dev/null 2>&1; then
    new_count=$(echo "$fetch_output" | jq '.new_count' 2>/dev/null)
    retry_count=$(echo "$fetch_output" | jq '.retry_candidates | length' 2>/dev/null)
    if [ -z "$new_count" ] || [ "$new_count" = "null" ]; then
        echo "MAILBOX_RESULT=error"
        echo "ERROR: failed to parse fetch JSON with jq (no new_count field)" >&2
        exit 1
    fi
    if [ -z "$retry_count" ] || [ "$retry_count" = "null" ]; then
        retry_count=0
    fi
else
    new_count=$(echo "$fetch_output" | grep -o '"new_count"[[:space:]]*:[[:space:]]*[0-9]*' \
        | grep -o '[0-9]*$' | head -1)
    if [ -z "$new_count" ]; then
        echo "MAILBOX_RESULT=error"
        echo "ERROR: unexpected fetch output format (no new_count field)" >&2
        exit 1
    fi
    # Empty retry_candidates array → 0; otherwise count the quoted entries.
    if echo "$fetch_output" | grep -q '"retry_candidates"[[:space:]]*:[[:space:]]*\[\]'; then
        retry_count=0
    else
        retry_count=$(echo "$fetch_output" | sed -n '/"retry_candidates"/,/\]/p' \
            | grep -c '"pending/')
    fi
    [ -z "$retry_count" ] && retry_count=0
fi

# --- Decision ---
# Trigger only on genuinely new fragments or an explicitly failed batch whose
# retry window has elapsed.
#
# Note what is deliberately NOT a trigger: an unanswered draft sitting in
# pending/. Directive section 3 says 确认超时（<OWNER>未回）→ 不自动执行，不催.
# Without this restraint a 30-minute task would re-nag about the same draft
# 48 times a day.
if [ "$new_count" -ge "$MAILBOX_TRIGGER_THRESHOLD" ] || [ "$retry_count" -gt 0 ]; then
    echo "$fetch_output" > "$BATCH_OUTPUT_FILE"
    echo "MAILBOX_RESULT=has_work"
    echo "INFO: ${new_count} new fragment(s), ${retry_count} retry candidate(s) saved to ${BATCH_OUTPUT_FILE}" >&2
    exit 0
else
    echo "MAILBOX_RESULT=no_work"
    exit 0
fi
