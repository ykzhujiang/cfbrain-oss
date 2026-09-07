#!/bin/bash
#
# generate-current-state.sh — 生成 current-state.md 系统状态索引
#
# 幂等脚本，汇总 PRD 状态、系统健康、知识库统计、Pipeline Health 等信息
# 写入 ../shared/context/current-state.md（覆盖旧内容）
#
# 设计原则：
#   1. graceful degradation —— 子命令失败不中断脚本
#   2. 新鲜度断言而非存在性断言 —— 端口开着 != Agent 在干活（prd-2026-08-28-001）

set -uo pipefail
# 注意：不使用 set -e，因为我们需要容忍子命令失败

# --- 确保多字节字符（中文等）正确处理 ---
# launchd/cron 环境通常 LC_ALL=C，cut/awk 按字节截断会产生乱码
export LC_ALL=en_US.UTF-8

# ============================================================
# 新鲜度阈值 —— 集中定义，禁止散落硬编码（可用环境变量覆盖）
# ============================================================
# 任一 Agent loop 日志超过该天数未更新 → 判定停摆
LOOP_STALE_DAYS="${LOOP_STALE_DAYS:-3}"
# 任一 clone 的 current-state.md 落后最新 clone 超过该天数 → 判定传播失败
CLONE_STATE_STALE_DAYS="${CLONE_STATE_STALE_DAYS:-2}"
# 「待实现」PRD 数量超过该值 → 判定改进闭环积压
PENDING_PRD_MAX="${PENDING_PRD_MAX:-2}"
# 最后一份评估报告超过该天数 → 判定评估环节停摆
EVAL_REPORT_STALE_DAYS="${EVAL_REPORT_STALE_DAYS:-7}"

# --- 路径配置 ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHARED_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$SHARED_DIR/.." && pwd)"
OUTBOX_DIR="$SHARED_DIR/outbox"
CONTEXT_DIR="$SHARED_DIR/context"
OUTPUT_FILE="$CONTEXT_DIR/current-state.md"
CFBRAIN_EXEC="$SHARED_DIR/scripts/cfbrain-exec.sh"

PRD_DIR="$OUTBOX_DIR/planner-to-generator"
RESULT_DIR="$OUTBOX_DIR/generator-to-evaluator"
EVAL_DIR="$OUTBOX_DIR/evaluator-to-planner"

# --- 项目 slug 推导（不硬编码项目名与 clone 路径）---
# 本脚本可能运行在 main clone（.<AGENT_NAME>）或角色 clone（.<AGENT>-generator 等）
REPO_BASE="$(basename "$REPO_ROOT")"
PROJECT_SLUG="${REPO_BASE#.}"
for _role in generator evaluator planner main; do
  PROJECT_SLUG="${PROJECT_SLUG%-${_role}}"
done
# 允许显式覆盖（供沙盒自测使用，生产环境不设置该变量）
PROJECT_SLUG="${CFBRAIN_PROJECT_SLUG:-$PROJECT_SLUG}"
# Main 的 cron 任务日志目录（对照 cron-run.sh 的 LOG_DIR）
CRON_LOG_DIR="/tmp/opencode-${PROJECT_SLUG}-logs"

NOW_EPOCH=$(date +%s)

# --- 日期工具（兼容 BSD date 与 GNU date）---
# 输入 YYYY-MM-DD 或 YYYYMMDD，输出 epoch 秒；无法解析时输出空
epoch_from_ymd() {
  local raw="${1//-/}"
  [[ ${#raw} -eq 8 ]] || { echo ""; return; }
  local iso="${raw:0:4}-${raw:4:2}-${raw:6:2}"
  date -j -f "%Y-%m-%d" "$iso" +%s 2>/dev/null \
    || date -d "$iso" +%s 2>/dev/null \
    || echo ""
}

# 输入 2026-08-22T19:09:10Z，输出 epoch 秒；无法解析时输出空
epoch_from_iso_utc() {
  local ts="$1"
  date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$ts" +%s 2>/dev/null \
    || date -u -d "$ts" +%s 2>/dev/null \
    || echo ""
}

# 输入 epoch 秒，输出距今天数（向下取整）；输入为空时输出空
days_since_epoch() {
  local e="$1"
  [[ -n "$e" ]] || { echo ""; return; }
  echo $(( (NOW_EPOCH - e) / 86400 ))
}

# 从形如 prefix-YYYY-MM-DD-NNN.md 的文件名提取 YYYY-MM-DD
date_from_filename() {
  echo "$1" | sed -n 's/.*-\([0-9]\{4\}\)-\([0-9]\{2\}\)-\([0-9]\{2\}\)-.*/\1-\2-\3/p'
}

# --- Agent loop 最近一次运行日期（YYYYMMDD），无日志时输出空 ---
# P/G/E 的 cycle 日志写在各自的角色 clone 内，且被 .gitignore 忽略，
# 因此必须跨 clone 探测：优先角色 clone，回退本 clone。
latest_loop_date() {
  local role="$1"
  local newest=""
  local candidate_dirs=(
    "$HOME/.${PROJECT_SLUG}-${role}/${role}/logs"
    "$REPO_ROOT/${role}/logs"
  )
  local d f base stamp

  # Main 没有 main-YYYYMMDD.log，它的活动体现在 cron 任务日志上
  if [[ "$role" == "main" ]]; then
    candidate_dirs=("$CRON_LOG_DIR" "$HOME/.${PROJECT_SLUG}/main/logs" "$REPO_ROOT/main/logs")
  fi

  for d in "${candidate_dirs[@]}"; do
    [[ -d "$d" ]] || continue
    for f in "$d"/*-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9].log; do
      [[ -f "$f" ]] || continue
      base="$(basename "$f" .log)"
      stamp="${base##*-}"
      # 非 main 角色只认 <role>-YYYYMMDD.log，避免 launchd 日志混入
      if [[ "$role" != "main" && "$base" != "${role}-${stamp}" ]]; then
        continue
      fi
      if [[ -z "$newest" || "$stamp" > "$newest" ]]; then
        newest="$stamp"
      fi
    done
  done

  echo "$newest"
}

# --- 各 clone 的 current-state.md 时间戳（用于检测跨 clone 传播失败）---
# 必须在输出重定向之前读取：`> "$OUTPUT_FILE"` 会立即截断文件。
clone_state_epoch() {
  local clone_dir="$1"
  local f="$clone_dir/shared/context/current-state.md"
  [[ -f "$f" ]] || { echo ""; return; }
  local ts
  ts=$(grep -m1 '^最后更新: ' "$f" 2>/dev/null | sed 's/^最后更新: //' | tr -d ' \r')
  [[ -n "$ts" ]] || { echo ""; return; }
  epoch_from_iso_utc "$ts"
}

# ============================================================
# 预读：必须在输出重定向截断 OUTPUT_FILE 之前完成
# ============================================================

# 1) 沿用旧文件中的手写 Known Limitations
#    注意：原实现在重定向块内部读 OUTPUT_FILE，文件已被截断，导致手写内容 100% 丢失，
#    并因此永远输出「- (无已知问题)」。此处提前读取修正该缺陷。
MANUAL_LIMITATIONS=""
if [[ -f "$OUTPUT_FILE" ]]; then
  MANUAL_LIMITATIONS=$(
    awk '
      /^## Known Limitations/ { inside=1; next }
      inside && /^## /        { inside=0 }
      inside && /^---[[:space:]]*$/ { inside=0 }
      inside                  { print }
    ' "$OUTPUT_FILE" 2>/dev/null \
    | grep -v '^[[:space:]]*$' \
    | grep -v '(无已知问题)' \
    | grep -v '^最后更新: ' \
    | grep -v '^- \[自动检测\]' \
    || true
  )
fi

# 2) 各 clone 的 current-state 新鲜度
declare -a CLONE_NAMES=()
declare -a CLONE_EPOCHS=()
NEWEST_CLONE_EPOCH=""
for _clone in "$HOME/.${PROJECT_SLUG}" \
              "$HOME/.${PROJECT_SLUG}-main" \
              "$HOME/.${PROJECT_SLUG}-generator" \
              "$HOME/.${PROJECT_SLUG}-evaluator" \
              "$HOME/.${PROJECT_SLUG}-planner"; do
  [[ -d "$_clone" ]] || continue
  _epoch=$(clone_state_epoch "$_clone")
  [[ -n "$_epoch" ]] || continue
  CLONE_NAMES+=("$(basename "$_clone")")
  CLONE_EPOCHS+=("$_epoch")
  if [[ -z "$NEWEST_CLONE_EPOCH" || "$_epoch" -gt "$NEWEST_CLONE_EPOCH" ]]; then
    NEWEST_CLONE_EPOCH="$_epoch"
  fi
done

# --- 检测结果累加器（供 Known Limitations 使用）---
declare -a DETECTED_ISSUES=()

# --- 开始生成 ---
{
  echo "# CFBrain OC — System Current State"
  echo ""
  echo "> 自动生成，请勿手动编辑（Known Limitations 章节的手写条目除外）"
  echo ""

  # === PRD 状态表 ===
  echo "## PRD 状态"
  echo ""
  echo "| prd_id | priority | area | 标题 | 状态 |"
  echo "|--------|----------|------|------|------|"

  PENDING_PRD_COUNT=0
  LATEST_PRD_FILE=""
  LATEST_PRD_DATE=""

  if [[ -d "$PRD_DIR" ]]; then
    for prd_file in "$PRD_DIR"/prd-*.md; do
      [[ -f "$prd_file" ]] || continue

      local_prd_id=$(basename "$prd_file" .md)

      # Extract metadata from YAML front matter
      local_priority=$(grep -m1 '^priority:' "$prd_file" 2>/dev/null | sed 's/priority:[[:space:]]*//' || echo "?")
      local_area=$(grep -m1 '^area:' "$prd_file" 2>/dev/null | sed 's/area:[[:space:]]*//' || echo "?")
      # Title: first markdown heading after front matter (truncate to 40 chars)
      # LC_ALL=en_US.UTF-8 ensures cut -c counts characters, not bytes
      local_title=$(grep -m1 '^# ' "$prd_file" 2>/dev/null | sed 's/^# PRD: //' | sed 's/^# //' | cut -c1-40 || echo "?")

      # Determine status by cross-referencing result and eval files
      local_status="待实现"

      # Check if any result file references this prd_id
      local_has_result=false
      if [[ -d "$RESULT_DIR" ]]; then
        for result_file in "$RESULT_DIR"/result-*.md; do
          [[ -f "$result_file" ]] || continue
          if grep -q "prd_id:.*${local_prd_id}" "$result_file" 2>/dev/null; then
            local_has_result=true
            break
          fi
        done
      fi

      # Check if any eval file marks this PRD as PASS
      local_is_pass=false
      if [[ -d "$EVAL_DIR" ]]; then
        for eval_file in "$EVAL_DIR"/eval-*.md; do
          [[ -f "$eval_file" ]] || continue
          if grep -q "prd_id:.*${local_prd_id}" "$eval_file" 2>/dev/null; then
            if grep -qi "Result:.*PASS" "$eval_file" 2>/dev/null; then
              local_is_pass=true
              break
            fi
          fi
        done
      fi

      if [[ "$local_is_pass" == "true" ]]; then
        local_status="PASS（已合并到生产）"
      elif [[ "$local_has_result" == "true" ]]; then
        local_status="已实现，待评审"
      else
        PENDING_PRD_COUNT=$((PENDING_PRD_COUNT + 1))
      fi

      # 追踪最新一份 PRD（文件名 prd-YYYY-MM-DD-NNN 的字典序即时间序，
      # 用完整文件名比较可正确区分同一天的 001 / 002）
      local_prd_date=$(date_from_filename "$local_prd_id")
      if [[ -n "$local_prd_date" ]]; then
        if [[ -z "$LATEST_PRD_FILE" || "$local_prd_id" > "${LATEST_PRD_FILE%.md}" ]]; then
          LATEST_PRD_DATE="$local_prd_date"
          LATEST_PRD_FILE="${local_prd_id}.md"
        fi
      fi

      echo "| ${local_prd_id} | ${local_priority} | ${local_area} | ${local_title} | ${local_status} |"
    done
  else
    echo "| - | - | - | PRD 目录不存在 | - |"
  fi

  echo ""

  # === 系统健康摘要 ===
  echo "## 系统健康"
  echo ""

  if [[ -x "$CFBRAIN_EXEC" ]]; then
    doctor_output=$("$CFBRAIN_EXEC" doctor --json 2>/dev/null || echo '{"error":"command failed"}')
    if echo "$doctor_output" | grep -qi '"status".*"fail"' 2>/dev/null; then
      echo "- PGLite 健康: **有检查项未通过**"
    elif echo "$doctor_output" | grep -qi '"status".*"warn"' 2>/dev/null; then
      echo "- PGLite 健康: 有警告"
    elif echo "$doctor_output" | grep -qi '"error"' 2>/dev/null; then
      echo "- PGLite 健康: 检查执行异常"
    else
      echo "- PGLite 健康: 全部通过"
    fi
  else
    echo "- PGLite 健康: 未检测（cfbrain-exec.sh 不可用）"
  fi

  echo ""

  # === 知识库统计 ===
  echo "## 知识库统计"
  echo ""

  if [[ -x "$CFBRAIN_EXEC" ]]; then
    list_output=$("$CFBRAIN_EXEC" list 2>/dev/null || echo "")
    if [[ -n "$list_output" ]]; then
      # Count non-empty lines (each line = one page entry)
      page_count=$(echo "$list_output" | grep -c '.' 2>/dev/null || echo "0")
      echo "- 总词条数: ${page_count}"
    else
      echo "- 总词条数: 未检测"
    fi
  else
    echo "- 总词条数: 未检测（cfbrain-exec.sh 不可用）"
  fi

  echo ""

  # === Registered Agents ===
  # 表头 Serve 而非 Status：它只代表端口可达（opencode server 活着），
  # 不代表该 Agent 的 cycle 在运行。是否在干活看 Loop Last Run / Age。
  echo "## Registered Agents"
  echo ""

  # port-registry.json 与本脚本同目录（$SCRIPT_DIR/port-registry.json）
  local_port_registry="$SCRIPT_DIR/port-registry.json"
  if [[ -f "$local_port_registry" ]]; then
    echo "| Agent | Port | Serve | Loop Last Run | Age |"
    echo "|-------|------|-------|---------------|-----|"

    emit_agent_row() {
      local agent_name="$1"
      local agent_port="$2"
      local http_code serve_col loop_stamp loop_display loop_age age_col

      http_code=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 2 "http://127.0.0.1:${agent_port}" 2>/dev/null || echo "000")
      if [[ "$http_code" == "200" ]]; then
        serve_col="Running"
      else
        serve_col="-"
      fi

      loop_stamp=$(latest_loop_date "$agent_name")
      if [[ -n "$loop_stamp" ]]; then
        loop_display="${loop_stamp:0:4}-${loop_stamp:4:2}-${loop_stamp:6:2}"
        loop_age=$(days_since_epoch "$(epoch_from_ymd "$loop_display")")
        if [[ -n "$loop_age" ]]; then
          age_col="${loop_age}d"
          if [[ "$loop_age" -gt "$LOOP_STALE_DAYS" ]]; then
            age_col="**${loop_age}d（停摆）**"
            DETECTED_ISSUES+=("${agent_name} loop 已停摆 ${loop_age} 天（阈值 ${LOOP_STALE_DAYS} 天），最后一次运行 ${loop_display}")
          fi
        else
          age_col="?"
        fi
      else
        loop_display="无日志"
        age_col="**未知（停摆）**"
        DETECTED_ISSUES+=("${agent_name} loop 无任何 cycle 日志，无法确认是否在运行")
      fi

      echo "| ${agent_name} | ${agent_port} | ${serve_col} | ${loop_display} | ${age_col} |"
    }

    # 优先使用 jq 解析（精确），回退到 grep+sed（容错）
    if command -v jq >/dev/null 2>&1; then
      while IFS=' ' read -r agent_name agent_port; do
        if [[ -n "$agent_name" ]] && [[ -n "$agent_port" ]]; then
          emit_agent_row "$agent_name" "$agent_port"
        fi
      done < <(jq -r 'to_entries[] | "\(.key) \(.value)"' "$local_port_registry" 2>/dev/null || true)
    else
      # Fallback: grep+sed 方式解析扁平 JSON（仅匹配 "key": number 模式）
      while IFS= read -r line; do
        agent_name=$(echo "$line" | sed -n 's/.*"\([^"]*\)"[[:space:]]*:.*/\1/p')
        agent_port=$(echo "$line" | sed -n 's/.*:[[:space:]]*\([0-9]\{4,5\}\).*/\1/p')
        if [[ -n "$agent_name" ]] && [[ -n "$agent_port" ]]; then
          emit_agent_row "$agent_name" "$agent_port"
        fi
      done < <(grep -E '"[^"]+"\s*:\s*[0-9]' "$local_port_registry" 2>/dev/null || true)
    fi
  else
    echo "- port-registry.json 不存在"
  fi

  echo ""

  # === Pipeline Health ===
  # 派生指标，可直接判读 Planner → Generator → Evaluator 闭环是否停摆
  echo "## Pipeline Health"
  echo ""

  # 最后一份评估报告
  latest_eval_file=""
  latest_eval_date=""
  if [[ -d "$EVAL_DIR" ]]; then
    for eval_file in "$EVAL_DIR"/eval-*.md; do
      [[ -f "$eval_file" ]] || continue
      eval_base=$(basename "$eval_file")
      eval_date=$(date_from_filename "$eval_base")
      [[ -n "$eval_date" ]] || continue
      # 完整文件名字典序即时间序，可正确区分同一天的 001 / 005
      if [[ -z "$latest_eval_file" || "$eval_base" > "$latest_eval_file" ]]; then
        latest_eval_date="$eval_date"
        latest_eval_file="$eval_base"
      fi
    done
  fi

  if [[ -n "$latest_eval_file" ]]; then
    eval_age=$(days_since_epoch "$(epoch_from_ymd "$latest_eval_date")")
    eval_age="${eval_age:-0}"
    echo "- 最后一份评估报告: ${latest_eval_file}（${eval_age} 天前）"
    if [[ "$eval_age" -gt "$EVAL_REPORT_STALE_DAYS" ]]; then
      DETECTED_ISSUES+=("最后一份评估报告 ${latest_eval_file} 已 ${eval_age} 天未更新（阈值 ${EVAL_REPORT_STALE_DAYS} 天），评估环节疑似停摆")
    fi
  else
    echo "- 最后一份评估报告: 无"
    DETECTED_ISSUES+=("evaluator-to-planner 目录下没有任何评估报告")
  fi

  # 最后一份 PRD
  if [[ -n "$LATEST_PRD_FILE" ]]; then
    prd_age=$(days_since_epoch "$(epoch_from_ymd "$LATEST_PRD_DATE")")
    prd_age="${prd_age:-0}"
    echo "- 最后一份 PRD: ${LATEST_PRD_FILE}（${prd_age} 天前）"
  else
    echo "- 最后一份 PRD: 无"
  fi

  # 待实现 PRD 计数
  echo "- 「待实现」PRD 计数: ${PENDING_PRD_COUNT}"
  if [[ "$PENDING_PRD_COUNT" -gt "$PENDING_PRD_MAX" ]]; then
    DETECTED_ISSUES+=("待实现 PRD 数 ${PENDING_PRD_COUNT}（阈值 ${PENDING_PRD_MAX}），改进闭环存在积压")
  fi

  # 跨 clone current-state 传播情况
  if [[ -n "$NEWEST_CLONE_EPOCH" ]]; then
    for i in "${!CLONE_NAMES[@]}"; do
      clone_lag_days=$(( (NEWEST_CLONE_EPOCH - CLONE_EPOCHS[i]) / 86400 ))
      if [[ "$clone_lag_days" -gt "$CLONE_STATE_STALE_DAYS" ]]; then
        DETECTED_ISSUES+=("clone ${CLONE_NAMES[i]} 的 current-state.md 落后最新版本 ${clone_lag_days} 天（阈值 ${CLONE_STATE_STALE_DAYS} 天）")
      fi
    done
    echo "- current-state.md 跨 clone 一致性: 已比对 ${#CLONE_NAMES[@]} 个 clone"
  else
    echo "- current-state.md 跨 clone 一致性: 未检测（未找到可解析的时间戳）"
  fi

  echo ""

  # === Known Limitations（检测 + 沿用 双来源）===
  echo "## Known Limitations"
  echo ""

  limitations_emitted=false

  if [[ -n "$MANUAL_LIMITATIONS" ]]; then
    echo "$MANUAL_LIMITATIONS"
    limitations_emitted=true
  fi

  if [[ "${#DETECTED_ISSUES[@]}" -gt 0 ]]; then
    for issue in "${DETECTED_ISSUES[@]}"; do
      echo "- [自动检测] ${issue}"
    done
    limitations_emitted=true
  fi

  if [[ "$limitations_emitted" == "false" ]]; then
    echo "- (无已知问题)"
  fi

  echo ""

  # === 最后更新 ===
  echo "---"
  echo ""
  echo "最后更新: $(date -u +'%Y-%m-%dT%H:%M:%SZ')"

} > "$OUTPUT_FILE"

echo "generate-current-state.sh: 成功生成 $OUTPUT_FILE"
