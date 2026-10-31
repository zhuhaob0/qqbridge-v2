# 实现说明（P1–P6）

> 本文记录 qqbridge-v2 已实现的内容、模块边界与验证方式。
> 设计文档见 [01-REQUIREMENTS](01-REQUIREMENTS.md) / [02-ARCHITECTURE](02-ARCHITECTURE.md) / [03-DETAILED-DESIGN](03-DETAILED-DESIGN.md) / [04-MIGRATION](04-MIGRATION.md)。

---

## 1. 模块地图

```
src/
├── index.js              入口：配置 → 日志 → 锁 → 数据库 → 记忆 → agent → 传输 → 控制台 → 定时任务
├── app.js                装配 router + wake + batcher + orchestrator
├── config.js             默认值 + 深合并 + 手写校验
├── transport/
│   ├── normalize.js      OneBot 事件 → 内部消息（纯函数）
│   └── snowluma.js       基于 @snowluma/sdk：收发、图片/语音/表情、成员、转发、历史
├── router/
│   ├── router.js         白名单 → 幂等 → 落库 → 会话 → 回调
│   ├── session.js        key 归一化、参与者、记忆通道
│   └── bus.js            进程内事件总线（wait_for_messages）
├── wake/
│   ├── policy.js         触发条件（纯函数）
│   └── batcher.js        批量窗口
├── orchestrator/
│   ├── run.js            一轮对话：记忆 → 提示词 → agent → 分条 → 限流发送 → 写记忆
│   ├── prompt.js         提示词组装（纯函数）
│   └── splitter.js       分条（纯函数）
├── memory/client.js      mnema HTTP：超时 800ms、熔断、降级
├── agent/
│   ├── port.js           AgentPort 契约
│   ├── dsh.js            DSH 实现（vendor/dsh-client.js）
│   ├── collector.js      turn 收集（忽略 chunk，防翻倍）
│   └── fake.js           测试用
├── tools/
│   ├── registry.js       注册 + 作用域 + 鉴权
│   ├── qq.js             P0 十件套
│   ├── qq-more.js        P1 八件套
│   ├── qq-extra.js       P2 八件套
│   └── mcp.js            stdio MCP（进程内）+ src/mcp/cli.js（跨进程代理）
├── storage/
│   ├── db.js             SQLite v2 迁移
│   └── queries.js        所有 SQL
├── console/              控制台（页面 + /health /stats /sessions /tools/*）
├── speech/index.js       SpeechPort（none / http / sensevoice / whisper）
├── scheduler/scheduler.js 每天定时任务
├── security/policy.js    三层权限（纯函数）
└── migration/v1.js       v1 → v2 迁移
```

---

## 2. 关键流程

### 2.1 收消息

```
SnowLuma → transport.snowluma → router.handle
  ① 会话白名单（private/group）
  ② 幂等（dedupe 表）
  ③ 落库（messages）
  ④ 更新会话（sessions）
  ⑤ 入站 → bus.emitMessage + wake decision
```

### 2.2 唤醒与回复

```
wake.policy（活跃/潜水、@/名字/提问/关键词/概率）
  → batcher（窗口合并）
  → orchestrator.run
      ① memory.recall / persona / narrative（失败降级）
      ② buildPrompt（含【会话标识】key+token）
      ③ agent.send（DSH）
      ④ split（按标点分条）
      ⑤ 限流 consumeRate → qq.sendText → 落库
      ⑥ memory.ingest（异步，不阻塞）
```

### 2.3 工具调用

```
DSH ──MCP(stdio)──► src/mcp/cli.js ──HTTP──► 控制台 /tools/call
                                                  │
                                           tools/registry
                                            ① authenticate（key+token）
                                            ② 作用域校验
                                            ③ run
```

**为什么绕一圈**：工具要发消息，必须用唯一的 SnowLuma 连接，只能在桥接进程里执行。

### 2.4 迁移

```
tools/migrate-v1.mjs
  ① sessions.json → sessions 表
  ② social-v2.json.recentMessages → messages + interactions
  ③ activeTopics → mnema events
  ④ memberImpressions → mnema facts（contact）
  ⑤ shared-memory.json → mnema facts（shared）
  ⑥ stickers.json / slang.json → 本地表
  ⑦ roles/*.md → mnema persona
```

---

## 3. 工具清单（26）

| 档 | 工具 |
|---|---|
| **P0** | `qq_status` `qq_send_message` `qq_reply` `qq_send_private_message` `qq_send_group_message` `qq_get_unread_messages` `qq_get_recent_messages` `qq_mark_read` `qq_wait_for_messages` `qq_set_wake_config` |
| **P1** | `qq_get_message_detail` `qq_get_group_members` `qq_get_active_members` `qq_get_forward_msg` `qq_send_image` `qq_send_sticker` `qq_collect_sticker` `qq_sticker_note` |
| **P2** | `qq_list_stickers` `qq_get_sticker_image` `qq_list_voices` `qq_send_voice` `qq_send_poke` `qq_slang_query` `qq_slang_submit` `qq_report_feedback` |

**作用域**：`owner` > `allowlist` > `group`；`qq_send_private/group_message` 需要 allowlist 及以上。

---

## 4. 数据表

| 表 | 用途 |
|---|---|
| `messages` | 消息归档（幂等键、方向、媒体标记） |
| `sessions` | 会话元数据、agent 会话、wake 状态、会话令牌 |
| `dedupe` | 幂等键（7 天清理） |
| `rate_limits` | 限流计数（分钟/小时/天） |
| `kv` | 杂项 |
| `stickers` | 收藏表情 + 备注 |
| `slang` | 黑话库（candidate/confirmed） |
| `feedback` | AI 自己上报的问题 |

**记忆不在本地**——由 mnema 负责（HTTP）。

---

## 5. 定时任务

| 时间 | 任务 |
|---|---|
| 04:30 | `memory.consolidate()`（聚类/抽象/衰减/叙事） |
| 04:40 | 清理：消息 90 天、幂等 7 天、限流 2 天 |

---

## 6. 验证

```bash
npm test        # 144 个单测
node src/index.js --config ./config.json --dry-run   # 影子启动（不发送）
node tools/migrate-v1.mjs --v1 <v1目录> --db ./state/qqbridge.db --dry-run
```

单测覆盖：配置校验、SQLite 迁移与查询、事件归一化、权限矩阵、路由幂等、唤醒策略、批量窗口、分条、提示词、记忆客户端熔断、编排（成功/失败/限流）、DSH 适配（假 api）、传输层、控制台、工具鉴权与 26 个工具、语音 provider、定时任务、v1 迁移。

---

## 7. 已知限制（切换前需实测）

| 项 | 说明 |
|---|---|
| SnowLuma 实机 | 图片/表情/语音/拍一拍走 `@snowluma/sdk`，需在你机器上实测一次 |
| DSH 实机 | `vendor/dsh-client.js` 来自 v1 生产验证，但 v2 的会话创建参数需实跑确认 |
| 语音识别 | `sensevoice` / `whisper` provider 需装模型与脚本；默认 `none` |
| 记忆 | mnema 需先运行并导入（`/v1/import`） |
| 群白名单 | 空列表 + `emptyGroupsMeansAll` 语义保留，切换时确认配置 |

---

## 8. 依赖安装的坑（实测）

### `@snowluma/sdk@1.14.20` 的 ESM 扩展名缺失

npm 上这个版本的 `dist/*.js` 使用**无扩展名**的相对导入：

```js
export { SnowLumaApiClient } from './client/api-client';   // ← Node ESM 会报 ERR_MODULE_NOT_FOUND
```

而 qq-bridge(v1) 本地安装的那份带 `.js`（`./client/api-client.js`），所以 v1 能跑、全新安装却跑不起来。

**处理**：`postinstall` 自动跑 `tools/fix-snowluma-esm.mjs`，把 dist 下所有相对导入补上 `.js`
（只在该文件确实存在时才补）。实测修复 45 处 / 13 个文件，之后 `import '@snowluma/sdk'` 正常。

**验证**：

```bash
npm run verify   # 逐项检查 SDK/DSH/工具表
```

### 历史消息方法名

SDK 里是 `getFriendMessageHistory` / `getGroupMessageHistory`（不是 `...MsgHistory`），
参数形状为 `{ user_id|group_id, count }`。`transport.history()` 已按实测签名实现。

### DSH 客户端

`vendor/dsh-client.js` 依赖 `@deepseek-ai/dsh-host-apiproxy` 与 `js-yaml`，装上即可加载
（`npm run verify` 会检查 `NodeApiClient` 的 `callUnary` / `ensureAuth` / `openRemoteEventStream`）。
