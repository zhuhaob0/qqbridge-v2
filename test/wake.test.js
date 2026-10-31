import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldWake, inDiving, mentionsBot, isQuestion } from '../src/wake/policy.js';

const config = (over = {}) => ({
  qq: { ownerQQ: 100, selfQQ: 200, botNames: ['蓝色大肥鱼'] },
  wake: { triggers: { at: true, name: true, question: true, probability: 0 } },
  ...over,
});

// 默认当作群聊消息（private 现在是「必醒」，见 policy）
const msg = (text, kind = 'public') => ({ text, direction: 'inbound', kind });

test('活跃模式：任何消息都唤醒', () => {
  const r = shouldWake({ msg: msg('随便说点什么'), session: { wakeState: {} }, config: config() });
  assert.equal(r.wake, true);
});

test('活跃模式但关闭 anyMessage：不唤醒', () => {
  const r = shouldWake({
    msg: msg('在吗'),
    session: { wakeState: { triggers: { anyMessage: false } } },
    config: config(),
  });
  assert.equal(r.wake, false);
});

test('潜水模式：普通消息不唤醒', () => {
  const r = shouldWake({
    msg: msg('今天天气不错'),
    session: { wakeState: { mode: 'diving', until: new Date(Date.now() + 3600_000).toISOString() } },
    config: config(),
  });
  assert.equal(r.wake, false);
  assert.match(r.reason, /潜水中/);
});

test('潜水模式：被 @ 唤醒', () => {
  const r = shouldWake({
    msg: msg('@200 你看看这个'),
    session: { wakeState: { mode: 'diving', until: new Date(Date.now() + 3600_000).toISOString() } },
    config: config(),
  });
  assert.equal(r.wake, true);
  assert.match(r.reason, /点名/);
});

test('潜水模式：被叫名字唤醒', () => {
  const r = shouldWake({
    msg: msg('蓝色大肥鱼你在吗'),
    session: { wakeState: { mode: 'diving', until: new Date(Date.now() + 3600_000).toISOString() } },
    config: config(),
  });
  assert.equal(r.wake, true);
});

test('潜水模式：被提问唤醒', () => {
  const r = shouldWake({
    msg: msg('这个怎么办？'),
    session: { wakeState: { mode: 'diving', until: new Date(Date.now() + 3600_000).toISOString() } },
    config: config(),
  });
  assert.equal(r.wake, true);
  assert.match(r.reason, /提问/);
});

test('潜水模式：关键词唤醒', () => {
  const r = shouldWake({
    msg: msg('求推荐一部电影'),
    session: { wakeState: { mode: 'diving', triggers: { keywords: ['电影'] } } },
    config: config(),
  });
  assert.equal(r.wake, true);
  assert.match(r.reason, /关键词/);
});

test('潜水到期后自动恢复活跃', () => {
  const past = new Date(Date.now() - 1000).toISOString();
  const r = shouldWake({
    msg: msg('随便'),
    session: { wakeState: { mode: 'diving', until: past } },
    config: config(),
  });
  assert.equal(r.wake, true);
});

test('概率唤醒', () => {
  const r = shouldWake({
    msg: msg('随便'),
    // 群聊的概率唤醒由 probabilityGroup 控制（probability 只管一对一）
    session: { wakeState: { mode: 'diving', triggers: { probabilityGroup: 0.5 } } },
    config: config(),
    random: () => 0.1,
  });
  assert.equal(r.wake, true);
  assert.match(r.reason, /概率/);
});

test('辅助函数', () => {
  assert.equal(inDiving({ mode: 'diving' }), true);
  assert.equal(inDiving({ mode: 'active' }), false);
  assert.equal(mentionsBot('@200 hi', { selfQQ: 200 }), true);
  assert.equal(mentionsBot('hi', { selfQQ: 200, botNames: ['小蓝'] }), false);
  assert.equal(isQuestion('你好吗'), true);
  assert.equal(isQuestion('我去吃饭了'), false);
});

test('群聊不做概率唤醒（潜水时也一样）', () => {
  const cfg = config({ wake: { triggers: { at: true, name: true, question: false, probability: 0.99 } } });
  const groupMsg = { text: '今天天气不错', direction: 'inbound', kind: 'public' };
  const r = shouldWake({ msg: groupMsg, session: { wakeState: { mode: 'diving' } }, config: cfg, random: () => 0.01 });
  assert.equal(r.wake, false, '群聊不应因概率而插话');
  // 一对一仍然允许
  const privateMsg = { text: '今天天气不错', direction: 'inbound', kind: 'direct' };
  const r2 = shouldWake({ msg: privateMsg, session: { wakeState: { mode: 'diving' } }, config: cfg, random: () => 0.01 });
  assert.equal(r2.wake, true);
});
