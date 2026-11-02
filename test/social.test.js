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

function kvQ(store, { lastInboundMsAgo = 60 * 60 * 1000 } = {}) {
  return {
    listSessions: () => [{ sessionKey: 'group:1', kind: 'group' }],
    latestInbound: () => ({ at: new Date(Date.now() - lastInboundMsAgo).toISOString() }),
    getKv: (db, key, fallback) => (key in store ? store[key] : fallback),
    setKv: (db, key, value) => { store[key] = value; },
  };
}

test('社交循环：到点按概率尝试发说说（每天最多 3 条）', async () => {
  const hour = new Date().getHours();
  const calls = [];
  const store = {};
  const loop = createSocialLoop({
    db: {}, q: kvQ(store),
    config: {
      qq: { ownerQQ: 2621072338 },
      social: {
        enabled: true, proactiveEnabled: true,
        qzone: { enabled: true, perDay: 3, windowStartHour: hour, windowEndHour: (hour + 1) % 24, cooldownMs: 0, probability: 1 },
      },
    },
    runProactive: async (key, purpose) => { calls.push({ key, purpose }); return { ok: true, sent: 1 }; },
    random: () => 0,
  });
  await loop.tick();
  assert.deepEqual(calls, [{ key: 'private:2621072338', purpose: 'qzone' }]);
  assert.equal(store['qzone:proactive:day'], '1');
});

test('社交循环：说说冷却期内不重复尝试', async () => {
  const hour = new Date().getHours();
  const calls = [];
  const store = { 'qzone:proactive:last': String(Date.now()) };
  const loop = createSocialLoop({
    db: {}, q: kvQ(store),
    config: {
      qq: { ownerQQ: 2621072338 },
      social: {
        enabled: true, proactiveEnabled: true,
        qzone: { enabled: true, perDay: 3, windowStartHour: hour, windowEndHour: (hour + 1) % 24, cooldownMs: 6 * 3600 * 1000, probability: 1 },
      },
    },
    runProactive: async (key, purpose) => { calls.push({ key, purpose }); return { ok: true, sent: 1 }; },
    random: () => 0,
  });
  await loop.tick();
  assert.equal(calls.length, 0);
});

test('社交循环：不配时间窗时任何时间都能发说说', async () => {
  const calls = [];
  const store = {};
  const loop = createSocialLoop({
    db: {}, q: kvQ(store),
    config: {
      qq: { ownerQQ: 2621072338 },
      social: {
        enabled: true, proactiveEnabled: true,
        qzone: { enabled: true, perDay: 3, cooldownMs: 0, probability: 1 },
      },
    },
    runProactive: async (key, purpose) => { calls.push({ key, purpose }); return { ok: true, sent: 1 }; },
    random: () => 0,
  });
  await loop.tick();
  assert.deepEqual(calls, [{ key: 'private:2621072338', purpose: 'qzone' }]);
});


function privateQ(store, { lastInboundMsAgo = 30 * 3600 * 1000, sessions = [] } = {}) {
  return {
    listSessions: () => [],
    latestInbound: (db, key) => ({ at: new Date(Date.now() - lastInboundMsAgo).toISOString() }),
    getSession: (db, key) => (sessions.includes(key) ? { sessionKey: key } : null),
    getKv: (db, key, fallback) => (key in store ? store[key] : fallback),
    setKv: (db, key, value) => { store[key] = value; },
  };
}

test('社交循环：owner 长时间没聊时主动私聊', async () => {
  const calls = [];
  const store = {};
  const q = privateQ(store, { sessions: ['private:2621072338'] });
  const loop = createSocialLoop({
    db: {}, q,
    config: {
      qq: { ownerQQ: 2621072338 },
      social: { enabled: true, proactiveEnabled: true, private: {
        enabled: true,
        owner: { minIdleHours: 24, perDay: 1, cooldownMs: 0, probability: 1 },
      } },
    },
    runProactive: async (key, purpose) => { calls.push({ key, purpose }); return { ok: true, sent: 1 }; },
    random: () => 0,
  });
  await loop.tick();
  assert.deepEqual(calls, [{ key: 'private:2621072338', purpose: 'private' }]);
});

test('社交循环：L4 好友也会主动私聊，L3 频率更低', async () => {
  const makeLoop = (randomValue) => {
    const calls = [];
    const store = {};
    const q = privateQ(store, { sessions: ['private:111', 'private:222'] });
    const loop = createSocialLoop({
      db: {}, q,
      memory: { relationships: async () => ([
        { contactId: 'user:111', tier: 'L4' },
        { contactId: 'user:222', tier: 'L3' },
      ]) },
      config: {
        qq: { ownerQQ: 2621072338 },
        social: { enabled: true, proactiveEnabled: true, private: {
          enabled: true,
          owner: { minIdleHours: 9999, probability: 0 },
          tiers: {
            L4: { minIdleHours: 0, perDay: 1, cooldownMs: 0, probability: 0.15 },
            L3: { minIdleHours: 0, perDay: 1, cooldownMs: 0, probability: 0.1 },
          },
        } },
      },
      runProactive: async (key, purpose) => { calls.push(key); return { ok: true, sent: 1 }; },
      random: () => randomValue,
    });
    return { loop, calls };
  };

  // 0.12：命中 L4（0.12 < 0.15），不命中 L3（0.12 > 0.1）
  const a = makeLoop(0.12);
  await a.loop.tick();
  assert.deepEqual(a.calls, ['private:111']);

  // 0.05：两者都命中
  const b = makeLoop(0.05);
  await b.loop.tick();
  assert.deepEqual(b.calls.sort(), ['private:111', 'private:222']);
});
