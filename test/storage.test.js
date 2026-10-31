import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { openDatabase, schemaInfo, SCHEMA_VERSION } from '../src/storage/db.js';
import * as q from '../src/storage/queries.js';

const msg = (over = {}) => ({
  msgId: 'm1', sessionKey: 'private:1', direction: 'inbound',
  senderId: '1', senderName: 'A', text: '你好',
  hasMedia: false, media: null, at: '2026-10-30T10:00:00Z',
  ...over,
});

test('打开内存库并迁移到最新版本', () => {
  const db = openDatabase(':memory:');
  assert.equal(schemaInfo(db).schemaVersion, SCHEMA_VERSION);
  db.close();
});

test('落盘重开保持版本', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-'));
  const file = path.join(dir, 't.db');
  let db = openDatabase(file);
  assert.equal(schemaInfo(db).schemaVersion, SCHEMA_VERSION);
  db.close();
  db = openDatabase(file);
  assert.equal(schemaInfo(db).schemaVersion, SCHEMA_VERSION);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('消息幂等：同 msgId 只插入一次', () => {
  const db = openDatabase(':memory:');
  assert.equal(q.insertMessage(db, msg()), true);
  assert.equal(q.insertMessage(db, msg({ text: '重复' })), false);
  assert.equal(q.countMessages(db, 'private:1'), 1);
  db.close();
});

test('recentMessages 按时间升序返回', () => {
  const db = openDatabase(':memory:');
  q.insertMessage(db, msg({ msgId: 'a', at: '2026-10-30T10:00:00Z', text: '一' }));
  q.insertMessage(db, msg({ msgId: 'b', at: '2026-10-30T10:01:00Z', text: '二' }));
  const list = q.recentMessages(db, 'private:1', 10);
  assert.deepEqual(list.map((m) => m.text), ['一', '二']);
  db.close();
});

test('会话 upsert 与 wake_state', () => {
  const db = openDatabase(':memory:');
  q.upsertSession(db, {
    sessionKey: 'private:1', kind: 'direct', participants: ['self', 'user:1'],
    lastEventAt: '2026-10-30T10:00:00Z', wakeState: { mode: 'diving' },
  });
  let s = q.getSession(db, 'private:1');
  assert.equal(s.kind, 'direct');
  assert.equal(s.wakeState.mode, 'diving');

  q.setWakeState(db, 'private:1', { mode: 'active' });
  s = q.getSession(db, 'private:1');
  assert.equal(s.wakeState.mode, 'active');
  db.close();
});

test('幂等表读写与清理', () => {
  const db = openDatabase(':memory:');
  assert.equal(q.seenDedupe(db, 'k1'), false);
  q.markDedupe(db, 'k1', '2026-10-01T00:00:00Z');
  assert.equal(q.seenDedupe(db, 'k1'), true);
  assert.equal(q.pruneDedupe(db, '2026-10-15T00:00:00Z'), 1);
  db.close();
});

test('限流：按分钟窗口计数，超限拒绝', () => {
  const db = openDatabase(':memory:');
  const at = new Date('2026-10-30T10:00:05Z');
  for (let i = 0; i < 3; i += 1) {
    const r = q.consumeRate(db, { action: 'send', target: 'private:1', window: 'minute', limit: 3, at });
    assert.equal(r.ok, true);
  }
  const blocked = q.consumeRate(db, { action: 'send', target: 'private:1', window: 'minute', limit: 3, at });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.count, 3);

  const nextMinute = q.consumeRate(db, {
    action: 'send', target: 'private:1', window: 'minute', limit: 3,
    at: new Date('2026-10-30T10:01:05Z'),
  });
  assert.equal(nextMinute.ok, true, '换窗口后应重新计数');
  db.close();
});

test('限流：按天窗口', () => {
  const db = openDatabase(':memory:');
  const r1 = q.consumeRate(db, { action: 'post', target: 'global', window: 'day', limit: 1, at: new Date('2026-10-30T01:00:00Z') });
  assert.equal(r1.ok, true);
  const r2 = q.consumeRate(db, { action: 'post', target: 'global', window: 'day', limit: 1, at: new Date('2026-10-30T23:00:00Z') });
  assert.equal(r2.ok, false, '同一天应被拒');
  const r3 = q.consumeRate(db, { action: 'post', target: 'global', window: 'day', limit: 1, at: new Date('2026-10-31T01:00:00Z') });
  assert.equal(r3.ok, true, '第二天应恢复');
  db.close();
});

test('kv 读写', () => {
  const db = openDatabase(':memory:');
  assert.equal(q.getKv(db, 'k', 'fallback'), 'fallback');
  q.setKv(db, 'k', 'v');
  assert.equal(q.getKv(db, 'k'), 'v');
  db.close();
});
