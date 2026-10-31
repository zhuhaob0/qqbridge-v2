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

const PROTOCOL_VERSION = '2024-11-05';
const BRIDGE = (process.env.QQB_BRIDGE ?? 'http://127.0.0.1:3100').replace(/\/+$/, '');
const TOKEN = process.env.QQB_TOKEN ?? '';

async function api(path, options = {}) {
  const res = await fetch(`${BRIDGE}${path}`, {
    ...options,
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
      return { jsonrpc: '2.0', id, result: { tools: body.tools ?? [] } };
    } catch (error) {
      return { jsonrpc: '2.0', id, result: { tools: [] }, error: { code: -32000, message: String(error?.message ?? error) } };
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
