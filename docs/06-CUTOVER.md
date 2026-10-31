# 切换记录（2026-10-31）

> 一次真实切换的操作日志：做了什么、现在什么状态、怎么回滚。

---

## 1. 切换前

| 项 | 状态 |
|---|---|
| v1（`D:\Software\QQBot\qq-bridge`） | 运行中，pid 15080，监听 3100 |
| SnowLuma | 运行中（3000/3001），由 DSH 插件 `qqbot-supervisor` 代为守护 |
| DSH | 运行在 61337，profile `desktop` |
| mnema | 运行在 8321（新，已导入 v1 记忆） |
| v2 | 代码/配置/迁移就绪，未接管 |

## 2. 做的改动

### 2.1 DSH 的 MCP 指向 v2

`~/.dsh/profiles/desktop/cordis.patch.yml`（备份 `.bak-v2-cutover`）：

```yaml
- id: mcp-snowluma
  config:
    args:
      - 'E:\Code\qqbridge-v2\src\mcp\cli.js'     # 原 qq-bridge/src/mcp-snowluma-safe.js
    env:
      QQB_BRIDGE: 'http://127.0.0.1:3100'
      QQB_TOKEN: ''
```

`mcp-snowluma-host` 与 `mcp-web-search-safe` 未改（它们独立于桥接）。

### 2.2 移除了 `qqbot-supervisor` 插件

`~/.dsh/profiles/desktop/package.json`（备份 `.bak-v2-cutover`）：

```diff
- "qqbot-supervisor": "link:E:/Code/dsh-plugin-qqbot"
  bundles: [..., "qq-agent-presets", "qq-mode-console"]   # 去掉了 qqbot-supervisor
```

**原因**：该插件写死 `spawn(node, ['src/bridge.js'], { cwd: <v1目录> })`，
只要它在，杀掉 v1 就会在 2 秒内被拉回来。

**副作用**：dispose 时它 `taskkill /T` 了自己的两个子进程 —— **SnowLuma 也被一起停掉了**。
SnowLuma 需要用户手动启动（见 §3）。

### 2.3 v2 侧修的两个问题

| 问题 | 修复 |
|---|---|
| v1 配置里的 token 是 **HTTP(3000)** 的，WS(3001) 是另一个 token | 新增 `src/transport/snowluma-token.js`：按 `selfQQ` 读 `<SnowLuma>/config/onebot_<uin>.json` 的 `wsServers[0].accessToken` |
| WS 连接失败导致进程崩溃（未捕获 Promise） | `start()` 里捕获并 5 秒重试；`/health` 的 `connected` 改为真实的 `client.isConnected` |

## 3. 当前状态

| 项 | 状态 |
|---|---|
| v1 | **已停止**（不会自动重启，supervisor 已移除） |
| v2 | **运行中**，监听 3100，26 个工具，记忆已连 mnema |
| SnowLuma | **已停止**，需手动启动 |
| DSH MCP | 已指向 v2，实测 `tools/list` 返回 26 个工具 |

### 待用户操作

双击 `D:\Software\QQBot\SnowLuma-v2.1.1\launcher.bat`（或按你平时的方式启动）。
启动后 v2 会在 5 秒内自动连上（日志出现「SnowLuma 传输层启动」且 `/health` 的 `transport.connected` 变 true）。

## 4. 回滚

```powershell
# 1) 停 v2
Get-NetTCPConnection -LocalPort 3100 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
# 2) 恢复 DSH 配置
copy "$env:USERPROFILE\.dsh\profiles\desktop\package.json.bak-v2-cutover" "$env:USERPROFILE\.dsh\profiles\desktop\package.json"
copy "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml.bak-v2-cutover" "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml"
# 3) 重启 DSH（或等插件热加载），然后启动 v1
cd D:\Software\QQBot\qq-bridge; node src/bridge.js
```

v1 的数据与配置**未改动**，回滚是无损的。

## 5. 后续待办

1. **重新做一个 v2-aware 的守护**：现有 `qqbot-supervisor` 写死了 v1 的入口，
   需要支持 `bridgeDir` + `bridgeScript` + `bridgeArgs`（或直接改为调用 v2 的 `src/index.js`）。
2. **DSH 重启后确认**：MCP 冷启动是否仍指向 v2（本次是热加载生效）。
3. **SnowLuma 的 EULA**：不要做成自动启动；保持"用户手动启动、桥接只探测"。

---

## 6. 切换后发现并修复的问题

| 问题 | 原因 | 修复 |
|---|---|---|
| 我发的那条测试消息显示成 `????` | **不是 v2 的 bug**：PowerShell 构造请求体时把中文编码成了 `?` | 用 Node 发请求验证即可；AI 自己的回复中文正常 |
| 性格变了（傲娇 → 不像原来） | ① 迁移按字母序选了 `傲娇助手.md`，v1 实际用 `小鲸鱼.md`；② v2 关掉了 DSH 的 `qq-chat-v2` 预设（系统提示词全丢） | ① 迁移改为 `config.role.name` → `小鲸鱼.md` → 其它；② `agent.preset = 'qq-chat-v2'`，恢复 DSH 系统提示词 |
| v2 冷启动连不上 DSH | DSH 每次启动端口随机，`config.json` 里的 `agent.baseUrl` 会过期 | v2 读取 `DSH_BASE_URL` 环境变量覆盖 `agent.baseUrl`；由守护插件注入 |

### 关于「冷启动」

「冷启动」= **DSH 桌面版完全退出再打开**。它每次启动会随机选一个 HTTP 端口（这次是 61337，下次可能是别的），
所以任何写死在配置里的 `agent.baseUrl` 都会失效。现在的解决方式是：守护插件启动桥接时把
`DSH_BASE_URL` 注入环境变量，v2 启动时用它覆盖配置。

而「热加载」是 DSH 运行中改配置/插件的行为——本次 MCP 指向 v2 就属于热加载生效，所以当时没重启 DSH 也能用。

## 7. 守护插件（qqbot-supervisor）适配

`E:\Code\dsh-plugin-qqbot` 已改为可配置：

| 配置 | 新默认值 |
|---|---|
| `bridgeDir` | `E:\Code\qqbridge-v2` |
| `bridgeScript` | `src/index.js` |
| `bridgeArgs` | `["--config","config.json"]` |
| `logFile` | `state/v2.out.log` |

**注意**：DSH 当前进程里缓存的还是旧模块（日志显示 `bridgeDir=D:\Software\QQBot\qq-bridge`），
所以**下次 DSH 重启后**才会用上新的默认值。在那之前，若 v2 崩溃，旧插件会尝试拉起 v1。
