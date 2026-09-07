#!/bin/bash
#
# deploy.sh — One-click deploy script (stop -> start)
#
# Template variables:
#   <AGENT_NAME> — e.g. news-briefing
#   $CFBRAIN_HOME  — e.g. $HOME/.news-briefing

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

show_help() {
    cat <<'EOF'
Usage: deploy.sh [OPTIONS]

One-click deploy: safely stop, then pull code and start.

Options:
  --help            Show help
  --dry-run         Show what would be done without executing
  --timeout N       Timeout seconds for deploy-stop.sh
  --startup-wait N  Override startup health check wait (default: 10s)

Equivalent to:
  scripts/deploy-stop.sh && scripts/deploy-start.sh
EOF
    exit 0
}

EXTRA_STOP_ARGS=()
EXTRA_START_ARGS=()
DRY_RUN=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --help) show_help ;;
        --dry-run)
            DRY_RUN=true
            EXTRA_STOP_ARGS+=("--dry-run")
            EXTRA_START_ARGS+=("--dry-run")
            shift
            ;;
        --timeout)
            EXTRA_STOP_ARGS+=("--timeout" "$2")
            shift 2
            ;;
        --startup-wait)
            EXTRA_START_ARGS+=("--startup-wait" "$2")
            shift 2
            ;;
        *) echo "Unknown option: $1"; show_help ;;
    esac
done

echo "╔══════════════════════════════════════╗"
echo "║     <AGENT_NAME> Deploy            ║"
echo "╚══════════════════════════════════════╝"
echo ""
echo "Start time: $(date '+%Y-%m-%d %H:%M:%S')"
echo ""

# --- Phase 1: Stop ---
echo "━━━ Phase 1: Shutdown ━━━"
echo ""
if ! bash "$SCRIPT_DIR/deploy-stop.sh" "${EXTRA_STOP_ARGS[@]+"${EXTRA_STOP_ARGS[@]}"}"; then
    echo ""
    echo "⚠️  Shutdown had errors, but continuing with startup..."
fi

echo ""

# --- Phase 2: Start ---
echo "━━━ Phase 2: Startup ━━━"
echo ""
if ! bash "$SCRIPT_DIR/deploy-start.sh" "${EXTRA_START_ARGS[@]+"${EXTRA_START_ARGS[@]}"}"; then
    echo ""
    echo "╔══════════════════════════════════════╗"
    echo "║  ❌ Deploy completed with errors      ║"
    echo "╚══════════════════════════════════════╝"
    echo "End time: $(date '+%Y-%m-%d %H:%M:%S')"
    exit 1
fi

echo ""
echo "╔══════════════════════════════════════╗"
echo "║  ✅ Deploy complete                   ║"
echo "╚══════════════════════════════════════╝"
echo "End time: $(date '+%Y-%m-%d %H:%M:%S')"
exit 0
