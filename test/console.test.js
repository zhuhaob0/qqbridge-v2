import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase, SCHEMA_VERSION } from '../src/storage/db.js';
import * as q from '../src/storage/queries.js';
import { createConsoleServer } from '../src/console/server.js';

async function withConsole(fn, { token = '' } = {}) {
  const db = openDatabase(':memory:');
  q.upsertSession(db, {
    sessionKey: 'private:1', kind: 'direct', participants: ['self', 'user:1'],
    lastEventAt: '2026-10-30T10:00:00Z', createdAt: '2026-10-30T10:00:00Z',
  });
  const consoleServer = createConsoleServer({
    db,
    config: { console: { token } },
    token,
    port: 0,
    stats: () => ({ messages: 0, sessions: 1 }),
    getSessions: () => q.listSessions(db, 10),
  });
  const addr = await consoleServer.listen();
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    await fn({ base, db, token });
  } finally {
    await consoleServer.close();
    db.close();
  }
}

test('控制台：GET / 返回页面', async () => {
  await withConsole(async ({ base }) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /qqbridge-v2/);
  });
});

test('控制台：健康检查包含 schema 与依赖状态', async () => {
  await withConsole(async ({ base }) => {
    const data = await (await fetch(`${base}/health`)).json();
    assert.equal(data.ok, true);
    assert.equal(data.schema, SCHEMA_VERSION);
    assert.equal(data.memory.enabled, false);
  });
});

test('控制台：统计与会话列表', async () => {
  await withConsole(async ({ base }) => {
    const stats = await (await fetch(`${base}/stats`)).json();
    assert.equal(stats.sessions, 1);

    const sessions = await (await fetch(`${base}/sessions`)).json();
    assert.equal(sessions.sessions.length, 1);
    assert.equal(sessions.sessions[0].sessionKey, 'private:1');
  });
});

test('控制台：配置 token 后需要授权', async () => {
  await withConsole(async ({ base }) => {
    assert.equal((await fetch(`${base}/health`)).status, 401);
    assert.equal((await fetch(`${base}/health`, { headers: { authorization: 'Bearer s3' } })).status, 200);
    assert.equal((await fetch(`${base}/health?token=s3`)).status, 200);
  }, { token: 's3' });
});

test('控制台：未知路由 404', async () => {
  await withConsole(async ({ base }) => {
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });
});
