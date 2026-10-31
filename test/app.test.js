import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../src/storage/db.js';
import * as q from '../src/storage/queries.js';
import { createApp } from '../src/app.js';
import { createFakeAgent } from '../src/agent/fake.js';
import { createFakeQq } from '../src/qq/fake.js';

const config = () => ({
  qq: { ownerQQ: 100, selfQQ: 200, botNames: [] },
  allow: { private: [1], groups: [], emptyGroupsMeansAll: false },
  wake: { batchWindowMs: 20, triggers: { at: true, name: true, question: true, probability: 0 } },
  send: { minGapMs: 0, maxGapMs: 0, maxPerMinute: 10, splitThreshold: 20 },
  agent: { preset: 'test' },
});

const event = (over = {}) => ({
  post_type: 'message',
  message_type: 'private',
  user_id: 1,
  message_id: 10,
  time: 1730300000,
  message: [{ type: 'text', data: { text: '你好' } }],
  sender: { user_id: 1, nickname: '小明' },
  ...over,
});

test('端到端：收消息 → 批量窗口 → 分条回复', async () => {
  const db = openDatabase(':memory:');
  const qq = createFakeQq();
  const app = createApp({
    db,
    config: config(),
    agent: createFakeAgent({ replies: ['你好呀。找我什么事？'] }),
    qq,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    sleep: async () => {},
  });

  const result = app.router.handle(event());
  assert.equal(result.accepted, true);

  await new Promise((r) => setTimeout(r, 120));

  assert.ok(qq.sent.length >= 1, '应至少发出一条');
  assert.match(qq.sent[0].text, /你好呀/);
  db.close();
});

test('端到端：白名单外不触发', async () => {
  const db = openDatabase(':memory:');
  const qq = createFakeQq();
  const app = createApp({
    db,
    config: config(),
    agent: createFakeAgent(),
    qq,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    sleep: async () => {},
  });

  app.router.handle(event({ user_id: 9 }));
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(qq.sent.length, 0);
  db.close();
});

test('端到端：窗口内多条消息只触发一次回复', async () => {
  const db = openDatabase(':memory:');
  const qq = createFakeQq();
  const app = createApp({
    db,
    config: config(),
    agent: createFakeAgent({ replies: ['收到'] }),
    qq,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    sleep: async () => {},
  });

  app.router.handle(event({ message_id: 11, message: [{ type: 'text', data: { text: '在吗' } }] }));
  app.router.handle(event({ message_id: 12, message: [{ type: 'text', data: { text: '问你个事' } }] }));

  await new Promise((r) => setTimeout(r, 140));
  assert.equal(qq.sent.length, 1, '应只回复一次');
  const recent = q.recentMessages(db, 'private:1', 10).filter((m) => m.direction === 'inbound');
  assert.equal(recent.length, 2, '两条入站都应入库');
  db.close();
});
