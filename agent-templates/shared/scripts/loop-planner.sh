#!/bin/bash
#
# loop-agent.sh — Single parameterized loop template for P/G/E agents (monorepo layout)
#
# Template variables:
#   <AGENT_NAME>   — e.g. news-briefing
#   planner         — generator, evaluator, or planner
#   $CFBRAIN_HOME    — Monorepo root, e.g. $HOME/.news-briefing
#   $CFBRAIN_HOME-planner — Role clone root, e.g. $HOME/.news-briefing-generator
#   3499    — Role port, e.g. 3469
#   <YOUR_FEISHU_APP_ID> — e.g. news-briefing (lark-cli profile name)
#   <YOUR_FEISHU_OWNER_OPEN_ID> — Feishu user open_id for notifications (ou_xxx)
#
# Monorepo: AGENTS.md lives at planner/AGENTS.md (in place, no cp needed).
# Git operations use REPO_ROOT (the clone root), agent runs in WORK_DIR (role subdir).

set -euo pipefail

LOCK_DIR="/tmp/<AGENT>-planner.lock"
OPENCODE="/opt/homebrew/bin/opencode"
# Model for the P/G/E session. Single source of truth — override via PGE_MODEL env.
PGE_MODEL="${PGE_MODEL:-anthropic/cd-opus-5}"
REPO_ROOT="$CFBRAIN_HOME-planner"
WORK_DIR="$CFBRAIN_HOME-planner/planner"
AGENT_ROLE="planner"
LOG_DIR="${WORK_DIR}/logs"
TIMEOUT=1800

LOG_FILE="${LOG_DIR}/planner-$(date +%Y%m%d).log"
mkdir -p "$LOG_DIR"

# --- Log rotation: remove logs older than 30 days ---
find "$LOG_DIR" -name "planner-*.log" -type f -mtime +30 -delete 2>/dev/null || true

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [planner] $*" >> "$LOG_FILE"
}

# mkdir-based atomic lock (works on macOS)
cleanup() {
    rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    if [ -d "$LOCK_DIR" ]; then
        lock_age=$(( $(date +%s) - $(stat -f %m "$LOCK_DIR") ))
        if [ "$lock_age" -gt 600 ]; then
            log "WARN: stale lock (${lock_age}s old), removing"
            rmdir "$LOCK_DIR" 2>/dev/null || true
            mkdir "$LOCK_DIR" 2>/dev/null || { log "SKIP: still locked"; exit 0; }
        else
            log "SKIP: another planner instance is running (${lock_age}s)"
            exit 0
        fi
    fi
fi

log "START"

cd "$WORK_DIR"

tmp_stdout=$(mktemp)
tmp_stderr=$(mktemp)
exit_code=0

# --- Pre-session: git fetch + reset to ensure workspace matches remote ---
# P/G/E workspaces should mirror origin/main exactly at session start.
# Using git fetch + reset --hard instead of git pull avoids merge conflicts
# that arise when multiple workspaces push concurrently to the same branch.
log "Syncing workspace with remote..."
if (cd "$REPO_ROOT" && git fetch origin >> "$LOG_FILE" 2>&1); then
    log "git fetch SUCCESS"

    # Check for unpushed local commits before resetting
    unpushed=$(cd "$REPO_ROOT" && git log origin/main..HEAD --oneline 2>/dev/null || true)
    if [ -n "$unpushed" ]; then
        unpushed_count=$(echo "$unpushed" | wc -l | tr -d ' ')
        log "WARN: found ${unpushed_count} unpushed local commit(s) — attempting push before reset"
        echo "$unpushed" >> "$LOG_FILE"

        if (cd "$REPO_ROOT" && git push >> "$LOG_FILE" 2>&1); then
            log "Push of local commits SUCCESS — no reset needed, pulling to fast-forward"
            (cd "$REPO_ROOT" && git pull >> "$LOG_FILE" 2>&1) || true
        else
            log "WARN: push FAILED — resetting to origin/main (${unpushed_count} local commit(s) will be discarded)"
            (cd "$REPO_ROOT" && git reset --hard origin/main >> "$LOG_FILE" 2>&1)
        fi
    else
        # No unpushed commits — safe to reset directly
        (cd "$REPO_ROOT" && git reset --hard origin/main >> "$LOG_FILE" 2>&1)
        log "git reset --hard origin/main SUCCESS"
    fi
else
    log "git fetch FAILED — continuing with local state"
fi
# monorepo: AGENTS.md is at planner/AGENTS.md in place, no cp needed

# --- Pre-session dirty worktree recovery ---
pre_dirty=$(cd "$REPO_ROOT" && git status --porcelain 2>/dev/null)
if [ -n "$pre_dirty" ]; then
    pre_dirty_count=$(echo "$pre_dirty" | wc -l | tr -d ' ')
    log "PRE-SESSION: found $pre_dirty_count dirty files"
    echo "$pre_dirty" >> "$LOG_FILE"
    if [ "$pre_dirty_count" -le 20 ]; then
        log "PRE-SESSION: auto-committing..."
        # Targeted git add: monorepo layout directories (never git add -A)
        if cd "$REPO_ROOT" \
            && git add shared/ main/ generator/ evaluator/ planner/ launchd/ .gitignore 2>/dev/null; true \
            && git commit -m "auto-recover: pre-session cleanup (${pre_dirty_count} files from serve)" \
            && git push; then
            log "PRE-SESSION: auto-commit SUCCESS"
        else
            log "PRE-SESSION: auto-commit FAILED — continuing anyway"
        fi
    fi
fi

# --- Post-pull template sync (if sync script exists) ---
# Automatically propagate template updates to instance scripts after git pull.
# Only runs if sync_template_instances.sh exists (Agent Builder and agents with custom sync).
# The script is idempotent and validates output with bash -n before overwriting.
SYNC_SCRIPT="$REPO_ROOT/shared/scripts/sync_template_instances.sh"
if [ -x "$SYNC_SCRIPT" ]; then
    log "Running template-to-instance sync..."
    if bash "$SYNC_SCRIPT" >> "$LOG_FILE" 2>&1; then
        log "Template sync SUCCESS"
        # Check if sync created changes that need committing
        sync_dirty=$(cd "$REPO_ROOT" && git status --porcelain 2>/dev/null)
        if [ -n "$sync_dirty" ]; then
            sync_count=$(echo "$sync_dirty" | wc -l | tr -d ' ')
            log "Template sync updated $sync_count file(s), committing..."
            if cd "$REPO_ROOT" \
                && git add shared/ main/ generator/ evaluator/ planner/ launchd/ .gitignore 2>/dev/null; true \
                && git commit -m "auto-sync: template-to-instance propagation (${sync_count} files)" \
                && git push; then
                log "Template sync commit SUCCESS"
            else
                log "WARN: Template sync commit FAILED — continuing anyway"
            fi
        fi
    else
        log "WARN: Template sync FAILED — continuing with existing scripts"
    fi
fi

cd "$WORK_DIR"
pre_session_head=$(cd "$REPO_ROOT" && git rev-parse HEAD 2>/dev/null || echo "")

timeout "$TIMEOUT" "$OPENCODE" run \
    --model "$PGE_MODEL" \
    --dangerously-skip-permissions \
    "Execute your standard planner cycle." \
    > "$tmp_stdout" 2> "$tmp_stderr" || exit_code=$?

# --- Failure detection (exit code 0 doesn't mean success) ---
# opencode streams every tool call and its output to stderr, so benign strings
# like "Error:" / "FATAL" appear constantly in a perfectly successful cycle
# (agent-written test scripts, one-off typos it recovered from, git usage
# errors). Matching them produced false FAILED on successful cycles.
# Two precise signals instead:
#   1. empty stdout  -> the session produced no final answer at all
#   2. fatal provider/auth error in the TAIL of stderr -> session died at the end
if [ "$exit_code" -eq 0 ]; then
    stdout_bytes=$(wc -c < "$tmp_stdout" 2>/dev/null | tr -d ' ')
    stdout_bytes=${stdout_bytes:-0}
    if [ "$stdout_bytes" -lt 32 ]; then
        exit_code=1
        log "OVERRIDE: exit_code set to 1 — session produced no final output (stdout ${stdout_bytes} bytes)"
    elif [ -f "$tmp_stderr" ] && tail -30 "$tmp_stderr" | grep -qiE 'ProviderModelNotFoundError|AuthenticationError|is not available|Bad Request|insufficient credit|rate limit exceeded|context length exceeded' 2>/dev/null; then
        exit_code=1
        log "OVERRIDE: exit_code set to 1 — fatal provider/auth error at end of stderr"
    fi
fi

# --- Post-session dirty worktree check ---
dirty_files=$(cd "$REPO_ROOT" && git status --porcelain 2>/dev/null || true)
if [ -n "$dirty_files" ]; then
    log "WARNING: dirty worktree after agent session:"
    echo "$dirty_files" >> "$LOG_FILE"

    dirty_count=$(echo "$dirty_files" | wc -l | tr -d ' ')

    if [ "$dirty_count" -le 20 ]; then
        log "Auto-committing $dirty_count orphaned files..."
        # Targeted git add: monorepo layout directories (never git add -A)
        if cd "$REPO_ROOT" \
            && git add shared/ main/ generator/ evaluator/ planner/ launchd/ .gitignore 2>/dev/null; true \
            && git commit -m "auto-recover: planner session orphaned changes (${dirty_count} files)" \
            && git push; then
            log "Auto-commit SUCCESS"
        else
            log "Auto-commit FAILED — manual intervention needed"
        fi
    else
        log "ERROR: too many dirty files ($dirty_count), skipping auto-commit"
    fi
fi

stdout_size=$(wc -c < "$tmp_stdout" | tr -d ' ')
stderr_size=$(wc -c < "$tmp_stderr" | tr -d ' ')

log "exit_code=$exit_code stdout=${stdout_size}bytes stderr=${stderr_size}bytes"

if [ "$stderr_size" -gt 0 ]; then
    log "STDERR:"
    cat "$tmp_stderr" >> "$LOG_FILE"
fi

if [ "$exit_code" -eq 0 ]; then
    log "SUCCESS"
else
    log "FAILED (exit $exit_code)"
fi

# --- Feishu notification ---
LARK_CLI="/opt/homebrew/bin/lark-cli"
LARK_PROFILE="<YOUR_FEISHU_APP_ID>"
REPORTS_DIR="$CFBRAIN_HOME/shared/outbox/reports"
mkdir -p "$REPORTS_DIR"

agent_label="planner"
agent_label_cap=$(echo "$agent_label" | awk '{print toupper(substr($0,1,1)) substr($0,2)}')
finish_time=$(date '+%H:%M')

# Status icon based on exit_code (process-level success/failure)
if [ "$exit_code" -eq 0 ]; then
    status_icon="✅"
else
    status_icon="❌"
fi

latest_summary=$(ls -t "$REPORTS_DIR"/planner-*.md 2>/dev/null | head -1)

feishu_msg=""
if [ -n "$latest_summary" ] && [ -f "$latest_summary" ]; then
    summary_filename=$(basename "$latest_summary")
    github_link="https://github.com/<YOUR_GITHUB_USER>/<YOUR_REPO>/blob/main/shared/outbox/reports/${summary_filename}"
    # Extract one-line summary: prefer "## Verdict" or "## 本轮工作" content
    one_line=""
    if grep -q '^## Verdict' "$latest_summary" 2>/dev/null; then
        one_line=$(sed -n '/^## Verdict/,/^## /{/^## /d;/^$/d;p;}' "$latest_summary" | head -1 | sed 's/^- //' | head -c 100)
    fi
    if [ -z "$one_line" ] && grep -q '^## 本轮工作' "$latest_summary" 2>/dev/null; then
        one_line=$(sed -n '/^## 本轮工作/,/^## /{/^## /d;/^$/d;p;}' "$latest_summary" | head -1 | sed 's/^- //' | head -c 100)
    fi
    if [ -z "$one_line" ] && grep -q '^## Result' "$latest_summary" 2>/dev/null; then
        one_line=$(sed -n '/^## Result/,/^## /{/^## /d;/^$/d;p;}' "$latest_summary" | head -1 | sed 's/^- //' | head -c 100)
    fi
    if [ -z "$one_line" ]; then
        one_line=$(grep -m1 '^- ' "$latest_summary" | sed 's/^- //' | head -c 100)
    fi
    [ -z "$one_line" ] && one_line="(详见报告)"
    feishu_msg="${status_icon} [${agent_label_cap}] ${finish_time}\n${one_line}\n📄 ${github_link}"
    log "Using agent-written work summary from $latest_summary"
else
    log "No agent work summary found, using fallback"
    if [ "$exit_code" -eq 0 ]; then
        feishu_msg="${status_icon} [${agent_label_cap}] ${finish_time} completed"
    else
        feishu_msg="${status_icon} [${agent_label_cap}] ${finish_time} failed (exit ${exit_code})"
    fi
fi

feishu_msg=$(printf "%b" "$feishu_msg")

if [ -x "$LARK_CLI" ] && [ -n "$LARK_PROFILE" ]; then
    "$LARK_CLI" im +messages-send --as bot --profile "$LARK_PROFILE" \
        --user-id "<YOUR_FEISHU_OWNER_OPEN_ID>" \
        --msg-type text \
        --text "${feishu_msg}" >> "$LOG_FILE" 2>&1 || log "WARN: Feishu notification failed"
    log "Feishu notification sent"
else
    log "WARN: lark-cli not found or no profile configured, skipping notification"
fi

rm -f "$tmp_stdout" "$tmp_stderr"
log "END"
