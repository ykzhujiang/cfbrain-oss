#!/bin/bash
#
# cron-health-repair.sh — PGLite auto-healing: doctor + repair pipeline
#
# Called by cron-run.sh --script cron-health-repair <this-script>
# Runs daily at 05:00 via com.<AGENT_NAME>.cron-health-repair.plist
#
# Logic:
#   1. Run cfbrain doctor --json
#   2. Parse each check's status
#   3. For actionable warns, execute corresponding repair command
#   4. Re-run doctor to verify fix
#   5. Output summary
#
# Known skip list (non-actionable warns):
#   - pgvector: PGLite WASM limitation, permanent warn
#   - rls: PGLite WASM limitation, permanent warn
#
# New/unknown checks default to SKIP (conservative). Add explicit mapping below
# to enable auto-repair for new doctor checks.
#

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFBRAIN_EXEC="${SCRIPT_DIR}/cfbrain-exec.sh"

# Validate cfbrain-exec.sh exists
if [ ! -f "$CFBRAIN_EXEC" ]; then
    echo "[health-repair] ERROR: cfbrain-exec.sh not found at $CFBRAIN_EXEC" >&2
    exit 1
fi

# --- Step 1: Run doctor --json ---
echo "[health-repair] Running doctor --json..."
DOCTOR_OUTPUT=$(bash "$CFBRAIN_EXEC" doctor --json 2>/dev/null)
DOCTOR_EXIT=$?

if [ $DOCTOR_EXIT -ne 0 ] && [ -z "$DOCTOR_OUTPUT" ]; then
    echo "[health-repair] ERROR: doctor command failed with exit code $DOCTOR_EXIT and no output" >&2
    exit 1
fi

# --- Step 2: Parse checks and identify actionable warns ---
# Doctor --json format: {"status":"healthy","checks":[{"name":"...","status":"ok|warn|error","message":"..."},...]}
# Handles both: top-level array (legacy) and .checks array (current)

repaired_count=0
repaired_list=""
failed_list=""

# Helper: extract checks with warn status using jq (preferred) or grep fallback
parse_warns() {
    if command -v jq >/dev/null 2>&1; then
        # Try .checks[] first (current format), fallback to .[] (legacy/flat array)
        local result
        result=$(echo "$DOCTOR_OUTPUT" | jq -r '(.checks // .)[] | select(.status == "warn") | "\(.name)|\(.message)"' 2>/dev/null)
        echo "$result"
    else
        # Fallback: grep-based parsing
        echo "$DOCTOR_OUTPUT" | grep -o '"name":"[^"]*"' | sed 's/"name":"//;s/"//' | while read -r check_name; do
            # Extract the full object for this check
            local check_block
            check_block=$(echo "$DOCTOR_OUTPUT" | grep -o "{[^}]*\"name\":\"${check_name}\"[^}]*}")
            local check_status
            check_status=$(echo "$check_block" | grep -o '"status":"[^"]*"' | sed 's/"status":"//;s/"//')
            if [ "$check_status" = "warn" ]; then
                local check_msg
                check_msg=$(echo "$check_block" | grep -o '"message":"[^"]*"' | sed 's/"message":"//;s/"//')
                echo "${check_name}|${check_msg}"
            fi
        done
    fi
}

warns=$(parse_warns)

if [ -z "$warns" ]; then
    echo "[health-repair] All checks OK, no repair needed"
    exit 0
fi

echo "[health-repair] Found warn(s), evaluating repair actions..."

# --- Step 3: Execute repairs for actionable warns ---
while IFS='|' read -r check_name check_message; do
    [ -z "$check_name" ] && continue

    case "$check_name" in
        pk_integrity)
            if echo "$check_message" | grep -qi "duplicate"; then
                echo "[health-repair] Repairing: $check_name (dedup)"
                repair_output=$(bash "$CFBRAIN_EXEC" repair --dedup 2>&1)
                repair_exit=$?
                echo "[health-repair]   Output: $repair_output"
                echo "[health-repair]   Exit code: $repair_exit"
                if [ $repair_exit -eq 0 ]; then
                    repaired_count=$((repaired_count + 1))
                    repaired_list="${repaired_list:+${repaired_list}, }${check_name}(--dedup)"
                else
                    failed_list="${failed_list:+${failed_list}, }${check_name}(--dedup)"
                fi
            else
                echo "[health-repair] SKIP: $check_name (warn but message not matching 'duplicate')"
            fi
            ;;

        index_health)
            if echo "$check_message" | grep -qi "index"; then
                echo "[health-repair] Repairing: $check_name (index)"
                repair_output=$(bash "$CFBRAIN_EXEC" repair --index 2>&1)
                repair_exit=$?
                echo "[health-repair]   Output: $repair_output"
                echo "[health-repair]   Exit code: $repair_exit"
                if [ $repair_exit -eq 0 ]; then
                    repaired_count=$((repaired_count + 1))
                    repaired_list="${repaired_list:+${repaired_list}, }${check_name}(--index)"
                else
                    failed_list="${failed_list:+${failed_list}, }${check_name}(--index)"
                fi
            else
                echo "[health-repair] SKIP: $check_name (warn but message not matching 'index')"
            fi
            ;;

        embeddings)
            if echo "$check_message" | grep -qi "missing"; then
                echo "[health-repair] Repairing: $check_name (embed)"
                repair_output=$(bash "$CFBRAIN_EXEC" repair --embed 2>&1)
                repair_exit=$?
                echo "[health-repair]   Output: $repair_output"
                echo "[health-repair]   Exit code: $repair_exit"
                if [ $repair_exit -eq 0 ]; then
                    repaired_count=$((repaired_count + 1))
                    repaired_list="${repaired_list:+${repaired_list}, }${check_name}(--embed)"
                else
                    failed_list="${failed_list:+${failed_list}, }${check_name}(--embed)"
                fi
            else
                echo "[health-repair] SKIP: $check_name (warn but message not matching 'missing')"
            fi
            ;;

        pgvector|rls)
            echo "[health-repair] SKIP: $check_name (known PGLite WASM limitation, no repair available)"
            ;;

        *)
            echo "[health-repair] SKIP: $check_name (unknown check, not in repair mapping — add explicitly to enable)"
            ;;
    esac
done <<< "$warns"

# --- Step 4: If any repairs were made, verify with a second doctor run ---
if [ $repaired_count -gt 0 ]; then
    echo ""
    echo "[health-repair] Verifying repairs with second doctor run..."
    POST_DOCTOR_OUTPUT=$(bash "$CFBRAIN_EXEC" doctor --json 2>/dev/null)

    # Check if previously-warned checks are now OK
    if command -v jq >/dev/null 2>&1; then
        post_warns=$(echo "$POST_DOCTOR_OUTPUT" | jq -r '[(.checks // .)[] | select(.status == "warn") | .name] | join(", ")' 2>/dev/null)
    else
        post_warns=$(echo "$POST_DOCTOR_OUTPUT" | grep -o '"status":"warn"' | wc -l | tr -d ' ')
        post_warns="${post_warns} warn(s) remaining"
    fi

    if [ -z "$post_warns" ]; then
        echo "[health-repair] Post-repair doctor: all checks OK"
    else
        echo "[health-repair] Post-repair doctor: remaining warns: $post_warns"
    fi
fi

# --- Step 5: Output summary ---
echo ""
if [ -n "$failed_list" ]; then
    echo "[health-repair] ERROR: repair failed for: $failed_list. Manual intervention needed."
    exit 1
fi

if [ $repaired_count -gt 0 ]; then
    echo "[health-repair] Repaired $repaired_count issue(s): $repaired_list. Post-repair doctor: ${post_warns:-all OK}"
else
    echo "[health-repair] No actionable repairs needed (all warns are in skip list)"
fi

exit 0
