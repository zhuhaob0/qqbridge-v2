import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../src/storage/db.js';
import * as q from '../src/storage/queries.js';
import { createToolRegistry } from '../src/tools/index.js';
import { createBus } from '../src/router/bus.js';
import { createFakeQq } from '../src/qq/fake.js';
import { createMcpServer } from '../src/tools/mcp.js';

const config = (over = {}) => ({
  qq: { ownerQQ: 100, selfQQ: 200 },
  allow: { private: [1, 2], groups: [456], emptyGroupsMeansAll: false },
  send: { maxPerMinute: 10 },
  ...over,
});

function setup({ owner = false } = {}) {
  const db = openDatabase(':memory:');
  const key = owner ? 'private:100' : 'private:1';
  q.upsertSession(db, {
    sessionKey: key, kind: 'direct', participants: ['self', owner ? 'user:100' : 'user:1'],
    wakeState: {}, lastEventAt: '2026-10-30T10:00:00Z', createdAt: '2026-10-30T10:00:00Z',
  });
  const token = q.ensureAgentToken(db, key);
  q.insertMessage(db, {
    msgId: 'in1', sessionKey: key, direction: 'inbound',
    senderId: '1', senderName: '小明', text: '在吗', at: '2026-10-30T10:00:00Z',
  });

  const qq = createFakeQq();
  const bus = createBus();
  const ctx = { db, config: config(), qq, bus, memory: null, logger: { info() {}, warn() {}, error() {}, debug() {} } };
  const registry = createToolRegistry();
  return { db, key, token, qq, bus, ctx, registry };
}

test('工具注册：P0 十件套都在', () => {
  const { registry } = setup();
  const names = registry.list().map((t) => t.name);
  for (const name of [
    'qq_status', 'qq_send_message', 'qq_reply', 'qq_send_private_message',
    'qq_send_group_message', 'qq_get_unread_messages', 'qq_get_recent_messages',
    'qq_mark_read', 'qq_wait_for_messages', 'qq_set_wake_config',
  ]) {
    assert.ok(names.includes(name), `缺少 ${name}`);
  }
});

test('鉴权：错误令牌被拒', async () => {
  const { registry, ctx, key } = setup();
  await assert.rejects(
    () => registry.call('qq_status', { key, token: 'wrong' }, ctx),
    /令牌无效/,
  );
});

test('鉴权：缺少 key 被拒', async () => {
  const { registry, ctx } = setup();
  await assert.rejects(() => registry.call('qq_status', { token: 'x' }, ctx), /缺少会话 key/);
});

test('qq_status 返回账号与未读数', async () => {
  const { registry, ctx, key, token } = setup();
  const r = await registry.call('qq_status', { key, token }, ctx);
  assert.equal(r.selfQQ, 200);
  assert.equal(r.unread, 1);
});

test('qq_send_message 发送并落库', async () => {
  const { registry, ctx, key, token, qq, db } = setup();
  const r = await registry.call('qq_send_message', { key, token, messages: '你好' }, ctx);
  assert.equal(r.ok, true);
  assert.equal(qq.sent.length, 1);
  assert.equal(qq.sent[0].sessionKey, key);
  const outbound = q.recentMessages(db, key, 10).filter((m) => m.direction === 'outbound');
  assert.equal(outbound.length, 1);
});

test('qq_send_private_message：白名单外目标被拒', async () => {
  const { registry, ctx, key, token } = setup();
  await assert.rejects(
    () => registry.call('qq_send_private_message', { key, token, userId: 999, text: 'hi' }, ctx),
    /不在私聊白名单/,
  );
});

test('qq_send_private_message：白名单内可发', async () => {
  const { registry, ctx, key, token, qq } = setup();
  const r = await registry.call('qq_send_private_message', { key, token, userId: 2, text: 'hi' }, ctx);
  assert.equal(r.ok, true);
  assert.equal(qq.sent[0].sessionKey, 'private:2');
});

test('qq_send_group_message：非白名单群被拒', async () => {
  const { registry, ctx, key, token } = setup();
  await assert.rejects(
    () => registry.call('qq_send_group_message', { key, token, groupId: 999, text: 'hi' }, ctx),
    /不在白名单/,
  );
});

test('qq_get_unread_messages / qq_mark_read', async () => {
  const { registry, ctx, key, token } = setup();
  const before = await registry.call('qq_get_unread_messages', { key, token }, ctx);
  assert.equal(before.count, 1);

  const marked = await registry.call('qq_mark_read', { key, token }, ctx);
  assert.equal(marked.ok, true);

  const after = await registry.call('qq_get_unread_messages', { key, token }, ctx);
  assert.equal(after.count, 0, '标记已读后不应再有未读');
});

test('qq_get_recent_messages 返回双向消息', async () => {
  const { registry, ctx, key, token } = setup();
  await registry.call('qq_send_message', { key, token, messages: '在的' }, ctx);
  const r = await registry.call('qq_get_recent_messages', { key, token, limit: 10 }, ctx);
  assert.equal(r.count, 2);
});

test('qq_set_wake_config 写入 wake_state', async () => {
  const { registry, ctx, key, token, db } = setup();
  const r = await registry.call('qq_set_wake_config', {
    key, token, mode: 'diving', until: '2026-11-01T00:00:00.000Z', triggers: { probability: 0.2 },
  }, ctx);
  assert.equal(r.wakeState.mode, 'diving');
  assert.equal(q.getSession(db, key).wakeState.triggers.probability, 0.2);
});

test('qq_wait_for_messages：收到消息时返回', async () => {
  const { registry, ctx, key, token, bus } = setup();
  const waiting = registry.call('qq_wait_for_messages', { key, token, timeoutMs: 1000 }, ctx);
  setTimeout(() => bus.emitMessage({ sessionKey: key, direction: 'inbound', text: '又来了' }), 10);
  const r = await waiting;
  assert.equal(r.timeout, false);
  assert.equal(r.messages[0].text, '又来了');
});

test('qq_wait_for_messages：超时返回空', async () => {
  const { registry, ctx, key, token } = setup();
  const r = await registry.call('qq_wait_for_messages', { key, token, timeoutMs: 20 }, ctx);
  assert.equal(r.timeout, true);
  assert.equal(r.messages.length, 0);
});

test('作用域：群会话不能调用 allowlist 工具', async () => {
  const db = openDatabase(':memory:');
  q.upsertSession(db, {
    sessionKey: 'group:456', kind: 'public', participants: ['self', 'group:456'],
    wakeState: {}, createdAt: '2026-10-30T10:00:00Z',
  });
  const token = q.ensureAgentToken(db, 'group:456');
  const ctx = { db, config: config(), qq: createFakeQq(), bus: createBus(), memory: null };
  const registry = createToolRegistry();
  await assert.rejects(
    () => registry.call('qq_send_private_message', { key: 'group:456', token, userId: 1, text: 'x' }, ctx),
    /无权使用/,
  );
  db.close();
});

test('MCP：tools/list 与 tools/call 走同一 registry', async () => {
  const { registry, ctx, key, token } = setup();
  const server = createMcpServer(registry, ctx);

  const list = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.ok(list.result.tools.length >= 10);

  const call = await server.handle({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'qq_status', arguments: { key, token } },
  });
  const payload = JSON.parse(call.result.content[0].text);
  assert.equal(payload.selfQQ, 200);

  const bad = await server.handle({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'qq_status', arguments: { key, token: 'nope' } },
  });
  assert.equal(bad.result.isError, true);
});
