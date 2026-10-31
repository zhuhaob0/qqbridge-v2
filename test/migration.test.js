import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { openDatabase } from '../src/storage/db.js';
import * as q from '../src/storage/queries.js';
import { migrateV1, mapConfig } from '../src/migration/v1.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-v1-'));
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'roles'), { recursive: true });

  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    ownerQQ: 100,
    snowluma: { wsUrl: 'ws://127.0.0.1:3001', accessToken: 'tk', selfQQ: 200 },
    allow: { private: [1, 2], groups: [456] },
    allowAllWhenEmpty: false,
    consolePort: 3100,
    consoleToken: 'ct',
    agentPreset: 'qq-chat-v2',
    sendDelayMs: 800,
  }), 'utf8');

  fs.writeFileSync(path.join(dir, 'state', 'sessions.json'), JSON.stringify({
    sessions: { 'private:1': 'sess-a', 'group:456': 'sess-b' },
  }), 'utf8');

  fs.writeFileSync(path.join(dir, 'state', 'social-v2.json'), JSON.stringify({
    conversations: {
      'private:1': {
        selfQQ: 200,
        wakeConfig: { anyMessage: true },
        recentMessages: [
          { msgId: 'm1', senderId: '1', senderName: '小明', text: '我最近在考虑跳槽', at: '2026-10-29T10:00:00Z' },
          { msgId: 'm2', senderId: '200', senderName: '我', text: '怕不稳？', at: '2026-10-29T10:01:00Z' },
        ],
        activeTopics: [{ text: '跳槽的事', lastMentionAt: '2026-10-29T10:00:00Z' }],
        memberImpressions: { 小明: { text: '焦虑，但挺真诚' } },
      },
      'group:456': {
        selfQQ: 200,
        recentMessages: [{ msgId: 'g1', senderId: '9', senderName: '群友', text: '今晚开黑吗', at: '2026-10-29T20:00:00Z' }],
      },
    },
  }), 'utf8');

  fs.writeFileSync(path.join(dir, 'state', 'shared-memory.json'), JSON.stringify({
    notes: [{ category: 'activeTopic', content: '主人喜欢猫', at: 1793000000000 }],
  }), 'utf8');

  fs.writeFileSync(path.join(dir, 'state', 'stickers.json'), JSON.stringify([
    { id: 's1', desc: '笑哭', localNote: '好图', tags: ['搞笑'], url: 'http://x/1.png' },
  ]), 'utf8');

  fs.writeFileSync(path.join(dir, 'state', 'slang.json'), JSON.stringify([
    { content: '摸鱼', meaning: '偷懒', usage: '上班摸鱼', status: 'confirmed' },
  ]), 'utf8');

  fs.writeFileSync(path.join(dir, 'roles', '小鲸鱼.md'), '# 性格\n- 嘴毒但心软', 'utf8');
  return dir;
}

test('配置映射：字段对齐 v2', () => {
  const cfg = mapConfig({
    ownerQQ: 100,
    snowluma: { wsUrl: 'ws://x:3001', accessToken: 'tk', selfQQ: 200 },
    allow: { private: [1], groups: [] },
    allowAllWhenEmpty: true,
    consolePort: 3200,
    consoleToken: 'ct',
    agentPreset: 'p',
    sendDelayMs: 500,
  });
  assert.equal(cfg.qq.ownerQQ, 100);
  assert.equal(cfg.qq.selfQQ, 200);
  assert.equal(cfg.qq.snowluma.token, 'tk');
  assert.deepEqual(cfg.allow.private, [1]);
  assert.equal(cfg.allow.emptyGroupsMeansAll, true);
  assert.equal(cfg.console.port, 3200);
  assert.equal(cfg.agent.preset, 'p');
});

test('迁移：会话/消息/表情/黑话/性格落库', async () => {
  const dir = fixture();
  const db = openDatabase(':memory:');
  const report = await migrateV1({ v1Dir: dir, db });

  assert.equal(report.sessions, 2);
  assert.equal(report.messages, 3);
  assert.equal(report.interactions, 2);
  assert.equal(report.stickers, 1);
  assert.equal(report.slang, 1);
  assert.equal(report.persona, true);

  assert.ok(q.getSession(db, 'private:1'));
  assert.ok(q.getSession(db, 'group:456'));
  assert.equal(q.recentMessages(db, 'private:1', 10).length, 2);

  const sticker = q.getSticker(db, 's1');
  assert.equal(sticker.note, '好图');
  assert.equal(q.getSlang(db, '摸鱼').meaning, '偷懒');

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('迁移：记忆写入 mnema（事件/事实/交互/性格）', async () => {
  const dir = fixture();
  const db = openDatabase(':memory:');
  const calls = { batches: [], personas: [] };
  const memory = {
    async ingestBatch(payload) { calls.batches.push(payload); return { ok: true }; },
    async setPersona(payload) { calls.personas.push(payload); return { ok: true }; },
  };

  const report = await migrateV1({ v1Dir: dir, db, memory });
  assert.equal(report.memoryImported, true);
  assert.equal(calls.batches.length, 1);

  const batch = calls.batches[0];
  assert.ok(batch.events.length >= 3, '消息与话题都应作为事件');
  assert.ok(batch.facts.some((f) => f.text.includes('小明')), '印象应转成事实');
  assert.ok(batch.facts.some((f) => f.sensitivity === 'shared'), '共享记忆应标 shared');
  assert.ok(batch.interactions.length >= 2);
  assert.equal(calls.personas.length, 1);
  assert.match(calls.personas[0].markdown, /嘴毒/);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('迁移：dry-run 不写数据库', async () => {
  const dir = fixture();
  const db = openDatabase(':memory:');
  const report = await migrateV1({ v1Dir: dir, db, dryRun: true });
  assert.equal(report.dryRun, true);
  assert.equal(report.sessions, 2, 'dry-run 仍统计');
  assert.equal(q.getSession(db, 'private:1'), null, '但不应落库');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
