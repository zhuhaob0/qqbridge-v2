import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSnowLumaTransport } from '../src/transport/snowluma.js';
import { createDryRunQq } from '../src/qq/dry-run.js';

function fakeClient() {
  const calls = { private: [], group: [], connects: 0, closes: 0 };
  const handlers = { private: null, group: null, notice: null };
  return {
    calls,
    handlers,
    onPrivateMessage(cb) { handlers.private = cb; },
    onGroupMessage(cb) { handlers.group = cb; },
    onNotice(_type, cb) { handlers.notice = cb; },
    connect() { calls.connects += 1; },
    close() { calls.closes += 1; },
    async sendPrivateMessage(id, payload) {
      calls.private.push({ id, payload });
      return { message_id: 100 + calls.private.length };
    },
    async sendGroupMessage(id, payload) {
      calls.group.push({ id, payload });
      return { data: { message_id: 200 + calls.group.length } };
    },
  };
}

test('传输层：私聊/群聊事件转发给 router', () => {
  const client = fakeClient();
  const raw = [];
  const t = createSnowLumaTransport({ client, onRaw: (e) => raw.push(e) });
  client.handlers.private({ user_id: 1, post_type: 'message' });
  client.handlers.group({ group_id: 2, post_type: 'message' });
  client.handlers.notice({ sub_type: 'poke' });
  assert.equal(raw.length, 3);
  assert.equal(raw[2].post_type, 'notice');
  t.stop();
});

test('传输层：sendText 映射到正确的方法', async () => {
  const client = fakeClient();
  const t = createSnowLumaTransport({ client, textFactory: (s) => ({ type: 'text', data: { text: s } }) });

  const a = await t.sendText('private:1', '你好');
  assert.equal(a.ok, true);
  assert.equal(a.msgId, '101');
  assert.equal(client.calls.private[0].id, 1);
  assert.equal(client.calls.private[0].payload.data.text, '你好');

  const b = await t.sendText('group:456', '大家好');
  assert.equal(b.ok, true);
  assert.equal(b.msgId, '201');
  assert.equal(client.calls.group[0].id, 456);
});

test('传输层：非法 key 返回失败而不是抛错', async () => {
  const t = createSnowLumaTransport({ client: fakeClient() });
  const r = await t.sendText('guild:1', 'x');
  assert.equal(r.ok, false);
  assert.match(r.error, /非法会话/);
});

test('传输层：发送异常被捕获', async () => {
  const client = fakeClient();
  client.sendPrivateMessage = async () => { throw new Error('ws closed'); };
  const t = createSnowLumaTransport({ client });
  const r = await t.sendText('private:1', 'x');
  assert.equal(r.ok, false);
  assert.match(r.error, /ws closed/);
});

test('传输层：start/stop 幂等', () => {
  const client = fakeClient();
  const t = createSnowLumaTransport({ client });
  t.start();
  t.start();
  t.stop();
  assert.equal(client.calls.connects, 1);
  assert.equal(client.calls.closes, 1);
});

test('干跑模式：只记录不发送', async () => {
  const qq = createDryRunQq({});
  const r = await qq.sendText('private:1', 'hi');
  assert.equal(r.ok, true);
  assert.equal(qq.sent.length, 1);
  assert.equal(qq.sent[0].message, 'hi');
});
