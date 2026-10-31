# 详细设计

> 项目：qqbridge-v2
> 状态：**设计阶段，待确认**

---

## 1. 目录结构

```
qqbridge-v2/
├── src/
│   ├── index.js                 进程入口（装配 + 启动）
│   ├── config.js                配置加载与校验
│   ├── transport/
│   │   ├── snowluma.js          基于 @snowluma/sdk 的连接与事件订阅（重连/背压）
│   │   └── decode.js            原始事件 → NormalizedMessage
│   ├── router/
│   │   ├── router.js            分发 + 幂等
│   │   ├── dedupe.js            幂等表
│   │   └── session.js           会话键归一化、参与者提取
│   ├── wake/
│   │   ├── policy.js            触发条件判定（纯函数）
│   │   ├── batcher.js           批量窗口
│   │   └── state.js             潜水/活跃/观察期状态机
│   ├── orchestrator/
│   │   ├── run.js               一轮对话编排
│   │   ├── prompt.js            提示词组装（纯函数，可单测）
│   │   └── splitter.js          文本分条（纯函数）
│   ├── speech/
│   │   ├── index.js        SpeechPort 工厂（按配置选 provider）
│   │   ├── sensevoice.js   本地 sherpa-onnx 实现（默认）
│   │   ├── whisper.js      faster-whisper / whisper.cpp
│   │   └── http.js         OpenAI 兼容转写接口
│   ├── memory/
│   │   ├── client.js            mnema HTTP 客户端（超时/熔断/降级）
│   │   └── defaults.js          无记忆时的兜底文本
│   ├── agent/
│   │   ├── dsh.js               AgentPort 的 DSH 实现
│   │   └── fake.js              测试用假宿主
│   ├── tools/
│   │   ├── registry.js          注册 + 按会话过滤
│   │   ├── qq.js                QQ 工具
│   │   ├── memory.js            记忆工具（转 mnema）
│   │   ├── phone.js             手机工具（owner）
│   │   ├── qzone.js             空间工具
│   │   └── web.js               联网搜索
│   ├── storage/
│   │   ├── db.js                打开 + 迁移
│   │   └── queries.js           所有 SQL
│   ├── console/
│   │   ├── server.js            本地 HTTP
│   │   └── page.js              单页 HTML
│   ├── scheduler/
│   │   ├── scheduler.js         定时任务框架
│   │   └── jobs.js              巩固 / 说说 / 清理
│   ├── security/
│   │   ├── policy.js            权限判定（纯函数）
│   │   └── sensitive.js         出站敏感词
│   └── util/
│       ├── logger.js            结构化日志
│       ├── lock.js              单实例锁
│       └── text.js              文本工具
├── test/                        单测（node:test）
├── docs/                        （本目录）
├── state/                       运行时数据（gitignore）
├── config.json
└── package.json
```

**文件行数上限**：核心模块 ≤ 400 行；超过则拆分。

---

## 2. 配置

```jsonc
{
  "qq": {
    "ownerQQ": 2621072338,
    "selfQQ": 1728667550,
    "snowluma": { "url": "ws://127.0.0.1:3001", "token": "" }
  },
  "allow": {
    "private": [197196327],
    "groups": [],
    "emptyGroupsMeansAll": true
  },
  "memory": {
    "baseUrl": "http://127.0.0.1:8321",
    "token": "",
    "tenant": "default",
    "timeoutMs": 800,
    "enabled": true
  },
  "speech": {`r`n    "provider": "sensevoice",          // sensevoice | whisper | http | none`r`n    "sensevoice": { "model": "models/sherpa-onnx-sense-voice-*-int8", "threads": 2 },`r`n    "http": { "url": "", "apiKey": "", "model": "whisper-1" }`r`n  },`r`n  "agent": {
    "kind": "dsh",
    "baseUrl": "http://127.0.0.1:xxxx",
    "preset": "qq-chat-v2",
    "sessionCwd": "D:/Software/QQBot/qq-bridge-v2/sessions"
  },
  "wake": {
    "batchWindowMs": 1500,
    "sleepObservationMs": 300000,
    "triggers": { "at": true, "name": true, "question": true, "probability": 0.15 }
  },
  "send": {
    "minGapMs": 600,
    "maxGapMs": 1800,
    "maxPerMinute": 10,
    "splitThreshold": 60
  },
  "console": { "port": 3100, "token": "" },
  "security": { "sensitivePatterns": ["sk-", "token", "密码"] }
}
```

**校验规则**（`config.js` 手写，不引依赖）：

- `ownerQQ`/`selfQQ` 必须是正整数
- `allow.groups` 为空时必须有 `emptyGroupsMeansAll` 显式声明
- `memory.baseUrl` 必须能被 URL 解析
- 未知字段报警告（不报错，便于灰度）

---

## 3. 数据库

### 3.1 表结构

```sql
-- 消息归档
CREATE TABLE messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  msg_id        TEXT NOT NULL,              -- OneBot message_id
  session_key   TEXT NOT NULL,              -- private:123 / group:456
  direction     TEXT NOT NULL,              -- inbound | outbound
  sender_id     TEXT NOT NULL,
  sender_name   TEXT,
  text          TEXT,
  has_media     INTEGER NOT NULL DEFAULT 0,
  raw           TEXT,                       -- 原始事件 JSON（截断）
  at            TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  UNIQUE(session_key, msg_id)
);
CREATE INDEX idx_messages_session_at ON messages(session_key, at DESC);

-- 会话
CREATE TABLE sessions (
  session_key   TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,              -- direct | public
  participants  TEXT NOT NULL,              -- JSON
  agent_token   TEXT,
  agent_session TEXT,
  wake_state    TEXT NOT NULL DEFAULT '{}',  -- JSON: mode/until/lastRun
  last_event_at TEXT,
  created_at    TEXT NOT NULL
);

-- 幂等
CREATE TABLE dedupe (
  key        TEXT PRIMARY KEY,
  seen_at    TEXT NOT NULL
);

-- 限流
CREATE TABLE rate_limits (
  action     TEXT NOT NULL,
  target     TEXT NOT NULL,
  window     TEXT NOT NULL,                 -- minute | day
  bucket     TEXT NOT NULL,                 -- 窗口起始
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(action, target, window, bucket)
);

-- 杂项
CREATE TABLE kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

**迁移**：`PRAGMA user_version`，只前进。

### 3.2 数据保留

| 表 | 保留 | 清理 |
|---|---|---|
| messages | 90 天 | 每日清理任务 |
| dedupe | 7 天 | 同上 |
| rate_limits | 2 天 | 同上 |

---

## 4. 关键流程

### 4.1 入站处理

```js
// transport → router
async function onMessage(raw) {
  const msg = decode(raw);                       // 纯函数
  if (!sessionAllowed(msg.sessionKey)) return;   // ① 会话准入

  const inserted = storage.insertMessage(msg);   // UNIQUE 冲突 → 重复
  if (!inserted) return;                          // ② 幂等

  wake.onMessage(msg);                            // ③ 唤醒判断
}
```

### 4.2 唤醒判定（纯函数，可单测）

```js
// wake/policy.js
export function shouldWake({ msg, session, config, now }) {
  const st = JSON.parse(session.wake_state || '{}');
  if (st.mode === 'diving' && now < (st.until ?? 0)) {
    return matchTrigger(msg, st.triggers ?? config.wake.triggers);  // 只按触发条件
  }
  return true;  // 活跃模式：任何消息都唤醒
}
```

### 4.3 一轮对话

```js
async function run(sessionKey) {
  const session = storage.getSession(sessionKey);
  const recent = storage.recentMessages(sessionKey, 20);

  // ① 记忆（失败不影响对话）
  const memory = await memoryPort.recall({
    channelId: sessionKey,
    participants: session.participants,
    query: recent.at(-1)?.text ?? '',
  }).catch(() => null);

  // ② 提示词
  const prompt = buildPrompt({ session, recent, memory, config });

  // ③ 调 agent
  const chunks = [];
  for await (const ev of agent.send(session.agentSession, prompt)) {
    if (ev.type === 'text') chunks.push(ev.text);
  }

  // ④ 分条 + 发送
  const parts = split(chunks.join(''), { threshold: config.send.splitThreshold });
  for (const part of parts) {
    await qq.sendText(sessionKey, part, {});
    await sleep(randomBetween(config.send.minGapMs, config.send.maxGapMs));
  }

  // ⑤ 记忆写入（异步，不阻塞）
  memoryPort.ingest({
    channel: { id: sessionKey, kind: session.kind, participants: session.participants },
    events: recent.map((m) => ({ role: m.direction === 'inbound' ? 'user' : 'assistant', text: m.text, at: m.at })),
  }).catch(logWarn);
}
```

### 4.4 提示词组装（纯函数）

```js
export function buildPrompt({ session, recent, memory, config }) {
  const parts = [];
  if (memory?.persona) parts.push(`【你的性格】\n${memory.persona}`);
  if (memory?.narrative) parts.push(`【你最近的状况】\n${memory.narrative}`);
  if (memory?.rendered) parts.push(memory.rendered);

  parts.push('【本轮对话】');
  for (const m of recent) {
    parts.push(`${m.direction === 'inbound' ? m.sender_name ?? '对方' : '你'}：${m.text}`);
  }

  parts.push('【怎么回】');
  parts.push('- 分条说，一条一个意群，多数不超过 30 字');
  parts.push('- 不要客服腔，可以简短、可以拒绝');
  parts.push(`- 对方 ${session.kind === 'public' ? '在群里' : '在私聊'}`);
  return parts.join('\n\n');
}
```

**测试点**：给定固定输入，输出必须稳定（快照测试）。

---

## 5. 权限实现

```js
// security/policy.js —— 纯函数
export function sessionAllowed(key, cfg) {
  const [kind, id] = key.split(':');
  if (kind === 'private') return cfg.allow.private.map(String).includes(id);
  if (kind === 'group') return cfg.allow.groups.length === 0
    ? cfg.allow.emptyGroupsMeansAll
    : cfg.allow.groups.map(String).includes(id);
  return false;
}

export function toolScopeFor(key, cfg) {
  const [kind, id] = key.split(':');
  if (kind === 'private' && String(id) === String(cfg.qq.ownerQQ)) return 'owner';
  if (kind === 'private') return 'allowlist';
  return 'group';
}

export function toolAllowed(tool, scope) {
  return tool.scope === 'all' || tool.scope === scope
      || (scope === 'owner');
}
```

**调用时二次校验**：工具 handler 收到的 `key` 必须与会话一致，防止模型伪造；
`phone.*`、`qzone.post`、`relay` 校验 `key === private:<ownerQQ>`。

---

## 6. 记忆适配

```js
// memory/client.js
export class MemoryClient {
  constructor({ baseUrl, token, tenant, timeoutMs }) { ... }

  async recall(args) {
    const res = await this.#post('/v1/recall', args);
    return res;  // { rendered, items }
  }

  async ingest({ channel, events }) {
    return this.#post('/v1/events', { channel, events });
  }

  #post(path, body) {
    // AbortController + timeoutMs；失败 → 记 metric，返回 null（不抛）
  }
}
```

**熔断**：连续 3 次失败 → 60 秒内直接返回 null（不再打网络），之后半开重试。

**映射**：

| 桥接概念 | mnema |
|---|---|
| `private:123` | channel `{ id: 'chat:user:123', kind: 'direct', participants: ['self','user:123'] }` |
| `group:456` | channel `{ id: 'chat:group:456', kind: 'public', participants: ['self','group:456'] }` |
| 一轮对话 | `events: [{role:'user'|'assistant', text, at}]` |
| 性格 | persona（owner 可写） |
| 叙事 | narrative（只读注入） |

---

## 7. 限流

```js
// 统一入口
async function consume(action, target, { perMinute, perDay }) {
  const now = new Date();
  const bucketMin = now.toISOString().slice(0, 16);
  const bucketDay = now.toISOString().slice(0, 10);
  // 事务内：读取 + 递增 + 判断
}
```

| action | 目标 | 限制 |
|---|---|---|
| `send` | session | 10/min |
| `comment` | contact | 5/day，全局 30/day |
| `like` | contact | 5/day |
| `post` | — | 3/day |
| `relay` | contact | 3/day，间隔 ≥60s |

---

## 8. 异常处理

| 场景 | 行为 |
|---|---|
| WS 断开 | 指数退避重连（1s→2s→4s…上限 30s），期间消息进队列 |
| DSH 超时（120s） | 中断会话，回一句"我卡住了"，记错误 |
| mnema 超时/失败 | 走降级（无记忆），记 metric |
| 发送失败 | 重试 2 次（间隔 1s/3s），仍失败记 dead-letter 表 |
| 单实例冲突 | 退出码 1，日志提示已有实例 |
| 配置非法 | 启动失败，打印具体字段 |

---

## 9. 测试策略

| 层 | 方式 | 重点 |
|---|---|---|
| `wake/policy` | 纯函数单测 | 触发组合、潜水/活跃、时间边界 |
| `orchestrator/prompt` | 快照测试 | 记忆缺失/完整两种形态 |
| `orchestrator/splitter` | 单测 | 长句切分、不切碎引用 |
| `security/policy` | 单测 | 三级权限矩阵 |
| `memory/client` | 假 HTTP | 超时、熔断、降级 |
| `storage` | 内存 SQLite | 迁移、幂等、限流窗口 |
| 端到端 | 假 SnowLuma + 假 DSH | 收消息 → 回复 → 写记忆 |

**目标**：核心模块覆盖 ≥ 70%；每次发版前跑全量。

---

## 10. 迁移步骤

1. **导出**（v1 侧脚本）：`sessions.json`、`social-v2.json` 里的关系/记忆 → JSON
2. **导入**（v2 侧命令）：`npm run migrate -- --from <dir>`
   - 会话 → `sessions` 表
   - 关系/记忆 → mnema（`/v1/events` + `/v1/relationships` 批量导入）
   - 表情/黑话 → v2 对应表
3. **影子模式**：v2 只读消息、不发送（`config.dryRun = true`），对比日志
4. **灰度**：仅 owner 私聊走 v2
5. **切换**：停 v1，v2 接全量
6. **回滚**：v1 目录保留，改回端口即可

---

## 11. 语音识别（SpeechPort）

`js
// speech/index.js
export function createSpeech(config) {
  switch (config.provider) {
    case 'none': return { transcribe: async () => null };
    case 'whisper': return createWhisper(config.whisper);
    case 'http': return createHttp(config.http);
    case 'sensevoice':
    default: return createSenseVoice(config.sensevoice);
  }
}
`

**默认 provider 为 sensevoice**（本地 sherpa-onnx + SenseVoice int8，离线、中文强、约 200MB）。
想换更准的：aster-whisper（CPU 上慢 3~5 倍）；不想本地跑：http 指向任意 OpenAI 兼容接口。

**约定**：

- 输入统一转 16k 单声道 wav（fmpeg 转换，失败则跳过）
- 输出 { text, confidence } 或 
ull（跳过）
- 超时 20s，失败不影响文字消息处理
- 识别结果标记为 [语音] 转写：… 拼进提示词，保留原始 ecord 段

**可扩展**：新增 provider 只需实现 	ranscribe() 并在工厂里加一个 case。

## 12. 待确认（与需求文档合并）

见 [01-REQUIREMENTS.md](01-REQUIREMENTS.md) 第 9 节，以及 [02-ARCHITECTURE.md](02-ARCHITECTURE.md) 第 10 节。
