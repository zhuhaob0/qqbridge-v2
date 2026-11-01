// SnowLuma 网关状态查询 MCP server（stdio）。
// 由 DSH 的 MCP 客户端 spawn（cordis.patch.yml 里 mcp-snowluma-host 行）。
//
// 工具：
//   snowluma_status   —— 检查网关是否在线（只读：HTTP get_login_info）与账号信息
//
// ── 为什么这里**没有**启停 SnowLuma 的工具（2026-09-20 移除，不要加回来）────────────
//
// 曾经有 `start_snowluma` / `stop_snowluma`（`spawn launcher.bat` / `taskkill`），默认关闭、
// 需要 `snowluma.allowProcessControl: true` 才注册。它们被移除，理由不是"危险"，而是**许可**：
//
//   SnowLuma EULA §5.4（中文为准）：「除事先取得著作权人的书面授权外，您仅可为 LICENSE 允许的
//   非商业用途，以专有组件随本软件提供的形式运行该组件；不得复制、修改、单独再分发或再许可该组件。
//   **将其并入第三方安装包或 Docker 镜像、通过自动化脚本部署**，或者将其用于任何商业用途，
//   均须事先取得书面授权。」
//
// 原生组件是**专有组件**；由本程序**程序化启动/结束**它，落在"通过自动化脚本部署"的射程内。
// 即便是"用户已装好、我们帮忙拉起"，也不值得为这点便利去踩一条需要书面授权的条款。
//
// 设计不变量 L6（见规划集 QSH_PLAN.md §6.0）：**QSH 只探测、不部署**——
// 永不安装、复制、打包或自动部署 SnowLuma 及其原生组件，也不程序化启停其进程。
// 用户在 QQ 侧不可用时得到的应该是**可操作的提示**（"请自行启动 SnowLuma"），而不是被代劳。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 兼容层位置：src/mcp/compat → 上三级是仓库根
const ROOT = path.resolve(__dirname, '..', '..', '..');

function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function getConfig() {
  return loadConfig();
}

function getHostConfig() {
  // v2 的配置是 qq.snowluma；OneBot HTTP token 存在 SnowLuma 自己的配置里
  const c = getConfig();
  const sl = c.qq?.snowluma ?? {};
  const homeDir = sl.homeDir ?? '';
  let httpUrl = sl.httpUrl ?? '';
  if (!httpUrl && sl.url) {
    // ws://127.0.0.1:3001 → http://127.0.0.1:3000（SnowLuma 的 HTTP 端口默认 3000）
    httpUrl = String(sl.url).replace(/^ws/, 'http').replace(/:3001(\/|$)/, ':3000$1');
  }
  if (!httpUrl) httpUrl = 'http://127.0.0.1:3000';
  let token = sl.accessToken ?? '';
  if (!token && homeDir) {
    try {
      const cfgDir = path.join(homeDir, 'config');
      const file = fs.readdirSync(cfgDir).find((f) => /^onebot_\d+\.json$/.test(f));
      if (file) {
        const raw = JSON.parse(fs.readFileSync(path.join(cfgDir, file), 'utf8'));
        token = raw?.networks?.httpServers?.[0]?.accessToken ?? '';
      }
    } catch { /* 读不到就用空 token */ }
  }
  return { httpUrl: String(httpUrl).replace(/\/+$/, ''), homeDir, token };
}

async function gatewayInfo() {
  const { httpUrl, token } = getHostConfig();
  try {
    const res = await fetch(`${httpUrl}/get_login_info`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) {
      const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请改为 OneBot HTTP API 地址）' : '';
      return { reachable: false, httpStatus: res.status, ...(hint ? { hint } : {}) };
    }
    const body = await res.json();
    if (body?.status === 'ok' && body?.retcode === 0) {
      return { reachable: true, online: true, user_id: body.data?.user_id, nickname: body.data?.nickname };
    }
    return { reachable: true, online: false, retcode: body?.retcode, wording: body?.wording };
  } catch (error) {
    return { reachable: false, error: String(error?.message ?? error) };
  }
}

const server = new McpServer({ name: 'snowluma-host', version: '0.2.1-r1' });


// ── QQ 空间工具（代理到桥接的 /tools/call）────────────────────────────────
// QQ 空间不属于 SnowLuma 的 MCP 工具集，但桥接已经实现了 qq_qzone_*，
// 这里把它们以 mcp__snowluma-host__ 前缀暴露给 QQ 会话。
async function bridgeCall(name, args) {
  const c = getConfig();
  const port = c.console?.port ?? 3100;
  const token = c.console?.token ?? '';
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await fetch('http://127.0.0.1:' + port + '/tools/call', {
    method: 'POST', headers, body: JSON.stringify({ name, arguments: args }),
  });
  const data = await res.json().catch(() => null);
  if (!data?.ok) throw new Error(data?.error ?? ('桥接返回 ' + res.status));
  return data.result;
}

const sessionArgs = { key: z.string(), token: z.string() };

server.tool(
  'qzone_post',
  '发一条 QQ 空间说说（自己的空间）。纯文字或带图；每 24 小时最多 3 条，发出去撤不回。',
  {
    ...sessionArgs,
    content: z.string().describe('说说正文'),
    images: z.array(z.string()).optional().describe('配图：http(s) 链接，或 state/media 下的文件名'),
  },
  async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await bridgeCall('qq_qzone_post', args)) }] }),
);

server.tool(
  'qzone_my_posts',
  '看自己 QQ 空间最近发的说说。',
  { ...sessionArgs, num: z.number().optional() },
  async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await bridgeCall('qq_qzone_my_posts', args)) }] }),
);

server.tool(
  'qzone_feeds',
  '看好友的 QQ 空间动态（含主人），返回 tid 可用于点赞/评论。',
  { ...sessionArgs, num: z.number().optional() },
  async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await bridgeCall('qq_qzone_feeds', args)) }] }),
);

server.tool(
  'qzone_like',
  '给一条说说点赞（每人每 24 小时最多 5 条）。',
  {
    ...sessionArgs,
    tid: z.string(),
    targetUin: z.union([z.string(), z.number()]).optional(),
    abstime: z.number().optional(),
  },
  async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await bridgeCall('qq_qzone_like', args)) }] }),
);

server.tool(
  'qzone_comment',
  '评论一条说说（发出撤不回：每 10 分钟 2 条、每天 30 条）。',
  { ...sessionArgs, tid: z.string(), content: z.string(), targetUin: z.union([z.string(), z.number()]).optional() },
  async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await bridgeCall('qq_qzone_comment', args)) }] }),
);

server.tool(
  'snowluma_status',
  '检查 SnowLuma OneBot 网关是否在线（只读探活 get_login_info）。返回网关可达性、QQ 在线状态与账号信息。网关不可达时返回可操作的提示（本程序不会代你启动 SnowLuma）。',
  {},
  async () => {
    const hc = getHostConfig();
    const info = await gatewayInfo();
    // 只读工具：不再暴露本机路径/PID（那需要进程控制能力，而该能力已被移除）。
    const payload = { ...info };
    if (info.reachable === false) {
      payload.hint = 'SnowLuma 网关不可达。请自行启动 SnowLuma（本程序不代装、不代启，原因见项目文档的合规说明 L6）。'
        + (hc.homeDir ? '' : ' 若 config.json 的 snowluma.httpUrl 与实际端口不一致，也请一并检查。');
    }
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  }
);

await server.connect(new StdioServerTransport());
