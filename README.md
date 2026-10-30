# qqbridge-v2

把 QQ（SnowLuma / OneBot）接到 DSH agent 上的**下一版桥接**。

> 取代 `qq-bridge`（12,023 行单文件、126 个路由、26 个工具、14 个 JSON 状态文件）。
> 目标：**分层、可测、可迁移、记忆外置**。

## 项目状态

📍 **设计阶段** — 尚无代码。三份文档待确认：

| 文档 | 内容 |
|---|---|
| [需求分析](docs/01-REQUIREMENTS.md) | 角色、功能需求（FR）、非功能需求、验收标准、风险 |
| [架构设计](docs/02-ARCHITECTURE.md) | 六层架构、端口/适配器、数据流、权限模型、部署 |
| [详细设计](docs/03-DETAILED-DESIGN.md) | 目录结构、配置、SQLite 表、关键流程、限流、测试、迁移 |

## 一句话架构

```
SnowLuma ←→ transport ←→ router ←→ wake ←→ orchestrator
                                                 │
                          ┌──────────────────────┼──────────────────────┐
                          ▼                      ▼                      ▼
                    storage (SQLite)        tools (权限过滤)        memory ──► mnema
                          │                      │
                          └────── console ───────┘
```

## 与前一版的关键差异

| 方面 | qq-bridge (v1) | qqbridge-v2 |
|---|---|---|
| 代码组织 | 单文件 1.2 万行 | 9 个模块，单文件 ≤400 行 |
| 记忆 | 内嵌 JSON | 外置 [mnema](https://github.com/zhuhaob0/mnema) |
| 状态 | 14 个 JSON | 1 个 SQLite（可迁移、可清理） |
| 权限 | 散落各处 | 统一 `security/policy.js`（纯函数可测） |
| 提示词 | 拼在 bridge.js | `orchestrator/prompt.js`（快照测试） |
| 可观测 | 文本日志 | JSON Lines + `/health` |

## License

MIT（与 mnema 一致，待确认）
