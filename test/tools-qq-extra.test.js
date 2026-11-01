import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../src/storage/db.js';
import * as q from '../src/storage/queries.js';
import { createToolRegistry } from '../src/tools/index.js';

const config = () => ({
  qq: { ownerQQ: 100, selfQQ: 200 },
  allow: { private: [1], groups: [456], emptyGroupsMeansAll: false },
  send: { maxPerMinute: 10, voicesPerMinute: 2, pokesPerMinute: 3 },
});

function setup({ withPort = true } = {}) {
  const db = openDatabase(':memory:');
  q.upsertSession(db, {
    sessionKey: 'private:1', kind: 'direct', participants: ['self', 'user:1'],
    wakeState: {}, createdAt: '2026-10-30T10:00:00Z',
  });
  const token = q.ensureAgentToken(db, 'private:1');
  q.upsertSticker(db, { id: 's1', desc: '笑哭', note: '好图', tags: ['搞笑'], url: 'http://x/1.png' });

  const qq = withPort
    ? {
      async sendText() { return { ok: true }; },
      async listVoices() { return [{ name: '晚安.wav', durationSec: 2.1 }]; },
      async sendVoice() { return { ok: true, msgId: 'v1' }; },
      async sendPoke() { return { ok: true }; },
    }
    : { async sendText() { return { ok: true }; } };

  const ctx = { db, config: config(), qq, bus: null, memory: null };
  const registry = createToolRegistry();
  return { db, token, qq, ctx, registry, key: 'private:1' };
}

test('P2 档工具都在注册表里（28 个全齐）', () => {
  const { registry } = setup();
  const names = registry.list().map((t) => t.name);
  for (const name of [
    'qq_list_stickers', 'qq_get_sticker_image', 'qq_list_voices', 'qq_send_voice',
    'qq_send_poke', 'qq_slang_query', 'qq_slang_submit', 'qq_report_feedback',
    'qq_archive_read',
  ]) assert.ok(names.includes(name), `缺少 ${name}`);
  assert.equal(names.length, 28, `工具总数应为 28，实际 ${names.length}`);
});

test('表情库：列表与搜索', async () => {
  const { registry, ctx, key, token } = setup();
  const all = await registry.call('qq_list_stickers', { key, token }, ctx);
  assert.equal(all.count, 1);

  const hit = await registry.call('qq_list_stickers', { key, token, query: '搞笑' }, ctx);
  assert.equal(hit.count, 1);

  const miss = await registry.call('qq_list_stickers', { key, token, query: '不存在' }, ctx);
  assert.equal(miss.count, 0);
});

test('表情图片：返回 url', async () => {
  const { registry, ctx, key, token } = setup();
  const r = await registry.call('qq_get_sticker_image', { key, token, stickerId: 's1' }, ctx);
  assert.equal(r.sticker.url, 'http://x/1.png');

  await assert.rejects(
    () => registry.call('qq_get_sticker_image', { key, token, stickerId: 'nope' }, ctx),
    /未收藏/,
  );
});

test('语音：列表、发送与限流', async () => {
  const { registry, ctx, key, token } = setup();
  const list = await registry.call('qq_list_voices', { key, token }, ctx);
  assert.equal(list.count, 1);

  await registry.call('qq_send_voice', { key, token, voice: '晚安.wav' }, ctx);
  await registry.call('qq_send_voice', { key, token, voice: '晚安.wav' }, ctx);
  await assert.rejects(
    () => registry.call('qq_send_voice', { key, token, voice: '晚安.wav' }, ctx),
    /频繁/,
  );
});

test('语音：传输层不支持时报错', async () => {
  const { registry, ctx, key, token } = setup({ withPort: false });
  await assert.rejects(() => registry.call('qq_list_voices', { key, token }, ctx), /不支持/);
});

test('拍一拍：成功与限流', async () => {
  const { registry, ctx, key, token } = setup();
  const r = await registry.call('qq_send_poke', { key, token, targetUserId: 1 }, ctx);
  assert.equal(r.ok, true);

  await registry.call('qq_send_poke', { key, token }, ctx);
  await registry.call('qq_send_poke', { key, token }, ctx);
  await assert.rejects(() => registry.call('qq_send_poke', { key, token }, ctx), /频繁/);
});

test('黑话：提交进候选库、查询能搜到', async () => {
  const { registry, ctx, key, token, db } = setup();
  await registry.call('qq_slang_submit', { key, token, term: '摸鱼', meaning: '偷懒' }, ctx);
  assert.equal(q.getSlang(db, '摸鱼').status, 'candidate');

  const found = await registry.call('qq_slang_query', { key, token, q: '摸鱼' }, ctx);
  assert.equal(found.count, 1);
  assert.equal(found.entries[0].meaning, '偷懒');
});

test('反馈：写入数据库', async () => {
  const { registry, ctx, key, token, db } = setup();
  await registry.call('qq_report_feedback', { key, token, message: '工具报错了', level: 'warning' }, ctx);
  const row = db.prepare('SELECT * FROM feedback ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.message, '工具报错了');
  assert.equal(row.level, 'warning');
});
