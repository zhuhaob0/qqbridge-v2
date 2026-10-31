import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../src/storage/db.js';
import * as q from '../src/storage/queries.js';
import { createToolRegistry } from '../src/tools/index.js';

const config = () => ({
  qq: { ownerQQ: 100, selfQQ: 200 },
  allow: { private: [1], groups: [456], emptyGroupsMeansAll: false },
  send: { maxPerMinute: 10, imagesPerMinute: 2, stickersPerMinute: 2 },
});

function setup({ withPort = true } = {}) {
  const db = openDatabase(':memory:');
  q.upsertSession(db, {
    sessionKey: 'group:456', kind: 'public', participants: ['self', 'group:456'],
    wakeState: {}, lastEventAt: '2026-10-30T10:00:00Z', createdAt: '2026-10-30T10:00:00Z',
  });
  const token = q.ensureAgentToken(db, 'group:456');

  q.insertMessage(db, {
    msgId: 'm1', sessionKey: 'group:456', direction: 'inbound',
    senderId: '1', senderName: '小明', text: '看这个', at: '2026-10-30T10:00:00Z',
  });
  q.insertMessage(db, {
    msgId: 'm2', sessionKey: 'group:456', direction: 'inbound',
    senderId: '2', senderName: '小红', text: '哈哈', at: '2026-10-30T10:01:00Z',
  });

  const qq = withPort
    ? {
      async sendText() { return { ok: true, msgId: 'x' }; },
      async sendImage() { return { ok: true, msgId: 'img1' }; },
      async sendSticker() { return { ok: true, msgId: 'st1' }; },
      async groupMembers() { return [{ userId: '1', name: '小明' }, { userId: '2', name: '小红' }]; },
      async forwardMsg() { return { messages: [{ text: 'a' }, { text: 'b' }] }; },
      async collectSticker() { return { ok: true, sticker: { id: 's1', desc: '笑哭', url: 'http://x/1.png' } }; },
    }
    : { async sendText() { return { ok: true, msgId: 'x' }; } };

  const ctx = { db, config: config(), qq, bus: null, memory: null };
  const registry = createToolRegistry();
  return { db, token, qq, ctx, registry, key: 'group:456' };
}

test('P1 档工具都在注册表里', () => {
  const { registry } = setup();
  const names = registry.list().map((t) => t.name);
  for (const name of [
    'qq_get_message_detail', 'qq_get_group_members', 'qq_get_active_members', 'qq_get_forward_msg',
    'qq_send_image', 'qq_send_sticker', 'qq_collect_sticker', 'qq_sticker_note',
  ]) assert.ok(names.includes(name), `缺少 ${name}`);
});

test('消息详情：有端口时走端口，没有时回落数据库', async () => {
  const a = setup();
  const r1 = await a.registry.call('qq_get_message_detail', { key: a.key, token: a.token, messageId: 'm1' }, a.ctx);
  assert.equal(r1.text, '看这个');

  const b = setup({ withPort: false });
  const r2 = await b.registry.call('qq_get_message_detail', { key: b.key, token: b.token, messageId: 'm2' }, b.ctx);
  assert.equal(r2.senderName, '小红');
});

test('群成员与活跃成员', async () => {
  const { registry, ctx, key, token } = setup();
  const members = await registry.call('qq_get_group_members', { key, token }, ctx);
  assert.equal(members.count, 2);

  const active = await registry.call('qq_get_active_members', { key, token }, ctx);
  assert.equal(active.members.length, 2);
  assert.equal(active.members[0].count, 1);
});

test('合并转发：端口存在时返回内容', async () => {
  const { registry, ctx, key, token } = setup();
  const r = await registry.call('qq_get_forward_msg', { key, token, id: 'f1' }, ctx);
  assert.equal(r.messages.length, 2);
});

test('发图：只接受 http(s)，并有频率限制', async () => {
  const { registry, ctx, key, token } = setup();
  await assert.rejects(
    () => registry.call('qq_send_image', { key, token, url: 'file:///etc/passwd' }, ctx),
    /http\(s\)/,
  );
  await registry.call('qq_send_image', { key, token, url: 'https://x/1.png' }, ctx);
  await registry.call('qq_send_image', { key, token, url: 'https://x/2.png' }, ctx);
  await assert.rejects(
    () => registry.call('qq_send_image', { key, token, url: 'https://x/3.png' }, ctx),
    /过于频繁/,
  );
});

test('表情：发送与收藏入库', async () => {
  const { registry, ctx, key, token, db } = setup();
  const sent = await registry.call('qq_send_sticker', { key, token, stickerId: 's1' }, ctx);
  assert.equal(sent.ok, true);

  const collected = await registry.call('qq_collect_sticker', { key, token, messageId: 'm1', remark: '好图' }, ctx);
  assert.equal(collected.ok, true);
  const stored = q.getSticker(db, 's1');
  assert.equal(stored.note, '好图');
});

test('表情备注：不存在的表情报错', async () => {
  const { registry, ctx, key, token } = setup();
  await assert.rejects(
    () => registry.call('qq_sticker_note', { key, token, stickerId: 'nope', note: 'x' }, ctx),
    /未收藏/,
  );
});

test('传输层不支持时给出明确错误', async () => {
  const { registry, ctx, key, token } = setup({ withPort: false });
  await assert.rejects(
    () => registry.call('qq_send_image', { key, token, url: 'https://x/1.png' }, ctx),
    /不支持/,
  );
});
