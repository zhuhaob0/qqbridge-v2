/**
 * 控制台（本地 HTTP）：健康、统计、会话；页面在 page.js
 */

import http from 'node:http';
import { CONSOLE_PAGE } from './page.js';

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function authorized(req, url, token) {
  if (!token) return true;
  const header = req.headers.authorization ?? '';
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim() === token;
  return url.searchParams.get('token') === token;
}

export function createConsoleServer({
  db, config, transport = null, memory = null, logger = null, registry = null, toolCtx = null,
  stats = () => ({}), getSessions = null, token = config?.console?.token ?? '', port = config?.console?.port ?? 3100,
} = {}) {
  const startedAt = Date.now();

  async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8').trim();
    return text ? JSON.parse(text) : {};
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/' || path === '/console') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(CONSOLE_PAGE);
      return;
    }

    if (!authorized(req, url, token)) {
      sendJson(res, 401, { ok: false, error: '未授权' });
      return;
    }

    if (path === '/health') {
      sendJson(res, 200, {
        ok: true,
        uptimeMs: Date.now() - startedAt,
        schema: db ? Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0) : null,
        memory: memory ? { degraded: Boolean(memory.degraded) } : { enabled: false },
        transport: transport ? { connected: Boolean(transport.connected) } : { connected: false },
      });
      return;
    }

    if (path === '/tools/list' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, tools: registry ? registry.list().map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, scope: t.scope })) : [] });
      return;
    }

    if (path === '/tools/call' && req.method === 'POST') {
      if (!registry) { sendJson(res, 503, { ok: false, error: '工具未装配' }); return; }
      try {
        const body = await readBody(req);
        const result = await registry.call(body.name, body.arguments ?? {}, toolCtx ?? { db, config, qq: transport, memory, logger });
        sendJson(res, 200, { ok: true, result });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error?.message ?? String(error), code: error?.code ?? 'error' });
      }
      return;
    }

    if (path === '/stats') {
      sendJson(res, 200, { ok: true, ...stats() });
      return;
    }

    if (path === '/sessions') {
      sendJson(res, 200, { ok: true, sessions: getSessions ? getSessions() : [] });
      return;
    }

    sendJson(res, 404, { ok: false, error: `未知路由 ${path}` });
  });

  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server.address()));
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
