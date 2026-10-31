/**
 * MCP server（stdio，JSON-RPC 2.0，零依赖）
 *
 * DSH 通过 MCP 调用这些工具；每个调用都带 key/token，由 registry 鉴权。
 */

import readline from 'node:readline';

const PROTOCOL_VERSION = '2024-11-05';

function text(value) {
  const body = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text: body }] };
}

export function createMcpServer(registry, ctx, { name = 'qqbridge', version = '0.1.0' } = {}) {
  async function handle(message) {
    const { id, method, params } = message ?? {};

    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name, version },
        },
      };
    }
    if (method === 'notifications/initialized' || method === 'initialized') return null;
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };

    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: registry.list().map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        },
      };
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const args = params?.arguments ?? {};
      try {
        const result = await registry.call(toolName, args, ctx);
        return { jsonrpc: '2.0', id, result: text(result) };
      } catch (error) {
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `错误：${error?.message ?? error}` }], isError: true } };
      }
    }

    return { jsonrpc: '2.0', id, error: { code: -32601, message: `未知方法 ${method}` } };
  }

  function start({ input = process.stdin, output = process.stdout } = {}) {
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    rl.on('line', async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: '解析失败' } })}\n`);
        return;
      }
      const response = await handle(message);
      if (response) output.write(`${JSON.stringify(response)}\n`);
    });
    return rl;
  }

  return { handle, start, registry };
}
