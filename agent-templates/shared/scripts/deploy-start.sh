#!/bin/bash
#
# deploy-start.sh — Safe startup script (parameterized template, monorepo layout)
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
#   1. Pre-flight checks (git status, key files)
#   2. git pull across all 4 clone roots
#   2.5 Sync plist files to ~/Library/LaunchAgents/
#   2.6 Validate plist file integrity
#   3. Load all LaunchAgent plists
#   4. Verify opencode serve processes (all 4 ports)
#   5. Verify lark bridge (if applicable)
#   6. Output startup report

set -uo pipefail

WORK_DIR="$CFBRAIN_HOME"
CLONE_ROOTS=(
    "$CFBRAIN_HOME"
    "$CFBRAIN_HOME-generator"
    "$CFBRAIN_HOME-evaluator"
    "$CFBRAIN_HOME-planner"
)
CLONE_AGENTS=(
    "main"
    "generator"
    "evaluator"
    "planner"
)

# --- Read serve ports from port-registry.json ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT_REGISTRY="${SCRIPT_DIR}/port-registry.json"
if command -v jq >/dev/null 2>&1 && [ -f "$PORT_REGISTRY" ]; then
    SERVE_PORTS=( $(jq -r '.[]' "$PORT_REGISTRY" 2>/dev/null) )
elif [ -f "$PORT_REGISTRY" ]; then
    SERVE_PORTS=( $(grep -oE '[0-9]+' "$PORT_REGISTRY" | grep -v '^$') )
fi
if [ "${#SERVE_PORTS[@]}" -eq 0 ]; then
    SERVE_PORTS=(3496 3497 3498 3499)  # fallback
fi

PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATTERN="com.<AGENT_NAME>"
STARTUP_WAIT=10
HEALTH_RETRIES=3
HEALTH_RETRY_INTERVAL=5

show_help() {
    cat <<'EOF'
Usage: deploy-start.sh [OPTIONS]

Start all <AGENT_NAME> LaunchAgents and verify service status.

Options:
  --help            Show help
  --skip-pull       Skip git pull step
  --skip-checks     Skip pre-flight checks
  --dry-run         Show what would be done without executing
  --startup-wait N  Override initial wait before health check (default: 10s)
EOF
    exit 0
}

DRY_RUN=false
SKIP_PULL=false
SKIP_CHECKS=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        --help) show_help ;;
        --skip-pull) SKIP_PULL=true; shift ;;
        --skip-checks) SKIP_CHECKS=true; shift ;;
        --dry-run) DRY_RUN=true; shift ;;
        --startup-wait)
            if [[ -z "${2:-}" ]] || ! [[ "$2" =~ ^[0-9]+$ ]]; then
                echo "Error: --startup-wait requires a positive integer" >&2
                exit 1
            fi
            STARTUP_WAIT="$2"; shift 2
            ;;
        *) echo "Unknown option: $1"; show_help ;;
    esac
done

passed=0
failed=0
warnings=0
step_pass() { echo "  ✅ $1"; ((passed++)); }
step_fail() { echo "  ❌ $1"; ((failed++)); }
step_warn() { echo "  ⚠️  $1"; ((warnings++)); }
step_skip() { echo "  ⏭️  $1"; }

echo "=== <AGENT_NAME> Startup ==="
echo "$(date '+%Y-%m-%d %H:%M:%S')"
echo ""

# --- Step 1: Pre-flight checks ---
echo "Step 1: Pre-flight checks..."
if [ "$SKIP_CHECKS" = true ]; then
    step_skip "Pre-flight checks skipped (--skip-checks)"
else
    cd "$WORK_DIR"

    git_status=$(git status --porcelain 2>/dev/null)
    if [ -z "$git_status" ]; then
        step_pass "Git working directory clean"
    else
        dirty_count=$(echo "$git_status" | wc -l | tr -d ' ')
        step_warn "Git has ${dirty_count} uncommitted changes (continuing startup)"
    fi

    missing_files=""
    for f in main/AGENTS.md shared/control/guardrails.md; do
        [ -f "$WORK_DIR/$f" ] || missing_files="$missing_files $f"
    done
    if [ -z "$missing_files" ]; then
        step_pass "Key files present"
    else
        step_fail "Missing key files:${missing_files}"
    fi

    if command -v opencode &>/dev/null || [ -x /opt/homebrew/bin/opencode ]; then
        step_pass "opencode executable found"
    else
        step_fail "opencode not found"
    fi
fi

# --- Step 2: git pull in all clone roots ---
echo ""
echo "Step 2: Pulling latest code (4 clone roots)..."
if [ "$SKIP_PULL" = true ]; then
    step_skip "git pull skipped (--skip-pull)"
else
    for i in "${!CLONE_ROOTS[@]}"; do
        ws="${CLONE_ROOTS[$i]}"
        ws_name=$(basename "$ws")

        if [ ! -d "$ws" ]; then
            step_warn "Clone root does not exist: $ws"
            continue
        fi

        cd "$ws"
        if [ "$DRY_RUN" = false ]; then
            git config pull.rebase true 2>/dev/null || true
            pull_output=$(git pull 2>&1)
            pull_exit=$?
            if [ $pull_exit -eq 0 ]; then
                step_pass "[$ws_name] git pull complete"
            else
                step_fail "[$ws_name] git pull failed: $pull_output"
            fi
            # monorepo: AGENTS.md is in each role's subdirectory, no cp needed
        else
            step_skip "DRY RUN: skip [$ws_name] git pull"
        fi
    done
fi

# --- Step 2.5: Install/update plist files from repo ---
echo ""
echo "Step 2.5: Syncing plist files to ~/Library/LaunchAgents/..."
plist_src="$WORK_DIR/launchd"
plists_synced=0
if [ -d "$plist_src" ]; then
    for plist in "$plist_src"/*.plist; do
        [ -f "$plist" ] || continue
        plist_name=$(basename "$plist")
        if [ "$DRY_RUN" = false ]; then
            cp "$plist" "$PLIST_DIR/$plist_name"
            plists_synced=$((plists_synced + 1))
        else
            echo "  DRY RUN: sync $plist_name"
            plists_synced=$((plists_synced + 1))
        fi
    done
    step_pass "Synced ${plists_synced} plists from launchd/ to ~/Library/LaunchAgents/"
else
    step_warn "launchd/ directory not found, skipping plist sync"
fi

# --- Step 2.6: Validate plist files (no unexpanded variables) ---
echo ""
echo "Step 2.6: Validating plist file integrity..."
plist_errors=0
for plist in "$PLIST_DIR"/${PLIST_PATTERN}*.plist; do
    [ -f "$plist" ] || continue
    if grep -q '\${' "$plist" || grep -q '{{' "$plist"; then
        plist_name=$(basename "$plist")
        step_fail "$plist_name contains unexpanded variables"
        plist_errors=$((plist_errors + 1))
    fi
done
if [ "$plist_errors" -eq 0 ]; then
    step_pass "All plist files validated (no unexpanded variables)"
fi

# --- Step 3: Load LaunchAgent plists ---
echo ""
echo "Step 3: Loading LaunchAgent plists..."
plists_found=0
plists_loaded=0
for plist in "$PLIST_DIR"/*.plist; do
    [ -f "$plist" ] || continue
    basename=$(basename "$plist")
    if echo "$basename" | grep -q "$PLIST_PATTERN"; then
        plists_found=$((plists_found + 1))
        label="${basename%.plist}"
        if [ "$DRY_RUN" = false ]; then
            uid=$(id -u)
            launchctl bootout "gui/${uid}/${label}" 2>/dev/null || true
            bootstrap_output=$(launchctl bootstrap "gui/${uid}" "$plist" 2>&1)
            bootstrap_exit=$?
            if [ $bootstrap_exit -eq 0 ]; then
                plists_loaded=$((plists_loaded + 1))
                echo "  Loaded: $basename (bootstrap)"
            else
                load_output=$(launchctl load "$plist" 2>&1)  # fallback for older macOS
                load_exit=$?
                if [ $load_exit -eq 0 ]; then
                    plists_loaded=$((plists_loaded + 1))
                    echo "  Loaded: $basename (load fallback)"
                else
                    echo "  Load failed: $basename — bootstrap: $bootstrap_output / load: $load_output"
                fi
            fi
        else
            plists_loaded=$((plists_loaded + 1))
            echo "  DRY RUN load: $basename"
        fi
    fi
done

if [ "$plists_found" -eq 0 ]; then
    step_fail "No <AGENT_NAME> plists found"
else
    step_pass "Found ${plists_found} plists, newly loaded ${plists_loaded}"
fi

# --- Step 4: Verify opencode serve (all 4 ports) with retry ---
echo ""
echo "Step 4: Verifying opencode serve processes (4 ports)..."
if [ "$DRY_RUN" = true ]; then
    step_skip "DRY RUN: skipping verification"
else
    echo "  Waiting ${STARTUP_WAIT}s for services to start..."
    sleep "$STARTUP_WAIT"

    # Process detection (informational)
    serve_detected=0
    for port in "${SERVE_PORTS[@]}"; do
        port_pid=$(pgrep -f "opencode.*serve.*--port ${port}" 2>/dev/null || true)
        if [ -n "$port_pid" ]; then
            serve_detected=$((serve_detected + 1))
        fi
    done
    if [ "$serve_detected" -eq 4 ]; then
        step_pass "${serve_detected}/4 serve processes detected for <AGENT_NAME>"
    elif [ "$serve_detected" -gt 0 ]; then
        step_warn "${serve_detected}/4 serve processes detected for <AGENT_NAME> (partial startup)"
    else
        step_warn "0/4 serve processes detected for <AGENT_NAME> (may still be starting)"
    fi

    # Health check with retry loop
    ports_remaining=("${SERVE_PORTS[@]}")
    retry=0

    while [ ${#ports_remaining[@]} -gt 0 ] && [ "$retry" -le "$HEALTH_RETRIES" ]; do
        if [ "$retry" -gt 0 ]; then
            wait_time=$((HEALTH_RETRY_INTERVAL * retry))
            echo "  Retry ${retry}/${HEALTH_RETRIES}: waiting ${wait_time}s for ${#ports_remaining[@]} port(s)..."
            sleep "$wait_time"
        fi

        still_pending=()
        for port in "${ports_remaining[@]}"; do
            http_code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${port}" 2>/dev/null || echo "000")
            if [ "$http_code" = "200" ]; then
                step_pass "Port ${port} responding"
            else
                # Check if process exists — if not, it's a hard failure (no retry)
                port_pid=$(pgrep -f "opencode.*serve.*--port ${port}" 2>/dev/null || true)
                if [ -z "$port_pid" ]; then
                    step_fail "Port ${port} — process not found (service failed to start)"
                else
                    still_pending+=("$port")
                fi
            fi
        done
        ports_remaining=("${still_pending[@]+"${still_pending[@]}"}")
        retry=$((retry + 1))
    done

    # Any ports still pending after all retries exhausted
    for port in "${ports_remaining[@]+"${ports_remaining[@]}"}"; do
        step_warn "Port ${port} not responding after ${HEALTH_RETRIES} retries (may need more time, check manually)"
    done
fi

# --- Step 5: Verify lark bridge ---
echo ""
echo "Step 5: Verifying Feishu chat bridge (optional)..."
if [ "$DRY_RUN" = true ]; then
    step_skip "DRY RUN: skipping verification"
else
    # The chat bridge is NOT part of this repository — see the "飞书 Bot" section
    # in main/AGENTS.md. This check only reports whether you wired one up yourself.
    lark_pid=$(pgrep -f "lark.*bridge.*<AGENT_NAME>" 2>/dev/null || true)
    if [ -n "$lark_pid" ]; then
        step_pass "Feishu chat bridge running (PID: $lark_pid)"
    else
        step_skip "No Feishu chat bridge detected (optional — not shipped with CFBrain)"
    fi
fi

# --- Step 6: Summary ---
echo ""
echo "=== Startup Report ==="
if [ "$DRY_RUN" = true ]; then
    echo "Mode: DRY RUN (no actions taken)"
fi

loaded_count=$(launchctl list 2>/dev/null | grep -c "$PLIST_PATTERN" || true)
echo "Loaded plists: ${loaded_count}"
echo "Passed: ${passed}  Warnings: ${warnings}  Failed: ${failed}"

if [ "$failed" -eq 0 ]; then
    echo "Result: ✅ Startup complete"
    exit 0
else
    echo "Result: ❌ Startup had errors, check output above"
    exit 1
fi
