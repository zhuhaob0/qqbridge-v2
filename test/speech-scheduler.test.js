import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSpeech } from '../src/speech/index.js';
import { createScheduler } from '../src/scheduler/scheduler.js';

test('语音：provider=none 直接返回 null', async () => {
  const speech = createSpeech({ provider: 'none' });
  assert.equal(await speech.transcribe({ audioPath: 'x.wav' }), null);
});

test('语音：未知 provider 直接报错', () => {
  assert.throws(() => createSpeech({ provider: 'whisper' }), /未知的 speech.provider/);
});

test('语音：sherpa 模型缺失时 status 为未就绪', () => {
  const speech = createSpeech({ provider: 'sherpa', modelDir: 'Z:/not-exist' });
  const status = speech.status();
  assert.equal(status.provider, 'sherpa');
  assert.equal(status.ready, false);
});

test('语音：http provider 调用转写接口', async () => {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    let size = 0;
    req.on('data', (chunk) => { size += chunk.length; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ text: '你好世界' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const speech = createSpeech({ provider: 'http', http: { url: `http://127.0.0.1:${port}/asr`, apiKey: 'k' } });
    const r = await speech.transcribe({ audioBase64: Buffer.from('x').toString('base64') });
    assert.equal(r, '你好世界');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('定时任务：到点执行一次，同一天不重复', async () => {
  const runs = [];
  const now = new Date(2026, 9, 30, 3, 30, 0); // 本地时间 03:30
  const scheduler = createScheduler({
    jobs: [{ name: 'consolidate', at: '03:30', run: async () => { runs.push('x'); return 'ok'; } }],
    clock: () => now,
  });

  const r1 = await scheduler.tick();
  assert.equal(r1.length, 1);
  assert.equal(runs.length, 1);

  const r2 = await scheduler.tick();
  assert.equal(r2.length, 0, '同一天不应重复执行');
});

test('定时任务：不同日期会再次执行', async () => {
  let now = new Date(2026, 9, 30, 3, 30, 0);
  const runs = [];
  const scheduler = createScheduler({
    jobs: [{ name: 'prune', at: '03:30', run: async () => runs.push(1) }],
    clock: () => now,
  });
  await scheduler.tick();
  now = new Date(2026, 9, 31, 3, 30, 0);
  await scheduler.tick();
  assert.equal(runs.length, 2);
});

test('定时任务：失败被记录但不影响其它任务', async () => {
  const logs = [];
  const now = new Date(2026, 9, 30, 4, 0, 0);
  const scheduler = createScheduler({
    jobs: [
      { name: 'bad', at: '04:00', run: async () => { throw new Error('boom'); } },
      { name: 'good', at: '04:00', run: async () => 'ok' },
    ],
    clock: () => now,
    logger: { info() {}, warn() {}, error: (msg, f) => logs.push({ msg, f }), debug() {} },
  });
  const results = await scheduler.tick();
  assert.equal(results.length, 2);
  assert.equal(results.find((r) => r.name === 'bad').ok, false);
  assert.equal(results.find((r) => r.name === 'good').ok, true);
  assert.equal(logs.length, 1);
});

test('定时任务：时间不匹配时不执行', async () => {
  const runs = [];
  const scheduler = createScheduler({
    jobs: [{ name: 'x', at: '03:30', run: async () => runs.push(1) }],
    clock: () => new Date(2026, 9, 30, 3, 31, 0),
  });
  await scheduler.tick();
  assert.equal(runs.length, 0);
});
