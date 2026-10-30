# 架构设计

> 项目：qqbridge-v2（qq-bridge 重写）
> 状态：**设计阶段，待确认**

---

## 1. 总体思路

一句话：**把 1.2 万行的"上帝对象"拆成 6 个边界清晰的层，把记忆踢出去，把状态收进 SQLite。**

```
┌──────────────────────────────────────────────────────────────┐
│  宿主：DSH（agent loop / 模型 / 工具注册 / 会话管理）           │
└───────────────▲──────────────────────────────┬───────────────┘
                │ AgentPort（session.send / events）│
┌───────────────┴──────────────────────────────▼───────────────┐
│                    qqbridge-v2（本项目）                       │
│                                                              │
│  ┌────────────┐  ┌────────────┐  ┌──────────────────────┐   │
│  │ transport  │→ │   router   │→ │      wake policy     │   │
│  │ (SnowLuma) │← │ (会话/幂等) │← │ (何时醒、醒多久、批量) │   │
│  └────────────┘  └─────┬──────┘  └──────────────────────┘   │
│                        │                                     │
│  ┌─────────────────────▼──────────────────────────────────┐ │
│  │              orchestrator（一轮对话的编排）               │ │
│  │  检索记忆 → 拼提示词 → 调 AgentPort → 收结果 → 分条     │ │
│  └───────┬─────────────────────────┬──────────────────────┘ │
│          │                         │                         │
│  ┌───────▼────────┐        ┌───────▼────────┐               │
│  │  memory port   │        │  tool registry │               │
│  │  (mnema HTTP)  │        │ (权限 + 作用域) │               │
│  └───────┬────────┘        └───────┬────────┘               │
│          │                         │                         │
│  ┌───────▼────────┐        ┌───────▼────────┐               │
│  │  storage (SQLite)│      │ scheduler（定时）│               │
│  └────────────────┘        └────────────────┘               │
│                                                              │
│  ┌──────────────────────────────────────────────────────────┐│
│  │ console（HTTP）：状态 / 会话 / 记忆 / 关系 / 性格          ││
│  └──────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────┘
                │ HTTP / MCP
        ┌───────▼────────┐
        │      mnema      │  记忆引擎（独立进程/库）
        └────────────────┘
```

---

## 2. 分层与职责

| 层 | 目录 | 职责 | 不该做的事 |
|---|---|---|---|
| **transport** | `src/transport/` | 与 SnowLuma 的 WS 连接、事件解码、发送请求 | 不含业务逻辑、不判断权限 |
| **router** | `src/router/` | 把原始事件归并到会话、去重、幂等、路由到处理器 | 不做唤醒决策 |
| **wake** | `src/wake/` | 唤醒策略：触发条件、批量窗口、潜水/活跃、观察期 | 不发消息 |
| **orchestrator** | `src/orchestrator/` | 一轮对话：取记忆 → 拼提示词 → 调 agent → 收结果 → 分条发送 | 不含协议细节 |
| **memory** | `src/memory/` | mnema 适配：写入/检索/性格/叙事/巩固；超时与降级 | 不存记忆本体 |
| **tools** | `src/tools/` | MCP 工具注册、权限过滤、作用域 | 不做会话管理 |
| **storage** | `src/storage/` | SQLite：messages / sessions / rate_limits / dedupe / kv | 不写业务规则 |
| **console** | `src/console/` | 本地 HTTP 管理界面 | 不直接改内存状态 |
| **scheduler** | `src/scheduler/` | 定时任务（巩固、说说、清理） | 不做即时消息处理 |

---

## 3. 关键接口（端口 / 适配器）

### 3.1 AgentPort —— 与 DSH 的边界

```js
interface AgentPort {
  ensureSession(sessionKey, { preset, cwd, title }): Promise<SessionId>
  send(sessionId, message): AsyncIterable<AgentEvent>   // 流式
  interrupt(sessionId): Promise<void>
  close(sessionId): Promise<void>
}

AgentEvent = { type: 'text', text } | { type: 'tool', name, args } | { type: 'done' } | { type: 'error', error }
```

**为什么要这个端口**：v1 里 DSH 调用散落在 `bridge.js` 各处；抽出来之后，换宿主（或测试时用假宿主）只改一个实现。

### 3.2 MemoryPort —— 与 mnema 的边界

```js
interface MemoryPort {
  ingest({ channel, events }): Promise<{ encoded, skipped }>
  recall({ channelId, participants, query }): Promise<{ rendered, items }>
  persona(tenant): Promise<Persona>
  setPersona(tenant, markdown, traits): Promise<Persona>
  narrative(tenant): Promise<Narrative>
  consolidate(tenant): Promise<Stats>
  feedback({ op, memoryId, text }): Promise<Result>
}
```

**降级语义**：所有方法超时（默认 800ms）返回 null，编排层按"没有记忆"继续，**不阻塞回复**。

### 3.3 QqPort —— 与 OneBot 的边界

```js
interface QqPort {
  sendText(target, text, { replyTo, at }): Promise<MsgId>
  sendImage(target, url, opts): Promise<MsgId>
  sendSticker(target, id, opts): Promise<MsgId>
  history(target, { limit, offset }): Promise<Message[]>
  markRead(sessionKey, throughSeq): Promise<void>
}
```

---

## 4. 数据流

### 4.1 入站：从消息到唤醒

```
SnowLuma WS
   │  OneBot event (post_type=message)
   ▼
transport.decode → NormalizedMessage { key, kind, senderId, text, media, at, msgId }
   ▼
router.dedupe(msgId)  ── 重复 → 丢弃
   ▼
router.persist(message)      // SQLite messages
   ▼
wake.onMessage(msg)
   ├─ 更新会话活跃时间
   ├─ 判断是否命中触发条件（@ / 名字 / 关键词 / 提问 / 概率 / 任意）
   └─ 命中 → 进入批量窗口（默认 1.5s），窗口结束触发一次唤醒
```

### 4.2 唤醒：一轮对话

```
wake.flush(sessionKey)
   ▼
orchestrator.run(sessionKey)
   1. memory.recall({ channelId, participants, query: 最近消息 })
   2. prompt = persona + narrative + rendered + 本轮消息 + 规则
   3. agent.send(sessionId, prompt)   → 流式事件
   4. 收集文本块 → 分条（splitter）
   5. 逐条 sendText（间隔 600~1800ms，随机）
   6. 结束后 memory.ingest(本轮对话)
   7. 更新 wake 状态（下次可睡时间）
```

### 4.3 巩固

```
scheduler @03:30
   ▼
memory.consolidate()  → mnema 内部：聚类/抽象/合并/衰减/叙事
   ▼
留痕：日志 + 控制台展示（事实数、合并数、叙事更新时间）
```

---

## 5. 状态与存储

### 5.1 为什么用 SQLite

| 维度 | JSON 文件（v1） | SQLite（v2） |
|---|---|---|
| 并发写 | 有丢失风险 | 事务安全 |
| 查询 | 全量加载 | 索引 |
| 迁移 | 手写 if-else | `user_version` + 迁移脚本 |
| 体积 | 155 KB 且增长 | 可控 + 可清理 |
| 可观测 | 打开文件看 | SQL 查询 |

### 5.2 表设计（概览，详见详细设计）

```
messages     消息归档（幂等键、方向、媒体标记）
sessions     会话元数据（key、kind、participants、last_event_at、wake 状态）
dedupe       幂等键（msgId → 首次处理时间）
rate_limits  限流计数（按 action + target + 窗口）
kv           杂项（锁、令牌、上次巩固时间、版本）
```

**记忆不在这里**——`mnema` 负责。桥接只存"为了收发和运维必须留的东西"。

---

## 6. 权限模型

三层判定，从粗到细：

```
① 会话准入：这个 key 允许被处理吗？
     private:<qq>  ∈ allow.private ?
     group:<gid>   ∈ allow.groups ? （空列表策略由配置决定）

② 工具准入：这次调用允许哪些工具？
     owner      → 全部
     allow.private → 聊天 + 空间社交（只读/互动，不含手机控制）
     group      → 聊天 + 搜索

③ 动作准入：这个具体动作允许吗？
     传话/发说说/手机控制 → 仅 owner
     跨会话读 → 禁止（除非合并进 mnema 的披露层）
```

**实现方式**：`tools/registry.js` 在注册时标注 `scope: 'owner' | 'allowlist' | 'group' | 'all'`，
按会话生成工具集；调用时二次校验（防止模型伪造 key）。

---

## 7. 可靠性与可观测

| 机制 | 做法 |
|---|---|
| **单实例** | `state/bridge.lock`（PID + 启动时间），冲突则优雅退出 |
| **看门狗** | 父进程监控；崩溃指数退避重启（2s→4s→8s，上限 2min） |
| **发送串行** | 每个会话一条 `sendChain`，保证顺序 |
| **超时** | 所有外部调用有超时（agent 120s / memory 800ms / qq 10s） |
| **健康检查** | `GET /health`：WS 连接、队列深度、最近错误、记忆服务状态 |
| **日志** | JSON Lines，按天轮转，保留 7 天；错误单独 `error.log` |
| **限流** | 发送（每会话 10/min）、评论（5/人/天）、说说（3/天）、传话（3/人/天） |

---

## 8. 部署形态

```
┌──────────────┐    WS     ┌───────────┐
│  SnowLuma    │◄─────────►│ qqbridge  │  Node 进程（单实例）
└──────────────┘           │  (v2)     │
                           └─────┬─────┘
                                 │ HTTP
                           ┌─────▼─────┐    ┌──────────┐
                           │   mnema   │    │   DSH    │（同机，不同进程）
                           └───────────┘    └──────────┘
```

- 三个进程都可以独立重启；
- 桥接对 mnema / DSH 都是**客户端**，任何一方挂掉不影响消息收发（只影响智能回复）；
- 控制台跑在桥接进程内（`127.0.0.1:3100`）。

---

## 9. 与 v1 的关系

| 方面 | v1 | v2 |
|---|---|---|
| 消息收发 | 同 | 保留，抽象成 QqPort |
| 提示词 | 拼在 bridge.js 里 | 独立 `prompt/` 模块 + 可测 |
| 记忆 | 内嵌 JSON | 外置 mnema |
| 状态 | 14 个 JSON | 1 个 SQLite |
| 工具 | 单文件 26 个 | 分域注册（qq / memory / phone / qzone / web） |
| 控制台 | 耦合在 bridge.js | 独立模块 + 静态页 |
| 配置 | JSON + 隐式默认 | JSON + 显式 schema 校验 |

**迁移策略**：v2 用**不同端口与目录**，与 v1 并存；先跑影子模式（只读消息、不发送）验证，再切流量。

---

## 10. 待确认的架构选择

| # | 选择 | 建议 | 备选 |
|---|---|---|---|
| A1 | AI 宿主 | **继续用 DSH** | 自研 agent loop（工作量大 3 倍） |
| A2 | 记忆接入 | **HTTP 直连 mnema** | MCP（多一层进程，延迟高） |
| A3 | 存储 | **SQLite** | 保持 JSON（不推荐） |
| A4 | SnowLuma 连接 | **Node 内置 WebSocket** | `ws` 依赖 |
| A5 | 工具协议 | **MCP（与 v1 一致）** | 直接函数调用（不兼容现有客户端） |
| A6 | 控制台 | **独立轻量页面** | 复用 v1 页面（耦合深） |
