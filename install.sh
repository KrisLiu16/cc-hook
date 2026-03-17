#!/bin/bash
# cc-hook installer
# Installs the Feishu Card Hook for Claude Code

set -euo pipefail

HOOK_DIR="$HOME/.claude/hooks"
SETTINGS="$HOME/.claude/settings.json"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== cc-hook installer ==="
echo ""

# Check dependencies
for cmd in jq curl; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: $cmd is not installed. Please install it first."
    exit 1
  fi
done

# Check mini-bridge config
if [ ! -f "$HOME/.mini-bridge/config.yaml" ]; then
  echo "WARNING: ~/.mini-bridge/config.yaml not found."
  echo "  The hook needs mini-bridge credentials to send Feishu cards."
  echo ""
fi

# Copy hook script
mkdir -p "$HOOK_DIR"
cp "$SCRIPT_DIR/feishu-card.sh" "$HOOK_DIR/"
chmod +x "$HOOK_DIR/feishu-card.sh"
echo "✓ Hook script installed to $HOOK_DIR/feishu-card.sh"

# Merge hooks into settings.json
if [ -f "$SETTINGS" ]; then
  # Check if hooks already configured
  if jq -e '.hooks.PreToolUse' "$SETTINGS" &>/dev/null; then
    echo "✓ Hooks already configured in $SETTINGS (skipped)"
  else
    # Merge hooks config
    HOOKS_JSON=$(cat "$SCRIPT_DIR/settings-hooks.json")
    jq --argjson hooks "$(echo "$HOOKS_JSON" | jq '.hooks')" '. + {hooks: $hooks}' "$SETTINGS" > "${SETTINGS}.tmp"
    mv "${SETTINGS}.tmp" "$SETTINGS"
    echo "✓ Hooks config added to $SETTINGS"
  fi
else
  echo "WARNING: $SETTINGS not found. Please add hooks config manually."
  echo "  Reference: $SCRIPT_DIR/settings-hooks.json"
fi

echo ""
echo "=== Installation complete ==="
echo ""
echo "To activate, run:"
echo "  echo '{\"enabled\":true,\"chat_id\":\"YOUR_CHAT_ID\"}' > /tmp/claude-feishu-card.json"
echo ""
echo "Get your chat_id from mini-bridge logs:"
echo "  grep 'received message from feishu' ~/.mini-bridge/gateway.log | tail -1"
echo ""
