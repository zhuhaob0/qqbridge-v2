import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../src/storage/db.js';
import * as q from '../src/storage/queries.js';
import { createConsoleServer } from '../src/console/server.js';
import { createToolRegistry } from '../src/tools/index.js';
import { createFakeQq } from '../src/qq/fake.js';
import { createBus } from '../src/router/bus.js';
import { buildPrompt } from '../src/orchestrator/prompt.js';

const config = () => ({
  qq: { ownerQQ: 100, selfQQ: 200 },
  allow: { private: [1], groups: [], emptyGroupsMeansAll: false },
  send: { maxPerMinute: 10 },
  console: { token: '' },
});

async function withServer(fn) {
  const db = openDatabase(':memory:');
  q.upsertSession(db, {
    sessionKey: 'private:1', kind: 'direct', participants: ['self', 'user:1'],
    wakeState: {}, lastEventAt: '2026-10-30T10:00:00Z', createdAt: '2026-10-30T10:00:00Z',
  });
  const token = q.ensureAgentToken(db, 'private:1');
  const qq = createFakeQq();
  const registry = createToolRegistry();
  const consoleServer = createConsoleServer({
    db,
    config: config(),
    registry,
    toolCtx: { db, config: config(), qq, bus: createBus(), memory: null },
    port: 0,
  });
  const addr = await consoleServer.listen();
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    await fn({ base, db, qq, token });
  } finally {
    await consoleServer.close();
    db.close();
  }
}

test('控制台工具通道：/tools/list 返回定义', async () => {
  await withServer(async ({ base }) => {
    const body = await (await fetch(`${base}/tools/list`)).json();
    assert.equal(body.ok, true);
    assert.ok(body.tools.length >= 10);
    assert.ok(body.tools.every((t) => t.name.startsWith('qq_')));
  });
});

test('控制台工具通道：/tools/call 成功执行', async () => {
  await withServer(async ({ base, qq, token }) => {
    const res = await fetch(`${base}/tools/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'qq_send_message', arguments: { key: 'private:1', token, messages: '走了' } }),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(qq.sent.length, 1);
  });
});

test('控制台工具通道：令牌无效返回 400', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/tools/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'qq_status', arguments: { key: 'private:1', token: 'bad' } }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /令牌无效/);
  });
});

test('提示词：会话令牌被注入，工具调用才有鉴权依据', () => {
  const prompt = buildPrompt({
    session: { sessionKey: 'private:1', kind: 'direct', agentToken: 'tok123' },
    recent: [],
  });
  assert.match(prompt, /【会话标识】/);
  assert.match(prompt, /key=private:1/);
  assert.match(prompt, /token=tok123/);
});

test('提示词：没有令牌时不输出该段', () => {
  const prompt = buildPrompt({ session: { sessionKey: 'private:1', kind: 'direct' }, recent: [] });
  assert.doesNotMatch(prompt, /会话标识/);
});
