import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../src/storage/db.js';
import * as q from '../src/storage/queries.js';
import { createOrchestrator } from '../src/orchestrator/run.js';
import { createFakeAgent } from '../src/agent/fake.js';
import { createFakeQq } from '../src/qq/fake.js';

const config = (over = {}) => ({
  qq: { ownerQQ: 100, selfQQ: 200, botNames: [] },
  allow: { private: [1], groups: [], emptyGroupsMeansAll: false },
  send: { minGapMs: 0, maxGapMs: 0, maxPerMinute: 10, splitThreshold: 10 },
  agent: { preset: 'test' },
  ...over,
});

const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };

function setup({ agentReply = '好的。收到。', memory = null, configOver = {}, failOn = null } = {}) {
  const db = openDatabase(':memory:');
  q.upsertSession(db, {
    sessionKey: 'private:1', kind: 'direct', participants: ['self', 'user:1'],
    wakeState: {}, lastEventAt: '2026-10-30T10:00:00Z', createdAt: '2026-10-30T10:00:00Z',
  });
  q.insertMessage(db, {
    msgId: 'in1', sessionKey: 'private:1', direction: 'inbound',
    senderId: '1', senderName: '小明', text: '在吗', at: '2026-10-30T10:00:00Z',
  });

  const agent = createFakeAgent({ replies: [agentReply], failOn });
  const qq = createFakeQq();
  const orch = createOrchestrator({
    db,
    config: config(configOver),
    agent,
    qq,
    memory,
    logger: quietLogger,
    clock: () => new Date('2026-10-30T10:01:00Z'),
    random: () => 0,
    sleep: async () => {},
  });
  return { db, agent, qq, orch };
}

test('编排：分条发送并落库为出站消息', async () => {
  const { db, qq, orch } = setup({
    agentReply: '好。收到。',
    configOver: { send: { minGapMs: 0, maxGapMs: 0, maxPerMinute: 10, splitThreshold: 2 } },
  });
  const result = await orch.run('private:1');
  assert.equal(result.ok, true);
  assert.ok(result.parts.length >= 2, `应分条，实际 ${result.parts.length}`);
  assert.equal(qq.sent.length, result.parts.length);
  assert.equal(qq.sent[0].sessionKey, 'private:1');

  const outbound = q.recentMessages(db, 'private:1', 20).filter((m) => m.direction === 'outbound');
  assert.equal(outbound.length, result.parts.length);
  db.close();
});

test('编排：提示词包含最近对话与发送规则', async () => {
  const { db, agent, orch } = setup();
  const result = await orch.run('private:1');
  assert.match(result.prompt, /小明：在吗/);
  assert.match(result.prompt, /怎么回/);
  assert.ok(agent.prompts.length === 1);
  db.close();
});

test('编排：记忆被检索并拼进提示词', async () => {
  const memory = {
    async recall() { return { rendered: '【你记得的】\n- 他喜欢猫', items: [] }; },
    async persona() { return { markdown: '# 性格\n- 嘴毒' }; },
    async narrative() { return { markdown: '# 我的状态\n- 最近在找工作' }; },
    async ingest() { return { ok: true }; },
  };
  const { db, orch } = setup({ memory });
  const result = await orch.run('private:1');
  assert.match(result.prompt, /他喜欢猫/);
  assert.match(result.prompt, /嘴毒/);
  assert.match(result.prompt, /最近在找工作/);
  db.close();
});

test('编排：记忆不可用时照常回复', async () => {
  const memory = {
    async recall() { return null; },
    async persona() { return null; },
    async narrative() { return null; },
    async ingest() { throw new Error('down'); },
  };
  const { db, qq, orch } = setup({ memory });
  const result = await orch.run('private:1');
  assert.equal(result.ok, true);
  assert.ok(qq.sent.length >= 1);
  db.close();
});

test('编排：agent 失败时返回失败且不发送', async () => {
  const { db, qq, orch } = setup({ failOn: 1 });
  const result = await orch.run('private:1');
  assert.equal(result.ok, false);
  assert.match(result.reason, /agent/);
  assert.equal(qq.sent.length, 0);
  db.close();
});

test('编排：每分钟发送上限生效', async () => {
  const { db, qq, orch } = setup({
    agentReply: '一。二。三。四。五。六。',
    configOver: { send: { minGapMs: 0, maxGapMs: 0, maxPerMinute: 2, splitThreshold: 2 } },
  });
  const result = await orch.run('private:1');
  assert.equal(result.ok, true);
  assert.ok(qq.sent.length <= 2, `应被限流为 2 条，实际 ${qq.sent.length}`);
  db.close();
});

test('编排：会话不存在时报错', async () => {
  const { db, orch } = setup();
  const result = await orch.run('private:404');
  assert.equal(result.ok, false);
  assert.match(result.reason, /会话不存在/);
  db.close();
});
