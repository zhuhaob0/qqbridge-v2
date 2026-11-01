# DSH preset 相关资产（vendored）

这里放的是 **DSH 侧的资产**，不是 qqbridge 运行时代码，但从 v2 起不再依赖 v1 仓库。

## 目录

```
integrations/dsh-presets/
  dsh/agent-presets/            # 源（人写）：preset.yml + agent.cordis.yml
    qq-chat/
    qq-chat-v2/
  plugins/qq-agent-presets/     # 装（DSH 读）：bundle patch + 守卫
    presets/qq-chat-v2.patch.yml
    presets/qq-chat.patch.yml
    qq-tool-restrict.mjs
  scripts/build-agent-preset-patches.mjs   # 源 → patch 的渲染脚本
```

## 为什么分「源」和「装」

- **源**（`dsh/agent-presets/<preset>/`）：人能读能改的地方，人格与工具面在这里维护
- **装**（`plugins/qq-agent-presets/presets/<preset>.patch.yml`）：DSH 0.1.7+ 的 preset 机制要求
  `@deepseek-ai/dsh-agent-preset` 行的 `config.plugins` 必须是内联行列表，所以由脚本渲染出来

改完源之后跑：

```bash
cd integrations/dsh-presets
node scripts/build-agent-preset-patches.mjs
```

## 它怎么被 DSH 用

`~/.dsh/plugins/qq-agent-presets` 是一个 **junction**，指向本目录的 `plugins/qq-agent-presets`；
profile 的 `package.json` 又用 `link:` 依赖把该包暴露给 DSH，patch 里的守卫行写的是裸说明符：

```yaml
- id: qq-tool-restrict
  name: qq-agent-presets/qq-tool-restrict.mjs
```

## 守卫（qq-tool-restrict.mjs）

两层防线：

1. **注册期** `tools.restrict({deny})`：把本地执行/文件/子 agent 类工具从 schema 隐藏
2. **执行期** `tools.guard`：白名单之外的工具调用一律拒绝（前缀 `mcp__snowluma__` 等）

⚠️ 静态名单会随 DSH 版本过期（实测 0.2.x 的全局工具已变成 `ego_*` 浏览器工具）。
诊断日志写在 `~/.dsh/state/tool-restrict.log`，会列出「当前 DSH 真实全局工具」与失败项。

脚本里还有一段「动态兜底」：故意触发一次非法 restrict，从报错里解析当前全局工具清单。
默认**只记录不执行**（`QQ_TOOL_RESTRICT_DYNAMIC=1` 才真正隐藏），避免误伤桌面会话的工具。
