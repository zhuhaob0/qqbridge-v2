import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryClient } from '../src/memory/client.js';
import { createBatcher } from '../src/wake/batcher.js';

const jsonResponse = (body, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => body,
});

test('记忆客户端：正常调用返回数据', async () => {
  const client = createMemoryClient({
    baseUrl: 'http://x',
    fetchImpl: async () => jsonResponse({ rendered: '【你记得的】', items: [] }),
  });
  const res = await client.recall({ channelId: 'c', participants: ['self'], query: 'q' });
  assert.equal(res.rendered, '【你记得的】');
});

test('记忆客户端：HTTP 错误降级为 null', async () => {
  const client = createMemoryClient({
    baseUrl: 'http://x',
    fetchImpl: async () => jsonResponse({}, false, 500),
  });
  const res = await client.recall({ channelId: 'c', participants: [], query: 'q' });
  assert.equal(res, null);
});

test('记忆客户端：连续失败后熔断', async () => {
  let calls = 0;
  const client = createMemoryClient({
    baseUrl: 'http://x',
    failureThreshold: 2,
    openMs: 60000,
    fetchImpl: async () => {
      calls += 1;
      throw new Error('boom');
    },
  });
  assert.equal(await client.recall({ channelId: 'c', participants: [], query: 'a' }), null);
  assert.equal(await client.recall({ channelId: 'c', participants: [], query: 'b' }), null);
  assert.equal(client.degraded, true);
  const before = calls;
  assert.equal(await client.recall({ channelId: 'c', participants: [], query: 'c' }), null);
  assert.equal(calls, before, '熔断期间不应再发请求');
});

test('记忆客户端：成功一次后熔断恢复计数', async () => {
  let n = 0;
  const client = createMemoryClient({
    baseUrl: 'http://x',
    failureThreshold: 2,
    fetchImpl: async () => {
      n += 1;
      if (n === 1) throw new Error('first fails');
      return jsonResponse({ rendered: 'ok', items: [] });
    },
  });
  assert.equal(await client.recall({ channelId: 'c', participants: [], query: 'a' }), null);
  const res = await client.recall({ channelId: 'c', participants: [], query: 'b' });
  assert.equal(res.rendered, 'ok');
  assert.equal(client.degraded, false);
});

test('批量窗口：窗口内多条合并成一次唤醒', async () => {
  const flushes = [];
  const batcher = createBatcher({ windowMs: 30, onFlush: (key, items) => flushes.push({ key, items }) });

  batcher.push('private:1', { text: 'a' });
  batcher.push('private:1', { text: 'b' });
  batcher.push('private:2', { text: 'c' });

  assert.equal(batcher.pendingCount('private:1'), 2);
  assert.equal(batcher.size(), 2);

  await new Promise((r) => setTimeout(r, 120));
  assert.equal(flushes.length, 2);
  const first = flushes.find((f) => f.key === 'private:1');
  assert.equal(first.items.length, 2);
});

test('批量窗口：flush 立即触发并清空', () => {
  const flushes = [];
  const batcher = createBatcher({ windowMs: 10000, onFlush: (key, items) => flushes.push({ key, items }) });
  batcher.push('private:1', { text: 'a' });
  batcher.flush('private:1');
  assert.equal(flushes.length, 1);
  assert.equal(batcher.size(), 0);
});
