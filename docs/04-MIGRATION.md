# 迁移与切换方案（直接切换）

> 决策：**v1 与 v2 不并存**，一次性切换，但记忆与配置必须先迁移。
> 状态：**设计阶段，待确认**

---

## 1. 为什么不并存

| 原因 | 说明 |
|---|---|
| **SnowLuma 单客户端** | 同一个 QQ 号不能稳定地被两个客户端同时连接，双连会互相踢下线、消息重复 |
| **状态双写复杂** | 两套记忆/会话同时演化，合并逻辑比重写还难 |
| **收益低** | v2 的核心逻辑（唤醒/分条/权限）可以单测覆盖，不需要靠影子流量验证 |

不并存的代价是"切换窗口有风险"，所以下面把风险逐条列清、逐条给缓解。

---

## 2. 切换前的数据盘点

| v1 数据 | 内容 | 去向 |
|---|---|---|
| `state/sessions.json` | 会话 key → agent session 映射 | v2 `sessions` 表（重建） |
| `state/social-v2.json` | 每会话：记忆、wakeConfig、计数、agentToken | 记忆 → mnema；wakeConfig → v2；其余丢弃 |
| `state/shared-memory.json` | 主人写的共享记忆（2 条） | mnema（shared 敏感度） |
| `state/stickers.json` | 收藏表情（6 条） | v2 表情表 |
| `state/slang.json` | 黑话库 | v2 黑话表 |
| `state/feedback.json` | AI 自己的反馈记录 | 可丢弃 |
| `state/token-usage.jsonl` / `tool-calls.jsonl` | 用量与调用日志 | **仅归档**，不迁移 |
| `role.md` / 角色卡 | 性格与设定 | mnema `persona` |
| `dsh/agent-presets/qq-chat-v2/*` | 提示词补丁 | v2 `prompt/` 模块（重写，不导入） |

### 2.1 记忆的字段级映射（关键）

v1 的每会话记忆有三个类别，映射规则如下：

| v1 | 结构 | 迁移到 mnema | 规则 |
|---|---|---|---|
| `memberImpressions` | `{ 名字: { … } }` | **fact** | `contentClass: preference`，`sensitivity: contact`，`participants: [user:<名字映射>]` |
| `activeTopics` | `[{ text, lastMentionAt, participants, pendingQuestion }]` | **event** | `contentClass: event`，`at: lastMentionAt`，`gist: text` |
| `pendingThoughts` | `[{ text, expiresAt }]` | **丢弃** | 2 小时过期，迁移价值低 |
| `shared-memory.json` | `{ notes: [{ category, content, at }] }` | **fact（shared）** | `sensitivity: shared`，`participants: []` |

**注意**：v1 的"名字"是昵称/群名片，mnema 需要稳定的 `contactId`。
迁移脚本要维护一张映射表（名字 → QQ 号），从 v1 的 `recentMessages[].senderId` 里反查。

### 2.2 关系度的迁移

v2 的关系度由 mnema 的 `interactions` 表推导。v1 没有独立的交互计数（只有 `recentMessages` 窗口），所以：

**方案**：用 v1 `recentMessages`（每个会话最近 N 条）回填 `interactions`，
按 `senderId` + `at` 写入，让 mnema 重算一次关系度。

- 优点：不用编造数据，关系度从"实际聊过多少"自然长出来
- 局限：只覆盖最近窗口，老关系会偏冷 → 可接受（人类也会淡忘）

### 2.3 迁移需要 mnema 的一个小改动

`/v1/events` 目前由编码器决定 `sensitivity` / `subject` / `contentClass`。
导入时这些必须显式指定，否则语义会变。

**建议**：给 mnema 加 `/v1/import`（或允许 `/v1/events` 带显式字段，需 token 鉴权），
批量写入 `{ text, contentClass, sensitivity, subject, participants, at }`，跳过编码与门控。

> 工作量：mnema 侧约 0.5 天（含测试）。这是切换的前置依赖。

---

## 3. 切换步骤（T 为切换时刻）

### T-1 天：准备

```bash
# 1) 全量备份 v1（含 state、config、presets）
robocopy D:\Software\QQBot\qq-bridge D:\Backup\qq-bridge-<date> /MIR

# 2) 导出记忆（脚本读 social-v2.json / shared-memory.json）
node tools/export-v1-memory.mjs --v1 D:/Software/QQBot/qq-bridge --out ./migration/

# 3) 干跑迁移（导入 mnema 测试库，检查条数与内容）
node src/cli.js import --from ./migration --dry-run
```

### T-0（建议凌晨 03:00–04:00 低峰）

```
1) 停 v1（确认进程退出、端口释放、SnowLuma 显示离线）
2) 起 mnema（含 import 后的数据）
3) 起 v2（--port 新端口，config 指向 mnema）
4) 补拉历史：v2 启动时对活跃会话调用 get_recent_messages，回填 messages 表（幂等）
5) 冒烟：
   - owner 私聊发一句 → 收到回复
   - 群聊 @ 一次 → 收到回复
   - 控制台打开 → 能看到会话与记忆
   - /health → WS 已连接、记忆可用
```

### T+30 分钟：观察清单

| 检查项 | 期望 |
|---|---|
| 消息延迟 | 收到 → 回复 ≤ 2s（不含生成） |
| 记忆命中 | 问"我之前说过什么"能答上来 |
| 无人时安静 | 不主动刷屏 |
| 日志无异常 | 无 5xx、无重复发送 |
| 限流生效 | 同一会话每分钟 ≤10 条 |

### T+24 小时：验收

- 巩固任务在 03:30 跑过，叙事已更新
- 关系度与迁移前大致相当（±0.15）
- 无重复回复、无丢消息

---

## 4. 风险清单与缓解

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| **R1** | 切换窗口（停 v1 → 起 v2）内的消息丢失 | 用户觉得"没理我" | ① 选低峰；② v2 启动后补拉历史（`get_recent_messages`）；③ 幂等表防重复处理 |
| **R2** | 记忆语义损失（topic 变 event、印象变 fact） | "它好像不记得我们聊过X" | ① 映射规则固定并留档；② 迁移后抽查 10 条；③ 保留 v1 数据 7 天，可二次导入 |
| **R3** | 工具未对齐（某工具 P2 还没实现） | 特定功能暂时不可用 | 分档实现（P0 必须先完成）；上线前跑"工具清单核对表" |
| **R4** | 发送节奏变化触发风控 | 被限流/禁言 | 沿用 v1 的限流参数（10/min、间隔 600–1800ms），不做激进优化 |
| **R5** | 关系度重置导致"对谁都很客气" | 人格断层 | 用 `recentMessages` 回填 `interactions`；owner 可手动调整（控制台） |
| **R6** | 记忆服务不可用 | 回复变"失忆" | 800ms 超时 + 熔断 + 降级文案；`/health` 显式暴露状态 |
| **R7** | 回滚困难 | 事故无法恢复 | v1 目录与配置原样保留；回滚 = 停 v2 + 起 v1（5 分钟） |
| **R8** | 黑话库/表情库格式不兼容 | 丢数据 | 迁移前先转成 v2 格式并校验条数 |
| **R9** | 单实例锁与新端口冲突 | 启动失败 | 显式配置端口；启动前检查占用 |

**最坏情况**：切换后 30 分钟内发现严重问题 → 停 v2、起 v1、恢复端口。
因为 v1 数据只在切换前被"读"，没有被"改"，回滚是无损的。

---

## 5. 回滚步骤

```bash
# 1) 停 v2
# 2) 恢复 v1 配置（如果切换时改过）
copy D:\Backup\qq-bridge-<date>\config.json D:\Software\QQBot\qq-bridge\config.json
# 3) 起 v1
# 4) 检查 SnowLuma 连接与冒烟
```

**回滚后**：v2 写入 mnema 的记忆不会自动消失（它是独立库），
下次再切可以继续用——这也是一种好处：**记忆不再绑死在桥接上**。

---

## 6. 记忆"延续性"的保证

切换后最容易出问题的不是代码，是**人格断层**。三层保证：

| 层 | 手段 |
|---|---|
| **性格** | `role.md` → mnema `persona`（原样搬运，一字不改） |
| **关系** | `recentMessages` 回填 `interactions` → 重算关系度 |
| **具体记忆** | `activeTopics` / `memberImpressions` / `shared` → 逐条导入并抽查 |

**验收标准**：切换后问它三个问题，答案应与 v1 时基本一致：

1. "我们之前聊过什么？"
2. "你还记得 X 吗？"（X 是 v1 里的一个印象）
3. "你现在在忙什么？"（叙事）

---

## 7. 待确认

1. 切换窗口定在哪个时间？（建议凌晨 3 点，与巩固任务错开）
2. 是否接受"关系度部分重置"（用最近消息回填）？
3. mnema 的 `/v1/import` 是否一并做（需要 0.5 天）？
