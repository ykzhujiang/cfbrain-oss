#!/bin/bash
#
# deploy-stop.sh — Safe shutdown script (parameterized template, monorepo layout)
#
# Template variables:
#   <AGENT_NAME>          — e.g. news-briefing
#   $CFBRAIN_HOME           — Monorepo root, e.g. $HOME/.news-briefing
#   $CFBRAIN_HOME-generator — e.g. $HOME/.news-briefing-generator
#   $CFBRAIN_HOME-evaluator — e.g. $HOME/.news-briefing-evaluator
#   $CFBRAIN_HOME-planner   — e.g. $HOME/.news-briefing-planner
#   3496           — e.g. 3468
#   3497      — e.g. 3469
#   3498      — e.g. 3470
#   3499        — e.g. 3471
#   com.<AGENT_NAME>        — e.g. com.news-briefing
#
# Steps:
#   1. Unload all LaunchAgent plists (prevent new cycles)
#   2. Wait for running Agent processes to exit naturally
#   3. Clean residual opencode processes (SIGTERM only)
#   4. Clean lock files
#   5. Verify all processes exited
#   6. Output shutdown report

set -uo pipefail

HUMAN_PROMPT_THRESHOLD=600
LOCK_PATTERN="/tmp/<AGENT_NAME>-*.lock"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATTERN="com.<AGENT_NAME>"

# --- Read serve ports from port-registry.json ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT_REGISTRY="${SCRIPT_DIR}/port-registry.json"
if command -v jq >/dev/null 2>&1 && [ -f "$PORT_REGISTRY" ]; then
    PORTS=$(jq -r '[.[]] | map(tostring) | join("|")' "$PORT_REGISTRY" 2>/dev/null)
elif [ -f "$PORT_REGISTRY" ]; then
    PORTS=$(grep -oE '[0-9]+' "$PORT_REGISTRY" | tr '\n' '|' | sed 's/|$//')
fi
PORTS="${PORTS:-3496|3497|3498|3499}"

show_help() {
    cat <<'EOF'
Usage: deploy-stop.sh [OPTIONS]

Safely stop all <AGENT_NAME> related processes and LaunchAgents.

Options:
  --help       Show help
  --dry-run    Show what would be done without executing
  --timeout N  Override wait threshold in seconds before prompting to
               force-kill (default: 600). Must be a positive integer.
EOF
    exit "${1:-0}"
}

DRY_RUN=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        --help) show_help 0 ;;
        --dry-run) DRY_RUN=true; shift ;;
        --timeout)
            if [[ -z "${2:-}" ]] || ! [[ "$2" =~ ^[0-9]+$ ]] || [[ "$2" -eq 0 ]]; then
                echo "Error: --timeout requires a positive integer" >&2
                exit 1
            fi
            HUMAN_PROMPT_THRESHOLD="$2"
            shift 2
            ;;
        *) echo "Error: Unknown option: $1" >&2; show_help 1 ;;
    esac
done

passed=0
failed=0
step_pass() { echo "  ✅ $1"; ((passed++)); }
step_fail() { echo "  ❌ $1"; ((failed++)); }
step_skip() { echo "  ⏭️  $1"; }

echo "=== <AGENT_NAME> Shutdown ==="
echo "$(date '+%Y-%m-%d %H:%M:%S')"
echo ""

# --- Step 1: Unload all LaunchAgent plists ---
echo "Step 1: Unloading LaunchAgent plists..."
plists_found=0
plists_unloaded=0
for plist in "$PLIST_DIR"/*.plist; do
    [ -f "$plist" ] || continue
    basename=$(basename "$plist")
    if echo "$basename" | grep -q "$PLIST_PATTERN"; then
        plists_found=$((plists_found + 1))
        label="${basename%.plist}"
        is_loaded=$(launchctl list 2>/dev/null | grep -c "$label" || true)
        if [ "$is_loaded" -gt 0 ]; then
            if [ "$DRY_RUN" = false ]; then
                uid=$(id -u)
                launchctl bootout "gui/${uid}/${label}" 2>/dev/null || true
            fi
            plists_unloaded=$((plists_unloaded + 1))
            echo "  Unloaded: $basename"
        else
            echo "  Already unloaded: $basename (skip)"
        fi
    fi
done

if [ "$plists_found" -eq 0 ]; then
    step_skip "No <AGENT_NAME> plists found"
else
    step_pass "Found ${plists_found} plists, unloaded ${plists_unloaded}"
fi

# --- Step 2: Wait for running Agent processes to exit naturally ---
echo ""
echo "Step 2: Waiting for Agent processes to exit..."
agent_pids=$(pgrep -f "opencode.*(serve.*(${PORTS})|run.*(planner|generator|evaluator)|<AGENT_NAME>)" 2>/dev/null || true)
if [ -z "$agent_pids" ]; then
    step_skip "No running Agent processes found"
else
    pid_count=$(echo "$agent_pids" | wc -l | tr -d ' ')
    echo "  Found ${pid_count} Agent processes: $(echo $agent_pids | tr '\n' ' ')"
    echo "  Waiting for natural exit (no force kill)..."

    elapsed=0
    prompted=false
    while true; do
        remaining_pids=$(pgrep -f "opencode.*(serve.*(${PORTS})|run.*(planner|generator|evaluator)|<AGENT_NAME>)" 2>/dev/null || true)
        if [ -z "$remaining_pids" ]; then
            break
        fi
        sleep 5
        elapsed=$((elapsed + 5))
        if [ $((elapsed % 30)) -eq 0 ]; then
            remaining_count=$(echo "$remaining_pids" | wc -l | tr -d ' ')
            echo "  ⏳ Waited ${elapsed}s... ${remaining_count} processes remaining"
        fi

        if [ $elapsed -ge "$HUMAN_PROMPT_THRESHOLD" ] && [ "$prompted" = false ]; then
            prompted=true
            remaining_count=$(echo "$remaining_pids" | wc -l | tr -d ' ')
            echo ""
            echo "  ⚠️  Waited over 10 minutes, ${remaining_count} processes still running"
            echo "  Process list:"
            ps -p $(echo "$remaining_pids" | tr '\n' ',') -o pid,etime,command 2>/dev/null | head -5 || true
            echo ""
            if [ -t 0 ]; then
                read -p "  Force kill? (y=kill / n=keep waiting / q=quit): " answer
                case "$answer" in
                    y|Y)
                        echo "  Force killing..."
                        echo "$remaining_pids" | xargs kill -9 2>/dev/null || true
                        sleep 2
                        break
                        ;;
                    q|Q)
                        echo "  Exiting script, processes still running"
                        exit 1
                        ;;
                    *)
                        echo "  Continuing to wait..."
                        ;;
                esac
            else
                echo "  Non-interactive mode, continuing to wait..."
            fi
        fi
    done

    remaining_pids=$(pgrep -f "opencode.*(serve.*(${PORTS})|run.*(planner|generator|evaluator)|<AGENT_NAME>)" 2>/dev/null || true)
    if [ -z "$remaining_pids" ]; then
        step_pass "Agent processes exited (${elapsed}s)"
    else
        step_fail "Some processes still running: $remaining_pids"
    fi
fi

# --- Step 3: Clean residual opencode processes (SIGTERM only) ---
echo ""
echo "Step 3: Cleaning residual opencode processes..."
residual_pids=$(pgrep -f "opencode.*(serve.*(${PORTS})|run.*(planner|generator|evaluator)|<AGENT_NAME>)" 2>/dev/null || true)
if [ -z "$residual_pids" ]; then
    step_skip "No residual opencode processes"
else
    residual_count=$(echo "$residual_pids" | wc -l | tr -d ' ')
    if [ "$DRY_RUN" = false ]; then
        echo "$residual_pids" | xargs kill -15 2>/dev/null || true
        sleep 3
        final_residual=$(pgrep -f "opencode.*(serve.*(${PORTS})|<AGENT_NAME>)" 2>/dev/null || true)
        if [ -z "$final_residual" ]; then
            step_pass "Cleaned ${residual_count} residual processes (SIGTERM)"
        else
            still_count=$(echo "$final_residual" | wc -l | tr -d ' ')
            echo "  ⚠️  ${still_count} processes did not respond to SIGTERM"
            if [ -t 0 ]; then
                read -p "  Force kill (kill -9)? (y/n): " answer
                if [ "$answer" = "y" ] || [ "$answer" = "Y" ]; then
                    echo "$final_residual" | xargs kill -9 2>/dev/null || true
                    sleep 1
                    step_pass "Force killed residual processes"
                else
                    step_fail "Processes still running (user chose not to force kill)"
                fi
            else
                step_fail "Non-interactive mode, ${still_count} processes not terminated"
            fi
        fi
    else
        echo "  DRY RUN: Would terminate ${residual_count} processes: $(echo $residual_pids | tr '\n' ' ')"
        step_pass "DRY RUN: Found ${residual_count} processes to clean"
    fi
fi

# --- Step 4: Clean lock files ---
echo ""
echo "Step 4: Cleaning lock files..."
locks_found=0
locks_cleaned=0
for lock in $LOCK_PATTERN; do
    [ -e "$lock" ] || continue
    locks_found=$((locks_found + 1))
    if [ "$DRY_RUN" = false ]; then
        rm -rf "$lock" 2>/dev/null && locks_cleaned=$((locks_cleaned + 1))
    else
        locks_cleaned=$((locks_cleaned + 1))
    fi
    echo "  Cleaned: $lock"
done

if [ "$locks_found" -eq 0 ]; then
    step_skip "No residual lock files"
else
    step_pass "Cleaned ${locks_cleaned}/${locks_found} lock files"
fi

# --- Step 5: Verify all processes exited ---
echo ""
echo "Step 5: Verifying process state..."
if [ "$DRY_RUN" = true ]; then
    step_skip "DRY RUN: skipping verification"
else
    verify_pids=$(pgrep -f "opencode.*(serve.*(${PORTS})|run.*(planner|generator|evaluator)|<AGENT_NAME>)" 2>/dev/null || true)
    verify_loaded=$(launchctl list 2>/dev/null | grep -c "$PLIST_PATTERN" || true)
    verify_locks=0
    for lock in $LOCK_PATTERN; do [ -e "$lock" ] && verify_locks=$((verify_locks + 1)); done

    if [ -z "$verify_pids" ] && [ "$verify_loaded" -eq 0 ] && [ "$verify_locks" -eq 0 ]; then
        step_pass "Verification passed: no processes, no loaded plists, no locks"
    else
        [ -n "$verify_pids" ] && step_fail "Still have opencode processes: $verify_pids"
        [ "$verify_loaded" -gt 0 ] && step_fail "${verify_loaded} plists still loaded"
        [ "$verify_locks" -gt 0 ] && step_fail "${verify_locks} lock files still exist"
    fi
fi

# --- Step 6: Summary ---
echo ""
echo "=== Shutdown Report ==="
if [ "$DRY_RUN" = true ]; then
    echo "Mode: DRY RUN (no actions taken)"
fi
echo "Passed: ${passed}  Failed: ${failed}"

if [ "$failed" -eq 0 ]; then
    echo "Result: ✅ Shutdown complete"
    exit 0
else
    echo "Result: ❌ Shutdown had errors, check output above"
    exit 1
fi
