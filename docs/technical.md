# Claude Code WeChat Channel 技术文档

## 概述

Claude Code WeChat Channel 是一个 MCP Channel 插件，将微信消息桥接到 Claude Code 会话中，实现通过微信直接与 Claude Code 交互。

- 仓库：https://github.com/vansin/claude-code-wechat-channel
- 运行时：Bun >= 1.0
- 协议：MCP (Model Context Protocol) Channel 扩展
- 微信接口：ClawBot ilink API（与 @tencent-weixin/openclaw-weixin 相同协议）

## 架构

```
微信 iOS App
    ↓ 用户发消息
WeChat ClawBot（微信官方插件）
    ↓ ilink 协议
ilink API (ilinkai.weixin.qq.com)
    ↓ HTTP POST
wechat-channel.ts（MCP Server，长轮询）
    ↓ MCP Channel Protocol (notifications/claude/channel)
Claude Code Session（通过 stdio 通信）
    ↓ 调用 wechat_reply tool
wechat-channel.ts → ilink/bot/sendmessage → 微信
```

## 文件结构

| 文件 | 作用 |
|------|------|
| wechat-channel.ts | MCP Channel 服务器主文件（~450行） |
| setup.ts | 独立扫码登录工具 |
| .mcp.json | Claude Code MCP 服务器声明 |
| package.json | 依赖：@modelcontextprotocol/sdk + qrcode-terminal |

## 核心流程

### 1. 扫码登录

```
setup.ts 或 wechat-channel.ts（首次无凭据时）
    ↓
GET ilink/bot/get_bot_qrcode?bot_type=3
    → 返回 { qrcode, qrcode_img_content }
    → 终端显示二维码（qrcode-terminal 库）
    ↓
用户微信扫码
    ↓
轮询 GET ilink/bot/get_qrcode_status?qrcode=xxx
    → status: wait → scaned → confirmed
    → confirmed 时返回 { bot_token, ilink_bot_id, baseurl, ilink_user_id }
    ↓
保存凭据到 ~/.claude/channels/wechat/account.json
    → { token, baseUrl, accountId, userId, savedAt }
    → chmod 600
```

### 2. 消息接收（长轮询）

```
循环 POST ilink/bot/getupdates
    body: { get_updates_buf, base_info: { channel_version } }
    headers: { Authorization: "Bearer {token}", X-WECHAT-UIN: randomBase64 }
    timeout: 35秒
    ↓
返回 { ret, msgs[], get_updates_buf }
    → get_updates_buf 是同步游标，持久化到 ~/.claude/channels/wechat/sync_buf.txt
    → msgs 包含新消息列表
    ↓
过滤：仅处理 message_type === 1（用户消息）
提取文本：
    - type 1 (text_item.text) — 文字消息
    - type 3 (voice_item.text) — 语音转文字
    - 支持引用消息（ref_msg）
    ↓
缓存 context_token（回复时需要）
    → Map<sender_id, context_token>
    ↓
推送到 Claude Code：
    mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: text,
        meta: { sender, sender_id }
      }
    })
```

### 3. 消息发送（回复）

```
Claude Code 调用 wechat_reply tool
    → { sender_id: "xxx@im.wechat", text: "回复内容" }
    ↓
从缓存获取 context_token
    ↓
POST ilink/bot/sendmessage
    body: {
      msg: {
        to_user_id: sender_id,
        client_id: 唯一ID,
        message_type: 2 (bot),
        message_state: 2 (finish),
        item_list: [{ type: 1, text_item: { text } }],
        context_token
      }
    }
```

## 关键技术细节

### ilink API 鉴权

每个请求需要：
- Authorization: Bearer {bot_token}
- AuthorizationType: ilink_bot_token
- X-WECHAT-UIN: 随机 Base64 编码的 uint32（防重放）
- Content-Type: application/json

### 错误处理与重试

- 连续失败 3 次后 backoff 30 秒
- 单次失败重试间隔 2 秒
- 长轮询超时 35 秒（无消息时正常超时，继续下一轮）
- AbortError 不计为失败

### context_token 机制

微信 ilink API 要求回复时带上 context_token（从接收消息中获取）。这是微信端用于关联对话上下文的令牌。如果没有 context_token，sendmessage 会失败。

缓存策略：内存 Map，key 为 sender_id。每次收到新消息更新。session 重启后需要用户先发一条消息才能回复。

### MCP Channel 协议

Channel 是 MCP 的实验性扩展，在标准 MCP 工具协议之上增加了：
- capabilities.experimental["claude/channel"] — 声明为 Channel 类型
- notifications/claude/channel — 向 Claude Code 推送外部消息
- Claude Code 收到后以 <channel source="wechat"> 标签展示给用户
- 回复通过常规 MCP tool call（wechat_reply）实现

## 使用方式

### 安装

```bash
cd ~/claude-code-wechat-channel
bun install
```

### 扫码登录

```bash
bun setup.ts
# 微信扫码确认后，凭据保存到 ~/.claude/channels/wechat/account.json
```

### 添加到全局 MCP

```bash
claude mcp add -s user wechat bun /path/to/claude-code-wechat-channel/wechat-channel.ts
```

### 启动

```bash
claude --dangerously-load-development-channels server:wechat
```

也可以在任意目录启动（已配置全局 MCP）。

## 当前限制

1. 单 Session 绑定：一个 ClawBot 实例只能连接一个 Claude Code session，无法路由到多个项目
2. Session 断开即失联：Claude Code 退出后通道断开，需要重新启动
3. 仅支持文字/语音：不支持图片、文件、小程序等消息类型
4. context_token 不持久化：session 重启后需要用户先发消息才能回复
5. 仅 iOS：微信 ClawBot 目前仅支持 iOS 最新版
6. Research Preview：需要 --dangerously-load-development-channels 标志

## 升级方案：多 Session 消息路由（方案 A）

### 目标

通过消息前缀路由到不同项目的 Claude Code session，每个 session 保持独立上下文。

### 架构设计

```
微信 → ilink API → 消息路由中间件（常驻进程）
                        ↓ 解析前缀
                   ┌────┼────┬────┬────┐
                   ↓    ↓    ↓    ↓    ↓
              project-a  project-b  project-c  ...
              session    session    session
              ~/proj-a   ~/proj-b   ~/proj-c
```

### 路由规则

| 前缀 | 目标项目 | 工作目录 |
|------|---------|---------|
| /a | Project A | ~/project-a |
| /b | Project B | ~/project-b |
| 无前缀 | 上次活跃的 session | - |

用户可通过 `config.json` 自定义路由前缀和项目目录。

### 技术要点

1. 中间件独立于 Claude Code 运行，管理微信连接和消息路由
2. 每个 Claude Code session 作为子进程启动，通过 stdin/stdout 通信
3. 需要研究 Claude CLI 是否支持非交互式消息注入（--pipe 模式或 API）
4. session 保活/自动重启机制
5. 消息队列缓存（session 未启动时暂存消息）

### 待研究

- Claude Code CLI 的 --pipe / programmatic API
- MCP Channel 是否支持多 server 同时连接
- 子进程管理最佳实践（pm2 / 自建进程池）
- 消息持久化（SQLite / Redis）

---

文档更新：2026-03-22
作者：Claude Code (Team Lead)
