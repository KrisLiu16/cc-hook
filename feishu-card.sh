#!/bin/bash
# feishu-card.sh - Feishu Card Status Hook for Claude Code
#
# Shows real-time work progress as a Feishu interactive card.
# One card per task, updated in-place as Claude works.
#
# Hook events:
#   pre  - PreToolUse:  show current tool action
#   post - PostToolUse: (reserved, currently no-op)
#   stop - Stop:        finalize card as completed

set -uo pipefail

PHASE="${1:-pre}"
STATE="/tmp/claude-feishu-card.json"
TOKEN_CACHE="/tmp/claude-feishu-token.json"
LOCK="/tmp/claude-feishu-card.lock"
API="https://open.feishu.cn"

# --- Quick exit checks ---
[ -f "$STATE" ] || exit 0
STATE_DATA=$(cat "$STATE" 2>/dev/null)
ENABLED=$(echo "$STATE_DATA" | jq -r '.enabled // false' 2>/dev/null)
[ "$ENABLED" = "true" ] || exit 0
CHAT_ID=$(echo "$STATE_DATA" | jq -r '.chat_id // empty' 2>/dev/null)
[ -n "$CHAT_ID" ] || exit 0

# Read event from stdin
INPUT=$(cat)

# Parse tool info
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // {}' 2>/dev/null)

# Filter noisy/recursive tools
case "$TOOL_NAME" in
  TodoWrite|EnterPlanMode|ExitPlanMode|AskUserQuestion|CronCreate|CronDelete|CronList|"")
    [ "$PHASE" = "stop" ] || exit 0 ;;
esac
case "$TOOL_NAME" in
  mcp__mini-bridge__lark_*) exit 0 ;;
esac

# --- Helper Functions ---

get_token() {
  if [ -f "$TOKEN_CACHE" ]; then
    local exp
    exp=$(jq -r '.exp // 0' "$TOKEN_CACHE" 2>/dev/null)
    if [ "$(date +%s)" -lt "$exp" ] 2>/dev/null; then
      jq -r '.token' "$TOKEN_CACHE" 2>/dev/null
      return
    fi
  fi
  local app_id app_secret resp token
  app_id=$(awk '/^app_id:/{print $2}' "$HOME/.mini-bridge/config.yaml" 2>/dev/null)
  app_secret=$(awk '/^app_secret:/{print $2}' "$HOME/.mini-bridge/config.yaml" 2>/dev/null)
  resp=$(curl -sS --max-time 3 -X POST "$API/open-apis/auth/v3/tenant_access_token/internal" \
    -H "Content-Type: application/json" \
    -d "{\"app_id\":\"$app_id\",\"app_secret\":\"$app_secret\"}" 2>/dev/null)
  token=$(echo "$resp" | jq -r '.tenant_access_token // empty' 2>/dev/null)
  if [ -n "$token" ]; then
    printf '{"token":"%s","exp":%d}' "$token" "$(($(date +%s)+7000))" > "$TOKEN_CACHE"
    echo "$token"
  fi
}

tool_display() {
  local tool="$1" input="$2" val
  case "$tool" in
    Read)
      val=$(echo "$input" | jq -r '.file_path // ""' 2>/dev/null)
      val=$(basename "$val" 2>/dev/null || echo "$val")
      echo "📖 阅读: \`$val\`" ;;
    Edit)
      val=$(echo "$input" | jq -r '.file_path // ""' 2>/dev/null)
      val=$(basename "$val" 2>/dev/null || echo "$val")
      echo "✏️ 编辑: \`$val\`" ;;
    Write)
      val=$(echo "$input" | jq -r '.file_path // ""' 2>/dev/null)
      val=$(basename "$val" 2>/dev/null || echo "$val")
      echo "📝 创建: \`$val\`" ;;
    Bash)
      val=$(echo "$input" | jq -r '.command // ""' 2>/dev/null | head -c 45)
      echo "💻 命令: \`${val}...\`" ;;
    Grep)
      val=$(echo "$input" | jq -r '.pattern // ""' 2>/dev/null)
      echo "🔍 搜索: \`$val\`" ;;
    Glob)
      val=$(echo "$input" | jq -r '.pattern // ""' 2>/dev/null)
      echo "📂 查找: \`$val\`" ;;
    Agent)
      val=$(echo "$input" | jq -r '.description // ""' 2>/dev/null)
      echo "🤖 代理: $val" ;;
    WebFetch)
      val=$(echo "$input" | jq -r '.url // ""' 2>/dev/null | head -c 40)
      echo "🌐 网页: \`$val\`" ;;
    WebSearch)
      val=$(echo "$input" | jq -r '.query // ""' 2>/dev/null)
      echo "🔎 搜索: $val" ;;
    LSP)
      val=$(echo "$input" | jq -r '.operation // ""' 2>/dev/null)
      echo "🧠 LSP: $val" ;;
    Skill)
      val=$(echo "$input" | jq -r '.skill // ""' 2>/dev/null)
      echo "⚡ 技能: $val" ;;
    NotebookEdit)
      echo "📓 编辑 Notebook" ;;
    *)
      echo "🔧 $tool" ;;
  esac
}

build_working_card() {
  local current="$1" history="$2" footer="$3"
  jq -n \
    --arg current "$current" \
    --arg history "$history" \
    --arg footer "$footer" \
    '{
      config: {wide_screen_mode: true},
      header: {title: {tag: "plain_text", content: "🔵 Claude Code 工作中"}, template: "blue"},
      elements: [
        {tag: "markdown", content: ("**当前操作**\n" + $current)},
        {tag: "hr"},
        {tag: "markdown", content: $history},
        {tag: "note", elements: [{tag: "plain_text", content: $footer}]}
      ]
    }'
}

build_done_card() {
  local history="$1" footer="$2"
  jq -n \
    --arg history "$history" \
    --arg footer "$footer" \
    '{
      config: {wide_screen_mode: true},
      header: {title: {tag: "plain_text", content: "✅ Claude Code 任务完成"}, template: "green"},
      elements: [
        {tag: "markdown", content: $history},
        {tag: "note", elements: [{tag: "plain_text", content: $footer}]}
      ]
    }'
}

send_card() {
  local token="$1" chat_id="$2" card="$3"
  local content
  content=$(echo "$card" | jq -Rs '.')
  local resp
  resp=$(curl -sS --max-time 3 -X POST \
    "$API/open-apis/im/v1/messages?receive_id_type=chat_id" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -d "{\"receive_id\":\"$chat_id\",\"msg_type\":\"interactive\",\"content\":$content}" 2>/dev/null)
  echo "$resp" | jq -r '.data.message_id // empty' 2>/dev/null
}

update_card() {
  local token="$1" msg_id="$2" card="$3"
  local content
  content=$(echo "$card" | jq -Rs '.')
  curl -sS --max-time 3 -X PATCH \
    "$API/open-apis/im/v1/messages/$msg_id" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -d "{\"content\":$content}" >/dev/null 2>&1
}

format_time() {
  local s="$1"
  if [ "$s" -lt 60 ] 2>/dev/null; then
    echo "${s}秒"
  elif [ "$s" -lt 3600 ] 2>/dev/null; then
    echo "$((s/60))分$((s%60))秒"
  else
    echo "$((s/3600))时$((s%3600/60))分"
  fi
}

# Simple file-based lock (best-effort, non-blocking)
acquire_lock() {
  local i=0
  while [ -f "$LOCK" ] && [ $i -lt 10 ]; do
    sleep 0.1
    i=$((i+1))
  done
  echo $$ > "$LOCK"
}

release_lock() {
  rm -f "$LOCK"
}

# --- Main Logic ---

TOKEN=$(get_token)
[ -n "$TOKEN" ] || exit 0

NOW=$(date +%s)
MSG_ID=$(echo "$STATE_DATA" | jq -r '.message_id // empty' 2>/dev/null)
START_TIME=$(echo "$STATE_DATA" | jq -r '.start_time // 0' 2>/dev/null)
STEP_COUNT=$(echo "$STATE_DATA" | jq -r '.step_count // 0' 2>/dev/null)

case "$PHASE" in
  pre)
    acquire_lock
    # Re-read state (might have changed)
    STATE_DATA=$(cat "$STATE" 2>/dev/null)
    MSG_ID=$(echo "$STATE_DATA" | jq -r '.message_id // empty' 2>/dev/null)
    START_TIME=$(echo "$STATE_DATA" | jq -r '.start_time // 0' 2>/dev/null)
    STEP_COUNT=$(echo "$STATE_DATA" | jq -r '.step_count // 0' 2>/dev/null)

    DISPLAY=$(tool_display "$TOOL_NAME" "$TOOL_INPUT")
    STEP_COUNT=$((STEP_COUNT + 1))

    [ "$START_TIME" -eq 0 ] 2>/dev/null && START_TIME=$NOW

    ELAPSED=$((NOW - START_TIME))
    ELAPSED_STR=$(format_time $ELAPSED)

    # Build history text from steps array (last 8)
    STEPS_TEXT=$(echo "$STATE_DATA" | jq -r '(.steps // [])[-8:] | join("\n")' 2>/dev/null)
    if [ -n "$STEPS_TEXT" ] && [ "$STEPS_TEXT" != "null" ]; then
      HISTORY="**操作记录**\n$STEPS_TEXT"
    else
      HISTORY="**操作记录**\n_开始工作..._"
    fi

    FOOTER="⏱ $ELAPSED_STR | 第${STEP_COUNT}步"

    CARD=$(build_working_card "🔄 $DISPLAY" "$HISTORY" "$FOOTER")

    if [ -z "$MSG_ID" ]; then
      MSG_ID=$(send_card "$TOKEN" "$CHAT_ID" "$CARD")
    else
      update_card "$TOKEN" "$MSG_ID" "$CARD"
    fi

    # Save state
    echo "$STATE_DATA" | jq \
      --arg mid "${MSG_ID:-}" \
      --arg step "✅ $DISPLAY" \
      --argjson sc "$STEP_COUNT" \
      --argjson st "$START_TIME" \
      '.message_id = $mid | .step_count = $sc | .start_time = $st | .steps = ((.steps // []) + [$step] | .[-15:])' \
      > "$STATE" 2>/dev/null

    release_lock
    ;;

  post)
    # Currently no-op. The next PreToolUse will handle the transition.
    ;;

  stop)
    if [ -n "$MSG_ID" ]; then
      ELAPSED=$((NOW - START_TIME))
      ELAPSED_STR=$(format_time $ELAPSED)
      STEPS_TEXT=$(echo "$STATE_DATA" | jq -r '(.steps // []) | join("\n")' 2>/dev/null)

      if [ -n "$STEPS_TEXT" ] && [ "$STEPS_TEXT" != "null" ]; then
        HISTORY="**操作记录** (共${STEP_COUNT}步)\n$STEPS_TEXT"
      else
        HISTORY="**操作记录**\n_无工具调用_"
      fi

      FOOTER="✅ 已完成 | 用时 $ELAPSED_STR | 共${STEP_COUNT}步"
      CARD=$(build_done_card "$HISTORY" "$FOOTER")
      update_card "$TOKEN" "$MSG_ID" "$CARD"

      # Reset for next task (keep enabled + chat_id)
      echo "$STATE_DATA" | jq '{enabled, chat_id}' > "$STATE" 2>/dev/null
    fi
    ;;
esac

exit 0
