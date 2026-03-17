# cc-hook

Claude Code → Feishu card real-time status plugin.

Tracks Claude Code's tool usage and displays progress as a single, continuously updating Feishu interactive card.

## Install

```bash
npm install -g cc-hook
cc-hook install    # inject hooks into ~/.claude/settings.json
cc-hook on         # enable (auto-detects chat_id from mini-bridge logs)
```

Restart Claude Code after install.

## Requirements

- Node.js >= 18
- [mini-bridge](https://github.com/anthropics/mini-bridge) running with Feishu bot credentials
- `~/.mini-bridge/config.yaml` with `app_id` and `app_secret`

## Commands

```
cc-hook install       Add hooks to Claude Code settings
cc-hook uninstall     Remove hooks
cc-hook on [chat_id]  Enable card mode
cc-hook off           Disable card mode
cc-hook status        Show current state
```

## How it works

```
Claude Code                    cc-hook                     Feishu
    │                             │                           │
    ├─ PreToolUse ───────────────►├─ send/update card ───────►│
    │  {tool: "Read", input: {}} │                           │ Card: "Working"
    │                             │                           │
    ├─ PreToolUse ───────────────►├─ update card ────────────►│
    │  {tool: "Edit", input: {}} │                           │ Card: updated
    │                             │                           │
    ├─ Stop ─────────────────────►├─ finalize card ──────────►│
    │                             │                           │ Card: "Done"
```

Hooks fire on every tool call. The plugin sends one card on the first tool use, then patches the same card as work progresses. On stop, the card turns green.

## Card format

**Working:**
```
┌──────────────────────────────────┐
│ Claude Code · Working       blue │
├──────────────────────────────────┤
│ ▸ `READ`  …/hooks/feishu-card.ts│
│ ─────────────────────────────    │
│ Record · 3 steps                 │
│ `BASH`  mkdir -p ~/.claude/hooks │
│ `READ`  …/config.yaml           │
│ `EDIT`  …/settings.json         │
│                                  │
│ step 4 · 12s                     │
└──────────────────────────────────┘
```

**Done:**
```
┌──────────────────────────────────┐
│ Claude Code · Done        green  │
├──────────────────────────────────┤
│ Record · 4 steps                 │
│ `BASH`  mkdir -p ~/.claude/hooks │
│ `READ`  …/config.yaml           │
│ `EDIT`  …/settings.json         │
│ `READ`  …/hooks/feishu-card.ts  │
│                                  │
│ done · 4 steps · 15s             │
└──────────────────────────────────┘
```

## State files

| File | Purpose |
|------|---------|
| `/tmp/cc-hook-state.json` | Enabled flag, chat_id, current card state |
| `/tmp/cc-hook-token.json` | Feishu token cache (~2h TTL) |

## License

MIT
