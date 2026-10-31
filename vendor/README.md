# vendor/

这里是**从旧版 `qq-bridge` 原样搬迁**的第三方协议适配代码，不是本项目的原创设计。

## `dsh-client.js`（795 行）

- **来源**：`qq-bridge/src/dsh-client.js`（旧项目生产验证过的 DSH Web API 客户端）
- **为什么搬**：DSH 的协议细节很多且脆弱（RPC 点号→斜杠、`{args:{...}}` 包装、浏览器 Cookie 铸造、
  `/api/remote.mux` 事件流、`session/prompt` 强制 `requestId`）。重写一遍只会引入回归，
  而这个文件头部已经有逐项实测记录（DSH 0.1.5-rc.1）。
- **依赖**：`js-yaml`、`@deepseek-ai/dsh-host-apiproxy`
- **边界**：只有 `src/agent/dsh.js` 引用它；业务代码只认 `AgentPort` 接口。

## 计划

等 DSH 官方 `apiproxy` 直接提供 Node 侧完整客户端（含 Cookie 铸造与 mux 流）后，
删除本目录、把 `src/agent/dsh.js` 改成直接依赖官方包。在此之前保持"最小面积引用"。
