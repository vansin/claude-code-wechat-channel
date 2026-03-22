# Claude Code WeChat Channel 全面升级方案

> 仓库：https://github.com/vansin/claude-code-wechat-channel
> 状态：待 Review
> 日期：2026-03-22

---

## 一、现状分析

### 当前能力
- 微信扫码登录（ClawBot ilink API）
- 文字/语音消息收发
- 单 Session 绑定
- MCP Channel 协议通信

### 核心痛点
1. **单 Session**：只能连一个 Claude Code 会话，无法操作多个项目
2. **Session 脆弱**：Claude Code 退出即断连，无消息缓存
3. **仅文字**：不支持图片、文件、链接卡片等富媒体
4. **无状态管理**：没有会话历史、项目切换记忆
5. **无法远程启动**：必须在终端手动启动 Claude Code

---

## 二、升级目标

从「单 Session 文字桥接」升级为「多项目 AI 工作台」：

```
微信发消息 → 自动路由到对应项目 → Claude Code 执行 → 结果发回微信
```

让用户在微信上就能管理所有项目，不需要打开终端。

---

## 三、升级模块

### 模块 1：多 Session 消息路由（P0 核心）

**目标**：一个微信对话操控多个项目的 Claude Code

```
微信消息 → Router 中间件 → 多个 Claude -p 子进程
                            ├── ~/project-a    (/a)
                            ├── ~/project-b    (/b)
                            ├── ~/project-c    (/c)
                            └── ...            (可配置)
```

**使用方式**：
| 命令 | 效果 |
|------|------|
| `/a 升级首页` | 路由到 project-a |
| `/b 查用户数` | 路由到 project-b |
| `/c 发日报` | 路由到 project-c |
| `/status` | 查看所有 Session 状态 |
| `/stop b` | 停止 project-b Session |
| `继续` | 发到上次活跃的 Session |

**技术方案**：
- Router 常驻进程（Bun），管理微信连接 + 子进程池
- 每个项目用 `claude -p --input-format stream-json` 启动
- 按需启动：首次收到消息时 spawn，空闲 30 分钟回收
- `--session-id` 实现上下文恢复

### 模块 2：消息持久化（P0）

**目标**：Session 断开不丢消息，重启后自动恢复

```
消息 → SQLite 本地存储 → 未处理队列
                          ↓
                     Session 启动时自动消费
```

**数据结构**：
```sql
messages (
  id INTEGER PRIMARY KEY,
  sender_id TEXT,
  project TEXT,        -- 路由目标
  content TEXT,        -- 消息内容
  response TEXT,       -- Claude 回复
  status TEXT,         -- pending/processing/done/failed
  created_at DATETIME,
  completed_at DATETIME
)
```

### 模块 3：富媒体支持（P1）

**目标**：支持图片发送/接收、文件分享、链接卡片

| 类型 | 接收 | 发送 | 说明 |
|------|------|------|------|
| 文字 | ✅ 已支持 | ✅ 已支持 | - |
| 语音 | ✅ 已支持 | ❌ | 语音转文字后处理 |
| 图片 | ❌ → ✅ | ❌ → ✅ | 接收：下载→OSS→URL给Claude；发送：OSS URL→ilink |
| 文件 | ❌ → ✅ | ❌ | 接收后上传 OSS |
| 链接卡片 | ❌ | ❌ → ✅ | 发送项目链接、部署结果等 |

**图片处理流程**：
```
用户发图片 → ilink 返回 image_item.url
  → 下载到本地 → 上传 OSS → 获得 CDN URL
  → 传给 Claude："用户发了一张图片: https://your-cdn.com/xxx.png"
```

### 模块 4：智能指令系统（P1）

**目标**：预设高频操作，一句话触发复杂流程

| 指令 | 效果 |
|------|------|
| `/deploy a` | 部署 project-a 到 Vercel |
| `/deploy b` | 部署 project-b 到 Vercel |
| `/build a` | 构建 project-a 并报告结果 |
| `/git a` | 查看 project-a 最近 5 条 commit |
| `/video 主题` | 用 Remotion 生成视频 |
| `/news` | 抓取 AI 资讯生成日报 |
| `/stats` | 各项目线上状态汇总 |
| `/help` | 显示所有可用指令 |

**实现**：Router 拦截特定前缀，转换为完整 prompt 后注入对应 Session。

### 模块 5：定时任务（P2）

**目标**：自动化日常运维

```
cron-like 定时器 → 触发指令 → Session 执行 → 结果推送微信
```

| 任务 | 频率 | 内容 |
|------|------|------|
| 每日站报 | 每天 9:00 | 各项目 git log + 线上状态 |
| AI 日报 | 每天 18:00 | 抓取 Twitter AI 资讯 |
| 健康检查 | 每小时 | curl 各站点，异常报警 |
| 数据库备份 | 每天 3:00 | Supabase pg_dump |

### 模块 6：Web Dashboard（P2）

**目标**：可视化管理界面

```
http://localhost:8080
├── Session 状态面板（各项目运行状态、内存占用）
├── 消息历史（搜索、筛选、重发）
├── 项目配置（路由前缀、工作目录、启动参数）
├── 定时任务管理
└── 日志查看
```

可嵌入现有管理后台。

---

## 四、项目重构

### 新目录结构

```
claude-code-wechat-channel/
├── src/
│   ├── router.ts              # 消息路由器（核心）
│   ├── ilink.ts               # ilink API 通信层
│   ├── session-manager.ts     # Claude 子进程管理
│   ├── message-store.ts       # SQLite 消息持久化
│   ├── media.ts               # 图片/文件处理 + OSS
│   ├── commands.ts            # 智能指令系统
│   ├── scheduler.ts           # 定时任务
│   ├── dashboard.ts           # Web Dashboard（Hono）
│   └── config.ts              # 项目路由配置
├── wechat-channel.ts          # 保留：单 Session 版（向后兼容）
├── wechat-router.ts           # 新入口：多 Session 路由版
├── setup.ts                   # 扫码登录（不变）
├── data/
│   └── messages.db            # SQLite 消息存储
├── .env                       # 配置（GITHUB_TOKEN、OSS keys）
├── config.json                # 项目路由配置
├── package.json
└── README.md
```

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
  "sessionTimeout": 1800,
  "dashboard": {
    "port": 8080,
    "enabled": true
  }
}
```

---

## 五、实施路线

### Phase 1（1-2 天）— MVP 路由
- [ ] 从 wechat-channel.ts 提取 ilink.ts 通信层
- [ ] 实现 router.ts 消息前缀路由
- [ ] 实现 session-manager.ts（claude -p 子进程管理）
- [ ] 实现 config.json 配置加载
- [ ] 端到端测试：微信发 /w xxx 路由到对应项目

### Phase 2（1 天）— 持久化 + 稳定性
- [ ] SQLite 消息存储
- [ ] 未处理消息队列 + 自动消费
- [ ] Session 自动重启
- [ ] 错误处理 + 超时兜底
- [ ] 进程保活（pm2 或自建 watchdog）

### Phase 3（1 天）— 智能指令
- [ ] /deploy /build /git /status /help 等快捷指令
- [ ] 指令扩展机制（config.json 可配置）
- [ ] 回复格式优化（纯文本，适配微信）

### Phase 4（后续）— 增强
- [ ] 图片收发 + OSS 集成
- [ ] 定时任务
- [ ] Web Dashboard
- [ ] 多用户支持（区分不同微信发送者）

---

## 六、风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| claude -p stream-json 输出格式不稳定 | 中 | 无法解析响应 | Phase 1 先用文本模式 |
| 多进程内存压力 | 低 | 服务器负载 | 按需启动 + 空闲回收 |
| ilink token 过期 | 中 | 微信断连 | 自动检测 + 提醒重新扫码 |
| Claude API 限流 | 低 | 请求被拒 | 队列串行 + 重试 |

---

## 七、启动方式

升级后的启动命令：

```bash
# 单 Session 模式（向后兼容）
claude --dangerously-load-development-channels server:wechat

# 多 Session 路由模式（新）
cd ~/claude-code-wechat-channel
bun wechat-router.ts

# 后台常驻
nohup bun wechat-router.ts > router.log 2>&1 &
```

---

文档作者：Claude Code (Team Lead)
日期：2026-03-22
状态：待 Review
