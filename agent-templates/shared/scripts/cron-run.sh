#!/bin/bash
#
# cron-run.sh — Universal cron entry point (parameterized template, monorepo layout)
#
# Template variables:
#   <AGENT_NAME>   — e.g. news-briefing
#   $CFBRAIN_HOME    — Monorepo root, e.g. $HOME/.news-briefing
#   3496    — e.g. 3468
#   <YOUR_FEISHU_APP_ID> — e.g. news-briefing (lark-cli profile name)
#
# Mode 1 (deterministic): cron-run.sh --script <task-name> <script-path>
# Mode 2 (agent task):    cron-run.sh --agent <task-name> <prompt>
# Mode 3 (conditional):   cron-run.sh --agent-if <task-name> <precheck-script> <agent-prompt>
#
# --agent-if precheck contract:
#   The precheck script must print one of the following tokens on stdout.
#   Generic tokens (preferred for new tasks):
#     no_work      — nothing to do, the LLM session is skipped
#     has_work     — work pending, the agent session is launched
#   Legacy feishu-comment tokens (still accepted, do not remove):
#     no_comments  — equivalent to no_work
#     has_comments — equivalent to has_work; additionally prefixes the agent
#                    prompt with the /tmp/cfbrain-poll-result.json pointer
#   Any other output is treated as a failure.

MAX_RETRIES=2
LOG_DIR="/tmp/opencode-<AGENT_NAME>-logs"

# --- Read main port from port-registry.json ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT_REGISTRY="${SCRIPT_DIR}/port-registry.json"
if command -v jq >/dev/null 2>&1 && [ -f "$PORT_REGISTRY" ]; then
    MAIN_PORT=$(jq -r '.main // empty' "$PORT_REGISTRY" 2>/dev/null)
fi
if [ -z "${MAIN_PORT:-}" ] && [ -f "$PORT_REGISTRY" ]; then
    MAIN_PORT=$(grep '"main"' "$PORT_REGISTRY" | sed 's/[^0-9]//g' 2>/dev/null)
fi
MAIN_PORT="${MAIN_PORT:-3496}"

SERVE_URL="http://127.0.0.1:${MAIN_PORT}"
OPENCODE="/opt/homebrew/bin/opencode"

MODE="$1"
TASK_NAME="$2"
PAYLOAD="$3"
AGENT_IF_PROMPT="$4"  # Only used in --agent-if mode

LOG_FILE="${LOG_DIR}/${TASK_NAME}-$(date +%Y%m%d).log"
mkdir -p "$LOG_DIR"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [$TASK_NAME] $1" >> "$LOG_FILE"
}

check_serve() {
    local http_code
    http_code=$(curl -s -o /dev/null -w "%{http_code}" "$SERVE_URL" 2>/dev/null)
    if [ "$http_code" != "200" ]; then
        log "ERROR: serve not reachable at $SERVE_URL (HTTP $http_code)"
        return 1
    fi
    return 0
}

verify_identity() {
    # monorepo: simplified — just check that AGENTS.md exists in CWD
    if [ ! -f "AGENTS.md" ]; then
        log "WARN: AGENTS.md not found in CWD"
        return 1
    fi
    return 0
}

get_identity_label() {
    if grep -q "<AGENT_NAME>" AGENTS.md 2>/dev/null; then
        echo "Main"
    elif grep -q "升级工程师" AGENTS.md 2>/dev/null; then
        echo "Generator"
    elif grep -q "独立质量评估者" AGENTS.md 2>/dev/null; then
        echo "Evaluator"
    elif grep -q "系统规划者" AGENTS.md 2>/dev/null; then
        echo "Planner"
    else
        echo "Unknown"
    fi
}

execute_script() {
    local attempt=$1
    local tmp_output exit_code

    tmp_output=$(mktemp)

    log "Attempt $attempt: executing script $PAYLOAD"

    bash "$PAYLOAD" > "$tmp_output" 2>&1
    exit_code=$?

    local output_size
    output_size=$(wc -c < "$tmp_output" | tr -d ' ')

    log "Attempt $attempt: exit_code=$exit_code output=${output_size}bytes"
    cat "$tmp_output" >> "$LOG_FILE"

    rm -f "$tmp_output"

    if [ "$exit_code" -ne 0 ]; then
        log "FAIL: script returned exit code $exit_code"
        return 1
    fi

    log "SUCCESS"
    return 0
}

execute_agent() {
    local attempt=$1
    local tmp_stdout tmp_stderr exit_code

    tmp_stdout=$(mktemp)
    tmp_stderr=$(mktemp)

    # --- Pre-session: git fetch + reset to ensure workspace matches remote ---
    # Main workspace should mirror origin/main at session start (same strategy as loop-agent.sh).
    # Using git fetch + reset --hard avoids git pull failures when unstaged changes exist.
    log "Syncing workspace with remote..."
    if (cd "$CFBRAIN_HOME" && git fetch origin >> "$LOG_FILE" 2>&1); then
        log "git fetch SUCCESS"

        # Check for unpushed local commits before resetting
        local unpushed
        unpushed=$(cd "$CFBRAIN_HOME" && git log origin/main..HEAD --oneline 2>/dev/null || true)
        if [ -n "$unpushed" ]; then
            local unpushed_count
            unpushed_count=$(echo "$unpushed" | wc -l | tr -d ' ')
            log "WARN: found ${unpushed_count} unpushed local commit(s) — attempting push before reset"
            echo "$unpushed" >> "$LOG_FILE"

            if (cd "$CFBRAIN_HOME" && git push >> "$LOG_FILE" 2>&1); then
                log "Push of local commits SUCCESS — pulling to fast-forward"
                (cd "$CFBRAIN_HOME" && git pull >> "$LOG_FILE" 2>&1) || true
            else
                log "WARN: push FAILED — resetting to origin/main (${unpushed_count} local commit(s) will be discarded)"
                (cd "$CFBRAIN_HOME" && git reset --hard origin/main >> "$LOG_FILE" 2>&1)
            fi
        else
            # No unpushed commits — safe to reset directly
            (cd "$CFBRAIN_HOME" && git reset --hard origin/main >> "$LOG_FILE" 2>&1)
            log "git reset --hard origin/main SUCCESS"
        fi
    else
        log "git fetch FAILED — continuing with local state"
    fi

    # Pre-session dirty worktree recovery (fallback if git fetch+reset above didn't fully clean)
    local pre_dirty_files
    pre_dirty_files=$(cd "$CFBRAIN_HOME" && git status --porcelain 2>/dev/null)
    if [ -n "$pre_dirty_files" ]; then
        local pre_dirty_count
        pre_dirty_count=$(echo "$pre_dirty_files" | wc -l | tr -d ' ')
        log "PRE-SESSION: found $pre_dirty_count dirty files (likely from serve mode):"
        echo "$pre_dirty_files" >> "$LOG_FILE"

        if [ "$pre_dirty_count" -le 20 ]; then
            log "PRE-SESSION: auto-committing..."
            (
                cd "$CFBRAIN_HOME" \
                && git add shared/ main/ generator/ evaluator/ planner/ launchd/ .gitignore 2>/dev/null; true \
                && git commit -m "auto-recover: pre-session cleanup (${pre_dirty_count} files from serve)" \
                && git push
            ) >> "$LOG_FILE" 2>&1

            if [ $? -eq 0 ]; then
                log "PRE-SESSION: auto-commit SUCCESS"
            else
                log "PRE-SESSION: auto-commit FAILED — continuing anyway"
            fi
        else
            log "PRE-SESSION: too many dirty files ($pre_dirty_count), skipping"
        fi
    fi

    # monorepo: AGENTS.md is already in place at main/AGENTS.md, no cp needed

    if ! verify_identity; then
        log "CRITICAL: AGENTS.md identity verification failed"
    fi

    local pre_session_head
    pre_session_head=$(cd "$CFBRAIN_HOME" && git rev-parse HEAD 2>/dev/null)

    log "Attempt $attempt: starting opencode run"

    timeout 1800 "$OPENCODE" run --attach "$SERVE_URL" "$PAYLOAD" \
        > "$tmp_stdout" 2> "$tmp_stderr" || exit_code=$?

    local stdout_size stderr_size
    stdout_size=$(wc -c < "$tmp_stdout" | tr -d ' ')
    stderr_size=$(wc -c < "$tmp_stderr" | tr -d ' ')

    log "Attempt $attempt: exit_code=$exit_code stdout=${stdout_size}bytes stderr=${stderr_size}bytes"

    if [ "$stderr_size" -gt 0 ]; then
        log "STDERR:"
        cat "$tmp_stderr" >> "$LOG_FILE"
    fi

    if [ "$stdout_size" -gt 0 ]; then
        log "STDOUT (last 50 lines):"
        tail -50 "$tmp_stdout" >> "$LOG_FILE"
    else
        log "WARNING: no stdout output"
    fi

    cat "$tmp_stdout" > "/tmp/opencode-<AGENT_NAME>-${TASK_NAME}.log"

    rm -f "$tmp_stdout" "$tmp_stderr"

    # Post-session dirty worktree check
    local dirty_files
    dirty_files=$(cd "$CFBRAIN_HOME" && git status --porcelain 2>/dev/null)
    if [ -n "$dirty_files" ]; then
        log "WARNING: dirty worktree after agent session:"
        echo "$dirty_files" >> "$LOG_FILE"

        local dirty_count
        dirty_count=$(echo "$dirty_files" | wc -l | tr -d ' ')

        if [ "$dirty_count" -le 20 ]; then
            log "Auto-committing $dirty_count orphaned files..."
            (
                cd "$CFBRAIN_HOME" \
                && git add shared/ main/ generator/ evaluator/ planner/ launchd/ .gitignore 2>/dev/null; true \
                && git commit --allow-empty -m "auto-recover: ${TASK_NAME} session orphaned changes (${dirty_count} files)" \
                && git push
            ) >> "$LOG_FILE" 2>&1

            if [ $? -eq 0 ]; then
                log "Auto-commit SUCCESS"
            else
                log "Auto-commit FAILED — manual intervention needed"
            fi
        else
            log "ERROR: too many dirty files ($dirty_count), skipping auto-commit"
        fi
    fi

    # Harness change detection + serve restart
    local HARNESS_FILES="main/AGENTS.md shared/context/ shared/control/guardrails.md"
    local harness_changed=false

    local current_head
    current_head=$(cd "$CFBRAIN_HOME" && git rev-parse HEAD 2>/dev/null)
    if [ -n "$pre_session_head" ] && [ "$pre_session_head" != "$current_head" ]; then
        local session_changed_files
        session_changed_files=$(cd "$CFBRAIN_HOME" && git diff --name-only "$pre_session_head" "$current_head" 2>/dev/null)
        for hf in $HARNESS_FILES; do
            if echo "$session_changed_files" | grep -q "^${hf}"; then
                harness_changed=true
                log "Harness file changed in session: $hf"
            fi
        done
    fi

    if [ "$harness_changed" = true ]; then
        log "Harness files changed — restarting opencode serve..."
        local serve_plist="$HOME/Library/LaunchAgents/com.<AGENT_NAME>.main.serve.plist"
        if [ -f "$serve_plist" ]; then
            local serve_label
            serve_label=$(basename "$serve_plist" .plist)
            local uid
            uid=$(id -u)

            launchctl bootout "gui/${uid}/${serve_label}" 2>/dev/null || true
            sleep 2

            local bootstrap_output
            bootstrap_output=$(launchctl bootstrap "gui/${uid}" "$serve_plist" 2>&1)
            if [ $? -ne 0 ]; then
                log "bootstrap failed ($bootstrap_output), trying load fallback..."
                launchctl load "$serve_plist" 2>/dev/null || true  # fallback
            fi
            sleep 5
            local http_code
            http_code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${MAIN_PORT}" 2>/dev/null || echo "000")
            if [ "$http_code" = "200" ]; then
                log "Serve restart SUCCESS (HTTP 200)"
            else
                log "WARNING: Serve restart — HTTP $http_code (may still be starting)"
            fi
        else
            log "WARNING: serve plist not found, cannot restart"
        fi
    fi

    if [ "${exit_code:-0}" -ne 0 ]; then
        log "FAIL: exit code ${exit_code:-unknown}"
        return 1
    fi

    if [ "$stdout_size" -lt 50 ]; then
        log "FAIL: stdout too small (${stdout_size}bytes), likely no execution"
        return 1
    fi

    log "SUCCESS"
    return 0
}

execute_agent_if() {
    local attempt=$1
    local precheck_script="$PAYLOAD"
    local agent_prompt="$AGENT_IF_PROMPT"
    local tmp_precheck_out exit_code

    log "Attempt $attempt: running precheck $precheck_script"

    # Validate precheck script exists and is executable
    if [ ! -x "$precheck_script" ]; then
        log "ERROR: precheck script not found or not executable: $precheck_script"
        return 1
    fi

    # Execute precheck script
    tmp_precheck_out=$(mktemp)
    bash "$precheck_script" > "$tmp_precheck_out" 2>> "$LOG_FILE"
    exit_code=$?

    local precheck_stdout
    precheck_stdout=$(cat "$tmp_precheck_out")
    rm -f "$tmp_precheck_out"

    log "Precheck exit_code=$exit_code stdout='$precheck_stdout'"

    # Handle precheck failure
    if [ $exit_code -ne 0 ]; then
        log "FAIL: precheck script failed with exit code $exit_code"
        return 1
    fi

    # Decision based on precheck output.
    # Generic tokens (no_work/has_work) let any task reuse --agent-if; the legacy
    # feishu-comment tokens stay supported so cron-poll keeps working unchanged.
    if echo "$precheck_stdout" | grep -qE "no_work|no_comments"; then
        log "Precheck: no pending work, skipping agent session"
        # Return special exit code 200 to signal "success but skipped"
        # We use a global variable since bash functions only return 0-255
        AGENT_IF_SKIPPED=true
        return 0
    elif echo "$precheck_stdout" | grep -q "has_comments"; then
        log "Precheck: comments found, launching agent session"
        # Override PAYLOAD with the enhanced agent prompt for execute_agent
        PAYLOAD="评论数据已保存在 /tmp/cfbrain-poll-result.json，请读取后处理。${agent_prompt}"
        execute_agent "$attempt"
        return $?
    elif echo "$precheck_stdout" | grep -q "has_work"; then
        log "Precheck: work found, launching agent session"
        # Generic path: the precheck owns its own data hand-off, so the prompt is
        # passed through verbatim (no feishu-specific pointer is injected).
        PAYLOAD="$agent_prompt"
        execute_agent "$attempt"
        return $?
    else
        log "FAIL: precheck output unrecognized: $precheck_stdout"
        return 1
    fi
}

# --- Feishu notification helper ---
send_feishu() {
    local status="$1"
    local msg="$2"
    local LARK_CLI="/opt/homebrew/bin/lark-cli"
    local LARK_PROFILE="<YOUR_FEISHU_APP_ID>"
    local finish_time
    finish_time=$(date '+%H:%M')
    local identity_label
    identity_label=$(get_identity_label)
    local feishu_msg="${status} [Main/${identity_label}/${TASK_NAME}] ${finish_time} ${msg}"

    if [ -x "$LARK_CLI" ] && [ -n "$LARK_PROFILE" ]; then
        "$LARK_CLI" im +messages-send --as bot --profile "$LARK_PROFILE" \
            --user-id "<YOUR_FEISHU_OWNER_OPEN_ID>" \
            --msg-type text \
            --text "${feishu_msg}" >> "$LOG_FILE" 2>&1 || log "WARN: Feishu notification failed"
        log "Feishu notification sent"
    fi
}

# --- Post-task: refresh current-state.md（生成即提交）---
#
# 为什么必须提交：本脚本下次启动时执行 `git reset --hard origin/main`（见上方
# pre-session sync），未提交的 current-state.md 会被直接丢弃 —— 表现为"文件 mtime 是
# 今天、内容时间戳却是几天前"。而 dirty 兜底 auto-commit 位于 reset 之后，救不了它。
# 提交进 origin/main 同时解决两个问题：持久化 + 跨 4 个 clone 传播。
#
# 本函数是收尾动作，任何失败只记日志，不改变任务退出码。
refresh_current_state() {
    local SCRIPTS_DIR STATE_SCRIPT REPO_DIR STATE_REL
    SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    STATE_SCRIPT="${SCRIPTS_DIR}/generate-current-state.sh"

    if [ ! -x "$STATE_SCRIPT" ]; then
        return 0
    fi

    log "Refreshing current-state.md..."
    "$STATE_SCRIPT" >> "$LOG_FILE" 2>&1 || true

    # 仓库根目录从脚本位置推导，保证在任意 clone 中都正确
    REPO_DIR="$(cd "$SCRIPTS_DIR" && git rev-parse --show-toplevel 2>/dev/null)"
    if [ -z "$REPO_DIR" ]; then
        REPO_DIR="$CFBRAIN_HOME"
    fi
    STATE_REL="shared/context/current-state.md"

    if [ ! -f "${REPO_DIR}/${STATE_REL}" ]; then
        log "refresh_current_state: ${STATE_REL} not found under ${REPO_DIR}, skipping commit"
        return 0
    fi

    # 幂等：无变更时不产生空提交
    local state_dirty
    state_dirty="$(cd "$REPO_DIR" && git status --porcelain -- "$STATE_REL" 2>/dev/null)"
    if [ -z "$state_dirty" ]; then
        log "refresh_current_state: no change, skipping commit"
        return 0
    fi

    if (cd "$REPO_DIR" && git add "$STATE_REL" \
        && git commit -m "auto: refresh current-state.md (${TASK_NAME})") >> "$LOG_FILE" 2>&1; then
        log "refresh_current_state: commit SUCCESS"

        if (cd "$REPO_DIR" && git push) >> "$LOG_FILE" 2>&1; then
            log "refresh_current_state: push SUCCESS"
        else
            log "WARN: refresh_current_state push FAILED — retrying via pull --rebase"
            if (cd "$REPO_DIR" && git pull --rebase && git push) >> "$LOG_FILE" 2>&1; then
                log "refresh_current_state: push SUCCESS after rebase"
            else
                log "WARN: refresh_current_state push FAILED after rebase — commit stays local, will be pushed by next session's pre-sync"
            fi
        fi
    else
        log "WARN: refresh_current_state commit FAILED — continuing (task exit code unaffected)"
    fi

    return 0
}

# --- Post-task: 4-port health check with dedup alerting ---
check_all_ports() {
    if [ ! -f "$PORT_REGISTRY" ]; then
        log "check_all_ports: port-registry.json not found, skipping"
        return 0
    fi

    local AGENT_NAMES=()
    local AGENT_PORTS=()

    # Read agent names and ports from port-registry.json
    if command -v jq >/dev/null 2>&1; then
        while IFS= read -r line; do
            local aname aport
            aname=$(echo "$line" | cut -d'|' -f1)
            aport=$(echo "$line" | cut -d'|' -f2)
            AGENT_NAMES+=("$aname")
            AGENT_PORTS+=("$aport")
        done < <(jq -r 'to_entries[] | "\(.key)|\(.value)"' "$PORT_REGISTRY" 2>/dev/null)
    else
        # Fallback: parse with grep+sed
        while IFS= read -r line; do
            local aname aport
            aname=$(echo "$line" | sed 's/.*"\([^"]*\)".*/\1/')
            aport=$(echo "$line" | sed 's/.*: *\([0-9]*\).*/\1/')
            if [ -n "$aname" ] && [ -n "$aport" ]; then
                AGENT_NAMES+=("$aname")
                AGENT_PORTS+=("$aport")
            fi
        done < <(grep -E '"[a-z]+"' "$PORT_REGISTRY")
    fi

    if [ "${#AGENT_PORTS[@]}" -eq 0 ]; then
        log "check_all_ports: no ports found in port-registry.json, skipping"
        return 0
    fi

    local HEALTH_STATE_FILE="${LOG_DIR}/port-health-last.txt"
    local previous_down=""
    if [ -f "$HEALTH_STATE_FILE" ]; then
        previous_down=$(cat "$HEALTH_STATE_FILE" 2>/dev/null)
    fi

    local current_down=""
    local i
    for i in "${!AGENT_PORTS[@]}"; do
        local port="${AGENT_PORTS[$i]}"
        local name="${AGENT_NAMES[$i]}"
        local http_code
        http_code=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 2 "http://127.0.0.1:${port}" 2>/dev/null || echo "000")
        if [ "$http_code" = "200" ]; then
            log "check_all_ports: ${name}(${port}) OK"
        else
            log "check_all_ports: ${name}(${port}) UNREACHABLE (HTTP ${http_code})"
            current_down="${current_down:+${current_down},}${name}(${port})"
        fi
    done

    # Dedup alerting: only notify when state changes
    if [ "$current_down" != "$previous_down" ]; then
        if [ -n "$current_down" ] && [ -z "$previous_down" ]; then
            # Transition: all OK -> some down
            send_feishu "⚠️" "端口不可达: ${current_down}"
            log "check_all_ports: ALERT sent — down: ${current_down}"
        elif [ -z "$current_down" ] && [ -n "$previous_down" ]; then
            # Transition: some down -> all recovered
            send_feishu "✅" "端口恢复: ${previous_down}"
            log "check_all_ports: RECOVERY sent — recovered: ${previous_down}"
        elif [ -n "$current_down" ] && [ -n "$previous_down" ]; then
            # Transition: different set of ports down
            send_feishu "⚠️" "端口状态变化: 不可达=${current_down} (之前=${previous_down})"
            log "check_all_ports: STATE CHANGE sent — was: ${previous_down}, now: ${current_down}"
        fi

        # Update state file
        echo "$current_down" > "$HEALTH_STATE_FILE"
    else
        if [ -n "$current_down" ]; then
            log "check_all_ports: still down (no change): ${current_down}"
        else
            log "check_all_ports: all ports OK (no change)"
        fi
    fi

    return 0
}

# Main
log "========== Task triggered =========="

if [ "$MODE" = "--script" ]; then
    log "Mode: script ($PAYLOAD)"

    if [ ! -x "$PAYLOAD" ]; then
        log "ERROR: script not found or not executable: $PAYLOAD"
        exit 1
    fi

    execute_fn="execute_script"

elif [ "$MODE" = "--agent" ]; then
    log "Mode: agent"
    log "Prompt: ${PAYLOAD:0:100}..."

    if ! check_serve; then
        log "Aborting: serve not available"
        exit 1
    fi

    execute_fn="execute_agent"

elif [ "$MODE" = "--agent-if" ]; then
    log "Mode: agent-if (conditional)"
    log "Precheck: $PAYLOAD"
    log "Agent prompt: ${AGENT_IF_PROMPT:0:100}..."

    if ! check_serve; then
        log "Aborting: serve not available"
        exit 1
    fi

    AGENT_IF_SKIPPED=false
    execute_fn="execute_agent_if"

else
    echo "Usage: cron-run.sh --script <task-name> <script-path>"
    echo "       cron-run.sh --agent <task-name> <prompt>"
    echo "       cron-run.sh --agent-if <task-name> <precheck-script> <agent-prompt>"
    exit 1
fi

# Execute with retries
attempt=1
while [ $attempt -le $((MAX_RETRIES + 1)) ]; do
    if $execute_fn $attempt; then
        # Handle --agent-if skip case: precheck passed but no work needed
        if [ "${AGENT_IF_SKIPPED:-false}" = true ]; then
            log "Precheck passed: no agent session needed, exiting cleanly"
            # No feishu notification, no report, no git commit — silent success
            exit 0
        fi

        log "Completed on attempt $attempt"
        send_feishu "✅" "completed (attempt $attempt)"
        # Post-task: refresh system state index
        refresh_current_state
        # Post-task: 4-port health check
        check_all_ports
        exit 0
    fi

    if [ $attempt -le $MAX_RETRIES ]; then
        wait_time=$((attempt * 10))
        log "Retrying in ${wait_time}s..."
        sleep $wait_time
    fi

    attempt=$((attempt + 1))
done

log "FAILED after $MAX_RETRIES retries"
send_feishu "❌" "failed (${MAX_RETRIES} retries exhausted)"
# Post-task: refresh system state index even on failure
refresh_current_state
# Post-task: 4-port health check even on failure
check_all_ports
exit 1
