# CC Bridge - 自建飞书 Bridge 技术方案

## 1. 目标

替代 mini-bridge，实现飞书 ↔ Claude Code 的完整通信，并支持：
- 回复直接以卡片发送（不再需要 Stop hook 拦截）
- 卡片交互回调（按钮、表单、选择器）
- MCP Elicitation 转飞书交互
- 更灵活的消息格式控制

## 2. 架构

```
┌──────────────┐     WebSocket      ┌──────────────┐     CLI/stdio      ┌──────────────┐
│   飞书服务器   │ ◄──────────────► │   CC Bridge   │ ◄──────────────► │  Claude Code  │
└──────────────┘                    └──────────────┘                    └──────────────┘
                                          │
                                    ┌─────┴─────┐
                                    │  MCP Server │
                                    └───────────┘
```

### 三个核心模块

**A. 飞书网关（Feishu Gateway）**
- WebSocket 长连接，订阅事件
- 处理 `im.message.receive_v1` → 用户消息
- 处理 `card.action.trigger` → 卡片交互回调
- 发送消息：POST `/open-apis/im/v1/messages`
- 更新卡片：PATCH `/open-apis/im/v1/messages/{message_id}`

**B. Claude Code 管理器（Claude Manager）**
- 启动 `claude` CLI 进程
- 传入用户消息，读取回复
- 管理会话生命周期

**C. MCP Server（可选，后期）**
- stdio 模式，提供飞书 API 工具
- `lark_api`、`lark_read_doc` 等

## 3. 飞书 API 清单

### 3.1 认证
```
POST /open-apis/auth/v3/tenant_access_token/internal
Body: { "app_id": "...", "app_secret": "..." }
Response: { "tenant_access_token": "...", "expire": 7200 }
```

### 3.2 发送消息
```
POST /open-apis/im/v1/messages?receive_id_type=chat_id
Headers: Authorization: Bearer {token}
Body: {
  "receive_id": "oc_xxx",
  "msg_type": "interactive",  // 卡片类型
  "content": "{...card JSON...}"
}
```

### 3.3 更新卡片
```
PATCH /open-apis/im/v1/messages/{message_id}
Body: { "content": "{...card JSON...}" }
```

### 3.4 获取 Bot 信息
```
GET /open-apis/bot/v3/info/
Response: { "bot": { "app_name": "CC助手", ... } }
```

### 3.5 获取用户信息（需要权限）
```
GET /open-apis/contact/v3/users/{open_id}?user_id_type=open_id
需要权限: contact:user.base:readonly
```

## 4. 飞书卡片 JSON 2.0

### 4.1 卡片结构
```json
{
  "schema": "2.0",
  "config": { "wide_screen_mode": true },
  "header": {
    "title": { "tag": "plain_text", "content": "标题" },
    "subtitle": { "tag": "plain_text", "content": "副标题" },
    "template": "blue",  // blue/green/purple/red/indigo/...
    "icon": { "tag": "standard_icon", "token": "chat_outlined" },
    "text_tag_list": [{
      "tag": "text_tag",
      "text": { "tag": "plain_text", "content": "标签" },
      "color": "blue"
    }]
  },
  "body": {
    "elements": [...]
  }
}
```

### 4.2 展示组件
| 组件 | tag | 用途 |
|------|-----|------|
| Markdown | `markdown` | 富文本内容 |
| 分割线 | `hr` | 水平分割 |
| 多列布局 | `column_set` | 多列排列 |

### 4.3 交互组件
| 组件 | tag | 用途 |
|------|-----|------|
| 按钮 | `button` | 点击回调/跳转 |
| 输入框 | `input` | 文本输入 |
| 单选下拉 | `select_static` | 单选菜单 |
| 多选下拉 | `multi_select_static` | 多选菜单 |
| 日期选择 | `date_picker` | 日期 |
| 时间选择 | `picker_time` | 时间 |
| 日期时间 | `picker_datetime` | 日期+时间 |
| 勾选框 | `checker` | 任务勾选 |
| 人员选择 | `select_person` | 选人（单选） |
| 多人选择 | `multi_select_person` | 选人（多选） |

### 4.4 按钮示例（JSON 2.0）
```json
{
  "tag": "button",
  "text": { "tag": "plain_text", "content": "确认" },
  "type": "primary",  // primary/danger/default
  "behaviors": [{
    "type": "callback",
    "value": { "action": "confirm", "task_id": "123" }
  }]
}
```
注意：JSON 2.0 不再支持 `action` 容器 tag，按钮直接放在 elements 或 column 内。

### 4.5 Markdown 支持范围
飞书卡片 Markdown 支持：
- **粗体** `**text**`
- *斜体* `*text*`
- ~~删除线~~ `~~text~~`
- `行内代码`
- 代码块 ` ```lang ... ``` `
- 链接 `[text](url)`
- 有序/无序列表

不支持：
- `#` 标题（需转为 `**粗体**`）
- `>` 引用块
- 表格
- 图片（需用 image 组件）

## 5. 卡片回调机制

### 5.1 事件类型
`card.action.trigger`（v2.0）

### 5.2 回调数据结构
```json
{
  "schema": "2.0",
  "header": {
    "event_id": "...",
    "token": "...",
    "create_time": "...",
    "event_type": "card.action.trigger",
    "tenant_key": "...",
    "app_id": "..."
  },
  "event": {
    "operator": {
      "open_id": "ou_xxx",
      "union_id": "on_xxx",
      "user_id": "xxx"
    },
    "token": "update_token_xxx",  // 用于更新卡片，30分钟有效
    "action": {
      "value": { "action": "confirm" },  // 按钮的 value
      "tag": "button",
      "name": "button_name",
      "form_value": {},  // 表单提交时的数据
      "input_value": ""  // 输入框的值
    },
    "context": {
      "open_message_id": "om_xxx",
      "open_chat_id": "oc_xxx"
    }
  }
}
```

### 5.3 回调响应格式
3 秒内响应，可选：
```json
{
  "toast": {
    "type": "success",  // success/error/warning/info
    "content": "操作成功"
  },
  "card": { ... }  // 可选，更新卡片内容
}
```

### 5.4 配置方式
- 飞书开放平台 → 应用 → 事件与回调 → 回调配置
- 支持长连接订阅（WebSocket），无需公网 URL

## 6. Claude Code CLI 交互

### 6.1 启动命令
```bash
claude --print "message"           # 单次对话，打印结果
claude --output-format stream-json # 流式 JSON 输出
claude --resume session_id         # 恢复会话
claude --session-id xxx            # 指定会话 ID
```

### 6.2 流式输出格式
```jsonl
{"type":"system","subtype":"init",...}
{"type":"assistant","message":{"content":[{"type":"text","text":"..."}],...}}
{"type":"result","subtype":"success","result":"final text",...}
```

### 6.3 MCP 配置
```bash
claude --mcp-config mcp.json
```
mcp.json:
```json
{
  "mcpServers": {
    "lark": {
      "command": "node",
      "args": ["mcp-server.js"],
      "type": "stdio"
    }
  }
}
```

## 7. Claude Code Hooks（已实现）

当前 cc-hook 已实现的 hook：
| Hook | 命令 | 用途 |
|------|------|------|
| UserPromptSubmit | `cc-hook prompt` | 创建 ThinkingCard |
| PreToolUse | `cc-hook pre` | 更新 WorkingCard |
| PostToolUse | `cc-hook post` | 绑定 session_id |
| SubagentStart | `cc-hook subagent-start` | 显示 agent 启动 |
| SubagentStop | `cc-hook subagent-stop` | 显示 agent 完成 |
| Stop | `cc-hook stop` | 发送 ReplyCard + block |

### 自建 Bridge 后可去掉的 Hook
- Stop hook 的拦截逻辑（bridge 直接发卡片）
- 所有 Feishu API 调用（bridge 负责）

### 保留有价值的 Hook
- PreToolUse/PostToolUse → 实时更新执行卡片
- Notification → 转发通知
- Elicitation → 转飞书交互卡片

## 8. MCP Elicitation → 飞书交互 方案

### 流程
1. MCP server 执行工具时需要用户输入
2. Claude Code 触发 `Elicitation` hook
3. Hook/Bridge 根据 elicitation 类型生成交互卡片：
   - 确认/取消 → 按钮卡片
   - 选择 → 下拉选择卡片
   - 文本输入 → 输入框卡片
4. 发送卡片到飞书
5. 用户在飞书操作
6. `card.action.trigger` 回调到 Bridge
7. Bridge 将结果传回 Claude Code
8. `ElicitationResult` hook 处理

### 难点
- Bridge 需要维护 elicitation 请求和回调的映射
- 超时处理（用户不响应）
- 多个并发 elicitation 的管理

## 9. 技术选型

| 模块 | 推荐 | 理由 |
|------|------|------|
| 语言 | Node.js / TypeScript | 复用 cc-hook 代码 |
| 飞书 SDK | `@larksuiteoapi/node-sdk` | 官方 SDK，支持长连接 |
| Claude CLI | `child_process.spawn` | 直接调用 claude 命令 |
| MCP | `@anthropic-ai/sdk` | MCP 协议实现 |

## 10. 实现步骤

### Phase 1: 基础通信
- [ ] 飞书 WebSocket 长连接
- [ ] 接收用户消息
- [ ] 启动 Claude Code CLI
- [ ] 回复以卡片发送

### Phase 2: 实时状态
- [ ] 工具调用实时更新卡片（复用 cc-hook 逻辑）
- [ ] ThinkingCard → WorkingCard → DoneCard + ReplyCard

### Phase 3: 卡片交互
- [ ] 处理 `card.action.trigger` 回调
- [ ] 按钮交互（确认/取消/自定义）
- [ ] 表单数据收集

### Phase 4: MCP 集成
- [ ] MCP Server（飞书工具）
- [ ] Elicitation → 飞书交互卡片
- [ ] 回调结果传回 Claude Code

## 11. 参考链接

- 飞书卡片概览: https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/feishu-card-overview
- 卡片组件 JSON 2.0: https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/component-json-v2-overview
- 卡片回调通信: https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-callback-communication
- 卡片搭建工具: https://open.feishu.cn/cardkit
- 卡片交互机器人教程: https://open.feishu.cn/document/uAjLw4CM/uMzNwEjLzcDMx4yM3ATM/develop-a-card-interactive-bot/introduction
- Claude Code Hooks 文档: https://code.claude.com/docs/en/hooks
- mini-bridge 配置: `~/.mini-bridge/config.yaml`
- cc-hook 源码: `/private/tmp/cc-hook/src/`
- cc-hook GitHub: https://github.com/KrisLiu16/cc-hook

## 12. 当前环境信息

- 飞书 App ID: `cli_a93385f92cb85bce`
- Bot 名称: CC助手
- Chat ID: `oc_b457fd32a6c7ed9e9a0f428a1e6a5062`
- mini-bridge Gateway 端口: 19876
- mini-bridge 已验证可收到 `card.action.trigger`（但未处理）
