import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../src/storage/db.js';
import * as q from '../src/storage/queries.js';
import { createRouter } from '../src/router/router.js';

const config = () => ({
  qq: { ownerQQ: 100, selfQQ: 200 },
  allow: { private: [1], groups: [456], emptyGroupsMeansAll: false },
});

const make = () => {
  const db = openDatabase(':memory:');
  const seen = [];
  const router = createRouter({
    db,
    config: config(),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    onMessage: (msg, meta) => seen.push({ msg, meta }),
    clock: () => new Date('2026-10-30T10:00:00Z'),
  });
  return { db, router, seen };
};

const event = (over = {}) => ({
  post_type: 'message',
  message_type: 'private',
  user_id: 1,
  message_id: 1,
  time: 1730300000,
  message: [{ type: 'text', data: { text: '在吗' } }],
  sender: { user_id: 1, nickname: 'A' },
  ...over,
});

test('白名单会话：入库并触发 onMessage', () => {
  const { db, router, seen } = make();
  const r = router.handle(event());
  assert.equal(r.accepted, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].meta.channelId, 'chat:user:1');
  assert.deepEqual(seen[0].meta.participants, ['self', 'user:1']);
  assert.equal(q.countMessages(db, 'private:1'), 1);
  db.close();
});

test('非白名单会话被忽略且不入库', () => {
  const { db, router, seen } = make();
  const r = router.handle(event({ user_id: 9 }));
  assert.equal(r.accepted, false);
  assert.match(r.reason, /白名单/);
  assert.equal(seen.length, 0);
  db.close();
});

test('重复消息只处理一次', () => {
  const { db, router, seen } = make();
  router.handle(event());
  const second = router.handle(event());
  assert.equal(second.accepted, false);
  assert.match(second.reason, /重复/);
  assert.equal(seen.length, 1);
  db.close();
});

test('自己发的消息入库但不触发唤醒', () => {
  const { db, router, seen } = make();
  const r = router.handle({
    post_type: 'message',
    message_type: 'group',
    group_id: 456,
    user_id: 200,
    message_id: 2,
    time: 1730300000,
    message: [{ type: 'text', data: { text: '我说一句' } }],
    sender: { user_id: 200, nickname: '我' },
  });
  assert.equal(r.accepted, true);
  assert.equal(r.msg.direction, 'outbound');
  assert.equal(seen.length, 0);
  db.close();
});

test('会话记录被创建并更新 last_event_at', () => {
  const { db, router } = make();
  router.handle(event());
  const s = q.getSession(db, 'private:1');
  assert.equal(s.kind, 'direct');
  assert.equal(s.lastEventAt, '2026-10-30T10:00:00.000Z');
  db.close();
});

test('非消息事件被忽略', () => {
  const { router } = make();
  assert.equal(router.handle({ post_type: 'notice' }).accepted, false);
});
