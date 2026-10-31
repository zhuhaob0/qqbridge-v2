import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSpeech } from '../src/speech/index.js';
import { createScheduler } from '../src/scheduler/scheduler.js';

test('语音：provider=none 直接返回 null', async () => {
  const speech = createSpeech({ provider: 'none' });
  assert.equal(await speech.transcribe({ audioPath: 'x.wav' }), null);
});

test('语音：http provider 调用转写接口', async () => {
  let captured = null;
  const speech = createSpeech({
    provider: 'http',
    http: { url: 'http://asr', apiKey: 'k', model: 'whisper-1' },
  }, {
    fetchImpl: async (url, init) => {
      captured = { url, auth: init.headers?.authorization, hasBody: Boolean(init.body) };
      return { ok: true, json: async () => ({ text: '你好世界' }) };
    },
  });
  const r = await speech.transcribe({ audioBase64: Buffer.from('x').toString('base64') });
  assert.equal(r.text, '你好世界');
  assert.equal(captured.url, 'http://asr');
  assert.equal(captured.auth, 'Bearer k');
});

test('语音：http 失败返回 null 不抛', async () => {
  const speech = createSpeech({ provider: 'http', http: { url: 'http://asr' } }, {
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });
  assert.equal(await speech.transcribe({ audioBase64: 'eA==' }), null);
});

test('语音：sensevoice 解析 JSON 输出', async () => {
  const speech = createSpeech(
    { provider: 'sensevoice', sensevoice: { script: 't.py', model: 'm', python: 'python' } },
    { exec: async ({ command, args }) => {
      assert.equal(command, 'python');
      assert.ok(args.includes('t.py'));
      return '{"text":"今天好累","confidence":0.9}';
    } },
  );
  const r = await speech.transcribe({ audioPath: 'a.wav' });
  assert.equal(r.text, '今天好累');
  assert.equal(r.confidence, 0.9);
});

test('语音：sensevoice 输出非 JSON 时按纯文本处理', async () => {
  const speech = createSpeech(
    { provider: 'sensevoice', sensevoice: { script: 't.py', python: 'python' } },
    { exec: async () => '纯文本结果' },
  );
  const r = await speech.transcribe({ audioPath: 'a.wav' });
  assert.equal(r.text, '纯文本结果');
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
