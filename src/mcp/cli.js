#!/usr/bin/env node
/**
 * MCP 代理（stdio）：把 MCP 调用转发给桥接进程的 HTTP 工具通道
 *
 * DSH 配置：
 *   { "command": "node", "args": [".../src/mcp/cli.js"],
 *     "env": { "QQB_BRIDGE": "http://127.0.0.1:3100", "QQB_TOKEN": "<console token>" } }
 *
 * 为什么代理而不是直连：工具执行需要唯一的 SnowLuma 连接与内存状态，
 * 只能在桥接进程里跑；MCP 进程只做协议转换。
 */

import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CACHE_FILE = process.env.QQB_TOOLS_CACHE ?? path.join(os.tmpdir(), 'qqbridge-tools-cache.json');

function saveCache(tools) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify({ at: new Date().toISOString(), tools }), 'utf8'); } catch { /* 忽略 */ }
}

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')).tools ?? []; } catch { return []; }
}

const PROTOCOL_VERSION = '2024-11-05';
const BRIDGE = (process.env.QQB_BRIDGE ?? 'http://127.0.0.1:3100').replace(/\/+$/, '');
const TOKEN = process.env.QQB_TOKEN ?? '';

async function api(path, options = {}) {
  // 桥接可能还没起来（DSH 启动早期）：必须快速失败，否则 DSH 会等 tools/list 到超时，
  // 表现为「进程和托盘都在，但窗口半天不出来」。
  const res = await fetch(`${BRIDGE}${path}`, {
    ...options,
    signal: AbortSignal.timeout(3000),
    headers: {
      'content-type': 'application/json',
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      ...(options.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body;
}

const textResult = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

async function handle(message) {
  const { id, method, params } = message ?? {};

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'qqbridge-v2', version: '0.1.0' },
      },
    };
  }
  if (method === 'notifications/initialized' || method === 'initialized') return null;
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };

  if (method === 'tools/list') {
    try {
      const body = await api('/tools/list');
      const tools = body.tools ?? [];
      if (tools.length) saveCache(tools);
      return { jsonrpc: '2.0', id, result: { tools } };
    } catch (error) {
      // 桥接还没起来时用上次的缓存。
      // 注意：JSON-RPC 规定 result 与 error 不能同时出现——之前两个都返回，
      // 客户端（DSH）可能把它当成失败并重试，实测表现为启动多等 60 秒。
      const cached = loadCache();
      console.error('[qqbridge-mcp] tools/list 回退缓存: ' + String(error?.message ?? error));
      return { jsonrpc: '2.0', id, result: { tools: cached } };
    }
  }

  if (method === 'tools/call') {
    try {
      const body = await api('/tools/call', {
        method: 'POST',
        body: JSON.stringify({ name: params?.name, arguments: params?.arguments ?? {} }),
      });
      return { jsonrpc: '2.0', id, result: textResult(body.result) };
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: `错误：${error?.message ?? error}` }], isError: true },
      };
    }
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `未知方法 ${method}` } };
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: '解析失败' } })}\n`);
    return;
  }
  const response = await handle(message);
  if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
});
