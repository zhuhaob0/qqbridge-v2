# 交接说明（Session Handoff）

> 用途：DSH 的对话上下文是**按会话隔离**的。开新会话后，我看不到旧会话的逐字记录，
> 但仓库、git 历史、这条文档都还在。新会话请先读这一页，然后 `git log --oneline -20` 补齐近期改动。

最后更新：2026-11-01 15:5x（Asia/Shanghai）

## 1. 这套东西是什么

```
QQ ←→ SnowLuma(OneBot 网关) ←→ qqbridge-v2(桥接) ←→ DSH(agent) ←→ DeepSeek 模型
                                        │
                                        └→ mnema(长期记忆引擎, HTTP)
```

- **qqbridge-v2**：QQ 桥接。负责收发、唤醒、编排、工具、记忆读写。
- **mnema**：记忆引擎（事件/事实/关系/人格/叙事 + 披露层），产品无关，纯 HTTP。
- **dsh-plugin-qqbot**：DSH 插件，托管 SnowLuma + 桥接进程。
- **integrations/dsh-presets**：DSH 侧 preset 资产（qq-chat-v2 + 工具守卫），fork 自上游仓库。

## 2. 服务与端口

| 服务 | 端口 | 启动方式 |
|---|---|---|
| SnowLuma | 3001 (WS) / 3000 (HTTP) | 由 qqbot-supervisor 插件拉起 |
| 桥接 v2 | 3100 | 由 qqbot-supervisor 插件拉起（注入 DSH_BASE_URL） |
| mnema | 8321 | 由 mnema-supervisor 插件拉起（DSH 插件） |
| DSH | 每次启动随机 | 桌面应用 |

## 3. 关键仓库

| 路径 | 内容 |
|---|---|
| `E:\Code\qqbridge-v2` | 桥接主体（git，已推 GitHub） |
| `E:\Code\mnema` | 记忆引擎 + `integrations/dsh` 插件 + `examples/standalone` |
| `E:\Code\dsh-plugin-qqbot` | 桥接守护插件 |
| `~\.dsh\plugins\qq-agent-presets` | junction → `qqbridge-v2\integrations\dsh-presets\plugins\qq-agent-presets` |

## 4. 近期已修的问题（别再重复踩）

| 问题 | 结论 |
|---|---|
| AI 回复两条 | 模型把 `messages` 数组传给发送工具 → 工具已合并成一条；提示词默认单条 |
| 看不到图片 | `transport.getImage`（get_image → media.url 兜底）+ 图片内容块；收到的图缓存到 `state/media` |
| 图片转发不了 | `qq_send_image` 支持网页地址（og:image/twitter:image/正文首图）；`qq_forward_image` 走本地缓存 |
| 语音听不到 | 关键：QQ 语音是 **SILK**（不是 amr）→ `silk-wasm` 解码 → ffmpeg 转 16k wav → SenseVoice(sherpa-onnx) |
| 群聊记不住 | 入站即写记忆（router 阶段），群聊 `sensitivity=shared` + `recordPublic`；召回补 3～5 条跨会话记忆 |
| 私聊不唤醒 | 私聊一律唤醒（`wake.privateAlways`）；群聊默认活跃 |
| DSH 启动 60 秒 | 根因：MCP `tools/list` 返回非法 JSON-RPC（result+error 同时返回）→ 只返回 result |
| 会话越建越多 | ①`sessionCwd` 相对路径 → 改绝对 ②DSH `create` 对已存在 id 会新建 uuid → 先 `sessions.list` 再复用 ③只在 DSH 地址变化时清映射 |
| 标题不可读 | `sessions.rename` 设成 `QQ 私聊 · 老大(QQ号)` / `QQ 群 · 群名(群号)`；会话标题每轮刷新 |
| transport failed | 已知 issue：会话引用缺失附件时会永远失败（0 HTTP 请求）。本机扫描未发现缺失附件；大体积会话（14MB+）也可能触发 → 建议定期开新会话 |

## 5. 当前状态（收尾时）

- 三个服务正常；桥接 health: `transport.connected=true`、`memory.degraded=false`、`speech.ready=true`
- 测试：`cd E:\Code\qqbridge-v2 && node --test` → 153 pass（偶发 1 个时间敏感的 flaky）
- 会话：`qqb-p-2621072338`（QQ 私聊）、`qqb-g-636960140`（QQ 群），标题已带名字
- mnema 里：群聊 66 条 + 私聊若干 + 图片描述；关系度 L2

## 6. 未完成 / 可继续的

1. **会话体积监控**：>5MB 时日志提示开新会话（未做）
2. **守卫静态名单过期**：DSH 0.2.x 全局工具已变成 `ego_*`；执行期白名单仍有效，schema 隐藏待开启动态模式（`QQ_TOOL_RESTRICT_DYNAMIC=1`）
3. **群名/昵称缓存**：进程内缓存，重启失效（可接受）
4. **migrate-v1 脚本**：v1 目录已删除，脚本只剩文档价值
5. **flaky 测试**：`test/app.test.js` 里依赖真实计时的用例

## 7. 常用命令

```powershell
# 桥接健康 / 工具表
Invoke-WebRequest http://127.0.0.1:3100/health -UseBasicParsing
Invoke-WebRequest http://127.0.0.1:3100/tools/list -UseBasicParsing

# 记忆健康
Invoke-WebRequest http://127.0.0.1:8321/v1/health -UseBasicParsing

# 测试
cd E:\Code\qqbridge-v2; node --test
cd E:\Code\mnema; node --test

# preset 重新渲染
cd E:\Code\qqbridge-v2\integrations\dsh-presets
node scripts/build-agent-preset-patches.mjs
```
