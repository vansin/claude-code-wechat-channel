# Claude Code WeChat Channel 升级方案

> 仓库：https://github.com/vansin/claude-code-wechat-channel
> 日期：2026-03-22
> 策略：**先把单 Session 做到极致，再扩展多 Session 路由**

---

## 一、现状

### 已有能力
- 微信扫码登录（ClawBot ilink API）
- 文字消息收发
- 语音消息（自动转文字）
- MCP Channel 协议通信
- 单 Session 绑定

### 核心痛点
1. **仅文字**：不支持图片，用户发截图 Claude 看不到
2. **无反馈**：消息发出后不知道处理状态，不知道何时完成
3. **Session 脆弱**：退出即断连，消息丢失
4. **单 Session**：只能连一个 Claude Code 会话（后续解决）

---

## 二、升级策略

```
Phase 1 — 单 Session 极致体验（当前重点）
    ├── 图片收发
    ├── 即时反馈 + 主动通知
    └── 消息持久化

Phase 2 — 多 Session 路由（后续）
    ├── 消息前缀路由
    ├── 子进程池管理
    └── Session 恢复
```

---

## 三、Phase 1：单 Session 极致体验

### 1.1 图片支持（P0）

**目标**：用户发图片 → Claude 能看到；Claude 回复图片 → 用户能看到

#### 接收图片

```
用户发图片
  ↓
ilink getupdates 返回 image_item
  ↓ 提取 image_item.url
下载图片到本地 /tmp
  ↓
上传到 OSS（可选，也可直接用 ilink URL）
  ↓
传给 Claude Code：
  "用户发了一张图片：[图片URL]"
  （Claude 可通过 WebFetch 或直接理解 URL）
```

**实现要点**：
- `extractTextFromMessage()` 新增 `type === 2`（图片类型）处理
- 图片消息格式：`image_item.url` 或 `image_item.media_id`
- 需要研究 ilink API 图片字段的具体格式（通过抓包或测试确认）
- 可选：本地缓存图片避免重复下载

#### 发送图片

```
Claude 调用 wechat_reply_image tool
  ↓
传入图片 URL
  ↓
通过 ilink/bot/sendmessage 发送
  item_list: [{ type: 2, image_item: { url: "..." } }]
```

**实现要点**：
- 新增 MCP Tool：`wechat_reply_image`
- 参数：`sender_id` + `image_url`
- ilink sendmessage 的 image_item 格式需验证

#### 代码改动

```
wechat-channel.ts:
  - extractTextFromMessage(): 新增图片类型提取
  - ListToolsRequestSchema handler: 新增 wechat_reply_image tool
  - CallToolRequestSchema handler: 新增图片发送逻辑
  - sendImageMessage(): 新函数
```

### 1.2 即时反馈 + 主动通知（P0）

**目标**：
- 收到消息 → 立即回复"收到，处理中..."
- 长任务完成 → 主动推送结果
- 正在处理 → 有状态提示

#### "正在输入" 状态指示器

ilink API 提供了原生的"正在输入"状态显示（类似微信对话框顶部的"对方正在输入..."提示），**不是**发一条消息，而是显示原生 typing 状态。

**API 调研结果**：

ilink 提供两个相关接口：
1. `POST /ilink/bot/getconfig` — 获取 `typing_ticket`（typing 认证令牌）
2. `POST /ilink/bot/sendtyping` — 发送"正在输入"状态（需要 `typing_ticket`）

**实现流程**：
```
启动时/定期：
  POST /ilink/bot/getconfig → 获取 typing_ticket 并缓存
  ↓
收到用户消息：
  POST /ilink/bot/sendtyping (携带 typing_ticket)
  → 用户看到"对方正在输入..."
  ↓
每 5 秒重复发送 sendtyping（typing 状态约 5-6 秒后过期）
  → setInterval 保持 typing 状态
  ↓
Claude 回复后：
  clearInterval 停止发送 typing
  → 发送正式回复
```

**实现要点**：
- 启动时调用 `getconfig` 获取 `typing_ticket` 并缓存
- `typing_ticket` 可能有有效期，需定期刷新
- 使用 `setInterval(sendTyping, 5000)` 保持 typing 状态
- Claude 回复后 `clearInterval` 停止
- 参考 OpenClaw 的 `typingIntervalSeconds: 6` 默认配置

#### 即时文字确认（备选）

如果 sendtyping API 调用失败或不可用，降级为发一条文字消息：
- 在 `startPolling()` 处理消息时，先调用 `sendTextMessage()` 发"收到，处理中..."
- 可选：对短消息（如"好"、"嗯"）不发确认

#### 主动通知

当前 Channel 协议是被动的（Claude 通过 tool call 回复）。主动通知需要：

- MCP Server 维护一个 `pendingNotify` 标志
- Claude 在完成长任务后调用 `wechat_reply` 时，自动判断是否为异步结果
- 或者：在 MCP instructions 中明确告诉 Claude "如果用户之前的消息已经收到确认，请在完成后主动回复结果"

**实现方式 A（简单）**：
在 MCP Server instructions 中添加：
```
When you receive a message from WeChat, the user has already been sent
"收到，处理中..." as an immediate acknowledgment. Always reply with the
final result using wechat_reply when done.
```

**实现方式 B（增强）**：
新增 `wechat_notify` tool，专门用于异步通知：
- 不需要 sender_id（使用上次消息的 sender）
- 支持进度更新（如"渲染中 60%..."）

### 1.3 消息持久化（P1）

**目标**：Session 断开不丢消息，重启后可查历史

#### 存储方案

```
SQLite（bun:sqlite 内置支持，零依赖）
  ↓
~/.claude/channels/wechat/messages.db
```

**表结构**：
```sql
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id TEXT NOT NULL,
  direction TEXT NOT NULL,  -- 'in' | 'out'
  content TEXT NOT NULL,
  media_type TEXT,          -- 'text' | 'image' | 'voice'
  media_url TEXT,           -- 图片/语音 URL
  status TEXT DEFAULT 'delivered', -- delivered/failed
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_messages_sender ON messages(sender_id);
CREATE INDEX idx_messages_created ON messages(created_at);
```

**实现要点**：
- Bun 内置 `bun:sqlite`，无需额外依赖
- 每条收发消息自动入库
- 可选：`/history` 命令查看最近 N 条消息
- 可选：启动时读取最近消息作为上下文

### 1.4 连接稳定性增强（P1）

**目标**：token 过期自动检测，断线自动重连

- 检测 `errcode` 特定错误码（token 失效）
- 失效后自动触发扫码流程并通知用户
- 网络波动后自动恢复长轮询
- 心跳机制（定期发 getupdates 检测连接健康）

---

## 四、Phase 2：多 Session 路由（后续）

### 目标

一个微信对话操控多个项目的 Claude Code Session。

### 架构

```
微信消息 → Router 中间件 → 多个 Claude -p 子进程
                            ├── ~/project-a    (/a)
                            ├── ~/project-b    (/b)
                            └── ...            (可配置)
```

### 路由规则

通过消息前缀路由，可通过 `config.json` 自定义：

| 命令 | 效果 |
|------|------|
| `/a 升级首页` | 路由到 project-a |
| `/b 查用户数` | 路由到 project-b |
| `/status` | 查看所有 Session 状态 |
| `/stop b` | 停止 project-b Session |
| 无前缀 | 发到上次活跃的 Session |

### 技术方案
- Router 常驻进程（Bun），管理微信连接 + 子进程池
- 每个项目用 `claude -p --input-format stream-json` 启动
- 按需启动：首次收到消息时 spawn，空闲 30 分钟回收
- `--session-id` 实现上下文恢复

### 配置文件 config.json

```json
{
  "projects": {
    "my-website": {
      "prefix": "/w",
      "cwd": "/home/user/my-website",
      "name": "My Website",
      "autoStart": false
    },
    "my-api": {
      "prefix": "/a",
      "cwd": "/home/user/my-api",
      "name": "Backend API",
      "autoStart": false
    }
  },
  "defaultProject": "my-website",
  "sessionTimeout": 1800
}
```

---

## 五、Phase 3：增强功能（远期）

| 模块 | 说明 |
|------|------|
| 智能指令 | `/deploy` `/build` `/git` `/status` 快捷命令 |
| 定时任务 | 每日站报、健康检查、自动备份 |
| Web Dashboard | Session 面板、消息历史、配置管理 |
| 多用户 | 区分不同微信发送者，权限控制 |
| 文件支持 | 接收/发送文件（PDF、代码等） |

---

## 六、实施计划

### Phase 1 — 单 Session 极致（优先执行）

| 步骤 | 任务 | 预估 |
|------|------|------|
| 1 | 图片接收：解析 image_item，提取 URL 传给 Claude | 2h |
| 2 | 图片发送：新增 wechat_reply_image tool | 1h |
| 3 | 即时确认：收到消息立即回"处理中" | 1h |
| 4 | 主动通知：更新 instructions 引导 Claude 主动回复 | 0.5h |
| 5 | SQLite 消息持久化 | 2h |
| 6 | 连接稳定性（token 检测 + 自动重连） | 1h |
| 7 | 测试 + 修复 | 1h |

### Phase 2 — 多 Session 路由

| 步骤 | 任务 | 预估 |
|------|------|------|
| 1 | 提取 ilink.ts 通信层 | 1h |
| 2 | 实现 router.ts + 前缀解析 | 2h |
| 3 | 实现 session-manager.ts（子进程池） | 3h |
| 4 | 端到端测试 | 2h |

---

## 七、代码改动清单（Phase 1）

```
wechat-channel.ts 改动：
├── extractTextFromMessage()
│   └── 新增 type === 2 (图片) 处理
├── ListToolsRequestSchema handler
│   └── 新增 wechat_reply_image tool 定义
├── CallToolRequestSchema handler
│   └── 新增 wechat_reply_image 调用逻辑
├── startPolling()
│   └── 收到消息后先发 ack 确认
├── sendImageMessage()     ← 新函数
├── MessageStore class     ← 新增，SQLite 封装
└── MCP instructions
    └── 更新：告知 Claude 消息已有 ack，完成后主动回复

新增文件：
├── src/message-store.ts   ← SQLite 消息存储
└── （可选）src/media.ts   ← 图片下载/上传工具
```

---

## 八、风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| ilink 图片字段格式未知 | 中 | 无法解析图片 | 发测试图片抓包确认 |
| bun:sqlite 兼容性 | 低 | 持久化失败 | 降级为 JSON 文件 |
| ack 消息与正式回复重复 | 低 | 体验差 | ack 用不同格式区分 |
| ilink token 过期频率 | 中 | 断连 | 监控错误码自动提醒 |

---

文档作者：Claude Code
日期：2026-03-22
