# cc-hook

Claude Code Feishu Card Hook — 飞书卡片实时工作状态插件

在飞书中以交互卡片的形式实时展示 Claude Code 的工作进度。一张卡片，不断更新，让你随时知道 Claude 在做什么。

## 效果

- 工作中：🔵 蓝色卡片，实时显示当前操作和历史记录
- 完成时：✅ 绿色卡片，显示总用时和总步数

支持的工具状态展示：
| 工具 | 显示 |
|------|------|
| Read | 📖 阅读: `filename` |
| Edit | ✏️ 编辑: `filename` |
| Write | 📝 创建: `filename` |
| Bash | 💻 命令: `command...` |
| Grep | 🔍 搜索: `pattern` |
| Glob | 📂 查找: `pattern` |
| Agent | 🤖 代理: `description` |
| WebFetch | 🌐 网页: `url` |
| WebSearch | 🔎 搜索: `query` |
| LSP | 🧠 LSP: `operation` |

## 前置条件

- [mini-bridge](https://github.com/anthropics/mini-bridge) 已配置并运行（提供飞书 Bot 凭证）
- `~/.mini-bridge/config.yaml` 中包含 `app_id` 和 `app_secret`
- 系统已安装 `jq` 和 `curl`

## 安装

```bash
# 1. 克隆仓库
git clone https://github.com/KrisLiu16/cc-hook.git
cd cc-hook

# 2. 运行安装脚本
bash install.sh
```

## 手动安装

```bash
# 1. 复制 hook 脚本
mkdir -p ~/.claude/hooks
cp feishu-card.sh ~/.claude/hooks/
chmod +x ~/.claude/hooks/feishu-card.sh

# 2. 在 ~/.claude/settings.json 中添加 hooks 配置
# 参考 settings-hooks.json
```

## 使用

### 开启飞书卡片模式

```bash
# chat_id 从 mini-bridge 日志中获取
echo '{"enabled":true,"chat_id":"oc_你的群聊ID"}' > /tmp/claude-feishu-card.json
```

### 关闭

```bash
echo '{"enabled":false}' > /tmp/claude-feishu-card.json
# 或直接删除
rm /tmp/claude-feishu-card.json
```

### 查看状态

```bash
cat /tmp/claude-feishu-card.json
```

## 架构

```
┌─────────────┐  Hook Events   ┌──────────────┐  Feishu API   ┌────────┐
│ Claude Code  │ ─────────────► │feishu-card.sh│ ────────────► │  飞书   │
│  (工作中)    │  PreToolUse    │  (状态管理)   │  create/patch │  (卡片) │
│              │  PostToolUse   │              │               │        │
│              │  Stop          │              │               │        │
└─────────────┘                └──────────────┘               └────────┘
```

**文件说明：**

| 文件 | 说明 |
|------|------|
| `feishu-card.sh` | Hook 主脚本，处理 pre/post/stop 三种事件 |
| `install.sh` | 一键安装脚本 |
| `settings-hooks.json` | hooks 配置片段，供手动添加到 settings.json |
| `/tmp/claude-feishu-card.json` | 运行时状态（卡片 ID、步骤记录） |
| `/tmp/claude-feishu-token.json` | 飞书 Token 缓存（~2小时有效） |

## License

MIT
