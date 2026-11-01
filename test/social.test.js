import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBus } from '../src/router/bus.js';
import { createSocialLoop } from '../src/wake/social.js';

test('waitQuiet：收到消息后安静 quietMs 就返回', async () => {
  const bus = createBus();
  const started = Date.now();
  const promise = bus.waitQuiet('group:1', { timeoutMs: 500, quietMs: 40 });
  setTimeout(() => bus.emitMessage({ sessionKey: 'group:1', direction: 'inbound', text: 'a' }), 10);
  setTimeout(() => bus.emitMessage({ sessionKey: 'group:1', direction: 'inbound', text: 'b' }), 20);
  const result = await promise;
  const elapsed = Date.now() - started;
  assert.equal(result.messages.length, 2);
  assert.equal(result.timedOut, false);
  assert.ok(elapsed < 400, `应在安静窗口后返回，实际 ${elapsed}ms`);
});

test('waitQuiet：没有消息则超时返回空', async () => {
  const bus = createBus();
  const result = await bus.waitQuiet('group:2', { timeoutMs: 60, quietMs: 10 });
  assert.equal(result.messages.length, 0);
  assert.equal(result.timedOut, true);
});

function fakeQ({ lastInboundMsAgo = 0 } = {}) {
  return {
    listSessions: () => [{ sessionKey: 'group:1', kind: 'group' }],
    latestInbound: () => ({ at: new Date(Date.now() - lastInboundMsAgo).toISOString() }),
    getKv: () => '1',
  };
}

test('社交循环：安静够久后按概率主动开话题', async () => {
  const calls = [];
  const loop = createSocialLoop({
    db: {}, q: fakeQ({ lastInboundMsAgo: 60 * 60 * 1000 }),
    config: {
      social: { enabled: true, proactiveEnabled: true, idleThresholdMs: 1000, checkMinMs: 0, checkMaxMs: 0, probability: 1 },
    },
    runProactive: async (key, purpose) => { calls.push({ key, purpose }); return { ok: true, sent: 1 }; },
    random: () => 0,
  });
  await loop.tick(); // 第一次只排检查时间
  await loop.tick(); // 第二次触发
  assert.deepEqual(calls, [{ key: 'group:1', purpose: 'open' }]);
  assert.equal(loop.states.get('group:1').phase, 'active');
});

test('社交循环：开口后冷场，按概率试探', async () => {
  const calls = [];
  const loop = createSocialLoop({
    db: {}, q: fakeQ({ lastInboundMsAgo: 60 * 60 * 1000 }),
    config: {
      social: {
        enabled: true, proactiveEnabled: true, idleThresholdMs: 1000, checkMinMs: 0, checkMaxMs: 0,
        probability: 1, probeAfterIdleMs: 0, probeProbability: 1, probeWaitMs: 1000,
      },
    },
    runProactive: async (key, purpose) => { calls.push({ key, purpose }); return { ok: true, sent: 1 }; },
    random: () => 0,
  });
  await loop.tick();
  await loop.tick();
  await loop.tick(); // 进入 active 后冷场 → probe
  assert.deepEqual(calls.map((c) => c.purpose), ['open', 'probe']);
  assert.equal(loop.states.get('group:1').phase, 'probing');
});

test('社交循环：关闭后什么都不做', async () => {
  let called = 0;
  const loop = createSocialLoop({
    db: {}, q: fakeQ({ lastInboundMsAgo: 60 * 60 * 1000 }),
    config: { social: { enabled: false } },
    runProactive: async () => { called += 1; return { ok: true, sent: 1 }; },
    random: () => 0,
  });
  await loop.tick();
  await loop.tick();
  assert.equal(called, 0);
});
