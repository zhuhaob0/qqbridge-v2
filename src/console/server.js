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
  db, config, transport = null, memory = null, logger = null,
  stats = () => ({}), getSessions = null, token = config?.console?.token ?? '', port = config?.console?.port ?? 3100,
} = {}) {
  const startedAt = Date.now();

  const server = http.createServer((req, res) => {
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
